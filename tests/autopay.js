// Card autopay (PayFast tokenization) against a real PostgreSQL, with PayFast's API and notifications stood in for.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/autopay.js   (wipes that database)
const { spawn } = require("child_process"); const path = require("path"); const crypto = require("crypto"); const { Pool } = require("pg");
const { startMailSink } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
function client(base, cookie = "") {
  return async (method, url, body) => {
    const h = {}; if (cookie) h.cookie = cookie; if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; }
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = m[1] ? "jf_s=" + m[1] : ""; }
    let j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j };
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const enc = (v) => encodeURIComponent(String(v).trim()).replace(/%20/g, "+");
const GYM_PASS = "gym pass phrase";
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists autopay_charges, autopay, class_skips, plan_breaks, notices, left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const sink = await startMailSink();
  // PayFast, stood in for: the notification check, saved-card charges (mode by token: ok, fail, down) and cancels.
  const calls = [], mode = {}; let pfId = 7000000;
  const pfSrv = require("http").createServer((rq, rs) => { let b = ""; rq.on("data", (c) => (b += c)); rq.on("end", () => {
    const u = new URL(rq.url, "http://x"), m = u.pathname.match(/^\/subscriptions\/([^/]+)\/(adhoc|cancel)$/);
    if (u.pathname === "/eng/query/validate") return rs.end("VALID");
    if (!m) { rs.writeHead(404); return rs.end("{}"); }
    const body = b ? JSON.parse(b) : {}, hd = { "merchant-id": rq.headers["merchant-id"], version: rq.headers.version, timestamp: rq.headers.timestamp };
    const all = { ...hd, ...body, passphrase: GYM_PASS }, sig = md5(Object.keys(all).sort().filter((k) => all[k] !== "" && all[k] != null).map((k) => `${k}=${enc(all[k])}`).join("&"));
    const call = { token: decodeURIComponent(m[1]), what: m[2], method: rq.method, body, headers: hd, signed: rq.headers.signature === sig, testing: u.searchParams.get("testing") }; calls.push(call);
    const md = mode[call.token] || "ok";
    if (m[2] === "cancel") { rs.writeHead(200, { "content-type": "application/json" }); return rs.end(JSON.stringify({ code: 200, status: "success", data: { response: true, message: "Success" } })); }
    if (md === "down") { rs.writeHead(500); return rs.end("oops"); }
    if (md === "fail") { rs.writeHead(400, { "content-type": "application/json" }); return rs.end(JSON.stringify({ code: 400, status: "failed", data: { response: "Insufficient funds", message: "Failure" } })); }
    call.pfId = String(++pfId); rs.writeHead(200, { "content-type": "application/json" }); rs.end(JSON.stringify({ code: 200, status: "success", data: { response: true, message: "Success", pf_payment_id: call.pfId } }));
  }); }).listen(0);
  const PF = `http://127.0.0.1:${pfSrv.address().port}`;
  const port = 9500 + Math.floor(Math.random() * 90), base = `http://127.0.0.1:${port}/api`;
  const common = { DATABASE_URL: DB, RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, APP_URL: "https://www.jitsflow.test", MAIL_GAP_MS: "0",
    PAYFAST_VALIDATE_URL: PF + "/eng/query/validate", PAYFAST_API_URL: PF, PAYFAST_AUTOPAY_TEST: "1" };
  const env = { ...process.env, ...common, PORT: String(port) }; delete env.ANTHROPIC_API_KEY; delete env.PAYFAST_MERCHANT_ID;
  const start = (e) => spawn("node", [path.resolve(__dirname, "../server.js")], { env: e, stdio: ["ignore", "ignore", "inherit"] });
  const up = async (p) => { for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${p}/healthz`); return; } catch (e) { await wait(150); } } };
  const srv = start(env); await up(port);
  // The scheduled job, run here the way server.js runs it (two "servers" at once, to show a card is never charged twice).
  Object.assign(process.env, common); delete process.env.PAYFAST_MERCHANT_ID;
  const { makeApi } = require("../backend/api"), pfm = require("../backend/payfast"), pool2 = new Pool({ connectionString: DB });
  const jobsA = makeApi(pool, {}).jobs, jobsB = makeApi(pool2, {}).jobs;
  const to = (addr, from = 0) => sink.mails.slice(from).filter((m) => m.to[0] === addr);
  const itn = (fields, pw = GYM_PASS) => { const str = Object.entries(fields).map(([k, v]) => `${k}=${enc(v)}`).join("&") + `&passphrase=${enc(pw)}`; return Object.entries(fields).map(([k, v]) => `${k}=${enc(v)}`).join("&") + "&signature=" + md5(str); };
  const notify = async (fields, pw) => { await fetch(base + "/payfast/notify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: itn(fields, pw) }); await wait(700); };
  const srvs = [srv];
  try {
    const coach = client(base), co2 = client(base);
    let r = await coach("POST", "/auth/start-gym", { gym: "Auto BJJ", name: "Coach Ann", email: "ann@auto.test", password: "coachpass1", timezone: "Africa/Johannesburg" });
    const gym = Number(r.j.me.gym.id), code = r.j.me.gym.studentCode;
    await co2("POST", "/auth/register", { code: r.j.me.gym.coachCode, name: "Coach Bo", email: "bo@auto.test", password: "coachpass2" });
    const today = (await coach("GET", "/coach/roster")).j.today, M = today.slice(0, 7);
    const plan = (await coach("POST", "/coach/plans", { name: "Adults", priceCents: 85000, period: "month" })).j.plan.id;
    await coach("PATCH", "/coach/gym/pay", { holder: "Auto BJJ", bank: "FNB", account: "62000000000", branch: "250655", dueDay: 1 });
    const S = {};
    const join = async (k) => { const c = client(base), x = await c("POST", "/auth/register", { code, name: `${k[0].toUpperCase()}${k.slice(1)} Member`, email: `${k}@auto.test`, password: "studentpass1" });
      c.id = x.j.me.id; c.email = `${k}@auto.test`; S[k] = c; await coach("PATCH", `/coach/students/${c.id}`, { planId: plan }); return c; };
    for (const k of ["amy", "ben", "cara", "dan", "eve", "fay", "gus", "hal", "ivy"]) await join(k);
    const pay = async (c) => (await c("GET", "/me/pay")).j.pay;
    const charges = async (uid) => (await pool.query("select * from autopay_charges where user_id=$1 order by id", [uid])).rows;
    const adhoc = (tok) => calls.filter((c) => c.what === "adhoc" && c.token === tok);

    // --- hidden until it can work
    ok((await pay(S.amy)).autopay === null, "no PayFast account: nothing about autopay on the Pay sheet");
    r = await S.amy("POST", "/me/autopay", {}); ok(r.s === 400, "and the server refuses to set it up");
    await coach("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12" });
    ok((await pay(S.amy)).autopay === null, "a PayFast account with no passphrase (PayFast needs one for saved cards): still hidden");
    r = await S.amy("POST", "/me/autopay", {}); ok(r.s === 400, "and refused");
    r = await S.amy("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12", passphrase: GYM_PASS }); ok(r.s === 403, "a member can't change the gym's PayFast account");
    r = await co2("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12", passphrase: GYM_PASS }); ok(r.s === 403, "nor can a coach who isn't the head coach");
    await coach("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12", passphrase: GYM_PASS });
    let a = (await pay(S.amy)).autopay; ok(a && a.on === false && a.dueDay === 1, "with a passphrase it's offered (off until they save a card): " + JSON.stringify(a));
    r = await coach("POST", "/me/autopay", {}); ok(r.s === 403, "coaches don't get it");

    // --- saving a card: PayFast's tokenization checkout, nothing charged at PayFast now
    r = await S.amy("POST", "/me/autopay", {}); const f = r.j.fields;
    ok(r.s === 200 && /\/eng\/process$/.test(r.j.action) && f.subscription_type === "2" && f.amount === "0.00" && f.custom_str1 === "card" && f.merchant_id === "10000105" && f.custom_int1 === S.amy.id && f.custom_int2 === String(gym),
      "Save my card: a PayFast tokenization checkout (subscription_type 2) for R0.00 on the gym's account: " + JSON.stringify(f));
    ok(f.signature === pfm.sign(f, GYM_PASS) && f.notify_url === "https://www.jitsflow.test/api/payfast/notify" && /autopay=on/.test(f.return_url) && !f.recurring_amount && !f.frequency, "signed with the gym's passphrase, no fixed monthly amount");
    // PayFast saves it and says so. The 1st has come, so what Amy owes this month is charged straight away.
    let m0 = sink.mails.length;
    const saved = (who, tok, extra = {}) => ({ m_payment_id: `card-${who.id}-1`, pf_payment_id: "", payment_status: "COMPLETE", item_name: "Auto BJJ fees", amount_gross: "0.00", custom_int1: who.id, custom_int2: String(gym), custom_int3: who.id, custom_str1: "card", token: tok, merchant_id: "10000105", ...extra });
    await notify({ ...saved(S.amy, "tok-amy"), pf_payment_id: "1" }, "wrong pass");
    ok(!(await pool.query("select 1 from autopay")).rows[0], "a notification with a bad signature saves nothing");
    await notify({ ...saved(S.amy, "tok-amy"), pf_payment_id: "1" });
    const row = (await pool.query("select * from autopay where user_id=$1", [S.amy.id])).rows[0];
    ok(row && row.token !== "tok-amy" && pfm.open(row.token) === "tok-amy" && row.from_month === M, "the card is saved, its token stored encrypted, paying from this month");
    ok(to("amy@auto.test", m0).some((x) => x.subject === "Your fees are paid automatically" && /the 1st of each month/.test(x.text)), "Amy gets an email saying it's on");
    let ch = adhoc("tok-amy");
    ok(ch.length === 1 && ch[0].method === "POST" && ch[0].body.amount === 85000 && /^auto-\d+$/.test(ch[0].body.m_payment_id) && ch[0].signed && ch[0].headers["merchant-id"] === "10000105" && ch[0].headers.version === "v1",
      "the 1st has passed, so R850 is charged now with PayFast's ad hoc API, signed: " + JSON.stringify(ch));
    ok(JSON.parse(ch[0].body.setup || "{}").split_payment.merchant_id === Number(pfm.TEST.id) && JSON.parse(ch[0].body.setup).split_payment.percentage === 2 && ch[0].testing === null, "with JitsFlow's 2% split, on the gym's own (not test) account");
    ok((await charges(S.amy.id))[0].status === "sent", "the charge waits for PayFast's notification");
    a = (await pay(S.amy)).autopay; ok(a.on && a.names.length === 1, "Amy's Pay sheet says her card pays");
    m0 = sink.mails.length; await notify({ ...saved(S.amy, "tok-amy"), pf_payment_id: "1" });
    ok(adhoc("tok-amy").length === 1 && !to("amy@auto.test", m0).length, "the same notification again: no second email, no second charge");
    // PayFast's notification for the charge: recorded as paid, the normal way, with a receipt.
    m0 = sink.mails.length; const cid = ch[0].body.m_payment_id;
    const charged = (tok, mid, pfid, amount, extra = {}) => ({ m_payment_id: mid, pf_payment_id: pfid, payment_status: "COMPLETE", item_name: "Auto BJJ fees", amount_gross: amount, amount_fee: "-19.55", amount_net: "830.45", token: tok, merchant_id: "10000105", ...extra });
    await notify(charged("tok-amy", cid, "5000001", "850.00"));
    let p = await pay(S.amy), got = p.payments.find((x) => x.reference === "PayFast 5000001");
    ok(got && got.status === "confirmed" && got.method === "payfast" && got.amountCents === 85000 && p.owedCents === 0, "the charge is recorded as paid, and Amy owes nothing: " + JSON.stringify(got));
    ok(to("amy@auto.test", m0).some((x) => /^Receipt: R/.test(x.subject) && /5000001/.test(x.text)), "Amy gets a receipt");
    ok(!to("ann@auto.test", m0).some((x) => x.subject === "A card payment came in"), "the head coach isn't emailed for each automatic payment (Money shows it)");
    ok((await charges(S.amy.id))[0].status === "paid", "the charge is marked paid");
    m0 = sink.mails.length; await notify(charged("tok-amy", cid, "5000001", "850.00"));
    ok((await pool.query("select count(*)::int as n from payments where user_id=$1 and source='payfast'", [S.amy.id])).rows[0].n === 1 && !to("amy@auto.test", m0).length, "the same notification twice: one payment, one receipt");

    // --- nothing charged when nothing's owed: paid already, paused, on trial
    await coach("POST", "/coach/payments", { userId: S.ben.id, amountCents: 85000, paidOn: today, method: "cash" });
    await coach("PATCH", `/coach/students/${S.cara.id}`, { planStatus: "paused" });
    await coach("PATCH", `/coach/students/${S.dan.id}`, { planStatus: "trial" });
    for (const k of ["ben", "cara", "dan"]) await notify(saved(S[k], "tok-" + k));
    ok(["ben", "cara", "dan"].every((k) => adhoc("tok-" + k).length === 0), "paid in cash, paused or on a trial: their saved cards aren't charged");
    ok((await pool.query("select count(*)::int as n from autopay where user_id = any($1)", [[S.ben.id, S.cara.id, S.dan.id]])).rows[0].n === 3, "but they're saved for later");

    // --- a card that's declined: the member and the head coach hear once, no retry this month
    mode["tok-eve"] = "fail"; m0 = sink.mails.length;
    await notify(saved(S.eve, "tok-eve")); await wait(300);
    ok(adhoc("tok-eve").length === 1 && (await charges(S.eve.id))[0].status === "failed", "Eve's card is declined");
    ok(to("eve@auto.test", m0).filter((x) => x.subject === "Your card payment didn't go through").length === 1, "Eve is told once, and asked to pay another way");
    ok(to("ann@auto.test", m0).filter((x) => x.subject === "An automatic card payment didn't go through" && /Eve Member/.test(x.text)).length === 1, "the head coach is told once");
    ok(!to("bo@auto.test", m0).length, "other coaches aren't");
    p = await pay(S.eve); ok(p.autopay.on && p.autopay.last.status === "failed" && p.owedCents === 85000, "Eve's Pay sheet shows it didn't go through, and she still owes");

    // --- no answer from PayFast: never retried; after a day the head coach is asked to check
    mode["tok-fay"] = "down";
    await notify(saved(S.fay, "tok-fay"));
    ok(adhoc("tok-fay").length === 1 && (await charges(S.fay.id))[0].status === "charging", "no answer: the charge is left open (it may have gone through)");
    // --- a proof being checked: wait
    await pool.query("insert into payments(gym_id,user_id,amount_cents,paid_on,status,source) values($1,$2,85000,$3,'pending','upload')", [gym, S.gus.id, today]);
    await notify(saved(S.gus, "tok-gus"));
    ok(adhoc("tok-gus").length === 0, "a proof being checked: the card waits");

    // --- the daily job: a card saved earlier is charged on the due day, once, however many servers run it
    await pool.query("insert into autopay(user_id,gym_id,payer_id,token,token_hash,merchant_id,from_month) values($1,$2,$1,$3,$4,'10000105',$5)", [S.hal.id, gym, pfm.seal("tok-hal"), crypto.createHash("sha256").update("tok-hal").digest("hex"), M]);
    ok((await jobsA.autopay({ hour: 5, day: today })) === 0 && adhoc("tok-hal").length === 0, "before 7am nothing is charged");
    const [n1, n2] = await Promise.all([jobsA.autopay({ hour: 9, day: today }), jobsB.autopay({ hour: 9, day: today })]);
    ok(n1 + n2 === 1 && adhoc("tok-hal").length === 1 && adhoc("tok-hal")[0].body.amount === 85000, "two servers run the job at once: Hal's card is charged R850 once: " + [n1, n2]);
    ok(adhoc("tok-eve").length === 1 && adhoc("tok-fay").length === 1 && adhoc("tok-amy").length === 1, "nobody tried this month is tried again");
    ok((await jobsA.autopay({ hour: 15, day: today })) === 0, "running again later that day does nothing");
    // Fee reminders on the due day leave out members whose card is paying (Hal), not one whose card was declined (Eve).
    await pool.query("update gyms set auto_remind=true where id=$1", [gym]); m0 = sink.mails.length;
    await jobsA.autoRemind({ hour: 9, day: M + "-01" }); await wait(500);
    ok(!to("hal@auto.test", m0).length && to("eve@auto.test", m0).length === 1, "fee reminders skip Hal (his card is paying) but not Eve (hers was declined)");
    await pool.query("update gyms set auto_remind=false where id=$1", [gym]);
    // A day on with no word from PayFast about Fay's charge: the head coach is asked to check, once.
    await pool.query("update autopay_charges set created_at=now() - interval '25 hours' where user_id=$1", [S.fay.id]); m0 = sink.mails.length;
    await Promise.all([jobsA.autopay({ hour: 9, day: today }), jobsB.autopay({ hour: 9, day: today })]); await wait(300);
    ok((await charges(S.fay.id))[0].status === "unsure" && to("ann@auto.test", m0).filter((x) => x.subject === "Check an automatic card payment").length === 1 && !to("fay@auto.test", m0).length, "a day without an answer: the head coach is asked to check PayFast (once); Fay isn't told it failed");
    // PayFast's notification turns up after all: it counts.
    const fid = (await charges(S.fay.id))[0].id; await notify(charged("tok-fay", "auto-" + fid, "5000009", "850.00"));
    ok((await pay(S.fay)).owedCents === 0 && (await charges(S.fay.id))[0].status === "paid", "the late notification still records Fay's payment");
    // A charge notification without our reference is matched by the card's open charge.
    await notify(charged("tok-hal", "card-x-1", adhoc("tok-hal")[0].pfId, "850.00", { custom_str1: "card" }));
    ok((await pay(S.hal)).owedCents === 0, "a charge notification is matched by its card when PayFast sends the card's first reference");

    // --- the head coach sees who pays automatically
    let mo = Object.fromEntries((await coach("GET", "/coach/money")).j.students.map((s) => [s.id, s]));
    ok(mo[S.amy.id].autopay === true && mo[S.ivy.id].autopay === false && mo[S.eve.id].autopayFailed === true && !mo[S.amy.id].autopayFailed, "Money shows who's on card autopay, and whose card was declined");
    r = await co2("GET", "/coach/money"); ok(r.s === 403, "only the head coach sees Money");

    // --- Stop, in one tap from Me, with Undo
    r = await S.amy("DELETE", "/me/autopay"); ok(r.s === 200 && r.j.stopped === 1 && (await pay(S.amy)).autopay.on === false, "Stop: Amy's card no longer pays");
    r = await S.amy("POST", "/me/autopay/undo", {}); ok(r.s === 200 && (await pay(S.amy)).autopay.on === true, "Undo puts it back");
    await S.amy("DELETE", "/me/autopay"); await pool.query("update autopay set stopped_at=now() - interval '11 minutes' where user_id=$1", [S.amy.id]);
    await jobsA.autopay({ hour: 9, day: today }); await wait(300);
    ok(!(await pool.query("select 1 from autopay where user_id=$1", [S.amy.id])).rows[0] && calls.some((c) => c.what === "cancel" && c.token === "tok-amy" && c.method === "PUT" && c.signed), "10 minutes on, the card is cancelled with PayFast and forgotten");
    r = await S.amy("POST", "/me/autopay/undo", {}); ok(r.s === 409, "too late to undo then");
    await notify(saved(S.ivy, "tok-ivy"));
    ok(adhoc("tok-ivy").length === 1, "Ivy's card is charged when saved");

    // --- a family: the parent's card pays for each kid, one email, one Stop
    const lerato = (await coach("POST", "/coach/students", { name: "Lerato Dlamini", parentName: "Thandi", phone: "082 555 1234" })).j.id;
    const sipho = (await coach("POST", "/coach/students", { name: "Sipho Dlamini", parentName: "Thandi", phone: "082 555 1234" })).j.id;
    for (const id of [lerato, sipho]) await coach("PATCH", `/coach/students/${id}`, { planId: plan });
    const mom = client(base); r = await mom("POST", "/auth/register", { code, name: "Thandi Dlamini", email: "thandi@auto.test", password: "thandipass1", phone: "082 555 1234", kids: [lerato, sipho] });
    ok(r.s === 201 && r.j.me.id === lerato, "Thandi signs in for Lerato and Sipho");
    await mom("POST", "/me/as", { id: sipho });
    r = await mom("POST", "/me/autopay", {}); ok(r.j.fields.custom_int1 === lerato && r.j.fields.custom_int3 === sipho && r.j.fields.email_address === "thandi@auto.test", "from Sipho's Pay sheet, the card is Thandi's (her login)");
    m0 = sink.mails.length; await notify({ ...saved({ id: sipho }, "tok-mom"), custom_int1: lerato });
    const on = to("thandi@auto.test", m0).filter((x) => x.subject === "Your fees are paid automatically");
    ok(on.length === 1 && /Hi Thandi/.test(on[0].text) && /Lerato and Sipho/.test(on[0].text), "one email to Thandi: her card pays for Lerato and Sipho: " + (on[0] && on[0].text));
    ok(adhoc("tok-mom").length === 2 && adhoc("tok-mom").every((c) => c.body.amount === 85000), "each kid's fees are charged on their own");
    p = await pay(mom); ok(p.autopay.on && p.autopay.names.join() === "Lerato,Sipho", "the Pay sheet says who it pays for");
    r = await mom("DELETE", "/me/autopay"); ok(r.j.stopped === 2, "one Stop stops it for both kids");
    await mom("POST", "/me/autopay/undo", {});

    // --- in the app: save a card from the Pay sheet, see it on Me, Stop with Undo; the head coach sees it in Money
    { const { chromium, devices } = require("playwright"), b = await chromium.launch(), errs = [];
      try {
        const jo = await join("jo"), URL = `http://127.0.0.1:${port}`;
        // Signed in with a session made in the database (sign-ins from one address are rate-limited).
        const phone = async (email) => { const c = await b.newContext({ ...devices["iPhone 13"] }), pg = await c.newPage(), tok = crypto.randomBytes(32).toString("hex"); pg.on("pageerror", (e) => errs.push(e.message));
          await pool.query("insert into sessions(token_hash,user_id,expires_at) select $1, id, now()+interval '1 day' from users where email=$2", [crypto.createHash("sha256").update(tok).digest("hex"), email]);
          await c.addCookies([{ name: "jf_s", value: tok, url: URL }]);
          await pg.goto(URL + "/app/#me"); await pg.waitForTimeout(1200); await pg.evaluate(() => { if (S.ui.sheet) hideSheet(); go("me"); }); await pg.waitForTimeout(800); return pg; };
        const ev = (pg, fn, x) => pg.evaluate(fn, x), toast = (pg) => ev(pg, () => document.getElementById("toast").textContent);
        const st = await phone("jo@auto.test");
        await st.tap('.feecard [data-a="mypay"]'); await st.waitForTimeout(500);
        ok(await ev(st, () => /Save my card and pay automatically/.test(document.getElementById("autopay")?.innerText || "") && /1st of each month/.test(document.getElementById("autopay").innerText)), "the Pay sheet offers 'Save my card and pay automatically', saying when it charges");
        ok(await ev(st, () => document.documentElement.scrollWidth <= 390), "pay sheet: no sideways scroll");
        let posted = null; await st.route("**/eng/process", (rt) => { posted = rt.request().postData(); rt.fulfill({ status: 200, contentType: "text/html", body: "<p>PayFast</p>" }); });
        await st.tap('#autopay [data-a="autoon"]'); await st.waitForTimeout(1200);
        ok(posted && /subscription_type=2/.test(posted) && /amount=0.00/.test(posted) && /custom_str1=card/.test(posted), "one tap goes to PayFast to save the card: " + posted);
        await notify(saved(jo, "tok-jo"));
        await st.goto(URL + "/app/?autopay=on#me"); await st.waitForTimeout(1500);
        ok(/Card saved/.test(await toast(st)), "back from PayFast: 'Card saved'");
        await ev(st, () => { if (S.ui.sheet) hideSheet(); go("me"); }); await st.waitForTimeout(600);
        ok(await ev(st, () => /Paid automatically by card on the 1st/.test(document.getElementById("autoline")?.innerText || "")), "Me says the fees are paid automatically");
        await st.tap('#autoline [data-a="autostop"]'); await st.waitForTimeout(900);
        ok(/Stopped/.test(await toast(st)) && !(await ev(st, () => !!document.getElementById("autoline"))) && !(await pool.query("select 1 from autopay where user_id=$1 and stopped_at is null", [jo.id])).rows[0], "one tap on Stop stops it: " + (await toast(st)));
        await st.tap("#toast .toastbtn"); await st.waitForTimeout(1200);
        ok(/again/.test(await toast(st)) && (await ev(st, () => !!document.getElementById("autoline"))), "Undo turns it back on: " + (await toast(st)));
        const co = await phone("ann@auto.test"); await ev(co, () => { COACH.moneyFilter = "all"; coachGo("money"); }); await co.waitForTimeout(1500);
        ok(await ev(co, (n) => [...document.querySelectorAll(".mrow")].some((r) => r.innerText.includes(n) && /pays by card automatically/.test(r.innerText)), "Jo Member"), "the head coach's Money list says who pays by card automatically");
        ok(await ev(co, (n) => [...document.querySelectorAll(".mrow")].some((r) => r.innerText.includes(n) && /card payment didn't go through/.test(r.innerText)), "Eve Member"), "and whose card was declined");
        ok(!errs.length, "no page errors: " + errs.join(" | "));
      } finally { await b.close(); } }

    // --- leaving the gym, or the gym changing PayFast account, stops it
    r = await S.ivy("POST", "/me/leave", {}); await wait(300);
    ok(!(await pool.query("select 1 from autopay where user_id=$1", [S.ivy.id])).rows[0] && calls.some((c) => c.what === "cancel" && c.token === "tok-ivy"), "Ivy leaves the gym: her card is cancelled");
    m0 = sink.mails.length; await coach("PUT", "/coach/payfast", { merchantId: "10000106", merchantKey: "abcdefghijk12", passphrase: GYM_PASS }); await wait(500);
    ok(!(await pool.query("select 1 from autopay where gym_id=$1", [gym])).rows[0], "a new PayFast account: saved cards (on the old one) stop");
    ok(to("thandi@auto.test", m0).filter((x) => x.subject === "Automatic card payments stopped").length === 1 && to("ben@auto.test", m0).length === 1, "and each person who saved one is told once (Thandi once for both kids)");
    ok(calls.some((c) => c.what === "cancel" && c.token === "tok-mom" && c.headers["merchant-id"] === "10000105"), "cancelled on the old account");

    // --- hidden unless JitsFlow and the gym are on live PayFast
    const runOn = async (extra, label, fn) => { const port2 = port + 100 + Math.floor(Math.random() * 50), b2 = `http://127.0.0.1:${port2}/api`, e2 = { ...env, PORT: String(port2), ...extra };
      for (const k of Object.keys(e2)) if (e2[k] === null) delete e2[k];
      const s2 = start(e2); srvs.push(s2); await up(port2); try { await fn(b2); } catch (e) { fail++; fails.push(label + " crashed: " + e.message); } finally { s2.kill(); } };
    await runOn({ PAYFAST_AUTOPAY_TEST: null }, "sandbox", async (b2) => {
      const st = client(b2); await st("POST", "/auth/login", { email: "ben@auto.test", password: "studentpass1" });
      ok((await st("GET", "/me/pay")).j.pay.autopay === null, "JitsFlow on PayFast's sandbox: hidden from members");
      r = await st("POST", "/me/autopay", {}); ok(r.s === 400, "and the server refuses it");
    });
    await runOn({ PAYFAST_AUTOPAY_TEST: null, PAYFAST_MERCHANT_ID: "12345678", PAYFAST_MERCHANT_KEY: "abcdefghijk12", PAYFAST_PASSPHRASE: "live pass" }, "live", async (b2) => {
      const st = client(b2); await st("POST", "/auth/login", { email: "ben@auto.test", password: "studentpass1" });
      ok((await st("GET", "/me/pay")).j.pay.autopay && (await st("GET", "/me/pay")).j.pay.autopay.on === false, "JitsFlow live and the gym on its own live account: offered");
      await pool.query("update gyms set payfast=$1 where id=$2", [{ merchantId: pfm.TEST.id, key: pfm.seal(pfm.TEST.key), pass: pfm.seal(pfm.TEST.pass) }, gym]);
      ok((await st("GET", "/me/pay")).j.pay.autopay === null && (await st("POST", "/me/autopay", {})).s === 400, "JitsFlow live but the gym on PayFast's test account: hidden and refused");
    });
    // The job does nothing either, on the sandbox without the test switch.
    await coach("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12", passphrase: GYM_PASS });
    await pool.query("insert into autopay(user_id,gym_id,payer_id,token,token_hash,merchant_id,from_month) values($1,$2,$1,$3,$4,'10000105',$5)", [S.ben.id, gym, pfm.seal("tok-ben2"), crypto.createHash("sha256").update("tok-ben2").digest("hex"), M]);
    await pool.query("delete from payments where user_id=$1", [S.ben.id]); await pool.query("update gyms set autopay_day=null where id=$1", [gym]);
    delete process.env.PAYFAST_AUTOPAY_TEST;
    ok((await jobsA.autopay({ hour: 9, day: today })) === 0 && adhoc("tok-ben2").length === 0, "the job charges nothing while autopay is off");
    process.env.PAYFAST_AUTOPAY_TEST = "1";
    ok((await jobsA.autopay({ hour: 9, day: today })) === 1 && adhoc("tok-ben2").length === 1, "and charges Ben once it's on");

    // ===== A second gym: who a card pays for, what it pays, and the charges PayFast is slow about =====
    const z = client(base); r = await z("POST", "/auth/start-gym", { gym: "Two BJJ", name: "Coach Zed", email: "zed@auto.test", password: "coachpass3", timezone: "Africa/Johannesburg" });
    const gym2 = Number(r.j.me.gym.id), code2 = r.j.me.gym.studentCode;
    const plan2 = (await z("POST", "/coach/plans", { name: "Adults", priceCents: 85000, period: "month" })).j.plan.id;
    await z("PATCH", "/coach/gym/pay", { holder: "Two BJJ", bank: "FNB", account: "62000000001", branch: "250655", dueDay: 1 });
    await z("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12", passphrase: GYM_PASS });
    const mAdd = (m, n) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 7);
    const sha2 = (t) => crypto.createHash("sha256").update(t).digest("hex");
    const add = async (name, extra) => { const id = (await z("POST", "/coach/students", { name, ...extra })).j.id; await z("PATCH", `/coach/students/${id}`, { planId: plan2 }); return id; };
    const asUser = async (id) => { const tok = crypto.randomBytes(32).toString("hex"); await pool.query("insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '1 day')", [sha2(tok), id]); return client(base, "jf_s=" + tok); };
    const card = (id, tok, from = M, payer = id) => pool.query("insert into autopay(user_id,gym_id,payer_id,token,token_hash,merchant_id,from_month) values($1,$2,$3,$4,$5,'10000105',$6)", [id, gym2, payer, pfm.seal(tok), sha2(tok), from]);
    const run2 = async () => { await pool.query("update gyms set autopay_day=null where id=$1", [gym2]); return jobsA.autopay({ hour: 9, day: today }); };
    const row2 = async (id) => (await z("GET", "/coach/money")).j.students.find((s) => s.id === String(id));
    const cancels = (tok) => calls.filter((c) => c.what === "cancel" && c.token === tok);
    const fam = async (kids, parent, phone, email) => { const ids = []; for (const k of kids) ids.push(await add(k, { parentName: parent, phone }));
      const c = client(base); const x = await c("POST", "/auth/register", { code: code2, name: parent + " Parent", email, password: "parentpass1", phone, kids: ids }); ok(x.s === 201, "a parent signs up for " + kids.join(" and ")); return [c, ...ids]; };

    // --- 1. A kid taken off a parent's login: the parent's card stops paying for them
    const [lindiMom, lindi, sizwe] = await fam(["Lindi Mokoena", "Sizwe Mokoena"], "Thembi", "082 555 2000", "thembi@auto.test");
    await notify({ ...saved({ id: sizwe }, "tok-m2"), custom_int1: lindi, custom_int2: String(gym2) });
    ok(adhoc("tok-m2").length === 2, "Thembi's card pays for Lindi and Sizwe");
    r = await z("POST", `/coach/students/${sizwe}/unlink`, {});
    ok(r.s === 200 && !(await pool.query("select 1 from autopay where user_id=$1", [sizwe])).rows[0] && (await pool.query("select 1 from autopay where user_id=$1", [lindi])).rows[0], "the coach unlinks Sizwe: Thembi's card stops paying for him, not for Lindi");
    ok(!cancels("tok-m2").length, "the card is still used for Lindi, so it isn't cancelled with PayFast");
    ok((await lindiMom("GET", "/me/pay")).j.pay.autopay.names.join() === "Lindi", "Thembi's Pay sheet says her card pays for Lindi only");
    await pool.query("delete from autopay_charges where user_id=$1", [sizwe]);
    await run2(); ok(adhoc("tok-m2").length === 2, "the next run doesn't charge Thembi's card for Sizwe");
    // A row left over from before (the card's owner isn't Sizwe or his parent): the job drops it rather than charge it.
    await card(sizwe, "tok-m2", M, lindi); await run2();
    ok(adhoc("tok-m2").length === 2 && !(await pool.query("select 1 from autopay where user_id=$1", [sizwe])).rows[0], "a card that isn't his or his parent's any more is never charged for him, and comes off");

    // --- 2. A parent who deletes their login: their card stops, and is cancelled with PayFast
    const [nMom, kea, tumi] = await fam(["Kea Nkosi", "Tumi Nkosi"], "Naledi", "082 555 3000", "naledi@auto.test");
    await notify({ ...saved({ id: kea }, "tok-n"), custom_int1: kea, custom_int2: String(gym2) });
    ok(adhoc("tok-n").length === 2, "Naledi's card pays for Kea and Tumi");
    r = await nMom("DELETE", "/me", { password: "parentpass1" }); await wait(300);
    ok(r.s === 200 && !(await pool.query("select 1 from autopay where user_id = any($1)", [[kea, tumi]])).rows[0], "Naledi deletes her login: her card pays for nobody");
    ok(cancels("tok-n").length === 1, "and it's cancelled with PayFast (she can't sign in to stop it)");
    await pool.query("delete from autopay_charges where user_id = any($1)", [[kea, tumi]]);
    await run2(); ok(adhoc("tok-n").length === 2, "the next run charges nothing to her card");

    // --- 6. One family proof being checked: no sibling's card is charged meanwhile
    const [zMom, lebo, ayanda] = await fam(["Lebo Dube", "Ayanda Dube"], "Zola", "082 555 4000", "zola@auto.test");
    await pool.query("insert into payments(gym_id,user_id,amount_cents,paid_on,status,source) values($1,$2,170000,$3,'pending','upload')", [gym2, lebo, today]);
    await notify({ ...saved({ id: lebo }, "tok-z"), custom_int1: lebo, custom_int2: String(gym2) });
    ok(adhoc("tok-z").length === 0, "Zola sent one proof (from Lebo's sheet) for both kids: Ayanda's card payment waits too");
    await run2(); ok(adhoc("tok-z").length === 0, "and the daily run waits while it's checked");
    const proof = (await pool.query("select id from payments where user_id=$1 and status='pending'", [lebo])).rows[0].id;
    await z("PATCH", `/coach/payments/${proof}`, { status: "confirmed" });
    await run2(); ok(adhoc("tok-z").length === 0 && (await row2(ayanda)).owedCents === 0, "the coach confirms it, it pays both kids, and nothing is charged");

    // --- 4 and 8. Old arrears and a declined month: the card pays the months it charged for, reminders ask for just the arrears
    const Oct = mAdd(M, -1), Aug = mAdd(M, -3), Sep = mAdd(M, -2);
    await pool.query("update gyms set bill_start=$2 where id=$1", [gym2, Aug + "-01"]);
    const amy2 = await add("Ama Owens", { email: "ama@auto.test" });
    await pool.query("update users set created_at=$2, bill_from=null where id=$1", [amy2, Aug + "-05"]);
    await card(amy2, "tok-a2", Oct);
    await pool.query("insert into autopay_charges(gym_id,user_id,month,amount_cents,status,alloc,told_at) values($1,$2,$3,85000,'failed',$4,now())", [gym2, amy2, Oct, { [Oct]: 85000 }]);
    await run2();
    ok(adhoc("tok-a2").length === 1 && adhoc("tok-a2")[0].body.amount === 170000, "Ama owes August to November; the card pays from October: it charges October (declined) and November, R1 700");
    let a2 = (await charges(amy2)).find((c) => c.month === M);
    ok(a2 && a2.alloc && a2.alloc[Oct] === 85000 && a2.alloc[M] === 85000, "the charge keeps the months it's for: " + JSON.stringify(a2 && a2.alloc));
    await notify(charged("tok-a2", "auto-" + a2.id, adhoc("tok-a2")[0].pfId, "1700.00"));
    let ap = (await pool.query("select alloc, months from payments where user_id=$1 and source='payfast'", [amy2])).rows[0];
    ok(ap && ap.alloc && ap.alloc[Oct] === 85000 && ap.alloc[M] === 85000 && !ap.alloc[Aug], "PayFast confirms: it pays October and November, not the old arrears: " + JSON.stringify(ap));
    ok((await row2(amy2)).owedMonths.map((o) => o.month).join() === [Aug, Sep].join(), "Ama still owes August and September, and nothing the card paid");
    await pool.query("delete from autopay_charges where user_id=$1 and month=$2", [amy2, M]); await run2();
    ok(adhoc("tok-a2").length === 1, "so the card has nothing more to charge (no R850 again for October)");
    let ama = await asUser(amy2), ap2 = (await ama("GET", "/me/pay")).j.pay;
    ok(ap2.autopay.on && ap2.autopay.from === Oct && ap2.owedMonths.length === 2, "Ama's Pay sheet: the card pays from October, and she still owes two older months");

    // --- 3. No answer from PayFast: the member isn't told it failed, and the head coach settles it in one tap
    const fay2 = await add("Faith Mbeki", { email: "faith@auto.test" }), gia2 = await add("Gia Naidoo", { email: "gia@auto.test" }), ida2 = await add("Ida Petersen", { email: "ida@auto.test" });
    for (const [id, tok] of [[fay2, "tok-f2"], [gia2, "tok-g2"], [ida2, "tok-i2"]]) { mode[tok] = "down"; await card(id, tok); }
    await run2();
    await pool.query("update autopay_charges set created_at=now() - interval '25 hours' where user_id = any($1)", [[fay2, gia2, ida2]]); m0 = sink.mails.length;
    await jobsA.autopay({ hour: 9, day: today }); await wait(300);
    ok((await pool.query("select count(*)::int as n from autopay_charges where user_id = any($1) and status='unsure'", [[fay2, gia2, ida2]])).rows[0].n === 3, "a day without an answer: unsure");
    ok(to("zed@auto.test", m0).filter((x) => x.subject === "Check an automatic card payment").length === 3 && !to("faith@auto.test", m0).length, "the head coach is asked to check each one; the member isn't told anything");
    ok(to("zed@auto.test", m0).some((x) => /It went through/.test(x.text) && !/record it in Money/.test(x.text)), "the email says to tap 'It went through' or 'It didn't' in Money, not to record it by hand");
    const fay = await asUser(fay2); let fp = (await fay("GET", "/me/pay")).j.pay;
    ok(fp.autopay.last && fp.autopay.last.status === "unsure", "Faith's Pay sheet knows it's being checked");
    let fr = await row2(fay2), mm = (await z("GET", "/coach/money")).j;
    ok(fr.autopayUnsure === true && fr.autopayFailed === false, "Money: Faith's card payment is 'not confirmed yet', not 'didn't go through'");
    ok(mm.cardCheck.length === 3 && mm.cardCheck.some((c) => c.name === "Faith Mbeki" && c.cents === 85000), "and it's at the top of Money for the head coach to settle");
    // Reminders on the due day: Faith's charge isn't settled yet, so she's left alone. Ama is reminded about August and September only.
    await pool.query("update payments set created_at=now() - interval '8 days', paid_on=$2 where user_id=$1", [amy2, Oct + "-20"]);
    await pool.query("update gyms set auto_remind=true where id=$1", [gym2]); m0 = sink.mails.length;
    await jobsA.autoRemind({ hour: 9, day: M + "-01" }); await wait(500);
    await pool.query("update gyms set auto_remind=false where id=$1", [gym2]);
    const amaRem = to("ama@auto.test", m0);
    const monName = (m) => new Date(m + "-15T12:00:00Z").toLocaleDateString("en-ZA", { month: "long", timeZone: "UTC" });
    ok(amaRem.length === 1 && /R.?1.700(,00)? is due/.test(amaRem[0].text) && amaRem[0].text.includes(monName(Aug)) && amaRem[0].text.includes(monName(Sep)),
      "Ama, whose card pays from October, is still reminded about the R1 700 she owes from before: " + (amaRem[0] && amaRem[0].text.slice(0, 300)));
    ok(!to("faith@auto.test", m0).length, "Faith, whose card payment isn't confirmed yet, isn't reminded");

    // --- 5. The head coach recorded it by hand (as the old email said), then PayFast's notice comes: not recorded twice
    await z("POST", "/coach/payments", { userId: fay2, amountCents: 85000, paidOn: today, method: "eft" }); m0 = sink.mails.length;
    const fc = (await charges(fay2))[0];
    await notify(charged("tok-f2", "auto-" + fc.id, "5000101", "850.00"));
    ok((await pool.query("select count(*)::int as n from payments where user_id=$1 and status='confirmed'", [fay2])).rows[0].n === 1, "PayFast's late notice after a payment recorded by hand: Faith has one payment, not two");
    ok(to("zed@auto.test", m0).filter((x) => x.subject === "A card payment came in after all").length === 1 && (await charges(fay2))[0].status === "paid", "the head coach is told, in case it was a different payment");
    // One tap: it went through. Undo, then again. PayFast's notice later changes nothing, and the receipt goes then.
    const gc2 = (await charges(gia2))[0];
    r = await z("POST", `/coach/money/card/${gc2.id}`, { went: true });
    ok(r.s === 200 && (await row2(gia2)).owedCents === 0 && (await charges(gia2))[0].status === "paid", "'It went through': Gia's payment is recorded and she owes nothing");
    r = await z("POST", `/coach/money/card/${gc2.id}/undo`, {});
    ok(r.s === 200 && (await row2(gia2)).owedCents === 85000 && (await charges(gia2))[0].status === "unsure", "Undo takes it off again");
    r = await coach("POST", `/coach/money/card/${gc2.id}`, { went: true }); ok(r.s === 404, "another gym's head coach can't settle it");
    r = await co2("POST", `/coach/money/card/${gc2.id}`, { went: true }); ok(r.s === 403, "nor can a coach who isn't a head coach");
    await z("POST", `/coach/money/card/${gc2.id}`, { went: true }); m0 = sink.mails.length;
    await notify(charged("tok-g2", "auto-" + gc2.id, "5000102", "850.00"));
    const gp = (await pool.query("select reference from payments where user_id=$1 and status='confirmed'", [gia2])).rows;
    ok(gp.length === 1 && gp[0].reference === "PayFast 5000102", "PayFast's notice then: still one payment, now with PayFast's reference");
    ok(to("gia@auto.test", m0).filter((x) => /^Receipt/.test(x.subject)).length === 1, "and Gia gets her receipt");
    r = await z("POST", `/coach/money/card/${gc2.id}/undo`, {}); ok(r.s === 409, "PayFast confirmed it: no undo then");
    // One tap: it didn't. Ida is asked to pay another way (the head coach isn't emailed about their own tap); reminders count her again.
    const ic = (await charges(ida2))[0]; m0 = sink.mails.length;
    r = await z("POST", `/coach/money/card/${ic.id}`, { went: false }); await wait(300);
    ok(r.s === 200 && (await charges(ida2))[0].status === "failed" && to("ida@auto.test", m0).filter((x) => x.subject === "Your card payment didn't go through").length === 1 && !to("zed@auto.test", m0).length, "'It didn't': Ida is asked to pay another way");
    ok((await row2(ida2)).autopayFailed === true && !(await z("GET", "/coach/money")).j.cardCheck.length, "Money shows it didn't go through, and nothing is left to check");
    r = await z("POST", `/coach/money/card/${ic.id}`, { went: true }); ok(r.s === 409, "settled already: a second tap changes nothing");

    // --- 7. Declined, then paid another way: no more 'didn't go through'
    const ivo = await add("Ivo Daniels", { email: "ivo@auto.test" }); mode["tok-v2"] = "fail"; await card(ivo, "tok-v2"); await run2();
    const ivc = await asUser(ivo);
    ok((await ivc("GET", "/me/pay")).j.pay.autopay.last.status === "failed" && (await row2(ivo)).autopayFailed, "Ivo's card is declined: his Pay sheet and Money say so");
    await z("POST", "/coach/payments", { userId: ivo, amountCents: 85000, paidOn: today, method: "eft" });
    ok((await ivc("GET", "/me/pay")).j.pay.autopay.last === null && (await row2(ivo)).autopayFailed === false, "he pays by EFT: neither says it didn't go through any more");

    // --- 9. Charged, then the member leaves before PayFast confirms: recorded, off what they owed, and the head coach told
    const hal2 = await add("Hal Jacobs", { email: "hal2@auto.test" }); await card(hal2, "tok-h2"); await run2();
    const hc = (await charges(hal2))[0]; ok(hc && hc.status === "sent", "Hal's card is charged R850");
    const hal = await asUser(hal2); m0 = sink.mails.length;
    r = await hal("POST", "/me/leave", {}); await wait(300);
    ok(to("zed@auto.test", m0).some((x) => /Hal Jacobs left/.test(x.text) && /still on its way from PayFast/.test(x.text)), "he leaves: the head coach hears the card payment is still on its way");
    ok((await pool.query("select owed_cents from left_owing where user_id=$1", [hal2])).rows[0].owed_cents === 85000, "he left owing R850 (not confirmed yet)");
    m0 = sink.mails.length; await notify(charged("tok-h2", "auto-" + hc.id, adhoc("tok-h2")[0].pfId, "850.00"));
    const hp = (await pool.query("select * from payments where user_id=$1 and gym_id=$2", [hal2, gym2])).rows;
    ok(hp.length === 1 && hp[0].status === "confirmed" && hp[0].amount_cents === 85000 && (await charges(hal2))[0].status === "left" && String((await charges(hal2))[0].payment_id) === String(hp[0].id), "PayFast confirms after he left: the payment is recorded for the gym");
    ok(!(await pool.query("select 1 from left_owing where user_id=$1", [hal2])).rows[0], "and he no longer shows as owing");
    ok(to("zed@auto.test", m0).filter((x) => x.subject === "A card payment came in after a member left" && /Hal Jacobs/.test(x.text)).length === 1, "the head coach is told once, to keep or refund it");
    await notify(charged("tok-h2", "auto-" + hc.id, adhoc("tok-h2")[0].pfId, "850.00"));
    ok((await pool.query("select count(*)::int as n from payments where user_id=$1", [hal2])).rows[0].n === 1, "the same notice again records nothing more");

    // --- the Me screen: an unconfirmed charge isn't called a failure; arrears outside the card are spelled out; Money's one tap
    { const { chromium, devices } = require("playwright"), b = await chromium.launch(), errs = [];
      try { const URL = `http://127.0.0.1:${port}`, ctx = await b.newContext({ ...devices["iPhone 13"] }), pg = await ctx.newPage(); pg.on("pageerror", (e) => errs.push(e.message));
        const tok = crypto.randomBytes(32).toString("hex");
        await pool.query("insert into sessions(token_hash,user_id,expires_at) select $1, id, now()+interval '1 day' from users where email='zed@auto.test'", [sha2(tok)]);
        await ctx.addCookies([{ name: "jf_s", value: tok, url: URL }]);
        await pg.goto(URL + "/app/#me"); await pg.waitForTimeout(1200);
        const line = (a, extra = {}) => pg.evaluate(([a, x]) => { const d = document.createElement("div"); d.innerHTML = autoLine({ autopay: a, currency: "ZAR", ...x }); return d.innerText; }, [a, extra]);
        const base2 = { on: true, names: ["Faith"], dueDay: 1, from: M };
        let t = await line({ ...base2, last: { month: M, cents: 85000, status: "unsure" } });
        ok(/checking your card payment/.test(t) && !/didn't go through/.test(t) && !/another way/.test(t), "Me, not confirmed yet: 'We're checking your card payment', never 'pay it another way': " + t);
        t = await line({ ...base2, last: { month: M, cents: 85000, status: "failed" } }); ok(/didn't go through/.test(t) && /another way/.test(t), "Me, declined: pay another way");
        t = await line({ ...base2, from: Oct, last: null }, { owedMonths: [{ month: Aug, cents: 85000 }, { month: Sep, cents: 85000 }] });
        ok(/doesn't pay R.?1.700/.test(t) && /yourself/.test(t), "Me, with older months owed: says the card doesn't pay those and to pay them: " + t);
        // Money: Faith's unconfirmed charge was settled above; a new one for Hana is at the top, and one tap records it, with Undo.
        const hana = await add("Hana Moosa", { email: "hana@auto.test" }); mode["tok-hn"] = "down"; await card(hana, "tok-hn"); await run2();
        await pool.query("update autopay_charges set created_at=now() - interval '25 hours' where user_id=$1", [hana]); await jobsA.autopay({ hour: 9, day: today });
        const hid = (await charges(hana))[0].id;
        await pg.evaluate(() => { COACH.moneyFilter = "all"; coachGo("money"); }); await pg.waitForTimeout(1500);
        ok(await pg.evaluate((id) => /Hana Moosa/.test(document.getElementById("cardchk-" + id)?.innerText || ""), hid), "Money shows Hana's unconfirmed card payment, with 'It went through' and 'It didn't'");
        ok(await pg.evaluate(() => [...document.querySelectorAll(".mrow")].some((r) => r.innerText.includes("Hana Moosa") && /not confirmed yet/.test(r.innerText))), "and her row says 'card payment not confirmed yet'");
        ok(await pg.evaluate(() => document.documentElement.scrollWidth <= 390), "money: no sideways scroll");
        await pg.tap(`#cardchk-${hid} [data-a="cardok"]`); await pg.waitForTimeout(1200);
        ok(/Recorded R.?850/.test(await pg.evaluate(() => document.getElementById("toast").textContent)) && (await charges(hana))[0].status === "paid" && !(await pg.evaluate((id) => !!document.getElementById("cardchk-" + id), hid)), "one tap: recorded, and it's off the list");
        await pg.tap("#toast .toastbtn"); await pg.waitForTimeout(1200);
        ok((await charges(hana))[0].status === "unsure" && (await pg.evaluate((id) => !!document.getElementById("cardchk-" + id), hid)), "Undo puts it back to check");
        ok(!errs.length, "no page errors: " + errs.join(" | "));
      } finally { await b.close(); } }

    // --- 10. The head coach clears the passphrase: saved cards stop (and are cancelled), with the members told
    const gus2 = await add("Gus Lee", { email: "gus2@auto.test" }); await card(gus2, "tok-gs");
    m0 = sink.mails.length; await z("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12", passphrase: "" }); await wait(500);
    ok(!(await pool.query("select 1 from autopay where gym_id=$1", [gym2])).rows[0], "no passphrase now: the gym's saved cards stop");
    ok(cancels("tok-gs").length === 1 && cancels("tok-gs")[0].signed && to("gus2@auto.test", m0).filter((x) => x.subject === "Automatic card payments stopped").length === 1, "each is cancelled with PayFast (with the old passphrase), and Gus is told");
    // A card still saved while the gym can't take them (say JitsFlow's PayFast is switched): hidden from Money, but Gus can still stop it.
    await card(gus2, "tok-gs2"); const gus = await asUser(gus2);
    let gp2 = (await gus("GET", "/me/pay")).j.pay.autopay;
    ok(gp2 && gp2.on === true && (await row2(gus2)).autopay === false, "a card still saved: Gus sees it on and can stop it; Money doesn't claim it pays");
    r = await gus("DELETE", "/me/autopay"); ok(r.s === 200 && r.j.stopped === 1, "Stop works");
    r = await gus("POST", "/me/autopay", {}); ok(r.s === 400, "but he can't save a card while it's off");
  } catch (e) { fail++; fails.push("crashed: " + (e.stack || e.message)); }
  finally { for (const s of srvs) s.kill(); await pool.end(); await pool2.end(); sink.close(); pfSrv.close(); }
  console.log(`autopay: ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log("  FAIL", f);
  process.exit(fail ? 1 : 0);
})();
