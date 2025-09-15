// Netlify Function: /.netlify/functions/items
exports.handler = async () => {
  try {
    const BOARD_ID = process.env.MONDAY_BOARD_ID;
    const TOKEN = process.env.MONDAY_API_TOKEN;

    if (!BOARD_ID || !TOKEN) {
      return jsonResp(500, { error: "Missing MONDAY_BOARD_ID or MONDAY_API_TOKEN" });
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

    const variables = { boardId: [BOARD_ID], limit: 100 };

    const resp = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": TOKEN },
      body: JSON.stringify({ query, variables })
    });

    const json = await resp.json();
    console.log("monday response:", JSON.stringify(json));

    if (json.errors) return jsonResp(502, { errors: json.errors });

    const items = json?.data?.boards?.[0]?.items_page?.items ?? [];
    return jsonResp(200, items);
  } catch (err) {
    return jsonResp(500, { error: String(err) });
  }
};

function jsonResp(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body)
  };
}
