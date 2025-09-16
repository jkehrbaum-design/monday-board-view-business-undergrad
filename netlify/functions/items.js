// Reset: einfacher Funktionstest, sollte {"ok":true} liefern
exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ ok: true })
  };
};
