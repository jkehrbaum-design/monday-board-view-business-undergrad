// netlify/functions/items.js
// CommonJS, Node 18+. Env: MONDAY_TOKEN
const MONDAY_API = "https://api.monday.com/v2";

exports.handler = async (event) => {
  try {
    const q = new URLSearchParams(event.rawQuery || "");
    const boardId = q.get("boardId") || "2761790925"; // ID als String lassen ([ID!])
    const cursorIn = q.get("cursor") || null;
    const pageLimit = Math.max(1, Math.min(parseInt(q.get("pageLimit") || "1", 10), 5)); // wie viele Seiten pro Call
    const hardCapPages = Math.max(1, Math.min(parseInt(q.get("maxPages") || "100", 10), 100));
    const TIME_BUDGET_MS = 8000; // < 10s Netlify-Timeout
    const started = Date.now();

    const token = process.env.MONDAY_TOKEN;
    if (!token) return respond(500, { error: "Missing MONDAY_TOKEN in environment" });

    // GraphQL
    const query = `
      query Items($ids:[ID!], $cursor:String) {
        boards(ids:$ids) {
          id
          name
          columns { id title type }
          items_page(limit:500, cursor:$cursor) {
            cursor
            items { id name column_values { id text value } }
          }
        }
      }
    `;

    let cursor = cursorIn;
    let pages = 0;
    let items = [];
    let columns = null;

    while (pages < pageLimit && pages < hardCapPages) {
      if (Date.now() - started > TIME_BUDGET_MS) break; // Zeitbudget

      const res = await gql(token, query, { ids: [boardId], cursor });
      if (res.errors?.length) return respond(502, { error: "GraphQL errors", errors: res.errors });

      const boards = res?.data?.boards || [];
      if (!boards.length) return respond(403, { error: "BOARD_NOT_VISIBLE", boardId });

      const board = boards[0];
      if (!columns) columns = board.columns || [];

      const page = board.items_page || {};
      const batch = page.items || [];
      items.push(...batch.map((it) => ({
        id: it.id,
        name: it.name,
        column_values: (it.column_values || []).reduce((acc, cv) => {
          acc[cv.id] = { text: cv.text, value: safeJson(cv.value) };
          return acc;
        }, {})
      })));

      cursor = page.cursor || null;
      pages += 1;
      if (!cursor) break; // fertig
    }

    return respond(200, {
      boardId,
      columns,
      items,
      count: items.length,
      cursor,          // <-- wenn nicht null: es gibt weitere Seiten
      more: !!cursor   // bequem für das Frontend
    });
  } catch (err) {
    return respond(500, { error: String(err) });
  }
};

async function gql(token, query, variables) {
  const r = await fetch(MONDAY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ query, variables }),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { parse_error: text }; }
}
function respond(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" }, body: JSON.stringify(obj) };
}
function safeJson(s){ try { return s ? JSON.parse(s) : null; } catch { return null; } }
