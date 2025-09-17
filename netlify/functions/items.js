// netlify/functions/items.js
// CommonJS, Node 18+ (global fetch). Nutzt MONDAY_TOKEN aus Netlify Env.
// Zusätzliche Debug-Modes: ?debug=me | ?debug=probe&boardId=...

const MONDAY_API = "https://api.monday.com/v2";

exports.handler = async (event) => {
  try {
    const q = new URLSearchParams(event.rawQuery || "");
    const boardId = Number(q.get("boardId") || "2761790925");
    const debug = q.get("debug"); // "me" | "probe" | null

    const token = process.env.MONDAY_TOKEN;
    if (!token) return respond(500, { error: "Missing MONDAY_TOKEN in environment" });

    if (debug === "me") {
      const me = await gql(token, `{ me { name email } account { id name } }`);
      return respond(200, me);
    }

    if (debug === "probe") {
      // Sichtbarkeit & Basisdaten prüfen, ohne Items zu ziehen
      const probe = await gql(token, `query($id: [Int]) {
        me { name email }
        boards(ids: $id) { id name state kind workspace { name } subscribers { email } }
      }`, { id: [boardId] });
      return respond(200, probe);
    }

    // Volle Abfrage mit Paging
    const query = `
      query Items($boardId: [Int], $cursor: String) {
        boards(ids: $boardId) {
          id
          name
          columns { id title type }
          items_page(limit: 500, cursor: $cursor) {
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

    let cursor = null, allItems = [], columns = null, pages = 0, maxPages = 100;
    while (pages < maxPages) {
      const res = await gql(token, query, { boardId, cursor });

      if (res.errors?.length) {
        return respond(502, { error: "GraphQL errors", errors: res.errors });
      }

      const boards = res?.data?.boards || [];
      if (!boards.length) {
        // Klare Meldung, falls 0 Boards zurückkommt
        const who = await gql(token, `{ me { name email } }`);
        return respond(403, {
          error: "BOARD_NOT_VISIBLE_OR_OLD_BUILD",
          hint: "Board nicht sichtbar ODER alte Function-Version im Cache. Bitte redeployen.",
          me: who?.data?.me || null,
          boardId: String(boardId)
        });
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

    return respond(200, { boardId: String(boardId), columns, items: allItems, count: allItems.length });

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
