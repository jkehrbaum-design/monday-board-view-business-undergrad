// netlify/functions/items.js
// Reads Monday items_page and accumulates multiple pages until we have
// at least N "Shareable" items (default N=20). Returns items plus a cursor.

// ---- Safe env access for Node (process.env) AND Edge (Deno.env) ----
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
      detail: 'MONDAY_API_TOKEN is not set. In Netlify, go to Site settings → Build & deploy → Environment → Environment variables and add MONDAY_API_TOKEN (and optionally MONDAY_BOARD_ID).',
      runtime: runtimeInfo()
    }, 500);
  }

  const p = event.queryStringParameters || {};
  const limit       = clampInt(p.limit, 100, 1, 200);  // Monday page size per request
  let   cursor      = p.cursor || null;
  const minFirst    = clampInt(p.min, 20, 0, 500);     // minimum rows to return in first response
  const maxPages    = clampInt(p.maxPages, 5, 1, 10);  // safety cap on pages per call
  const progressive = String(p.progressive || '').toLowerCase() === 'true';

  // Optional backend filters (mirrors your UI)
  const q      = (p.q || '').trim().toLowerCase();
  const stateF = (p.state || '').trim();
  const cMin   = toNum(p.costMin, -Infinity);
  const cMax   = toNum(p.costMax, +Infinity);
  const gMin   = toNum(p.gpaMin, -Infinity);
  const gMax   = toNum(p.gpaMax, +Infinity);

  // Monday query
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

  // Helpers to read Monday columns
  const gv    = (cols, id) => (cols.find(c => c.id === id)?.text || '').trim();
  const gvNum = (cols, id) => numFromText(gv(cols, id));

  // Shareable logic
  const SHAREABLE_COL_ID = 'dup__of_sharable___bachelor_s___freshman___average_';
  const isShareable = (cols) => {
    const c = cols.find(x => x.id === SHAREABLE_COL_ID);
    if (!c) return false;
    if ((c.text || '').toLowerCase() === 'shareable') return true;
    try {
      const v = c.value && JSON.parse(c.value);
      if (v && (v.index === 1 || v.index === "1")) return true;
    } catch { /* ignore */ }
    return false;
  };

  // Debug (single page peek)
  if ((p.debug || '').toLowerCase() === 'shareable') {
    try {
      const variables = { boardId: BOARD_ID, limit, cursor };
      const data  = await gql(query, variables, TOKEN);
      const page  = data?.boards?.[0]?.items_page || {};
      const items = Array.isArray(page.items) ? page.items : [];
      const shareable = items.filter(it => isShareable(it.column_values || []));
      return json({
        region: getEnv('AWS_REGION') || getEnv('NETLIFY_REGION') || 'unknown',
        boardId: BOARD_ID,
        requestedLimit: limit,
        receivedThisPage: items.length,
        shareableOnThisPage: shareable.length,
        cursorPresent: !!page.cursor,
        sampleIds: shareable.slice(0, 10).map(x => x.id),
        note: "This inspects only the current items_page."
      });
    } catch (e) {
      return json({ error: 'Debug fetch failed', detail: errorMessage(e) }, 502);
    }
  }

  // Accumulator
  const acc = [];

  // Convert raw items to small shape + apply backend filters
  function process(items){
    const prepped = (items || [])
      .filter(it => isShareable(it.column_values || []))
      .map(it => {
        const cols = it.column_values || [];
        return {
          id: it.id,
          name: it.name,
          state: gv(cols, 'state1'),
          totalCost: gvNum(cols, 'formula'),
          minGpa: gvNum(cols, 'numbers34'),
          column_values: cols
        };
      });

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

  // Fetch loop
  let pagesFetched = 0;
  let nextCursor = cursor;
  try {
    do {
      const variables = { boardId: BOARD_ID, limit, cursor: nextCursor || null };
      const data  = await gql(query, variables, TOKEN);
      const page  = data?.boards?.[0]?.items_page || {};
      const items = Array.isArray(page.items) ? page.items : [];
      process(items);
      nextCursor = page.cursor || null;
      pagesFetched++;
      if (progressive) break; // allow client to progressively load
    } while (acc.length < minFirst && nextCursor && pagesFetched < maxPages);
  } catch (e) {
    const msg = errorMessage(e);
    const looksExpired = msg.includes('CursorExpiredError') || msg.includes('cursor has expired');
    if (!looksExpired) {
      return json({ error: 'Upstream Monday error', detail: msg }, 502);
    }
    // Return what we have and force client to refresh without cursor
    nextCursor = null;
  }

  return json({
    cursor: nextCursor,
    totalLoaded: acc.length,
    items: acc
  });
};

// ---------- Helpers ----------
function json(obj, status = 200){
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj)
  };
}
async function gql(query, variables, token){
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization': token },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}
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
  const n = +(`${t}`.replace(/[, $€£]/g, ''));
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
