// Support mode: a JitsFlow team member manages a gym as its head coach (backend/api.js, supportGate). Only verified team members can
// start it, for a claimed gym; it shows the gym exactly as its head coach sees it and allows normal gym work (each change logged with
// who really did it), refuses everything on the deny list (bank details, payouts, refunds, the owner's login, ownership, the plan),
// ends on Exit, after 2 hours, or when the team member signs out, never reaches another gym, and tells the owner.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/support.js   (wipes that database)
// SHOTS=<dir> also saves iPhone 13 screenshots there.
const { spawn } = require("child_process"); const path = require("path"); const fs = require("fs"); const { Pool } = require("pg");
const { chromium, devices } = require("playwright");
const { startMailSink } = require("./fixture-gym"); const { startFakePaystack } = require("./fake-paystack");
const { supportDenied, SUP_NO } = require("../backend/api");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TEAM_NO = "Exit support mode to use the team tools.";
// A client with a cookie jar (jf_s and jf_sup), and the support header when it's in support mode (as the app sends it).
function client(base) {
  const jar = {};
  const c = async (method, url, body, headers = {}) => {
    const h = { ...headers }, ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "); if (ck) h.cookie = ck;
    if (c.sup && !("x-jf-support" in headers)) h["x-jf-support"] = c.sup;
    if (h["x-jf-support"] === null) delete h["x-jf-support"];
    if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; }
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of r.headers.getSetCookie ? r.headers.getSetCookie() : []) { const m = sc.match(/^(jf_s|jf_sup)=([^;]*)/); if (m) { if (m[2] && !/Expires=Thu, 01 Jan 1970/i.test(sc)) jar[m[1]] = m[2]; else delete jar[m[1]]; } }
    let j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j };
  };
  c.jar = jar; c.sup = null;
  return c;
}
const refusedAsSupport = (r) => r.s === 403 && !!r.j && (r.j.support === true || r.j.error === SUP_NO || r.j.error === TEAM_NO);

