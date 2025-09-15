// Netlify Function: /.netlify/functions/items
// Holt Items über boards -> groups -> items (kompatibel, wenn "items" am Board nicht verfügbar ist)
exports.handler = async () => {
  try {
    const BOARD_ID = process.env.MONDAY_BOARD_ID;
    const TOKEN = process.env.MONDAY_API_TOKEN;

    if (!BOARD_ID || !TOKEN) {
      return jsonResp(500, { error: "Missing MONDAY_BOARD_ID or MONDAY_API_TOKEN" });
    }

    const query = `
      query ($boardId: [ID!]) {
        boards(ids: $boardId) {
          id
          name
          groups {
            id
            title
            items {
              id
              name
              column_values { id text }
            }
          }
        }
      }
    `;

    const variables = { boardId: [BOARD_ID] };

    const resp = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": TOKEN
      },
      body: JSON.stringify({ query, variables })
    });

    const json = await resp.json();
    console.log("monday response:", JSON.stringify(json));

    if (json.errors) {
      return jsonResp(502, { errors: json.errors });
    }

    // Alle Items aus allen Gruppen zu einer Liste zusammenführen
    const groups = json?.data?.boards?.[0]?.groups ?? [];
    const items = groups.flatMap(g => g.items || []);

    return jsonResp(200, items);
  } catch (err) {
    return jsonResp(500, { error: String(err) });
  }
};

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
