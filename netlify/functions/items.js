// netlify/functions/items.js
// Fetch ONE Monday items_page per call (safe & fast) and let the client paginate.
// Robust against Monday "operation was aborted" with retries + shrinking page size.
// Includes backend calculation for "live on campus" (formula5).

function getEnv(name, fallback = '') {
  try {
    if (typeof process !== 'undefined' && process.env && name in process.env) {
      return process.env[name] || fallback;
    }
  } catch (_) {}
  try {
    if (globalThis && globalThis.Deno && globalThis.Deno.env && typeof globalThis.Deno.env.get === 'function') {
      const v = globalThis.Deno.env.get(name);
      if (v != null) return v;
    }
  } catch (_) {}
  return fallback;
}

export const handler = async (event) => {
  const TOKEN    = getEnv('MONDAY_API_TOKEN', '');
  const BOARD_ID = getEnv('MONDAY_BOARD_ID', '2738090584');

  // Health check
  if (event.queryStringParameters?.debug === 'env') {
    return json({ hasToken: !!TOKEN, boardId: BOARD_ID, runtime: runtimeInfo() });
  }
  if (!TOKEN) {
    return json({
      error: 'Missing environment variables',
      detail: 'Set MONDAY_API_TOKEN (and optionally MONDAY_BOARD_ID) in Netlify → Site settings → Build & deploy → Environment.',
      runtime: runtimeInfo()
    }, 500);
  }

  const p = event.queryStringParameters || {};
  // We will IGNORE very large requested limits and control our own "safe limits" below.
  const clientLimit = clampInt(p.limit, 40, 1, 200); // not used directly; just a hint
  const cursor      = p.cursor || null;

  // By default, return only one page (client paginates progressively).
  const progressive = String(p.progressive || '').toLowerCase() === 'true';
  const minFirst   = clampInt(p.min, 0, 0, 500); // if you *explicitly* want multi-page on server
  const maxPages   = clampInt(p.maxPages, 2, 1, 6);

  // Optional backend filters
  const q      = (p.q || '').trim().toLowerCase();
  const stateF = (p.state || '').trim();
  const cMin   = toNum(p.costMin, -Infinity);
  const cMax   = toNum(p.costMax, +Infinity);
  const gMin   = toNum(p.gpaMin, -Infinity);
  const gMax   = toNum(p.gpaMax, +Infinity);

  // Monday GraphQL
  const query = `
    query($boardId: [ID!], $limit: Int, $cursor: String){
      boards(ids: $boardId){
        items_page (limit: $limit, cursor: $cursor){
          cursor
          items {
            id
            name
            column_values {
              id
              type
              text
              value
            }
          }
        }
      }
    }`;

  // Helpers to read Monday values
  const gv    = (cols, id) => (cols.find(c => c.id === id)?.text || '').trim();
  const gvNum = (cols, id) => numFromText(gv(cols, id));

  // Shareable filter
  const SHAREABLE_COL_ID = 'dup__of_sharable___bachelor_s___freshman___average_';
  const isShareable = (cols) => {
    const c = cols.find(x => x.id === SHAREABLE_COL_ID);
    if (!c) return false;
    if ((c.text || '').toLowerCase() === 'shareable') return true;
    try {
      const v = c.value && JSON.parse(c.value);
      if (v && (v.index === 1 || v.index === "1")) return true;
    } catch {}
    return false;
  };

  // Debug for a single page
  if ((p.debug || '').toLowerCase() === 'shareable') {
    try {
      const data  = await fetchPageResilient(query, { boardId: BOARD_ID, cursor, clientLimit });
      const page  = data?.boards?.[0]?.items_page || {};
      const items = Array.isArray(page.items) ? page.items : [];
      const shareable = items.filter(it => isShareable(it.column_values || []));
      return json({
        region: getEnv('AWS_REGION') || getEnv('NETLIFY_REGION') || 'unknown',
        boardId: BOARD_ID,
        receivedThisPage: items.length,
        shareableOnThisPage: shareable.length,
        cursorPresent: !!page.cursor
      });
    } catch (e) {
      return json({ error: 'Debug fetch failed', detail: errorMessage(e) }, 502);
    }
  }

  // Accumulate rows here
  const acc = [];
  function process(items){
    const prepped = (items || [])
      .filter(it => isShareable(it.column_values || []))
      .map(it => {
        const cols = it.column_values || [];

        // Backend calculation: # Live on Campus (exposed under Monday id "formula5")
        // ROUNDUP( {Total Enrollment} * {% live on campus} , 0 )
        const enroll = gvNum(cols, 'numbers7');  // Total Enrollment
        let pctLive  = gvNum(cols, 'numbers8');  // e.g. "35" or "35%"

        if (pctLive != null && !isNaN(pctLive)) {
          if (pctLive > 1) pctLive = pctLive / 100; // 35 => 0.35
          if (pctLive < 0) pctLive = 0;
        } else {
          pctLive = null;
        }

        let liveOnCampus = null;
        if (enroll != null && !isNaN(enroll) && pctLive != null && !isNaN(pctLive)) {
          liveOnCampus = Math.ceil(enroll * pctLive);
        }

        return {
          id: it.id,
          name: it.name,
          state: gv(cols, 'state1'),
          totalCost: gvNum(cols, 'formula'),
          minGpa: gvNum(cols, 'numbers34'),
          column_values: cols,

          // expose backend calc mapped to Monday id consumed by the UI
          formula5: liveOnCampus
        };
      });

    // Optional backend filters
    for (const row of prepped){
      if (q) {
        const majors = gv(row.column_values || [], 'dropdown73');
        const hay = (row.name + ' ' + (majors || '')).toLowerCase();
        if (!hay.includes(q)) continue;
      }
      if (stateF && stateF !== 'all') {
        if ((row.state || '').toLowerCase() !== stateF.toLowerCase()) continue;
      }
      if (!between(row.totalCost, cMin, cMax)) continue;
      if (!between(row.minGpa,   gMin, gMax)) continue;
      acc.push(row);
    }
  }

  // One resilient page fetch (with shrinking limits & retries)
  async function getOnePage(curCursor){
    const data = await fetchPageResilient(query, { boardId: BOARD_ID, cursor: curCursor, clientLimit });
    const page  = data?.boards?.[0]?.items_page || {};
    const items = Array.isArray(page.items) ? page.items : [];
    process(items);
    return page.cursor || null;
  }

  // Fetch loop — default one page only
  let nextCursor = cursor;
  let pagesFetched = 0;

  try {
    do {
      nextCursor = await getOnePage(nextCursor);
      pagesFetched++;
      if (progressive) break;
    } while (minFirst > 0 && acc.length < minFirst && nextCursor && pagesFetched < maxPages);
  } catch (e) {
    const msg = errorMessage(e);
    const looksExpired = /CursorExpiredError|cursor has expired/i.test(msg);
    if (!looksExpired) return json({ error: 'Upstream Monday error', detail: msg }, 502);
    nextCursor = null;
  }

  return json({ cursor: nextCursor, totalLoaded: acc.length, items: acc });
};

