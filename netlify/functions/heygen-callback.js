// HomegoingHQ — HeyGen callback receiver (regular Netlify function, runs in seconds).
// HeyGen POSTs here when a render finishes. We download the MP4, store it in
// Supabase, and save clip_url on the milestone. No polling, no timeout.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HEYGEN_CALLBACK_SECRET(optional)

const BUCKET = "milestone-clips";

async function sbUpload(path, buffer, contentType) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(base + "/storage/v1/object/" + BUCKET + "/" + path, {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "apikey": key, "Content-Type": contentType, "x-upsert": "true" },
    body: buffer
  });
  if (!r.ok) throw new Error("Supabase upload failed: " + r.status + " " + (await r.text().catch(() => "")).slice(0, 160));
  return base + "/storage/v1/object/public/" + BUCKET + "/" + path;
}
async function sbSetClip(phase, clipUrl) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  await fetch(base + "/rest/v1/app_messages?kind=eq.milestone&phase=eq." + encodeURIComponent(phase), {
    method: "PATCH",
    headers: { "Authorization": "Bearer " + key, "apikey": key, "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify({ clip_url: clipUrl })
  });
}

exports.handler = async (event) => {
  // HeyGen validates endpoints with a quick OPTIONS request — answer fast.
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 200, body: "ok" };

  // optional shared-secret check
  const secret = process.env.HEYGEN_CALLBACK_SECRET;
  if (secret) {
    const given = (event.queryStringParameters && event.queryStringParameters.k) || "";
    if (given !== secret) { console.log("heygen-callback: bad secret"); return { statusCode: 401, body: "bad secret" }; }
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  const type = body.event_type || "";
  const d = body.event_data || {};
  const phase = (d.callback_id || "").trim();
  console.log("heygen-callback:", type, "phase=", phase);

  if (type === "avatar_video.fail") {
    console.log("heygen-callback: render failed —", d.msg || "(no message)");
    return { statusCode: 200, body: "ack" };
  }
  if (type !== "avatar_video.success" || !d.url || !phase) {
    return { statusCode: 200, body: "ignored" };
  }

  try {
    const vidResp = await fetch(d.url);
    if (!vidResp.ok) throw new Error("download failed: " + vidResp.status);
    const vidBuf = Buffer.from(await vidResp.arrayBuffer());
    const publicUrl = await sbUpload(phase + ".mp4", vidBuf, "video/mp4");
    await sbSetClip(phase, publicUrl);
    console.log("heygen-callback: stored", phase, publicUrl);
    return { statusCode: 200, body: JSON.stringify({ ok: true, phase, clip_url: publicUrl }) };
  } catch (err) {
    console.log("heygen-callback error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
