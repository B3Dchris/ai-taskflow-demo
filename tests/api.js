// API tests against a real PostgreSQL. Usage: DATABASE_URL=postgres://... node tests/api.js
// The database is wiped first, so point this at a throwaway test database only.
const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };

function client(base) {
  let cookie = "";
  return async (method, url, body, headers = {}) => {
    const h = { ...headers }; if (cookie) h.cookie = cookie;
    if (method !== "GET") { h["content-type"] = "application/json"; if (!("x-jf" in headers)) h["x-jf"] = "1"; }
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = m[1] ? "jf_s=" + m[1] : ""; }
    let j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j, h: r.headers };
  };
}

(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  await pool.end();
  const port = 9900 + Math.floor(Math.random() * 90), base = `http://127.0.0.1:${port}/api`;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env: { ...process.env, PORT: String(port), DATABASE_URL: DB }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch (e) { await new Promise((r) => setTimeout(r, 150)); } }
  try {
    const coach = client(base), stu = client(base), stu2 = client(base), other = client(base), anon = client(base);
    // --- accounts
    let r = await anon("GET", "/me"); ok(r.s === 200 && r.j.me === null, "anonymous /me is null");
    r = await anon("GET", "/progress"); ok(r.s === 401, "progress needs sign-in");
    r = await coach("POST", "/auth/start-gym", { gym: "JPB Martial Arts Academy", name: "Coach JP", email: "Coach@Example.com", password: "s3cret-pass" });
    ok(r.s === 201 && r.j.me.role === "coach" && r.j.me.gym.studentCode && r.j.me.gym.coachCode && r.j.me.email === "coach@example.com", "coach starts a gym and gets invite codes");
    const sc = r.j.me.gym.studentCode, cc = r.j.me.gym.coachCode;
    ok(r.h.get("set-cookie") && /HttpOnly/i.test(r.h.get("set-cookie")) && /SameSite=Lax/i.test(r.h.get("set-cookie")), "session cookie is HttpOnly and SameSite=Lax");
    r = await stu("POST", "/auth/register", { code: "WRONG123", name: "Chris", email: "chris@example.com", password: "password1" }); ok(r.s === 404, "wrong gym code is refused");
    r = await stu("POST", "/auth/register", { code: sc.toLowerCase(), name: "Chris", email: "chris@example.com", password: "short" }); ok(r.s === 400 && /8 characters/.test(r.j.error), "short password is refused");
    r = await stu("POST", "/auth/register", { code: sc.toLowerCase(), name: "Chris", email: "chris@example.com", password: "password1" }); ok(r.s === 201 && r.j.me.role === "student" && r.j.me.gym.name === "JPB Martial Arts Academy" && !r.j.me.gym.studentCode, "student joins with the gym code (and can't see codes)");
    r = await stu2("POST", "/auth/register", { code: sc, name: "Chris again", email: "CHRIS@example.com", password: "password1" }); ok(r.s === 409, "duplicate email is refused");
    r = await stu2("POST", "/auth/register", { code: sc, name: "Sam", email: "sam@example.com", password: "password2" }); ok(r.s === 201, "second student joins");
    r = await other("POST", "/auth/start-gym", { gym: "Other Gym", name: "Other Coach", email: "other@example.com", password: "password3" }); ok(r.s === 201, "a second gym starts");
    r = await coach("POST", "/auth/logout", {}); ok(r.s === 200, "logout");
    r = await coach("GET", "/me"); ok(r.j.me === null, "logged out session is gone");
    r = await coach("POST", "/auth/login", { email: "coach@example.com", password: "wrong" }); ok(r.s === 401, "wrong password refused");
    r = await coach("POST", "/auth/login", { email: "COACH@example.com", password: "s3cret-pass" }); ok(r.s === 200 && r.j.me.role === "coach", "login works (email case-insensitive)");
    r = await stu("POST", "/auth/logout", {}, { "x-jf": "" }); ok(r.s === 403, "requests without the app header are blocked");
    // --- progress + logs
    r = await stu("PUT", "/progress", { data: { mastery: { knee_cut: 3, upa: 2, armbar_cg: 1 }, settings: { goal: "blue", perWeek: 2 } } }); ok(r.s === 200, "student saves progress");
    r = await stu("GET", "/progress"); ok(r.j.data.mastery.knee_cut === 3, "progress reads back");
    r = await stu("PUT", "/progress", { data: [1, 2] }); ok(r.s === 400, "progress must be an object");
    r = await stu("PUT", "/progress", { data: { big: "x".repeat(320000) } }); ok(r.s === 413, "oversized progress refused");
    const today = new Date().toISOString().slice(0, 10);
    r = await stu("PUT", "/logs/s1", { data: { date: today, mins: 90, stuck: ["hg_bot", "sc_bot"], tapped: ["rnc"] } }); ok(r.s === 200, "student saves a session");
    await stu("PUT", "/logs/s2", { data: { date: today, mins: 60, stuck: ["hg_bot"], tapped: [] } });
    r = await stu("GET", "/logs"); ok(r.j.logs.length === 2 && r.j.logs.some((l) => l.id === "s1"), "sessions read back");
    r = await stu("PUT", "/logs/bad id!", { data: {} }); ok(r.s === 400, "bad session id refused");
    r = await stu("DELETE", "/logs/s2"); r = await stu("GET", "/logs"); ok(r.j.logs.length === 1, "session deleted");
    // --- classes + attendance
    const when = new Date(Date.now() + 2 * 864e5).toISOString();
    r = await stu("POST", "/classes", { title: "No-gi", startsAt: when }); ok(r.s === 403, "students can't create classes");
    r = await coach("POST", "/classes", { title: "No-gi fundamentals", startsAt: when, durationMin: 90, plan: { focus: "Half guard bottom", ids: ["hg_frames", "hg_dogfight"], notes: "Underhook!" } });
    ok(r.s === 201 && r.j.class.plan.ids.length === 2, "coach plans a class");
    const cid = r.j.class.id;
    r = await coach("POST", "/classes", { title: "Private plan", startsAt: when, shared: false, plan: { notes: "secret" } }); const hid = r.j.class.id;
    r = await stu("GET", "/classes"); const seen = Object.fromEntries(r.j.classes.map((c) => [c.id, c]));
    ok(seen[cid] && seen[cid].plan.focus === "Half guard bottom" && seen[hid] && seen[hid].plan === null, "students see shared plans only");
    r = await stu("PUT", `/classes/${cid}/rsvp`, { going: true }); ok(r.s === 200 && r.j.going, "student says they're going");
    await stu2("PUT", `/classes/${cid}/rsvp`, { going: true }); await stu2("PUT", `/classes/${cid}/rsvp`, { going: false });
    r = await stu("GET", "/classes"); ok(r.j.classes.find((c) => c.id === cid).myGoing === true && r.j.classes.find((c) => c.id === cid).going === 1, "going count and my status");
    r = await coach("GET", `/coach/classes/${cid}`);
    const att = r.j && r.j.attendees && r.j.attendees[0];
    ok(r.s === 200 && r.j.attendees.length === 1 && att.name === "Chris" && att.mastery.knee_cut === 3 && att.stuck.hg_bot === 1 && att.stuck.sc_bot === 1 && att.tapped.rnc === 1 && /^\d{4}-\d{2}-\d{2}$/.test(att.last), "coach sees who's going with skills and weak spots");
    r = await coach("PUT", `/coach/classes/${cid}/attendance`, { userId: att.id, attended: true }); ok(r.s === 200, "coach marks attendance");
    r = await other("GET", `/coach/classes/${cid}`); ok(r.s === 404, "another gym's coach can't see the class");
    r = await other("PUT", `/classes/${cid}/rsvp`, { going: true }); ok(r.s === 404, "another gym can't RSVP");
    r = await coach("PUT", `/classes/${cid}`, { title: "No-gi: half guard", startsAt: when, plan: { focus: "Half guard", ids: ["hg_frames"] } }); ok(r.s === 200 && r.j.class.title === "No-gi: half guard", "coach edits the class");
    r = await coach("POST", "/classes", { title: "x", startsAt: "not a date" }); ok(r.s === 400, "bad class date refused");
    // --- roster, students, payments
    r = await stu("GET", "/coach/roster"); ok(r.s === 403, "students can't see the roster");
    r = await coach("GET", "/coach/roster"); const chris = r.j.people.find((p) => p.name === "Chris");
    ok(r.s === 200 && r.j.people.length === 3 && chris.mastery.knee_cut === 3 && chris.n30 === 1 && chris.attended30 === 1 && chris.goal === "blue", "roster shows students with progress, sessions and attendance");
    r = await other("GET", `/coach/students/${chris.id}`); ok(r.s === 404, "another gym's coach can't see the student");
    r = await coach("PATCH", `/coach/students/${chris.id}`, { belt: "blue", stripes: 1, notes: "Great underhook", feeCents: 85000 }); ok(r.s === 200, "coach updates belt, stripes, notes, fee");
    r = await coach("PATCH", `/coach/students/${chris.id}`, { belt: "green" }); ok(r.s === 400, "unknown belt refused");
    r = await coach("PATCH", "/coach/gym", { monthlyFeeCents: 90000 }); ok(r.s === 200 && r.j.me.gym.monthlyFeeCents === 90000, "coach sets the gym fee");
    r = await coach("POST", "/coach/payments", { userId: chris.id, amountCents: 85000, paidOn: today, reference: "CHRIS NOV" }); ok(r.s === 201, "coach records a payment");
    r = await coach("POST", "/coach/payments", { amountCents: 50000, paidOn: today, reference: "UNKNOWN EFT" }); ok(r.s === 201 && r.j.payment.userId === null, "unmatched payment recorded");
    const unmatched = r.j.payment.id;
    r = await coach("POST", "/coach/payments", { userId: chris.id, amountCents: -5, paidOn: today }); ok(r.s === 400, "bad amount refused");
    r = await other("PATCH", `/coach/payments/${unmatched}`, { userId: chris.id }); ok(r.s === 404, "other gym can't touch payments");
    r = await coach("GET", "/coach/roster"); const chris2 = r.j.people.find((p) => p.name === "Chris"), sam = r.j.people.find((p) => p.name === "Sam");
    ok(chris2.paidThisMonthCents === 85000 && chris2.feeCents === 85000 && chris2.belt === "blue" && chris2.stripes === 1 && sam.feeCents === 90000 && sam.paidThisMonthCents === 0, "roster shows who has paid this month");
    r = await coach("PATCH", `/coach/payments/${unmatched}`, { userId: sam.id }); ok(r.s === 200, "coach assigns an unmatched payment");
    r = await coach("GET", `/coach/students/${sam.id}`); ok(r.j.payments.length === 1 && r.j.payments[0].amountCents === 50000, "student detail shows their payments");
    r = await coach("DELETE", `/coach/payments/${unmatched}`); r = await coach("GET", "/coach/payments"); ok(r.j.payments.length === 1, "payment deleted");
    r = await coach("POST", "/coach/codes/rotate", { which: "student" }); ok(r.j.me.gym.studentCode !== sc, "coach rotates the student code");
    r = await stu2("POST", "/auth/register", { code: sc, name: "Late", email: "late@example.com", password: "password9" }); ok(r.s === 404, "old code stops working");
    r = await client(base)("POST", "/auth/register", { code: cc, name: "Assistant", email: "asst@example.com", password: "password4" }); ok(r.s === 201 && r.j.me.role === "coach", "coach code makes a coach");
    // --- account changes + deletion
    r = await stu("PATCH", "/me", { name: "Chris B" }); ok(r.j.me.name === "Chris B", "rename");
    r = await stu("DELETE", "/me", { password: "nope" }); ok(r.s === 401, "deleting needs the password");
    r = await stu("DELETE", "/me", { password: "password1" }); ok(r.s === 200, "student deletes their account");
    const pool2 = new Pool({ connectionString: DB });
    const left = await pool2.query("select (select count(*) from progress where user_id=$1) p, (select count(*) from training_logs where user_id=$1) l", [chris.id]);
    ok(Number(left.rows[0].p) === 0 && Number(left.rows[0].l) === 0, "their progress and sessions are deleted too");
    await pool2.end();
    // --- rate limit
    let last; for (let i = 0; i < 11; i++) last = await anon("POST", "/auth/login", { email: "sam@example.com", password: "bad" });
    ok(last.s === 429, "repeated wrong passwords are slowed down");
    r = await anon("GET", "/nope"); ok(r.s === 404, "unknown API path is 404");
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e)); }
  srv.kill();
  console.log(`api: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
