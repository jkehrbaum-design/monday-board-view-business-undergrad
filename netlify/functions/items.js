// netlify/functions/items.js
// Reads Monday items (entire board), filters to SHAREABLE? (F) = "Shareable",
// and returns items with computed fallbacks for key formula columns.

export const handler = async (event) => {
  const TOKEN    = process.env.MONDAY_API_TOKEN;
  const BOARD_ID = process.env.MONDAY_BOARD_ID || '2738090584';

  if (event.queryStringParameters?.debug === 'env') {
    return json({ hasToken: !!TOKEN, boardId: BOARD_ID });
  }
  if (!TOKEN) return json({ error: 'No MONDAY_API_TOKEN set' }, 500);

  // --- Query all pages (internal page size 200) ---
  const allItems = [];
  let cursor = null;
  const PAGE_LIMIT = 200;

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

  try {
    while (true) {
      const variables = { boardId: BOARD_ID, limit: PAGE_LIMIT, cursor };
      const data  = await gql(query, variables, TOKEN);
      const page  = data?.boards?.[0]?.items_page || {};
      const items = Array.isArray(page.items) ? page.items : [];
      allItems.push(...items);
      cursor = page.cursor || null;
      if (!cursor) break;
    }
  } catch (e) {
    return json({ error: 'GraphQL fetch failed', details: String(e) }, 500);
  }

  // --- Helpers to read Monday values ---
  const gv     = (cols, id) => (cols.find(c => c.id === id)?.text || '').trim();
  const graw   = (cols, id) => cols.find(c => c.id === id); // full object
  const gvNum  = (cols, id) => numFromText(gv(cols, id));
  const gvStatIndex = (cols, id) => {
    const raw = graw(cols, id)?.value;
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      if (typeof v?.index === 'number') return v.index;
      return null;
    } catch { return null; }
  };

  // --- Column IDs we rely on for fallbacks / filters ---
  const COL = {
    // Filter column
    shareable: 'dup__of_sharable___bachelor_s___freshman___average_',

    // Totals
    tuition: 'annual_tuition_cost',
    room: '_usd__annual_room_cost',
    board: '_usd__annual_board_cost',
    fees: 'numbers5',

    // Scholarships
    sch_low: 'dup__of_minimum__usd__annual_scholarship_amount6',
    sch_mid: 'numbers68',
    sch_hi:  'numbers11',

    // Formula columns (as they exist on Monday)
    total_formula:   'formula',    // TOTAL (Approximate Annual Cost in USD) (B)
    net_low_formula: 'formula3',   // (Lowest) Possible Net Cost of Attendance (F)
    net_mid_formula: 'formula07',  // (Mid-Range) Possible Net Cost of Attendance (F)
    net_hi_formula:  'formula9',   // (Highest) Possible Net Cost of Attendance (F)
    work_comp_formula: 'formula5', // Annual Work on Campus Compensation (Most Probable) (B)

    // Employment + min wage
    campus_job: 'status_113',  // "Bachelor's - Campus Employment Opportunities? (B)"
    min_wage:   'numbers985',  // 2025 Minimum Wage

    // Convenience fields used by frontend
    state:  'state1',
    gpa:    'numbers34',   // GPA Min (Lowest Scholarship)
    majors: 'dropdown73',  // Bachelor’s Study Areas
  };

  // Business rule for work compensation fallback:
  const HOURS_PER_WEEK = 20;
  const WEEKS_PER_YEAR = 32;

  // --- Derive, filter, and compute fallbacks ---
  let fetchedCount = allItems.length;
  const prepped = [];

  for (const it of allItems) {
    const cols = it.column_values || [];

    // Filter to SHAREABLE? (F) = "Shareable"
    const shareableText  = gv(cols, COL.shareable);
    const shareableIndex = gvStatIndex(cols, COL.shareable);
    const isShareable = (shareableText.toLowerCase() === 'shareable') || (shareableIndex === 1);
    if (!isShareable) continue;

    // Raw number inputs
    const tuition = gvNum(cols, COL.tuition);
    const room    = gvNum(cols, COL.room);
    const board   = gvNum(cols, COL.board);
    const fees    = gvNum(cols, COL.fees);

    const lowSch  = gvNum(cols, COL.sch_low);
    const midSch  = gvNum(cols, COL.sch_mid);
    const hiSch   = gvNum(cols, COL.sch_hi);

    const minWage = gvNum(cols, COL.min_wage);
    const campusJobText = gv(cols, COL.campus_job); // "Yes"/"No"/etc.

    // Try Monday-provided formulas first
    let total      = gvNum(cols, COL.total_formula);
    let netLow     = numFromText(gv(cols, COL.net_low_formula));
    let netMid     = numFromText(gv(cols, COL.net_mid_formula));
    let netHigh    = numFromText(gv(cols, COL.net_hi_formula));
    let workComp   = gvNum(cols, COL.work_comp_formula);

    // Fallback TOTAL if missing
    if (!isFiniteNum(total)) {
      const sumParts = [tuition, room, board, fees].filter(isFiniteNum);
      total = sumParts.length === 4 ? sumParts.reduce((a,b)=>a+b,0) : null;
    }

    // Fallback Net Costs if missing (your confirmed formulas)
    // formula3  = TOTAL − Highest scholarship
    if (!isFiniteNum(netLow)) {
      netLow = (isFiniteNum(total) && isFiniteNum(hiSch)) ? (total - hiSch) : null;
    }
    // formula07 = TOTAL − Mid-Range scholarship
    if (!isFiniteNum(netMid)) {
      netMid = (isFiniteNum(total) && isFiniteNum(midSch)) ? (total - midSch) : null;
    }
    // formula9  = TOTAL − Lowest scholarship
    if (!isFiniteNum(netHigh)) {
      netHigh = (isFiniteNum(total) && isFiniteNum(lowSch)) ? (total - lowSch) : null;
    }

    // Fallback Work Compensation if missing (your confirmed rule)
    // IF campus employment == "No" → 0, else minWage * 20 * 32
    if (!isFiniteNum(workComp)) {
      const hasCampusJob = campusJobText && campusJobText.toLowerCase() !== 'no';
      if (!hasCampusJob) workComp = 0;
      else if (isFiniteNum(minWage)) workComp = minWage * HOURS_PER_WEEK * WEEKS_PER_YEAR;
      else workComp = null;
    }

    prepped.push({
      id: it.id,
      name: it.name,
      state: gv(cols, COL.state),
      totalCost: isFiniteNum(total) ? total : null,
      minGpa: gvNum(cols, COL.gpa),
      majors: gv(cols, COL.majors),

      // expose raw for frontend
      column_values: cols,

      // expose computed/derived for frontend columns that expect them
      _computed: {
        total,          // mirrors 'formula'
        net_low:  isFiniteNum(netLow)  ? netLow  : null,  // formula3
        net_mid:  isFiniteNum(netMid)  ? netMid  : null,  // formula07
        net_hi:   isFiniteNum(netHigh) ? netHigh : null,  // formula9
        work_comp: isFiniteNum(workComp)? workComp: null, // formula5
        min_wage:  isFiniteNum(minWage) ? minWage : null,
        campus_job_text: campusJobText || ''
      }
    });
  }

  // Optional quick debug
  if (event.queryStringParameters?.debug === 'shareable') {
    const withTotals = prepped.filter(x => isFiniteNum(x._computed.total)).length;
    const withNetAny = prepped.filter(x => isFiniteNum(x._computed.net_low) || isFiniteNum(x._computed.net_mid) || isFiniteNum(x._computed.net_hi)).length;
    const withWork   = prepped.filter(x => isFiniteNum(x._computed.work_comp)).length;
    return json({
      fetched: fetchedCount,
      shareable: prepped.length,
      totals_present: withTotals,
      any_net_present: withNetAny,
      work_comp_present: withWork
    });
  }

  return json({
    cursor: null,                 // we returned all items
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
function numFromText(t){
  if (!t && t !== 0) return NaN;
  const n = +String(t).replace(/[^\d.\-]/g, '');
  return Number.isFinite(n) ? n : NaN;
}
function isFiniteNum(n){
  return typeof n === 'number' && Number.isFinite(n);
}
