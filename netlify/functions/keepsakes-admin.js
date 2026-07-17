// ============================================================================
// Netlify Function: keepsakes-admin
// Returns LIVE keepsake sales data (aggregates + recent orders) for the admin
// view. keepsake_orders holds buyer emails/addresses and is RLS-locked to the
// service role, so this endpoint must be gated: the caller sends their Supabase
// access token, and we verify they're an admin using YOUR existing is_admin()
// RPC (the same gate the rest of the app uses) before returning anything.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   (SUPABASE_ANON_KEY optional — falls back to the public anon key for the
//    is_admin check; the user's own JWT is what actually authorizes it.)
//
// Request (POST JSON): { token }   // Supabase access_token of the logged-in admin
// Response: { kpis, byStatus, recent[] }
// ============================================================================

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };

  const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANON = process.env.SUPABASE_ANON_KEY || KEY;
  if (!SB || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "Supabase env not set" }) };

  try {
    const { token } = JSON.parse(event.body || "{}");
    if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: "not signed in" }) };

    // ---- verify admin using the app's own is_admin() RPC, run AS the user ----
    const adminResp = await fetch(SB + "/rest/v1/rpc/is_admin", {
      method: "POST",
      headers: { apikey: ANON, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: "{}",
    });
    const isAdmin = adminResp.ok && (await adminResp.json()) === true;
    if (!isAdmin) return { statusCode: 403, headers, body: JSON.stringify({ error: "forbidden" }) };

    // ---- read orders with the service role (bypasses RLS) ----
    const sel = "id,created_at,status,buyer_email,recipient,items,retail_total,wholesale_total,margin_total,prodigi_order_id,prodigi_status,paid_at";
    const oResp = await fetch(
      SB + "/rest/v1/keepsake_orders?select=" + encodeURIComponent(sel) + "&order=created_at.desc&limit=500",
      { headers: { apikey: KEY, Authorization: "Bearer " + KEY } }
    );
    if (!oResp.ok) {
      const t = await oResp.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: "read failed", detail: t.slice(0, 300) }) };
    }
    const orders = await oResp.json();

    // "sold" = anything past pending (payment captured)
    const sold = orders.filter((o) => o.status && o.status !== "pending");
    const num = (v) => Number(v) || 0;

    const revenue = sold.reduce((s, o) => s + num(o.retail_total), 0);
    const cost = sold.reduce((s, o) => s + num(o.wholesale_total), 0);
    const margin = sold.reduce((s, o) => s + num(o.margin_total), 0);
    const now = Date.now();
    const rev30 = sold.filter((o) => o.paid_at && now - new Date(o.paid_at).getTime() < 30 * 864e5)
      .reduce((s, o) => s + num(o.retail_total), 0);

    const kpis = {
      orders_sold: sold.length,
      revenue: round(revenue),
      cost: round(cost),
      margin: round(margin),
      margin_pct: revenue ? Math.round((margin / revenue) * 100) : 0,
      avg_order: sold.length ? round(revenue / sold.length) : 0,
      revenue_30d: round(rev30),
      pending: orders.filter((o) => o.status === "pending").length,
      needs_attention: orders.filter((o) => o.status === "prodigi_error").length,
    };

    const byStatus = {};
    orders.forEach((o) => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });

    // recent orders — trimmed, no raw addresses beyond city/state
    const recent = orders.slice(0, 40).map((o) => {
      const items = Array.isArray(o.items) ? o.items : [];
      const rc = o.recipient || {};
      const addr = rc.address || {};
      return {
        id: o.id,
        created_at: o.created_at,
        status: o.status,
        prodigi_status: o.prodigi_status || null,
        prodigi_order_id: o.prodigi_order_id || null,
        buyer_email: o.buyer_email || null,
        recipient_name: rc.name || null,
        place: [addr.townOrCity, addr.stateOrCounty].filter(Boolean).join(", ") || null,
        item_summary: items.map((i) => (i.copies > 1 ? i.copies + "× " : "") + (i.name || i.sku)).join(", "),
        retail: round(num(o.retail_total)),
        margin: round(num(o.margin_total)),
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify({ kpis, byStatus, recent }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }

  function round(n) { return Math.round(n * 100) / 100; }
};
