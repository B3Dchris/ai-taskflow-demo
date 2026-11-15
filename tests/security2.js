// Security regressions, third batch, against a real PostgreSQL with PayFast and Resend stood in for (nothing external is contacted):
// the JitsFlow plan's PayFast subscription (cancelled when the gym goes or the head coach cancels, its amount following the gym's
// price, payments for another amount flagged), members' saved cards cancelled with the gym, cancels retried and surfaced, card
// checkouts checked against their notifications, a passphrase for live PayFast accounts, sign-ups with an email a coach added,
// stop links on fee reminders, session lifetime and "sign out everywhere", data retention, and reads that don't write.
// (The assistant's confirm cards and untrusted data are in tests/assistant.js.)
// Usage: DATABASE_URL=postgres://.../<something>test node tests/security2.js   (wipes that database)
"use strict";
const { spawn } = require("child_process"); const path = require("path"); const http = require("http"); const crypto = require("crypto"); const { Pool } = require("pg");
const { startMailSink } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const enc = (v) => encodeURIComponent(String(v).trim()).replace(/%20/g, "+");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const itn = (fields, pw) => { const s = Object.entries(fields).map(([k, v]) => `${k}=${enc(v)}`).join("&"); return s + "&signature=" + md5(s + (pw ? `&passphrase=${enc(pw)}` : "")); };
const GYM_PASS = "gym pass phrase";
let ipN = 1;
function client(base) {
  let cookie = ""; const ip = `198.51.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
  const c = async (method, url, body, headers = {}) => {
    const h = { "x-forwarded-for": ip, ...headers }; if (cookie) h.cookie = cookie; if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; }
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = m[1] ? "jf_s=" + m[1] : ""; }
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { s: r.status, j, t, h: r.headers };
  };
  c.cookie = () => cookie;
  return c;
}

(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop schema public cascade; create schema public");
  const sink = await startMailSink();
  // PayFast, stood in for: notifications are confirmed; the API records each call (cancel, update, pause, unpause, adhoc), checks its
  // signature against the passphrase it was made with, and answers by token: ok (default), fail (an error), gone (404).
  const calls = [], mode = {};
  const pf = http.createServer((rq, rs) => { let b = ""; rq.on("data", (c) => (b += c)); rq.on("end", () => {
    const u = new URL(rq.url, "http://x");
    if (u.pathname === "/eng/query/validate") return rs.end("VALID");
    const m = u.pathname.match(/^\/subscriptions\/([^/]+)\/(adhoc|cancel|update|pause|unpause)$/); if (!m) { rs.writeHead(404); return rs.end("{}"); }
    const body = b ? JSON.parse(b) : {}, hd = { "merchant-id": rq.headers["merchant-id"], version: rq.headers.version, timestamp: rq.headers.timestamp };
    const signedWith = (pw) => { const all = { ...hd, ...body, ...(pw ? { passphrase: pw } : {}) }; return rq.headers.signature === md5(Object.keys(all).sort().filter((k) => all[k] !== "" && all[k] != null).map((k) => `${k}=${enc(all[k])}`).join("&")); };
    const call = { token: decodeURIComponent(m[1]), what: m[2], method: rq.method, body, merchant: hd["merchant-id"], testing: u.searchParams.get("testing"), signedWith }; calls.push(call);
    const md = mode[call.token] || "ok";
    if (md === "fail") { rs.writeHead(400, { "content-type": "application/json" }); return rs.end(JSON.stringify({ code: 400, status: "failed", data: { response: false, message: "Failure" } })); }
    if (md === "gone") { rs.writeHead(404, { "content-type": "application/json" }); return rs.end(JSON.stringify({ code: 404, status: "failed", data: { message: "Subscription not found" } })); }
    rs.writeHead(200, { "content-type": "application/json" }); rs.end(JSON.stringify({ code: 200, status: "success", data: { response: true, message: "Success" } }));
  }); }).listen(0);
  const PF = `http://127.0.0.1:${pf.address().port}`;
  const port = 9700 + Math.floor(Math.random() * 90), base = `http://127.0.0.1:${port}/api`;
  const common = { DATABASE_URL: DB, RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, APP_URL: "https://www.jitsflow.test", MAIL_GAP_MS: "0", JF_ADMIN_EMAILS: "boss@jf3.test",
    PAYFAST_VALIDATE_URL: PF + "/eng/query/validate", PAYFAST_API_URL: PF, PAYFAST_AUTOPAY_TEST: "1", TRUST_PROXY: "1" };
  const env = { ...process.env, ...common, PORT: String(port) }; for (const k of ["ANTHROPIC_API_KEY", "PAYFAST_MERCHANT_ID", "JF_SECRET", "JF_SECRET_OLD", "NODE_ENV", "GA_ID"]) delete env[k];
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch (e) { await wait(150); } }
  await wait(300);
  // The scheduled jobs, run here the way server.js runs them.
  Object.assign(process.env, common); for (const k of ["PAYFAST_MERCHANT_ID", "JF_SECRET", "JF_SECRET_OLD"]) delete process.env[k];
  const { makeApi } = require("../backend/api"), pfm = require("../backend/payfast"), { purgeRejected } = require("../backend/db");
  const jobs = makeApi(pool, {}).jobs;
  const to = (addr, from = 0) => sink.mails.slice(from).filter((m) => (m.to || [])[0] === addr);
  const notify = async (fields, pw) => { await fetch(base + "/payfast/notify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: itn(fields, pw) }); await wait(600); };
  let pfn = 5000;
  const planItn = (gymId, f) => notify({ m_payment_id: f.mid || `sub-${gymId}-1`, pf_payment_id: String(++pfn), payment_status: f.status || "COMPLETE", item_name: "JitsFlow monthly plan",
    amount_gross: f.gross || "0.00", custom_str1: "sub", custom_int1: String(gymId), token: f.token, merchant_id: pfm.TEST.id }, pfm.TEST.pass);
  const cardItn = (gymId, uid, tok) => notify({ m_payment_id: `card-${uid}-1`, pf_payment_id: String(++pfn), payment_status: "COMPLETE", item_name: "fees", amount_gross: "0.00", custom_str1: "card",
    custom_int1: String(uid), custom_int2: String(gymId), custom_int3: String(uid), token: tok, merchant_id: "10000105" }, GYM_PASS);
  const billing = async (gymId) => ((await pool.query("select billing from gyms where id=$1", [gymId])).rows[0] || {}).billing;
  const of = (tok, what) => calls.filter((c) => c.token === tok && (!what || c.what === what));
  const verify = (email) => pool.query("update users set email_verified_at=now(), email_verified_for=email where email=$1", [email]);
  let n = 0;
  const gymOn = async (k) => { const c = client(base), r = await c("POST", "/auth/start-gym", { gym: `${k} BJJ`, name: `Coach ${k}`, email: `coach-${k.toLowerCase()}@jf3.test`, password: "coachpass1", timezone: "Africa/Johannesburg" });
    if (r.s !== 201) throw new Error("start-gym " + r.s + " " + r.t); c.gym = r.j.me.gym; c.id = r.j.me.id; c.email = `coach-${k.toLowerCase()}@jf3.test`; await verify(c.email); return c; };
  const studentOf = async (coach, k) => { const c = client(base), r = await c("POST", "/auth/register", { code: coach.gym.studentCode, name: `${k} Student`, email: `${k.toLowerCase()}${++n}@jf3.test`, password: "studentpass1" });
    if (r.s !== 201) throw new Error("register " + r.s + " " + r.t); c.id = r.j.me.id; return c; };
  const ADMIN = client(base); await ADMIN("POST", "/auth/register", { name: "Boss", email: "boss@jf3.test", password: "bosspass12" }); await verify("boss@jf3.test");
  let r, m0;

  try {
    // ---------- 1. The JitsFlow plan: reading it writes nothing; a card is set up, replaced, and its payments checked ----------
    {
      const A = await gymOn("Alpha"), gA = A.gym.id;
      r = await A("GET", "/coach/billing"); ok(r.s === 200 && r.j.billing.trialEnds && !(await billing(gA)).trialEnds, "GET /coach/billing works it out without writing the free months' end");
      r = await A("GET", "/coach/gym/pay"); const tok0 = (await pool.query("select pop_token from gyms where id=$1", [gA])).rows[0].pop_token;
      ok(tok0 && r.j.popAddress === `pop-${tok0}@jitsflow.com`, "a new gym has its proof-of-payment address from the start (reading Money settings doesn't make it)");
      await pool.query("update gyms set pop_token=null where id=$1", [gA]); r = await A("GET", "/coach/gym/pay"); const tok1 = (await pool.query("select pop_token from gyms where id=$1", [gA])).rows[0].pop_token;
      ok(tok1 && r.j.popAddress.includes(tok1) && (await A("GET", "/coach/gym/pay")).j.popAddress.includes(tok1), "a gym from before that gets one once, then it stays");
      r = await A("POST", "/coach/billing/checkout", {}); const mid1 = r.j.fields.m_payment_id;
      ok(r.s === 200 && (await billing(gA)).trialEnds && (await billing(gA)).checkout.id === mid1 && (await billing(gA)).checkout.cents === 9900, "adding a card (a POST) saves the free months' end and what the subscription charges");
      await planItn(gA, { mid: mid1, token: "plan-a1" }); let b = await billing(gA);
      ok(b.status === "active" && b.token === "plan-a1" && b.subCents === 9900 && !of("plan-a1").length, "the card is on, at R99, and PayFast isn't asked to change anything");
      r = await A("POST", "/coach/billing/checkout", {}); await planItn(gA, { mid: r.j.fields.m_payment_id, token: "plan-a2" }); await wait(300);
      const c1 = of("plan-a1", "cancel")[0];
      ok((await billing(gA)).token === "plan-a2" && c1 && c1.method === "PUT" && c1.merchant === pfm.TEST.id && c1.testing === "true" && c1.signedWith(pfm.TEST.pass), "a new card replaces the old one, which is cancelled with PayFast (JitsFlow's own keys, signed): " + JSON.stringify(c1 && { m: c1.merchant, t: c1.testing }));
      // monthly payments: the price is fine; another amount is flagged, not taken as paid in full
      await planItn(gA, { token: "plan-a2", gross: "99.00" }); b = await billing(gA);
      ok(b.lastPaidCents === 9900 && !b.mismatch && !(await pool.query("select 1 from payfast_flags where gym_id=$1", [gA])).rows[0], "a R99 payment for a R99 plan: paid");
      m0 = sink.mails.length; await planItn(gA, { token: "plan-a2", gross: "10.00" }); b = await billing(gA); await wait(300);
      const fl = (await pool.query("select * from payfast_flags where gym_id=$1", [gA])).rows[0];
      ok(b.mismatch && b.mismatch.gotCents === 1000 && b.mismatch.wantCents === 9900 && fl && fl.kind === "plan-amount" && fl.got_cents === 1000 && fl.expected_cents === 9900, "a R10 payment on a R99 plan is recorded as R10 and flagged: " + JSON.stringify(b.mismatch));
      ok(to("boss@jf3.test", m0).some((m) => /Check a PayFast payment for Alpha BJJ/.test(m.subject) && /R10/.test(m.text) && /R99/.test(m.text)), "the team is emailed");
      r = await ADMIN("GET", "/admin/overview"); const ga = r.j.gyms.find((g) => g.id === String(gA) || g.name === "Alpha BJJ"), ff = r.j.system.payfastFlags.find((f) => f.gym === "Alpha BJJ");
      ok(ga && ga.billing.mismatch && ga.billing.mismatch.gotCents === 1000 && ff && /R10/.test(ff.note), "and the dashboard shows it, on the gym and under Needs attention");
      r = await ADMIN("POST", `/admin/payfast/flag/${ff.id}/seen`, {}); ok(r.s === 200 && !(await ADMIN("GET", "/admin/overview")).j.system.payfastFlags.some((f) => f.id === ff.id), "Done takes it off");
      ok((await A("POST", `/admin/payfast/flag/${ff.id}/seen`, {})).s === 403, "(only the team can)");
      // a payment on the replaced card (before its cancel went through): the plan keeps its new card; the old one is cancelled again, and flagged
      const oc = of("plan-a1", "cancel").length; await planItn(gA, { token: "plan-a1", gross: "99.00" }); await wait(300);
      ok((await billing(gA)).token === "plan-a2" && of("plan-a1", "cancel").length === oc + 1 && (await pool.query("select 1 from payfast_flags where gym_id=$1 and kind='plan-old-card'", [gA])).rows[0], "a payment on the replaced card doesn't bring it back: it's cancelled again and the team checks it");

      // ---------- 2. The amount follows the gym's price: beta accepted (free: paused), its free months ending, leaving, a fee change ----------
      await A("POST", "/coach/beta", { action: "apply", note: "keen" });
      r = await ADMIN("PATCH", `/admin/gyms/${gA}/beta`, { action: "accept" }); await wait(500); b = await billing(gA);
      const pz = of("plan-a2", "pause")[0];
      ok(r.s === 200 && pz && pz.body.cycles >= 6 && pz.body.cycles <= 8 && pz.signedWith(pfm.TEST.pass) && b.paused === true, "accepted into the beta (free for 6 months): the subscription is paused at PayFast, not cancelled: " + JSON.stringify(pz && pz.body));
      ok((await jobs.syncPlans()) === 0 && of("plan-a2", "pause").length === 1, "and the jobs leave it be");
      // the free months end (feeUntil comes): unpaused, at R49
      const bt = (await pool.query("select beta from gyms where id=$1", [gA])).rows[0].beta;
      await pool.query("update gyms set beta=$2 where id=$1", [gA, { ...bt, feeUntil: new Date(Date.now() - 864e5).toISOString().slice(0, 10) }]);
      await jobs.syncPlans(); b = await billing(gA);
      ok(of("plan-a2", "unpause").length === 1 && of("plan-a2", "update").some((c) => c.body.amount === 4900 && c.method === "PATCH") && b.subCents === 4900 && b.paused === false, "on the day the free months end, the job unpauses it at R49");
      await A("POST", "/coach/beta", { action: "leave" }); await wait(500);
      ok(of("plan-a2", "update").some((c) => c.body.amount === 9900) && (await billing(gA)).subCents === 9900, "leaving the beta: back to R99 at PayFast");
      // PayFast says no: tried again an hour on; the 8th time the team hears
      mode["plan-a2"] = "fail";
      await ADMIN("PATCH", `/admin/gyms/${gA}/beta`, { action: "accept", feeCents: 2500 }); await wait(500); b = await billing(gA);
      ok(b.subCents === 9900 && b.syncTries === 1 && /update: PayFast 400/.test(b.syncError) && Date.parse(b.syncAfter) > Date.now() + 50 * 60e3, "a fee change PayFast refuses is kept to try again in an hour: " + JSON.stringify(b.syncError));
      const u0 = of("plan-a2", "update").length; await jobs.syncPlans(); ok(of("plan-a2", "update").length === u0, "(not before)");
      await pool.query("update gyms set billing = billing || $2 where id=$1", [gA, { syncTries: 7, syncAfter: new Date(Date.now() - 1000).toISOString() }]);
      m0 = sink.mails.length; await jobs.syncPlans(); await wait(300);
      ok(to("boss@jf3.test", m0).some((m) => /PayFast needs a hand: change Alpha BJJ's JitsFlow plan to R25/.test(m.subject)) && (await ADMIN("GET", "/admin/overview")).j.system.planSync.some((g) => g.name === "Alpha BJJ"), "after 8 tries the team is told, and the dashboard lists it");
      mode["plan-a2"] = "ok"; await pool.query("update gyms set billing = billing - 'syncAfter' where id=$1", [gA]); await jobs.syncPlans(); b = await billing(gA);
      ok(b.subCents === 2500 && !b.syncError && !b.syncTries, "once PayFast takes it, R25 it is, and the error clears");

      // ---------- 3. The head coach cancels ----------
      const co2 = client(base); await co2("POST", "/auth/register", { code: A.gym.coachCode, name: "Other Coach", email: "other-coach@jf3.test", password: "coachpass2" });
      ok((await co2("DELETE", "/coach/billing")).s === 403, "only the head coach can cancel the plan");
      r = await A("DELETE", "/coach/billing"); b = await billing(gA); await wait(300);
      ok(r.s === 200 && of("plan-a2", "cancel").length === 1 && b.status === "cancelled" && !b.token && (await A("GET", "/coach/billing")).j.billing.card === false, "Cancel plan: cancelled with PayFast; the plan shows cancelled, no card");
      ok((await A("DELETE", "/coach/billing")).s === 409, "nothing left to cancel the second time");
      await planItn(gA, { token: "plan-a2", status: "CANCELLED" }); ok((await billing(gA)).status === "cancelled", "PayFast's own CANCELLED notice afterwards changes nothing");
    }

    // ---------- 4. A gym deleted: its plan and its members' saved cards are cancelled with PayFast ----------
    {
      const B = await gymOn("Bravo"), gB = B.gym.id, s1 = await studentOf(B, "Bea");
      r = await B("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12" }); ok(r.s === 400 && /passphrase/.test(r.j.error), "a live PayFast account can't be connected without its passphrase");
      r = await B("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12", passphrase: GYM_PASS }); ok(r.s === 200, "with it, it can");
      r = await B("POST", "/coach/billing/checkout", {}); await planItn(gB, { mid: r.j.fields.m_payment_id, token: "plan-b" });
      await cardItn(gB, s1.id, "tok-bea");
      ok((await billing(gB)).token === "plan-b" && (await pool.query("select 1 from autopay where user_id=$1", [s1.id])).rows[0], "(a plan card and a member's saved card)");
      // card checkouts: what each asked for is kept, and the notification is checked against it
      r = await s1("POST", "/me/pay/payfast", { amountCents: 50000 }); const f = r.j.fields, co = (await pool.query("select * from card_checkouts where m_payment_id=$1", [f.m_payment_id])).rows[0];
      ok(co && co.amount_cents === 50000 && String(co.user_id) === s1.id && co.split && co.split.percentage === 2, "a card checkout is recorded with its amount and JitsFlow's split: " + JSON.stringify(co && co.split));
      const pay = (fields, pw = GYM_PASS) => notify({ m_payment_id: f.m_payment_id, pf_payment_id: String(++pfn), payment_status: "COMPLETE", item_name: "fees", amount_gross: "500.00", amount_fee: "-11.50",
        custom_str1: "pay", custom_int1: s1.id, custom_int2: String(gB), custom_int3: "", merchant_id: "10000105", ...fields }, pw);
      await pay({}); ok((await pool.query("select amount_cents from payments where gym_id=$1 and source='payfast'", [gB])).rows.map((x) => x.amount_cents).join() === "50000" && !(await pool.query("select 1 from payfast_flags where gym_id=$1", [gB])).rows[0], "the amount it asked for: recorded, nothing flagged");
      // A gym connected before passphrases were needed: a member can sign their own form, for less. Recorded as what was paid, and flagged.
      await pool.query("update gyms set payfast = payfast || $2 where id=$1", [gB, { pass: pfm.seal("") }]);
      m0 = sink.mails.length; await pay({ amount_gross: "5.00", pf_payment_id: "9001" }, ""); await wait(300);
      let flg = (await pool.query("select * from payfast_flags where gym_id=$1 order by id", [gB])).rows;
      ok((await pool.query("select amount_cents from payments where reference='PayFast 9001'")).rows[0].amount_cents === 500 && flg[0] && flg[0].kind === "card-amount" && flg[0].expected_cents === 50000 && flg[0].got_cents === 500, "a payment for less than its checkout asked: recorded as R5, never more, and flagged");
      ok(to("boss@jf3.test", m0).some((m) => /Check a PayFast payment for Bravo BJJ/.test(m.subject)), "the team is emailed");
      await pay({ m_payment_id: "pay-made-up", pf_payment_id: "9002" }, ""); flg = (await pool.query("select * from payfast_flags where gym_id=$1 and kind='card-unknown'", [gB])).rows;
      ok(flg.length === 1 && /pay-made-up/.test(flg[0].note), "one with a payment id JitsFlow never made: flagged too");
      r = await B("GET", "/coach/payfast"); ok(r.j.payfast.needsPassphrase === true, "and its head coach is asked to add a passphrase");
      await pool.query("update gyms set payfast = payfast || $2 where id=$1", [gB, { pass: pfm.seal(GYM_PASS) }]);
      // delete the gym
      r = await B("DELETE", "/coach/gym", { password: "coachpass1" }); await wait(500);
      const cp = of("plan-b", "cancel")[0], cc = of("tok-bea", "cancel")[0];
      ok(r.s === 200 && cp && cp.merchant === pfm.TEST.id && cp.signedWith(pfm.TEST.pass), "deleting the gym cancels its JitsFlow plan with PayFast");
      ok(cc && cc.merchant === "10000105" && cc.signedWith(GYM_PASS) && !(await pool.query("select 1 from autopay where user_id=$1", [s1.id])).rows[0], "and each member's saved card, on the gym's own account, before it goes");
      ok(!(await pool.query("select 1 from gyms where id=$1", [gB])).rows[0] && (await pool.query("select count(*) from payfast_ops where gym_id=$1 and done_at is not null", [gB])).rows[0].count === "2", "the gym is gone; both cancels are done");
    }

    // ---------- 5. The last account deleted, with PayFast saying no: the delete goes ahead, the cancel is retried, then the team hears ----------
    {
      const C = await gymOn("Charlie"), gC = C.gym.id; mode["plan-c"] = "fail";
      r = await C("POST", "/coach/billing/checkout", {}); await planItn(gC, { mid: r.j.fields.m_payment_id, token: "plan-c" });
      r = await C("DELETE", "/me", { password: "coachpass1" }); await wait(500);
      let op = (await pool.query("select * from payfast_ops where token_hash=$1", [sha("plan-c")])).rows[0];
      ok(r.s === 200 && !(await pool.query("select 1 from gyms where id=$1", [gC])).rows[0], "the account and the gym are deleted, whatever PayFast says");
      ok(op && op.tries === 1 && !op.done_at && /PayFast 400/.test(op.error) && Date.parse(op.next_at) > Date.now() + 10 * 60e3 && op.token !== "plan-c" && pfm.open(op.token) === "plan-c", "the cancel PayFast refused is queued to try again in 15 minutes (its token kept sealed)");
      await jobs.pfOps(); ok((await pool.query("select tries from payfast_ops where id=$1", [op.id])).rows[0].tries === 1, "the jobs don't try it before then");
      await pool.query("update payfast_ops set next_at=now() where id=$1", [op.id]); await jobs.pfOps(); op = (await pool.query("select * from payfast_ops where id=$1", [op.id])).rows[0];
      ok(op.tries === 2 && !op.failed_at && Date.parse(op.next_at) > Date.now() + 25 * 60e3, "then they do, and wait twice as long the next time");
      ok((await ADMIN("GET", "/admin/overview")).j.system.payfastOps.trying === 1, "the dashboard counts it as still being tried");
      await pool.query("update payfast_ops set next_at=now(), tries=7 where id=$1", [op.id]); m0 = sink.mails.length; await jobs.pfOps(); await wait(300);
      op = (await pool.query("select * from payfast_ops where id=$1", [op.id])).rows[0];
      const dash = (await ADMIN("GET", "/admin/overview")).j.system.payfastOps;
      ok(op.failed_at && to("boss@jf3.test", m0).some((m) => /PayFast needs a hand: cancel Charlie BJJ's JitsFlow plan/.test(m.subject)) && dash.failed.some((o) => /Charlie BJJ/.test(o.label)), "after 8 tries it's given up: the team is emailed and the dashboard says to cancel it by hand");
      await ADMIN("POST", `/admin/payfast/op/${op.id}/seen`, {}); ok(!(await ADMIN("GET", "/admin/overview")).j.system.payfastOps.failed.some((o) => o.id === String(op.id)), "Done takes it off");
      // PayFast has no such subscription any more: nothing to cancel, done
      const D = await gymOn("Delta"), gD = D.gym.id; mode["plan-d"] = "gone";
      r = await D("POST", "/coach/billing/checkout", {}); await planItn(gD, { mid: r.j.fields.m_payment_id, token: "plan-d" });
      await D("DELETE", "/coach/gym", { password: "coachpass1" }); await wait(400);
      ok((await pool.query("select done_at from payfast_ops where token_hash=$1", [sha("plan-d")])).rows[0].done_at, "a subscription PayFast doesn't know any more counts as cancelled");
    }

    // ---------- 6. A wrong claim taken back: the claimant's plan and saved cards are cancelled ----------
    {
      const token = crypto.randomBytes(24).toString("base64url");
      const pid = (await pool.query("insert into prospects(token,website,domain,name,import_state,status,profile) values($1,'https://echo.test','echo.test','Echo BJJ','done','sent',$2) returning id",
        [token, { name: "Echo BJJ", timetable: [{ day: "Mon", start: "18:00", end: "19:00", title: "BJJ" }] }])).rows[0].id;
      await ADMIN("POST", `/admin/prospects/${pid}/build`, {});
      const W = client(base); r = await W("POST", "/auth/start-gym", { prospect: token, name: "Impostor", email: "imp@jf3.test", password: "password123" }); const gE = r.j.me.gym.id;
      ok(r.s === 201 && (await pool.query("select pop_token from gyms where id=$1", [gE])).rows[0].pop_token, "a claimed gym gets its proof-of-payment address");
      await W("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12", passphrase: GYM_PASS });
      r = await W("POST", "/coach/billing/checkout", {}); await planItn(gE, { mid: r.j.fields.m_payment_id, token: "plan-e" });
      r = await ADMIN("POST", `/admin/gyms/${gE}/unclaim`, {}); await wait(500);
      ok(r.s === 200 && of("plan-e", "cancel").length === 1 && !(await billing(gE)).token, "unclaiming cancels the claimant's JitsFlow plan with PayFast");
    }

    // ---------- 7. Someone a coach added with their email can still sign up; nobody is put into that record ----------
    {
      const X = await gymOn("Xray"), Y = await gymOn("Yankee");
      const rec = (await X("POST", "/coach/students", { name: "Real Person", email: "real.person@target.test", phone: "082 100 2000" })).j.id;
      m0 = sink.mails.length; const v = client(base);
      r = await v("POST", "/auth/register", { name: "Real Person", email: "real.person@target.test", password: "mypassword1" }); await wait(300);
      const recRow = (await pool.query("select * from users where id=$1", [rec])).rows[0];
      ok(r.s === 201 && r.j.me.id !== String(rec) && !r.j.me.gym, "the owner of the email signs up (no 409), as their own account, in no gym: " + r.s);
      ok(recRow && recRow.gym_id === X.gym.id * 1 || String(recRow.gym_id) === X.gym.id, "the record stays in the coach's gym");
      ok(recRow && !recRow.email && recRow.name === "Real Person" && recRow.pass_hash === null && recRow.phone, "with its name and number, without the email");
      ok(to(X.email, m0).some((m) => m.subject === "A member made their own JitsFlow account" && /real\.person@target\.test/.test(m.text) && /Merge/.test(m.text) && /WhatsApp/.test(m.text)), "the coach who added them is told, with Merge if they join");
      // the same with starting a gym
      await Y("POST", "/coach/students", { name: "Gym Owner", email: "owner@target.test" });
      r = await client(base)("POST", "/auth/start-gym", { gym: "Owner's Gym", name: "Gym Owner", email: "owner@target.test", password: "ownerpass1" }); ok(r.s === 201, "or starts their own gym");
      // joining that same gym with its code: a new account, and one note to the coach to merge
      const sam = (await Y("POST", "/coach/students", { name: "Sam Same", email: "sam@target.test" })).j.id;
      m0 = sink.mails.length; r = await client(base)("POST", "/auth/register", { code: Y.gym.studentCode, name: "Sam Same", email: "sam@target.test", password: "sampass123" }); await wait(300);
      const notes = to(Y.email, m0);
      ok(r.s === 201 && r.j.me.id !== String(sam) && r.j.me.gym && r.j.me.gym.id === Y.gym.id && (await pool.query("select pass_hash from users where id=$1", [sam])).rows[0].pass_hash === null, "with the gym's code: a new account in the gym, not linked to the record");
      ok(notes.length === 1 && /may be on your list already/.test(notes[0].subject) && /Merge/.test(notes[0].text), "and one note to the head coach to merge: " + notes.map((m) => m.subject));
      // a password reset for an email a coach added: the email names the gym, so nobody joins it without knowing
      await X("POST", "/coach/students", { name: "Pat Offline", email: "pat@target.test" });
      m0 = sink.mails.length; await client(base)("POST", "/auth/forgot", { email: "pat@target.test" }); await wait(400);
      const rm = to("pat@target.test", m0)[0];
      ok(rm && rm.subject === "Set your JitsFlow password" && /Xray BJJ added you/.test(rm.text) && /Not a member of Xray BJJ\? Don't use the button/.test(rm.text) && /join Xray BJJ/.test(rm.text), "a reset for a record a coach added says which gym it joins, and how to sign up alone instead");
      m0 = sink.mails.length; await client(base)("POST", "/auth/forgot", { email: "real.person@target.test" }); await wait(400);
      ok(to("real.person@target.test", m0)[0] && to("real.person@target.test", m0)[0].subject === "Reset your JitsFlow password", "(an account's own reset is as before)");
    }

    // ---------- 8. Fee reminders carry the stop link; a stop is honoured, and Money says so ----------
    {
      const F = await gymOn("Foxtrot");
      const plan = (await F("POST", "/coach/plans", { name: "Adults", priceCents: 50000, period: "month" })).j.plan.id;
      await F("PATCH", "/coach/gym/pay", { holder: "Foxtrot", bank: "FNB", account: "62000000000", branch: "250655", dueDay: 1 });
      const add = async (name, email) => { const id = (await F("POST", "/coach/students", { name, email, phone: "082 333 " + String(1000 + n++) })).j.id;
        await F("PATCH", `/coach/students/${id}`, { planId: plan }); await pool.query("update users set created_at=now()-interval '70 days', bill_from=null where id=$1", [id]); return id; };
      const ann = await add("Ann Owes", "ann@owes.test"), bob = await add("Bob Owes", "bob@owes.test");
      await pool.query("update gyms set bill_start=date_trunc('month', now() - interval '2 months')::date where id=$1", [F.gym.id]);
      m0 = sink.mails.length; r = await F("POST", "/coach/money/remind", { userIds: [ann, bob] }); await wait(400);
      const am = to("ann@owes.test", m0)[0], stop = am && (am.text.match(/\/api\/gym-mail\/stop\/([A-Za-z0-9_-]{24})/) || [])[1];
      ok(r.s === 200 && r.j.sent === 2 && am && stop && am.headers && am.headers["List-Unsubscribe"] === `<https://www.jitsflow.test/api/gym-mail/stop/${stop}>` && am.headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click", "a fee reminder has the stop link and List-Unsubscribe headers: " + JSON.stringify(am && am.headers));
      r = await fetch(`http://127.0.0.1:${port}/api/gym-mail/stop/${stop}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
      ok(r.status === 200, "one tap stops them");
      await pool.query("update users set reminded_at=null where id = any($1)", [[ann, bob]]);
      m0 = sink.mails.length; r = await F("POST", "/coach/money/remind", { userIds: [ann, bob] }); await wait(400);
      ok(r.j.sent === 1 && r.j.stopped.includes("Ann Owes") && !to("ann@owes.test", m0).length && to("bob@owes.test", m0).length === 1, "the next reminder skips the address that stopped (and says so): " + JSON.stringify(r.j));
      const row = (await F("GET", "/coach/money")).j.students.find((s) => s.id === String(ann));
      ok(row && row.mailStopped === true && row.phone && !(await F("GET", "/coach/money")).j.students.find((s) => s.id === String(bob)).mailStopped, "Money shows the head coach she stopped emails (her WhatsApp number is still there)");
      // the automatic reminders honour it too
      await pool.query("update users set reminded_at=null where id = any($1)", [[ann, bob]]); await pool.query("update gyms set auto_remind=true, remind_log=null where id=$1", [F.gym.id]);
      // (due today, so Home's reminder sheet shows today's run; on the 29th to the 31st, on the 1st without that check)
      const todayZ = new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10), dom = +todayZ.slice(8, 10), due = dom <= 28 ? todayZ : todayZ.slice(0, 8) + "01";
      if (dom <= 28) await F("PATCH", "/coach/gym/pay", { holder: "Foxtrot", bank: "FNB", account: "62000000000", branch: "250655", dueDay: dom });
      m0 = sink.mails.length; await jobs.autoRemind({ day: due, hour: 9 }); await wait(300);
      const log = (await pool.query("select remind_log from gyms where id=$1", [F.gym.id])).rows[0].remind_log;
      ok(!to("ann@owes.test", m0).length && to("bob@owes.test", m0).length === 1 && log.stopped.includes("Ann Owes"), "the automatic ones skip her too, and Home lists her: " + JSON.stringify(log));
      if (dom <= 28) ok((await F("GET", "/coach/roster")).j.reminders.stopped.includes("Ann Owes"), "(Home's reminder sheet gets it)");
    }

    // ---------- 9. Sessions: 180 days at most, and sign out everywhere else ----------
    {
      const G = await gymOn("Golf"), g2 = client(base), g3 = client(base);
      await g2("POST", "/auth/login", { email: G.email, password: "coachpass1" }); await g3("POST", "/auth/login", { email: G.email, password: "coachpass1" });
      r = await G("POST", "/me/sessions/end", {});
      ok(r.s === 200 && r.j.ended === 2 && !(await g2("GET", "/me")).j.me && !(await g3("GET", "/me")).j.me && (await G("GET", "/me")).j.me, "Sign out everywhere else: the other two sessions end, this one stays");
      await pool.query("update sessions set created_at=now()-interval '170 days', expires_at=now()+interval '1 day' where user_id=$1", [G.id]);
      r = await G("GET", "/me"); await wait(200);
      const left = (await pool.query("select extract(epoch from expires_at - now())/86400 as d from sessions where user_id=$1", [G.id])).rows[0].d;
      ok(r.j.me && left > 9 && left < 10.1 && /Max-Age=8\d{5}/.test(r.h.get("set-cookie") || ""), "a session that's been used rolls on, but never past 180 days from signing in: " + left);
      await pool.query("update sessions set created_at=now()-interval '181 days', expires_at=now()+interval '30 days' where user_id=$1", [G.id]);
      ok(!(await G("GET", "/me")).j.me, "past 180 days it's over, however much it's used");
      await g2("POST", "/auth/login", { email: G.email, password: "coachpass1" });
      r = await g2("POST", "/me/sessions/end", { all: true }); ok(r.s === 200 && !(await g2("GET", "/me")).j.me, "all: true signs this one out too");
    }

    // ---------- 10. Data retention: the daily purge ----------
    {
      const H = await gymOn("Hotel"), st = await studentOf(H, "Gone");
      const pid = (await pool.query("insert into payments(gym_id,user_id,amount_cents,paid_on,status) values($1,$2,50000,current_date,'confirmed') returning id", [H.gym.id, st.id])).rows[0].id;
      await pool.query("insert into pop_files(payment_id,name,type,data) values($1,'p.png','image/png',$2)", [pid, Buffer.from("x")]);
      r = await st("DELETE", "/me", { password: "studentpass1" });
      const pr = (await pool.query("select user_id, user_gone_at from payments where id=$1", [pid])).rows[0];
      ok(r.s === 200 && pr.user_id === null && pr.user_gone_at, "a member deletes their account: their payment stays for the gym, marked");
      await purgeRejected(pool); ok((await pool.query("select 1 from pop_files where payment_id=$1", [pid])).rows[0], "their proof stays for 90 days");
      await pool.query("update payments set user_gone_at=now()-interval '91 days' where id=$1", [pid]); await purgeRejected(pool);
      ok(!(await pool.query("select 1 from pop_files where payment_id=$1", [pid])).rows[0] && (await pool.query("select 1 from payments where id=$1", [pid])).rows[0], "then the file goes; the payment stays");
      await pool.query("insert into left_owing(gym_id,name,month,owed_cents,left_at) values($1,'Old Leaver','2025-01',1000,now()-interval '19 months'),($1,'New Leaver','2026-10',1000,now()-interval '2 months')", [H.gym.id]);
      await pool.query(`insert into site_visitors(day,vhash,click,click_id) values(current_date-91,'a','gclid','abc123'),(current_date-5,'b','gclid','def456')`);
      await pool.query("insert into password_resets(token_hash,user_id,expires_at) values('old',$1,now()-interval '1 hour')", [H.id]);
      await pool.query("insert into email_verifications(token_hash,user_id,email,expires_at) values('oldv',$1,'x@y.test',now()-interval '1 hour')", [H.id]);
      await pool.query("insert into gym_mail_stops(gym_id,email,token,stopped_at,created_at) values($1,'stop@me.test','tokentokentokentokentoke',now()-interval '3 years',now()-interval '3 years')", [H.gym.id]);
      await purgeRejected(pool);
      const lo = (await pool.query("select name from left_owing where gym_id=$1", [H.gym.id])).rows.map((x) => x.name), sv = (await pool.query("select vhash, click, click_id from site_visitors order by vhash")).rows;
      ok(lo.join() === "New Leaver", "people who left owing are kept 18 months");
      ok(sv[0].click === "gclid" && sv[0].click_id === "" && sv[1].click_id === "def456", "Google Ads click ids go after 90 days (where they came from stays)");
      ok(!(await pool.query("select 1 from password_resets where token_hash='old'")).rows[0] && !(await pool.query("select 1 from email_verifications where token_hash='oldv'")).rows[0], "expired reset and email links are deleted");
      ok((await pool.query("select 1 from gym_mail_stops where email='stop@me.test'")).rows[0], "a stop request is kept");
      const priv = await (await fetch(`http://127.0.0.1:${port}/privacy/`)).text();
      ok(/How long we keep it/.test(priv) && /90 days/.test(priv) && /18 months/.test(priv) && /180 days/.test(priv), "the privacy page says how long each is kept");
    }

    // ---------- 11. In the app: Cancel plan, the passphrase notice, sign out everywhere, the assistant's confirm card, the team's to-dos ----------
    {
      const { chromium, devices } = require("playwright");
      const I = await gymOn("India"), gI = I.gym.id;
      r = await I("POST", "/coach/billing/checkout", {}); await planItn(gI, { mid: r.j.fields.m_payment_id, token: "plan-i" });
      await pool.query("update gyms set payfast=$2 where id=$1", [gI, { merchantId: "10000105", key: pfm.seal("abcdefghijk12"), pass: pfm.seal("") }]);
      const br = await chromium.launch(), errs = [];
      try {
        const ctx = await br.newContext({ ...devices["iPhone 13"] }); await ctx.addInitScript(() => { if (!localStorage.getItem("rtb.progress")) localStorage.setItem("rtb.progress", JSON.stringify({ settings: { onboarded: true } })); });
        await ctx.addCookies([{ name: "jf_s", value: I.cookie().replace(/^jf_s=/, ""), url: `http://127.0.0.1:${port}` }]);
        const p = await ctx.newPage(); p.on("pageerror", (e) => errs.push(e.message)); const ev = (f, a) => p.evaluate(f, a), toast = () => ev(() => document.getElementById("toast").textContent);
        await p.goto(`http://127.0.0.1:${port}/app/`); await p.waitForTimeout(1200);
        await ev(() => coachGo("gym")); await p.waitForTimeout(800);
        ok(await ev(() => { const x = document.querySelector(".planpanel"); return !!x && !!x.querySelector('[data-a="billcancel"]'); }), "Gym › Your JitsFlow plan has Cancel plan when a card is on it");
        await p.tap('.planpanel [data-a="billcancel"]'); await p.waitForTimeout(300);
        ok(await ev(() => S.ui.sheet && S.ui.sheet.k === "confirm" && /won't charge your card again/.test(document.getElementById("sheet").innerText)), "it asks first, saying what happens");
        await p.tap('[data-a="billcancelyes"]'); await p.waitForTimeout(900);
        ok(/plan is cancelled/.test(await toast()) && (await billing(gI)).status === "cancelled" && of("plan-i", "cancel").length === 1 && await ev(() => !document.querySelector('.planpanel [data-a="billcancel"]')), "Cancel plan: cancelled with PayFast, and the panel says so");
        ok(await ev(() => { const x = document.querySelector(".planpanel"), t = x && x.querySelector(".payterms"); return !!x.querySelector('[data-a="billcard"]') && !!t && /charges the plan price monthly/.test(t.innerText) && /Cancel any time; no part-month refunds/.test(t.innerText) && /By tapping Add a card, you agree to the Terms and Refund policy\. Payments are processed securely by Payfast\./.test(t.innerText) && !!t.querySelector('a[href="/terms/"]') && !!t.querySelector('a[href="/refunds/"]'); }), "Add a card: the billing terms, the Terms and Refund policy links and Payfast on the same screen");
        ok(await ev(async () => { COACH.pf = (await api("GET", "/coach/payfast")).payfast; return /Add your PayFast passphrase/.test(pfPanel()); }), "a PayFast account without a passphrase: the head coach is asked to add one");
        // the assistant's confirm card (the assistant itself is switched off here: its card is drawn as the app draws it)
        ok(await ev(() => { const h = astBubble({ role: "assistant", text: "Check the card.", proposals: [{ id: "x1", summary: "Change your bank details", lines: ["Account number: 1 → 2"] }] });
          const d = document.createElement("div"); d.innerHTML = h; return /Change your bank details/.test(d.innerText) && /Account number: 1 → 2/.test(d.innerText) && !!d.querySelector('[data-a="astok"][data-v="x1"]') && !!d.querySelector('[data-a="astno"]'); }), "the assistant's proposal is a card with the exact change, Confirm and Cancel");
        // sign out everywhere else
        const other = client(base); await other("POST", "/auth/login", { email: I.email, password: "coachpass1" });
        await ev(() => go("me")); await p.waitForTimeout(600);
        await p.tap('[data-a="signoutall"]'); await p.waitForTimeout(700);
        ok(/Signed out on 1 other device\./.test(await toast()) && !(await other("GET", "/me")).j.me && await ev(async () => !!(await api("GET", "/me")).me), "Me › Sign out on all your other devices: the other one ends, this one stays: " + (await toast()));
        // the team's dashboard: a PayFast cancel to do by hand, with Done
        await pool.query("insert into payfast_ops(what,label,token,token_hash,failed_at,error) values('card','a member''s saved card at India BJJ','x','x-hash',now(),'PayFast 400')");
        const ac = await br.newContext({ ...devices["iPhone 13"] }); await ac.addCookies([{ name: "jf_s", value: ADMIN.cookie().replace(/^jf_s=/, ""), url: `http://127.0.0.1:${port}` }]);
        const ap = await ac.newPage(); ap.on("pageerror", (e) => errs.push(e.message)); await ap.goto(`http://127.0.0.1:${port}/app/`); await ap.waitForTimeout(1000);
        await ap.evaluate(() => dashOpen()); await ap.waitForTimeout(1500);
        ok(await ap.evaluate(() => /Cancel by hand in PayFast: a member's saved card at India BJJ/.test(document.getElementById("sheet").innerText)), "the team's dashboard lists the cancel to do by hand");
        await ap.tap('#dashsystem [data-a="pfseen"]'); await ap.waitForTimeout(1200);
        ok(await ap.evaluate(() => !/Cancel by hand in PayFast: a member's saved card at India BJJ/.test(document.getElementById("sheet").innerText)) && (await pool.query("select seen_at from payfast_ops where token_hash='x-hash'")).rows[0].seen_at, "Done takes it off");
        ok(!errs.length, "no errors in the app: " + errs.join(" | "));
      } finally { await br.close(); }
    }

    // ---------- every state-changing route still needs the app's header (the new ones too) ----------
    {
      const Z = await gymOn("Zulu");
      for (const [m, u] of [["DELETE", "/coach/billing"], ["POST", "/me/sessions/end"], ["POST", "/coach/assistant/confirm"], ["POST", "/admin/payfast/op/1/seen"]]) {
        const x = await fetch(base + u, { method: m, headers: { cookie: Z.cookie(), "content-type": "application/x-www-form-urlencoded" }, body: "a=1" });
        ok(x.status === 403, `${m} ${u} without x-jf: 403 (${x.status})`);
      }
    }
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e)); }
  srv.kill(); sink.close(); pf.close(); await pool.end().catch(() => {});
  console.log(`security2: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
