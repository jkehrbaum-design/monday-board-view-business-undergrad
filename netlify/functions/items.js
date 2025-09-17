// netlify/functions/items.js
// Paginiert Monday-Items und gibt gewünschte Spalten als Felder zurück.
// Fix: 'title' kommt von boards.columns, nicht von column_values.

const MONDAY_API = 'https://api.monday.com/v2';

export async function handler(event) {
  const TOKEN = process.env.MONDAY_API_TOKEN;
  const BOARD_ID =
    process.env.BOARD_ID ||
    process.env.BOARDID ||
    process.env.MONDAY_BOARD_ID;

  if (!TOKEN || !BOARD_ID) {
    return json({ error: 'Missing MONDAY_API_TOKEN or BOARD_ID' }, 500);
  }

  const qs = event.queryStringParameters || {};
  const limit = clampInt(qs.limit, 50, 1, 100);
  const cursor = qs.cursor || null;

  const query = `
    query($boardIds:[ID!]!, $limit:Int!, $cursor:String) {
      boards(ids:$boardIds) {
        id
        columns {
          id
          title
        }
        items_page(limit:$limit, cursor:$cursor) {
          cursor
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
        Authorization: TOKEN
      },
      body: JSON.stringify({ query, variables })
    });

    const gql = await resp.json();

    if (gql?.errors) {
      return json({ errors: gql.errors }, 500);
    }

    const board = gql?.data?.boards?.[0];
    const page = board?.items_page || { cursor: null, items: [] };

    // Map: columnId -> title
    const idToTitle = new Map(
      (board?.columns || []).map((c) => [c.id, c.title || ''])
    );

    const items = (page.items || []).map((it) =>
      toSlimItem(it, idToTitle)
    );

    return json({
      items,
      cursor: page.cursor
    });
  } catch (err) {
    console.error(err);
    return json({ error: 'Fetch failed', detail: String(err) }, 500);
  }
}

/* ------------ helpers ------------ */

function toSlimItem(item, idToTitle) {
  // Spaltentitel-Normalisierung (case-insensitive, nur a-z0-9)
  const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  // Gewünschte Titel (normalisiert)
  const WANT = {
    state: normalize('State'),
    ranking: normalize('Ranking'),
    final_cost_of_attendance: normalize('Final cost of attendance'),
    major: normalize('Major'),
    minimum_gpa_requirement: normalize('Minimum GPA requirement')
  };

  const values = {};
  for (const cv of item.column_values || []) {
    const title = idToTitle.get(cv.id) || '';
    const key = normalize(title);

    if (key === WANT.state) values.state = cv.text || '';
    if (key === WANT.ranking) values.ranking = cv.text || '';
    if (key === WANT.final_cost_of_attendance) values.final_cost_of_attendance = cv.text || '';
    if (key === WANT.major) values.major = cv.text || '';
    if (key === WANT.minimum_gpa_requirement) values.minimum_gpa_requirement = cv.text || '';
  }

  return {
    id: item.id,
    name: item.name || '',
    state: values.state || '',
    ranking: values.ranking || '',
    final_cost_of_attendance: values.final_cost_of_attendance || '',
    major: values.major || '',
    minimum_gpa_requirement: values.minimum_gpa_requirement || ''
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
