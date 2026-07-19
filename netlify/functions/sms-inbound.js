// HomegoingHQ — Twilio inbound SMS webhook. Honors STOP/START to keep our
// opt-out state in sync. Point your Twilio number's "A MESSAGE COMES IN" webhook
// (or the Messaging Service inbound webhook) to /.netlify/functions/sms-inbound.
exports.handler = async (event) => {
  const SB = process.env.SUPABASE_URL, SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const twiml = () => ({ statusCode: 200, headers: { "Content-Type": "text/xml" }, body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>' });
  try {
    const params = new URLSearchParams(event.body || "");
    const from = (params.get("From") || "").trim();
    const text = (params.get("Body") || "").trim().toUpperCase();
    if (!SB || !SR || !from) return twiml();
    const SRH = { apikey: SR, Authorization: "Bearer " + SR, "Content-Type": "application/json" };
    const STOP = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
    const START = ["START", "YES", "UNSTOP"];
    let optedOut = null;
    if (STOP.includes(text)) optedOut = true; else if (START.includes(text)) optedOut = false;
    if (optedOut !== null) {
      await fetch(SB + "/rest/v1/sms_subscriptions?phone=eq." + encodeURIComponent(from), { method: "PATCH", headers: Object.assign({}, SRH, { Prefer: "return=minimal" }), body: JSON.stringify({ opted_out: optedOut, updated_at: new Date().toISOString() }) }).catch(() => {});
    }
    return twiml(); // Twilio's Advanced Opt-Out sends the STOP/START confirmation automatically.
  } catch (err) { return twiml(); }
};
