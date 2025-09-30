// netlify/functions/items.js
// Returns one page of Monday items, already filtered to "Shareable" only.
// The frontend will keep calling this endpoint with the provided cursor
// until it becomes null, so we avoid long-running functions and 504s.

export const handler = async (event) => {
  const TOKEN    = process.env.MONDAY_API_TOKEN;
  const BOARD_ID = process.env.MONDAY_BOARD_ID || '2738090584';

  // Quick env sanity check
  if (event.queryStringParameters?.debug === 'env') {
    return json({ hasToken: !!TOKEN, boardId: BOARD_ID });
  }
  if (!TOKEN) return json({ error: 'No MONDAY_API_TOKEN set' }, 500);

  // Shareable status column (from your board)
  const SHARE_COL_ID = 'dup__of_sharable___bachelor_s___freshman___average_'; // "SHAREABLE? (F)"

  // Paging
  const p      = event.queryStringParameters || {};
  const limit  = clampInt(p.limit, 200, 1, 200); // keep it fast (max 200 per request)
  const cursor = p.cursor || null;

  // GraphQL: fetch a single page of items with ALL column values
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

  const variables = { boardId: BOARD_ID, limit, cursor };
  const data  = await gql(query, variables, TOKEN);
  const page  = data?.boards?.[0]?.items_page || {};
  const items = Array.isArray(page.items) ? page.items : [];

  // ---- helpers to read Monday values
  const gv    = (cols, id) => (cols.find(c => c.id === id)?.text || '').trim();
  const gvRaw = (cols, id) => cols.find(c => c.id === id)?.value || null;
  const gvNum = (cols, id) => numFromText(gv(cols, id));

  // Keep only rows with Shareable status selected
  const shareableOnly = items.filter(it => {
    const cols = it.column_values || [];
    const txt  = gv(cols, SHARE_COL_ID);              // human label, e.g. "Shareable"
    if (txt && txt.toLowerCase() === 'shareable') return true;

    // Fallback: check status index in .value JSON (index 1 is "Shareable" in your board)
    try {
      const v = gvRaw(cols, SHARE_COL_ID);
      if (!v) return false;
      const parsed = JSON.parse(v);
      return parsed && parsed.index === 1;
    } catch {
      return false;
    }
  });

  // Prepare a few convenience fields (frontend still receives ALL raw columns)
  const prepped = shareableOnly.map(it => {
    const cols = it.column_values || [];
    return {
      id: it.id,
      name: it.name,
      state: gv(cols, 'state1'),          // State
      totalCost: gvNum(cols, 'formula'),  // TOTAL (Approx Annual Cost in USD) (B)
      minGpa: gvNum(cols, 'numbers34'),   // GPA Minimum (F) (Lowest Scholarship)
      majors: gv(cols, 'dropdown73'),     // Bachelor's Study Areas (B)
      column_values: cols                 // pass all raw columns through
    };
  });

  return json({
    cursor: page.cursor || null,
    totalLoaded: prepped.length,
    items: prepped
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
function numFromText(t){
  if (!t) return NaN;
  const n = +(`${t}`.replace(/[, $€£]/g, ''));
  return isNaN(n) ? NaN : n;
}
