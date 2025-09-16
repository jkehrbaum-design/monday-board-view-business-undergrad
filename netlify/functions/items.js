// netlify/functions/items.js
import fetch from "node-fetch";

export async function handler(event, context) {
  const token = process.env.MONDAY_API_TOKEN;

  if (!token) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Missing MONDAY_API_TOKEN" }),
    };
  }

  const query = `
    query {
      boards (ids: [2761790925]) {
        id
        name
        items {
          id
          name
        }
      }
    }
  `;

  try {
    const response = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": token,   // <---- WICHTIG
      },
      body: JSON.stringify({ query }),
    });

    const data = await response.json();
    return {
      statusCode: 200,
      body: JSON.stringify(data),
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
}
