// HomegoingHQ — Admin-only: pay ONE owed designer_payout via Stripe Connect.
// Verifies the caller is an admin (is_admin RPC, run as the user), re-checks the
// designer's Stripe account is payouts-enabled, creates an idempotent Transfer,
// then marks the payout paid. Real money movement — guarded on every side.
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
const H = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: H, body: JSON.stringify({ error: "POST only" }) };

  const SK = process.env.STRIPE_SECRET_KEY;
  const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANON = process.env.SUPABASE_ANON_KEY || KEY;
  if (!SK || !SB || !KEY) return { statusCode: 500, headers: H, body: JSON.stringify({ error: "server not configured" }) };

  try {
    const { token, payoutId } = JSON.parse(event.body || "{}");
    if (!token) return { statusCode: 401, headers: H, body: JSON.stringify({ error: "not signed in" }) };
    if (!payoutId) return { statusCode: 400, headers: H, body: JSON.stringify({ error: "payoutId required" }) };

    // ---- verify admin using the app's own is_admin() RPC, run AS the user ----
    const adminResp = await fetch(SB + "/rest/v1/rpc/is_admin", {
      method: "POST",
      headers: { apikey: ANON, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: "{}",
    });
    const isAdmin = adminResp.ok && (await adminResp.json()) === true;
    if (!isAdmin) return { statusCode: 403, headers: H, body: JSON.stringify({ error: "forbidden" }) };

    const svc = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };

    // ---- load the payout + its designer's Stripe account (service role) ----
    const pResp = await fetch(SB + "/rest/v1/designer_payouts?id=eq." + encodeURIComponent(payoutId) +
      "&select=id,amount,status,designer_id,designers(stripe_account_id,payouts_enabled,full_name)", { headers: svc });
    const pRows = await pResp.json();
    const p = Array.isArray(pRows) ? pRows[0] : null;
    if (!p) return { statusCode: 404, headers: H, body: JSON.stringify({ error: "payout not found" }) };
    if (p.status !== "owed") return { statusCode: 409, headers: H, body: JSON.stringify({ error: "already paid" }) };

    const d = p.designers || {};
    const acct = d.stripe_account_id;
    if (!acct) return { statusCode: 400, headers: H, body: JSON.stringify({ error: "designer has not connected a Stripe payout account" }) };

    const cents = Math.round(Number(p.amount) * 100);
    if (!(cents > 0)) return { statusCode: 400, headers: H, body: JSON.stringify({ error: "nothing to pay" }) };

    // ---- re-verify the account is payouts-enabled straight from Stripe ----
    const aResp = await fetch("https://api.stripe.com/v1/accounts/" + encodeURIComponent(acct),
      { headers: { Authorization: "Bearer " + SK } });
    const aData = await aResp.json();
    if (!aResp.ok) return { statusCode: 502, headers: H, body: JSON.stringify({ error: (aData.error && aData.error.message) || "stripe error" }) };
    if (!aData.payouts_enabled) return { statusCode: 400, headers: H, body: JSON.stringify({ error: "designer's payouts are not enabled yet" }) };

    // ---- create the transfer (idempotent by payout id: safe on retry/double-click) ----
    const tform = new URLSearchParams();
    tform.append("amount", String(cents));
    tform.append("currency", "usd");
    tform.append("destination", acct);
    tform.append("metadata[payout_id]", p.id);
    tform.append("metadata[designer_id]", p.designer_id || "");
    const tResp = await fetch("https://api.stripe.com/v1/transfers", {
      method: "POST",
      headers: { Authorization: "Bearer " + SK, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": "payout-" + p.id },
      body: tform.toString(),
    });
    const tData = await tResp.json();
    if (!tResp.ok) return { statusCode: 502, headers: H, body: JSON.stringify({ error: (tData.error && tData.error.message) || "transfer failed" }) };

    // ---- mark paid ONLY if still owed (second guard against double-marking) ----
    await fetch(SB + "/rest/v1/designer_payouts?id=eq." + encodeURIComponent(payoutId) + "&status=eq.owed", {
      method: "PATCH",
      headers: { ...svc, Prefer: "return=minimal" },
      body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString(), paid_method: "stripe", paid_ref: tData.id }),
    });

    return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, transfer_id: tData.id, amount: cents }) };
  } catch (err) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};
