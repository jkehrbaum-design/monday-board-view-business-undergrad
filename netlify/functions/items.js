// netlify/functions/items.js
// Liest Monday-Items inkl. aller Spalten und gibt Cursor + Filter-Felder zurück

export const handler = async (event) => {
  const TOKEN   = process.env.MONDAY_API_TOKEN;
  const BOARD_ID = process.env.MONDAY_BOARD_ID || '2761790925';

  if (event.queryStringParameters?.debug === 'env') {
    return json({ hasToken: !!TOKEN, boardId: BOARD_ID });
  }
  if (!TOKEN) return json({ error: 'No MONDAY_API_TOKEN set' }, 500);

  const p = event.queryStringParameters || {};

  const limit   = clampInt(p.limit, 50, 1, 200);
  const cursor  = p.cursor || null;

  // Filterparameter aus dem Frontend
  const q       = (p.q || '').trim().toLowerCase();
  const stateF  = (p.state || '').trim();         // Label der State-Spalte
  const rMin    = toNum(p.rankMin, -Infinity);
  const rMax    = toNum(p.rankMax, +Infinity);
  const cMin    = toNum(p.costMin, -Infinity);
  const cMax    = toNum(p.costMax, +Infinity);
  const gMin    = toNum(p.gpaMin, -Infinity);
  const gMax    = toNum(p.gpaMax, +Infinity);

  // GraphQL Query: Items + alle Spalten
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
  const data = await gql(query, variables, TOKEN);
  const page = data?.boards?.[0]?.items_page || {};
  const items = Array.isArray(page.items) ? page.items : [];

  // Hilfsfunktionen für Filter
  const gv = (cols, id) => (cols.find(c => c.id === id)?.text || '').trim();
  const gvNum = (cols, id) => numFromText(gv(cols, id));

  // Wir mappen pro Item einige Convenience-Felder,
  // den kompletten Spalten-Block reichen wir 1:1 weiter (cols)
  const prepped = items.map(it => {
    const cols = it.column_values || [];

    // Wichtige IDs (aus deiner Spaltenliste):
    const stateText   = gv(cols, 'dropdown');         // State
    const rankingNum  = gvNum(cols, 'numbers0');      // Ranking (Webometrics)
    const totalCost   = gvNum(cols, 'formula27');     // TOTAL Approx Annual Cost
    const minGpa      = gvNum(cols, 'numbers4');      // GPA Minimum (Lowest Scholarship)
    const majorsText  = gv(cols, 'dropdown6');        // Bachelor’s Study Areas (Dropdown)

    return {
      id: it.id,
      name: it.name,
      state: stateText,
      ranking: isNaN(rankingNum) ? null : rankingNum,
      totalCost: isNaN(totalCost) ? null : totalCost,
      minGpa: isNaN(minGpa) ? null : minGpa,
      majors: majorsText.toLowerCase(),
      cols // alle Spalten roh weitergeben
    };
  });

  // Filter anwenden (im Backend, damit Paginierung sinnvoll bleibt)
  const filtered = prepped.filter(row => {
    if (q) {
      const hay = (row.name + ' ' + row.majors).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (stateF && stateF !== 'all') {
      if ((row.state || '').toLowerCase() !== stateF.toLowerCase()) return false;
    }
    if (!between(row.ranking, rMin, rMax)) return false;
    if (!between(row.totalCost, cMin, cMax)) return false;
    if (!between(row.minGpa, gMin, gMax)) return false;
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
    headers: {
      'Content-Type':'application/json',
      'Authorization': token
    },
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
