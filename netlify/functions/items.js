// netlify/functions/items.js
// Holt Items + unterstützt: Pagination, Filter, und liefert bei dict=state alle State-Labels (Dropdown-Column settings)

const MONDAY_URL = 'https://api.monday.com/v2';

const COL = {
  STATE: 'dropdown',
  RANKING: 'numbers0',
  FINAL_COST: 'formula27',
  TUITION: 'numbers72',
  ROOM: 'numbers_11',
  BOARD: 'numbers_24',
  FEES: 'numbers_3',
  MAJOR_PRIMARY: 'dropdown6',
  MAJORS_EXTRA: [
    'dropdown71',
    'dup__of_architecture__b_',
    'dup__of_arts__b_',
    'dup__of_business__b_',
    'dup__of_engineering__b_',
    'dup__of_humanities__b_',
    'dropdown9',
    'dup__of_dropdown8',
    'dup__of_dropdown',
    'dup__of_dup__of_dropdown'
  ],
  GPA_LOW: 'numbers4',
  GPA_MID: 'numbers_23',
  GPA_HIGH: 'numbers43',
};

function parseNumber(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[,$\s]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}
function pick(cvMap, id) { return cvMap.get(id)?.text ?? ''; }
function pickN(cvMap, id) { return parseNumber(cvMap.get(id)?.text); }

function mergeMajors(cvMap) {
  const parts = [];
  const prim = pick(cvMap, COL.MAJOR_PRIMARY);
  if (prim) parts.push(prim);
  for (const id of COL.MAJORS_EXTRA) {
    const t = pick(cvMap, id);
    if (t) parts.push(t);
  }
  const out = new Set();
  parts.join(',').split(',').map(s => s.trim()).filter(Boolean).forEach(s => out.add(s));
  return [...out].join(', ');
}
function computeMinGpa(cvMap) {
  const vals = [pickN(cvMap, COL.GPA_LOW), pickN(cvMap, COL.GPA_MID), pickN(cvMap, COL.GPA_HIGH)]
    .filter(v => v != null && v > 0);
  if (!vals.length) return null;
  return Math.min(...vals);
}
function computeFinalCost(cvMap) {
  const f = pickN(cvMap, COL.FINAL_COST);
  if (f != null) return f;
  const t = pickN(cvMap, COL.TUITION) ?? 0;
  const r = pickN(cvMap, COL.ROOM) ?? 0;
  const b = pickN(cvMap, COL.BOARD) ?? 0;
  const fees = pickN(cvMap, COL.FEES) ?? 0;
  const sum = t + r + b + fees;
  return sum > 0 ? sum : null;
}

function applyFilters(items, q, state, rMin, rMax, cMin, cMax, gMin, gMax) {
  return items.filter(it => {
    if (q) {
      const qq = q.toLowerCase();
      if (!(it.name?.toLowerCase().includes(qq) || it.major?.toLowerCase().includes(qq))) return false;
    }
    if (state && state !== 'all') {
      const has = it.state?.split(',').map(s => s.trim().toLowerCase());
      if (!has || !has.includes(state.toLowerCase())) return false;
    }
    if (rMin != null && it.ranking != null && it.ranking < rMin) return false;
    if (rMax != null && it.ranking != null && it.ranking > rMax) return false;
    if (cMin != null && it.final_cost != null && it.final_cost < cMin) return false;
    if (cMax != null && it.final_cost != null && it.final_cost > cMax) return false;
    if (gMin != null && it.min_gpa != null && it.min_gpa < gMin) return false;
    if (gMax != null && it.min_gpa != null && it.min_gpa > gMax) return false;
    return true;
  });
}

