// Netlify Function: /.netlify/functions/items
// Liest Monday-Board-Items read-only. Erst versucht die Funktion "items_page",
// wenn das Schema das nicht erlaubt, fällt sie automatisch auf "items" zurück.
exports.handler = async () => {
  try {
    const BOARD_ID = process.env.MONDAY_BOARD_ID;
    const TOKEN = process.env.MONDAY_API_TOKEN;

    if (!BOARD_ID || !TOKEN) {
      return jsonResp(500, { error: "Missing MONDAY_BOARD_ID or MONDAY_API_TOKEN" });
    }

    // Helper zum Abfragen
    const callMonday = async (query, variables) => {
      const resp = await fetch("https://api.monday.com/v2", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": TOKEN
        },
        body: JSON.stringify({ query, variables })
      });
      const data = await resp.json();
      console.log("monday response:", JSON.stringify(data));
      return data;
    };

    // 1) Primär: boards -> items_page
    const q1 = `
      query ($boardId: [ID!], $limit: Int!, $page: Int!) {
        boards(ids: $boardId) {
          id
          items_page(limit: $limit, page: $page) {
            items {
              id
              name
              column_values { id text }
            }
          }
        }
      }
    `;
    const v1 = { boardId: [BOARD_ID], limit: 100, page: 1 };
    let data = await callMonday(q1, v1);

    // 2) Fallback: boards -> items (falls items_page nicht verfügbar ist)
    if (data.errors) {
      const q2 = `
        query ($boardId: [ID!], $limit: Int!) {
          boards(ids: $boardId) {
            id
            items(limit: $limit) {
              id
              name
              column_values { id text }
            }
          }
        }
      `;
      const v2 = { boardId: [BOARD_ID], limit: 100 };
      data = await callMonday(q2, v2);
    }

    // Fehler weiterhin? -> gib sie zurück, damit wir sie im Browser sehen
    if (data.errors) {
      return jsonResp(502, { errors: data.errors });
    }

    // Items extrahieren (egal ob aus items_page oder items)
    const board = data?.data?.boards?.[0];
    const items =
      board?.items_page?.items ??
      board?.items ??
      [];

    return jsonResp(200, items);
  } catch (err) {
    return jsonResp(500, { error: String(err) });
  }
};

// Kleine Hilfsfunktion für konsistente JSON-Responses & CORS
function jsonResp(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(body)
  };
}
