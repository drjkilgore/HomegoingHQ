// HomegoingHQ — Tenant branding resolver.
// Public GET: /.netlify/functions/tenant?host=grace.homegoinghq.com
// Returns display-safe white-label branding for the active account that owns
// that subdomain or custom domain. Never returns limits, usage, or owner data —
// the public_branding() RPC (migration v13) enforces that server-side.
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
    // branding rarely changes; let the edge/browser cache it briefly
    "Cache-Control": "public, max-age=300"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const host = (event.queryStringParameters && event.queryStringParameters.host || "").toLowerCase().trim();
  if (!host) return { statusCode: 200, headers, body: JSON.stringify({ found: false }) };

  const base = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return { statusCode: 200, headers, body: JSON.stringify({ found: false, error: "not_configured" }) };

  try {
    const r = await fetch(base + "/rest/v1/rpc/public_branding", {
      method: "POST",
      headers: {
        "apikey": key,
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ host })
    });
    const data = await r.json();
    if (!r.ok) return { statusCode: 200, headers, body: JSON.stringify({ found: false }) };
    return { statusCode: 200, headers, body: JSON.stringify(data || { found: false }) };
  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ found: false, error: err.message }) };
  }
};
