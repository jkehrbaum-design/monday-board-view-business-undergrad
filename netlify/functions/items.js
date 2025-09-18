// netlify/functions/items.js
// Reads Monday items incl. all columns and returns cursor + filter fields

export const handler = async (event) => {
  const TOKEN    = process.env.MONDAY_API_TOKEN;
  const BOARD_ID = process.env.MONDAY_BOARD_ID || '2761790925';

  if (event.queryStringParameters?.debug === 'env') {
    return json({ hasToken: !!TOKEN, boardId: BOARD_ID });
  }
  if (!TOKEN) return json({ error: 'No MONDAY_API_TOKEN set' }, 500);

  const p = event.queryStringParameters || {};

  const limit  = clampInt(p.limit, 50, 1, 200);
  const cursor = p.cursor || null;

  // Optional backend filters (keine Änderung gegenüber deiner Logik)
  const q      = (p.q || '').trim().toLowerCase();
  const stateF = (p.state || '').trim();
  const rMin   = toNum(p.rankMin, -Infinity);
  const rMax   = toNum(p.rankMax, +Infinity);
  const cMin   = toNum(p.costMin, -Infinity);
  const cMax   = toNum(p.costMax, +Infinity);
  const gMin   = toNum(p.gpaMin, -Infinity);
  const gMax   = toNum(p.gpaMax, +Infinity);

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

  // helper to read Monday values
  const gv    = (cols, id) => (cols.find(c => c.id === id)?.text || '').trim();
  const gvNum = (cols, id) => numFromText(gv(cols, id));

  // prepare a few convenience fields, but keep ALL raw columns in `column_values`
  const prepped = items.map(it => {
    const cols = it.column_values || [];
    return {
      id: it.id,
      name: it.name,
      state: gv(cols, 'dropdown'),
      ranking: gvNum(cols, 'numbers0'),       // Webometrics
      totalCost: gvNum(cols, 'formula27'),    // TOTAL Approx Annual Cost
      minGpa: gvNum(cols, 'numbers4'),        // GPA Minimum (Lowest Scholarship)
      majors: gv(cols, 'dropdown6'),          // Bachelor’s Study Areas
      column_values: cols                     // IMPORTANT: keep raw for frontend rendering
    };
  });

  // backend filter so pagination stays meaningful
  const filtered = prepped.filter(row => {
    if (q) {
      const hay = (row.name + ' ' + (row.majors||'')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (stateF && stateF !== 'all') {
      if ((row.state || '').toLowerCase() !== stateF.toLowerCase()) return false;
    }
    if (!between(row.ranking,  rMin, rMax)) return false;
    if (!between(row.totalCost, cMin, cMax)) return false;
    if (!between(row.minGpa,   gMin, gMax)) return false;
    return true;
  });

  return json({
    cursor: page.cursor || null,
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
