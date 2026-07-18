// HomegoingHQ — Stripe billing portal session (manage / cancel Vault Keeper)
// Env vars: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SITE_URL
// Enable the portal once in Stripe → Settings → Billing → Customer portal.
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    const { userId } = JSON.parse(event.body || "{}");
    if (!userId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing user" }) };

    const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SB || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "Server not configured" }) };

    // Look up the customer's Stripe id from their profile (service role — bypasses RLS).
    const r = await fetch(SB + "/rest/v1/profiles?id=eq." + encodeURIComponent(userId) + "&select=stripe_customer_id", {
      headers: { "apikey": KEY, "Authorization": "Bearer " + KEY }
    });
    const rows = await r.json();
    const customer = Array.isArray(rows) && rows[0] && rows[0].stripe_customer_id;
    if (!customer) return { statusCode: 400, headers, body: JSON.stringify({ error: "No billing account on file yet." }) };

    const params = new URLSearchParams();
    params.append("customer", customer);
    params.append("return_url", (process.env.SITE_URL || "") + "/");

    const resp = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.STRIPE_SECRET_KEY,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });
    const data = await resp.json();
    if (!resp.ok) return { statusCode: 502, headers, body: JSON.stringify({ error: data.error?.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ url: data.url }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
