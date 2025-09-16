// netlify/functions/items.js
// Liefert paginierte Items aus einem Monday-Board + gewünschte Spaltenfelder

const MONDAY_API = 'https://api.monday.com/v2';

export async function handler(event) {
  // --- ENV
  const TOKEN = process.env.MONDAY_API_TOKEN;
  const BOARD_ID = process.env.BOARD_ID || process.env.BOARDID || process.env.MONDAY_BOARD_ID;

  if (!TOKEN || !BOARD_ID) {
    return json({ error: 'Missing MONDAY_API_TOKEN or BOARD_ID' }, 500);
  }

  // --- Query-Parameter (Pagination)
  const qs = event.queryStringParameters || {};
  const limit = clampInt(qs.limit, 50, 1, 100);     // max 100
  const cursor = qs.cursor || null;

  // --- GraphQL
  const query = `
    query($boardIds:[ID!]!, $limit:Int!, $cursor:String) {
      boards(ids:$boardIds) {
        items_page(limit:$limit, cursor:$cursor) {
          cursor
          items {
            id
            name
            column_values {
              id
              title
              text
            }
          }
        }
      }
    }
  `;

  const variables = {
    boardIds: [String(BOARD_ID)],
    limit,
    cursor
  };

  try {
    const resp = await fetch(MONDAY_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': TOKEN
      },
      body: JSON.stringify({ query, variables })
    });

    const gql = await resp.json();

    if (gql?.errors) {
      return json({ errors: gql.errors }, 500);
    }

    const page = gql?.data?.boards?.[0]?.items_page || { items: [], cursor: null };
    const items = (page.items || []).map(toSlimItem);

    // Response-Form: items + cursor (für "Mehr laden")
    return json({
      items,
      cursor: page.cursor // null, wenn keine nächste Seite
    });

  } catch (err) {
    console.error(err);
    return json({ error: 'Fetch failed', detail: String(err) }, 500);
  }
}

/* ---------------- helpers ---------------- */

function toSlimItem(item) {
  // Spalten per Titel abholen (Titel -> Text)
  const get = (title) =>
    (item.column_values || []).find((c) => (c.title || '').trim().toLowerCase() === title.trim().toLowerCase())
      ?.text || '';

  return {
    id: item.id,
    name: item.name || '',
    state: get('State'),
    ranking: get('Ranking'),
    final_cost_of_attendance: get('Final cost of attendance'),
    major: get('Major'),
    minimum_gpa_requirement: get('Minimum GPA requirement')
  };
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function json(obj, status = 200) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(obj)
  };
}
