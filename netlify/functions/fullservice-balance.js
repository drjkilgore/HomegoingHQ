// HomegoingHQ — full-service PRINTING BALANCE checkout (dynamic, one-time).
// Charged after the family approves the proof. Env: STRIPE_SECRET_KEY, SITE_URL
exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  try {
    if (!process.env.STRIPE_SECRET_KEY) return { statusCode: 400, headers, body: JSON.stringify({ error: "Payments aren't configured yet." }) };
    const { amountCents, orderId, email, summary } = JSON.parse(event.body || "{}");
    const amt = Math.round(Number(amountCents) || 0);
    if (!amt || amt < 50) return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid balance amount." }) };

    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("line_items[0][price_data][currency]", "usd");
    params.append("line_items[0][price_data][product_data][name]", "HomegoingHQ Printing Balance");
    if (summary) params.append("line_items[0][price_data][product_data][description]", String(summary).slice(0, 300));
    params.append("line_items[0][price_data][unit_amount]", String(amt));
    params.append("line_items[0][quantity]", "1");
    params.append("success_url", (process.env.SITE_URL || "") + "/?fsbal=paid");
    params.append("cancel_url", (process.env.SITE_URL || "") + "/?fsbal=cancelled");
    if (email) params.append("customer_email", email);
    params.append("client_reference_id", orderId || "");
    params.append("metadata[kind]", "fullservice_balance");
    params.append("metadata[order_id]", orderId || "");
    params.append("metadata[summary]", String(summary || "").slice(0, 450));

    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + process.env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    const data = await resp.json();
    if (!resp.ok) return { statusCode: 502, headers, body: JSON.stringify({ error: (data.error && data.error.message) || "Stripe error" }) };
    return { statusCode: 200, headers, body: JSON.stringify({ url: data.url }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
