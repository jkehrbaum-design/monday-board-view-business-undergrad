// /.netlify/functions/items
// Debug-Modi:
//   ?debug=env     -> zeigt, ob Token & Board-ID ankommen
//   ?debug=boards  -> listet Boards (id, name), die dein Token sieht
//   ?debug=1       -> rohe Monday-Antwort für die Items-Query

exports.handler = async (event) => {
  try {
    const TOKEN = process.env.MONDAY_API_TOKEN;
    const BOARD_ID = process.env.MONDAY_BOARD_ID || "2761790925";
    const qs = event?.queryStringParameters || {};

    // Debug: ENV prüfen
    if (qs.debug === "env") {
      const info = {
        hasToken: Boolean(TOKEN),
        approxTokenLength: TOKEN ? TOKEN.length : 0,
        boardId: BOARD_ID,
      };
      console.log("[items] env check:", info);
      return json(200, info);
    }

    if (!TOKEN) {
      return json(500, { error: "MONDAY_API_TOKEN missing in environment variables" });
    }

    // Debug: Boards auflisten
    if (qs.debug === "boards") {
      const listQuery = `
        query {
          boards(limit: 50, state: active) {
            id
            name
            state
          }
        }
      `;
      const listData = await mondayPost(TOKEN, { query: listQuery });
      if (listData.errors) return json(502, { errors: listData.errors });

      const boards = (listData?.data?.boards ?? []).map(b => ({
        id: b.id,
        name: b.name,
        state: b.state,
      }));
      console.log("[items] boards:", boards);
      return json(200, boards);
    }

    // Items vom Board holen (items_page ohne total_count/page)
    const itemsQuery = `
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
    const data = await mondayPost(TOKEN, { query: itemsQuery, variables });

    if (qs.debug === "1") {
      // rohe Monday-Antwort zur Diagnose
      return json(200, data);
    }

    if (data.errors) {
      console.log("[items] monday errors:", data.errors);
      return json(502, { errors: data.errors });
    }

    const items = data?.data?.boards?.[0]?.items_page?.items?.map(it => ({
      id: it.id,
      name: it.name,
      text: (it.column_values || [])
        .map(cv => cv?.text)
        .filter(Boolean)
        .join(" | "),
    })) ?? [];

    return json(200, items);
  } catch (e) {
    console.error("[items] fatal:", e);
    return json(500, { error: String(e) });
  }
};

// ---- Helpers ----
async function mondayPost(token, bodyObj) {
  // Node 18+ in Netlify hat global fetch – kein node-fetch nötig
  const resp = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": token,
    },
    body: JSON.stringify(bodyObj),
  });
  return resp.json();
}

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}
