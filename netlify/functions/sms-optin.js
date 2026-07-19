// HomegoingHQ — send a one-time confirmation text after a member opts in.
// POST { accessToken, estateId }. Reads the member's own subscription (service role),
// confirms consent, then texts them. Env: SUPABASE_*, TWILIO_ACCOUNT_SID,
// TWILIO_AUTH_TOKEN, and TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER.
exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  const SB = process.env.SUPABASE_URL || "https://vohqgmnurnkgbwpvrakp.supabase.co";
  const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANON = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvaHFnbW51cm5rZ2J3cHZyYWtwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNjc0NTYsImV4cCI6MjA5ODk0MzQ1Nn0.fXDBbljOS_p49FS9vU4smAWxyn4STYuLRGFf9rJgp-Q";
  const SID = process.env.TWILIO_ACCOUNT_SID, TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const MSID = process.env.TWILIO_MESSAGING_SERVICE_SID, FROM = process.env.TWILIO_FROM_NUMBER;
  if (!SR) return { statusCode: 500, headers, body: JSON.stringify({ error: "not_configured" }) };
  const SRH = { apikey: SR, Authorization: "Bearer " + SR, "Content-Type": "application/json" };
  try {
    const { accessToken, estateId } = JSON.parse(event.body || "{}");
    if (!accessToken || !estateId) return { statusCode: 400, headers, body: JSON.stringify({ error: "missing params" }) };
    const who = await fetch(SB + "/auth/v1/user", { headers: { apikey: ANON, Authorization: "Bearer " + accessToken } });
    if (!who.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: "session invalid" }) };
    const uid = (await who.json()).id;
    const subs = await (await fetch(SB + "/rest/v1/sms_subscriptions?select=phone,consent,opted_out&estate_id=eq." + encodeURIComponent(estateId) + "&user_id=eq." + uid, { headers: SRH })).json();
    const sub = Array.isArray(subs) && subs[0];
    if (!sub || !sub.consent || sub.opted_out) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: "no_consent" }) };
    if (!SID || !TOKEN || (!MSID && !FROM)) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, note: "twilio_not_configured" }) };
    const est = await (await fetch(SB + "/rest/v1/estates?select=decedent_name&id=eq." + encodeURIComponent(estateId), { headers: SRH })).json();
    const name = (Array.isArray(est) && est[0] && est[0].decedent_name) || "the estate";
    const body = "HomegoingHQ: You're set to receive reminders about " + name + "'s estate. Msg & data rates may apply. Reply STOP to opt out.";
    const p = new URLSearchParams(); p.set("To", sub.phone); p.set("Body", body);
    if (MSID) p.set("MessagingServiceSid", MSID); else p.set("From", FROM);
    const r = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + SID + "/Messages.json", { method: "POST", headers: { Authorization: "Basic " + Buffer.from(SID + ":" + TOKEN).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: p.toString() });
    const d = await r.json();
    if (!r.ok) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: d.message || "send failed" }) };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) { return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }; }
};
