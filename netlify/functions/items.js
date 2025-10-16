// netlify/functions/items.js
// Reads Monday items_page and now accumulates multiple pages until we have
// at least N "Shareable" items (default N=20). Returns items plus a cursor.

export const handler = async (event) => {
  const TOKEN    = process.env.MONDAY_API_TOKEN;
  const BOARD_ID = process.env.MONDAY_BOARD_ID || '2738090584';

  // Health check
  if (event.queryStringParameters?.debug === 'env') {
    return json({ hasToken: !!TOKEN, boardId: BOARD_ID });
  }
  if (!TOKEN) return json({ error: 'No MONDAY_API_TOKEN set' }, 500);

  const p = event.queryStringParameters || {};
  const limit     = clampInt(p.limit, 100, 1, 200);     // default 100
  let   cursor    = p.cursor || null;
  const minFirst  = clampInt(p.min, 20, 0, 500);        // default 20 rows minimum
  const maxPages  = clampInt(p.maxPages, 5, 1, 10);     // safety cap
  const progressive = String(p.progressive || '').toLowerCase() === 'true';

  // Optional backend filters (mirrors your UI)
  const q      = (p.q || '').trim().toLowerCase();
  const stateF = (p.state || '').trim();
  const cMin   = toNum(p.costMin, -Infinity);
  const cMax   = toNum(p.costMax, +Infinity);
  const gMin   = toNum(p.gpaMin, -Infinity);
  const gMax   = toNum(p.gpaMax, +Infinity);

  // Monday query: one page, with column_values (id/type/text/value) for the board
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

  // Helper readers
  const gv    = (cols, id) => (cols.find(c => c.id === id)?.text || '').trim();
  const gvNum = (cols, id) => numFromText(gv(cols, id));

  // Shareable column logic
  const SHAREABLE_COL_ID = 'dup__of_sharable___bachelor_s___freshman___average_';
  const isShareable = (cols) => {
    const c = cols.find(x => x.id === SHAREABLE_COL_ID);
    if (!c) return false;
    if ((c.text || '').toLowerCase() === 'shareable') return true;
    try {
      const v = c.value && JSON.parse(c.value);
      if (v && (v.index === 1 || v.index === "1")) return true;
    } catch { /* ignore parse errors */ }
    return false;
  };

  // If called in debug mode, return a quick summary for a single page
  if ((p.debug || '').toLowerCase() === 'shareable') {
    try {
      const variables = { boardId: BOARD_ID, limit, cursor };
      const data  = await gql(query, variables, TOKEN);
      const page  = data?.boards?.[0]?.items_page || {};
      const items = Array.isArray(page.items) ? page.items : [];
      const shareable = items.filter(it => isShareable(it.column_values || []));
      return json({
        region: process.env.AWS_REGION || process.env.NETLIFY_REGION || 'unknown',
        boardId: BOARD_ID,
        requestedLimit: limit,
        receivedThisPage: items.length,
        shareableOnThisPage: shareable.length,
        cursorPresent: !!page.cursor,
        sampleIds: shareable.slice(0, 10).map(x => x.id),
        note: "This inspects only the current items_page."
      });
    } catch (e) {
      return json({ error: 'Debug fetch failed', detail: String(e && e.message || e) }, 502);
    }
  }

  // Accumulator
  const acc = [];

  // Process a raw page of items into our small shape and apply backend filters
  function process(items){
    const prepped = (items || [])
      .filter(it => isShareable(it.column_values || []))
      .map(it => {
        const cols = it.column_values || [];
        // NOTE: we keep raw column_values so the front-end can map 70+ columns
        return {
          id: it.id,
          name: it.name,
          state: gv(cols, 'state1'),          // "State" dropdown
          totalCost: gvNum(cols, 'formula'),  // (legacy) TOTAL (B) if present
          minGpa: gvNum(cols, 'numbers34'),   // GPA Minimum (Lowest Scholarship)
          column_values: cols
        };
      });

    // Optional backend filters to reduce payload early
    for (const row of prepped){
      // q search over name + majors (if present in raw)
      if (q) {
        const majors = gv(row.column_values || [], 'dropdown73'); // Bachelor's Study Areas (B)
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

  // Fetch loop: keep pulling pages until we have at least `minFirst`
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
      // Stop early if frontend asked for progressive “small first”
      if (progressive) break;
    } while (acc.length < minFirst && nextCursor && pagesFetched < maxPages);
  } catch (e) {
    // If Monday cursor expired mid-loop, return whatever we have, with no cursor
    const msg = String(e && e.message || e || '');
    const looksExpired = msg.includes('CursorExpiredError') || msg.includes('cursor has expired');
    if (!looksExpired) {
      return json({ error: 'Upstream Monday error', detail: msg }, 502);
    }
    nextCursor = null; // force frontend to refresh without cursor
  }

  return json({
    cursor: nextCursor,           // if present, UI can fetch the next page client-side
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
