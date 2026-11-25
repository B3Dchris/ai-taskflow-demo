// Members' fees, batch 2 of the payments review: a card refund that failed shows (with why, Try again, and on Home) and a refund is
// sent once however often it's tapped; a chargeback says what's at risk, by when and what happens next (and stays on the team's
// dashboard while it's open); a proof marked Not received says why, with Undo, and the member is told (in the app and by email);
// a confirmed payment has Undo and sends the member a receipt; member and coach money screens refresh themselves; and coming back
// from Paystack's checkout says what really happened (checking, paid, declined, cancelled, or still processing).
// Usage: DATABASE_URL=postgres://.../<something>test node tests/payfixes2.js   (wipes that database; SHOTS=<dir> also saves screenshots)
const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg");
const { chromium, devices } = require("playwright");
const { startMailSink } = require("./fixture-gym"); const { startFakePaystack } = require("./fake-paystack");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(base) {
  let cookie = "";
  const c = async (method, url, body, key) => {
    const h = {}; if (cookie) h.cookie = cookie; if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; } if (key) h["x-jf-key"] = key;
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = m[1] ? "jf_s=" + m[1] : ""; }
    let j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j };
  };
  c.cookie = () => cookie.replace(/^jf_s=/, "");
  return c;
}
const SECRET = "sk_test_" + "b".repeat(40), TELL = 2500, SHOTS = process.env.SHOTS || "";
const shot = async (pg, name, sel) => { if (!SHOTS) return; require("fs").mkdirSync(SHOTS, { recursive: true });
  if (sel) await pg.evaluate((q) => { const x = document.querySelector(q); if (x) x.scrollIntoView({ block: "start" }); }, sel); await pg.waitForTimeout(200); await pg.screenshot({ path: path.join(SHOTS, name) }); };

