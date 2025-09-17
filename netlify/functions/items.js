// netlify/functions/items.js (CommonJS, Node 18+)
const MONDAY_API = "https://api.monday.com/v2";

exports.handler = async (event) => {
  try {
    const q = new URLSearchParams(event.rawQuery || "");
    const boardId = Number(q.get("boardId") || "2761790925");
    const dbgMe = q.get("debug") === "me";

    const token = process.env.MONDAY_TOKEN;
    if (!token) return respond(500, { error: "Missing MONDAY_TOKEN in environment" });

    if (dbgMe) {
      // Nur „wer bin ich?“ zeigen – hilft beim Einladen ins Board
      const meRes = await gql(token, `{ me { name email } account { id name } }`);
      return respond(200, meRes);
    }

    // Erst minimal prüfen, ob das Board für diesen Token sichtbar ist
    const probe = await gql(token, `{
      boards(ids: [${boardId}]) { id name }
    }`);
    const visible = probe?.data?.boards?.length ? true : false;
    if (!visible) {
      return respond(403, {
        error: "BOARD_NOT_VISIBLE",
        hint: "Invite the token's user to the board as viewer.",
        whoami: probe?.data?.me || undefined, // kann leer sein, wenn nicht angefragt
        details: probe?.errors || null
      });
    }

    // Vollabfrage mit Paging
    const query = `
      query Items($boardId: [Int], $cursor: String) {
        boards (ids: $boardId) {
          id
          name
          columns { id title type }
          items_page (limit: 500, cursor: $cursor) {
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
      const gErrors = res.errors;
      if (gErrors?.length) return respond(502, { error: "GraphQL errors", errors: gErrors });

      const boards = res?.data?.boards || [];
      if (!boards.length) break;

      const board = boards[0];
      if (!columns) columns = board.columns || [];

      const page = board.items_page || {};
      const items = page.items || [];
      allItems.push(
        ...items.map((it) => ({
          id: it.id,
          name: it.name,
          column_values: (it.column_values || []).reduce((acc, cv) => {
            acc[cv.id] = { text: cv.text, value: safeJson(cv.value) };
            return acc;
          }, {}),
        }))
      );

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
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { parse_error: text }; }
  // hänge zur Diagnose „me“ an
  if (!json?.data?.me) {
    try {
      const me = await fetch(MONDAY_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: token },
        body: JSON.stringify({ query: "{ me { name email } }" }),
      }).then(x => x.json());
      json.data = { ...(json.data || {}), ...(me.data || {}) };
    } catch {}
  }
  return json;
}

function respond(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify(obj),
  };
}
function safeJson(s){ try { return s ? JSON.parse(s) : null; } catch { return null; } }
