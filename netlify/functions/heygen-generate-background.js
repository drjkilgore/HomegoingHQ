// HomegoingHQ — Milestone avatar render STARTER (Netlify background function).
// Tells HeyGen to render your avatar speaking the milestone text in your HeyGen
// voice, with a callback so we never poll (no timeout). HeyGen notifies
// /heygen-callback when done, which stores the finished video.
//
// Trigger: POST { phase, text }  to /.netlify/functions/heygen-generate-background
// Env: HEYGEN_API_KEY, HEYGEN_AVATAR_ID(optional), HEYGEN_VOICE_ID(optional),
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      PUBLIC_APP_URL(optional, defaults to https://app.homegoinghq.com),
//      HEYGEN_CALLBACK_SECRET(optional shared secret for the callback)

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, body: "" };
  let phase = "", text = "";
  try { const b = JSON.parse(event.body || "{}"); phase = (b.phase || "").trim(); text = (b.text || "").toString().slice(0, 800); } catch (e) {}
  if (!phase || !text) return { statusCode: 400, body: "phase and text required" };
  if (!process.env.HEYGEN_API_KEY) { console.log("heygen-start: not configured"); return { statusCode: 500, body: "not configured" }; }

  const avatarId = process.env.HEYGEN_AVATAR_ID || "bb645f6e5a1b4407bc002967034f65e8";
  const voiceId  = process.env.HEYGEN_VOICE_ID  || "BsUnRAi8Bqeb462fyAqb";
  const cbBase = process.env.PUBLIC_APP_URL || "https://app.homegoinghq.com";
  const secret = process.env.HEYGEN_CALLBACK_SECRET || "";
  const callbackUrl = cbBase + "/.netlify/functions/heygen-callback" + (secret ? "?k=" + encodeURIComponent(secret) : "");

  try {
    const r = await fetch("https://api.heygen.com/v2/video/generate", {
      method: "POST",
      headers: { "X-Api-Key": process.env.HEYGEN_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        video_inputs: [{
          character: { type: "avatar", avatar_id: avatarId, avatar_style: "normal" },
          voice: { type: "text", input_text: text, voice_id: voiceId, speed: 0.95 },
          background: { type: "color", value: "#26332E" }
        }],
        dimension: { width: 1280, height: 720 },
        callback_url: callbackUrl,
        callback_id: phase
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !(j.data && j.data.video_id)) {
      console.log("heygen-start: HeyGen rejected", r.status, JSON.stringify(j).slice(0, 400));
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: "heygen start failed", detail: j }) };
    }
    console.log("heygen-start: render queued", phase, j.data.video_id);
    return { statusCode: 200, body: JSON.stringify({ ok: true, phase, video_id: j.data.video_id }) };
  } catch (err) {
    console.log("heygen-start error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
