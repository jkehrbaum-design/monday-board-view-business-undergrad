// netlify/functions/items.js
// Reads ALL Monday items (Shareable only), incl. all columns, and returns them in one response.
// - Server-side filter: SHAREABLE? (F) == "Shareable"
// - Auto-follows cursor to collect ALL items (no pagination for the client)
// - Optional backend filters: q (search), state, costMin/Max, gpaMin/Max

export const handler = async (event) => {
  const TOKEN    = process.env.MONDAY_API_TOKEN;
  const BOARD_ID = process.env.MONDAY_BOARD_ID || '2738090584';

  if (event.queryStringParameters?.debug === 'env') {
    return json({ hasToken: !!TOKEN, boardId: BOARD_ID });
  }
  if (!TOKEN) return json({ error: 'No MONDAY_API_TOKEN set' }, 500);

  const p = event.queryStringParameters || {};

  // Optional backend filters
  const q      = (p.q || '').trim().toLowerCase();
  const stateF = (p.state || '').trim();
  const cMin   = toNum(p.costMin, -Infinity);
  const cMax   = toNum(p.costMax, +Infinity);
  const gMin   = toNum(p.gpaMin, -Infinity);
  const gMax   = toNum(p.gpaMax, +Infinity);

  // We still use a per-page limit when talking to Monday, but we loop through all pages.
  const PAGE_LIMIT = clampInt(p.limit, 100, 1, 200); // 100 is a good tradeoff; Monday caps around here.

  // GraphQL with server-side "Shareable" filter
  const query = `
    query($boardId: [ID!], $limit: Int, $cursor: String){
      boards(ids: $boardId){
        items_page(
          limit: $limit
          cursor: $cursor
          query_params: {
            rules: [
              {
                column_id: "dup__of_sharable___bachelor_s___freshman___average_"
                operator: any_of
                compare_value: ["Shareable"]
              }
            ]
            operator: and
          }
        ){
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

  // ---- fetch ALL pages
  let cursor = null;
  let allItems = [];
  const SAFETY_MAX_PAGES = 200; // prevents runaway loops
  for (let i = 0; i < SAFETY_MAX_PAGES; i++) {
    const vars = { boardId: BOARD_ID, limit: PAGE_LIMIT, cursor };
    const data = await gql(query, vars, TOKEN);
    const page = data?.boards?.[0]?.items_page || {};
    const batch = Array.isArray(page.items) ? page.items : [];
    allItems.push(...batch);
    cursor = page.cursor || null;
    if (!cursor) break;
  }

  // helpers to read Monday values
  const gv    = (cols, id) => (cols.find(c => c.id === id)?.text || '').trim();
  const gvNum = (cols, id) => numFromText(gv(cols, id));

  // Prepare a few convenience fields; keep ALL raw columns in `column_values`
  const prepped = allItems.map(it => {
    const cols = it.column_values || [];
    return {
      id: it.id,
      name: it.name,
      state: gv(cols, 'state1'),          // "State" (dropdown)
      totalCost: gvNum(cols, 'formula'),  // TOTAL Approx Annual Cost (B)
      minGpa: gvNum(cols, 'numbers34'),   // GPA Minimum (F) (Lowest Scholarship)
      majors: gv(cols, 'dropdown73'),     // Bachelor's Study Areas (B)
      column_values: cols
    };
  });

  // Optional backend filters so the *client* always gets the final set already filtered
  const filtered = prepped.filter(row => {
    if (q) {
      const hay = (row.name + ' ' + (row.majors||'')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (stateF && stateF !== 'all') {
      if ((row.state || '').toLowerCase() !== stateF.toLowerCase()) return false;
    }
    if (!between(row.totalCost, cMin, cMax)) return false;
    if (!between(row.minGpa,   gMin, gMax)) return false;
    return true;
  });

  // Return everything at once; cursor is null because we've already consumed all pages
  return json({
    cursor: null,
    totalLoaded: filtered.length,
    items: filtered
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
