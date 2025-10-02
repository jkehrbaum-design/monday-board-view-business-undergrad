// netlify/functions/items.js
// Reads ONE Monday items_page and returns only "Shareable" items (plus cursor)
// Frontend can keep calling with the returned cursor to progressively load all.

export const handler = async (event) => {
  const TOKEN    = process.env.MONDAY_API_TOKEN;
  const BOARD_ID = process.env.MONDAY_BOARD_ID || '2738090584';

  // Health check
  if (event.queryStringParameters?.debug === 'env') {
    return json({ hasToken: !!TOKEN, boardId: BOARD_ID });
  }
  if (!TOKEN) return json({ error: 'No MONDAY_API_TOKEN set' }, 500);

  const p = event.queryStringParameters || {};
  const limit  = clampInt(p.limit, 50, 1, 200); // default 50 (safer regionally)
  const cursor = p.cursor || null;

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

  const variables = { boardId: BOARD_ID, limit, cursor };
  const data  = await gql(query, variables, TOKEN);
  const page  = data?.boards?.[0]?.items_page || {};
  const items = Array.isArray(page.items) ? page.items : [];

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

  // If called in debug mode, return a quick summary for this single page
  if ((p.debug || '').toLowerCase() === 'shareable') {
    const shareable = items.filter(it => isShareable(it.column_values || []));
    return json({
      region: process.env.AWS_REGION || process.env.NETLIFY_REGION || 'unknown',
      boardId: BOARD_ID,
      requestedLimit: limit,
      receivedThisPage: items.length,
      shareableOnThisPage: shareable.length,
      cursorPresent: !!page.cursor,
      sampleIds: shareable.slice(0, 10).map(x => x.id),
      note: "This inspects only the current items_page to avoid timeouts. The UI should keep calling with the returned cursor to load the rest."
    });
  }

  // Prepare small shape for the UI but keep ALL raw columns for rendering
  const prepped = items
    .filter(it => isShareable(it.column_values || []))
    .map(it => {
      const cols = it.column_values || [];
      return {
        id: it.id,
        name: it.name,
        state: gv(cols, 'state1'),          // "State" dropdown
        totalCost: gvNum(cols, 'formula'),  // TOTAL (B) (id "formula")
        minGpa: gvNum(cols, 'numbers34'),   // GPA Minimum (Lowest Scholarship)
        majors: gv(cols, 'dropdown73'),     // Bachelor's Study Areas (B)
        column_values: cols                 // keep raw for UI mapping (70+ columns)
      };
    });

  // Optional backend filters to reduce payload early
  const filtered = prepped.filter(row => {
    if (q) {
      const hay = (row.name + ' ' + (row.majors || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (stateF && stateF !== 'all') {
      if ((row.state || '').toLowerCase() !== stateF.toLowerCase()) return false;
    }
    if (!between(row.totalCost, cMin, cMax)) return false;
    if (!between(row.minGpa,   gMin, gMax)) return false;
    return true;
  });

  return json({
    cursor: page.cursor || null,   // if present, the UI should fetch the next page client-side
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
