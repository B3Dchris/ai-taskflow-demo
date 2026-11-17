// Members paying their gym through Paystack, against a real PostgreSQL, with Paystack stood in for (tests/fake-paystack.js):
// a gym's payout account (subaccount), the team verifying it, checkouts, webhooks (signatures, replays, wrong amounts), saved cards
// and their monthly charges, refunds, chargebacks, and the public pages' "coming soon" switch. Nothing here talks to Paystack.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/paystack.js   (wipes that database)
const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg");
const { startMailSink } = require("./fixture-gym"); const { startFakePaystack } = require("./fake-paystack");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
function client(base, cookie = "") {
  const c = async (method, url, body) => {
    const h = {}; if (cookie) h.cookie = cookie; if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; }
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = m[1] ? "jf_s=" + m[1] : ""; }
    let j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j };
  };
  return c;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = "sk_test_" + "f".repeat(40);
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists paystack_checkouts, paystack_refunds, paystack_disputes, payfast_ops, card_checkouts, payfast_flags, assistant_proposals, autopay_charges, autopay, class_skips, plan_breaks, notices, left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const sink = await startMailSink(), ps = await startFakePaystack({ secret: SECRET });
  const port = 9300 + Math.floor(Math.random() * 90), base = `http://127.0.0.1:${port}/api`; ps.setApp(`http://127.0.0.1:${port}`);
  const common = { DATABASE_URL: DB, RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, APP_URL: "https://www.jitsflow.test", MAIL_GAP_MS: "0", JF_ADMIN_EMAILS: "boss@jitsflow.test",
    PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_URL: ps.url };
  const env = { ...process.env, ...common, PORT: String(port), JF_PLAN_CARD_TEST: "1" }; delete env.ANTHROPIC_API_KEY; delete env.PAYFAST_MERCHANT_ID; delete env.JF_PAYSTACK_LIVE; delete env.JF_MEMBER_PAYMENTS; delete env.PAYSTACK_FEE_BEARER;
  const logs = [];
  const start = (e) => { const s = spawn("node", [path.resolve(__dirname, "../server.js")], { env: e, stdio: ["ignore", "pipe", "pipe"] }); s.stdout.on("data", (d) => logs.push(String(d))); s.stderr.on("data", (d) => logs.push(String(d))); return s; };
  const up = async (p) => { for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${p}/healthz`); return; } catch (e) { await wait(150); } } };
  const srvs = [start(env)]; await up(port);
  // The scheduled jobs, run here as server.js runs them.
  Object.assign(process.env, common); delete process.env.PAYFAST_MERCHANT_ID;
  const { makeApi } = require("../backend/api"), pfm = require("../backend/payfast"), jobs = makeApi(pool, {}).jobs;
  const to = (addr, from = 0) => sink.mails.slice(from).filter((m) => m.to[0] === addr);
  const inits = () => ps.calls.filter((c) => c.path === "/transaction/initialize");
  const lastInit = () => inits().slice(-1)[0].body;
  const charges = () => ps.calls.filter((c) => c.path === "/transaction/charge_authorization");
  // The member pays on Paystack's checkout page (the stand-in): it sends Paystack's webhook, then goes back to the app.
  const payOn = async (url) => { const code = url.split("/checkout/")[1]; const r = await fetch(`${ps.url}/checkout/${code}/pay`, { method: "POST", redirect: "manual" }); await wait(500); return r.headers.get("location"); };
  try {
    // ---------- switched off: nothing about Paystack anywhere ----------
    {
      const p2 = port + 100, e2 = { ...env, PORT: String(p2) }; delete e2.PAYSTACK_SECRET_KEY; const s2 = start(e2); srvs.push(s2); await up(p2);
      const st = await (await fetch(`http://127.0.0.1:${p2}/api/status`)).json();
      ok(st.cards === "payfast" && !JSON.stringify(st).includes("sk_"), "without PAYSTACK_SECRET_KEY, /api/status says members pay by PayFast: " + JSON.stringify(st));
      const c = client(`http://127.0.0.1:${p2}/api`); await c("POST", "/auth/start-gym", { gym: "Off BJJ", name: "Coach Off", email: "off@ps.test", password: "coachpass1", timezone: "Africa/Johannesburg" });
      let r = await c("GET", "/coach/paystack"); ok(r.s === 200 && r.j.paystack.on === false, "and the head coach's Get paid by card card is off");
      r = await c("PUT", "/coach/paystack", { bankCode: "470010", account: "1234567890", holder: "Off", business: "Off BJJ", idKind: "reg", idNumber: "2019/123456/07" }); ok(r.s === 400, "and can't be set up");
      const h = await (await fetch(`http://127.0.0.1:${p2}/pricing/`)).text();
      ok(/coming soon/i.test(h) && !/jf:(soon|live)/.test(h), "the pricing page says member card payments are coming soon, with no markers left in it");
      s2.kill();
    }
    {
      const p3 = port + 200, e3 = { ...process.env, PORT: String(p3), JF_PAYSTACK_LIVE: "1" }; delete e3.DATABASE_URL; const s3 = start(e3); srvs.push(s3); await up(p3);
      const h = await (await fetch(`http://127.0.0.1:${p3}/pricing/`)).text(), t = h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      ok(/paid by Paystack directly into the gym's bank account/.test(t) && /JitsFlow never holds membership money/.test(t) && !/jf:(soon|live)/.test(h), "JF_PAYSTACK_LIVE=1: the pricing page says card payments are live, paid by Paystack into the gym's account");
      const sec = (await (await fetch(`http://127.0.0.1:${p3}/security/`)).text()).replace(/<[^>]+>/g, " ");
      ok(/Paystack/.test(sec) && /Capitec Pay/.test(sec), "and the secure payments page names Paystack and Capitec Pay");
      s3.kill();
    }
    let r = await fetch(base + "/status").then((x) => x.json());
    ok(r.cards === "paystack" && !JSON.stringify(r).includes(SECRET), "with the key set, /api/status says members pay by Paystack (and shows no secret)");

    // ---------- the gym and its members ----------
    const coach = client(base), co2 = client(base), admin = client(base), anon = client(base);
    r = await coach("POST", "/auth/start-gym", { gym: "Stack BJJ", name: "Coach Ann", email: "ann@ps.test", password: "coachpass1", timezone: "Africa/Johannesburg" });
    const gym = Number(r.j.me.gym.id), code = r.j.me.gym.studentCode;
    await co2("POST", "/auth/register", { code: r.j.me.gym.coachCode, name: "Coach Bo", email: "bo@ps.test", password: "coachpass2" });
    await admin("POST", "/auth/register", { name: "Boss Admin", email: "boss@jitsflow.test", password: "adminpass1" });
    await pool.query("update users set email_verified_at=now(), email_verified_for=email where email='boss@jitsflow.test'");
    const plan = (await coach("POST", "/coach/plans", { name: "Adults", priceCents: 85000, period: "month" })).j.plan.id;
    await coach("PATCH", "/coach/gym/pay", { holder: "Stack BJJ", bank: "FNB", account: "62000000000", branch: "250655", dueDay: 1 });
    const S = {};
    const join = async (k, withPlan = true) => { const c = client(base), x = await c("POST", "/auth/register", { code, name: `${k[0].toUpperCase()}${k.slice(1)} Member`, email: `${k}@ps.test`, password: "studentpass1" });
      c.id = x.j.me.id; c.email = `${k}@ps.test`; S[k] = c; if (withPlan) await coach("PATCH", `/coach/students/${c.id}`, { planId: plan }); return c; };
    for (const k of ["amy", "ben", "cara", "dan"]) await join(k);
    const pay = async (c) => (await c("GET", "/me/pay")).j.pay;

    // ---------- the head coach gives the gym's bank account ----------
    r = await coach("GET", "/coach/paystack");
    ok(r.s === 200 && r.j.paystack.on && r.j.paystack.test && r.j.paystack.feePct === 2 && r.j.paystack.bearer === "subaccount" && r.j.paystack.account === null, "the head coach sees Get paid by card, not set up yet: " + JSON.stringify(r.j));
    ok((await co2("GET", "/coach/paystack")).s === 403 && (await S.amy("GET", "/coach/paystack")).s === 403 && (await anon("GET", "/coach/paystack")).s === 401, "only the head coach sees it");
    r = await coach("GET", "/coach/paystack/banks"); await coach("GET", "/coach/paystack/banks");
    ok(r.s === 200 && r.j.banks.map((b) => b.name).join() === "Capitec Bank,First National Bank,Absa Bank,Standard Bank" && ps.calls.filter((c) => c.path === "/bank").length === 1,
      "banks come from Paystack: South Africa only, the popular ones, most popular first; inactive and other countries' banks left out; asked for once a day: " + JSON.stringify(r.j));
    ok(ps.calls.find((c) => c.path === "/bank").query.country === "south africa" && ps.calls.find((c) => c.path === "/bank").query.currency === "ZAR" && ps.calls.every((c) => c.auth), "with country, currency and the secret key");
    const good = { bankCode: "470010", account: "1234 567 890", holder: "Stack BJJ (Pty) Ltd", business: "Stack BJJ (Pty) Ltd", idKind: "reg", idNumber: "2019/123456/07" };
    for (const [bad, why] of [[{ account: "12ab" }, "account"], [{ bankCode: "999999" }, "bank"], [{ idNumber: "2019-1234" }, "registration"], [{ idKind: "id", idNumber: "8001015009088" }, "ID"], [{ holder: "" }, "holder"], [{ business: "" }, "business"]]) {
      r = await coach("PUT", "/coach/paystack", { ...good, ...bad }); ok(r.s === 400 && r.j.error, `a wrong ${why} is refused: ${r.j && r.j.error}`);
    }
    r = await coach("PUT", "/coach/paystack", { ...good, account: "0000000000" }); ok(r.s === 502 && /invalid/i.test(r.j.error), "Paystack's own refusal is shown: " + JSON.stringify(r.j));
    ok((await co2("PUT", "/coach/paystack", good)).s === 403 && (await S.amy("PUT", "/coach/paystack", good)).s === 403, "a coach who isn't head, or a member, can't set it");
    let m0 = sink.mails.length;
    r = await coach("PUT", "/coach/paystack", good);
    const subCall = ps.calls.filter((c) => c.path === "/subaccount").slice(-1)[0].body, acct = r.j.paystack;
    ok(r.s === 200 && acct.status === "pending_verification" && acct.bankName === "Capitec Bank" && acct.last4 === "7890" && acct.idLast4 === "5607" && !JSON.stringify(r.j).includes("1234567890") && !JSON.stringify(r.j).includes("123456/07"),
      "saved: waiting for the team, showing only the last 4 digits: " + JSON.stringify(r.j));
    ok(subCall.business_name === "Stack BJJ (Pty) Ltd" && subCall.settlement_bank === "470010" && subCall.account_number === "1234567890" && subCall.percentage_charge === 0 && subCall.settlement_schedule === "auto" && subCall.primary_contact_email === "ann@ps.test",
      "a Paystack subaccount is made: the gym's bank, percentage 0 (JitsFlow's fee goes per payment), auto settlement: " + JSON.stringify(subCall));
    let row = (await pool.query("select paystack from gyms where id=$1", [gym])).rows[0].paystack;
    ok(row.subaccount && row.accountSealed && !JSON.stringify(row).includes("1234567890") && pfm.open(row.accountSealed) === "1234567890" && pfm.open(row.idSealed) === "2019/123456/07" && row.ownerId,
      "the full account and registration numbers are stored sealed, never in the clear");
    await wait(300);
    ok(!logs.join("").includes("1234567890") && !logs.join("").includes("123456/07"), "and never logged");
    ok(to("ann@ps.test", m0).some((x) => x.subject === "Your gym's card payout account changed" && /ending 7890/.test(x.text)) && to("boss@jitsflow.test", m0).some((x) => /Card payouts to verify: Stack BJJ/.test(x.subject)),
      "the head coach is told, and the team is asked to verify it");
    let p = await pay(S.amy); ok(p.card === false && p.provider === "paystack", "members can't pay by card while it waits: " + JSON.stringify([p.card, p.provider]));
    r = await S.amy("POST", "/me/pay/paystack", { amountCents: 85000 }); ok(r.s === 400, "and the server refuses a checkout");
    r = await S.amy("POST", "/me/pay/payfast", { amountCents: 85000 }); ok(r.s === 400, "PayFast isn't offered to members while Paystack is on");

    // ---------- the team verifies it ----------
    r = await coach("GET", "/admin/overview"); ok(r.s === 403, "the team's dashboard is the team's only");
    r = await admin("GET", "/admin/overview"); let sys = r.j.system.paystack;
    const tv = sys && sys.toVerify.find((x) => x.id === String(gym));
    ok(sys && sys.on && sys.test && tv && tv.gym === "Stack BJJ" && tv.last4 === "7890" && tv.bankName === "Capitec Bank" && tv.idKind === "reg" && tv.subaccount && tv.head.email === "ann@ps.test" && /dashboard\.paystack\.com/.test(sys.dashboard),
      "the dashboard lists it to verify, with a link to Paystack's subaccounts: " + JSON.stringify(sys));
    ok(!JSON.stringify(r.j).includes("1234567890") && !JSON.stringify(r.j).includes("123456/07"), "with the numbers masked");
    r = await admin("POST", `/admin/paystack/gyms/${gym}/reveal`, {}); ok(r.s === 200 && r.j.account === "1234567890" && r.j.idNumber === "2019/123456/07", "the team can see the full numbers on tap");
    ok((await coach("POST", `/admin/paystack/gyms/${gym}/reveal`, {})).s === 403 && (await coach("POST", `/admin/paystack/gyms/${gym}/verify`, {})).s === 403, "nobody else can");
    m0 = sink.mails.length; r = await admin("POST", `/admin/paystack/gyms/${gym}/verify`, {}); await wait(300);
    ok(r.s === 200 && (await pool.query("select paystack->>'status' as s, paystack->>'verifiedBy' as b from gyms where id=$1", [gym])).rows[0].s === "active", "Mark verified switches card payments on");
    ok(to("ann@ps.test", m0).some((x) => x.subject === "Card payments are on" && /Capitec Pay/.test(x.text) && /2 working days/.test(x.text)), "and the head coach is emailed");
    ok((await admin("POST", `/admin/paystack/gyms/${gym}/verify`, {})).s === 409, "marking it twice says so");
    p = await pay(S.amy); ok(p.card === true && p.provider === "paystack" && p.autopay && p.autopay.on === false && p.autopay.provider === "paystack", "members can pay by card now, and save their card: " + JSON.stringify([p.card, p.autopay]));
    r = await coach("PUT", "/coach/paystack", good); ok(r.s === 200 && r.j.same && r.j.paystack.status === "active", "saving the same details again changes nothing (still verified)");

    // ---------- a member pays their fees by card ----------
    r = await S.amy("POST", "/me/pay/paystack", { amountCents: 400 }); ok(r.s === 400, "under R5 is refused");
    r = await S.amy("POST", "/me/pay/paystack", { amountCents: 2000001 }); ok(r.s === 400 && /R20 000/.test(r.j.error), "over R20,000 is refused");
    r = await S.amy("POST", "/me/pay/paystack", { amountCents: 85000 });
    let ini = lastInit();
    ok(r.s === 200 && r.j.url.startsWith(ps.url + "/checkout/") && r.j.reference === ini.reference, "a checkout opens on Paystack: " + JSON.stringify(r.j));
    ok(ini.amount === 85000 && ini.currency === "ZAR" && ini.subaccount === row.subaccount && ini.transaction_charge === 1700 && ini.bearer === "subaccount" && ini.email === "amy@ps.test" && ini.callback_url === "https://www.jitsflow.test/app/?paid=card"
      && ini.metadata.userId === S.amy.id && ini.metadata.gymId === String(gym) && ini.metadata.kind === "fees" && !ini.channels,
      "for R850 in rand, split to the gym's subaccount with JitsFlow's 2% (R17) as a flat charge, the gym bearing Paystack's fee, every channel Paystack offers: " + JSON.stringify(ini));
    const ref1 = r.j.reference, url1 = r.j.url;
    // forged and unsigned webhooks
    let st = await ps.hook("charge.success", { reference: ref1, amount: 85000, currency: "ZAR", status: "success" }, { sig: "ab".repeat(64) });
    ok(st === 401, "a webhook with a wrong signature is refused");
    st = await ps.hook("charge.success", { reference: ref1, amount: 85000, currency: "ZAR", status: "success" }, { sig: false }); ok(st === 401, "and one with none");
    r = await fetch(base + "/paystack/webhook", { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": ps.sign(Buffer.from("{}")) }, body: '{"event":"charge.success","data":{}}' });
    ok(r.status === 401, "a signature for another body doesn't count");
    // A signed webhook for a payment Paystack hasn't seen go through (it says abandoned): nothing is credited.
    st = await ps.hook("charge.success", { reference: ref1, amount: 85000, currency: "ZAR", status: "success" }); await wait(300);
    ok(st === 200 && !(await pool.query("select 1 from payments where reference=$1", [ref1])).rows[0], "a signed webhook alone credits nothing: Paystack says it wasn't paid (verify)");
    m0 = sink.mails.length;
    const back = await payOn(url1);
    ok(/^https:\/\/www\.jitsflow\.test\/app\/\?paid=card&trxref=jfp-/.test(back), "after paying, Paystack sends them back to the app: " + back);
    let pr = (await pool.query("select * from payments where reference=$1", [ref1])).rows;
    ok(pr.length === 1 && pr[0].status === "confirmed" && pr[0].source === "paystack" && pr[0].method === "card" && pr[0].amount_cents === 85000 && pr[0].fee_cents === 1700 && pr[0].psp_fee_cents > 0 && /Card via Paystack/.test(pr[0].note),
      "the webhook, checked with Paystack, records it as paid (card, Paystack's reference, both fees): " + JSON.stringify(pr[0] && [pr[0].status, pr[0].source, pr[0].method, pr[0].note]));
    p = await pay(S.amy); ok(p.owedCents === 0 && p.payments.some((x) => x.reference === ref1 && x.method === "card" && x.feeCents === 1700), "Amy owes nothing now");
    ok(to("amy@ps.test", m0).some((x) => x.subject === "Receipt: R 850,00 to Stack BJJ" && x.text.includes(ref1)) && to("ann@ps.test", m0).some((x) => x.subject === "A card payment came in" && /through Paystack/.test(x.text)),
      "Amy gets a receipt and the head coach is told: " + JSON.stringify(sink.mails.slice(m0).map((x) => [x.to[0], x.subject])));
    m0 = sink.mails.length;
    st = await ps.hook("charge.success", ps.verifyData(ps.txs.get(ref1))); await wait(300);
    r = await S.amy("POST", "/me/pay/paystack/check", { reference: ref1 });
    ok(st === 200 && r.j.status === "paid" && (await pool.query("select count(*)::int as n from payments where reference=$1", [ref1])).rows[0].n === 1 && !to("amy@ps.test", m0).length, "the same webhook again, and the member coming back: still one payment, one receipt");
    ok((await S.ben("POST", "/me/pay/paystack/check", { reference: ref1 })).s === 404, "someone else can't ask about Amy's payment");

    // ---------- Paystack's answer doesn't match the checkout: not credited, the team checks it ----------
    const flagCount = async () => Number((await pool.query("select count(*) from payfast_flags where kind like 'ps-%'")).rows[0].count);
    for (const [over, why] of [[{ amount: 100 }, "amount"], [{ currency: "NGN" }, "currency"], [{ subaccount: "ACCT_other" }, "subaccount"]]) {
      r = await S.ben("POST", "/me/pay/paystack", { amountCents: 85000 }); const ref = r.j.reference; ps.succeed(ref); ps.tweak(ref, over);
      const f0 = await flagCount(); m0 = sink.mails.length;
      await ps.hook("charge.success", ps.verifyData(ps.txs.get(ref))); await wait(300);
      ok(!(await pool.query("select 1 from payments where reference=$1", [ref])).rows[0] && (await flagCount()) === f0 + 1 && (await pool.query("select status from paystack_checkouts where reference=$1", [ref])).rows[0].status === "flagged",
        `a payment with another ${why} than the checkout's isn't credited, and is flagged for the team`);
      ok(to("boss@jitsflow.test", m0).some((x) => /Check a Paystack payment/.test(x.subject)), "the team is emailed about it");
      await ps.hook("charge.success", ps.verifyData(ps.txs.get(ref))); await wait(200); ok((await flagCount()) === f0 + 1, "once");
    }
    // A payment JitsFlow didn't start
    ps.txs.set("outside-1", { id: 777, reference: "outside-1", amount: 5000, currency: "ZAR", status: "success", subaccount: row.subaccount, email: "x@y.z" });
    const f1 = await flagCount(); await ps.hook("charge.success", { reference: "outside-1" }); await wait(300);
    ok((await flagCount()) === f1 + 1 && !(await pool.query("select 1 from payments where reference='outside-1'")).rows[0], "a payment JitsFlow didn't start is flagged, not recorded");
    r = await admin("GET", "/admin/overview"); ok(r.j.system.payfastFlags.some((f) => f.kind === "ps-mismatch") && r.j.system.payfastFlags.some((f) => f.kind === "ps-unknown"), "the dashboard shows them");
    // Paystack test mode (verify's domain "test"): recorded as a test, no real money
    r = await S.ben("POST", "/me/pay/paystack", { amountCents: 85000 }); const refT = r.j.reference; ps.succeed(refT); ps.tweak(refT, { domain: "test" });
    await ps.hook("charge.success", ps.verifyData(ps.txs.get(refT))); await wait(300);
    ok((await pool.query("select status from payments where reference=$1", [refT])).rows[0].status === "test" && (await pay(S.ben)).owedCents === 85000, "a test-mode payment is kept as a test: it doesn't count as paid");

    // ---------- packs and plans by card ----------
    const pack = (await coach("POST", "/coach/packs", { name: "5 privates", lessons: 5, priceCents: 250000 })).j.pack;
    r = await S.cara("POST", "/me/pay/paystack", { packId: pack.id, amountCents: 100 }); ini = lastInit(); if (r.s !== 200) console.log(r);
    ok(r.s === 200 && ini.amount === 250000 && ini.transaction_charge === 5000 && ini.metadata.kind === "pack" && ini.metadata.packId === pack.id, "a pack is paid at its price (whatever's sent): " + JSON.stringify(ini.metadata));
    await payOn(r.j.url); p = await pay(S.cara);
    ok(p.privatesLeft.left === 5 && p.payments.some((x) => x.packLessons === 5 && x.method === "card"), "the pack's 5 lessons are theirs once Paystack confirms it");
    const eve = await join("eve", false);
    const pickable = (await pay(eve)).plans; ok(pickable.length === 1, "a new member can pick a plan");
    r = await eve("POST", "/me/pay/paystack", { planId: plan, amountCents: 1000 }); ini = lastInit();
    ok(r.s === 200 && ini.amount === 85000 && ini.metadata.kind === "plan" && ini.metadata.planId === plan, "joining a plan by card: at least its price");
    await payOn(r.j.url);
    const ev = (await pool.query("select plan_id, plan_status from users where id=$1", [eve.id])).rows[0];
    ok(String(ev.plan_id) === plan && ev.plan_status === "active" && (await pool.query("select plan_id from payments where user_id=$1", [eve.id])).rows[0].plan_id == plan, "they're on the plan once it's paid: " + JSON.stringify(ev));
    r = await S.dan("POST", "/me/pay/paystack", { planId: plan }); ok(r.s === 404, "someone already on a plan can't buy one that isn't on offer to them");

    // ---------- rate limit ----------
    let lim = 0; for (let i = 0; i < 14; i++) { const x = await S.dan("POST", "/me/pay/paystack", { amountCents: 1000 }); if (x.s === 429) lim++; }
    ok(lim > 0, "a member can't open checkouts without end (rate limited)");

    // ---------- saving a card, and the monthly charge ----------
    m0 = sink.mails.length;
    r = await S.ben("POST", "/me/autopay", {}); ini = lastInit();
    ok(r.s === 200 && r.j.url && ini.amount === 85000 && JSON.stringify(ini.channels) === '["card"]' && ini.metadata.save === true && /autopay=on/.test(ini.callback_url),
      "Save my card: a card checkout for what Ben owes now, to keep the card: " + JSON.stringify(ini));
    await payOn(r.j.url);
    const ap = (await pool.query("select * from autopay where user_id=$1", [S.ben.id])).rows[0];
    ok(ap && ap.provider === "paystack" && ap.merchant_id === row.subaccount && ap.pay_email === "ben@ps.test" && ap.card_label === "Visa •••• 4081" && /^AUTH_/.test(pfm.open(ap.token)) && !/AUTH_/.test(ap.token),
      "his card is kept: the reusable authorization, sealed, never a card number: " + JSON.stringify(ap && [ap.provider, ap.card_label, ap.pay_email]));
    p = await pay(S.ben); ok(p.owedCents === 0 && p.autopay.on && p.autopay.card === "Visa •••• 4081" && p.autopay.provider === "paystack", "he's paid up, and his Pay sheet says his card pays automatically");
    ok(to("ben@ps.test", m0).some((x) => x.subject === "Your fees are paid automatically" && /saved with Paystack/.test(x.text)), "he's told it's on");
    // Next month (his payment taken away, as if it's a new month): the job charges his saved card.
    const benPay = (await pool.query("select id from payments where user_id=$1 and status='confirmed' and source='paystack'", [S.ben.id])).rows[0].id;
    await pool.query("delete from payments where id=$1", [benPay]); await pool.query("update gyms set autopay_day=null where id=$1", [gym]);
    m0 = sink.mails.length; const c0 = charges().length;
    await jobs.autopay({ hour: 9 }); await wait(500);
    const ch = charges().slice(c0);
    ok(ch.length === 1 && ch[0].body.authorization_code === pfm.open(ap.token) && ch[0].body.email === "ben@ps.test" && ch[0].body.amount === 85000 && ch[0].body.currency === "ZAR" && ch[0].body.subaccount === row.subaccount && ch[0].body.transaction_charge === 1700 && ch[0].body.bearer === "subaccount",
      "the monthly job charges his saved card what he owes, with the same split: " + JSON.stringify(ch.map((x) => x.body)));
    const ac = (await pool.query("select * from autopay_charges where user_id=$1 order by id desc limit 1", [S.ben.id])).rows[0];
    ok(ac.status === "paid" && ac.provider === "paystack" && ac.ref === ch[0].body.reference && (await pay(S.ben)).owedCents === 0, "and records it as paid: " + JSON.stringify(ac && [ac.status, ac.provider]));
    ok(to("ben@ps.test", m0).some((x) => /^Receipt: R/.test(x.subject) && /Paystack reference/.test(x.text)), "with a receipt");
    await pool.query("update gyms set autopay_day=null where id=$1", [gym]); await jobs.autopay({ hour: 9 }); ok(charges().length === c0 + 1, "the next run charges nothing more");
    await ps.hook("charge.success", ps.verifyData(ps.txs.get(ac.ref))); await wait(300);
    ok((await pool.query("select count(*)::int as n from payments where reference=$1", [ac.ref])).rows[0].n === 1, "Paystack's webhook for the charge changes nothing (recorded once)");
    // A declined card
    await pool.query("delete from payments where user_id=$1 and reference=$2", [S.ben.id, ac.ref]); await pool.query("delete from autopay_charges where user_id=$1", [S.ben.id]); await pool.query("update gyms set autopay_day=null where id=$1", [gym]);
    ps.mode[pfm.open(ap.token)] = "fail"; m0 = sink.mails.length;
    await jobs.autopay({ hour: 9 }); await wait(400);
    const fc = (await pool.query("select * from autopay_charges where user_id=$1 order by id desc limit 1", [S.ben.id])).rows[0];
    ok(fc.status === "failed" && /Insufficient/.test(fc.error) && to("ben@ps.test", m0).some((x) => x.subject === "Your card payment didn't go through") && to("ann@ps.test", m0).some((x) => x.subject === "An automatic card payment didn't go through"),
      "a declined card: Ben and the head coach are told: " + JSON.stringify(fc && [fc.status, fc.error]));
    // No answer from Paystack: never charged again; asked about later (the job), and recorded when Paystack says it went through
    await pool.query("delete from autopay_charges where user_id=$1", [S.ben.id]); await pool.query("update gyms set autopay_day=null where id=$1", [gym]);
    ps.mode[pfm.open(ap.token)] = "down"; const c1 = charges().length;
    await jobs.autopay({ hour: 9 }); await wait(300);
    const dc = (await pool.query("select * from autopay_charges where user_id=$1 order by id desc limit 1", [S.ben.id])).rows[0];
    ok(charges().length === c1 + 1 && dc.status === "charging" && /didn't answer|trouble/.test(dc.error), "Paystack doesn't answer: the charge waits (never tried twice): " + JSON.stringify(dc && [dc.status, dc.error]));
    ps.mode[pfm.open(ap.token)] = undefined;
    const t = ps.txs.get(dc.ref) || (ps.txs.set(dc.ref, { id: 991, reference: dc.ref, amount: dc.amount_cents, currency: "ZAR", subaccount: row.subaccount, email: "ben@ps.test", status: "abandoned" }), ps.txs.get(dc.ref));
    ps.succeed(dc.ref); await pool.query("update paystack_checkouts set created_at=now()-interval '20 minutes' where reference=$1", [dc.ref]);
    await pool.query("update gyms set autopay_day=null where id=$1", [gym]); await jobs.autopay({ hour: 9 }); await wait(300);
    ok(t && (await pool.query("select status from autopay_charges where id=$1", [dc.id])).rows[0].status === "paid" && charges().length === c1 + 1, "the job asks Paystack later, and records it once it says it went through (no second charge)");
    // Stop, in one tap
    r = await S.ben("DELETE", "/me/autopay"); ok(r.s === 200 && r.j.stopped === 1 && (await pay(S.ben)).autopay.on === false, "Stop works as before");
    r = await S.ben("POST", "/me/autopay/undo", {}); ok(r.s === 200 && (await pay(S.ben)).autopay.on, "and Undo");

    // ---------- refunds ----------
    const amyPay = (await pool.query("select id from payments where reference=$1", [ref1])).rows[0].id;
    ok((await co2("POST", `/coach/payments/${amyPay}/refund`, { amountCents: 10000 })).s === 403 && (await S.amy("POST", `/coach/payments/${amyPay}/refund`, {})).s === 403, "only the head coach refunds");
    r = await coach("POST", `/coach/payments/${amyPay}/refund`, { amountCents: 90000 }); ok(r.s === 400, "not more than was paid");
    r = await coach("POST", `/coach/payments/${amyPay}/refund`, { amountCents: 10000 });
    const rf = ps.refunds.slice(-1)[0];
    ok(r.s === 200 && r.j.refund.status === "pending" && rf.transaction.reference === ref1 && rf.amount === 10000, "a part refund of R100 goes to Paystack for that payment: " + JSON.stringify(r.j));
    let pp = (await coach("GET", "/coach/payments")).j.payments.find((x) => x.id === String(amyPay));
    ok(pp.amountCents === 85000 && pp.refundPending, "until Paystack says it's done, the payment shows a refund on its way");
    m0 = sink.mails.length;
    st = await ps.hook("refund.processed", { id: rf.id, transaction_reference: ref1, amount: 10000, currency: "ZAR", status: "processed" }); await wait(300);
    pp = (await pool.query("select * from payments where id=$1", [amyPay])).rows[0];
    ok(pp.amount_cents === 75000 && pp.refunded_cents === 10000 && pp.status === "confirmed" && /Refunded R/.test(pp.note) && (await pay(S.amy)).owedCents === 10000, "Paystack says it's done: R100 comes off what Amy paid (she owes R100 again)");
    ok(to("ann@ps.test", m0).some((x) => x.subject === "A card refund went through") && to("amy@ps.test", m0).some((x) => /^Refund: R/.test(x.subject)), "the head coach and Amy are told");
    await ps.hook("refund.processed", { id: rf.id, transaction_reference: ref1, amount: 10000, currency: "ZAR", status: "processed" }); await wait(300);
    ok((await pool.query("select amount_cents from payments where id=$1", [amyPay])).rows[0].amount_cents === 75000, "the same webhook twice: refunded once");
    r = await coach("POST", `/coach/payments/${amyPay}/refund`, {}); const rf2 = ps.refunds.slice(-1)[0];
    ok(r.s === 200 && rf2.amount === 75000, "Refund all: the rest");
    ok((await coach("POST", `/coach/payments/${amyPay}/refund`, {})).s === 409, "a payment can't be refunded twice while one is on its way");
    await ps.hook("refund.processed", { id: rf2.id, transaction_reference: ref1, amount: 75000, currency: "ZAR", status: "processed" }); await wait(300);
    ok((await pool.query("select status from payments where id=$1", [amyPay])).rows[0].status === "refunded" && (await pay(S.amy)).owedCents === 85000, "refunded in full: it no longer counts, and Amy owes her fees again");
    // a refund that fails
    const caraPay = (await pool.query("select id, reference from payments where user_id=$1 and source='paystack'", [S.cara.id])).rows[0];
    r = await coach("POST", `/coach/payments/${caraPay.id}/refund`, { amountCents: 5000 }); const rf3 = ps.refunds.slice(-1)[0]; m0 = sink.mails.length;
    await ps.hook("refund.failed", { id: rf3.id, transaction_reference: caraPay.reference, amount: 5000, status: "failed" }); await wait(300);
    ok((await pool.query("select status from paystack_refunds where ps_id=$1", [String(rf3.id)])).rows[0].status === "failed" && to("ann@ps.test", m0).some((x) => x.subject === "A card refund didn't go through"), "a failed refund: the head coach is told, nothing changes");
    r = await admin("GET", "/admin/overview"); ok(r.j.system.paystack.refundsFailed.length === 1, "and the team sees it");
    r = await admin("POST", `/admin/paystack/refund/${r.j.system.paystack.refundsFailed[0].id}/seen`, {}); ok(r.s === 200 && !(await admin("GET", "/admin/overview")).j.system.paystack.refundsFailed.length, "until marked done");

    // ---------- chargebacks ----------
    m0 = sink.mails.length;
    const dsp = { id: 5551, refund_amount: 250000, currency: "ZAR", status: "awaiting-merchant-feedback", due_at: "2026-12-01T10:00:00.000Z", transaction: { reference: caraPay.reference, amount: 250000 } };
    await ps.hook("charge.dispute.create", dsp); await wait(300);
    ok((await pool.query("select dispute from payments where id=$1", [caraPay.id])).rows[0].dispute === "open" && to("ann@ps.test", m0).some((x) => x.subject === "A member disputed a card payment" && /1 December/.test(x.text))
      && to("boss@jitsflow.test", m0).some((x) => /Chargeback at Stack BJJ/.test(x.subject)), "a chargeback: the payment is marked Disputed, the head coach and the team are told what to do");
    m0 = sink.mails.length; await ps.hook("charge.dispute.create", dsp); await wait(200); ok(!to("ann@ps.test", m0).length, "told once");
    ok((await coach("GET", "/coach/payments")).j.payments.find((x) => x.id === String(caraPay.id)).dispute === "open", "Money shows it");
    r = await admin("GET", "/admin/overview"); ok(r.j.system.paystack.disputes.some((d) => d.id === "5551" && d.gym === "Stack BJJ"), "the team's dashboard shows it");
    await ps.hook("charge.dispute.resolve", { ...dsp, status: "resolved", resolution: "declined" }); await wait(300);
    ok((await pool.query("select dispute, status from payments where id=$1", [caraPay.id])).rows[0].dispute === "won", "resolved for the gym: won, still paid");

    // ---------- the bank account changes: checked again ----------
    m0 = sink.mails.length;
    r = await coach("PUT", "/coach/paystack", { ...good, bankCode: "250655", account: "62012345678" });
    ok(r.s === 200 && r.j.paystack.status === "pending_verification" && r.j.paystack.last4 === "5678" && ps.calls.filter((c) => c.method === "PUT" && /^\/subaccount\//.test(c.path)).length === 1, "new bank details update the same subaccount, and wait to be checked again");
    ok((await pay(S.amy)).card === false && to("boss@jitsflow.test", m0).some((x) => /Card payouts to verify/.test(x.subject)), "card payments pause until the team verifies it again");
    r = await admin("POST", `/admin/paystack/gyms/${gym}/verify`, {}); ok(r.s === 200 && (await pay(S.amy)).card === true, "verified again: back on");

    // ---------- JitsFlow moves from Paystack's test key to its live key ----------
    // Test-mode subaccounts and saved cards don't exist in live mode: each gym's payout account is made again in live mode from its
    // saved details (verified stays verified), test cards stop quietly (no "declined" emails), and members pay by card at once.
    {
      const LIVE = "sk_live_" + "e".repeat(40), psl = await startFakePaystack({ secret: LIVE });
      const before = (await pool.query("select paystack from gyms where id=$1", [gym])).rows[0].paystack;
      ok(before.mode === "test" && before.status === "active", "a payout account made on the test key says so: " + before.mode);
      // Accounts saved before the mode was recorded count as test ones.
      await pool.query("update gyms set paystack = paystack - 'mode' where id=$1", [gym]);
      const on0 = (await pool.query("select count(*)::int as n from autopay where gym_id=$1 and provider='paystack' and stopped_at is null", [gym])).rows[0].n;
      for (const s0 of srvs) s0.kill(); await wait(300);
      const lport = port + 100; psl.setApp(`http://127.0.0.1:${lport}`); const m1 = sink.mails.length;
      srvs.push(start({ ...env, PORT: String(lport), PAYSTACK_SECRET_KEY: LIVE, PAYSTACK_API_URL: psl.url })); await up(lport);
      let after = null; for (let i = 0; i < 40; i++) { after = (await pool.query("select paystack from gyms where id=$1", [gym])).rows[0].paystack; if (after.mode === "live") break; await wait(150); }
      ok(after.mode === "live" && after.subaccount !== before.subaccount && after.prevSubaccount === before.subaccount && psl.subs.has(after.subaccount) && after.status === "active" && after.verifiedAt,
        "on the live key, the gym's payout account is made again in live mode, still verified: " + JSON.stringify({ mode: after.mode, status: after.status }));
      const sub = psl.calls.find((c) => c.method === "POST" && c.path === "/subaccount");
      ok(sub && sub.body.account_number === "62012345678" && sub.body.settlement_bank === before.bankCode && sub.body.business_name === before.business, "from the details already saved");
      ok(on0 > 0 && !(await pool.query("select 1 from autopay where gym_id=$1 and provider='paystack' and stopped_at is null", [gym])).rows[0], `test-mode saved cards stop (${on0})`);
      ok(!sink.mails.slice(m1).some((x) => /declined|didn't go through/i.test(x.subject + " " + (x.text || ""))), "and nobody gets a declined email");
      const lb = `http://127.0.0.1:${lport}/api`, amyL = client(lb);
      r = await amyL("POST", "/auth/login", { email: "amy@ps.test", password: "studentpass1" });
      const ap = (await amyL("GET", "/me/pay")).j.pay;
      ok(r.s === 200 && ap.card === true && !(ap.autopay && ap.autopay.on), "members can pay by card on the live key straight away (and are offered to save a card again)");
      r = await amyL("POST", "/me/pay/paystack", { amountCents: 85000 });
      ok(r.s === 200 && psl.calls.filter((c) => c.path === "/transaction/initialize").slice(-1)[0].body.subaccount === after.subaccount, "a checkout goes to the live payout account: " + r.s + " " + JSON.stringify(r.j));
      const coachLive = client(lb); r = await coachLive("POST", "/auth/login", { email: "ann@ps.test", password: "coachpass1" });
      r = await coachLive("PUT", "/coach/paystack", { ...good, bankCode: "250655", account: "62012345678" });
      ok(r.s === 200 && r.j.same === true && !psl.calls.some((c) => c.method === "PUT"), "saving the same details again on the live key: nothing changes, still verified: " + JSON.stringify(r.j));
      const runs = psl.calls.filter((c) => c.method === "POST" && c.path === "/subaccount").length;
      process.env.PAYSTACK_SECRET_KEY = LIVE; process.env.PAYSTACK_API_URL = psl.url;
      ok((await jobs.psMove()) === 0 && psl.calls.filter((c) => c.method === "POST" && c.path === "/subaccount").length === runs, "done once: the jobs don't make it again");
      process.env.PAYSTACK_SECRET_KEY = SECRET; process.env.PAYSTACK_API_URL = ps.url;
      psl.close();
    }
  } catch (e) { fail++; fails.push("crashed: " + (e.stack || e.message)); }
  finally { for (const s of srvs) s.kill(); await pool.end(); sink.close(); ps.close(); }
  console.log(`paystack: ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log("  FAIL", f);
  if (fail && process.env.SHOW_LOGS) console.log(logs.join(""));
  process.exit(fail ? 1 : 0);
})();
