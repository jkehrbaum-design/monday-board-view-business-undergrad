// Netlify Function: /.netlify/functions/items
// Holt Items aus einem Monday-Board über boards -> items_page (ohne "page", ohne "total_count").
// Debug-Modus: /items?debug=1 gibt die rohe Monday-Antwort zurück.

exports.handler = async (event) => {
  try {
    const BOARD_ID = process.env.MONDAY_BOARD_ID;
    const TOKEN = process.env.MONDAY_API_TOKEN;

    if (!BOARD_ID || !TOKEN) {
      return json(500, { error: "Missing MONDAY_BOARD_ID or MONDAY_API_TOKEN" });
    }

    // Minimal-kompatible Query für dein Schema
    const query = `
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

    const body = JSON.stringify({
      query,
      variables: { boardId:
