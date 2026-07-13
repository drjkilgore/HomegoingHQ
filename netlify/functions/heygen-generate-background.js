// HomegoingHQ — Milestone avatar renderer (Netlify BACKGROUND function, up to 15 min).
// Flow: text -> ElevenLabs audio (your voice) -> HeyGen avatar lip-syncs to it
//       -> store MP4 in Supabase -> save clip_url on the milestone.
// Trigger: POST { phase, text }  to /.netlify/functions/heygen-generate-background
// Because it's a *background* function it returns 202 immediately; the admin UI
// polls app_messages and the clip appears when rendering finishes.
//
// Env vars (app.homegoinghq.com site):
//   HEYGEN_API_KEY        (required)
//   HEYGEN_AVATAR_ID      (optional — defaults to the provided avatar)
//   ELEVENLABS_API_KEY    (required — already set)
//   ELEVENLABS_VOICE_ID   (optional — your voice; defaults to Rachel)
//   ELEVENLABS_MODEL      (optional — defaults to eleven_multilingual_v2 for lip-sync quality)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (already set)

const BUCKET = "milestone-clips";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function sbSetClip(phase, clipUrl) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  await fetch(base + "/rest/v1/app_messages?kind=eq.milestone&phase=eq." + encodeURIComponent(phase), {
    method: "PATCH",
    headers: { "Authorization": "Bearer " + key, "apikey": key, "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify({ clip_url: clipUrl })
  });
}

async function heygenStart(avatarId, audioUrl) {
  const key = process.env.HEYGEN_API_KEY;
  const r = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST",
    headers: { "X-Api-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      video_inputs: [{
        character: { type: "avatar", avatar_id: avatarId, avatar_style: "normal" },
        voice: { type: "audio", audio_url: audioUrl },
        background: { type: "color", value: "#26332E" }
      }],
      dimension: { width: 1280, height: 720 }
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !(j.data && j.data.video_id)) throw new Error("HeyGen start failed: " + r.status + " " + JSON.stringify(j).slice(0, 200));
  return j.data.video_id;
}

async function heygenWait(videoId) {
  const key = process.env.HEYGEN_API_KEY;
  for (let i = 0; i < 80; i++) {              // ~13 min max (80 * 10s)
    await sleep(10000);
    const r = await fetch("https://api.heygen.com/v1/video_status.get?video_id=" + videoId, { headers: { "X-Api-Key": key } });
    const j = await r.json().catch(() => ({}));
    const st = j && j.data && j.data.status;
    if (st === "completed") return j.data.video_url;
    if (st === "failed") throw new Error("HeyGen render failed: " + JSON.stringify(j.data && j.data.error || {}).slice(0, 200));
  }
  throw new Error("HeyGen render timed out");
}

exports.handler = async (event) => {
  // Background functions still receive the request; validate then do the long work.
  let phase = "", text = "";
  try { const b = JSON.parse(event.body || "{}"); phase = (b.phase || "").trim(); text = (b.text || "").toString().slice(0, 800); } catch {}
  if (!phase || !text) return { statusCode: 400, body: "phase and text required" };
  if (!process.env.HEYGEN_API_KEY || !process.env.ELEVENLABS_API_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: "not configured" };
  }
  const avatarId = process.env.HEYGEN_AVATAR_ID || "bb645f6e5a1b4407bc002967034f65e8";

  try {
    const stamp = Date.now();
    // 1) ElevenLabs audio in your voice
    const audio = await elevenAudio(text);
    const audioUrl = await sbUpload("audio/" + phase + "-" + stamp + ".mp3", audio, "audio/mpeg");
    // 2) HeyGen renders the avatar speaking that audio
    const videoId = await heygenStart(avatarId, audioUrl);
    const heygenUrl = await heygenWait(videoId);
    // 3) Store the finished MP4 in Supabase and save it on the milestone
    const vidResp = await fetch(heygenUrl);
    const vidBuf = Buffer.from(await vidResp.arrayBuffer());
    const publicUrl = await sbUpload(phase + ".mp4", vidBuf, "video/mp4");
    await sbSetClip(phase, publicUrl);
    return { statusCode: 200, body: JSON.stringify({ ok: true, phase, clip_url: publicUrl }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, phase, error: err.message }) };
  }
};
