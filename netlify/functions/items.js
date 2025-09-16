// Diagnose: zeigt, ob das Board sichtbar ist und wie viele Items es hat
exports.handler = async () => {
  try {
    const BOARD_ID = process.env.MONDAY_BOARD_ID;
    const TOKEN = process.env.MONDAY_API_TOKEN;

    if (!BOARD_ID || !TOKEN) {
      return send(500, { error: "Missing MONDAY_BOARD_ID or MONDAY_API_TOKEN" });
    }

    const query = `
      query ($boardId: [ID!]) {
        boards(ids: $boardId) {
          id
          name
          state
          items_page(limit: 1) { total_count }
        }
      }
    `;

    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": TOKEN },
      body: JSON.stringify({ query, variables: { boardId: [BOARD_ID] } })
    });

    const json = await r.json();
    return send(200, json);
  } catch (e) {
    return send(500, { error: String(e) });
  }
};

function send(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body, null, 2)
  };
}