(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop schema public cascade; create schema public;");
  const SECRET = "sk_test_" + "s".repeat(40);
  const sink = await startMailSink(), ps = await startFakePaystack({ secret: SECRET });
  const port = 9700 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${port}`, base = BASE + "/api"; ps.setApp(BASE);
  const env = { ...process.env, DATABASE_URL: DB, PORT: String(port), APP_URL: "https://www.jitsflow.test", RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, MAIL_GAP_MS: "0",
    JF_ADMIN_EMAILS: "boss@jitsflow.test, unverified@jitsflow.test", PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_URL: ps.url, JF_PLAN_CARD_TEST: "1" };
  delete env.ANTHROPIC_API_KEY; delete env.PAYFAST_MERCHANT_ID; delete env.JF_MEMBER_PAYMENTS; delete env.JF_SUPPORT_EMAIL_OWNER; delete env.JF_ASSISTANT;
  const servers = [];
  const startSrv = (p, extra = {}) => { const s = spawn("node", [path.resolve(__dirname, "../server.js")], { env: { ...env, PORT: String(p), ...extra }, stdio: ["ignore", "ignore", "inherit"] }); servers.push(s); return s; };
  const up = async (b) => { for (let i = 0; i < 80; i++) { try { await fetch(b + "/healthz"); return; } catch (e) { await wait(150); } } };
  startSrv(port); await up(BASE);
  const SHOTS = process.env.SHOTS || ""; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  let b;
  try {
    const start = async (gym, email, name) => { const c = client(base), r = await c("POST", "/auth/start-gym", { gym, name, email, password: "coachpass1", timezone: "Africa/Johannesburg" });
      c.gym = r.j.me.gym.id; c.code = r.j.me.gym.studentCode; c.coachCode = r.j.me.gym.coachCode; c.id = r.j.me.id; return c; };
    const A = await start("Alpha BJJ", "a@sup.test", "Ann Owner"), B = await start("Bravo BJJ", "b@sup.test", "Ben Bravo"), C = await start("Charlie BJJ", "c@sup.test", "Cat Charlie");
    const reg = async (email, name, code) => { const c = client(base), r = await c("POST", "/auth/register", { name, email, password: "userpass12", ...(code ? { code } : {}) }); c.id = r.j.me.id; return c; };
    const A2 = await reg("a2@sup.test", "Andy Assistant", A.coachCode), M = await reg("m@sup.test", "Mia Member", A.code), BM = await reg("bm@sup.test", "Bo Bravomember", B.code);
    const boss = await reg("boss@jitsflow.test", "Boss Team"), unv = await reg("unverified@jitsflow.test", "Una Verified");
    await pool.query("update users set email_verified_at=now(), email_verified_for=email where email in ('boss@jitsflow.test','a@sup.test','b@sup.test','c@sup.test')");
    // Alpha's setup: bank details, a plan Mia is on (so she owes), a proof to check.
    await A("PATCH", "/coach/gym/pay", { holder: "Alpha BJJ", bank: "FNB", account: "62000000001", branch: "250655", type: "Cheque" });
    const plan = (await A("POST", "/coach/plans", { name: "Adults", priceCents: 80000, period: "month" })).j.plan.id;
    await A("PATCH", `/coach/students/${M.id}`, { planId: plan });
    const proof = (await pool.query("insert into payments(gym_id,user_id,amount_cents,paid_on,source,status,method) values($1,$2,80000,current_date,'student','pending','eft') returning id", [A.gym, M.id])).rows[0].id;
    const bClass = (await B("POST", "/classes", { title: "Bravo fundamentals", startsAt: new Date(Date.now() + 2 * 864e5).toISOString(), durationMin: 60 })).j.class.id;

    // ---------- who can start it ----------
    let r;
    for (const [c, who] of [[A, "a head coach"], [A2, "a coach"], [M, "a member"], [unv, "a team email that isn't verified"]]) {
      r = await c("POST", `/admin/gyms/${A.gym}/support`, {}); ok(r.s === 403 && !c.jar.jf_sup, `${who} can't start support mode (${r.s} ${r.j && r.j.error})`);
    }
    r = await client(base)("POST", `/admin/gyms/${A.gym}/support`, {}); ok(r.s === 401, "nobody signed in can't either: " + r.s);
    r = await A("POST", `/admin/gyms/${A.gym}/support`, {}, { "x-jf": "0" }); ok(r.s === 403, "a change without the app's header is blocked as always");
    const unc = (await pool.query("insert into gyms(name,student_code,coach_code,claim) values('Unclaimed BJJ','UNCL1234','UNCL5678','{}') returning id")).rows[0].id;
    r = await boss("POST", `/admin/gyms/${unc}/support`, {}); ok(r.s === 400 && !boss.jar.jf_sup, "an unclaimed gym can't be managed as support: " + (r.j && r.j.error));
    r = await boss("POST", "/admin/gyms/999999/support", {}); ok(r.s === 404, "a gym that doesn't exist: 404");
    const mails0 = sink.mails.length;

    // ---------- starting: the head coach's view, exactly ----------
    const bossTok = boss.jar.jf_s;
    r = await boss("POST", `/admin/gyms/${A.gym}/support`, {});
    ok(r.s === 201 && r.j.support && r.j.support.gym === "Alpha BJJ" && !!boss.jar.jf_sup && boss.jar.jf_s === bossTok, "the team member starts support for Alpha: its own cookie, their own session untouched");
    boss.sup = r.j.support.id;
    const s1 = (await pool.query("select *, extract(epoch from expires_at - created_at) as secs from support_sessions where id=$1", [boss.sup])).rows[0];
    ok(Number(s1.secs) === 7200 && String(s1.head_id) === String(A.id) && String(s1.admin_id) === String(boss.id), "it lasts 2 hours, for Alpha's head coach, and knows who started it");
    ok((await pool.query("select count(*)::int as n from sessions where user_id=$1", [boss.id])).rows[0].n === 1, "no new sign-in session was made for anyone");
    r = await boss("GET", "/me");
    ok(r.j.me.id === A.id && r.j.me.gym.head && r.j.me.support && r.j.me.support.gym === "Alpha BJJ" && !r.j.me.admin, "in support mode the app is Alpha's head coach's, says it's support, and has no team tools");
    for (const u of ["/coach/roster", "/coach/money", "/classes", "/coach/plans", "/coach/gym/pay", "/coach/payments", "/coach/insights", "/gym", "/programme", "/coach/billing"]) {
      const [x, y] = await Promise.all([A("GET", u), boss("GET", u)]);
      ok(x.s === 200 && y.s === 200 && JSON.stringify(x.j) === JSON.stringify(y.j), `support sees ${u} exactly as the head coach does`);
    }
    r = await boss("GET", "/me", undefined, { "x-jf-support": null }); ok(r.j.me && r.j.me.id === A.id, "reads without the header (images, links) are in support mode too");
    r = await boss("GET", "/progress"); ok(r.s === 403, "but not the owner's own training journal: " + r.s);
    await wait(500);
    let ownerMails = sink.mails.slice(mails0).filter((m) => m.to[0] === "a@sup.test");
    ok(ownerMails.length === 1 && /JitsFlow support is helping with Alpha BJJ/.test(ownerMails[0].subject) && /Boss Team \(boss@jitsflow.test\)/.test(ownerMails[0].text)
      && /Every change they make is logged/.test(ownerMails[0].text) && /Gym › Support access/.test(ownerMails[0].text) && /support@jitsflow.com/.test(ownerMails[0].text) && /#coach-gym/.test(ownerMails[0].text),
    "the owner gets one email: who, when, that changes are logged, where to see them, and support@jitsflow.com: " + (ownerMails[0] ? ownerMails[0].text.slice(0, 500) : "none"));
    ok((ownerMails[0] || {}).reply_to === "support@jitsflow.com", "replies go to support");

    // ---------- normal gym work, logged with who really did it ----------
    const logN = async () => (await pool.query("select count(*)::int as n from support_log where session_id=$1", [boss.sup])).rows[0].n;
    const before = await logN(), m1 = sink.mails.length;
    r = await boss("POST", "/coach/students", { name: "Sam Supportadded", phone: "0821112222" }); ok(r.s === 201, "support adds a member: " + r.s);
    const sam = r.j.id;
    r = await boss("POST", "/classes", { title: "Support fundamentals", startsAt: new Date(Date.now() + 3 * 864e5).toISOString(), durationMin: 60 }); ok(r.s === 201, "plans a class: " + r.s);
    const cls = r.j.class.id;
    r = await boss("PATCH", `/coach/payments/${proof}`, { status: "confirmed" }); ok(r.s === 200, "confirms a proof: " + r.s);
    r = await boss("PATCH", `/coach/plans/${plan}`, { name: "Adults unlimited", priceCents: 85000, period: "month" }); ok(r.s === 200, "edits a plan: " + r.s);
    await pool.query("update payments set status='pending' where id=$1", [proof]); // so Mia owes again, for the reminder
    r = await boss("POST", "/coach/money/remind", { userIds: [M.id] }); ok(r.s === 200 && r.j.sent === 1, "sends a fee reminder: " + JSON.stringify(r.j));
    r = await boss("PATCH", `/coach/students/${sam}`, { belt: "blue", notes: "Secret note about Sam" }); ok(r.s === 200, "changes a member");
    r = await boss("PATCH", "/coach/gym", { showAttendees: false }); ok(r.s === 200 && r.j.me.support, "changes a gym setting (the answer's me still says support)");
    await wait(600);
    ok(sink.mails.slice(m1).some((m) => m.to[0] === "m@sup.test"), "the reminder reached the member (that's what support is for)");
    ok((await A("GET", "/coach/roster")).j.people.some((p) => p.name === "Sam Supportadded"), "the owner sees the member support added");
    const logs = (await pool.query("select * from support_log where session_id=$1 order by id", [boss.sup])).rows;
    const says = logs.map((x) => x.summary);
    ok(logs.length - before >= 7 && logs.every((x) => x.admin_email === "boss@jitsflow.test" && String(x.admin_id) === String(boss.id) && String(x.gym_id) === String(A.gym)), "every change is logged with the team member's identity and the gym");
    for (const [want, p] of [["Added a member", "/coach/students"], ["Planned a class", "/classes"], ["Confirmed a payment", "/coach/payments/:id"], ["Changed a plan", "/coach/plans/:id"], ["Sent fee reminders (1 member)", "/coach/money/remind"], ["Changed a member (belt, notes)", "/coach/students/:id"], ["Changed gym settings (who's booked)", "/coach/gym"]])
      ok(logs.some((x) => x.summary === want && x.path === p && x.status < 300), `logged: "${want}" on ${p}`);
    ok(logs.some((x) => x.method === "START" && x.summary === "Support session started"), "the start is logged");
    const all = JSON.stringify(logs);
    ok(!/Sam Supportadded|0821112222|Secret note|62000000001|Support fundamentals/.test(all), "the log keeps no names, numbers or notes that were typed");
    ok(!logs.some((x) => x.method === "GET"), "reads aren't logged");
    r = await boss("POST", "/me/notices/seen", {}); ok(r.s === 200, "marking the owner's notices seen is skipped (it only marks what they've seen)");
    // A change that emails the coaches says support made it, not the owner.
    const A3 = await reg("a3@sup.test", "Alex Thirdcoach", A.coachCode), m4 = sink.mails.length;
    r = await boss("PATCH", `/coach/students/${A3.id}`, { active: false }); await wait(600);
    const told = sink.mails.slice(m4).find((m) => m.to[0] === "a@sup.test" && /inactive/i.test(m.subject));
    ok(r.s === 200 && told && /JitsFlow support marked Alex Thirdcoach as inactive/.test(told.text) && !/Ann Owner marked/.test(told.text), "a coach change emailed to the coaches says JitsFlow support did it: " + (told ? told.text.slice(0, 200) : "no email"));

    // ---------- every route on the deny list ----------
    // 1. Every route in the API, checked against the deny list: these, and only these, are refused in support mode.
    const routes = [];
    for (const f of ["../backend/api.js", "../backend/programme.js"]) {
      const src = fs.readFileSync(path.resolve(__dirname, f), "utf8");
      for (const m of src.matchAll(/api\.(get|post|put|patch|delete)\("([^"]+)"/g)) routes.push([m[1].toUpperCase(), m[2]]);
    }
    const sample = (p) => p.replace(/:what\([^)]*\)/, "reveal").replace(/:[A-Za-z]+/g, "1");
    const denied = routes.filter(([m, p]) => supportDenied(m, sample(p), "999999")).map(([m, p]) => `${m} ${p}`).sort();
    const EXPECT = ["PATCH /coach/gym/pay", "POST /coach/gym/pay/new-address", "PUT /coach/paystack", "PUT /coach/payfast", "DELETE /coach/payfast", "POST /coach/payments/:id/refund",
      "POST /coach/payments/:id/refunds/:rid/dismiss", "POST /coach/assistant", "POST /coach/assistant/confirm", "DELETE /coach/gym", "POST /coach/head", "POST /coach/billing/checkout",
      "DELETE /coach/billing", "POST /coach/beta", "POST /coach/beta/feedback", "POST /coach/support/end",
      "POST /auth/start-gym", "POST /auth/register", "POST /auth/login", "POST /auth/forgot", "POST /auth/reset", "POST /auth/verify", "POST /auth/logout",
      "PATCH /me", "DELETE /me", "POST /me/sessions/end", "POST /me/verify-email", "POST /me/join", "POST /me/leave", "POST /me/as", "POST /me/kids", "POST /me/train", "POST /me/claim-gym", "POST /me/plan", "POST /me/book-usual",
      "POST /me/pay/proof", "POST /me/pay/payfast", "POST /me/pay/paystack", "POST /me/pay/paystack/check", "POST /me/autopay", "DELETE /me/autopay", "POST /me/autopay/undo",
      "GET /progress", "PUT /progress", "GET /logs", "PUT /logs/:id", "DELETE /logs/:id"];
    const adminRoutes = routes.filter(([, p]) => p.startsWith("/admin/")).map(([m, p]) => `${m} ${p}`);
    const want = [...EXPECT, ...adminRoutes].sort();
    ok(JSON.stringify(denied) === JSON.stringify(want), "the deny list covers exactly the guarded routes: extra " + JSON.stringify(denied.filter((x) => !want.includes(x))) + " missing " + JSON.stringify(want.filter((x) => !denied.includes(x))));
    // Anything else that sounds like money settings, ownership or the owner's login must be a read, or on this list of what support may do.
    const MAY = ["GET /coach/gym/pay", "PATCH /coach/gym/pay-soon", "PATCH /coach/gym/access-fee", "PATCH /coach/gym/private-price", "GET /coach/paystack", "GET /coach/paystack/banks", "GET /coach/payfast",
      "GET /coach/billing", "GET /coach/beta", "GET /me", "GET /me/pay", "GET /me/notices", "POST /me/notices/seen", "GET /me/membership", "GET /me/attended", "POST /me/programme/caught-up", "GET /coach/support",
      "PATCH /coach/gym", "DELETE /coach/gym/pay", "GET /coach/payments", "GET /coach/payments/months"];
    const sensitive = routes.map(([m, p]) => `${m} ${p}`).filter((k) => /gym\/pay|paystack|payfast|refund|billing|\/coach\/head|\/coach\/gym$|assistant|beta|support| \/me(\/|$)| \/auth\//.test(k) && !/^POST \/(paystack\/webhook|payfast\/notify)$/.test(k.replace(/^\w+ /, "POST ")));
    const unreviewed = sensitive.filter((k) => !denied.includes(k) && !MAY.includes(k) && !k.startsWith("GET /admin") && !k.endsWith("/admin/support/exit") && !/\/admin\//.test(k));
    ok(!unreviewed.length, "every money, ownership or login route is either refused in support mode or reviewed as fine: " + JSON.stringify(unreviewed));

    // The money, ownership and login routes also refuse support themselves (if the list above ever missed them).
    const apiSrc = fs.readFileSync(path.resolve(__dirname, "../backend/api.js"), "utf8");
    const SELF = ["PATCH /coach/gym/pay", "POST /coach/gym/pay/new-address", "PUT /coach/paystack", "PUT /coach/payfast", "DELETE /coach/payfast", "POST /coach/payments/:id/refund", "POST /coach/payments/:id/refunds/:rid/dismiss",
      "POST /coach/assistant", "POST /coach/assistant/confirm", "DELETE /coach/gym", "POST /coach/head", "POST /coach/billing/checkout", "DELETE /coach/billing", "POST /coach/beta", "POST /coach/beta/feedback", "POST /coach/support/end",
      "DELETE /me", "PATCH /me", "POST /me/sessions/end", "POST /me/verify-email", "POST /me/join", "POST /me/leave", "POST /me/claim-gym", "POST /me/kids", "POST /me/as", "POST /auth/logout", "POST /auth/login", "POST /auth/reset"];
    const lacking = SELF.filter((k) => { const [m, p] = k.split(" "); const i = apiSrc.indexOf(`api.${m.toLowerCase()}("${p}", `); return i < 0 || !/^[^\n]*\n\s+noSupport\(req\)/.test(apiSrc.slice(i)); });
    ok(!lacking.length, "each money, ownership and login route checks for support mode itself too: " + JSON.stringify(lacking));
    // 2. Each one tried in support mode: refused before it runs, with the one plain reason, and nothing changes or is emailed.
    const call = (k) => { const [m, p] = k.split(" "); const url = p.replace(":id", String(proof)).replace(":rid", "1").replace(/:what\([^)]*\)/, "reveal").replace(/:[A-Za-z]+/g, String(A.gym));
      const body = { password: "coachpass1", holder: "Thief", bank: "Evil Bank", account: "99999999", branch: "1", userId: A2.id, merchantId: "10000100", merchantKey: "46f0cd694581a", passphrase: "x", action: "apply", all: true, name: "Hacked", email: "x@evil.test", code: B.code, ...(p === "/coach/paystack" ? { bankCode: "470010", account: "1234567890", holder: "X", business: "X", idKind: "reg", idNumber: "2019/123456/07" } : {}) };
      return [m, url, m === "GET" ? undefined : body]; };
    const m2 = sink.mails.length, sess0 = (await pool.query("select count(*)::int as n from sessions where user_id=$1", [A.id])).rows[0].n;
    for (const k of want.filter((x) => !/^(GET|POST) \/admin\/support\/exit$/.test(x))) {
      const [m, url, body] = call(k); r = await boss(m, url, body);
      ok(r.s === 403 && r.j && r.j.error === (k.includes("/admin/") ? TEAM_NO : SUP_NO), `support mode refuses ${k}: ${r.s} ${r.j && r.j.error}`);
    }
    r = await boss("PATCH", `/coach/students/${A.id}`, { phone: "0839999999", notes: "x" }); ok(r.s === 403 && r.j.error === SUP_NO, "and the owner's own record through the member routes");
    r = await boss("DELETE", `/coach/students/${A.id}`); ok(r.s === 403, "including removing them");
    await wait(600);
    ok(sink.mails.length === m2, "no email went out from any of them: " + sink.mails.slice(m2).map((x) => x.subject).join(" | "));
    const g = (await pool.query("select pay, payfast, paystack, head_coach_id, billing, beta, pop_token from gyms where id=$1", [A.gym])).rows[0];
    ok(g && g.pay.account === "62000000001" && g.pay.holder === "Alpha BJJ" && !g.payfast && !g.paystack && String(g.head_coach_id) === String(A.id) && !(g.beta && g.beta.status), "the gym's bank details, PayFast, payouts, head coach and beta are as they were");
    const owner = (await pool.query("select name, email, phone from users where id=$1", [A.id])).rows[0];
    ok(owner && owner.name === "Ann Owner" && owner.email === "a@sup.test" && !owner.phone, "the owner's account is as it was");
    ok((await pool.query("select count(*)::int as n from sessions where user_id=$1", [A.id])).rows[0].n === sess0 && (await A("GET", "/me")).j.me.id === A.id, "the owner is still signed in");
    const changesTried = want.filter((k) => !k.startsWith("GET ") && !/exit$/.test(k)).length + 2;
    ok((await pool.query("select count(*)::int as n from support_log where session_id=$1 and summary like 'Blocked:%' and status=403", [boss.sup])).rows[0].n === changesTried, "each refusal is logged as blocked");
    // Without the app's support header, a change is refused (a tab opened before support started can't act on the gym).
    r = await boss("POST", "/coach/students", { name: "Other tab" }, { "x-jf-support": null }); ok(r.s === 409 && r.j.supportOther, "a change without the support header is refused: " + r.s);
    r = await boss("POST", "/coach/students", { name: "Wrong tab" }, { "x-jf-support": "12345" }); ok(r.s === 409 && r.j.supportEnded, "a change from another support session's page is refused: " + r.s);
    ok(!(await pool.query("select 1 from users where name in ('Other tab','Wrong tab')")).rows.length, "and neither was added anywhere");
    r = await boss("POST", `/admin/gyms/${B.gym}/support`, {}); ok(r.s === 403 && r.j.error === TEAM_NO, "starting another one while in support mode: exit first");

    // ---------- another gym stays out of reach ----------
    r = await boss("GET", `/coach/students/${BM.id}`); ok(r.s === 404, "another gym's member: " + r.s);
    r = await boss("PUT", `/classes/${bClass}`, { title: "Hijacked", startsAt: new Date(Date.now() + 2 * 864e5).toISOString(), durationMin: 60 }); ok(r.s === 404, "another gym's class: " + r.s);
    r = await boss("GET", `/coach/classes/${bClass}`); ok(r.s === 404, "another gym's class details: " + r.s);
    ok(!JSON.stringify((await boss("GET", "/coach/roster")).j).includes("Bravomember"), "another gym's people aren't in the roster");
    ok((await pool.query("select title from classes where id=$1", [bClass])).rows[0].title === "Bravo fundamentals", "and its class is untouched");

    r = await boss("POST", "/admin/support/exit", {}); ok(r.s === 200 && r.j.ended, "exit"); const s1id = boss.sup; boss.sup = null;

    // ---------- the real head coach: every guarded route still works for them ----------
    const safe = want.filter((k) => !/^(DELETE \/coach\/gym|DELETE \/me|POST \/auth\/logout|POST \/me\/sessions\/end|POST \/me\/(leave|join|claim-gym|kids|as|train)|POST \/coach\/head|POST \/auth\/reset)$/.test(k));
    for (const k of safe) {
      const [m, url, body] = call(k); r = await A(m, url, k === "PATCH /coach/gym/pay" ? { holder: "Alpha BJJ", bank: "FNB", account: "62000000002", branch: "250655", type: "Cheque" } : k === "PATCH /me" ? { name: "Ann Owner" } : k.startsWith("POST /auth/") ? { email: "nobody@sup.test", password: "wrong-pass1" } : body);
      ok(!refusedAsSupport(r), `the head coach isn't refused ${k} as support: ${r.s} ${r.j && r.j.error}`);
    }
    ok((await pool.query("select pay->>'account' as a from gyms where id=$1", [A.gym])).rows[0].a === "62000000002", "the head coach changed their own bank details");
    r = await boss("POST", `/admin/gyms/${A.gym}/support`, {}); boss.sup = r.j.support.id; const sh = boss.sup;
    r = await A("POST", "/coach/head", { userId: A2.id }); ok(r.s === 200, "the head coach can hand over: " + r.s);
    // That ends support: Alpha's head coach isn't who it was.
    r = await boss("GET", "/coach/roster"); ok(r.s === 401 && r.j.supportEnded, "support ends when the gym's head coach changes: " + r.s);
    ok((await pool.query("select ended_how from support_sessions where id=$1", [sh])).rows[0].ended_how === "gym", "(ended: the head coach changed)");
    r = await A2("POST", "/coach/head", { userId: A.id }); ok(r.s === 200, "and it's handed back");
    boss.sup = null;
    r = await boss("GET", "/me"); ok(r.j.me.id === boss.id && r.j.me.admin && !r.j.me.support, "the team member is back in their own account");
    // Charlie's head coach: the ones that end a session or an account.
    for (const [m, u, body] of [["POST", "/me/leave", {}], ["POST", "/me/join", { code: "NOPE1234" }], ["POST", "/me/sessions/end", {}], ["DELETE", "/coach/gym", { password: "coachpass1" }]]) {
      r = await C(m, u, body); ok(!refusedAsSupport(r) && (u !== "/coach/gym" || r.s === 200), `the head coach isn't refused ${m} ${u} as support: ${r.s} ${r.j && r.j.error}`);
    }
    r = await C("DELETE", "/me", { password: "coachpass1" }); ok(r.s === 200, "and can delete their account");

    // ---------- exit: back to their own account, untouched ----------
    r = await boss("POST", `/admin/gyms/${A.gym}/support`, {}); boss.sup = r.j.support.id; const s2 = boss.sup;
    r = await boss("GET", "/me"); ok(r.j.me.id === A.id, "support again");
    r = await boss("POST", "/admin/support/exit", {}); ok(r.s === 200 && r.j.ended && !boss.jar.jf_sup && r.j.me.id === boss.id && r.j.me.admin, "Exit ends it, its cookie goes, and the answer is their own account");
    ok(boss.jar.jf_s === bossTok, "their own session is the same one as before");
    r = await boss("POST", "/coach/students", { name: "After exit" }); ok(r.s === 401 && r.j.supportEnded && !(await pool.query("select 1 from users where name='After exit'")).rows.length, "a change the app still sends as support is refused, not run as the team member");
    boss.sup = null; r = await boss("GET", "/me"); ok(r.j.me.id === boss.id && r.j.me.admin, "their own app");
    const ex = (await pool.query("select ended_how from support_sessions where id=$1", [s2])).rows[0];
    ok(ex.ended_how === "exit" && (await pool.query("select 1 from support_log where session_id=$1 and method='END' and summary='Support session ended'", [s2])).rows.length === 1, "the exit is logged");

    // ---------- 2 hours, then it ends by itself ----------
    r = await boss("POST", `/admin/gyms/${A.gym}/support`, {}); boss.sup = r.j.support.id; const s3 = boss.sup;
    await pool.query("update support_sessions set created_at=now() - interval '121 minutes', expires_at=now() - interval '1 minute' where id=$1", [s3]);
    r = await boss("POST", "/coach/students", { name: "Too late" });
    ok(r.s === 401 && r.j.supportEnded && /2 hours/.test(r.j.error) && !boss.jar.jf_sup && !(await pool.query("select 1 from users where name='Too late'")).rows.length, "after 2 hours a change is refused and support is over: " + JSON.stringify(r.j));
    ok((await pool.query("select ended_how from support_sessions where id=$1", [s3])).rows[0].ended_how === "time", "(ended: time)");
    boss.sup = null; r = await boss("GET", "/me"); ok(r.j.me.id === boss.id, "and the team member is themselves again");
    // Nobody there when the time ran out: the daily tidy-up ends it and logs it.
    r = await boss("POST", `/admin/gyms/${A.gym}/support`, {}); const s4 = r.j.support.id; delete boss.jar.jf_sup;
    await pool.query("update support_sessions set created_at=now() - interval '3 hours', expires_at=now() - interval '1 hour' where id=$1", [s4]);
    await require("../backend/db").purgeRejected(pool);
    ok((await pool.query("select ended_how from support_sessions where id=$1", [s4])).rows[0].ended_how === "time" && (await pool.query("select 1 from support_log where session_id=$1 and method='END'", [s4])).rows.length === 1, "a support session nobody exited ends by itself, logged");
    await pool.query("insert into support_log(gym_id,method,path,summary,created_at) values($1,'POST','/x','old',now() - interval '14 months')", [A.gym]);
    await require("../backend/db").purgeRejected(pool);
    ok(!(await pool.query("select 1 from support_log where summary='old'")).rows.length && (await pool.query("select count(*)::int as n from support_log")).rows[0].n > 5, "the log is kept 13 months");

    // ---------- signing out of their own account (or leaving the team) ends it ----------
    r = await boss("POST", `/admin/gyms/${A.gym}/support`, {}); boss.sup = r.j.support.id; const s5 = boss.sup;
    await pool.query("update users set email_verified_at=null where id=$1", [boss.id]);
    r = await boss("GET", "/coach/roster"); ok(r.s === 401 && r.j.supportEnded, "no longer a verified team member: support ends");
    ok((await pool.query("select ended_how from support_sessions where id=$1", [s5])).rows[0].ended_how === "signedout", "(ended: signed out)");
    await pool.query("update users set email_verified_at=now() where id=$1", [boss.id]); boss.sup = null;

    // ---------- the owner: one email per start, and the log in their app ----------
    await wait(500);
    const starts = (await pool.query("select count(*)::int as n from support_sessions where gym_id=$1", [A.gym])).rows[0].n;
    ownerMails = sink.mails.filter((m) => m.to[0] === "a@sup.test" && /JitsFlow support is helping/.test(m.subject));
    ok(ownerMails.length === starts, `one email per start (${ownerMails.length} for ${starts})`);
    r = await A("GET", "/coach/support");
    const first = r.j.sessions.find((x) => x.id === String(s1id)) || {};
    ok(r.s === 200 && r.j.sessions.length === starts && first.who === "Boss Team" && first.email === "boss@jitsflow.test" && !first.live
      && (first.changes || []).some((c) => c.summary === "Added a member") && (first.changes || []).some((c) => c.summary === "Blocked: Change the gym's bank details" && c.blocked)
      && !(first.changes || []).some((c) => /Nothing saved/.test(c.summary)), "the owner sees each session, who, and what changed: " + JSON.stringify(first).slice(0, 400));
    r = await A2("GET", "/coach/support"); ok(r.s === 403, "other coaches don't");
    // The owner ends one that's on.
    r = await boss("POST", `/admin/gyms/${A.gym}/support`, {}); boss.sup = r.j.support.id;
    r = await A("POST", "/coach/support/end", {}); ok(r.s === 200 && r.j.ended === 1, "the owner can end support access now");
    r = await boss("GET", "/coach/roster"); ok(r.s === 401 && r.j.supportEnded, "and it's over for support straight away");
    boss.sup = null;

    // ---------- the switch: no owner email ----------
    {
      const p2 = port + 100, B2 = `http://127.0.0.1:${p2}`; startSrv(p2, { JF_SUPPORT_EMAIL_OWNER: "0" }); await up(B2);
      const bx = client(B2 + "/api"); bx.jar.jf_s = boss.jar.jf_s;
      const m3 = sink.mails.length; r = await bx("POST", `/admin/gyms/${B.gym}/support`, {}); await wait(600);
      ok(r.s === 201 && !sink.mails.slice(m3).some((m) => m.to[0] === "b@sup.test"), "JF_SUPPORT_EMAIL_OWNER=0: no email to the owner");
      bx.sup = r.j.support.id; await bx("POST", "/admin/support/exit", {});
    }

    // ---------- on the phone (iPhone 13): the dashboard, the banner, switched-off buttons, the owner's list ----------
    b = await chromium.launch();
    const ctxFor = async (c) => { const ctx = await b.newContext({ ...devices["iPhone 13"] }); await ctx.addCookies([{ name: "jf_s", value: c.jar.jf_s, url: BASE }]); return ctx; };
    const ev = (pg, fn, arg) => pg.evaluate(fn, arg);
    const noSideways = (pg) => ev(pg, () => document.documentElement.scrollWidth <= window.innerWidth + 1);
    const shot = async (pg, name) => { if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, name) }); };
    const ctx = await ctxFor(boss), pg = await ctx.newPage();
    pg.on("pageerror", (e) => { fail++; fails.push("page error: " + e.message); });
    await pg.goto(BASE + "/app/?dash=1"); await wait(2500);
    ok(await ev(pg, () => S.ui.sheet && S.ui.sheet.k === "dash" && !!document.querySelector('[data-a="supask"]')), "the dashboard opens (?dash=1) and its gym list offers Manage as support");
    ok(await ev(pg, (id) => !!document.querySelector(`[data-a="supask"][data-v="${id}"]`), A.gym), "for Alpha");
    await ev(pg, (id) => document.querySelector(`[data-a="supask"][data-v="${id}"]`).closest(".dgym").scrollIntoView({ block: "center" }), A.gym); await wait(300);
    await shot(pg, "1-dashboard-manage-as-support.png");
    ok(await noSideways(pg), "dashboard: no sideways scroll");
    await pg.click(`[data-a="supask"][data-v="${A.gym}"]`); await wait(400);
    ok(await ev(pg, () => /Manage Alpha BJJ\?/.test(document.getElementById("sheet").innerText) && /gets an email/.test(document.getElementById("sheet").innerText)), "it asks first, saying the owner is told");
    await Promise.all([pg.waitForNavigation(), pg.click('[data-a="supgo"]')]); await wait(2500);
    const toastTxt = await ev(pg, () => document.getElementById("toast").textContent + " | me=" + (API.me && API.me.email) + " sup=" + JSON.stringify(API.support));
    const bar = await ev(pg, () => { const x = document.getElementById("supbar"); if (!x) return null; const r2 = x.getBoundingClientRect(); return { t: x.innerText, top: r2.top, h: r2.height, exit: !!x.querySelector('[data-a="supexit"]') }; });
    ok(bar && /Managing Alpha BJJ as JitsFlow support · (1 h 59 min|2 h) left/.test(bar.t) && bar.exit && bar.top === 0, "the amber bar: Managing Alpha BJJ as JitsFlow support · time left · Exit: " + JSON.stringify(bar) + " " + toastTxt);
    ok(await ev(pg, () => API.me.gym.name === "Alpha BJJ" && isHead() && S.ui.tab === "coach" && COACH.view === "home" && !API.me.admin), "the app is Alpha's head coach's, on Today");
    ok(await ev(pg, () => { const n = document.querySelector("nav.tabs"), x = document.getElementById("supbar"); return !n.hidden && x.getBoundingClientRect().bottom <= n.getBoundingClientRect().top; }), "the bar doesn't cover the tabs");
    ok(await ev(pg, () => getComputedStyle(document.getElementById("supbar")).position === "sticky" && [...document.styleSheets].some((sh) => { try { return [...sh.cssRules].some((x) => x.selectorText === ".supbar" && /safe-area-inset-top/.test(x.cssText)); } catch (e) { return false; } })), "it sits at the top, clear of the phone's status bar (safe area)");
    ok(await noSideways(pg), "Today in support mode: no sideways scroll");
    await shot(pg, "2-support-banner-today.png");
    await pg.click('nav.tabs [data-v="coach-money"]'); await wait(1500);
    ok(await ev(pg, () => !!document.getElementById("supbar") && COACH.view === "money" && /Managing Alpha BJJ/.test(document.getElementById("supbar").innerText)), "the bar stays on Money");
    ok(await noSideways(pg), "Money: no sideways scroll");
    await shot(pg, "3-support-banner-money.png");
    // Gym › Getting paid (from Money's row): the bank details are switched off, with the reason.
    await ev(pg, () => { S.ui.openG = { ...(S.ui.openG || {}), "m-bank": 1 }; }); await pg.click("#m-gotpaid"); await wait(1200);
    ok(await ev(pg, () => S.ui.sheet && S.ui.sheet.k === "gymsec" && S.ui.sheet.id === "pay"), "Money's Getting paid row opens Gym › Getting paid");
    const bank = await ev(pg, () => { const f = document.getElementById("bankform"); if (!f) return null; const btn = f.querySelector("[type=submit]"), box = f.closest(".panel,section,details") || f.parentElement;
      return { all: [...f.querySelectorAll("input,select,button")].every((x) => x.disabled), note: ((box.querySelector(".supnote") || f.parentElement.querySelector(".supnote")) || {}).textContent || "", btn: !!btn }; });
    ok(bank && bank.all && bank.note === SUP_NO, "Gym › Getting paid: the bank details form is switched off, with the reason: " + JSON.stringify(bank));
    ok(await ev(pg, () => { const x = document.getElementById("supbar"), h = document.querySelector("#sheet h1"); return !!x && !!h && x.getBoundingClientRect().bottom <= h.getBoundingClientRect().top + 1; }), "the bar sits above the Gym sheet");
    ok(await noSideways(pg), "Gym › Getting paid: no sideways scroll");
    await ev(pg, () => { const d = document.getElementById("bankform").closest("details"); window.scrollTo(0, d.getBoundingClientRect().top + window.scrollY - 90); }); await wait(300);
    await shot(pg, "4-guarded-bank-details.png"); await ev(pg, () => hideSheet());
    // A sheet opens below the bar (the bar never covers its buttons).
    await ev(pg, () => addStudentSheet()); await wait(500);
    ok(await ev(pg, () => { const x = document.getElementById("supbar"), sb = document.getElementById("sheetbar"); return !document.getElementById("sheet").hidden && x.getBoundingClientRect().bottom <= sb.getBoundingClientRect().top; }), "a sheet: the bar stays at the top, its buttons clear");
    await ev(pg, () => hideSheet());
    // The Gym tab: the checklist under the bar; My training (the owner's own) and the owner's login buttons are switched off; a tap on one says why.
    await pg.click('nav.tabs [data-v="coach-gym"]'); await wait(1500);
    const guarded = (as) => ev(pg, (as) => as.map((a) => { const x = document.querySelector(`[data-a="${a}"]`), box = x && x.closest(".panel,section");
      return x ? x.disabled && x.title === SUP_NO && !!box && !!box.querySelector(".supnote") && box.querySelectorAll(".supnote").length === 1 : "missing:" + a; }), as);
    ok(await ev(pg, () => { const x = document.getElementById("supbar"), g = document.querySelector(".gymtop"); return !!g && document.querySelectorAll("#gymcheck .ckrow").length === 6 && x.getBoundingClientRect().bottom <= g.getBoundingClientRect().top; }), "the bar sits above the Gym checklist");
    const mt = await guarded(["mytrain"]); ok(mt.every((x) => x === true), "Gym: My training is switched off with the reason: " + JSON.stringify(mt));
    await pg.click('[data-a="mytrain"]', { force: true }).catch(() => {}); await wait(300); ok(await ev(pg, () => S.ui.tab === "coach" && COACH.view === "gym"), "and tapping it anyway stays on Gym");
    await ev(pg, () => gymSec("account")); await wait(600);
    const gym = await guarded(["signout", "signoutall", "delacct", "gymdel"]);
    ok(gym.every((x) => x === true), "Gym › Account: sign out, sign out everywhere, delete account and delete gym are switched off with the reason: " + JSON.stringify(gym));
    ok(await ev(pg, () => { const f = document.getElementById("phoneform"); return !!f && [...f.querySelectorAll("input,button")].every((x) => x.disabled); }), "the owner's own number can't be changed");
    ok(await noSideways(pg), "Gym › Account: no sideways scroll");
    await ev(pg, () => document.querySelector('[data-a="signout"]').scrollIntoView({ block: "center" })); await wait(300);
    await shot(pg, "6-guarded-account-buttons.png");
    await ev(pg, () => gymSec("support")); await wait(800);
    ok(await ev(pg, () => !!document.getElementById("supportacc") && !document.getElementById("dashpanel")), "support sees the Support access list, and no team tools");
    await ev(pg, () => gymSec("profile")); await wait(600);
    // Normal work from the app goes through and is logged.
    const n0 = (await pool.query("select count(*)::int as n from support_log where summary like 'Changed gym settings (name%'")).rows[0].n;
    await ev(pg, () => { document.getElementById("g-name").value = "Alpha BJJ"; document.querySelector("#gymform [type=submit]").click(); }); await wait(1200);
    ok((await pool.query("select count(*)::int as n from support_log where summary like 'Changed gym settings (name%'")).rows[0].n === n0 + 1, "a change made in the app is logged");
    // Exit: back to their own app, on the dashboard.
    await Promise.all([pg.waitForNavigation(), pg.click('[data-a="supexit"]')]); await wait(2500);
    ok(await ev(pg, () => !document.getElementById("supbar") && !API.support && API.me && API.me.admin && API.me.email === "boss@jitsflow.test" && S.ui.sheet && S.ui.sheet.k === "dash"), "Exit: their own app, on the dashboard");
    ok(!(await ctx.cookies()).some((x) => x.name === "jf_sup") && (await ctx.cookies()).some((x) => x.name === "jf_s" && x.value === bossTok), "the support cookie is gone; their own is the same");
    await ctx.close();
    // The owner's Support access list.
    const octx = await ctxFor(A), op = await octx.newPage();
    op.on("pageerror", (e) => { fail++; fails.push("page error (owner): " + e.message); });
    await op.goto(BASE + "/app/#coach-gym"); await wait(2500); await op.click('.gymsettings [data-a="gymsec"][data-v="support"]'); await wait(1200);
    const acc = await ev(op, () => { const x = document.getElementById("supportacc"); return x ? x.innerText : ""; });
    ok(/Support access/i.test(acc) && /Boss Team/.test(acc) && /Added a member/.test(acc) && /Changed gym settings \(name/.test(acc) && /every change shows here/.test(acc), "the owner's Gym › Support access: who and what changed: " + acc.slice(0, 600));
    ok(await ev(op, () => !document.getElementById("supbar")), "the owner sees no support bar");
    await ev(op, () => document.getElementById("supportacc").scrollIntoView({ block: "start" })); await wait(300);
    ok(await noSideways(op), "the owner's Gym › Support access: no sideways scroll");
    await shot(op, "5-owner-support-access.png");
    await octx.close();

    // ---------- starts are rate limited ----------
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) { r = await boss("POST", `/admin/gyms/${B.gym}/support`, {}); if (r.s === 429) limited = true; else if (r.j && r.j.support) { boss.sup = r.j.support.id; await boss("POST", "/admin/support/exit", {}); boss.sup = null; } }
    ok(limited, "starting support is rate limited (10 an hour)");
  } catch (e) { fail++; fails.push("crashed: " + (e.stack || e.message)); }
  finally { if (b) await b.close(); for (const s of servers) s.kill(); await pool.end(); sink.close(); ps.close(); }
  console.log(`support: ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log("  FAIL", f);
  process.exit(fail ? 1 : 0);
})();
