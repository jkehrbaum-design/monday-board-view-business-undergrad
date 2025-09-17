// netlify/functions/items.js
// CommonJS, Node 18+ (global fetch). Env var: MONDAY_TOKEN
// Progressive Loader: pageLimit Seiten pro Call (Default 1). Rückgabe enthält cursor, falls weitere Seiten existieren.

const MONDAY_API = "https://api.monday.com/v2";

exports.handler = async (event) => {
  try {
    const q = new URLSearchParams(event.rawQuery || "");
    const boardId = q.get("boardId") || "2761790925";  // Monday erwartet [ID!], also String-IDs
    const cursorIn = q.get("cursor") || null;
    const pageLimit = clampInt(q.get("pageLimit"), 1, 3, 1); // 1..3 Seiten pro Aufruf (Default 1)
    const TIME_BUDGET_MS = 8000; // < 10s (Netlify Starter Timeout)
    const debug = q.get("debug"); // "me" | "probe" | null

    const token = process.env.MONDAY_TOKEN;
    if (!token) return respond(500, { error: "Missing MONDAY_TOKEN in environment" });

    // ---- Debug: who am I?
    if (debug === "me") {
      return respond(200, await gql(token, `{ me { name email } account { id name } }`));
    }

    // ---- Debug: sehe ich das Board?
    if (debug === "probe") {
      const probe = await gql(token, `
        query($ids:[ID!]) {
          me { name email }
          boards(ids:$ids) { id name state kind workspace { name } subscribers { email } }
        }`, { ids: [boardId] });
      return respond(200, probe);
    }

    // ---- Normale Items-Abfrage (progressiv, mit Zeitbudget)
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

    let cursor = cursorIn;
    let pages = 0;
    let items = [];
    let columns = null;
    const t0 = Date.now();

    while (pages < pageLimit) {
      if (Date.now() - t0 > TIME_BUDGET_MS) break; // Timeout-Schutz

      const res = await gql(token, query, { ids: [boardId], cursor });
      if (res.errors?.length) return respond(502, { error: "GraphQL errors", errors: res.errors });

      const boards = res?.data?.boards || [];
      if (!boards.length) {
        // Board (noch) nicht sichtbar oder alter Build?
        const me = await gql(token, `{ me { name email } }`);
        return respond(403, { error: "BOARD_NOT_VISIBLE", boardId, me: me?.data?.me || null });
      }

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

      cursor = page.cursor || null; // null => keine weiteren Seiten
      pages += 1;
      if (!cursor) break;
    }

    return respond(200, {
      boardId,
      columns,
      items,
      count: items.length,
      cursor,        // für den nächsten Call (oder null, wenn fertig)
      more: !!cursor
    });

  } catch (err) {
    return respond(500, { error: String(err) });
  }
};

// ---------- Helpers ----------
async function gql(token, query, variables) {
  const r = await fetch(MONDAY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token }, // wichtig: kein "Bearer "
    body: JSON.stringify({ query, variables }),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { parse_error: text }; }
}

function respond(status, obj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify(obj),
  };
}

function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return fallback;
}
