// netlify/functions/items.js
// Reads all Monday items for the board, filters to "Shareable" only, and returns items + debug

export const handler = async (event) => {
  const TOKEN    = process.env.MONDAY_API_TOKEN;
  const BOARD_ID = process.env.MONDAY_BOARD_ID || '2738090584';

  if (event.queryStringParameters?.debug === 'env') {
    return json({ hasToken: !!TOKEN, boardId: BOARD_ID });
  }
  if (!TOKEN) return json({ error: 'No MONDAY_API_TOKEN set' }, 500);

  // === Params (optional backend filters used by your frontend) ===
  const p       = event.queryStringParameters || {};
  const limit   = clampInt(p.limit, 100, 1, 200); // page size per Monday request; we still fetch ALL pages
  const q       = (p.q || '').trim().toLowerCase();
  const stateF  = (p.state || '').trim();
  const cMin    = toNum(p.costMin, -Infinity);
  const cMax    = toNum(p.costMax, +Infinity);
  const gMin    = toNum(p.gpaMin, -Infinity);
  const gMax    = toNum(p.gpaMax, +Infinity);

  // === Monday column we filter on ===
  const SHARE_COL_ID = 'dup__of_sharable___bachelor_s___freshman___average_';
  const SHARE_LABELS = new Set(['shareable']); // allow exact label by text (case-insensitive)
  const SHARE_INDEX  = 1;                      // and/or by status index number

  // === GraphQL (items_page) ===
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
    }
  `;

  // === Fetch ALL pages ===
  let cursor = null;
  let fetchedItems = [];
  let safety = 0; // safety stop in case of unexpected loops
  try {
    do {
      const variables = { boardId: BOARD_ID, limit, cursor };
      const data = await gql(query, variables, TOKEN);
      const page = data?.boards?.[0]?.items_page || {};
      const items = Array.isArray(page.items) ? page.items : [];
      fetchedItems.push(...items);
      cursor = page.cursor || null;

      if (++safety > 500) { // absurdly high ceiling
        throw new Error('Pagination safety stop triggered.');
      }
    } while (cursor);
  } catch (e) {
    return json({ error: 'GraphQL fetch failed', details: String(e) }, 500);
  }

  // === Helpers for reading columns ===
  const getCol = (cols, id) => (cols.find(c => c.id === id) || null);
  const hasShareable = (cols) => {
    const c = getCol(cols, SHARE_COL_ID);
    if (!c) return false;
    const text = (c.text || '').trim().toLowerCase();
    if (text && SHARE_LABELS.has(text)) return true;

    // sometimes Monday gives us only a JSON value with an index (and empty text)
    if (c.value) {
      try {
        const v = JSON.parse(c.value);
        if (typeof v?.index === 'number' && v.index === SHARE_INDEX) return true;
      } catch { /* ignore parse errors */ }
    }
    return false;
  };

  // === Server-side Shareable filter (hard requirement) ===
  const shareableItems = fetchedItems.filter(it => {
    const cols = Array.isArray(it.column_values) ? it.column_values : [];
    return hasShareable(cols);
  });

  // === Convenience fields (keep raw column_values for the frontend) ===
  const gv    = (cols, id) => (cols.find(c => c.id === id)?.text || '').trim();
  const gvNum = (cols, id) => numFromText(gv(cols, id));

  const prepped = shareableItems.map(it => {
    const cols = it.column_values || [];
    return {
      id: it.id,
      name: it.name,
      // Map to your live board’s column IDs:
      state: gv(cols, 'state1'),             // "State"
      totalCost: gvNum(cols, 'formula'),     // TOTAL Approx Annual Cost (B) - formula
      minGpa: gvNum(cols, 'numbers34'),      // GPA Minimum (F) (Lowest Scholarship)
      majors: gv(cols, 'dropdown73'),        // Bachelor’s Study Areas (B)
      column_values: cols                    // keep raw for frontend rendering
    };
  });

  // === Optional backend filters (to keep pagination meaningful originally; harmless here) ===
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

  // === Debug view (?debug=shareable) ===
  if ((p.debug || '').toLowerCase() === 'shareable') {
    const withCol = fetchedItems.filter(it => getCol(it.column_values || [], SHARE_COL_ID));
    const sample = filtered.slice(0, 10).map(x => ({ id: x.id, name: x.name }));
    return json({
      fetched: fetchedItems.length,
      withColumn: withCol.length,
      shareable: shareableItems.length,
      afterOptionalFilters: filtered.length,
      sample // first few shareable rows after optional filters
    });
  }

  // === Normal response ===
  return json({
    cursor: null,               // no further pagination needed client-side
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

