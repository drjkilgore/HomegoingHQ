// LegacyHQ — Stripe webhook: upgrades profile tier after successful checkout.
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Stripe → Developers → Webhooks → endpoint: /.netlify/functions/stripe-webhook
// Event to send: checkout.session.completed
// NOTE (v1): signature verification is omitted to stay dependency-free in the
// browser-only workflow. Before real sales, add STRIPE_WEBHOOK_SECRET verification.
exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    if (body.type !== "checkout.session.completed") {
      return { statusCode: 200, body: "ignored" };
    }
    const session = body.data.object;
    const userId = session.metadata?.user_id || session.client_reference_id;
    const tier = session.metadata?.tier || "settle";
    if (!userId) return { statusCode: 200, body: "no user" };

    const resp = await fetch(process.env.SUPABASE_URL + "/rest/v1/profiles?id=eq." + userId, {
      method: "PATCH",
      headers: {
        "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
      },
      body: JSON.stringify({ plan_tier: tier, stripe_customer_id: session.customer || null })
    });
    return { statusCode: resp.ok ? 200 : 500, body: resp.ok ? "ok" : "supabase error" };
  } catch (err) {
    return { statusCode: 400, body: err.message };
  }
};
