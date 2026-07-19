// HomegoingHQ — "Ask the Guide to read this" document analysis.
// Reads an uploaded estate document (PDF / image / text), asks Claude to extract
// plain-language facts, cautions, and suggested next-step tasks. Information, not
// advice. Membership-gated + Settle-tier gated. Results cached in document_insights.
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
const RANK = { free: 0, companion: 1, settle: 2, premium: 3 };

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
  const AK = process.env.ANTHROPIC_API_KEY;
  if (!SB || !SR || !AK) return { statusCode: 500, headers, body: JSON.stringify({ error: "not_configured" }) };
  const SRH = { apikey: SR, Authorization: "Bearer " + SR, "Content-Type": "application/json" };

  try {
    const { accessToken, documentId, force } = JSON.parse(event.body || "{}");
    if (!accessToken) return { statusCode: 401, headers, body: JSON.stringify({ error: "not signed in" }) };
    if (!documentId) return { statusCode: 400, headers, body: JSON.stringify({ error: "documentId required" }) };

    // 1) Verify session → uid.
    const who = await fetch(SB + "/auth/v1/user", { headers: { apikey: ANON, Authorization: "Bearer " + accessToken } });
    if (!who.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: "session invalid" }) };
    const uid = (await who.json().catch(() => ({}))).id || null;

    // 2) Load the document (service role).
    const docs = await (await fetch(SB + "/rest/v1/documents?select=id,estate_id,name,storage_path,doc_type&id=eq." + encodeURIComponent(documentId), { headers: SRH })).json();
    const doc = Array.isArray(docs) && docs[0];
    if (!doc) return { statusCode: 200, headers, body: JSON.stringify({ error: "not_found" }) };

    // 3) Caller must be a member of that estate.
    const mRes = await fetch(SB + "/rest/v1/rpc/is_estate_member", {
      method: "POST", headers: { apikey: ANON, Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ e: doc.estate_id })
    });
    if (!(mRes.ok && (await mRes.json()) === true)) return { statusCode: 403, headers, body: JSON.stringify({ error: "forbidden" }) };

    // 4) Settle-tier gate (max of estate tier and caller's plan tier — mirrors the app's tier()).
    const est = await (await fetch(SB + "/rest/v1/estates?select=tier&id=eq." + encodeURIComponent(doc.estate_id), { headers: SRH })).json();
    const etier = (Array.isArray(est) && est[0] && est[0].tier) || "free";
    let ptier = "free";
    if (uid) { const pr = await (await fetch(SB + "/rest/v1/profiles?select=plan_tier&id=eq." + uid, { headers: SRH })).json(); ptier = (Array.isArray(pr) && pr[0] && pr[0].plan_tier) || "free"; }
    const eff = Math.max(RANK[etier] || 0, RANK[ptier] || 0);
    if (eff < RANK.settle) return { statusCode: 200, headers, body: JSON.stringify({ error: "upgrade" }) };

    // 5) Cache hit?
    if (!force) {
      const cached = await (await fetch(SB + "/rest/v1/document_insights?select=insight&document_id=eq." + encodeURIComponent(documentId), { headers: SRH })).json();
      if (Array.isArray(cached) && cached[0] && cached[0].insight) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, insight: cached[0].insight, cached: true }) };
      }
    }

    // 6) Download the file (service role).
    const objPath = String(doc.storage_path).split("/").map(encodeURIComponent).join("/");
    const fRes = await fetch(SB + "/storage/v1/object/estate-docs/" + objPath, { headers: { apikey: SR, Authorization: "Bearer " + SR } });
    if (!fRes.ok) return { statusCode: 200, headers, body: JSON.stringify({ error: "download_failed" }) };
    const buf = Buffer.from(await fRes.arrayBuffer());
    if (buf.length > 12 * 1024 * 1024) return { statusCode: 200, headers, body: JSON.stringify({ error: "too_large" }) };

    // 7) Build the content block by file type.
    const ext = (String(doc.name).split(".").pop() || "").toLowerCase();
    const imgTypes = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
    let fileBlock;
    if (ext === "pdf") {
      fileBlock = { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } };
    } else if (imgTypes[ext]) {
      fileBlock = { type: "image", source: { type: "base64", media_type: imgTypes[ext], data: buf.toString("base64") } };
    } else if (ext === "txt" || ext === "csv") {
      fileBlock = { type: "text", text: "DOCUMENT CONTENTS:\n\n" + buf.toString("utf8").slice(0, 20000) };
    } else {
      return { statusCode: 200, headers, body: JSON.stringify({ error: "unsupported", message: "Please upload a PDF or image (JPG or PNG)." }) };
    }

    const system = `You are the HomegoingHQ Guide, reading a document for a family settling the estate of someone who has died.
Tone: calm, plain, brief (Survivor Mode) — no exclamation points, never chirpy.

You provide INFORMATION, not advice. Explain what the document is and the family's likely next steps in plain language. Never say "you should" on contested legal, tax, or financial judgments — instead note that a licensed attorney, CPA, or financial professional can advise. Quote figures, names, and dates EXACTLY as they appear. Mask account numbers and any SSN to the last 4 digits (e.g. ••••1234). If the document is unreadable or you are unsure, say so plainly rather than guessing. Do not invent facts that are not in the document.

Return ONLY a JSON object — no markdown, no text outside the JSON — with exactly this shape:
{
  "doc_type": one of ["will","trust","life_insurance","bank_statement","bill","invoice","deed","tax_notice","death_certificate","benefits","policy","statement","letter","other"],
  "summary": "2-3 short plain sentences",
  "key_facts": [ {"label": "short label", "value": "value quoted from the document"} ],
  "cautions": [ "short caution string (e.g. don't pay this from personal funds; names a different executor than expected; deadline noted)" ],
  "suggested_tasks": [ {"title": "concrete next step", "why": "one sentence", "how": "practical steps", "phase": "first24|week1|month1|days90|longterm", "category": "short category"} ]
}
Use [] for any empty array. Keep strings concise. Include 0-4 suggested_tasks. Where a matter is clearly legal, tax, or financial in nature, add a caution to consult the appropriate licensed professional.`;

    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: [fileBlock, { type: "text", text: "Read this document and return the JSON described. If it is not clearly readable, set summary to say so and return empty arrays." }] }]
    };

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": AK, "anthropic-version": "2023-06-01", "anthropic-beta": "pdfs-2024-09-25" },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) return { statusCode: 200, headers, body: JSON.stringify({ error: "ai", detail: (data.error && data.error.message) || "AI error" }) };

    const raw = (Array.isArray(data.content) ? data.content : []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    let insight;
    try { insight = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim()); }
    catch (e) { return { statusCode: 200, headers, body: JSON.stringify({ error: "parse" }) }; }

    // Normalize.
    const PH = ["first24", "week1", "month1", "days90", "longterm"];
    insight.doc_type = String(insight.doc_type || "other");
    insight.summary = String(insight.summary || "");
    insight.key_facts = Array.isArray(insight.key_facts) ? insight.key_facts.slice(0, 12).map(f => ({ label: String(f.label || ""), value: String(f.value || "") })) : [];
    insight.cautions = Array.isArray(insight.cautions) ? insight.cautions.slice(0, 8).map(String) : [];
    insight.suggested_tasks = Array.isArray(insight.suggested_tasks) ? insight.suggested_tasks.slice(0, 4).map(t => ({
      title: String(t.title || "").slice(0, 140),
      why: String(t.why || "").slice(0, 300),
      how: String(t.how || "").slice(0, 600),
      phase: PH.includes(t.phase) ? t.phase : "week1",
      category: String(t.category || "From a document").slice(0, 40)
    })) : [];

    // 8) Cache (service role upsert).
    await fetch(SB + "/rest/v1/document_insights", {
      method: "POST",
      headers: Object.assign({}, SRH, { Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify([{ document_id: documentId, estate_id: doc.estate_id, insight }])
    }).catch(() => {});

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, insight }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
