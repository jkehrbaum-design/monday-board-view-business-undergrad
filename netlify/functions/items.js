// netlify/functions/items.js
// Lädt Items von einem Board aus monday.com und gibt nur die
// gewünschten Felder zurück (name, state, ranking, final_cost_of_attendance, major, minimum_gpa_requirement).
// Pagination: ?limit=50&cursor=<opaque cursor>

const BOARD_ID = process.env.MONDAY_BOARD_ID || '2761790925';
const TOKEN    = process.env.MONDAY_API_TOKEN;

export const handler = async (event) => {
  // --- KO-Checks und Debug-Modi ---
  if (!TOKEN) {
    return json({ errors: [{ message: 'No monday token (MONDAY_API_TOKEN)' }] }, 500);
  }
  if (!BOARD_ID) {
    return json({ errors: [{ message: 'No board id (MONDAY_BOARD_ID)' }] }, 500);
  }

  const url      = new URL(event?.rawUrl ?? 'http://x');
  const debug    = url.searchParams.get('debug');
  const limit    = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '50', 10)));
  const cursorIn = url.searchParams.get('cursor');

  // Debug-Ausgaben (helfen dir im Browser)
  if (debug === 'env') {
    return json({ hasToken: !!TOKEN, approxTokenLength: TOKEN.length, boardId: BOARD_ID });
  }

  // --- GraphQL-Query ---
  // Wir ziehen NUR die Spaltenwerte, die wir brauchen (per .text).
  const query = `
    query ($boardId: [ID!], $limit: Int, $cursor: String) {
      boards (ids: $boardId) {
        items_page (limit: $limit, cursor: $cursor) {
          cursor
          items {
            id
            name
            column_values (ids: [
              "state",
              "ranking",
              "final_cost_of_attendance",
              "major",
              "minimum_gpa_requirement"
            ]) {
              id
              text
            }
          }
        }
      }
    }
  `;

  const variables = { boardId: BOARD_ID, limit, cursor: cursorIn || null };

  try {
    const resp = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': TOKEN
      },
      body: JSON.stringify({ query, variables })
    });

    const data = await resp.json();

    // Debug: Alle Boards zeigen
    if (debug === 'boards') return json(data);

    // Fehler durchreichen
    if (data.errors) return json({ errors: data.errors }, 500);

    // Normalisieren
    const page = data?.data?.boards?.[0]?.items_page;
    const items = (page?.items || []).map(mapItem);
    const cursorOut = page?.cursor || null;

    // Optional: voller Dump für Debug
    if (debug === '1') return json({ data: items, cursor: cursorOut });

    // „schlankes“ Format für das Frontend
    return json({ items, cursor: cursorOut });
  } catch (err) {
    return json({ errors: [{ message: err.message || 'fetch error' }] }, 500);
  }
};

// ---- Helpers ----
function mapItem(raw) {
  const cv = Object.fromEntries((raw.column_values || []).map(c => [c.id, (c.text ?? '').trim()]));
  return {
    id: raw.id,
    name: raw.name || '',
    state: cv.state || '',
    ranking: cv.ranking || '',
    final_cost_of_attendance: cv.final_cost_of_attendance || '',
    major: cv.major || '',
    minimum_gpa_requirement: cv.minimum_gpa_requirement || ''
  };
}

function json(payload, status = 200) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*' // rein für Tests; bei Bedarf einschränken
    },
    body: JSON.stringify(payload)
  };
}
