// HomegoingHQ — admin-delete-user: fully remove a user (storage files + DB + login).
// POST { accessToken, target }
//  1) verify the caller is an admin
//  2) collect the target's estate document + memory storage paths
//  3) remove those files from storage (service role)
//  4) call admin_delete_user RPC with the admin's token (deletes estates + login),
//     which keeps the RPC's guards (no self, no other admins).
exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  const SB = process.env.SUPABASE_URL || "https://vohqgmnurnkgbwpvrakp.supabase.co";
  const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANON = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvaHFnbW51cm5rZ2J3cHZyYWtwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNjc0NTYsImV4cCI6MjA5ODk0MzQ1Nn0.fXDBbljOS_p49FS9vU4smAWxyn4STYuLRGFf9rJgp-Q";
  if (!SR) return { statusCode: 500, headers, body: JSON.stringify({ error: "not_configured" }) };
  const SRH = { apikey: SR, Authorization: "Bearer " + SR, "Content-Type": "application/json" };
  const q = async (path) => (await fetch(SB + "/rest/v1/" + path, { headers: SRH })).json();
  const removeFiles = async (bucket, paths) => {
    const uniq = [...new Set((paths || []).filter(Boolean))];
    let removed = 0;
    for (let i = 0; i < uniq.length; i += 100) {
      const chunk = uniq.slice(i, i + 100);
      const r = await fetch(SB + "/storage/v1/object/" + bucket, {
        method: "DELETE",
        headers: { apikey: SR, Authorization: "Bearer " + SR, "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: chunk })
      });
      if (r.ok) removed += chunk.length;
    }
    return removed;
  };
  try {
    const { accessToken, target } = JSON.parse(event.body || "{}");
    if (!accessToken || !target) return { statusCode: 400, headers, body: JSON.stringify({ error: "missing params" }) };

    // 1) who is calling
    const who = await fetch(SB + "/auth/v1/user", { headers: { apikey: ANON, Authorization: "Bearer " + accessToken } });
    if (!who.ok) return { statusCode: 401, headers, body: JSON.stringify({ error: "session invalid" }) };
    const caller = (await who.json()).id;
    const adminRows = await q("admin_users?select=user_id&user_id=eq." + caller);
    if (!Array.isArray(adminRows) || !adminRows.length) return { statusCode: 403, headers, body: JSON.stringify({ error: "not_admin" }) };

    // 2) collect storage paths from the target's estates (before anything is deleted)
    const estates = await q("estates?select=id&created_by=eq." + target);
    const ids = (estates || []).map(e => e.id);
    let filesRemoved = 0;
    if (ids.length) {
      const inClause = "in.(" + ids.join(",") + ")";
      const docs = await q("documents?select=storage_path&estate_id=" + encodeURIComponent(inClause));
      const mems = await q("memories?select=media_path&estate_id=" + encodeURIComponent(inClause));
      // 3) remove the files
      filesRemoved += await removeFiles("estate-docs", (docs || []).map(d => d.storage_path));
      filesRemoved += await removeFiles("memorial-media", (mems || []).map(m => m.media_path));
    }

    // 4) delete DB rows + login via the guarded RPC, as the admin (keeps is_admin/self/admin guards)
    const rpc = await fetch(SB + "/rest/v1/rpc/admin_delete_user", {
      method: "POST",
      headers: { apikey: ANON, Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ target })
    });
    const rpcData = await rpc.json();
    if (rpcData && rpcData.error) return { statusCode: 200, headers, body: JSON.stringify({ error: rpcData.error }) };

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, files_removed: filesRemoved, estates_deleted: (rpcData && rpcData.estates_deleted) || 0 }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
