// HomegoingHQ — Approve a co-brand partner application (admin-only).
// Churches: free — provision immediately + email a set-password link.
// Funeral homes: create the account, mark approved, and email them a Stripe
// checkout link ($149/mo). The existing stripe-webhook provisions their co-brand
// account once they pay (subdomain is set afterward in the admin panel).
// Every email includes a short "what HomegoingHQ is" intro + optional video.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
//      SENDGRID_API_KEY, FROM_EMAIL, SITE_URL, INTRO_VIDEO_URL (optional)
const sleep = ms => new Promise(r => setTimeout(r, ms));

const INTRO_HTML = () => `
  <p style="font-size:14px;line-height:1.6;color:#26332E">HomegoingHQ is a guided platform that helps families through the weeks after a death — a step-by-step roadmap of every task and deadline, ready-to-send notification letters and documents, memorial pages, and a calm place to keep what matters. When you co-brand it, the families you serve get all of it under your name.</p>`;
const VIDEO_HTML = () => {
  const v = process.env.INTRO_VIDEO_URL;
  return v ? `<p style="text-align:center;margin:14px 0"><a href="${v}" style="font-family:Arial,sans-serif;color:#8F6A24;font-weight:bold;text-decoration:none">▶ Watch a short introduction</a></p>` : "";
};

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };

  const SB = process.env.SUPABASE_URL || "https://vohqgmnurnkgbwpvrakp.supabase.co";
  const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANON = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvaHFnbW51cm5rZ2J3cHZyYWtwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNjc0NTYsImV4cCI6MjA5ODk0MzQ1Nn0.fXDBbljOS_p49FS9vU4smAWxyn4STYuLRGFf9rJgp-Q";
  if (!SB || !SR) return { statusCode: 500, headers, body: JSON.stringify({ error: "db not configured" }) };
  const site = process.env.SITE_URL || "https://app.homegoinghq.com";
  const SRH = { apikey: SR, Authorization: "Bearer " + SR, "Content-Type": "application/json" };

  const profileUid = async (email) => {
    const j = await (await fetch(SB + "/rest/v1/profiles?select=id&email=eq." + encodeURIComponent(email), { headers: SRH })).json().catch(() => []);
    return Array.isArray(j) && j[0] ? j[0].id : null;
  };
  const sendMail = async (to, subject, html) => {
    if (!process.env.SENDGRID_API_KEY || !process.env.FROM_EMAIL) return;
    await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.SENDGRID_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: process.env.FROM_EMAIL, name: "HomegoingHQ" },
        subject, content: [{ type: "text/html", value: html }]
      })
    }).catch(() => {});
  };
  const recoveryLink = async (email) => {
    const gj = await (await fetch(SB + "/auth/v1/admin/generate_link", { method: "POST", headers: SRH, body: JSON.stringify({ type: "recovery", email, redirect_to: site }) })).json().catch(() => ({}));
    return gj.action_link || (gj.properties && gj.properties.action_link) || null;
  };
  const shell = (title, inner) => `<div style="font-family:Georgia,serif;max-width:540px;margin:0 auto;color:#26332E">
    <div style="background:#26332E;color:#F6F2EA;border-radius:14px 14px 0 0;padding:22px 26px;font-size:20px">${title}</div>
    <div style="border:1px solid #E4DDCE;border-top:none;border-radius:0 0 14px 14px;padding:26px;background:#FFFDF9">${inner}
      <p style="font-size:12.5px;color:#5B7183;margin-top:18px">Questions? <a href="mailto:care@homegoinghq.com" style="color:#8F6A24">care@homegoinghq.com</a></p>
    </div></div>`;

  try {
    const { accessToken, id, subdomain } = JSON.parse(event.body || "{}");
    if (!accessToken) return { statusCode: 401, headers, body: JSON.stringify({ error: "not signed in" }) };
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: "application id required" }) };

    const who = await fetch(SB + "/auth/v1/user", { headers: { apikey: ANON, Authorization: "Bearer " + accessToken } });
    if (!who.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: "session invalid" }) };
    const adminUid = (await who.json().catch(() => ({}))).id || null;
    const ia = await fetch(SB + "/rest/v1/rpc/is_admin", { method: "POST", headers: { apikey: ANON, Authorization: "Bearer " + accessToken, "Content-Type": "application/json" }, body: "{}" });
    if (!(ia.ok && (await ia.json()) === true)) return { statusCode: 403, headers, body: JSON.stringify({ error: "admin only" }) };

    const apps = await (await fetch(SB + "/rest/v1/partner_applications?select=*&id=eq." + encodeURIComponent(id), { headers: SRH })).json();
    const app = Array.isArray(apps) && apps[0];
    if (!app) return { statusCode: 200, headers, body: JSON.stringify({ error: "not_found" }) };
    if (app.status === "approved") return { statusCode: 200, headers, body: JSON.stringify({ error: "already_approved" }) };
    const email = (app.owner_email || "").toLowerCase();
    const isChurch = app.tenant_type === "church";
    const biz = (app.business_name || "your organization").replace(/</g, "&lt;");

    // Ensure the owner has an account (needed for both paths).
    let uid = await profileUid(email);
    let created = false;
    if (!uid) {
      await fetch(SB + "/auth/v1/admin/users", { method: "POST", headers: SRH, body: JSON.stringify({ email, email_confirm: true, user_metadata: { full_name: app.contact_name || app.business_name || "" } }) });
      created = true;
      for (let i = 0; i < 6 && !uid; i++) { await sleep(400); uid = await profileUid(email); }
      if (!uid) return { statusCode: 200, headers, body: JSON.stringify({ error: "account_pending", created: true }) };
    }

    // ---------- CHURCH: free — provision now ----------
    if (isChurch) {
      const res = await (await fetch(SB + "/rest/v1/rpc/admin_approve_partner_application", {
        method: "POST", headers: { apikey: ANON, Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ p_id: id, p_subdomain: subdomain || null })
      })).json().catch(() => ({}));
      if (res && res.error) return { statusCode: 200, headers, body: JSON.stringify({ error: res.error, created }) };

      const sub = (subdomain || app.desired_subdomain || "").toString().replace(/[^a-z0-9-]/gi, "").toLowerCase();
      const branded = sub ? ("https://" + sub + ".homegoinghq.com") : site;
      const link = created ? await recoveryLink(email) : null;
      await sendMail(email, "Welcome — your HomegoingHQ portal is ready", shell("Welcome to HomegoingHQ", `
        <p style="font-size:15px;line-height:1.6">Welcome, <strong>${biz}</strong> — you're approved, and it's <strong>free</strong> for your congregation, always.</p>
        ${INTRO_HTML()}${VIDEO_HTML()}
        ${created && link ? `<p style="font-size:14px">First, set your password:</p><p style="text-align:center;margin:18px 0"><a href="${link}" style="background:#8F6A24;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-family:Arial,sans-serif;font-weight:bold">Set your password →</a></p>` : `<p style="text-align:center;margin:18px 0"><a href="${site}" style="background:#8F6A24;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-family:Arial,sans-serif;font-weight:bold">Sign in to finish setup</a></p>`}
        <p style="font-size:14px">Your branded space: <a href="${branded}" style="color:#8F6A24">${branded}</a></p>`));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, created, tenant_type: "church" }) };
    }

    // ---------- FUNERAL HOME: paid — mark approved + send Stripe checkout ----------
    await fetch(SB + "/rest/v1/partner_applications?id=eq." + encodeURIComponent(id), {
      method: "PATCH", headers: Object.assign({}, SRH, { Prefer: "return=minimal" }),
      body: JSON.stringify({ status: "approved", reviewed_by: adminUid, reviewed_at: new Date().toISOString() })
    });

    let checkoutUrl = null;
    try {
      const co = await (await fetch(site + "/.netlify/functions/stripe-checkout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "funeralhome", email, userId: uid, business: app.business_name || "" })
      })).json();
      checkoutUrl = co && co.url;
    } catch (e) { /* surfaced below */ }

    const link = created ? await recoveryLink(email) : null;
    await sendMail(email, "You're approved — start your HomegoingHQ portal", shell("You're approved", `
      <p style="font-size:15px;line-height:1.6">Welcome, <strong>${biz}</strong>. We'd be glad to offer HomegoingHQ to the families you serve, under your own name.</p>
      ${INTRO_HTML()}${VIDEO_HTML()}
      <p style="font-size:14px;line-height:1.6">Funeral-home partnership is a simple <strong>$149/month</strong> subscription — no per-family cost. Two quick steps to go live:</p>
      ${created && link ? `<p style="font-size:14px;margin:0 0 4px"><strong>1.</strong> Set your password:</p><p style="text-align:center;margin:8px 0 16px"><a href="${link}" style="background:#26332E;color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-family:Arial,sans-serif;font-weight:bold">Set your password</a></p>` : ""}
      <p style="font-size:14px;margin:0 0 4px"><strong>${created ? "2." : "1."}</strong> Start your subscription:</p>
      <p style="text-align:center;margin:8px 0 16px">${checkoutUrl ? `<a href="${checkoutUrl}" style="background:#8F6A24;color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-family:Arial,sans-serif;font-weight:bold">Start subscription →</a>` : `<a href="${site}" style="color:#8F6A24">Sign in to subscribe</a>`}</p>
      <p style="font-size:13px;color:#5B7183;line-height:1.6">Once payment is complete, your co-branded portal activates and we'll set up your branded web address. Families choose and pay for their own plans — everything stays under your name.</p>`));

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, created, tenant_type: "funeral_home", needsPayment: true, checkoutUrl }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
