// HomegoingHQ — daily scheduled check: text opted-in members about tasks due within
// 3 days. One reminder per task per user (sms_sent_log). Scheduled in netlify.toml.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
//      TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER.
exports.handler = async () => {
  const SB = process.env.SUPABASE_URL, SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SID = process.env.TWILIO_ACCOUNT_SID, TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const MSID = process.env.TWILIO_MESSAGING_SERVICE_SID, FROM = process.env.TWILIO_FROM_NUMBER;
  if (!SB || !SR) return { statusCode: 200, body: "supabase not configured" };
  if (!SID || !TOKEN || (!MSID && !FROM)) return { statusCode: 200, body: "twilio not configured" };
  const SRH = { apikey: SR, Authorization: "Bearer " + SR, "Content-Type": "application/json" };
  const q = async (path) => (await fetch(SB + "/rest/v1/" + path, { headers: SRH })).json();
  const sendSms = async (to, body) => {
    const p = new URLSearchParams(); p.set("To", to); p.set("Body", body);
    if (MSID) p.set("MessagingServiceSid", MSID); else p.set("From", FROM);
    const r = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + SID + "/Messages.json", { method: "POST", headers: { Authorization: "Basic " + Buffer.from(SID + ":" + TOKEN).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: p.toString() });
    return r.ok;
  };
  const now = new Date(), soon = new Date(now.getTime() + 3 * 86400000);
  let sent = 0;
  try {
    const tasks = await q(`tasks?select=id,estate_id,title,due_at,assignee&status=eq.todo&due_at=gte.${now.toISOString()}&due_at=lte.${soon.toISOString()}&order=due_at&limit=300`);
    for (const t of (tasks || [])) {
      let recipientIds = [];
      if (t.assignee) recipientIds = [t.assignee];
      else { const mem = await q(`estate_members?select=user_id&estate_id=eq.${t.estate_id}`); recipientIds = (mem || []).map(m => m.user_id); }
      if (!recipientIds.length) continue;
      const subs = await q(`sms_subscriptions?select=user_id,phone&estate_id=eq.${t.estate_id}&consent=eq.true&opted_out=eq.false&user_id=in.(${recipientIds.join(",")})`);
      for (const s of (subs || [])) {
        const log = await q(`sms_sent_log?select=id&task_id=eq.${t.id}&user_id=eq.${s.user_id}&limit=1`);
        if (Array.isArray(log) && log.length) continue;
        const due = t.due_at ? (" (due " + String(t.due_at).slice(0, 10) + ")") : "";
        const ok = await sendSms(s.phone, `HomegoingHQ reminder: "${t.title}"${due}. Reply STOP to opt out.`);
        await fetch(SB + "/rest/v1/sms_sent_log", { method: "POST", headers: Object.assign({}, SRH, { Prefer: "return=minimal" }), body: JSON.stringify([{ task_id: t.id, user_id: s.user_id }]) }).catch(() => {});
        if (ok) sent++;
      }
    }
    return { statusCode: 200, body: "sent " + sent };
  } catch (err) { return { statusCode: 200, body: "error " + err.message }; }
};