(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop schema public cascade; create schema public");
  const sink = await startMailSink(), ps = await startFakePaystack({ secret: SECRET });
  const port = 9700 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${port}`, base = BASE + "/api"; ps.setApp(BASE);
  const env = { ...process.env, DATABASE_URL: DB, PORT: String(port), APP_URL: BASE, RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, MAIL_GAP_MS: "0",
    PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_URL: ps.url, JF_PLAN_CARD_TEST: "1", JF_ADMIN_EMAILS: "boss@pf2.test", JF_PAY_TELL_MS: String(TELL) };
  delete env.ANTHROPIC_API_KEY; delete env.PAYFAST_MERCHANT_ID; delete env.JF_MEMBER_PAYMENTS; delete env.PAYSTACK_FEE_BEARER;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + "/healthz"); break; } catch (e) { await wait(150); } }
  const to = (addr, from = 0) => sink.mails.slice(from).filter((m) => m.to[0] === addr);
  let b;
  try {
    // ---------- a gym that takes cards, its head coach, the team, and members ----------
    const A = client(base); let r = await A("POST", "/auth/start-gym", { gym: "Alpha BJJ", name: "Coach Ann", email: "ann@pf2.test", password: "coachpass1", timezone: "Africa/Johannesburg" });
    const gym = Number(r.j.me.gym.id), code = r.j.me.gym.studentCode;
    const admin = client(base); await admin("POST", "/auth/register", { name: "Boss Admin", email: "boss@pf2.test", password: "adminpass1" });
    await pool.query("update users set email_verified_at=now(), email_verified_for=email where email='boss@pf2.test'");
    const plan = (await A("POST", "/coach/plans", { name: "Adults", priceCents: 85000, period: "month" })).j.plan.id;
    await A("PATCH", "/coach/gym/pay", { holder: "Alpha BJJ", bank: "FNB", account: "62000000000", branch: "250655", dueDay: 1 });
    await pool.query("update gyms set paystack=$2 where id=$1", [gym, { subaccount: "ACCT_alpha", status: "active", mode: "test", bankName: "FNB", last4: "0000", holder: "Alpha BJJ", business: "Alpha BJJ" }]);
    const M = {};
    for (const k of ["amy", "ben", "cara", "dan", "eve", "fay", "gus", "hal", "ivy"]) {
      const c = client(base), x = await c("POST", "/auth/register", { code, name: `${k[0].toUpperCase()}${k.slice(1)} Member`, email: `${k}@pf2.test`, password: "studentpass1" });
      c.id = String(x.j.me.id); c.email = `${k}@pf2.test`; M[k] = c; await A("PATCH", `/coach/students/${c.id}`, { planId: plan });
    }
    const pay = async (c) => (await c("GET", "/me/pay")).j.pay;
    const payments = async () => (await A("GET", "/coach/payments")).j.payments;
    // A member pays by card on Paystack's checkout (the stand-in): its webhook records it.
    const cardPay = async (c, cents = 85000) => { const j = (await c("POST", "/me/pay/paystack", { amountCents: cents })).j; await fetch(`${ps.url}/checkout/${j.url.split("/checkout/")[1]}/pay`, { method: "POST", redirect: "manual" }); await wait(500);
      return (await pool.query("select * from payments where reference=$1", [j.reference])).rows[0]; };
    const amyPay = await cardPay(M.amy), benPay = await cardPay(M.ben), caraPay = await cardPay(M.cara), halPay = await cardPay(M.hal);
    ok(amyPay && benPay && caraPay && halPay && amyPay.status === "confirmed", "four card payments recorded");

    // ---------- 1. a refund that fails shows, with why, until it's tried again or dismissed ----------
    r = await A("POST", `/coach/payments/${amyPay.id}/refund`, { amountCents: 10000 }); let rf = ps.refunds.slice(-1)[0];
    ok(r.s === 200 && rf.amount === 10000, "a R100 refund goes to Paystack");
    let pp = (await payments()).find((x) => x.id === String(amyPay.id));
    ok(pp.refunds.length === 1 && pp.refunds[0].status === "pending" && pp.refundLeftCents === 75000 && pp.refundPending, "while it's on its way it's listed, and what's left to refund leaves it out: " + JSON.stringify(pp.refunds));
    let m0 = sink.mails.length;
    await ps.hook("refund.failed", { id: rf.id, transaction_reference: amyPay.reference, amount: 10000, status: "failed", reason: "Merchant balance too low" }); await wait(400);
    pp = (await payments()).find((x) => x.id === String(amyPay.id));
    ok(pp.refunds[0].status === "failed" && pp.refunds[0].reason === "Merchant balance too low" && !pp.refunds[0].dismissed && pp.refundLeftCents === 85000 && !pp.refundPending,
      "Paystack says it failed: the payment carries it, with Paystack's reason, and the full amount is left to refund again: " + JSON.stringify(pp));
    ok(to("ann@pf2.test", m0).some((x) => x.subject === "A card refund didn't go through"), "the head coach is emailed too");
    r = await A("POST", `/coach/payments/${amyPay.id}/refund`, { amountCents: 20000 }); rf = ps.refunds.slice(-1)[0];
    pp = (await payments()).find((x) => x.id === String(amyPay.id));
    ok(r.s === 200 && pp.refunds.length === 2 && pp.refunds[0].dismissed && pp.refunds[1].status === "pending" && pp.refundLeftCents === 65000, "tried again: the failed one is dealt with, the new one is on its way");
    await ps.hook("refund.processed", { id: rf.id, transaction_reference: amyPay.reference, amount: 20000, status: "processed" }); await wait(400);
    pp = (await payments()).find((x) => x.id === String(amyPay.id));
    ok(pp.refunds.map((x) => x.status).join() === "failed,done" && pp.amountCents === 65000 && pp.refundLeftCents === 65000, "done: what's left counts the refunds done and on their way only: " + JSON.stringify([pp.refunds, pp.refundLeftCents]));
    // one that fails and is dismissed (the coach paid them back another way)
    r = await A("POST", `/coach/payments/${benPay.id}/refund`, { amountCents: 5000 }); rf = ps.refunds.slice(-1)[0];
    await ps.hook("refund.failed", { id: rf.id, transaction_reference: benPay.reference, amount: 5000, status: "failed", reason: "Card expired" }); await wait(400);
    const benRf = (await payments()).find((x) => x.id === String(benPay.id)).refunds[0];
    ok((await M.ben("POST", `/coach/payments/${benPay.id}/refunds/${benRf.id}/dismiss`, {})).s === 403, "only the head coach can dismiss it");
    r = await A("POST", `/coach/payments/${benPay.id}/refunds/${benRf.id}/dismiss`, {});
    ok(r.s === 200 && (await payments()).find((x) => x.id === String(benPay.id)).refunds[0].dismissed, "Dismiss: dealt with");
    // and one left failed, for Home
    r = await A("POST", `/coach/payments/${halPay.id}/refund`, { amountCents: 30000 }); rf = ps.refunds.slice(-1)[0];
    await ps.hook("refund.failed", { id: rf.id, transaction_reference: halPay.reference, amount: 30000, status: "failed", reason: "Insufficient balance" }); await wait(400);

    // ---------- 2. a refund is sent once ----------
    let n0 = ps.refunds.length;
    const both = await Promise.all([A("POST", `/coach/payments/${caraPay.id}/refund`, {}), A("POST", `/coach/payments/${caraPay.id}/refund`, {})]);
    ok(both.map((x) => x.s).sort().join() === "200,409" && ps.refunds.length === n0 + 1, "two taps at once (no key): one refund, the other is told it's on its way: " + both.map((x) => x.s) + " / " + (ps.refunds.length - n0));
    // undo that one (failed), for the chargeback below
    await ps.hook("refund.failed", { id: ps.refunds.slice(-1)[0].id, transaction_reference: caraPay.reference, amount: 85000, status: "failed", reason: "test" }); await wait(300);
    await pool.query("update paystack_refunds set coach_done_at=now() where payment_id=$1", [caraPay.id]);
    n0 = ps.refunds.length;
    const dup = await Promise.all([A("POST", `/coach/payments/${benPay.id}/refund`, { amountCents: 1000 }, "k-ben-1"), A("POST", `/coach/payments/${benPay.id}/refund`, { amountCents: 1000 }, "k-ben-1")]);
    ok(dup.every((x) => x.s === 200) && dup[0].j.refund.id === dup[1].j.refund.id && ps.refunds.length === n0 + 1, "the same tap sent twice (same key): the first answer twice, one refund: " + JSON.stringify(dup.map((x) => x.j)));
    // Paystack says no: nothing is kept on its way, and it can be tried again
    const ghost = (await pool.query("insert into payments(gym_id,user_id,amount_cents,paid_on,source,status,method,reference) values($1,$2,50000,current_date,'paystack','confirmed','card','jfp-not-at-paystack') returning id", [gym, M.eve.id])).rows[0].id;
    r = await A("POST", `/coach/payments/${ghost}/refund`, {});
    ok(r.s === 502 && /not found|not successful/i.test(r.j.error) && !(await pool.query("select 1 from paystack_refunds where payment_id=$1", [ghost])).rows[0], "Paystack refuses: the claim is let go, and the coach sees why: " + JSON.stringify(r.j));
    await pool.query("delete from payments where id=$1", [ghost]);

    // ---------- 3. a chargeback: what's at risk, by when, what happens next ----------
    m0 = sink.mails.length;
    const due = new Date(Date.now() + 7 * 864e5).toISOString();
    const dsp = { id: 7001, refund_amount: 85000, currency: "ZAR", status: "awaiting-merchant-feedback", due_at: due, transaction: { reference: caraPay.reference, amount: 85000 } };
    await ps.hook("charge.dispute.create", dsp); await wait(400);
    pp = (await payments()).find((x) => x.id === String(caraPay.id));
    ok(pp.chargeback && pp.chargeback.status === "open" && pp.chargeback.cents === 85000 && pp.chargeback.dueAt && pp.refundLeftCents === 85000, "Money's payment carries the chargeback: open, R850, Paystack's deadline: " + JSON.stringify(pp.chargeback));
    r = await A("POST", `/coach/payments/${caraPay.id}/refund`, {}); ok(r.s === 409 && /disput/i.test(r.j.error), "it can't be refunded while it's disputed: " + JSON.stringify(r.j));
    r = await admin("GET", "/admin/overview"); let dd = r.j.system.paystack.disputes.find((d) => d.id === "7001");
    ok(dd && dd.status !== "resolved", "the team's dashboard shows it");
    r = await admin("POST", "/admin/paystack/dispute/7001/seen", {});
    ok(r.s === 409 && (await admin("GET", "/admin/overview")).j.system.paystack.disputes.some((d) => d.id === "7001"), "and can't mark it done while it's open: it stays: " + JSON.stringify(r.j));
    await pool.query("update paystack_disputes set seen_at=now() where id='7001'"); // marked done before this fix
    ok((await admin("GET", "/admin/overview")).j.system.paystack.disputes.some((d) => d.id === "7001"), "an open one marked done before still shows");
    await pool.query("update paystack_disputes set seen_at=null where id='7001'");

    // ---------- 4. Not received: why, Undo, the member is told; Confirm: Undo and a receipt ----------
    const proof = async (c, cents = 85000) => (await pool.query("insert into payments(gym_id,user_id,amount_cents,paid_on,source,status,method) values($1,$2,$3,current_date,'student','pending','eft') returning id", [gym, c.id, cents])).rows[0].id;
    const notices = async (c) => (await c("GET", "/me/notices")).j.notices;
    let pid = await proof(M.dan, 65000); m0 = sink.mails.length;
    r = await A("PATCH", `/coach/payments/${pid}`, { status: "rejected", reason: "amount", reasonNote: "I can only see R500 from you" });
    ok(r.s === 200 && r.j.payment.status === "rejected" && r.j.payment.rejectReason === "amount" && r.j.payment.rejectNote === "I can only see R500 from you", "Not received, with why and a note");
    ok(!(await notices(M.dan)).some((n) => n.kind === "payment") && !to("dan@pf2.test", m0).length, "the member isn't told straight away (Undo comes first)");
    await wait(TELL + 1500);
    let nt = (await notices(M.dan)).find((n) => n.kind === "payment"), em = to("dan@pf2.test", m0)[0];
    ok(nt && /Payment not received/.test(nt.title) && /R\s?650/.test(nt.body) && /doesn't match/.test(nt.body) && /R500 from you/.test(nt.body), "then they get a notice in the app, with why and the note: " + JSON.stringify(nt));
    ok(em && /not received/i.test(em.subject) && /doesn't match/.test(em.text) && /R500 from you/.test(em.text) && /\/app\/\?pay=1/.test(em.html) && /Send a new proof/.test(em.html) && /gym-mail\/stop/.test(em.text), "and an email, with why and a button to send a new proof (and the stop link): " + (em ? em.text.slice(0, 500) : "none"));
    m0 = sink.mails.length; await wait(TELL + 500); ok(!to("dan@pf2.test", m0).length, "told once");
    ok((await payments()).some((x) => x.id === String(pid) && x.status === "rejected" && x.rejectReason === "amount"), "the coach still sees it in Payments, with why");
    ok((await A("GET", `/coach/students/${M.dan.id}`)).j.payments.some((x) => x.id === String(pid) && x.status === "rejected"), "and on the member's sheet");
    ok((await pay(M.dan)).payments.some((x) => x.id === String(pid) && x.status === "rejected" && x.rejectNote === "I can only see R500 from you"), "the member's own list says why");
    r = await A("PATCH", `/coach/payments/${pid}`, { status: "pending" });
    ok(r.s === 200 && r.j.payment.status === "pending" && !r.j.payment.rejectReason && !(await pool.query("select rejected_at from payments where id=$1", [pid])).rows[0].rejected_at, "Restore: back to being checked");
    // Undo straight away: never told
    const pid2 = await proof(M.eve); m0 = sink.mails.length;
    await A("PATCH", `/coach/payments/${pid2}`, { status: "rejected", reason: "arrived" }); await A("PATCH", `/coach/payments/${pid2}`, { status: "pending" });
    await wait(TELL + 1500);
    ok(!to("eve@pf2.test", m0).length && !(await notices(M.eve)).some((n) => n.kind === "payment"), "Undo straight after: the member hears nothing");
    // Confirm: a receipt a little later; Undo before it: none
    m0 = sink.mails.length;
    r = await A("PATCH", `/coach/payments/${pid2}`, { status: "confirmed" }); await A("PATCH", `/coach/payments/${pid2}`, { status: "pending" }); await wait(TELL + 1500);
    ok(!to("eve@pf2.test", m0).length, "confirmed then Undo: no receipt");
    r = await A("PATCH", `/coach/payments/${pid2}`, { status: "confirmed" }); ok(!to("eve@pf2.test", m0).length, "confirmed: no receipt straight away");
    await wait(TELL + 1500);
    let rc = to("eve@pf2.test", m0);
    ok(rc.length === 1 && /^Receipt: R\s?850/.test(rc[0].subject) && /Alpha BJJ received your payment of R\s?850/.test(rc[0].text) && /gym-mail\/stop/.test(rc[0].text), "a confirmed EFT payment: the member gets one receipt: " + (rc[0] ? rc[0].text.slice(0, 300) : "none"));
    await A("PATCH", `/coach/payments/${pid2}`, { status: "pending" }); await A("PATCH", `/coach/payments/${pid2}`, { status: "confirmed" }); await wait(TELL + 1500);
    ok(to("eve@pf2.test", m0).length === 1, "confirmed again later: still one receipt for that payment");
    // a bulk confirm: one receipt per member
    const g1 = await proof(M.fay, 40000), g2 = await proof(M.fay, 45000), g3 = await proof(M.gus, 85000); m0 = sink.mails.length;
    for (const id of [g1, g2, g3]) await A("PATCH", `/coach/payments/${id}`, { status: "confirmed" });
    await wait(TELL + 1500);
    ok(to("fay@pf2.test", m0).length === 1 && /R\s?850/.test(to("fay@pf2.test", m0)[0].subject) && to("gus@pf2.test", m0).length === 1, "three confirmed together: one receipt per member (Fay's for both of hers): " + to("fay@pf2.test", m0).map((x) => x.subject));
    // recorded by hand: a receipt too; stopped emails: none
    m0 = sink.mails.length; await A("POST", "/coach/payments", { userId: M.dan.id, amountCents: 85000, paidOn: new Date().toISOString().slice(0, 10), method: "cash" }); await wait(TELL + 1500);
    ok(to("dan@pf2.test", m0).length === 1 && /^Receipt/.test(to("dan@pf2.test", m0)[0].subject), "a payment recorded by hand: a receipt");
    await pool.query("insert into gym_mail_stops(gym_id,email,token,stopped_at) values($1,'gus@pf2.test','tok-gus-stopped-000000000',now()) on conflict (gym_id,email) do update set stopped_at=now()", [gym]);
    m0 = sink.mails.length; const g4 = await proof(M.gus, 10000); await A("PATCH", `/coach/payments/${g4}`, { status: "confirmed" }); await wait(TELL + 1500);
    ok(!to("gus@pf2.test", m0).length, "someone who stopped the gym's emails gets no receipt");
    // card payments still get their own receipt only (not a second one)
    ok(sink.mails.filter((x) => x.to[0] === "amy@pf2.test" && /^Receipt/.test(x.subject)).length === 1, "a card payment's receipt isn't sent twice");

    // ---------- 6. back from Paystack's checkout (API) ----------
    let co = (await M.eve("POST", "/me/pay/paystack", { amountCents: 50000 })).j;
    const init = ps.calls.filter((c) => c.path === "/transaction/initialize").slice(-1)[0].body;
    ok(init.metadata && init.metadata.cancel_action === BASE + "/app/?paid=cancel&reference=" + co.reference && /\/app\/\?paid=card$/.test(init.callback_url), "the checkout says where Cancel goes (the app, with a marker): " + JSON.stringify(init.metadata));
    let loc = (await fetch(`${ps.url}/checkout/${co.url.split("/checkout/")[1]}/cancel`, { method: "POST", redirect: "manual" })).headers.get("location");
    ok(/paid=cancel/.test(loc), "Cancel comes back with it: " + loc);
    r = await M.eve("POST", "/me/pay/paystack/check", { reference: co.reference }); ok(r.j.status === "cancelled" && !(await pay(M.eve)).cardProcessing, "asked about, it's cancelled, and nothing shows as processing");
    co = (await M.eve("POST", "/me/pay/paystack", { amountCents: 50000 })).j;
    await fetch(`${ps.url}/checkout/${co.url.split("/checkout/")[1]}/decline`, { method: "POST", redirect: "manual" });
    r = await M.eve("POST", "/me/pay/paystack/check", { reference: co.reference }); ok(r.j.status === "declined", "a declined card: declined: " + JSON.stringify(r.j));
    co = (await M.eve("POST", "/me/pay/paystack", { amountCents: 50000 })).j;
    await fetch(`${ps.url}/checkout/${co.url.split("/checkout/")[1]}/slow`, { method: "POST", redirect: "manual" });
    ok(!(await pay(M.eve)).cardProcessing, "a checkout they haven't come back from isn't shown as processing");
    r = await M.eve("POST", "/me/pay/paystack/check", { reference: co.reference }); let pe = await pay(M.eve);
    ok(r.j.status === "waiting" && pe.cardProcessing && pe.cardProcessing.cents === 50000, "Paystack still working on it: waiting, and /me/pay shows it as processing: " + JSON.stringify(pe.cardProcessing));
    let mo = (await A("GET", "/coach/money")).j.students.find((x) => x.id === M.eve.id);
    ok(mo.cardProcessing && mo.cardProcessing.cents === 50000, "the coach's Money shows it as processing too");
    ps.succeed(co.reference); await ps.hook("charge.success", ps.verifyData(ps.txs.get(co.reference))); await wait(500);
    ok(!(await pay(M.eve)).cardProcessing && !(await A("GET", "/coach/money")).j.students.find((x) => x.id === M.eve.id).cardProcessing, "once Paystack confirms it, it's paid, not processing");

    // ---------- in the app (iPhone 13) ----------
    b = await chromium.launch(); const errs = [];
    const phone = async (c, init) => { const ctx = await b.newContext({ ...devices["iPhone 13"] }); await ctx.addCookies([{ name: "jf_s", value: c.cookie(), url: BASE }]); if (init) await ctx.addInitScript(init);
      const p = await ctx.newPage(); p.on("pageerror", (e) => errs.push(e.message)); return p; };
    const ev = (pg, fn, arg) => pg.evaluate(fn, arg), toastTxt = (pg) => ev(pg, () => document.getElementById("toast").textContent);
    const appTxt = (pg) => ev(pg, () => document.getElementById("app").innerText), sheetTxt = (pg) => ev(pg, () => document.getElementById("sheet").innerText);

    // the head coach: Home and Money
    const cp = await phone(A); await cp.goto(BASE + "/app/#coach-home"); await cp.waitForTimeout(2000);
    let t = await appTxt(cp);
    ok(/Refund of R\s?300 to Hal failed: Insufficient balance/.test(t) && await ev(cp, () => !!document.querySelector('[id^="needrefund-"] [data-a="refundask"]')), "Home › Needs you: the failed refund, with why and Try again: " + t.slice(0, 600));
    await shot(cp, "home-needs.png", '[id^="needrefund-"]');
    ok(!/to Amy failed/.test(t) && !/to Ben failed/.test(t), "not the ones tried again or dismissed");
    ok(/Chargeback: R\s?850 from Cara/.test(t) && /answer by/.test(t), "and the open chargeback, with its deadline");
    await ev(cp, () => { COACH.moneyView = "payments"; coachGo("money"); }); await cp.waitForTimeout(800); t = await appTxt(cp);
    ok(/Refund of R\s?300 failed: Insufficient balance\. Nothing was refunded\./.test(t) && /Try again/.test(t), "Payments: the row says the refund failed, why, with Try again");
    ok(/Chargeback/.test(t) && /R\s?850 at risk/.test(t) && /answer by (\d+ \w+|\w+ \d+)/.test(t) && /Our team answers Paystack for you/.test(t), "a chargeback row: what's at risk, by when, and what happens next");
    ok(await ev(cp, (id) => !document.querySelector(`[data-a="refundask"][data-v="${id}"]`), String(caraPay.id)), "with no Refund while it's disputed");
    await shot(cp, "payments-card-rows.png", ".cbline");
    ok(await ev(cp, () => document.documentElement.scrollWidth <= 390), "no sideways scroll");
    await cp.tap(`[data-a="refundask"][data-v="${halPay.id}:retry"]`); await cp.waitForTimeout(400); t = await sheetTxt(cp);
    ok(/Refunds so far/i.test(t) && /Failed/.test(t) && /Insufficient balance/.test(t) && await ev(cp, () => document.getElementById("refund-amt").value === "300"), "Try again: the sheet shows the failed try and fills in its amount: " + (await ev(cp, () => document.getElementById("refund-amt").value)));
    await shot(cp, "refund-sheet-retry.png");
    n0 = ps.refunds.length;
    await ev(cp, () => { const btn = document.querySelector('[data-a="refundyes"]'); btn.click(); btn.click(); btn.click(); }); await cp.waitForTimeout(1500);
    ok(ps.refunds.length === n0 + 1 && /Refund sent to Paystack/.test(await toastTxt(cp)), "three fast taps on Refund: one refund: " + (ps.refunds.length - n0));
    await ev(cp, () => coachLoad("payments")); await cp.waitForTimeout(500);
    ok(!/Refund of R\s?300 to Hal failed/.test(await ev(cp, () => coachToday())), "tried again: off Home");
    await cp.tap(`[data-a="refundask"][data-v="${amyPay.id}"]`); await cp.waitForTimeout(400); t = await sheetTxt(cp);
    ok(/Refunded/.test(t) && /Failed/.test(t) && await ev(cp, () => document.getElementById("refund-amt").value === "650"), "the refund sheet lists earlier tries and fills in what's left (R650), not the full amount");
    await ev(cp, () => hideSheet());

    // Not received, in the sheet: why, then Undo
    const pid3 = await proof(M.dan, 30000); await ev(cp, () => coachLoad()); await cp.waitForTimeout(600);
    await ev(cp, (id) => popSheet(id), String(pid3)); await cp.waitForTimeout(300);
    ok(await ev(cp, () => [...document.querySelectorAll("#sheetbar button")].some((x) => x.textContent.trim() === "Not received") && !/Not a payment/.test(document.getElementById("sheetbar").innerText)), "Check payment: the button says Not received");
    await cp.tap('#sheetbar [data-a="poprej"]'); await cp.waitForTimeout(300);
    await cp.tap('#rejpick [data-a="rejwhy"][data-v="amount"]'); await shot(cp, "not-received-why.png");
    ok(await ev(cp, () => /Money hasn't arrived/.test(document.getElementById("rejpick").innerText) && /Wrong amount/.test(document.getElementById("rejpick").innerText) && /Not this member's/.test(document.getElementById("rejpick").innerText) && !!document.getElementById("rej-note")),
      "tapping it asks why (four reasons and a note), right there");
    ok(await ev(cp, (id) => COACH.payments.find((p) => p.id === id).status === "pending", String(pid3)), "nothing changes until a reason is picked");
    await cp.tap('#rejpick [data-a="rejwhy"][data-v="arrived"]'); await cp.tap('[data-a="rejgo"]'); await cp.waitForTimeout(900);
    ok(/Marked as not received\. We'll tell Dan why\./.test(await toastTxt(cp)) && await ev(cp, () => !!document.querySelector('#toast [data-a="toastact"]')), "then it's set aside, with Undo: " + (await toastTxt(cp)));
    ok((await pool.query("select status, reject_reason from payments where id=$1", [pid3])).rows[0].reject_reason === "arrived", "with the reason picked");
    await cp.tap('#toast [data-a="toastact"]'); await cp.waitForTimeout(900);
    ok((await pool.query("select status from payments where id=$1", [pid3])).rows[0].status === "pending" && /back under To check/.test(await toastTxt(cp)), "Undo: back to be checked");
    // greyed in Payments and on the member's sheet, with Restore
    await A("PATCH", `/coach/payments/${pid3}`, { status: "rejected", reason: "member" }); await ev(cp, () => coachLoad()); await cp.waitForTimeout(600);
    t = await appTxt(cp);
    ok(/Not received \(\d\)/i.test(t) && await ev(cp, (id) => { const r = document.querySelector(`[data-gone="${id}"]`); return !!r && r.classList.contains("gone") && /not this member's/.test(r.innerText) && !!r.querySelector('[data-a="payrestore"]'); }, String(pid3)),
      "Payments keeps it, greyed, with why and Restore: " + (await ev(cp, (id) => { const r = document.querySelector(`[data-gone="${id}"]`); return r ? r.outerHTML : "none"; }, String(pid3))));
    await shot(cp, "payments-not-received.png", "[data-gone]");
    await ev(cp, (id) => studentSheet(id), M.dan.id); await cp.waitForTimeout(800);
    ok(await ev(cp, (id) => !!document.querySelector(`#sheet [data-gone="${id}"] [data-a="payrestore"]`), String(pid3)), "and so does the member's sheet");
    await cp.tap(`#sheet [data-gone="${pid3}"] [data-a="payrestore"]`); await cp.waitForTimeout(1000);
    ok((await pool.query("select status from payments where id=$1", [pid3])).rows[0].status === "pending", "Restore puts it back to be checked");
    await ev(cp, () => hideSheet());
    // Confirm, with Undo
    await ev(cp, () => { COACH.moneyView = "month"; render(); }); await cp.waitForTimeout(300);
    await cp.tap(`.popcard[data-pop="${pid3}"] [data-a="popok"]`); await cp.waitForTimeout(900);
    ok(/Payment confirmed/.test(await toastTxt(cp)) && await ev(cp, () => /Undo/.test(document.querySelector('#toast [data-a="toastact"]').textContent)), "Confirm: an Undo toast");
    await cp.tap('#toast [data-a="toastact"]'); await cp.waitForTimeout(900);
    ok((await pool.query("select status from payments where id=$1", [pid3])).rows[0].status === "pending", "Undo: back to be checked");

    // ---------- 5. the coach's Money updates itself when they come back to the app ----------
    const pid4 = await proof(M.gus, 12300);
    ok(await ev(cp, (id) => !COACH.payments.some((p) => p.id === id), String(pid4)), "(a new proof the coach's app hasn't seen)");
    await ev(cp, () => { COACH.payAt = Date.now() - 60000; document.dispatchEvent(new Event("visibilitychange")); }); await cp.waitForTimeout(1200);
    ok(await ev(cp, (id) => COACH.payments.some((p) => p.id === id) && /R\s?123/.test(document.getElementById("app").innerText), String(pid4)), "back in the app after a while: Payments shows it without a reload");
    n0 = 0; await ev(cp, () => { window.__n = 0; const f = window.fetch; window.fetch = (...a) => { if (/\/coach\/payments$/.test(String(a[0]))) window.__n++; return f(...a); }; document.dispatchEvent(new Event("visibilitychange")); });
    await cp.waitForTimeout(600); ok(await ev(cp, () => window.__n === 0), "but not again within 30 seconds");
    await cp.context().close();

    // ---------- 5. the member's screens update themselves ----------
    const pid5 = await proof(M.ivy, 85000);
    const fp = await phone(M.ivy); await fp.goto(BASE + "/app/#me"); await fp.waitForTimeout(1800);
    await ev(fp, () => { if (!document.getElementById("sheet").hidden) hideSheet(); go("map"); }); await fp.waitForTimeout(1200);
    ok(await ev(fp, () => /^Checking$/.test((document.querySelector(".mapstrip .schk") || {}).innerText || "") && !document.querySelector("#duechip")), "the Map: a small Checking chip, no amount due");
    await fp.tap(".mapstrip .schk"); await fp.waitForTimeout(600);
    ok(await ev(fp, () => S.ui.sheet && S.ui.sheet.k === "mypay" && !!document.querySelector("#sheet .fd.checking")), "it opens the Pay sheet, with the month's dot in Checking"); await ev(fp, () => hideSheet());
    await A("PATCH", `/coach/payments/${pid5}`, { status: "rejected", reason: "arrived" });
    await ev(fp, () => go("me")); await fp.waitForTimeout(300); await ev(fp, () => { API.payAt = Date.now() - 60000; go("map"); }); await fp.waitForTimeout(1200);
    ok(await ev(fp, () => !document.querySelector(".mapstrip .schk") && /R\s?850 due · Pay/.test((document.querySelector("#duechip") || {}).innerText || "")), "the coach sets it aside, the member switches tabs: no longer Checking, without a reload");
    await A("POST", "/coach/payments", { userId: M.ivy.id, amountCents: 85000, paidOn: new Date().toISOString().slice(0, 10), method: "eft" });
    await fp.tap("#duechip"); await fp.waitForTimeout(1500);
    t = await sheetTxt(fp);
    await shot(fp, "member-paysheet-not-received.png", ".rejnote");
    ok(/You're paid up/.test(t) && /Not received/.test(t) && /hasn't arrived in your gym's account/.test(t), "opening Pay asks again: paid up, and the proof that wasn't received says why: " + t.slice(0, 300));
    await ev(fp, () => hideSheet());
    await A("PATCH", `/coach/payments/${pid5}`, { status: "pending" });
    await ev(fp, () => { API.payAt = Date.now() - 60000; document.dispatchEvent(new Event("visibilitychange")); }); await fp.waitForTimeout(1200);
    ok(await ev(fp, (id) => API.pay.payments.some((p) => p.id === id && p.status === "pending"), String(pid5)), "coming back to the app asks again");
    await fp.context().close();

    // ---------- 6. back from Paystack's checkout, in the app ----------
    const W = "window.jfPsWaits=[400,400,400,400];";
    // paid: "Checking your payment…", then Paid
    await pool.query("delete from payments where user_id=$1", [M.gus.id]);
    let gp = await phone(M.gus, W); await gp.goto(BASE + "/app/#me"); await gp.waitForTimeout(1500);
    await ev(gp, () => { if (!document.getElementById("sheet").hidden) hideSheet(); go("me"); return loadPay().then(() => myPaySheet()); }); await gp.waitForTimeout(400);
    await gp.fill("#card-amt", "850");
    await Promise.all([gp.waitForURL(/\/checkout\//, { timeout: 8000 }), gp.tap('#paymethods [data-a="paycard"][data-v="cc"]')]);
    await Promise.all([gp.waitForURL(/\/app\//, { timeout: 8000 }), gp.tap("#pay")]); await gp.waitForTimeout(700);
    const first = await toastTxt(gp);
    ok(/Checking your payment…|Paid\. Thanks!/.test(first) && !/Payment received/.test(first), "back from paying: “Checking your payment…”, not a premature “received”: " + first);
    await gp.waitForTimeout(1500); ok(/Paid\. Thanks!/.test(await toastTxt(gp)), "then Paid, once Paystack says so");
    // declined
    await ev(gp, () => loadPay().then(() => myPaySheet())); await gp.waitForTimeout(300);
    await gp.fill("#card-amt", "100");
    await Promise.all([gp.waitForURL(/\/checkout\//, { timeout: 8000 }), gp.tap('#paymethods [data-a="paycard"][data-v="cc"]')]);
    await Promise.all([gp.waitForURL(/\/app\//, { timeout: 8000 }), gp.tap("#decline")]); await gp.waitForTimeout(1500);
    ok(/declined/.test(await toastTxt(gp)) && /Nothing was charged/.test(await toastTxt(gp)), "a declined card: says so, and that nothing was charged: " + (await toastTxt(gp)));
    // cancelled
    await ev(gp, () => loadPay().then(() => myPaySheet())); await gp.waitForTimeout(300);
    await gp.fill("#card-amt", "100");
    await Promise.all([gp.waitForURL(/\/checkout\//, { timeout: 8000 }), gp.tap('#paymethods [data-a="paycard"][data-v="cc"]')]);
    await Promise.all([gp.waitForURL(/\/app\//, { timeout: 8000 }), gp.tap("#cancel")]); await gp.waitForTimeout(1500);
    ok(/Payment cancelled\. Nothing was charged\./.test(await toastTxt(gp)) && await ev(gp, () => S.ui.sheet && S.ui.sheet.k === "mypay" && !document.getElementById("sheet").hidden && !/[?&](paid|reference)=/.test(location.search)),
      "Cancel: “Payment cancelled. Nothing was charged.”, and the Pay sheet opens again: " + (await toastTxt(gp)));
    await shot(gp, "member-cancelled.png");
    // slow: still processing after the checks
    await pool.query("delete from payments where user_id=$1", [M.gus.id]);
    await ev(gp, () => loadPay().then(() => myPaySheet())); await gp.waitForTimeout(300);
    await gp.fill("#card-amt", "200");
    await Promise.all([gp.waitForURL(/\/checkout\//, { timeout: 8000 }), gp.tap('#paymethods [data-a="paycard"][data-v="cc"]')]);
    await Promise.all([gp.waitForURL(/\/app\//, { timeout: 8000 }), gp.tap("#slow")]); await gp.waitForTimeout(700);
    ok(/Checking your payment…/.test(await toastTxt(gp)), "Paystack still working on it: “Checking your payment…”");
    await gp.waitForTimeout(3500);
    ok(/still processing/.test(await toastTxt(gp)), "after the checks: it says it's still processing: " + (await toastTxt(gp)));
    await ev(gp, () => { if (!document.getElementById("sheet").hidden) hideSheet(); go("map"); }); await gp.waitForTimeout(1200);
    ok(await ev(gp, () => /^Checking$/.test((document.querySelector(".mapstrip .schk") || {}).innerText || "") && !document.querySelector("#duechip")), "the Map shows a card payment on its way as Checking, not as due");
    await shot(gp, "member-fees-processing.png", ".mapstrip");
    await gp.tap(".mapstrip .schk"); await gp.waitForTimeout(800);
    t = await sheetTxt(gp); ok(/Card payment processing \(R\s?200/.test(t) && /it shows here once Paystack confirms/i.test(t), "the Pay sheet shows it as processing: " + t);
    ok(/Card payment processing/.test(await sheetTxt(gp)) && /no need to pay again/i.test(await sheetTxt(gp)), "so does the Pay sheet");
    await gp.context().close();
    const cp2 = await phone(A); await cp2.goto(BASE + "/app/#coach-money"); await cp2.waitForTimeout(2200);
    await ev(cp2, () => { const d = document.querySelector('details[data-g="m-rest"]'); if (d) d.open = true; }); await cp2.waitForTimeout(300); t = await appTxt(cp2);
    await shot(cp2, "coach-money-processing.png", ".mrow");
    ok(/card payment of R\s?200 processing/.test(t) && /Processing/.test(t), "the coach's Money shows it as processing too");
    await cp2.context().close();
    ok(!errs.length, "no page errors: " + errs.join(" | "));

    // ---------- 3. a chargeback lost: no longer paid, the member owes it again, and both are told plainly ----------
    m0 = sink.mails.length;
    await ps.hook("charge.dispute.resolve", { ...dsp, status: "resolved", resolution: "merchant-accepted" }); await wait(500);
    const row = (await pool.query("select status, dispute from payments where id=$1", [caraPay.id])).rows[0], pc = await pay(M.cara);
    ok(row.status === "refunded" && row.dispute === "lost" && pc.owedCents === 85000, "lost: the payment no longer counts, and Cara owes R850 again: " + JSON.stringify([row, pc.owedCents]));
    ok(to("ann@pf2.test", m0).some((x) => /went back to the member/.test(x.subject)) && (await notices(M.cara)).some((n) => /went back to you/.test(n.title) && /owed again/.test(n.body)), "the head coach is emailed and Cara gets a plain notice in the app");
    ok(pc.payments.some((x) => x.dispute === "lost"), "Cara's own list marks it");
    pp = (await payments()).find((x) => x.id === String(caraPay.id)); ok(pp.chargeback.status === "lost", "Money says the chargeback was lost");
    r = await admin("POST", "/admin/paystack/dispute/7001/seen", {});
    ok(r.s === 200 && !(await admin("GET", "/admin/overview")).j.system.paystack.disputes.some((d) => d.id === "7001"), "resolved: now the team can mark it done");
  } catch (e) { fail++; fails.push("crashed: " + (e.stack || e.message)); }
  finally { if (b) await b.close(); srv.kill(); await pool.end(); sink.close(); ps.close(); }
  console.log(`payfixes2: ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log("  FAIL", f);
  process.exit(fail ? 1 : 0);
})();
