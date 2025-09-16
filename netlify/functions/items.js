// netlify/functions/items.js
// Holt kompakte Item-Daten aus einem Monday-Board

export default async function handler(req, res) {
  // CORS für deinen Frontend-Aufruf
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  // Health-/Debug-Checks wie gehabt
  const q = (req.query && (req.query.debug || req.query.q)) || "";
  if (q === "env") {
    return res.status(200).end(
      JSON.stringify({
        hasToken: !!process.env.MONDAY_API_TOKEN,
        approxTokenLength: process.env.MONDAY_API_TOKEN?.length || 0,
        boardId: process.env.MONDAY_BOARD_ID || "env:MONDAY_BOARD_ID fehlt",
      })
    );
  }

  try {
    const TOKEN = process.env.MONDAY_API_TOKEN;
    const BOARD_ID = process.env.MONDAY_BOARD_ID; // z.B. 2761790925

    if (!TOKEN || !BOARD_ID) {
      return res
        .status(500)
        .end(JSON.stringify({ error: "TOKEN oder BOARD_ID fehlt" }));
    }

    // nur die nötigsten Felder holen (Name + Text-Spalten)
    const query = `
      query($boardId: [ID!]!) {
        boards (ids: $boardId) {
          id
          name
          items_page (limit: 100) {
            items {
              id
              name
              column_values {
                id
                text
              }
            }
          }
        }
      }
    `;

    const variables = { boardId: [BOARD_ID] };

    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });

    const json = await r.json();

    // Debug-Ausgaben erreichbar über …/items?debug=1 bzw. …?debug=boards
    if (q === "1" || q === "raw" || q === "boards") {
      return res.status(200).end(JSON.stringify(json));
    }

    // Board gefunden?
    const board = json?.data?.boards?.[0];
    if (!board) {
      return res.status(200).end(JSON.stringify([]));
    }

    // kompakt mappen: {id, name, preview}
    const items = (board.items_page?.items || []).map((it) => {
      const allText =
        (it.column_values || [])
          .map((c) => (c?.text || "").trim())
          .filter(Boolean)
          .join(" • ") || "";
      const preview = allText.length > 240 ? allText.slice(0, 240) + "…" : allText;
      return { id: it.id, name: it.name, preview };
    });

    return res.status(200).end(JSON.stringify(items));
  } catch (err) {
    return res
      .status(500)
      .end(JSON.stringify({ error: "Serverfehler", detail: String(err) }));
  }
}
