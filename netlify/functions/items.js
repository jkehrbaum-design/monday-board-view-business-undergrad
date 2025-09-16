const fetch = require("node-fetch");

exports.handler = async function(event, context) {
  try {
    const query = `
      query {
        boards (ids: 2761790925) {
          id
          name
          state
          items {
            id
            name
          }
        }
      }
    `;

    const response = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        "Authorization": process.env.MONDAY_API_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query })
    });

    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify(data)
    };
  } catch (error) {
    console.error("Error in items function:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
