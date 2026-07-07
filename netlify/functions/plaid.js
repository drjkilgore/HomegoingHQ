// HomegoingHQ — Plaid account discovery (one-time fetch; token discarded after use)
// Env vars: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox|production)
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  const host = "https://" + (process.env.PLAID_ENV || "sandbox") + ".plaid.com";
  const creds = { client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET };
  if (!creds.client_id || !creds.secret)
    return { statusCode: 200, headers, body: JSON.stringify({ error: "Plaid isn't configured yet." }) };
  const call = async (path, body) => {
    const r = await fetch(host + path, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...creds, ...body }) });
    return r.json();
  };
  try {
    const { action, userId, public_token } = JSON.parse(event.body || "{}");

    if (action === "link_token") {
      const d = await call("/link/token/create", {
        client_name: "HomegoingHQ",
        user: { client_user_id: userId || "anon" },
        products: ["auth"], country_codes: ["US"], language: "en"
      });
      if (d.error_message) return { statusCode: 502, headers, body: JSON.stringify({ error: d.error_message }) };
      return { statusCode: 200, headers, body: JSON.stringify({ link_token: d.link_token }) };
    }

    if (action === "discover") {
      const ex = await call("/item/public_token/exchange", { public_token });
      if (ex.error_message) return { statusCode: 502, headers, body: JSON.stringify({ error: ex.error_message }) };
      const bal = await call("/accounts/balance/get", { access_token: ex.access_token });
      // Privacy by design: discard the connection immediately after the one-time read.
      await call("/item/remove", { access_token: ex.access_token });
      if (bal.error_message) return { statusCode: 502, headers, body: JSON.stringify({ error: bal.error_message }) };
      const accounts = (bal.accounts || []).map(a => ({
        name: (a.name || a.official_name || "Account") + (a.mask ? " ••••" + a.mask : ""),
        type: a.subtype || a.type,
        balance: a.balances?.current ?? a.balances?.available ?? 0
      }));
      return { statusCode: 200, headers, body: JSON.stringify({ accounts, institution: bal.item?.institution_id || "" }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "unknown action" }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
