// netlify/functions/items.js
// CommonJS, Node 18+ (global fetch). Env var: MONDAY_TOKEN
const MONDAY_API = "https://api.monday.com/v2";

exports.handler = async (event) => {
  try {
    const q = new URLSearchParams(event.rawQuery || "");
    const boardId = q.get("boardId") || "2761790925"; // String lassen (ID!)
    const debug = q.get("debug"); // "me" | "probe"

    const token = process.env.MONDAY_TOKEN;
    if (!token) return respond(500, { error: "Missing MONDAY_TOKEN in environment" });

    if (debug === "me") {
      return respond(200, await gql(token, `{ me { name email } account { id name } }`));
    }
    if (debug === "probe") {
      const probe = await gql(token, `
        query($ids:[ID!]) {
          me { name email }
          boards(ids:$ids) { id name state kind workspace { name } subscribers { email } }
        }`, { ids: [boardId] });
      return respond(200, probe);
    }

    const query = `
      query Items($ids:[ID!], $cursor:String) {
        boards(ids:$ids) {
          id
          name
          columns { id title type }
          items_page(limit:500, cursor:$cursor) {
            cursor
            items {
              id
              name
              column_values { id text value }
            }
          }
        }
      }
    `;

    let cursor = null, pages = 0, maxPages = 100;
    let allItems = [], columns = null;

    while (pages < maxPages) {
      const res = await gql(token, query, { ids: [boardId], cursor });
      if (res.errors?.length) return respond(502, { error: "GraphQL errors", errors: res.errors });

      const boards = res?.data?.boards || [];
      if (!boards.length) {
        return respond(403, { error: "BOARD_NOT_VISIBLE", boardId });
      }

      const board = boards[0];
      if (!columns) columns = board.columns || [];

      const page = board.items_page || {};
      const items = page.items || [];
      allItems.push(...items.map((it) => ({
        id: it.id,
        name: it.name,
        column_values: (it.column_values || []).reduce((acc, cv) => {
          acc[cv.id] = { text: cv.text, value: safeJson(cv.value) };
          return acc;
        }, {})
      })));

      cursor = page.cursor || null;
      pages++;
      if (!cursor) break;
    }

    return respond(200, { boardId, columns, items: allItems, count: allItems.length });
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
