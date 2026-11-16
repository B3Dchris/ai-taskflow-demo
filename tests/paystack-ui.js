// Paystack in real browsers (iPhone 13): the head coach adds the gym's bank account, the JitsFlow team verifies it, a member pays
// by card on (a stand-in for) Paystack's checkout and comes back paid, saves their card, the monthly job charges it, and the head
// coach refunds a payment. Paystack is stood in for (tests/fake-paystack.js); nothing here talks to Paystack.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/paystack-ui.js   (wipes that database)
// SHOTS=<folder>: also saves screenshots of the coach's card, the team's verify list and the member's Pay sheet there.
const { chromium, devices } = require("playwright"); const { spawn } = require("child_process"); const path = require("path"); const fs = require("fs"); const { Pool } = require("pg");
const { startMailSink } = require("./fixture-gym"); const { startFakePaystack } = require("./fake-paystack");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = "sk_test_" + "e".repeat(40), SHOTS = process.env.SHOTS || "";
function client(base) {
  let cookie = "";
  const c = async (method, url, body) => {
    const h = {}; if (cookie) h.cookie = cookie; if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; }
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = m[1] ? "jf_s=" + m[1] : ""; }
    let j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j };
  };
  c.token = () => cookie.replace(/^jf_s=/, "");
  return c;
}
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists paystack_checkouts, paystack_refunds, paystack_disputes, payfast_ops, card_checkouts, payfast_flags, assistant_proposals, autopay_charges, autopay, class_skips, plan_breaks, notices, left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const sink = await startMailSink(), ps = await startFakePaystack({ secret: SECRET });
  const port = 9600 + Math.floor(Math.random() * 90), URL = `http://localhost:${port}`, base = URL + "/api"; ps.setApp(`http://127.0.0.1:${port}`);
  const common = { DATABASE_URL: DB, RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, APP_URL: URL, MAIL_GAP_MS: "0", JF_ADMIN_EMAILS: "boss@jitsflow.test", PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_URL: ps.url };
  const env = { ...process.env, ...common, PORT: String(port), JF_PLAN_CARD_TEST: "1" }; delete env.ANTHROPIC_API_KEY; delete env.PAYFAST_MERCHANT_ID; delete env.JF_PAYSTACK_LIVE; delete env.JF_MEMBER_PAYMENTS;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60; i++) { try { await fetch(URL + "/healthz"); break; } catch (e) { await wait(150); } }
  Object.assign(process.env, common);
  const jobs = require("../backend/api").makeApi(pool, {}).jobs;
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const b = await chromium.launch(), errs = [];
  const phone = async (c) => { const ctx = await b.newContext({ ...devices["iPhone 13"] }); if (c) await ctx.addCookies([{ name: "jf_s", value: c.token(), url: URL }]); const p = await ctx.newPage(); p.on("pageerror", (e) => errs.push(e.message)); return p; };
  const ev = (p, f, a) => p.evaluate(f, a), toast = (p) => ev(p, () => document.getElementById("toast").textContent);
  const wide = async (p, label) => ok(await ev(p, () => document.documentElement.scrollWidth <= 390), label + ": no sideways scroll");
  // The phone's screen with that part scrolled to the top (a sheet: from its top).
  const shot = async (p, name, sel) => { if (!SHOTS) return;
    await ev(p, (q) => { const x = document.querySelector(q); if (!x) return; if (q === "#sheet") { x.querySelectorAll("*").forEach((y) => { if (y.scrollTop) y.scrollTop = 0; }); for (let y = x; y; y = y.parentElement) y.scrollTop = 0; } else x.scrollIntoView({ block: "start" }); }, sel); await p.waitForTimeout(250);
    await p.screenshot({ path: path.join(SHOTS, name) }); };
  try {
    // the gym, its head coach, the team and two members (made through the API; the browsers sign in with their sessions)
    const coach = client(base), admin = client(base), amy = client(base), ben = client(base);
    let r = await coach("POST", "/auth/start-gym", { gym: "Lions BJJ", name: "Coach Thabo", email: "thabo@lions.test", password: "coachpass1", timezone: "Africa/Johannesburg" });
    const gym = r.j.me.gym.id, code = r.j.me.gym.studentCode;
    await admin("POST", "/auth/register", { name: "Boss Admin", email: "boss@jitsflow.test", password: "adminpass1" });
    await pool.query("update users set email_verified_at=now(), email_verified_for=email where email='boss@jitsflow.test'");
    const plan = (await coach("POST", "/coach/plans", { name: "Adults unlimited", priceCents: 85000, period: "month" })).j.plan.id;
    await coach("PATCH", "/coach/gym/pay", { holder: "Lions BJJ", bank: "FNB", account: "62000000000", branch: "250655", dueDay: 1 });
    for (const [c, n] of [[amy, "Amy Dlamini"], [ben, "Ben Mokoena"]]) { const x = await c("POST", "/auth/register", { code, name: n, email: n.split(" ")[0].toLowerCase() + "@lions.test", password: "studentpass1" }); c.id = x.j.me.id; await coach("PATCH", `/coach/students/${c.id}`, { planId: plan }); }

    // ---------- the head coach: Money › Setup › Get paid by card ----------
    const co = await phone(coach);
    await co.goto(URL + "/app/#coach-money"); await co.waitForTimeout(900);
    await ev(co, () => { COACH.moneyView = "setup"; render(); }); await co.waitForTimeout(900);
    ok(await ev(co, () => !!document.getElementById("pspanel") && !document.getElementById("pfform") && /Get paid by card/.test(document.getElementById("pspanel").innerText)), "Money › Setup shows Get paid by card (and not PayFast)");
    if (!(await ev(co, () => document.getElementById("pspanel").open))) { await co.tap("#pspanel summary"); await co.waitForTimeout(300); }
    await co.waitForFunction(() => document.querySelectorAll('#psform [name="bankCode"] option').length > 2, null, { timeout: 5000 }).catch(() => {});
    ok(await ev(co, () => { const t = document.getElementById("pspanel").innerText; return /Paystack pays your share straight into your bank account/.test(t) && /2 working days/.test(t) && /2% platform fee/.test(t) && /paystack\.com\/za\/pricing/.test(t) && /taken from your share/.test(t) && !/R\s?\d+[.,]\d\d%/.test(t); }),
      "it says plainly: Paystack pays the gym's account (about 2 working days), JitsFlow's 2% and Paystack's fee (who bears it, no fixed rate)");
    ok(await ev(co, () => [...document.querySelectorAll('#psform [name="bankCode"] option')].map((o) => o.textContent).includes("Capitec Bank")), "the bank list comes from Paystack");
    await wide(co, "Get paid by card");
    await shot(co, "coach-onboarding-form.png", "#pspanel");
    await shot(co, "coach-onboarding-form-2.png", "#psform");
    await co.selectOption('#psform [name="bankCode"]', "470010");
    await co.fill('#psform [name="account"]', "1234567890"); await co.fill('#psform [name="holder"]', "Lions BJJ (Pty) Ltd"); await co.fill('#psform [name="business"]', "Lions BJJ (Pty) Ltd");
    await co.fill('#psform [name="idNumber"]', "2019/123456/07");
    await co.tap('#psform [type="submit"]'); await co.waitForTimeout(900);
    ok(/JitsFlow checks your bank account/.test(await toast(co)) && await ev(co, () => !!document.getElementById("ps-wait") && /Waiting for JitsFlow to verify your bank account/.test(document.getElementById("pspanel").innerText)),
      "saved: “Waiting for JitsFlow to verify your bank account (usually within a day)”");
    ok(await ev(co, () => /•••• 7890/.test(document.getElementById("pspanel").innerText) && !document.body.innerText.includes("1234567890") && !document.body.innerText.includes("123456/07")), "only the last 4 digits show");
    await shot(co, "coach-onboarding-pending.png", "#pspanel");

    // ---------- the member, before it's verified: EFT only ----------
    const am = await phone(amy);
    await am.goto(URL + "/app/"); await am.waitForTimeout(900);
    await ev(am, () => loadPay().then(() => myPaySheet())); await am.waitForTimeout(400);
    ok(await ev(am, () => !document.querySelector("#paymethods") && !!document.getElementById("payeft")), "until the team verifies it, members see EFT only");

    // ---------- the JitsFlow team verifies it ----------
    const ad = await phone(admin);
    await ad.goto(URL + "/app/#me"); await ad.waitForTimeout(900);
    await ev(ad, () => dashOpen()); await ad.waitForTimeout(1500);
    ok(await ev(ad, () => { const x = document.getElementById("dashpayouts"); return !!x && /Card payouts to verify · 1/.test(x.textContent) && /Lions BJJ/.test(x.innerText) && /Capitec Bank •••• 7890/.test(x.innerText) && /Company reg\. •••• 5607/.test(x.innerText) && !!x.querySelector('a[href^="https://dashboard.paystack.com"]') && !x.innerText.includes("1234567890"); }),
      "the team's dashboard lists the account to verify, masked, with a link to Paystack's subaccounts: " + (await ev(ad, () => (document.getElementById("dashpayouts") || {}).innerText)));
    await wide(ad, "team dashboard");
    await shot(ad, "admin-verify-list.png", "#dashpayouts");
    await ad.tap('[data-a="psreveal"]'); await ad.waitForTimeout(500);
    ok(await ev(ad, () => /1234567890/.test(document.querySelector(".psrev").innerText) && /2019\/123456\/07/.test(document.querySelector(".psrev").innerText)), "Show full numbers shows them, on tap");
    await ad.tap('[data-a="psverify"]'); await ad.waitForTimeout(1200);
    ok(/Verified/.test(await toast(ad)) && await ev(ad, () => /Nothing to verify/.test(document.getElementById("dashpayouts").innerText)), "Mark verified: done, and off the list");
    ok(sink.mails.some((m) => m.to[0] === "thabo@lions.test" && m.subject === "Card payments are on"), "the head coach is emailed that card payments are on");

    // ---------- the member pays by card ----------
    await am.reload(); await am.waitForTimeout(900);
    await ev(am, () => { window.ApplePaySession = { canMakePayments: () => true }; return loadPay().then(() => myPaySheet()); }); await am.waitForTimeout(400);
    ok(await ev(am, () => { const ts = [...document.querySelectorAll("#paymethods .paytile")].map((x) => x.getAttribute("aria-label")); return ts.join() === "Apple Pay,Card,Capitec Pay,EFT: bank details and proof of payment"; }),
      "the Pay sheet: Apple Pay (on a device that has it), Card, Capitec Pay and EFT, with no Google Pay");
    ok(await ev(am, () => /Payments are processed securely by Paystack\./.test(document.querySelector("#paymethods .payterms").innerText) && /Terms/.test(document.querySelector("#paymethods .payterms").innerText)), "with the Terms and Refund policy line, naming Paystack");
    ok(await ev(am, () => /Secure with Paystack/.test(document.getElementById("autopay").innerText)), "and Save my card and pay automatically, through Paystack");
    await wide(am, "Pay sheet");
    await shot(am, "member-pay-sheet.png", "#sheet");
    await ev(am, () => { delete window.ApplePaySession; myPaySheet(); });
    ok(await ev(am, () => ![...document.querySelectorAll("#paymethods .paytile")].some((x) => /Apple Pay|Google Pay/.test(x.getAttribute("aria-label")))), "without Apple Pay on the device: no Apple Pay tile (and still no Google Pay)");
    await am.fill("#card-amt", "850");
    await Promise.all([am.waitForURL(/\/checkout\//, { timeout: 8000 }), am.tap('#paymethods [data-a="paycard"][data-v="cc"]')]);
    ok(/Pay R850\.00/.test(await am.textContent("h1")) && /capitec_pay/.test(await am.textContent("#channels")), "Card opens Paystack's checkout for R850, which offers its own methods");
    await Promise.all([am.waitForURL(/\/app\//, { timeout: 8000 }), am.tap("#pay")]);
    await am.waitForTimeout(400);
    ok(/Payment received — it shows once Paystack confirms|Paid\. Thanks!/.test(await toast(am)), "back in the app: “Payment received — it shows once Paystack confirms”: " + (await toast(am)));
    await am.waitForTimeout(1500);
    ok(/Paid\. Thanks!/.test(await toast(am)) && await ev(am, () => !/[?&](paid|reference)=/.test(location.search)), "then “Paid” once Paystack confirms (and the address is tidied)");
    await ev(am, () => loadPay().then(() => myPaySheet())); await am.waitForTimeout(400);
    ok(await ev(am, () => API.pay.owedCents === 0 && /Received/.test(document.getElementById("sheet").innerText) && /Card/.test(document.getElementById("sheet").innerText)), "the Pay sheet shows it received, by card");
    ok(sink.mails.some((m) => m.to[0] === "amy@lions.test" && /^Receipt: R/.test(m.subject)), "Amy gets a receipt by email");

    // ---------- Ben saves his card; the monthly job charges it ----------
    const be = await phone(ben);
    await be.goto(URL + "/app/"); await be.waitForTimeout(900);
    await ev(be, () => loadPay().then(() => myPaySheet())); await be.waitForTimeout(300);
    await Promise.all([be.waitForURL(/\/checkout\//, { timeout: 8000 }), be.tap('[data-a="autoon"]')]);
    ok(/Pay R850\.00/.test(await be.textContent("h1")) && (await be.textContent("#channels")).trim() === "card", "Save my card: a card checkout for what he owes now");
    await Promise.all([be.waitForURL(/\/app\//, { timeout: 8000 }), be.tap("#pay")]); await be.waitForTimeout(2000);
    ok(/card is saved/.test(await toast(be)), "back: paid, and the card is saved: " + (await toast(be)));
    await ev(be, () => loadPay().then(() => myPaySheet())); await be.waitForTimeout(300);
    ok(await ev(be, () => /Paid automatically/.test(document.getElementById("autopay").textContent) && /Visa •••• 4081/.test(document.getElementById("autopay").innerText)), "his Pay sheet: paid automatically, by Visa •••• 4081: " + (await ev(be, () => (document.getElementById("autopay") || {}).innerText)));
    await pool.query("delete from payments where user_id=$1", [ben.id]); await pool.query("update gyms set autopay_day=null where id=$1", [gym]);
    await jobs.autopay({ hour: 9 }); await wait(600);
    ok(ps.calls.some((c) => c.path === "/transaction/charge_authorization" && c.body.amount === 85000) && (await pool.query("select status from autopay_charges where user_id=$1", [ben.id])).rows[0].status === "paid", "next month the job charges his saved card, and it's recorded as paid");
    await ev(be, () => loadPay().then(() => myPaySheet())); await be.waitForTimeout(300);
    ok(await ev(be, () => API.pay.owedCents === 0), "he owes nothing");

    // ---------- the head coach refunds part of Amy's payment ----------
    await co.reload(); await co.waitForTimeout(1200);
    await ev(co, () => { COACH.moneyView = "payments"; return coachLoad("payments").then(render); }); await co.waitForTimeout(700);
    ok(await ev(co, () => /JitsFlow fee R\s?17\b/.test(document.getElementById("app").innerText) && !!document.querySelector('[data-a="refundask"]')), "Money › Payments shows the card payment's fees, with Refund");
    await co.tap('[data-a="refundask"]'); await co.waitForTimeout(300);
    ok(await ev(co, () => /Paystack reverses the payment's split/.test(document.getElementById("sheet").innerText)), "the refund sheet says Paystack reverses the split by its rules");
    await co.fill("#refund-amt", "100"); await co.tap('[data-a="refundyes"]'); await co.waitForTimeout(900);
    ok(/Refund sent to Paystack/.test(await toast(co)) && await ev(co, () => /refund on its way/.test(document.getElementById("app").innerText)), "Refund: sent, and shown as on its way");
    const rf = ps.refunds.slice(-1)[0];
    await ps.hook("refund.processed", { id: rf.id, transaction_reference: rf.transaction.reference, amount: rf.amount, status: "processed" }); await wait(500);
    await ev(co, () => coachLoad("payments").then(render)); await co.waitForTimeout(500);
    ok(await ev(co, () => /R\s?100 refunded/.test(document.getElementById("app").innerText) && /R\s?750\b/.test(document.getElementById("app").innerText)), "once Paystack confirms it: R100 refunded, R750 left on the payment");
    ok(!errs.length, "no page errors: " + errs.join(" | "));
  } catch (e) { fail++; fails.push("crashed: " + (e.stack || e.message)); }
  finally { await b.close(); srv.kill(); await pool.end(); sink.close(); ps.close(); }
  console.log(`paystack ui: ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log("  FAIL", f);
  process.exit(fail ? 1 : 0);
})();
