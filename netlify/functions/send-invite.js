// LegacyHQ — Invite email via SendGrid
// Env vars: SENDGRID_API_KEY, FROM_EMAIL (verified sender), SITE_URL
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (!process.env.SENDGRID_API_KEY) return { statusCode: 200, headers, body: JSON.stringify({ skipped: true }) };

  try {
    const { email, inviterName, contextName, kind, unlockAt } = JSON.parse(event.body || "{}");
    if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: "email required" }) };

    const site = process.env.SITE_URL || "";
    let subject, intro, cta = "Open LegacyHQ";
    if (kind === "emergency") {
      subject = `Emergency access requested on your LegacyHQ plan`;
      intro = `${inviterName} has requested emergency access to your plan for ${contextName}, attesting that access is needed now. If this is expected, no action is needed — access unlocks automatically ${unlockAt ? "on " + new Date(unlockAt).toLocaleString() : "after your waiting period"}. <strong>If this is NOT expected, sign in immediately and decline the request.</strong>`;
      cta = "Review the request";
    } else if (kind === "estate") {
      subject = `${inviterName} invited you to help settle the estate of ${contextName}`;
      intro = `${inviterName} is using LegacyHQ to coordinate everything after the passing of ${contextName}, and has invited you to help — tasks, documents, and next steps, all in one calm place.`;
    } else {
      subject = `${inviterName} shared their LegacyHQ plan with you`;
      intro = `${inviterName} has organized important information for ${contextName} in LegacyHQ and wants you to have access when it matters.`;
    }

    const html = `
      <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#26332E">
        <div style="background:#26332E;color:#F6F2EA;border-radius:14px 14px 0 0;padding:22px 26px;font-size:20px">LegacyHQ</div>
        <div style="border:1px solid #E4DDCE;border-top:none;border-radius:0 0 14px 14px;padding:26px;background:#FFFDF9">
          <p style="font-size:16px;line-height:1.6">${intro}</p>
          ${kind==="emergency" ? "" : `<p style="font-size:15px;line-height:1.6">To join, create a free account using <strong>this email address</strong> — you'll be connected automatically:</p>`}
          <p style="margin:26px 0"><a href="${site}" style="background:#A67C2E;color:#fff;text-decoration:none;padding:13px 24px;border-radius:10px;font-family:Arial,sans-serif;font-weight:bold">${cta}</a></p>
          <p style="font-size:12px;color:#5B7183">If you weren't expecting this, you can safely ignore this email.</p>
        </div>
      </div>`;

    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + process.env.SENDGRID_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: process.env.FROM_EMAIL, name: "LegacyHQ" },
        subject,
        content: [{ type: "text/html", value: html }]
      })
    });
    return { statusCode: 200, headers, body: JSON.stringify({ sent: resp.ok }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
