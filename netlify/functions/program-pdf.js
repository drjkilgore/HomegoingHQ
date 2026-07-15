// ============================================================================
// Netlify Function: program-pdf
// Turns a funeral-program's print HTML into a print-ready PDF, stores it in
// Supabase Storage, and returns a signed URL you can hand to Peecho (or offer
// as a download).
//
// Dependency-free (matches your other functions): only global fetch + built-ins.
// The actual HTML->PDF rendering is done by a Chromium-based renderer reached
// over HTTP, so this ONE file works whether that renderer is:
//   • a hosted service (e.g. Browserless cloud)          — recommended to start
//   • your own Browserless/Chromium container            — later, same code
// Switching between them is just changing PDF_RENDER_URL. No code change.
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (already set for your other fns)
//   PDF_RENDER_URL     Chromium HTML->PDF endpoint that accepts { html, options }
//                      and returns the PDF bytes. e.g.
//                      https://production-sfo.browserless.io/pdf?token=YOUR_TOKEN
//   PDF_RENDER_TOKEN   (optional) sent as a Bearer header if your renderer wants
//                      the token in a header instead of the URL query string
//   PROGRAM_PDF_BUCKET (optional) storage bucket name, default "program-pdfs"
// ============================================================================

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  try {
    const { estateId, html } = JSON.parse(event.body || "{}");
    if (!html || html.length < 50) return json(400, { error: "html required" });

    // ---- authorize the caller (the family member's Supabase session) ----
    const token = (event.headers.authorization || event.headers.Authorization || "")
      .replace(/^Bearer\s+/i, "");
    if (token) {
      const who = await fetch(process.env.SUPABASE_URL + "/auth/v1/user", {
        headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + token },
      });
      if (!who.ok) return json(401, { error: "not signed in" });
    }

    // ---- 1) render HTML -> print-ready PDF (Chromium) ----
    const pdf = await renderPdf(html);

    // ---- 2) upload to Supabase Storage (REST) ----
    const bucket = process.env.PROGRAM_PDF_BUCKET || "program-pdfs";
    const path = `${(estateId || "misc").replace(/[^a-zA-Z0-9_-]/g, "")}/program-${Date.now()}.pdf`;
    const up = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`,
      {
        method: "POST",
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/pdf",
          "x-upsert": "true",
        },
        body: pdf,
      },
    );
    if (!up.ok) return json(502, { error: "storage upload failed: " + (await up.text()).slice(0, 300) });

    // ---- 3) signed URL (Peecho fetches this; 7-day TTL) ----
    const signRes = await fetch(
      `${process.env.SUPABASE_URL}/storage/v1/object/sign/${bucket}/${path}`,
      {
        method: "POST",
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 7 }),
      },
    );
    if (!signRes.ok) return json(502, { error: "sign failed: " + (await signRes.text()).slice(0, 300) });
    const signed = await signRes.json();
    const url = process.env.SUPABASE_URL + "/storage/v1" + signed.signedURL;

    return json(200, { url, path, bytes: pdf.length });
  } catch (e) {
    return json(500, { error: String((e && e.message) || e) });
  }
};

// Render via a Chromium HTML->PDF endpoint. margin 0 + preferCSSPageSize lets
// the program's own @page / print CSS control the trim size. Peecho adds bleed
// and cut marks itself, so we hand it a clean flat sheet.
async function renderPdf(html) {
  const endpoint = process.env.PDF_RENDER_URL;
  if (!endpoint) throw new Error("PDF_RENDER_URL not set");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.PDF_RENDER_TOKEN ? { Authorization: "Bearer " + process.env.PDF_RENDER_TOKEN } : {}),
    },
    body: JSON.stringify({
      html,
      options: {
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
      },
    }),
  });
  if (!res.ok) throw new Error("renderer " + res.status + ": " + (await res.text()).slice(0, 300));
  return Buffer.from(await res.arrayBuffer());
}

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