// ---------- Resilient fetch with retries & shrinking page size ----------
async function fetchPageResilient(query, { boardId, cursor, clientLimit }){
  // Try progressively smaller limits; Monday sometimes aborts larger pages.
  // Start near requested size but enforce our safe ladder.
  const ladder = unique([
    clampInt(clientLimit, 40, 10, 80), // hint
    40, 30, 25, 20, 15, 10
  ]);

  const maxAttempts = 5; // total attempts across limits (not per-limit)
  let attempt = 0;
  let lastErr = null;

  for (const lim of ladder){
    // We may take multiple tries at the same lim if it aborts intermittently
    for (let inner = 0; inner < 2 && attempt < maxAttempts; inner++, attempt++){
      try {
        return await gqlWithTimeout(query, { boardId, limit: lim, cursor: cursor || null });
      } catch (e){
        lastErr = e;
        const msg = errorMessage(e);
        // Retry only on abort-ish/network-ish errors
        if (!isAbortish(msg)) throw e;

        // Backoff with jitter
        const base = 180 * (attempt + 1);
        const jitter = Math.floor(Math.random() * 120);
        await sleep(base + jitter);
        // then retry (possibly with same lim once; otherwise next lim)
      }
    }
  }

  throw lastErr || new Error('This operation was aborted');
}

function isAbortish(msg){
  return /aborted|AbortError|operation was aborted|network error|Failed to fetch|The operation was aborted/i.test(String(msg||''));
}

// ---------- Low-level GraphQL with timeout ----------
async function gqlWithTimeout(query, variables){
  const token = getEnv('MONDAY_API_TOKEN', '');
  const controller = new AbortController();
  // Keep under Netlify’s hard 10s; we also backoff-retry outside this call.
  const timeoutMs = 8000;
  const t = setTimeout(()=>controller.abort(), timeoutMs);
  try{
    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': token },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal
    });
    const j = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (j && j.errors) throw new Error(JSON.stringify(j.errors));
    return j.data;
  } finally {
    clearTimeout(t);
  }
}

// ---------- Helpers ----------
function json(obj, status = 200){
  return { statusCode: status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj) };
}
function sleep(ms){ return new Promise(res=>setTimeout(res, ms)); }
function unique(arr){ return Array.from(new Set(arr)); }

function clampInt(v, def, min, max){
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}
function toNum(v, fallback){
  if (v === undefined || v === '' || v === null) return fallback;
  const n = +(`${v}`.replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? fallback : n;
}
function numFromText(t){
  if (!t) return NaN;
  // Accept % as well; strip currency & commas.
  const n = +(`${t}`.replace(/[, $€£%]/g, ''));
  return isNaN(n) ? NaN : n;
}
function between(n, min, max){
  if (n === null || n === undefined || isNaN(n)) return true;
  return n >= min && n <= max;
}
function errorMessage(e){
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  if (e.name === 'AbortError') return 'AbortError';
  if (e.message) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}
function runtimeInfo(){
  const isEdge = !!(globalThis && globalThis.Deno);
  return {
    runtime: isEdge ? 'edge (Deno)' : 'lambda (Node)',
    nodeVersion: typeof process !== 'undefined' && process.version ? process.version : null,
  };
}
