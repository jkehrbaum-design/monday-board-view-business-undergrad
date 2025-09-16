// Listet die Boards auf, die dein Token sehen darf (ID & Name).
exports.handler = async () => {
  try {
    const TOKEN = process.env.MONDAY_API_TOKEN;

    if (!TOKEN) {
      return send(500, { error: "Missing MONDAY_API_TOKEN" });
    }

    const query = `
      query {
        boards (limit: 50, state: active) {
          id
          name
          kind
          state
        }
      }
    `;

    const r = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": TOKEN },
      body: JSON.stringify({ query })
    });

    const data = await r.json();
    if (data.errors) return send(502, { errors: data.errors });

    // Nur eine saubere Liste zurückgeben
    const boards = (data?.data?.boards ?? []).map(b => ({
      id: b.id, name: b.name, kind: b.kind, state: b.state
    }));

    return send(200, boards);
  } catch (e) {
    return send(500, { error: String(e) });
  }
};

function send(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body)
  };
}