async function fetchMonday(token, body) {
  const resp = await fetch(MONDAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': token },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  return json;
}

exports.handler = async (event) => {
  try {
    const token = process.env.MONDAY_API_TOKEN;
    const boardId = process.env.MONDAY_BOARD_ID;
    if (!token || !boardId) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Missing env vars MONDAY_API_TOKEN / MONDAY_BOARD_ID' }) };
    }

    const params = event.queryStringParameters || {};

    // --- Utility responses ---------------------------------------------------
    if (params.debug === 'env') {
      return { statusCode: 200, body: JSON.stringify({ ok: true, boardId, hasToken: !!token, approxTokenLength: token.length }) };
    }

    // --- Dictionary: all state labels from dropdown settings -----------------
    if (params.dict === 'state') {
      const q = `
        query ($boardId:[ID!]) {
          boards (ids:$boardId) {
            columns (ids:["${COL.STATE}"]) { id title type settings_str }
          }
        }`;
      const data = await fetchMonday(token, { query: q, variables: { boardId: [boardId] } });
      if (data.errors) return { statusCode: 200, body: JSON.stringify({ errors: data.errors }) };

      const col = data?.data?.boards?.[0]?.columns?.[0];
      let labels = [];
      try {
        const s = JSON.parse(col?.settings_str || '{}');
        if (Array.isArray(s.labels)) {
          labels = s.labels.filter(Boolean);
        } else if (s.labels && typeof s.labels === 'object') {
          labels = Object.values(s.labels).filter(Boolean);
        } else if (s.labels_positions && typeof s.labels_positions === 'object') {
          labels = Object.values(s.labels_positions).map(x => x?.label || x?.title).filter(Boolean);
        }
      } catch (e) { /* ignore */ }

      labels = [...new Set(labels)].sort((a,b)=>a.localeCompare(b));
      return { statusCode: 200, body: JSON.stringify({ states: labels }) };
    }

    // --- Regular data fetch (items page) ------------------------------------
    const limit = Math.min(parseInt(params.limit || '50', 10), 200);
    const cursor = params.cursor || null;

    const q = params.q || '';
    const state = params.state || 'all';
    const rMin = params.rMin ? parseNumber(params.rMin) : null;
    const rMax = params.rMax ? parseNumber(params.rMax) : null;
    const cMin = params.cMin ? parseNumber(params.cMin) : null;
    const cMax = params.cMax ? parseNumber(params.cMax) : null;
    const gMin = params.gMin ? parseNumber(params.gMin) : null;
    const gMax = params.gMax ? parseNumber(params.gMax) : null;

    const colIDs = [
      COL.STATE, COL.RANKING, COL.FINAL_COST, COL.TUITION, COL.ROOM, COL.BOARD, COL.FEES,
      COL.MAJOR_PRIMARY, ...COL.MAJORS_EXTRA, COL.GPA_LOW, COL.GPA_MID, COL.GPA_HIGH
    ];

    const query = `
      query Fetch($boardId:[ID!], $limit:Int!, $cursor:String) {
        boards (ids:$boardId) {
          items_page (limit:$limit, cursor:$cursor) {
            cursor
            items {
              id
              name
              column_values (ids:${JSON.stringify(colIDs)}) { id text type }
            }
          }
        }
      }`;

    const data = await fetchMonday(token, { query, variables: { boardId: [boardId], limit, cursor } });
    if (data.errors) return { statusCode: 200, body: JSON.stringify({ errors: data.errors }) };

    const page = data?.data?.boards?.[0]?.items_page;
    const nextCursor = page?.cursor || null;

    const out = [];
    for (const item of page.items || []) {
      const cvMap = new Map();
      for (const cv of item.column_values || []) cvMap.set(cv.id, cv);

      out.push({
        id: item.id,
        name: item.name,
        state: pick(cvMap, COL.STATE),
        major: mergeMajors(cvMap),
        ranking: pickN(cvMap, COL.RANKING),
        final_cost: computeFinalCost(cvMap),
        min_gpa: computeMinGpa(cvMap),
      });
    }

    const filtered = applyFilters(out, q, state, rMin, rMax, cMin, cMax, gMin, gMax);

    return {
      statusCode: 200,
      body: JSON.stringify({
        items: filtered,
        cursor: nextCursor,
        meta: { received: out.length, returned: filtered.length }
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
