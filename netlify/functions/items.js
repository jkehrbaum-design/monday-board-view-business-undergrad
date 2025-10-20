// netlify/functions/items.js
// Fetches ONE Monday items_page per call (fast). Frontend paginates with cursor.
// Now includes: retry-on-timeout + backoff, and backend calc for "live on campus" (formula5).

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

  // Health/debug
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
  let   limit  = clampInt(p.limit, 100, 1, 200);      // default 100; retry will reduce if needed
  let   cursor = p.cursor || null;

  // Default to 0 so we DON’T do multi-page loops on the server (front-end paginates).
  const minFirst   = clampInt(p.min, 0, 0, 500);
  const maxPages   = clampInt(p.maxPages, 2, 1, 10);
  const progressive = String(p.progressive || '').toLowerCase() === 'true';

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

  const gv    = (cols, id) => (cols.find(c => c.id === id)?.text || '').trim();
  const gvNum = (cols, id) => numFromText(gv(cols, id));

  // “Shareable” check
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

  // Quick debug for this single page
  if ((p.debug || '').toLowerCase() === 'shareable') {
    try {
      const data  = await gqlWithRetry(() => gql(query, { boardId: BOARD_ID, limit, cursor }, TOKEN), { retries: 2, timeoutMs: 8500 });
      const page  = data?.boards?.[0]?.items_page || {};
      const items = Array.isArray(page.items) ? page.items : [];
      const shareable = items.filter(it => isShareable(it.column_values || []));
      return json({
        region: getEnv('AWS_REGION') || getEnv('NETLIFY_REGION') || 'unknown',
        boardId: BOARD_ID,
        requestedLimit: limit,
        receivedThisPage: items.length,
        shareableOnThisPage: shareable.length,
        cursorPresent: !!page.cursor
      });
    } catch (e) {
      return json({ error: 'Debug fetch failed', detail: errorMessage(e) }, 502);
    }
  }

  const acc = [];
  function process(items){
    const prepped = (items || [])
      .filter(it => isShareable(it.column_values || []))
      .map(it => {
        const cols = it.column_values || [];

        // -------- Backend calculation: # Live on Campus (formula5) ----------
        // ROUNDUP( {Total Enrollment} * {% live on campus} , 0 )
        const enroll = gvNum(cols, 'numbers7');  // Total Enrollment
        let pctLive  = gvNum(cols, 'numbers8');  // e.g. "35" or "35%"

        if (pctLive != null && !isNaN(pctLive)) {
          if (pctLive > 1) pctLive = pctLive / 100;  // 35 => 0.35
          if (pctLive < 0) pctLive = 0;
        } else {
          pctLive = null;
        }

        let liveOnCampus = null;
        if (enroll != null && !isNaN(enroll) && pctLive != null && !isNaN(pctLive)) {
          liveOnCampus = Math.ceil(enroll * pctLive);
        }
        // --------------------------------------------------------------------

        return {
          id: it.id,
          name: it.name,
          state: gv(cols, 'state1'),
          totalCost: gvNum(cols, 'formula'),
          minGpa: gvNum(cols, 'numbers34'),

          column_values: cols, // keep all raw columns

          // expose backend-calculated value under Monday id the UI reads
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

  // Wrapper to fetch a page with retry + dynamic limit reduction on timeout
  async function fetchPageWithRetry(curLimit, curCursor){
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++){
      try{
        const data  = await gqlWithRetry(
          () => gql(query, { boardId: BOARD_ID, limit: curLimit, cursor: curCursor || null }, TOKEN),
          { retries: 1, timeoutMs: 8500 } // per-attempt guard
        );
        return data;
      } catch(e){
        lastErr = e;
        const msg = errorMessage(e);
        const aborted = /aborted|AbortError|The operation was aborted/i.test(msg);
        // halve the limit on abort to make the next call cheaper
        if (aborted) {
          curLimit = Math.max(20, Math.floor(curLimit / 2));
          await sleep(150 * (attempt + 1)); // small backoff
          continue;
        }
        // For non-abort errors, just rethrow
        throw e;
      }
    }
    throw lastErr || new Error('Unknown fetch failure');
  }

  // Fetch loop (one page unless client asked for minFirst > 0)
  let nextCursor = cursor;
  let pagesFetched = 0;

  try {
    do {
      const data  = await fetchPageWithRetry(limit, nextCursor);
      const page  = data?.boards?.[0]?.items_page || {};
      const items = Array.isArray(page.items) ? page.items : [];
      process(items);
      nextCursor = page.cursor || null;
      pagesFetched++;

      if (progressive) break;
    } while (minFirst > 0 && acc.length < minFirst && nextCursor && pagesFetched < maxPages);
  } catch (e) {
    const msg = errorMessage(e);
    const looksExpired = msg.includes('CursorExpiredError') || msg.includes('cursor has expired');
    if (!looksExpired) return json({ error: 'Upstream Monday error', detail: msg }, 502);
    nextCursor = null;
  }

  return json({ cursor: nextCursor, totalLoaded: acc.length, items: acc });
};

// ---------- Helpers ----------
function json(obj, status = 200){
  return { statusCode: status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj) };
}

async function gql(query, variables, token){
  const controller = new AbortController();
  const t = setTimeout(()=>controller.abort(), 8500); // keep under Netlify time budget
  try{
    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization': token },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal
    });
    const j = await r.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    return j.data;
  } finally {
    clearTimeout(t);
  }
}

// Retry wrapper for gql-like functions
async function gqlWithRetry(fn, { retries = 2, timeoutMs = 8500 } = {}){
  let lastErr = null;
  for (let i = 0; i <= retries; i++){
    try{
      return await fn();
    } catch(e){
      lastErr = e;
      const msg = errorMessage(e);
      const aborted = /aborted|AbortError|The operation was aborted/i.test(msg);
      // Only retry on abort/timeout/network-ish errors
      if (!aborted && i === retries) break;
      await sleep(200 * (i + 1)); // backoff
    }
  }
  throw lastErr || new Error('Request failed');
}

function sleep(ms){ return new Promise(res=>setTimeout(res, ms)); }

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
  const n = +(`${t}`.replace(/[, $€£%]/g, '')); // accept %
  return isNaN(n) ? NaN : n;
}
function between(n, min, max){
  if (n === null || n === undefined || isNaN(n)) return true;
  return n >= min && n <= max;
}
function errorMessage(e){
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
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
