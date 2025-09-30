// netlify/functions/items.js
// Reads Monday items (all pages), filters to "Shareable" only, returns items + convenience fields

export const handler = async (event) => {
  const TOKEN    = process.env.MONDAY_API_TOKEN;
  const BOARD_ID = process.env.MONDAY_BOARD_ID || '2738090584';

  if (event.queryStringParameters?.debug === 'env') {
    return json({ hasToken: !!TOKEN, boardId: BOARD_ID });
  }
  if (!TOKEN) return json({ error: 'No MONDAY_API_TOKEN set' }, 500);

  const p = event.queryStringParameters || {};
  // Optional backend filters (same idea as before)
  const q      = (p.q || '').trim().toLowerCase();
  const stateF = (p.state || '').trim();
  const cMin   = toNum(p.costMin, -Infinity);
  const cMax   = toNum(p.costMax, +Infinity);
  const gMin   = toNum(p.gpaMin, -Infinity);
  const gMax   = toNum(p.gpaMax, +Infinity);

  // Always fetch all pages (we'll still use a sane page size per call)
  const pageSize = clampInt(p.limit, 200, 1, 200); // 200 is Monday's practical page size
  const allItems = await fetchAllItems(BOARD_ID, pageSize, TOKEN);

  // Column helpers
  const gv    = (cols, id) => (cols.find(c => c.id === id)?.text || '').trim();
  const gvNum = (cols, id) => numFromText(gv(cols, id));

  // Only keep items that are explicitly Shareable
  const filteredByShareable = allItems.filter(it => isShareable(it.column_values));

  // Map convenience fields for frontend (keep all raw cols too)
  const prepped = filteredByShareable.map(it => {
    const cols = it.column_values || [];
    return {
      id: it.id,
      name: it.name,
      state: gv(cols, 'state1'),          // State
      totalCost: gvNum(cols, 'formula'),  // TOTAL (Approximate Annual Cost in USD) (B)
      minGpa: gvNum(cols, 'numbers34'),   // GPA Minimum (F) (Lowest Scholarship)
      majors: gv(cols, 'dropdown73'),     // Bachelor's Study Areas (B)
      column_values: cols                 // raw for frontend renderer
    };
  });

  // Optional backend filters so the response stays tight if you use them
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

  return json({
    cursor: null,           // we fetched everything
    totalLoaded: filtered.length,
    items: filtered
  });
};

// ---- core fetch (follows cursor until finished) ----
async function fetchAllItems(boardId, pageSize, token){
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
  const varsBase = { boardId, limit: pageSize, cursor: null };
  const out = [];
  let cursor = null;

  do {
    const data = await gql(query, { ...varsBase, cursor }, token);
    const page = data?.boards?.[0]?.items_page || {};
    const items = Array.isArray(page.items) ? page.items : [];
    out.push(...items);
    cursor = page.cursor || null;
  } while (cursor);

  return out;
}

// ---- Shareable filter (text OR index match) ----
function isShareable(cols){
  const c = cols?.find(x => x.id === 'dup__of_sharable___bachelor_s___freshman___average_');
  if (!c) return false;
  const t = (c.text || '').trim();
  if (t && t.toLowerCase() === 'shareable') return true;

  // Fallback: parse status index from value JSON
  if (c.value) {
    try {
      const v = JSON.parse(c.value);
      // On your board, Shareable has index 1 (per your Playground sample).
      // If you later change label ordering, update this number.
      if (typeof v.index === 'number' && v.index === 1) return true;
    } catch {}
  }
  return false;
}

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
