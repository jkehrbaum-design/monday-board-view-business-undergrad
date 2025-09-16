// File: netlify/functions/items.js
// Requires: node-fetch (^3). Ensure MONDAY_TOKEN is set in Netlify env.
// Endpoint: /.netlify/functions/items?boardId=2761790925

import fetch from "node-fetch";

const MONDAY_API = "https://api.monday.com/v2";

export const handler = async (event) => {
  try {
    const token = process.env.MONDAY_TOKEN;
    if (!token) {
      return json(500, { error: "Missing MONDAY_TOKEN in environment" });
    }

    const urlParams = new URLSearchParams(event.rawQuery || "");
    const boardId = urlParams.get("boardId") || "2761790925"; // default to your board
    const maxPages = Number(urlParams.get("maxPages") || 100); // safety cap

    // GraphQL query: fetch columns + items_page
    const query = `
      query Items($boardId: [Int], $cursor: String) {
        boards (ids: $boardId) {
          id
          name
          columns {
            id
            title
            type
          }
          items_page (limit: 500, cursor: $cursor) {
            cursor
            items {
              id
              name
              column_values {
                id
                text
                value
              }
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
      const body = {
        query,
        variables: { boardId: Number(boardId), cursor },
      };

      const res = await withRetry(() =>
        fetch(MONDAY_API, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: token,
          },
          body: JSON.stringify(body),
        })
      );

      if (!res.ok) {
        const txt = await res.text();
        return json(res.status, { error: "Monday API error", details: txt });
      }

      const payload = await res.json();
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
          // Map to a fast lookup by columnId => {text, value}
          column_values: (it.column_values || []).reduce((acc, cv) => {
            acc[cv.id] = { text: cv.text, value: safeJsonParse(cv.value) };
            return acc;
          }, {}),
        }))
      );

      cursor = page.cursor || null;
      pages += 1;
      if (!cursor) break;
    }

    return json(200, {
      boardId,
      columns,
      items: allItems,
      count: allItems.length,
    });
  } catch (err) {
    return json(500, { error: err.message || String(err) });
  }
};

// --- helpers -------------------------------------------------------------

const json = (status, obj) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=60", // small CDN cache
  },
  body: JSON.stringify(obj),
});

function safeJsonParse(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

async function withRetry(fn, retries = 3, backoffMs = 500) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
    }
  }
  throw lastErr;
}
