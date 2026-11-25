// Members' fees, from the payments review: billing starts when someone joins this gym (not when their account was made), a family
// payment taken back (Undo, or "not a payment") takes its brothers' and sisters' shares with it, fee reminders open the Pay sheet
// (and offer card when the gym takes cards), and a member who's paid up is never handed an amount to pay.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/payfixes.js   (wipes that database)
const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg");
const { chromium, devices } = require("playwright");
const { startMailSink } = require("./fixture-gym"); const { startFakePaystack } = require("./fake-paystack");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(base) {
  let cookie = "";
  const c = async (method, url, body) => {
    const h = {}; if (cookie) h.cookie = cookie; if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; }
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = m[1] ? "jf_s=" + m[1] : ""; }
    let j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j };
  };
  c.cookie = () => cookie.replace(/^jf_s=/, "");
  return c;
}
const SECRET = "sk_test_" + "a".repeat(40);
const ym = (d) => d.toISOString().slice(0, 7);
const monthsAgo = (n) => { const d = new Date(); d.setUTCDate(10); d.setUTCMonth(d.getUTCMonth() - n); return d; };

(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop schema public cascade; create schema public;");
  const sink = await startMailSink(), ps = await startFakePaystack({ secret: SECRET });
  const port = 9600 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${port}`, base = BASE + "/api"; ps.setApp(BASE);
  const env = { ...process.env, DATABASE_URL: DB, PORT: String(port), APP_URL: "https://www.jitsflow.test", RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, MAIL_GAP_MS: "0",
    PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_URL: ps.url, JF_PLAN_CARD_TEST: "1" };
  delete env.ANTHROPIC_API_KEY; delete env.PAYFAST_MERCHANT_ID; delete env.JF_MEMBER_PAYMENTS;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 80; i++) { try { await fetch(BASE + "/healthz"); break; } catch (e) { await wait(150); } }
  let b;
  try {
    const start = async (gym, email) => { const c = client(base), r = await c("POST", "/auth/start-gym", { gym, name: "Coach " + gym, email, password: "coachpass1", timezone: "Africa/Johannesburg" });
      c.gym = r.j.me.gym.id; c.code = r.j.me.gym.studentCode; return c; };
    const A = await start("Alpha BJJ", "a@pf.test"), B = await start("Bravo BJJ", "b@pf.test");
    const planB = (await B("POST", "/coach/plans", { name: "Adults", priceCents: 85000, period: "month" })).j.plan.id;
    await pool.query("update gyms set bill_start=$2 where id=$1", [B.gym, ym(monthsAgo(8)) + "-01"]);
    const now = ym(new Date());

    // ---------- billing starts when they join this gym ----------
    const sam = client(base); let r = await sam("POST", "/auth/register", { code: A.code, name: "Sam Mover", email: "sam@pf.test", password: "studentpass1" });
    const samId = r.j.me.id;
    await pool.query("update users set created_at=$2, gym_joined_at=$2 where id=$1", [samId, monthsAgo(6)]); // a member of Alpha for six months
    r = await sam("POST", "/me/join", { code: B.code }); ok(r.s === 200, "Sam moves to Bravo (" + r.s + ")");
    await B("PATCH", `/coach/students/${samId}`, { planId: planB });
    let p = (await sam("GET", "/me/pay")).j.pay;
    ok(p.owedCents === 85000 && p.owedMonths.length === 1 && p.owedMonths[0].month === now, "someone who joins with an older account owes from the month they joined, not before: " + JSON.stringify(p.owedMonths));
    const prev = ym(monthsAgo(1));
    let mo = (await B("GET", "/coach/money?month=" + prev)).j;
    ok(!mo.students.some((x) => x.id === String(samId)), "and isn't on Money for the months before they joined");
    // Someone who's been at Bravo for three months (joined then) still owes all three, and this one.
    const tom = client(base); r = await tom("POST", "/auth/register", { code: B.code, name: "Tom Regular", email: "tom@pf.test", password: "studentpass1" });
    const tomId = r.j.me.id; await pool.query("update users set created_at=$2, gym_joined_at=$2 where id=$1", [tomId, monthsAgo(3)]);
    await B("PATCH", `/coach/students/${tomId}`, { planId: planB });
    p = (await tom("GET", "/me/pay")).j.pay;
    ok(p.owedMonths.length === 4 && p.owedCents === 4 * 85000, "a member who joined three months ago still owes those months: " + JSON.stringify(p.owedMonths));
    // A parent who signed up for their kid months ago, and starts training today, pays from today.
    const pat = client(base); r = await pat("POST", "/auth/register", { code: B.code, name: "Pat Parent", email: "pat@pf.test", password: "studentpass1" });
    const patId = r.j.me.id; await pool.query("update users set created_at=$2, gym_joined_at=$2 where id=$1", [patId, monthsAgo(5)]);
    await pool.query("update users set gym_joined_at=now() where id=$1", [patId]); // as /me/train does
    await B("PATCH", `/coach/students/${patId}`, { planId: planB });
    p = (await pat("GET", "/me/pay")).j.pay;
    ok(p.owedMonths.length === 1, "a parent who starts training owes from then: " + JSON.stringify(p.owedMonths));

    // ---------- a family payment taken back ----------
    const kidPlan = (await B("POST", "/coach/plans", { name: "Kids", priceCents: 50000, period: "month" })).j.plan.id;
    const k1 = (await B("POST", "/coach/students", { name: "Kid One", phone: "0821234567", parentName: "Fam Parent", planId: kidPlan })).j.id;
    const k2 = (await B("POST", "/coach/students", { name: "Kid Two", phone: "0821234567", parentName: "Fam Parent", planId: kidPlan })).j.id;
    const owes = async () => { const m = (await B("GET", "/coach/money")).j.students; const f = (id) => m.find((x) => x.id === String(id)); return [f(k1), f(k2)].map((x) => x.paidCents); };
    const pid = (await pool.query("insert into payments(gym_id,user_id,amount_cents,paid_on,source,status,method) values($1,$2,100000,current_date,'student','pending','eft') returning id", [B.gym, k1])).rows[0].id;
    r = await B("PATCH", `/coach/payments/${pid}`, { status: "confirmed" });
    ok(r.s === 200 && r.j.split && r.j.split.length && JSON.stringify(await owes()) === "[50000,50000]", "R1 000 for two kids: confirmed, split between them: " + JSON.stringify(await owes()));
    r = await B("PATCH", `/coach/payments/${pid}`, { status: "pending" });
    const shares = (await pool.query("select count(*)::int as n from payments where split_of=$1", [pid])).rows[0].n;
    ok(r.s === 200 && r.j.payment.amountCents === 100000 && shares === 0 && JSON.stringify(await owes()) === "[0,0]", "Undo: back to being checked at its whole R1 000, and neither kid shows as paid: " + r.j.payment.amountCents + " shares " + shares);
    r = await B("PATCH", `/coach/payments/${pid}`, { status: "confirmed" });
    ok(r.s === 200 && JSON.stringify(await owes()) === "[50000,50000]", "confirmed again: split again");
    r = await B("PATCH", `/coach/payments/${pid}`, { status: "rejected" });
    ok(r.s === 200 && JSON.stringify(await owes()) === "[0,0]" && !(await pool.query("select 1 from payments where split_of=$1", [pid])).rows[0], "not a payment: both kids owe again, nothing left paid from it");
    const note = (await pool.query("select note from payments where id=$1", [pid])).rows[0].note || "";
    ok(!/Family payment of/.test(note), "and its family note is gone: " + note);

    // ---------- fee reminders open the Pay sheet, and offer card where the gym takes it ----------
    await B("PATCH", "/coach/gym/pay", { holder: "Bravo BJJ", bank: "FNB", account: "62000000001", branch: "250655", type: "Cheque" });
    let m0 = sink.mails.length;
    r = await B("POST", "/coach/money/remind", { userIds: [tomId] }); await wait(800);
    let em = sink.mails.slice(m0).find((x) => x.to[0] === "tom@pf.test");
    ok(r.s === 200 && em && /\/app\/\?pay=1/.test(em.html) && !/\/app\/#book/.test(em.html) && /Pay or send proof/.test(em.html) && !/by card/.test(em.text), "a reminder's button opens the Pay sheet (no card yet): " + (em ? em.text.slice(0, 300) : r.s));
    await pool.query("update gyms set paystack=$2 where id=$1", [B.gym, { subaccount: "ACCT_bravo", status: "active", mode: "test", bankName: "FNB", last4: "0001" }]);
    m0 = sink.mails.length;
    r = await B("POST", "/coach/money/remind", { userIds: [samId] }); await wait(800);
    em = sink.mails.slice(m0).find((x) => x.to[0] === "sam@pf.test");
    ok(r.s === 200 && em && /Pay now/.test(em.html) && /Pay by card in the app/.test(em.text) && /Or pay by EFT to/.test(em.text) && /\/app\/\?pay=1/.test(em.html), "where the gym takes cards, the reminder says so first, and EFT second: " + (em ? em.text.slice(0, 400) : r.s));

    // ---------- in the app: paid up means nothing to pay; owing means the amount ----------
    await B("POST", "/coach/payments", { userId: samId, amountCents: 85000, paidOn: new Date().toISOString().slice(0, 10), method: "eft" });
    p = (await sam("GET", "/me/pay")).j.pay;
    ok(p.owedCents === 0 && p.card === true, "Sam is paid up, at a gym that takes cards");
    b = await chromium.launch();
    const phone = async (c) => { const ctx = await b.newContext({ ...devices["iPhone 13"] }); await ctx.addCookies([{ name: "jf_s", value: c.cookie(), url: BASE }]); return ctx.newPage(); };
    const ev = (pg, fn, arg) => pg.evaluate(fn, arg);
    let pg = await phone(sam); await pg.goto(BASE + "/app/#me"); await wait(1500);
    await ev(pg, () => { if (!document.getElementById("sheet").hidden) hideSheet(); go("map"); }); await wait(1200);
    ok(await ev(pg, () => !!API.pay && !document.querySelector("#duechip") && !document.querySelector('.mapstrip [data-a="mypay"]')), "paid up: the Map shows nothing about fees");
    await ev(pg, () => go("me")); await wait(400); await pg.click("#mepay"); await wait(500);
    ok(await ev(pg, () => { const t = document.getElementById("sheet").innerText, a = document.getElementById("card-amt");
      return /Pay ahead/.test(t) && /You're paid up/.test(t) && !/Pay your fees/.test(t) && a && a.value === "" && /pay ahead/i.test(a.placeholder); }), "the sheet says they're paid up, and no amount is filled in");
    await pg.context().close();
    pg = await phone(tom); await pg.goto(BASE + "/app/?pay=1"); await wait(2200);
    ok(await ev(pg, () => S.ui.sheet && S.ui.sheet.k === "mypay" && /Pay your fees/.test(document.getElementById("sheet").innerText) && location.hash === "#me" && !/pay=1/.test(location.search)),
      "the reminder's link opens the app on Me with the Pay sheet open");
    ok(await ev(pg, () => { const a = document.getElementById("card-amt"); return a && a.value === String(4 * 850); }), "owing: the amount they owe is filled in");
    await pg.context().close();
  } catch (e) { fail++; fails.push("crashed: " + (e.stack || e.message)); }
  finally { if (b) await b.close(); srv.kill(); await pool.end(); sink.close(); ps.close(); }
  console.log(`payfixes: ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log("  FAIL", f);
  process.exit(fail ? 1 : 0);
})();
