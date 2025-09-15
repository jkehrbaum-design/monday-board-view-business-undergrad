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

    const query = `
      query ($boardId: [Int]) {
        boards (ids: $boardId) {
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
    `;
    const variables = { boardId: Number(BOARD_ID) };

    const resp = await fetch('https://api.monday.com/v2', {
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
