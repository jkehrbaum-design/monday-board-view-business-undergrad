// File: netlify/functions/items.js
// Netlify Node 18+ hat global fetch. Keine Zusatz-Dependency nötig.
// Erfordert in Netlify: Umgebungsvariable MONDAY_TOKEN.

const MONDAY_API = "https://api.monday.com/v2";

export const handler = async (event) => {
  try {
    const token = process.env.MONDAY_TOKEN;
    if (!token) {
      return respond(500, { error: "Missing MONDAY_TOKEN in environment" });
    }

    const q = new URLSearchParams(event.rawQuery || "");
    const boardId = Number(q.get("boardId") || "2761790925");
    const maxPages = Number(q.get("maxPages") || 100);

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

    let cursor = null;
    let allItems = [];
    let columns = null;
    let pages = 0;

    while (pages < maxPages) {
      const res = await fetch(MONDAY_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Monday erwartet KEIN "Bearer ", sondern direkt den Token
          Authorization: token,
        },
        body: JSON.stringify({ query, variables: { boardId, cursor } }),
      });

      const text = await res.text();
      if (!res.ok) {
        return respond(res.status, { error: "Monday API error", details: text });
      }
      const payload = safeJson(text);
      const boards = payload?.data?.boards || [];
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
      pages += 1;
      if (!cursor) break;
    }

    return respond(200, {
      boardId: String(boardId),
      columns,
      items: allItems,
      count: allItems.length,
    });
  } catch (err) {
    return respond(500, { error: String(err) });
  }
};

// Helpers
function respond(status, obj) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
    },
    body: JSON.stringify(obj),
  };
}
function safeJson(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}
