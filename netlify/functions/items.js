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

  // ======== ADD: Enrich missing formula values so UI always sees them ========
  // Column IDs used in formulas and fallbacks
  const FORM_COL = {
    tuition: 'annual_tuition_cost',
    room: '_usd__annual_room_cost',
    board: '_usd__annual_board_cost',
    fees: 'numbers5',

    total: 'formula',      // TOTAL (Approximate Annual Cost in USD)

    schLow: 'dup__of_minimum__usd__annual_scholarship_amount6',
    schMid: 'numbers68',
    schHi:  'numbers11',

    netLow: 'formula3',    // (Lowest) Possible Net Cost of Attendance
    netMid: 'formula07',   // (Mid-Range) Possible Net Cost of Attendance
    netHi:  'formula9',    // (Highest) Possible Net Cost of Attendance

    workComp:   'formula5',   // Annual Work on Campus Compensation (Most Probable)
    minWage:    'numbers985',
    workDetail: 'long_text56' // “Work on Campus Details”
  };

  function amt(x){
    if (x == null) return null;
    const s = String(x).replace(/[^\d.\-]/g,'');
    if (!s) return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  function findCV(cols, id){ return (cols||[]).find(c => c.id === id); }
  function getNumCV(cols, id){
    const cv = findCV(cols, id);
    return amt(cv?.text ?? cv?.value);
  }
  function setTextCV(rowOrItem, id, text){
    const t = (text == null) ? '' : String(text);
    const cols = (rowOrItem.column_values ||= []);
    const cv = cols.find(c => c.id === id);
    if (cv){
      cv.text = t;
      cv.value = t;
    } else {
      cols.push({ id, type:'text', text:t, value:t });
    }
  }
  const r0 = (n) => (n == null ? null : Math.round(n));
  function deriveWorkComp(minWage, details){
    if (!minWage || !details) return null;
    const m = String(details).match(/(\d+)\s*hours?\s*\/?\s*week.*?(\d+)\s*weeks?/i);
    if (!m) return null;
    const hrs = parseInt(m[1],10); const wks = parseInt(m[2],10);
    if (!hrs || !wks) return null;
    return minWage * hrs * wks;
  }

  for (const row of prepped){
    const cols = row.column_values || [];

    const tuition = getNumCV(cols, FORM_COL.tuition) || 0;
    const room    = getNumCV(cols, FORM_COL.room)    || 0;
    const board   = getNumCV(cols, FORM_COL.board)   || 0;
    const fees    = getNumCV(cols, FORM_COL.fees)    || 0;

    // 1) TOTAL = Tuition + Room + Board + Fees (if Monday didn't send it)
    let total = getNumCV(cols, FORM_COL.total);
    if (total == null) {
      total = tuition + room + board + fees;
      setTextCV(row, FORM_COL.total, r0(total));
    }
    if (row.totalCost == null) row.totalCost = total;

    // 2) Net costs
    const schLow = getNumCV(cols, FORM_COL.schLow) || 0;
    const schMid = getNumCV(cols, FORM_COL.schMid) || 0;
    const schHi  = getNumCV(cols, FORM_COL.schHi)  || 0;

    const netLow = total - schHi;  // (Lowest) = TOTAL - Highest scholarship
    const netMid = total - schMid; // (Mid)    = TOTAL - Mid scholarship
    const netHi  = total - schLow; // (Highest)= TOTAL - Lowest scholarship

    setTextCV(row, FORM_COL.netLow, r0(netLow));
    setTextCV(row, FORM_COL.netMid, r0(netMid));
    setTextCV(row, FORM_COL.netHi,  r0(netHi));

    // 3) Work compensation (use Monday if present; else derive conservatively)
    let wc = getNumCV(cols, FORM_COL.workComp);
    if (wc == null){
      const minW = getNumCV(cols, FORM_COL.minWage);
      const det  = findCV(cols, FORM_COL.workDetail)?.text || '';
      const derived = deriveWorkComp(minW, det);
      if (derived != null) wc = derived;
    }
    if (wc != null) setTextCV(row, FORM_COL.workComp, r0(wc));
  }
  // ======== /formula enrichment ========

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
