// Security regressions against a real PostgreSQL: each section replays an attack from the security review and checks it now fails
// (admin by an unverified email, gym emails as a relay, taking over records a coach added, families by a typed phone number, rate-limit
// races and IPv6 rotation, unclaim leftovers, account enumeration, check-in and trial abuse, non-head coach edits).
// Usage: DATABASE_URL=postgres://.../<something>test node tests/security.js   (wipes that database)
"use strict";
const { spawn } = require("child_process"); const path = require("path"); const http = require("http"); const crypto = require("crypto");
const { Pool } = require("pg"); const bcrypt = require("bcryptjs");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const DAY = 864e5, day = (n = 0) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const time = async (f) => { const t = process.hrtime.bigint(); await f(); return Number(process.hrtime.bigint() - t) / 1e6; };

// A mail sink like Resend's API: records each email; answers after `delay` ms; `failing` makes it answer 500.
function mailSink() {
  const mails = []; const st = { delay: 0, failing: false };
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { mails.push(JSON.parse(b)); } catch (e) {}
    setTimeout(() => { res.writeHead(st.failing ? 500 : 200, { "content-type": "application/json" }); res.end('{"id":"x"}'); }, st.delay); }); });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}/emails`, mails, st, close: () => srv.close() })));
}
let ipN = 1;
const freshIp = () => `198.51.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
function client(base, headers0 = {}) {
  let cookie = ""; const ip = freshIp();
  const c = async (method, url, body, headers = {}) => {
    const h = { "x-forwarded-for": ip, ...headers0, ...headers }; if (cookie) h.cookie = cookie;
    if (method !== "GET" && !("x-jf" in headers)) { h["content-type"] = h["content-type"] || "application/json"; h["x-jf"] = "1"; }
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = m[1] ? "jf_s=" + m[1] : ""; }
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { s: r.status, j, t, h: r.headers };
  };
  c.cookie = () => cookie;
  return c;
}

