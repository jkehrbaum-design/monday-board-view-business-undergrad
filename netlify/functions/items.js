// netlify/functions/items.js
// Liest Items aus deinem monday-Board und gibt für die UI die Felder
// name, state, major, ranking, final_cost, min_gpa + Pagination zurück.

const MONDAY_URL = 'https://api.monday.com/v2';

const COL = {
  STATE: 'dropdown',
  RANKING: 'numbers0',
  FINAL_COST: 'formula27',
  TUITION: 'numbers72',
  ROOM: 'numbers_11',
  BOARD: 'numbers_24',
  FEES: 'numbers_3',
  // Primary "Study Areas":
  MAJOR_PRIMARY: 'dropdown6',
  // zusätzliche Major-Gruppen:
  MAJORS_EXTRA: [
    'dropdown71',                // Architecture (B)
    'dup__of_architecture__b_',  // Arts (B)
    'dup__of_arts__b_',          // Business (B)
    'dup__of_business__b_',      // Engineering (B)
    'dup__of_engineering__b_',   // Humanities (B)
    'dup__of_humanities__b_',    // Computer Science (B) (in deinem Board so benannt)
    'dropdown9',                  // Natural Sciences (B)
    'dup__of_dropdown8',         // Social Sciences (B)
    'dup__of_dropdown',          // Education (B)
    'dup__of_dup__of_dropdown'   // Law (B)
  ],
  GPA_LOW: 'numbers4',
  GPA_MID: 'numbers_23',
  GPA_HIGH: 'numbers43',
};

function nfCurrency(n) {
  if (n == null || isNaN(n)) return '';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function nfNumber(n) {
  if (n == null || isNaN(n)) return '';
  return new Intl.NumberFormat('en-US').format(n);
}

function parseNumber(text) {
  if (!text) return null;
  // monday gibt Zahlen oft als String "12,345" zurück -> raus mit Kommas:
  const cleaned = String(text).replace(/[,$\s]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function pick(cvMap, id) {
  return cvMap.get(id)?.text ?? '';
}

function pickN(cvMap, id) {
  return parseNumber(cvMap.get(id)?.text);
}

function mergeMajors(cvMap) {
  const parts = [];
  const prim = pick(cvMap, COL.MAJOR_PRIMARY);
  if (prim) parts.push(prim);

  for (const id of COL.MAJORS_EXTRA) {
    const t = pick(cvMap, id);
    if (t) parts.push(t);
  }

  // Labels kommen bereits als "A, B" text – zusammenführen & deduplizieren:
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
  // 1) Formelspalte, wenn vorhanden
  const f = pickN(cvMap, COL.FINAL_COST);
  if (f != null) return f;
  // 2) Fallback Summe
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
      // State kann mehrere Labels enthalten "California, West" -> enthält?
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

exports.handler = async (event) => {
  try {
    const token = process.env.MONDAY_API_TOKEN;
    const boardId = process.env.MONDAY_BOARD_ID;
    if (!token || !boardId) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Missing env vars MONDAY_API_TOKEN / MONDAY_BOARD_ID' }) };
    }

    // --- QueryParams --------------------------------------------------------
    const params = event.queryStringParameters || {};
    const limit = Math.min(parseInt(params.limit || '50', 10), 200);
    const cursor = params.cursor || null;

    // Filter-Parameter
    const q = params.q || '';
    const state = params.state || 'all';
    const rMin = params.rMin ? parseNumber(params.rMin) : null;
    const rMax = params.rMax ? parseNumber(params.rMax) : null;
    const cMin = params.cMin ? parseNumber(params.cMin) : null;
    const cMax = params.cMax ? parseNumber(params.cMax) : null;
    const gMin = params.gMin ? parseNumber(params.gMin) : null;
    const gMax = params.gMax ? parseNumber(params.gMax) : null;

    // Debug-Hilfen
    if (params.debug === 'env') {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, boardId, hasToken: !!token, approxTokenLength: token.length })
      };
    }

    // --- GraphQL ------------------------------------------------------------
    const colIDs = [
      COL.STATE, COL.RANKING, COL.FINAL_COST, COL.TUITION, COL.ROOM, COL.BOARD, COL.FEES,
      COL.MAJOR_PRIMARY, ...COL.MAJORS_EXTRA, COL.GPA_LOW, COL.GPA_MID, COL.GPA_HIGH
    ];

    const query = `
      query Fetch($boardId: [ID!], $limit: Int!, $cursor: String) {
        boards (ids: $boardId) {
          items_page (limit: $limit, cursor: $cursor) {
            cursor
            items {
              id
              name
              column_values (ids: ${JSON.stringify(colIDs)}) {
                id
                text
                type
              }
            }
          }
        }
      }`;

    const body = JSON.stringify({
      query,
      variables: { boardId: [boardId], limit, cursor }
    });

    const resp = await fetch(MONDAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token
      },
      body
    });

    const data = await resp.json();
    if (data.errors) {
      return { statusCode: 200, body: JSON.stringify({ errors: data.errors }) };
    }

    const page = data?.data?.boards?.[0]?.items_page;
    const nextCursor = page?.cursor || null;

    const out = [];
    for (const item of page.items || []) {
      const cvMap = new Map();
      for (const cv of item.column_values || []) cvMap.set(cv.id, cv);

      const state = pick(cvMap, COL.STATE);
      const ranking = pickN(cvMap, COL.RANKING);
      const major = mergeMajors(cvMap);
      const min_gpa = computeMinGpa(cvMap);
      const final_cost = computeFinalCost(cvMap);

      out.push({
        id: item.id,
        name: item.name,
        state,
        major,
        ranking,
        final_cost,
        min_gpa
      });
    }

    // Filter clientseitig anwenden:
    const filtered = applyFilters(out, q, state, rMin, rMax, cMin, cMax, gMin, gMax);

    return {
      statusCode: 200,
      body: JSON.stringify({
        items: filtered,
        cursor: nextCursor,
        meta: {
          received: out.length,
          returned: filtered.length,
        }
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
