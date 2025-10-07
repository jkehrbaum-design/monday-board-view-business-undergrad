// netlify/functions/items.js
// Reads ONE Monday items_page and returns only "Shareable" items (plus cursor)
// Adds backend-calculated fields for totals & net costs so the UI can display them reliably.

export const handler = async (event) => {
  const TOKEN    = process.env.MONDAY_API_TOKEN;
  const BOARD_ID = process.env.MONDAY_BOARD_ID || '2738090584';

  // Health check
  if (event.queryStringParameters?.debug === 'env') {
    return json({ hasToken: !!TOKEN, boardId: BOARD_ID });
  }
  if (!TOKEN) return json({ error: 'No MONDAY_API_TOKEN set' }, 500);

  const p = event.queryStringParameters || {};
  const limit  = clampInt(p.limit, 50, 1, 200);
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

  // Helpers to read column text/number
  const gv    = (cols, id) => (cols.find(c => c.id === id)?.text || '').trim();
  const gvNum = (cols, id) => numFromText(gv(cols, id)); // returns NaN if not parseable

  // Shareable status
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

  // Quick debug of current page only
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
      note: "This inspects only the current items_page. The UI should keep calling with the returned cursor to load the rest."
    });
  }

  // === Backend calculations (replaces Monday formula cols when needed) =====
  function calcTotals(cols){
    const tuition = gvNum(cols, 'annual_tuition_cost');
    const room    = gvNum(cols, '_usd__annual_room_cost');
    const board   = gvNum(cols, '_usd__annual_board_cost');
    const fees    = gvNum(cols, 'numbers5');

    const parts = [tuition, room, board, fees].filter(n => Number.isFinite(n));
    const total = parts.length ? parts.reduce((a,b)=>a+b, 0) : NaN;

    const schLow = gvNum(cols, 'dup__of_minimum__usd__annual_scholarship_amount6'); // Lowest scholarship $
    const schMid = gvNum(cols, 'numbers68');  // Mid-Range scholarship $
    const schHi  = gvNum(cols, 'numbers11');  // Highest scholarship $

    // Net costs (per your definitions):
    // net_low = TOTAL - Highest scholarship
    // net_mid = TOTAL - Mid-Range scholarship
    // net_hi  = TOTAL - Lowest scholarship
    const net_low = Number.isFinite(total) && Number.isFinite(schHi)  ? (total - schHi)  : NaN;
    const net_mid = Number.isFinite(total) && Number.isFinite(schMid) ? (total - schMid) : NaN;
    const net_hi  = Number.isFinite(total) && Number.isFinite(schLow) ? (total - schLow) : NaN;

    // Work comp: prefer the Monday formula if present; else estimate from min_wage
    // Estimation heuristic: 10 hrs/week * 30 weeks ≈ 300 hours
    const mondayWork = gvNum(cols, 'formula5'); // if Monday had a formula, use it
    const minWage    = gvNum(cols, 'numbers985'); // 2025 Min Wage
    const work_calc  = Number.isFinite(mondayWork)
      ? mondayWork
      : (Number.isFinite(minWage) ? (minWage * 300) : NaN);

    return {
      total_calc:   Number.isFinite(total)   ? total   : null,
      net_low_calc: Number.isFinite(net_low) ? net_low : null,
      net_mid_calc: Number.isFinite(net_mid) ? net_mid : null,
      net_hi_calc:  Number.isFinite(net_hi)  ? net_hi  : null,
      work_comp_calc: Number.isFinite(work_calc) ? work_calc : null
    };
  }
  // ========================================================================

  // Prepare shape for UI
  const prepped = items
    .filter(it => isShareable(it.column_values || []))
    .map(it => {
      const cols = it.column_values || [];
      const totals = calcTotals(cols);

      return {
        id: it.id,
        name: it.name,
        state: gv(cols, 'state1'),
        totalCost: gvNum(cols, 'formula'),         // keep original (if any) for backend filtering
        minGpa: gvNum(cols, 'numbers34'),          // GPA Minimum (Lowest Scholarship)
        majors: gv(cols, 'dropdown73'),

        // Expose ALL raw column_values for UI rendering
        column_values: cols,

        // Expose backend-calculated fields at top level so the UI can read them by colId
        // (The new index.html checks item[colId] before Monday column_values)
        total_calc: totals.total_calc,
        net_low_calc: totals.net_low_calc,
        net_mid_calc: totals.net_mid_calc,
        net_hi_calc: totals.net_hi_calc,
        work_comp_calc: totals.work_comp_calc
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