(async () => {
  // Unit: IPv6 addresses count per /64 for rate limits.
  { const { v6net } = require("../backend/api");
    ok(v6net("2001:db8:1:1::1") === "2001:db8:1:1::/64" && v6net("2001:DB8:1:1:abcd::9") === "2001:db8:1:1::/64" && v6net("2001:db8::1") === "2001:db8:0:0::/64" && v6net("fe80::1%eth0") === "fe80:0:0:0::/64",
      "IPv6 addresses are bucketed by /64: " + [v6net("2001:db8:1:1::1"), v6net("2001:db8::1")]); }

  const pool = new Pool({ connectionString: DB });
  await pool.query("drop schema public cascade; create schema public;");
  const sink = await mailSink();
  const port = 9600 + Math.floor(Math.random() * 90), ORIGIN = `http://127.0.0.1:${port}`, base = ORIGIN + "/api";
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB, TRUST_PROXY: "1", RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, APP_URL: "https://www.jitsflow.test",
    JF_ADMIN_EMAILS: "boss@jf.test", MAIL_GAP_MS: "0", PAYFAST_SANDBOX: "" }; delete env.ANTHROPIC_API_KEY; delete env.GA_ID;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 80; i++) { try { await fetch(ORIGIN + "/healthz"); break; } catch (e) { await wait(150); } }
  await wait(300);
  const to = (addr, from = 0) => sink.mails.slice(from).filter((m) => (m.to || [])[0] === addr);
  const linkIn = (m, k) => m && ((m.text || "").match(new RegExp(`[?&]${k}=([A-Za-z0-9_-]+)`)) || [])[1];
  const H4 = await bcrypt.hash("password123", 4);
  // Seeded people (fast): a users row, signed in.
  async function mk(gym, role, name, email, extra = {}) {
    const id = (await pool.query("insert into users(gym_id,role,name,email,pass_hash,phone,created_at,signed_up_at) values($1,$2,$3,$4,$5,$6,now()-interval '150 days',now()) returning id",
      [gym, role, name, email, H4, extra.phone || ""])).rows[0].id;
    const c = client(base); const r = await c("POST", "/auth/login", { email, password: "password123" }); if (r.s !== 200) throw new Error("login " + email + " " + r.s);
    c.id = String(id); return c;
  }
  const verify = (id) => pool.query("update users set email_verified_at=now(), email_verified_for=email where id=$1", [id]);
  async function gym(name, sc, cc, age = "150 days") { return String((await pool.query(`insert into gyms(name,student_code,coach_code,created_at) values($1,$2,$3,now()-$4::interval) returning id`, [name, sc, cc, age])).rows[0].id); }
  const head = async (g, name, email) => { const h = await mk(g, "coach", name, email); await pool.query("update gyms set head_coach_id=$1 where id=$2", [h.id, g]); return h; };

  let ADMIN = null;
  try {
    // ---------- 1. Platform admin needs a verified email ----------
    {
      const atk = client(base);
      let r = await atk("POST", "/auth/register", { name: "Not the boss", email: "Boss@JF.test", password: "attacker-pass-1" });
      ok(r.s === 201 && !r.j.me.admin && r.j.me.adminVerify && !r.j.me.emailVerified, "registering an unclaimed JF_ADMIN_EMAILS address doesn't make an admin: " + JSON.stringify(r.j && r.j.me && [r.j.me.admin, r.j.me.adminVerify]));
      for (const u of ["/admin/overview", "/admin/prospects", "/admin/beta"]) { const x = await atk("GET", u); ok(x.s === 403 && /Verify your email/.test(x.j.error), `unverified admin address: GET ${u} is 403 (${x.s})`); }
      // the real owner of the inbox gets the link; whoever holds the link verifies
      const m0 = sink.mails.length; r = await atk("POST", "/me/verify-email", {}); await wait(100);
      const vm = to("boss@jf.test", m0)[0], vt = linkIn(vm, "verify");
      ok(r.s === 200 && r.j.sent && vm && vm.subject === "Confirm your email for JitsFlow" && vt && vt.length === 64, "Send verification email: a link to that address");
      ok(!(await pool.query("select 1 from email_verifications where token_hash=$1 or token_hash=$2", [vt, vt.toUpperCase()])).rows[0] && (await pool.query("select 1 from email_verifications where token_hash=$1", [sha(vt)])).rows[0], "the token is stored hashed");
      const anon = client(base);
      r = await anon("POST", "/auth/verify", { token: vt }); ok(r.s === 200 && r.j.ok && r.j.me === null, "the link verifies (signed out: nobody is signed in by it)");
      r = await anon("POST", "/auth/verify", { token: vt }); ok(r.s === 400, "the link works once");
      r = await atk("GET", "/me"); ok(r.j.me.admin && r.j.me.emailVerified && !r.j.me.adminVerify, "verified: the team tools open");
      ok((await atk("GET", "/admin/overview")).s === 200, "and /admin/overview answers");
      // email changes: verification no longer counts
      await pool.query("update users set email='boss-old@jf.test' where email='boss@jf.test'"); await pool.query("update users set email='boss@jf.test' where email='boss-old@jf.test'");
      ok((await atk("GET", "/admin/overview")).s === 200, "(same address back: still verified)");
      const other = await mk(null, "student", "Other", "other@jf.test"); await verify(other.id);
      await pool.query("update users set email='boss2@jf.test' where id=$1", [(await pool.query("select id from users where email='boss@jf.test'")).rows[0].id]);
      await pool.query("update users set email='boss@jf.test' where id=$1", [other.id]);
      r = await other("GET", "/me"); ok(!r.j.me.admin && r.j.me.adminVerify && (await other("GET", "/admin/overview")).s === 403, "verification is for the exact address: an account whose email changed to an admin address isn't an admin");
      // expired links don't work
      const m1 = sink.mails.length; await other("POST", "/me/verify-email", {}); await wait(100); const vt2 = linkIn(to("boss@jf.test", m1)[0], "verify");
      await pool.query("update email_verifications set expires_at=now()-interval '1 second'");
      ok((await anon("POST", "/auth/verify", { token: vt2 })).s === 400 && !(await other("GET", "/me")).j.me.admin, "an expired link is refused");
      // a password reset proves the email too
      const m2 = sink.mails.length; await anon("POST", "/auth/forgot", { email: "boss@jf.test" }); await wait(300);
      const rt = linkIn(to("boss@jf.test", m2)[0], "reset"); r = await other("POST", "/auth/reset", { token: rt, password: "newpassword1" });
      ok(r.s === 200 && r.j.me.admin, "setting a password from the reset email verifies the address");
      ok((await other("POST", "/me/claim-gym", { token: "A".repeat(32) })).s === 403, "(the team still can't claim gyms)");
      ADMIN = other;
    }

    // ---------- 2. Gym emails: verified coach, caps for new gyms, offline people, a stop link ----------
    {
      const co = client(base, { "x-forwarded-for": "173.245.48.10", "cf-connecting-ip": "2001:db8:aa:1::1" });
      let m0 = sink.mails.length;
      let r = await co("POST", "/auth/start-gym", { gym: "Your account is suspended, log in at evil.example", name: "Bank Security", email: "atk@evil.test", password: "attackpass1" });
      await wait(200); const wm = to("atk@evil.test", m0)[0];
      ok(r.s === 201 && wm && !/suspended|evil\.example/.test(wm.subject + wm.html + wm.text) && linkIn(wm, "verify"), "the welcome email doesn't carry the gym name someone typed, and has the email check in it");
      const gid = r.j.me.gym.id, sc = r.j.me.gym.studentCode;
      const victims = Array.from({ length: 60 }, (_, i) => ({ name: `Victim ${i}`, email: `victim${i}@target.test` }));
      r = await co("POST", "/coach/students/bulk", { people: victims }); const ids = r.j.ids;
      m0 = sink.mails.length;
      r = await co("POST", "/coach/message", { subject: "Urgent: verify your account", text: "Log in at https://evil.example", userIds: ids });
      ok(r.s === 403 && r.j.verify === true && sink.mails.length === m0, "an unverified coach can't email anyone (the app offers the verification email): " + r.s);
      r = await co("POST", "/coach/invite", { emails: ["x1@target.test", "x2@target.test"] }); ok(r.s === 403 && r.j.verify === true && sink.mails.length === m0, "nor send invites");
      // the coach verifies from the welcome email
      ok((await client(base)("POST", "/auth/verify", { token: linkIn(wm, "verify") })).s === 200, "the welcome email's button verifies the coach");
      r = await co("POST", "/coach/message", { subject: "Urgent", text: "Log in at https://evil.example", userIds: ids });
      ok(r.s === 200 && r.j.sent === 0 && r.j.held.length === 60 && sink.mails.length === m0, "a new gym's messages don't go to people the coach added who aren't on the app: " + JSON.stringify([r.j.sent, (r.j.held || []).length]));
      r = await co("POST", "/coach/invite", { emails: Array.from({ length: 25 }, (_, i) => `inv${i}@target.test`) });
      const r2 = await co("POST", "/coach/invite", { emails: Array.from({ length: 25 }, (_, i) => `inv${i + 25}@target.test`) });
      ok(r.j.sent === 25 && r2.j.sent === 5 && r2.j.failed.length === 20, "a new gym emails at most 30 people a day: " + [r.j.sent, r2.j.sent]);
      const inv = to("inv0@target.test")[0], stop = inv && ((inv.text || "").match(/https:\/\/www\.jitsflow\.test\/api\/gym-mail\/stop\/([A-Za-z0-9_-]{24})/) || [])[1];
      ok(inv && stop && inv.headers && inv.headers["List-Unsubscribe"] === `<https://www.jitsflow.test/api/gym-mail/stop/${stop}>` && inv.headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click", "each invite has a stop link and List-Unsubscribe headers");
      const page = await fetch(ORIGIN + "/api/gym-mail/stop/" + stop).then((x) => x.text());
      ok(/<form method="post"/.test(page) && !(await pool.query("select stopped_at from gym_mail_stops where token=$1", [stop])).rows[0].stopped_at, "opening the link shows one button (a scanner opening it stops nothing)");
      const one = await fetch(ORIGIN + "/api/gym-mail/stop/" + stop, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
      ok(one.status === 200 && (await pool.query("select stopped_at from gym_mail_stops where token=$1", [stop])).rows[0].stopped_at, "a mail app's one-tap unsubscribe (a form POST with no app header) stops them");
      // an established gym: 3 members who signed up, 8 days old; offline people get messages, but not someone who stopped them
      for (let i = 0; i < 3; i++) await client(base)("POST", "/auth/register", { code: sc, name: "Member " + i, email: `member${i}@gym.test`, password: "memberpass" + i });
      await pool.query("update gyms set created_at=now()-interval '8 days' where id=$1", [gid]);
      const memberIds = (await pool.query("select id from users where gym_id=$1 and email like 'member%'", [gid])).rows.map((x) => String(x.id));
      await pool.query("insert into gym_mail_stops(gym_id,email,token,stopped_at) values($1,'victim0@target.test',$2,now())", [gid, crypto.randomBytes(18).toString("base64url")]);
      m0 = sink.mails.length; r = await co("POST", "/coach/message", { subject: "Training this week", text: "See you on the mats.", userIds: [...memberIds, ids[0], ids[1]] });
      ok(r.j.sent === 4 && r.j.stopped.length === 1 && to("member0@gym.test", m0).length === 1 && to("victim1@target.test", m0).length === 1 && !to("victim0@target.test", m0).length, "an established gym reaches its members and the people it added, except who stopped its emails: " + JSON.stringify(r.j));
      r = await co("POST", "/coach/invite", { emails: ["inv0@target.test"] }); ok(r.j.sent === 0 && r.j.stopped.length === 1, "and invites aren't sent to an address that stopped them");
    }

    // ---------- 3. A gym's code doesn't take over records the coach added ----------
    const g1 = await gym("Gym One", "STUDENT1", "COACHAA1"), H1 = await head(g1, "Head One", "h1@x.test");
    {
      const kid = (await pool.query("insert into users(gym_id,role,name,phone,parent_name,offline,pay_ref) values($1,'student','Lerato Mokoena','0831112222','Mrs Mokoena',true,'JFKID01') returning id", [g1])).rows[0].id;
      const adult = (await pool.query("insert into users(gym_id,role,name,phone,email,offline,notes,pay_ref) values($1,'student','Sipho Dlamini','0834445555','sipho@real.test',true,'private coach note','JFSIPHO') returning id", [g1])).rows[0].id;
      await pool.query("insert into payments(gym_id,user_id,amount_cents,paid_on,status,source) values($1,$2,85000,current_date,'confirmed','manual')", [g1, adult]);
      const n0 = (await pool.query("select count(*)::int as n from notices where kind='duplicate'")).rows[0].n;
      const a1 = client(base);
      let r = await a1("POST", "/auth/register", { code: "STUDENT1", name: "Lerato Mokoena", email: "atk1@evil.test", password: "password123" });
      const kr = (await pool.query("select pass_hash, email from users where id=$1", [kid])).rows[0];
      ok(r.s === 201 && !r.j.ask && r.j.me.id !== String(kid) && !kr.pass_hash && !kr.email, "signing up with the code and a kid's name makes a new account; the kid's record is untouched");
      ok((await pool.query("select count(*)::int as n from notices where kind='duplicate'")).rows[0].n === n0 + 1, "and the head coach is told it may be the same person");
      r = await client(base)("POST", "/auth/register", { code: "STUDENT1", name: "sipho  dlamini", email: "atk2@evil.test", password: "password123", link: String(adult) });
      const ad = (await pool.query("select email, pass_hash from users where id=$1", [adult])).rows[0];
      ok(r.s === 201 && ad.email === "sipho@real.test" && !ad.pass_hash && !JSON.stringify(r.j).includes("Sipho"), "a link= with someone else's record id is ignored: their record and payments stay theirs");
      const a2 = client(base);
      await pool.query("insert into users(gym_id,role,name,phone,parent_name,offline) values($1,'student','Kid A','0846667777','Mom',true),($1,'student','Kid B','0846667777','Mom',true)", [g1]);
      r = await a2("POST", "/auth/register", { code: "STUDENT1", name: "Whoever", phone: "084 666 7777", email: "atk3@evil.test", password: "password123" });
      ok(r.s === 201 && !r.j.ask && !/Kid A|Kid B/.test(JSON.stringify(r.j)), "a phone number reveals nobody's kids");
      r = await a2("POST", "/auth/register", { code: "STUDENT1", name: "Whoever2", phone: "084 666 7777", email: "atk4@evil.test", password: "password123", kids: [String(kid)] });
      ok(r.s === 201 && !(await pool.query("select parent_id from users where id=$1", [kid])).rows[0].parent_id, "kids= without a kid's invite link links nobody");
      // the coach's invite link still signs them into their record
      const tok = new URL((await H1("POST", `/coach/students/${adult}/claim-link`)).j.url).searchParams.get("claim");
      r = await client(base)("POST", "/auth/register", { code: "STUDENT1", claim: tok, name: "Sipho Dlamini", email: "sipho@real.test", password: "siphopass1" });
      ok(r.s === 201 && r.j.me.id === String(adult), "the coach's invite link still signs them into their own record");
    }

    // ---------- 4. Families come from links, never from a number someone typed ----------
    {
      await pool.query("update gyms set monthly_fee_cents=60000, pay='{\"holder\":\"Gym One\",\"bank\":\"FNB\",\"account\":\"62111111111\"}' where id=$1", [g1]);
      const v = (await pool.query(`insert into users(gym_id,role,name,phone,parent_name,offline,monthly_fee_cents,created_at,email) values
        ($1,'student','Ayanda Zulu','072 555 1234','Mrs Zulu',true,60000,now()-interval '70 days','mrszulu@real.test'),($1,'student','Bongi Zulu','0725551234','Mrs Zulu',true,60000,now()-interval '70 days',null) returning id`, [g1])).rows.map((x) => String(x.id));
      const A = await mk(g1, "student", "Mallory", "m@x.test", { phone: "0820000000" });
      let r = await A("PATCH", "/me", { phone: "072 555 1234" });
      r = await A("POST", "/me/kids", { name: "Zz Fake" }); ok(r.s === 201, "a parent can still add a new kid by name");
      r = await A("POST", "/me/kids", { name: "Ayanda Zulu" });
      ok(r.s === 409 && /invite link/.test(r.j.error) && !(await pool.query("select parent_id from users where id=$1", [v[0]])).rows[0].parent_id, "typing a kid's name (with their parent's number on your profile) doesn't link them");
      r = await A("GET", "/me/pay"); const fam = r.j.pay && r.j.pay.family;
      ok(!(fam && fam.kids.some((x) => /Zulu/.test(x.name))), "another family's kids aren't on your Pay sheet: " + JSON.stringify(fam && fam.kids.map((x) => x.name)));
      r = await H1("GET", "/coach/money"); const mo = Object.fromEntries(r.j.students.map((s) => [s.id, s]));
      const fake = Object.values(mo).find((x) => x.name === "Zz Fake");
      ok(mo[v[0]].family && mo[v[0]].family === mo[v[1]].family && fake && fake.family !== mo[v[0]].family && (!mo[A.id] || mo[A.id].family !== mo[v[0]].family), "kids the coach added with the same number are still one family; the member who typed that number (and their kid) isn't in it");
      await verify(H1.id); const m0 = sink.mails.length;
      r = await H1("POST", "/coach/money/remind", { userIds: Object.keys(mo), auto: false }); await wait(600);
      const toA = to("m@x.test", m0);
      ok(!toA.some((m) => /Ayanda|Bongi|claim=/.test(m.text)), "the attacker's inbox gets no one else's reminder or invite link: " + toA.map((m) => m.subject));
      const zulu = to("mrszulu@real.test", m0)[0];
      ok(zulu && /Ayanda/.test(zulu.text) && /Bongi/.test(zulu.text), "the real family's reminder goes to the email the coach has for them");
      const claimTok = linkIn(zulu, "claim"), owner = claimTok && (await pool.query("select id from users where claim_token=$1", [claimTok])).rows[0];
      ok(!claimTok || (owner && String(owner.id) === v[0]), "a family reminder only carries the invite link of the record the email belongs to");
    }

    // ---------- 5 & 6. Rate limits: counted before the password check, IPv6 by /64, sign-ups and gyms ----------
    {
      await client(base)("POST", "/auth/register", { name: "Victim", email: "victim@x.test", password: "password123" });
      const anon = client(base), N = 60;
      const out = await Promise.all(Array.from({ length: N }, (_, i) => anon("POST", "/auth/login", { email: "victim@x.test", password: i === N - 1 ? "password123" : "guess" + i })));
      const c401 = out.filter((x) => x.s === 401).length, c200 = out.filter((x) => x.s === 200).length;
      ok(c401 <= 10 && c200 === 0, `${N} logins at once from one address: ${c401} wrong-password answers (at most 10), ${c200} signed in`);
      ok((await anon("POST", "/auth/login", { email: "victim@x.test", password: "password123" })).s === 429, "after that, even the right password waits");
      const good = client(base); let st = [];
      for (let i = 0; i < 14; i++) st.push((await good("POST", "/auth/login", { email: "h1@x.test", password: "password123" })).s);
      ok(st.every((s) => s === 200), "signing in correctly again and again doesn't use up attempts: " + st.join(","));
      // IPv6 rotation behind Cloudflare: one /64 is one address
      st = []; for (let i = 0; i < 40; i++) st.push((await anon("POST", "/auth/login", { email: "victim2@x.test", password: "x" + i }, { "x-forwarded-for": "173.245.48.10", "cf-connecting-ip": `2001:db8:1:1::${(i + 1).toString(16)}` })).s);
      ok(st.filter((s) => s === 429).length >= 25, `40 guesses from 40 addresses in one IPv6 /64: ${st.filter((s) => s === 401).length} answered, ${st.filter((s) => s === 429).length} limited`);
      ok((await anon("POST", "/auth/login", { email: "victim2@x.test", password: "y" }, { "x-forwarded-for": "173.245.48.10", "cf-connecting-ip": "2001:db8:1:2::1" })).s === 401, "another /64 is someone else");
      // new gyms per address: several sent at once can't all get past the check
      const gs = await Promise.all(Array.from({ length: 14 }, (_, i) => client(base, { "x-forwarded-for": "173.245.48.10", "cf-connecting-ip": `2001:db8:2:2::${i + 1}` })("POST", "/auth/start-gym", { gym: "G" + i, name: "N", email: `same${i}@evil.test`, password: "attackpass1" })));
      ok(gs.filter((x) => x.s === 201).length === 10, "14 gyms started at once from one /64: 10 made: " + gs.map((x) => x.s).join(","));
    }

    // ---------- 7. /me/join: wrong codes are limited ----------
    {
      const J = await mk(null, "student", "Joiner", "j@x.test"); let lim = 0, msg = "";
      for (let i = 0; i < 30; i++) { const x = await J("POST", "/me/join", { code: "ZZZZZZ" + String(i).padStart(2, "2") }); if (x.s === 429) { lim++; msg = x.j.error; } }
      ok(lim >= 15 && /try again in a few minutes/i.test(msg), `30 wrong codes from one account: ${lim} limited ("${msg}")`);
      const J2 = await mk(null, "student", "Joiner Two", "j2@x.test");
      for (let i = 0; i < 4; i++) await J2("POST", "/me/join", { code: "WRONG00" + i });
      for (let i = 0; i < 8; i++) await J2("POST", "/me/join", { code: "STUDENT1" });
      ok((await J2("POST", "/me/join", { code: "STUDENT1" })).s === 200, "the right code doesn't count against them");
    }

    // ---------- 8. Unclaim and reassign leave nothing of the wrong claimant behind ----------
    {
      const ADM = ADMIN;
      const mkProspect = async (dom) => { const token = crypto.randomBytes(24).toString("base64url");
        const id = (await pool.query("insert into prospects(token,website,domain,name,import_state,status,profile) values($1,$2,$3,$4,'done','sent',$5) returning id",
          [token, "https://" + dom, dom, "Prospect " + dom, { name: "Prospect " + dom, timetable: [{ day: "Mon", start: "18:00", end: "19:00", title: "BJJ" }], rates: [{ name: "Monthly", price: 500, period: "month" }] }])).rows[0].id;
        await ADM("POST", `/admin/prospects/${id}/build`, {}); return { token, id };
      };
      const P = await mkProspect("p1.test"), W = client(base);
      let r = await W("POST", "/auth/start-gym", { prospect: P.token, name: "Impostor", email: "imp@x.test", password: "password123" });
      const pg = r.j.me.gym.id;
      await W("PATCH", "/coach/gym/pay", { holder: "Impostor", bank: "FNB", account: "62000000001", branch: "250655" });
      await W("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12", passphrase: "imp secret" });
      await W("POST", "/coach/payments", { amountCents: 50000, paidOn: day(), note: "impostor data" });
      await W("POST", "/coach/plans", { name: "Impostor plan", priceCents: 1000, period: "month" });
      await W("POST", "/coach/students", { name: "Phish Target", email: "target@victim.test" });
      await W("PATCH", "/coach/gym", { waPhone: "082 000 1111" });
      r = await ADM("POST", `/admin/gyms/${pg}/unclaim`, {}); ok(r.s === 200, "admin unclaims (" + r.s + ")");
      const pv = client(base, { "x-jf-preview": P.token });
      const pay = await pv("GET", "/coach/gym/pay"), pf = await pv("GET", "/coach/payfast"), pays = await pv("GET", "/coach/payments"), plans = (await pool.query("select name from plans where gym_id=$1", [pg])).rows.map((x) => x.name);
      ok(pay.s === 200 && !pay.j.pay.account && !pay.j.pay.holder && !(pf.j.payfast && pf.j.payfast.connected) && !(pays.j.payments || []).length, "after unclaim the preview shows none of the claimant's bank, PayFast or payments: " + JSON.stringify([pay.j.pay, pf.j.payfast, (pays.j.payments || []).length]));
      ok(!plans.includes("Impostor plan") && !(await pool.query("select 1 from users where email='target@victim.test'")).rows[0] && !(await pool.query("select wa_phone from gyms where id=$1", [pg])).rows[0].wa_phone, "and the plans, people and WhatsApp number they added are gone");
      r = await client(base)("POST", "/auth/start-gym", { prospect: P.token, name: "Real Owner", email: "owner@x.test", password: "password123" });
      const O = client(base); await O("POST", "/auth/login", { email: "owner@x.test", password: "password123" });
      const op = await O("GET", "/coach/gym/pay"), opf = await O("GET", "/coach/payfast");
      ok(r.s === 201 && !op.j.pay.account && !(opf.j.payfast && opf.j.payfast.connected), "the next owner starts with no bank details or PayFast account");
      // reassign, with a member in the gym
      const P2 = await mkProspect("p2.test"), W2 = client(base);
      r = await W2("POST", "/auth/start-gym", { prospect: P2.token, name: "Impostor Two", email: "imp2@x.test", password: "password123" }); const pg2 = r.j.me.gym.id, sc2 = r.j.me.gym.studentCode;
      await W2("PATCH", "/coach/gym/pay", { holder: "Impostor", bank: "FNB", account: "62000000002", branch: "250655" });
      await W2("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12", passphrase: "imp secret" });
      await client(base)("POST", "/auth/register", { code: sc2, name: "A Member", email: "amember@x.test", password: "password123" });
      await client(base)("POST", "/auth/register", { name: "Right Owner", email: "right@x.test", password: "password123" });
      r = await ADM("POST", `/admin/gyms/${pg2}/reassign`, { email: "right@x.test" });
      const R = client(base); await R("POST", "/auth/login", { email: "right@x.test", password: "password123" });
      const rp = await R("GET", "/coach/gym/pay"), rpf = await R("GET", "/coach/payfast");
      ok(r.s === 200 && rp.s === 200 && !rp.j.pay.account && !(rpf.j.payfast && rpf.j.payfast.connected) && (await pool.query("select 1 from users where email='amember@x.test' and gym_id=$1", [pg2])).rows[0], "reassign: the right owner gets the gym and its members, without the claimant's bank or PayFast");
    }

    // ---------- 9. Forgot password and sign-in don't say who has an account ----------
    {
      await client(base)("POST", "/auth/register", { name: "Real", email: "real@x.test", password: "password123" });
      sink.st.delay = 250; const tf = { yes: [], no: [] };
      for (let i = 0; i < 4; i++) { tf.yes.push(await time(() => client(base)("POST", "/auth/forgot", { email: "real@x.test" }))); tf.no.push(await time(() => client(base)("POST", "/auth/forgot", { email: `nobody${i}@x.test` }))); }
      ok(Math.abs(med(tf.yes) - med(tf.no)) < 100 && med(tf.yes) < 200, `forgot password answers as fast either way: ${med(tf.yes).toFixed(0)} vs ${med(tf.no).toFixed(0)} ms`);
      sink.st.delay = 0; sink.st.failing = true;
      const fy = await client(base)("POST", "/auth/forgot", { email: "real@x.test" }), fn = await client(base)("POST", "/auth/forgot", { email: "ghost@x.test" }); sink.st.failing = false;
      ok(fy.s === 200 && fn.s === 200, `and the same answer when the mail service is down: ${fy.s} vs ${fn.s}`);
      const ty = [], tn = []; for (let i = 0; i < 5; i++) { ty.push(await time(() => client(base)("POST", "/auth/login", { email: "real@x.test", password: "nope" + i }))); tn.push(await time(() => client(base)("POST", "/auth/login", { email: `ghost${i}@x.test`, password: "nope" }))); }
      ok(Math.abs(med(ty) - med(tn)) < 60, `sign-in takes as long with no account: ${med(ty).toFixed(0)} vs ${med(tn).toFixed(0)} ms`);
    }

    // ---------- 10. Check-in locks the member (a weekly limit can't be beaten) ----------
    {
      const plan1 = (await H1("POST", "/coach/plans", { name: "Once a week", priceCents: 30000, period: "month", classesPerWeek: 1 })).j.plan.id;
      const L = await mk(g1, "student", "Limited", "lim@x.test"); await H1("PATCH", `/coach/students/${L.id}`, { planId: plan1 });
      const t = Date.now() + 15 * 60e3, mkc = async (title, at) => (await H1("POST", "/classes", { title, startsAt: new Date(at).toISOString() })).j.class.id;
      const a1 = await mkc("A", t), a2 = await mkc("B", t + 60e3);
      const rr = await Promise.all([L("POST", `/classes/${a1}/checkin`), L("POST", `/classes/${a2}/checkin`)]);
      ok(rr.filter((x) => x.s === 200).length === 1, "a 1-class-a-week plan: two check-ins at once, one gets in: " + rr.map((x) => x.s));
    }

    // ---------- 11. Trials end by themselves, and leaving and rejoining doesn't start another ----------
    {
      const g2 = await gym("Gym Two", "STUDENT2", "COACHAA2"), H2 = await head(g2, "Head Two", "h2@x.test");
      const plan2 = (await H2("POST", "/coach/plans", { name: "Unlimited", priceCents: 90000, period: "month" })).j.plan.id;
      const N1 = await mk(g2, "student", "Newbie", "new@x.test"); await pool.query("update users set created_at=now(), gym_joined_at=now() where id=$1", [N1.id]);
      let r = await N1("POST", "/me/plan", { planId: plan2 }); ok(r.s === 200 && (await N1("GET", "/me/pay")).j.pay.planStatus === "trial", "a new member picks a plan: a free trial");
      await pool.query("update users set created_at=now()-interval '95 days', gym_joined_at=now()-interval '95 days', trial_ends=current_date-80, plan_started=current_date-95 where id=$1", [N1.id]);
      await pool.query("update plan_breaks set from_month=date_trunc('month', now()-interval '95 days')::date where user_id=$1", [N1.id]);
      await require("../backend/db").tick(pool);
      r = await N1("GET", "/me/pay"); ok(r.j.pay.planStatus === "active" && r.j.pay.owedCents > 0, `80 days after the trial ended: ${r.j.pay.planStatus}, owes ${r.j.pay.owedCents} (the hourly job ended it)`);
      const N2 = await mk(g2, "student", "Rejoiner", "rejoin@x.test"); await pool.query("update users set created_at=now(), gym_joined_at=now() where id=$1", [N2.id]);
      await N2("POST", "/me/plan", { planId: plan2 }); await N2("POST", "/me/leave", {}); await N2("POST", "/me/join", { code: "STUDENT2" });
      r = await N2("POST", "/me/plan", { planId: plan2 }); const p2 = (await N2("GET", "/me/pay")).j.pay;
      ok(r.s === 200 && p2.planStatus === "active", "leaving and joining again doesn't give another free trial: " + p2.planStatus);
    }

    // ---------- 12. Other coaches can't change the head coach's (or another coach's) record, or merge members ----------
    {
      const C1 = await mk(g1, "coach", "Coach Two", "c1@x.test"), C2 = await mk(g1, "coach", "Coach Three", "c3@x.test");
      let r = await C1("PATCH", `/coach/students/${H1.id}`, { belt: "white", notes: "pwned" }); ok(r.s === 403, "a coach can't edit the head coach's record (" + r.s + ")");
      r = await C1("PATCH", `/coach/students/${C2.id}`, { active: false }); ok(r.s === 403 && (await pool.query("select active from users where id=$1", [C2.id])).rows[0].active, "nor mark another coach inactive");
      r = await C1("PATCH", `/coach/students/${C1.id}`, { belt: "blue" }); ok(r.s === 200, "their own record is theirs to change");
      const off = (await H1("POST", "/coach/students", { name: "Offline Merge", phone: "0811231234" })).j.id, acc = await mk(g1, "student", "Offline Merge", "om@x.test");
      r = await C1("POST", `/coach/students/${off}/merge`, { into: acc.id }); ok(r.s === 403, "only the head coach merges (" + r.s + ")");
      r = await H1("POST", `/coach/students/${off}/merge`, { into: acc.id }); ok(r.s === 200, "the head coach can");
    }

    // ---------- Every state-changing route still needs the app's header (one-tap unsubscribe is the only new exception) ----------
    {
      const src = require("fs").readFileSync(path.resolve(__dirname, "../backend/api.js"), "utf8");
      const routes = [...src.matchAll(/api\.(post|put|patch|delete)\("([^"]+)"/g)].map((m) => [m[1].toUpperCase(), m[2].replace(/:token/g, "A".repeat(24)).replace(/:\w+/g, "1")]);
      const bad = []; for (const [m, u] of routes) { const x = await H1(m, u, "a=1", { "x-jf": undefined, "content-type": "application/x-www-form-urlencoded" }); if (x.s !== 403 && u !== "/payfast/notify" && !u.startsWith("/gym-mail/stop/")) bad.push(`${m} ${u} -> ${x.s}`); }
      ok(!bad.length && routes.length > 100, `all ${routes.length} state-changing routes refuse a request without x-jf ` + bad.join("; "));
    }
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e)); }
  srv.kill(); sink.close(); await pool.end().catch(() => {});
  console.log(`security: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
