// Diagnose: prüfe, ob dein Token das Board sieht und ob Items existieren
exports.handler = async () => {
  try {
    const BOARD_ID = process.env.MONDAY_BOARD_ID;
    const TOKEN = process.env.MONDAY_API_TOKEN;

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

    // WICHTIG: anderer Variablenname, damit nichts doppelt deklariert ist
    const vars = { boardId: [BOARD_ID] };

    const resp = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": TOKEN },
      body: JSON.stringify({ query, variables: vars })
    });

    const json = await resp.json();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(json, null, 2)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: String(err) })
    };
  }
};
