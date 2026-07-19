// HomegoingHQ — Invite a co-brand partner (funeral home/church) or a concierge.
// Admin-only: verifies the caller's Supabase JWT and is_admin() before sending.
// Funeral home/church → link to the co-brand apply page (partners-apply.html).
// Concierge → link to the concierge program (concierge.homegoinghq.com).
// Env: SENDGRID_API_KEY, FROM_EMAIL, SITE_URL, SUPABASE_URL, SUPABASE_ANON_KEY,
//      INTRO_VIDEO_URL (optional), CONCIERGE_APPLY_URL (optional)
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  if (!process.env.SENDGRID_API_KEY || !process.env.FROM_EMAIL) return { statusCode: 500, headers, body: JSON.stringify({ error: "email not configured" }) };
  const SB = process.env.SUPABASE_URL || "https://vohqgmnurnkgbwpvrakp.supabase.co";
  const ANON = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvaHFnbW51cm5rZ2J3cHZyYWtwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNjc0NTYsImV4cCI6MjA5ODk0MzQ1Nn0.fXDBbljOS_p49FS9vU4smAWxyn4STYuLRGFf9rJgp-Q";

  try {
    const { accessToken, email, business, tenant_type } = JSON.parse(event.body || "{}");
    if (!accessToken) return { statusCode: 401, headers, body: JSON.stringify({ error: "not signed in" }) };
    const to = (email || "").trim().toLowerCase();
    if (!to || !to.includes("@")) return { statusCode: 400, headers, body: JSON.stringify({ error: "valid email required" }) };
    const type = ["church", "concierge", "funeral_home"].includes(tenant_type) ? tenant_type : "funeral_home";

    // 1) Verify the caller's token is a real session.
    const uRes = await fetch(SB + "/auth/v1/user", { headers: { apikey: ANON, Authorization: "Bearer " + accessToken } });
    if (!uRes.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: "session invalid" }) };

    // 2) Verify the caller is an admin.
    const aRes = await fetch(SB + "/rest/v1/rpc/is_admin", {
      method: "POST",
      headers: { apikey: ANON, Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: "{}"
    });
    if (!(aRes.ok && (await aRes.json()) === true)) return { statusCode: 403, headers, body: JSON.stringify({ error: "admin only" }) };

    // 3) Build the right link + copy for the type.
    const site = process.env.SITE_URL || "https://app.homegoinghq.com";
    const video = process.env.INTRO_VIDEO_URL || "https://youtu.be/aMxpT9fuYII";
    const videoBtn = video ? `<p style="text-align:center;margin:14px 0"><a href="${video}" style="font-family:Arial,sans-serif;color:#8F6A24;font-weight:bold;text-decoration:none">▶ See how HomegoingHQ works</a></p>` : "";
    const introP = `<p style="font-size:14px;line-height:1.6;color:#26332E">HomegoingHQ is a guided platform that helps families through the weeks after a death — a step-by-step roadmap of every task and deadline, ready-to-send notification letters and documents, memorial pages, and a calm place to keep what matters.</p>`;
    const bizSafe = (business || "").replace(/</g, "&lt;");
    const greeting = business ? ("Hello " + bizSafe + ",") : "Hello,";
    const isConcierge = type === "concierge";
    const isChurch = type === "church";

    let link, subject, pitchP, applyIntro, buttonLabel;
    if (isConcierge) {
      link = process.env.CONCIERGE_APPLY_URL || "https://concierge.homegoinghq.com";
      subject = "Become a HomegoingHQ Concierge";
      pitchP = `<p style="font-size:15px;line-height:1.6">We'd love to have you join as a <strong>HomegoingHQ Concierge</strong> — a certified professional who walks families through settling an estate, at their side from the first call to the final task. You bring the care; HomegoingHQ gives you the roadmap, the tools, and families who need help.</p>`;
      applyIntro = `<p style="font-size:14px;line-height:1.6">If you'd like to join, learn more and apply here — we review each concierge personally:</p>`;
      buttonLabel = "Apply to become a Concierge →";
    } else {
      const q = new URLSearchParams({ type });
      if (business) q.set("biz", business);
      if (to) q.set("email", to);
      link = site + "/partners-apply.html?" + q.toString();
      subject = "Bring HomegoingHQ to your families";
      const kindWord = isChurch ? "congregation" : "the families you serve";
      const priceLine = isChurch
        ? "As a place of worship, it's <strong>free</strong> — a gift to your congregation, always."
        : "For funeral homes it's a simple monthly subscription, with no extra per-family cost — families choose their own plans.";
      pitchP = `<p style="font-size:15px;line-height:1.6">We'd love to offer <strong>HomegoingHQ</strong> to ${kindWord} — the full guided aftercare platform (roadmap, letters, documents, and memorial tools) under your own name, at <em>yourname.homegoinghq.com</em>.</p>
        <p style="font-size:14px;line-height:1.6">${priceLine}</p>`;
      applyIntro = `<p style="font-size:14px;line-height:1.6">If you'd like to bring it on, apply here — it takes about two minutes, and we review each partner personally:</p>`;
      buttonLabel = "Apply to co-brand →";
    }

    const html = `<div style="font-family:Georgia,serif;max-width:540px;margin:0 auto;color:#26332E">
      <div style="background:#26332E;color:#F6F2EA;border-radius:14px 14px 0 0;padding:22px 26px;font-size:20px">An invitation from HomegoingHQ</div>
      <div style="border:1px solid #E4DDCE;border-top:none;border-radius:0 0 14px 14px;padding:26px;background:#FFFDF9">
        <p style="font-size:15px;line-height:1.6">${greeting}</p>
        ${pitchP}
        ${introP}
        ${videoBtn}
        ${applyIntro}
        <p style="margin:22px 0;text-align:center"><a href="${link}" style="background:#8F6A24;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-family:Arial,sans-serif;font-weight:bold">${buttonLabel}</a></p>
        <p style="font-size:12.5px;color:#5B7183">Questions? Reach us at <a href="mailto:care@homegoinghq.com" style="color:#8F6A24">care@homegoinghq.com</a>.</p>
      </div></div>`;

    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.SENDGRID_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: process.env.FROM_EMAIL, name: "HomegoingHQ" },
        subject,
        content: [{ type: "text/html", value: html }]
      })
    });
    if (!resp.ok) {
      const t = await resp.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: "email send failed", detail: t.slice(0, 300) }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
