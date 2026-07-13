// HomegoingHQ — Milestone avatar render STARTER (Netlify background function).
// Does only the quick work, then returns: ElevenLabs audio (your voice) -> upload
// -> tell HeyGen to render and CALL US BACK when done. No polling, so no timeout.
// HeyGen notifies /heygen-callback, which stores the finished video.
//
// Trigger: POST { phase, text }  to /.netlify/functions/heygen-generate-background
// Env: HEYGEN_API_KEY, HEYGEN_AVATAR_ID(optional), ELEVENLABS_API_KEY,
//      ELEVENLABS_VOICE_ID(optional), ELEVENLABS_MODEL(optional),
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      PUBLIC_APP_URL(optional, defaults to https://app.homegoinghq.com),
//      HEYGEN_CALLBACK_SECRET(optional shared secret for the callback)

const BUCKET = "milestone-clips";

async function elevenAudio(text) {
  const key = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
  const model = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";
  const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voice), {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true } })
  });
  if (!r.ok) throw new Error("ElevenLabs failed: " + r.status + " " + (await r.text().catch(() => "")).slice(0, 160));
  return Buffer.from(await r.arrayBuffer());
}

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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, body: "" };
  let phase = "", text = "";
  try { const b = JSON.parse(event.body || "{}"); phase = (b.phase || "").trim(); text = (b.text || "").toString().slice(0, 800); } catch (e) {}
  if (!phase || !text) return { statusCode: 400, body: "phase and text required" };
  if (!process.env.HEYGEN_API_KEY || !process.env.ELEVENLABS_API_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("heygen-start: not configured"); return { statusCode: 500, body: "not configured" };
  }
  const avatarId = process.env.HEYGEN_AVATAR_ID || "bb645f6e5a1b4407bc002967034f65e8";
  const cbBase = process.env.PUBLIC_APP_URL || "https://app.homegoinghq.com";
  const secret = process.env.HEYGEN_CALLBACK_SECRET || "";
  const callbackUrl = cbBase + "/.netlify/functions/heygen-callback" + (secret ? "?k=" + encodeURIComponent(secret) : "");

  try {
    const audio = await elevenAudio(text);
    const audioUrl = await sbUpload("audio/" + phase + "-" + Date.now() + ".mp3", audio, "audio/mpeg");
    console.log("heygen-start: audio ready for", phase, audioUrl);

    const r = await fetch("https://api.heygen.com/v2/video/generate", {
      method: "POST",
      headers: { "X-Api-Key": process.env.HEYGEN_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        video_inputs: [{
          character: { type: "avatar", avatar_id: avatarId, avatar_style: "normal" },
          voice: { type: "audio", audio_url: audioUrl },
          background: { type: "color", value: "#26332E" }
        }],
        dimension: { width: 1280, height: 720 },
        callback_url: callbackUrl,
        callback_id: phase
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !(j.data && j.data.video_id)) {
      console.log("heygen-start: HeyGen rejected", r.status, JSON.stringify(j).slice(0, 300));
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: "heygen start failed", detail: j }) };
    }
    console.log("heygen-start: render queued", phase, j.data.video_id);
    return { statusCode: 200, body: JSON.stringify({ ok: true, phase, video_id: j.data.video_id }) };
  } catch (err) {
    console.log("heygen-start error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
