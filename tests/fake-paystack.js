// A stand-in for Paystack's API (api.paystack.co) and its hosted checkout, for the tests. Nothing here talks to Paystack.
// startFakePaystack({ secret }) resolves { url, calls, txs, subs, refunds, mode, setApp(base), hook(event, data, opts), close }.
// - GET /bank, POST/PUT /subaccount, POST /transaction/initialize, GET /transaction/verify/:ref, POST /transaction/charge_authorization,
//   POST /refund: as Paystack's docs describe them (Bearer secret key, JSON, amounts in cents).
// - GET /checkout/:code: a checkout page with Pay and Cancel buttons. Pay marks the transaction a success, sends Paystack's signed
//   charge.success webhook to the app (setApp) and returns to the callback_url with trxref and reference, as Paystack does.
// mode: { authorization code: "fail" | "down" | "pending" } for saved-card charges; tweak(ref, fn): change what verify will say.
"use strict";
const http = require("http"); const crypto = require("crypto");
function startFakePaystack({ secret }) {
  const calls = [], txs = new Map(), subs = new Map(), refunds = [], mode = {}, auths = new Map();
  let app = "", n = 0, hookWait = Promise.resolve();
  const send = (rs, code, body, type = "application/json") => { rs.writeHead(code, { "content-type": type }); rs.end(typeof body === "string" ? body : JSON.stringify(body)); };
  const ok = (rs, data, message = "OK") => send(rs, 200, { status: true, message, data });
  const no = (rs, code, message) => send(rs, code, { status: false, message });
  const sign = (raw) => crypto.createHmac("sha512", secret).update(raw).digest("hex");
  // Sends a webhook to the app, signed (or not: opts.sig false, or a given wrong one). Resolves with the app's HTTP status.
  async function hook(event, data, opts = {}) {
    const raw = Buffer.from(JSON.stringify({ event, data }));
    const headers = { "content-type": "application/json" };
    if (opts.sig !== false) headers["x-paystack-signature"] = typeof opts.sig === "string" ? opts.sig : sign(raw);
    const r = await fetch(app + "/api/paystack/webhook", { method: "POST", headers, body: raw });
    return r.status;
  }
  const verifyData = (t) => ({ id: t.id, domain: t.domain || "live", status: t.status, reference: t.reference, amount: t.amount, currency: t.currency, gateway_response: t.gateway_response || (t.status === "success" ? "Successful" : "Declined"),
    channel: t.channel || "card", fees: t.fees, metadata: t.metadata, customer: { email: t.email }, subaccount: t.subaccount ? { subaccount_code: t.subaccount } : null,
    authorization: t.status === "success" ? t.authorization : {}, paid_at: t.paid_at || null });
  const srv = http.createServer((rq, rs) => { const chunks = []; rq.on("data", (c) => chunks.push(c)); rq.on("end", async () => {
    const u = new URL(rq.url, "http://x"), raw = Buffer.concat(chunks).toString(); let body = {}; try { body = raw && /json/.test(rq.headers["content-type"] || "") ? JSON.parse(raw) : {}; } catch (e) {}
    const p = u.pathname;
    // the checkout pages the member sees (no key needed: it's a browser page)
    let m = p.match(/^\/checkout\/([\w-]+)(\/(pay|cancel))?$/);
    if (m) {
      const t = [...txs.values()].find((x) => x.access_code === m[1]); if (!t) return send(rs, 404, "No such checkout", "text/plain");
      if (!m[2]) return send(rs, 200, `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Paystack checkout</title></head><body style="font-family:sans-serif;padding:20px">
        <h1>Pay R${(t.amount / 100).toFixed(2)}</h1><p id="email">${t.email}</p><p id="channels">${(t.channels || ["card", "apple_pay", "capitec_pay", "eft"]).join(", ")}</p>
        <form method="post" action="/checkout/${t.access_code}/pay"><button id="pay" type="submit">Pay</button></form><form method="post" action="/checkout/${t.access_code}/cancel"><button id="cancel" type="submit">Cancel</button></form></body></html>`, "text/html");
      if (m[3] === "cancel") { t.status = "abandoned"; rs.writeHead(302, { location: t.callback_url.split("?")[0] }); return rs.end(); }
      t.status = "success"; t.paid_at = new Date().toISOString(); t.fees = Math.round(t.amount * 0.029) + 100; t.channel = "card";
      const code = "AUTH_" + (++n).toString(36) + crypto.randomBytes(3).toString("hex");
      t.authorization = { authorization_code: code, reusable: true, last4: "4081", brand: "visa", card_type: "visa", exp_month: "12", exp_year: "2030", channel: "card", bank: "TEST BANK" };
      auths.set(code, { email: t.email });
      hookWait = hook("charge.success", verifyData(t)).catch(() => {});
      await hookWait;
      rs.writeHead(302, { location: t.callback_url + (t.callback_url.includes("?") ? "&" : "?") + `trxref=${t.reference}&reference=${t.reference}` }); return rs.end();
    }
    const auth = rq.headers.authorization === "Bearer " + secret;
    calls.push({ method: rq.method, path: p, query: Object.fromEntries(u.searchParams), body, auth });
    if (!auth) return no(rs, 401, "Invalid key");
    if (rq.method === "GET" && p === "/bank") return ok(rs, [{ id: 1, name: "Capitec Bank", code: "470010", active: true, is_deleted: false }, { id: 2, name: "First National Bank", code: "250655", active: true },
      { id: 3, name: "Absa Bank", code: "632005", active: true }, { id: 4, name: "Gone Bank", code: "999999", active: false }, { id: 5, name: "Standard Bank", code: "051001", active: true, country: "South Africa", currency: "ZAR" },
      { id: 6, name: "Access Bank", code: "044", active: true, country: "Nigeria", currency: "NGN" }, { id: 7, name: "GCB Bank", code: "040100", active: true, country: "Ghana", currency: "GHS" }]);
    if (rq.method === "POST" && p === "/subaccount") {
      if (body.account_number === "0000000000") return no(rs, 400, "Account details are invalid");
      const code = "ACCT_" + crypto.randomBytes(5).toString("hex"); subs.set(code, { ...body, subaccount_code: code }); return ok(rs, { subaccount_code: code, ...body }, "Subaccount created");
    }
    if ((m = p.match(/^\/subaccount\/(ACCT_\w+)$/)) && rq.method === "PUT") { if (!subs.has(m[1])) return no(rs, 404, "Subaccount not found"); subs.set(m[1], { ...subs.get(m[1]), ...body }); return ok(rs, subs.get(m[1]), "Subaccount updated"); }
    if (rq.method === "POST" && p === "/transaction/initialize") {
      if (txs.has(body.reference)) return no(rs, 400, "Duplicate Transaction Reference");
      const access = "ac" + crypto.randomBytes(6).toString("hex");
      txs.set(body.reference, { id: ++n, ...body, access_code: access, status: "abandoned", fees: 0 });
      return ok(rs, { authorization_url: `${base()}/checkout/${access}`, access_code: access, reference: body.reference }, "Authorization URL created");
    }
    if ((m = p.match(/^\/transaction\/verify\/(.+)$/))) { const t = txs.get(decodeURIComponent(m[1])); if (!t) return no(rs, 400, "Transaction reference not found"); return ok(rs, verifyData(t.over ? { ...t, ...t.over } : t), "Verification successful"); }
    if (rq.method === "POST" && p === "/transaction/charge_authorization") {
      const md = mode[body.authorization_code], a = auths.get(body.authorization_code);
      if (md === "down") return send(rs, 502, "bad gateway", "text/plain");
      if (!a) return no(rs, 400, "Invalid authorization code");
      if (a.email !== body.email) return no(rs, 400, "Authorization does not belong to this customer");
      const t = { id: ++n, ...body, access_code: "", status: md === "fail" ? "failed" : md === "pending" ? "pending" : "success", gateway_response: md === "fail" ? "Insufficient Funds" : "Approved", fees: Math.round(body.amount * 0.029),
        authorization: { authorization_code: body.authorization_code, reusable: true, last4: "4081", brand: "visa" }, channel: "card" };
      txs.set(body.reference, t);
      return ok(rs, verifyData(t), "Charge attempted");
    }
    if (rq.method === "POST" && p === "/refund") {
      const t = txs.get(body.transaction); if (!t || t.status !== "success") return no(rs, 400, "Transaction not found or not successful");
      const r = { id: 9000 + refunds.length + 1, transaction: { reference: t.reference, amount: t.amount }, amount: body.amount || t.amount, currency: "ZAR", status: "pending" }; refunds.push(r);
      return ok(rs, r, "Refund has been queued for processing");
    }
    return no(rs, 404, "Not found");
  }); });
  const base = () => `http://127.0.0.1:${srv.address().port}`;
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res({ get url() { return base(); }, calls, txs, subs, refunds, mode, auths, hook, sign,
    tweak: (ref, over) => { const t = txs.get(ref); if (t) t.over = { ...(t.over || {}), ...over }; },
    succeed: (ref) => { const t = txs.get(ref); t.status = "success"; t.fees = Math.round(t.amount * 0.029) + 100; t.authorization = { authorization_code: "AUTH_s" + t.id, reusable: true, last4: "1111", brand: "mastercard", channel: "card" }; auths.set("AUTH_s" + t.id, { email: t.email }); return verifyData(t); },
    verifyData, setApp: (b) => { app = b; }, close: () => srv.close() })));
}
module.exports = { startFakePaystack };
