// ============================================================================
// Netlify Function: flower-api
// Server-side proxy to the Florist One API. Injects HTTP Basic auth (your API
// key + password) so the credentials NEVER reach the browser. Grounded in
// Florist One's documented REST API (base .../api/rest/flowershop/) and their
// official client.
//
// Dependency-free (matches your other functions): global fetch + built-ins only.
//
// Env vars:
//   FLORISTONE_API_KEY        your Florist One API key   (Basic-auth username)
//   FLORISTONE_API_PASSWORD   your Florist One password  (Basic-auth password)
//   (both are shown on floristone.com/api/technical-information once signed in)
//
// Request (POST JSON): { action, ...params }
//   action "products"     { category, count?, start?, sorttype? }  -> browse catalog
//   action "product"      { code }                                 -> one product
//   action "deliverydate" { zipcode }                              -> valid delivery dates
//   action "total"        { products }                             -> price a selection
//   action "placeorder"   { customer, products, payment, ordertotal, allowsubstitutions? }
//   action "orderinfo"    { orderno }                              -> order status
//
// PAYMENT NOTE: Florist One's classic placeorder accepts card details in the
// order body. You almost certainly do NOT want to pass raw card data through
// your server (PCI scope). Prefer their tokenized/Stripe payment path and
// confirm the exact placeorder payment field against your authenticated docs.
// This proxy passes whatever you send in `payment` straight through as-is, so it
// works with either shape once you confirm it.
// ============================================================================

const BASE = process.env.FLORISTONE_BASE || "https://www.floristone.com/api/rest/flowershop/";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const key = process.env.FLORISTONE_API_KEY, pw = process.env.FLORISTONE_API_PASSWORD;
  if (!key || !pw) return json(500, { error: "FLORISTONE_API_KEY / FLORISTONE_API_PASSWORD not set" });
  const authHeader = "Basic " + Buffer.from(`${key}:${pw}`).toString("base64");

  try {
    const b = JSON.parse(event.body || "{}");
    let url, method = "GET", payload = null;

    switch (b.action) {
      case "products": {
        const p = new URLSearchParams({ category: b.category || "", count: String(b.count || 12), start: String(b.start || 1) });
        if (b.sorttype) p.set("sorttype", b.sorttype);
        url = BASE + "getproducts?" + p.toString();
        break;
      }
      case "product":
        url = BASE + "getproducts?code=" + encodeURIComponent(b.code || "");
        break;
      case "deliverydate":
        url = BASE + "checkdeliverydate?zipcode=" + encodeURIComponent(b.zipcode || "");
        break;
      case "total":
        // gettotal accepts the selection as a query string (per Florist One samples)
        url = BASE + "gettotal?products=" + encodeURIComponent(typeof b.products === "string" ? b.products : JSON.stringify(b.products || []));
        break;
      case "orderinfo":
        url = BASE + "getorderinfo?orderno=" + encodeURIComponent(String(b.orderno || ""));
        break;
      case "placeorder":
        url = BASE + "placeorder";
        method = "POST";
        payload = JSON.stringify({
          customer: b.customer,
          products: b.products,
          ccinfo: b.payment,            // confirm this field name for the token flow
          ordertotal: b.ordertotal,
          allowsubstitutions: b.allowsubstitutions,
        });
        break;
      default:
        return json(400, { error: "unknown action: " + b.action });
    }

    const resp = await fetch(url, {
      method,
      headers: { "Authorization": authHeader, ...(payload ? { "Content-Type": "application/json" } : {}) },
      body: payload,
    });
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 600) }; }
    if (!resp.ok) return json(502, { error: "floristone " + resp.status, detail: data });
    return json(200, data);
  } catch (e) {
    return json(500, { error: String((e && e.message) || e) });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
