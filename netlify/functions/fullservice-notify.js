// HomegoingHQ — notify the designer when a full-service order is submitted.
// Env: SENDGRID_API_KEY (already set), SENDGRID_FROM (optional, defaults care@homegoinghq.com),
//      FULLSERVICE_NOTIFY_EMAIL (where designer notifications go; defaults to SENDGRID_FROM)
exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  const key = process.env.SENDGRID_API_KEY;
  if (!key) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, skipped: "no SENDGRID_API_KEY" }) };

  try {
    const b = JSON.parse(event.body || "{}");
    const from = process.env.SENDGRID_FROM || "care@homegoinghq.com";
    const to = process.env.FULLSERVICE_NOTIFY_EMAIL || from;
    const q = b.quote || {};
    const c = b.contact || {};
    const balanceLink = b.orderId && b.siteUrl ? (b.siteUrl + "/?fsbalance=" + b.orderId) : "(available after deploy)";
    const lines = [
      "New full-service design request.",
      "",
      "Service: " + (q.tierName || b.tier || "—"),
      "For: " + (b.decedent || "—"),
      "Design fee (paid/charging now): $" + (Number(b.designFee || 0).toFixed(2)),
      "Printing balance (bill at proof approval): $" + (Number(b.balance || 0).toFixed(2)),
      "Estimated total: $" + (Number(q.total || 0).toFixed(2)),
      "",
      "Contact: " + (c.name || "") + " · " + (c.email || "") + " · " + (c.phone || ""),
      "",
      "Order summary: " + (b.summary || ""),
      "",
      "When the proof is approved, send the family this link to pay the printing balance:",
      balanceLink
    ];
    const body = lines.join("\n");
    const html = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from, name: "HomegoingHQ" },
        reply_to: c.email ? { email: c.email } : { email: from },
        subject: "New full-service request — " + (q.tierName || "design"),
        content: [{ type: "text/plain", value: body }, { type: "text/html", value: html }]
      })
    });
    if (r.status >= 200 && r.status < 300) return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, status: r.status }) };
  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
