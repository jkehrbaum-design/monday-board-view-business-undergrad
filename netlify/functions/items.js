// Netlify Function: /.netlify/functions/items
// Holt Items über boards -> items_page (ohne "page", ohne "total_count").
// ?debug=1 gibt die rohe Monday-Antwort zurück.

exports.handler = async (event) => {
  try {
    const BOARD_ID = process.env.MONDAY_BOARD_ID;
    const TOKEN = process.env.MONDAY_API_TOKEN;

    if (!BOARD_ID || !TOKEN) {
      return send(500, { error: "Missing MONDAY_BOARD_ID or MONDAY_API_TOKEN" });
    }

    const query = `
      query ($boardId: [ID!], $limit: Int!) {
        boards(ids: $boardId) {
          id
          name
          items_page(limit: $limit) {
            items {
              id
              name
              column_values { id text }
            }
          }
        }
      }
    `;

    const vars = { boardId: [BOARD_ID], limit: 100 };

    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": TOKEN
      },
      body: JSON.stringify({ query, variables: vars })
    });

    const data = await r.json();

    // Debug-Ausgabe: ?debug=1 zeigt die rohe Antwort
    if (event?.queryStringParameters?.debug === "1") {
      return send(200, data);
    }

    if (data.errors) {
      return send(502, { errors: data.errors });
    }

    const items = data?.data?.boards?.[0]?.items_page?.items ?? [];
    return send(200, items);
  } catch (e) {
    return send(500, { error: String(e) });
  }
};

function send(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(body)
  };
}
