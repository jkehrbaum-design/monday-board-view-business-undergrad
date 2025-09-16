// Diagnose-Aufruf: prüft, ob das Board sichtbar ist und wie viele Items es hat
exports.handler = async () => {
  try {
    const BOARD_ID = process.env.MONDAY_BOARD_ID;
    const TOKEN = process.env.MONDAY_API_TOKEN;

    // Sicherheitscheck
    if (!BOARD_ID || !TOKEN) {
      return resp(500, { error: "Missing MONDAY_BOARD_ID or MONDAY_API_TOKEN" });
    }

    const query = `
      query ($boardId: [ID!]) {
        boards(ids: $boardId) {
          id
          name
          state
          items_page(limit: 1) {
            total_count
          }
        }
      }
    `;

    // ⬅️ Kein "variables" Identifier mehr – direkt inline übergeben
    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": TOKEN },
      body: JSON.stringify({ query, variables: { boardId: [BOARD_ID] } })
    });

    const json = await r.json();
    return resp(200, json);
  } catch (e) {
    return resp(500, { error: String(e) });
  }
};

// Hilfsfunktion für konsistente JSON-Responses
function resp(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body, null, 2)
  };
}
