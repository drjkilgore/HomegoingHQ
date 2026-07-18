// HomegoingHQ — Vault sweep (Netlify Scheduled Function; see netlify.toml)
// Runs daily. Deletes the vault documents of lapsed Vault Keeper subscribers
// (status canceled/past_due) whose 45-day grace window (vault_grace_until) has
// expired. Paid-settlement estates (companion/settle/premium) are skipped —
// their vault is unlimited regardless of the vault subscription. Idempotent:
// anything left over is retried on the next run.
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
exports.handler = async () => {
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !KEY) return { statusCode: 200, body: "sweep skipped: not configured" };
  const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };
  const nowISO = new Date().toISOString();
  const PAID = ["companion", "settle", "premium"];

  // 1) Lapsed subscribers past their grace deadline
  const expired = await (await fetch(
    `${URL}/rest/v1/profiles?select=id&vault_status=in.(canceled,past_due)&vault_grace_until=lt.${encodeURIComponent(nowISO)}`,
    { headers: H }
  )).json();
  if (!Array.isArray(expired) || !expired.length) return { statusCode: 200, body: "sweep: nothing due" };

  let users = 0, filesDeleted = 0;
  for (const p of expired) {
    try {
      // 2) Their estates (vault owner = estates.created_by); skip paid-settlement estates
      const estates = await (await fetch(
        `${URL}/rest/v1/estates?created_by=eq.${p.id}&select=id,tier`, { headers: H }
      )).json();
      const freeIds = (Array.isArray(estates) ? estates : [])
        .filter(e => !PAID.includes((e.tier || "free")))
        .map(e => e.id);

      if (freeIds.length) {
        const inList = "(" + freeIds.map(encodeURIComponent).join(",") + ")";

        // 3) Collect storage paths, then remove the objects from the bucket
        const docs = await (await fetch(
          `${URL}/rest/v1/documents?estate_id=in.${inList}&select=storage_path`, { headers: H }
        )).json();
        const paths = (Array.isArray(docs) ? docs : []).map(d => d.storage_path).filter(Boolean);
        if (paths.length) {
          await fetch(`${URL}/storage/v1/object/estate-docs`, {
            method: "DELETE", headers: H, body: JSON.stringify({ prefixes: paths })
          });
          filesDeleted += paths.length;
        }

        // 4) Delete the document rows
        await fetch(`${URL}/rest/v1/documents?estate_id=in.${inList}`, {
          method: "DELETE", headers: { ...H, Prefer: "return=minimal" }
        });
      }

      // 5) Settle the profile back to inactive so it isn't swept again
      await fetch(`${URL}/rest/v1/profiles?id=eq.${p.id}`, {
        method: "PATCH", headers: { ...H, Prefer: "return=minimal" },
        body: JSON.stringify({ vault_status: "inactive", vault_grace_until: null })
      });
      users++;
    } catch (e) { /* best-effort; the next run retries anything left */ }
  }
  return { statusCode: 200, body: `sweep: ${users} users, ${filesDeleted} files removed` };
};
