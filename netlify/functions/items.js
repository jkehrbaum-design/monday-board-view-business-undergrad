// Netlify Function: /.netlify/functions/items
exports.handler = async function () {
  try {
    const BOARD_ID = process.env.MONDAY_BOARD_ID;
    const TOKEN = process.env.MONDAY_API_TOKEN;

    if (!BOARD_ID || !TOKEN) {
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing MONDAY_BOARD_ID or MONDAY_API_TOKEN' })
      };
    }

// ↓ Query ersetzen
const query = `
  query ($boardId: [ID!], $limit: Int!) {
    boards (ids: $boardId) {
      items_page (limit: $limit, page: 1) {
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

// ↓ Variablen ersetzen
const variables = { boardId: [String(BOARD_ID)], limit: 100 };

// ↓ Mapping der Antwort ersetzen (weiter unten)
const items = json?.data?.boards?.[0]?.items_page?.items ?? [];

      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': TOKEN
      },
      body: JSON.stringify({ query, variables })
    });

    const json = await resp.json();
    console.log('monday response:', JSON.stringify(json));

    const items = json?.data?.boards?.[0]?.items ?? [];
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify(items)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(err) })
    };
  }
};
