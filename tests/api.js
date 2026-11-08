// API tests against a real PostgreSQL. Usage: DATABASE_URL=postgres://... node tests/api.js
// The database is wiped first, so point this at a throwaway test database only.
const { spawn } = require("child_process"); const { startGymSite, startMailSink } = require("./fixture-gym"); const path = require("path"); const { Pool } = require("pg");
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
  await pool.query("drop table if exists pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  await pool.end();
  const port = 9900 + Math.floor(Math.random() * 90), base = `http://127.0.0.1:${port}/api`;
  const site = await startGymSite(), sink = await startMailSink();
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB, JF_IMPORT_ALLOW_LOOPBACK: "1", RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, APP_URL: "https://www.jitsflow.test", INBOUND_SECRET: "test-inbound-secret" }; delete env.ANTHROPIC_API_KEY;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
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
    r = await coach("POST", "/classes", { title: "Fundamentals", discipline: "Muay Thai", startsAt: when }); ok(r.s === 201 && r.j.class.discipline === "Muay Thai", "a class has a type (not just jiu-jitsu)");
    { const id = r.j.class.id; r = await coach("PUT", "/classes/" + id, { title: "Fundamentals", discipline: "Boxing", startsAt: when }); ok(r.s === 200 && r.j.class.discipline === "Boxing", "the type can be changed"); await coach("DELETE", "/classes/" + id); }
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
    { const tmp = client(base); await tmp("POST", "/auth/start-gym", { gym: "Solo gym", name: "Solo", email: "solo@example.com", password: "solopass1" });
      const pl = new Pool({ connectionString: DB }); const before = Number((await pl.query("select count(*) from gyms where name='Solo gym'")).rows[0].count);
      await tmp("DELETE", "/me", { password: "solopass1" }); const after = Number((await pl.query("select count(*) from gyms where name='Solo gym'")).rows[0].count); await pl.end();
      ok(before === 1 && after === 0, "when a gym's last member deletes their account, the gym goes too"); }
    { const tmp = client(base); await tmp("POST", "/auth/start-gym", { gym: "Offline gym", name: "Solo", email: "solo2@example.com", password: "solopass1" });
      const ad = await tmp("POST", "/coach/students", { name: "Off Line", phone: "0825550199" });
      const pl = new Pool({ connectionString: DB });
      await tmp("DELETE", "/me", { password: "solopass1" });
      const g = Number((await pl.query("select count(*) from gyms where name='Offline gym'")).rows[0].count), us = Number((await pl.query("select count(*) from users where name='Off Line'")).rows[0].count); await pl.end();
      ok(ad.s === 201 && g === 0 && us === 0, "students who never signed in don't keep a gym alive after its last coach leaves"); }
    const pool2 = new Pool({ connectionString: DB });
    const left = await pool2.query("select (select count(*) from progress where user_id=$1) p, (select count(*) from training_logs where user_id=$1) l", [chris.id]);
    ok(Number(left.rows[0].p) === 0 && Number(left.rows[0].l) === 0, "their progress and sessions are deleted too");
    await pool2.end();
    // --- gym website import
    r = await stu2("POST", "/coach/import", { url: site.url }); ok(r.s === 403, "students can't import");
    r = await coach("POST", "/coach/import", { url: "http://10.0.0.5/" }); ok(r.s === 400 && /public website/.test(r.j.error), "private addresses are refused by the API");
    r = await coach("POST", "/coach/import", { url: site.url });
    ok(r.s === 200 && r.j.method === "basic" && r.j.profile.timetable.length === 9 && r.j.logos.length > 0 && r.j.pages.length === 9, "coach imports their whole website");
    const imp = r.j;
    r = await coach("GET", "/gym"); ok(r.s === 200 && !(r.j.gym.profile.timetable || []).length, "nothing is saved until the coach confirms");
    imp.profile.timetable = imp.profile.timetable.filter((x) => x.day !== "Sat");
    r = await coach("PUT", "/coach/gym/profile", { profile: imp.profile, logoUrl: imp.logos[0].url });
    ok(r.s === 200 && r.j.me.gym.logo && r.j.me.gym.name === "Fourways Grappling Club", "coach saves the import with a logo");
    const logoUrl = r.j.me.gym.logo;
    const lr = await fetch(`http://127.0.0.1:${port}` + logoUrl);
    ok(lr.status === 200 && lr.headers.get("content-type") === "image/png" && /immutable/.test(lr.headers.get("cache-control") || ""), "logo is served from JitsFlow");
    r = await stu2("GET", "/gym");
    ok(r.s === 200 && r.j.gym.profile.timetable.length === 8 && r.j.gym.profile.rates.length >= 3 && r.j.gym.logo === logoUrl, "students see the saved timetable, rates and logo");
    r = await stu2("GET", "/me"); ok(r.j.me.gym.logo === logoUrl, "students' account shows the gym logo");
    r = await coach("GET", "/coach/roster"); ok(r.j.gymFeeCents === 90000, "an existing standard fee is not overwritten by the import");
    r = await other("GET", "/gym"); ok(r.s === 200 && !(r.j.gym.profile.timetable || []).length, "other gyms don't get this profile");
    r = await coach("PUT", "/coach/gym/profile", { profile: { ...imp.profile, website: "javascript:alert(1)" }, logoUrl: site.url + "/evil.svg" });
    ok(r.s === 200 && /Couldn't download/.test(r.j.logoNote) && r.j.me.gym.logo === logoUrl, "an SVG logo is refused and the old one kept");
    r = await coach("GET", "/gym"); ok(r.j.gym.profile.website === "", "unsafe website links are dropped");
    const t1 = new Date(Date.now() + 3 * 864e5).toISOString(), t2 = new Date(Date.now() + 4 * 864e5).toISOString();
    r = await coach("POST", "/coach/classes/bulk", { classes: [{ title: "No-Gi All Levels", startsAt: t1, durationMin: 90 }, { title: "Kids BJJ", startsAt: t2, durationMin: 45 }] });
    ok(r.s === 201 && r.j.added === 2 && r.j.skipped === 0, "timetable classes are added in one go");
    r = await coach("POST", "/coach/classes/bulk", { classes: [{ title: "no-gi all levels", startsAt: t1, durationMin: 90 }] });
    ok(r.s === 201 && r.j.added === 0 && r.j.skipped === 1, "classes already there are skipped");
    r = await stu2("POST", "/coach/classes/bulk", { classes: [] }); ok(r.s === 403, "students can't add classes");
    r = await coach("PUT", "/coach/gym/profile", { profile: imp.profile, logoUrl: null });
    ok(r.s === 200 && r.j.me.gym.logo === null, "coach can remove the logo");
    // --- email: welcome, password reset, invites
    const wait = () => new Promise((r) => setTimeout(r, 300));
    r = await anon("GET", "/status"); ok(r.s === 200 && r.j.mail === true && r.j.ai === false, "status says email is on");
    await wait();
    const wc = sink.mails.find((m) => m.to[0] === "coach@example.com");
    ok(wc && /is set up on JitsFlow/.test(wc.subject) && wc.html.includes("https://www.jitsflow.test/app/?join=" + sc) && wc.from === "JitsFlow <no-reply@jitsflow.com>" && wc.reply_to === "hello@jitsflow.com" && wc.text, "coach gets a welcome email with the invite link");
    ok(sink.mails.some((m) => m.to[0] === "sam@example.com" && /Welcome/.test(m.subject)), "students get a welcome email");
    let n = sink.mails.length;
    r = await anon("POST", "/auth/forgot", { email: "nobody@example.com" }); ok(r.s === 200 && sink.mails.length === n, "forgot-password for an unknown email looks the same and sends nothing");
    r = await anon("POST", "/auth/forgot", { email: "not-an-email" }); ok(r.s === 400, "forgot-password needs an email");
    r = await anon("POST", "/auth/forgot", { email: "COACH@example.com" }, { host: "evil.example" });
    const rm = sink.mails[sink.mails.length - 1];
    ok(r.s === 200 && rm.to[0] === "coach@example.com" && /Reset your JitsFlow password/.test(rm.subject), "reset email is sent");
    const link = (rm.text.match(/https:\/\/\S+\?reset=([0-9a-f]{64})/) || []);
    ok(link[0] && link[0].startsWith("https://www.jitsflow.test/app/?reset="), "reset link uses the site address, not the request's Host header");
    const resetter = client(base);
    r = await resetter("POST", "/auth/reset", { token: link[1], password: "short" }); ok(r.s === 400 && /8 characters/.test(r.j.error), "new password must be long enough");
    r = await resetter("POST", "/auth/reset", { token: "0".repeat(64), password: "brand-new-pass" }); ok(r.s === 400 && /expired/.test(r.j.error), "a made-up token is refused");
    r = await resetter("POST", "/auth/reset", { token: link[1], password: "brand-new-pass" }); ok(r.s === 200 && r.j.me.email === "coach@example.com", "reset sets the new password and signs in");
    r = await resetter("POST", "/auth/reset", { token: link[1], password: "another-pass1" }); ok(r.s === 400, "a reset link works only once");
    r = await coach("GET", "/me"); ok(r.j.me === null, "other sessions are signed out after a reset");
    r = await coach("POST", "/auth/login", { email: "coach@example.com", password: "s3cret-pass" }); ok(r.s === 401, "old password no longer works");
    r = await coach("POST", "/auth/login", { email: "coach@example.com", password: "brand-new-pass" }); ok(r.s === 200, "new password works");
    r = await stu2("POST", "/coach/invite", { emails: "x@example.com" }); ok(r.s === 403, "students can't send invites");
    r = await coach("POST", "/coach/invite", { emails: "lee@example.com, nope" }); ok(r.s === 400 && /nope/.test(r.j.error), "bad addresses are named");
    n = sink.mails.length;
    r = await coach("POST", "/coach/invite", { emails: "lee@example.com\nSam@example.com; lee@example.com" });
    const inv = sink.mails[sink.mails.length - 1];
    ok(r.s === 200 && r.j.sent === 1 && r.j.already.includes("sam@example.com") && sink.mails.length === n + 1, "invites go to new people only, once each");
    ok(inv.to[0] === "lee@example.com" && inv.html.includes("https://www.jitsflow.test/app/?join=" + (await coach("GET", "/me")).j.me.gym.studentCode) && /invited you to/.test(inv.subject), "invite email carries the join link");
    // --- WhatsApp numbers and student invites
    r = await stu2("PATCH", "/me", { phone: "082 123 4567<script>" }); ok(r.s === 200 && r.j.me.phone === "082 123 4567", "a student saves a WhatsApp number (junk stripped)");
    r = await stu2("PATCH", "/me", { phone: "12" }); ok(r.j.me.phone === "", "too-short numbers aren't kept");
    await stu2("PATCH", "/me", { phone: "+27 82 123 4567" });
    r = await coach("GET", "/coach/roster"); const samRow = r.j.people.find((p) => p.name === "Sam"); ok(samRow.phone === "+27 82 123 4567", "coaches see the number on the roster");
    r = await coach("PATCH", `/coach/students/${sam.id}`, { phone: "083 555 0000" }); r = await coach("GET", `/coach/students/${sam.id}`); ok(r.j.student.phone === "083 555 0000", "coaches can set a student's number");
    r = await stu2("GET", "/me"); const coachGym = (await coach("GET", "/me")).j.me.gym;
    ok(r.j.me.gym.inviteCode === coachGym.studentCode && !r.j.me.gym.coachCode && !r.j.me.gym.studentCode, "students get the student invite code to share (never the coach code)");
    await coach("PATCH", "/coach/gym", { studentsInvite: false }); r = await stu2("GET", "/me"); ok(!r.j.me.gym.inviteCode, "a coach can stop students sharing invites");
    await coach("PATCH", "/coach/gym", { studentsInvite: true });
    // --- paying by EFT: bank details, personal references, proof of payment, review
    r = await coach("GET", "/coach/gym/pay"); const popAddr = r.j.popAddress;
    ok(r.s === 200 && /^pop-[a-z0-9]{10}@jitsflow\.com$/.test(popAddr) && r.j.popReady === true, "each gym gets a private proof-of-payment address");
    r = await stu2("GET", "/coach/gym/pay"); ok(r.s === 403, "students can't see the gym's forwarding address");
    r = await coach("PATCH", "/coach/gym/pay", { holder: "Test Gym", bank: "FNB", account: "62-123 456 789", branch: "250655", type: "Cheque", link: "http://pay.example" }); ok(r.s === 400, "a payment link must be https");
    r = await coach("PATCH", "/coach/gym/pay", { holder: "Test Gym", bank: "FNB", account: "62-123 456 789", branch: "250655", type: "Cheque", note: "Due by the 3rd" }); ok(r.s === 200 && r.j.pay.account === "62123 456 789", "coach saves bank details (account number keeps digits only)");
    r = await stu2("GET", "/me/pay"); const myRef = r.j.pay.reference;
    ok(/^JF[A-HJ-NP-Z2-9]{5}$/.test(myRef) && r.j.pay.bank.bank === "FNB" && r.j.pay.dueCents === 90000 && r.j.pay.paidCents === 0, "student sees what's due, the bank details and their own reference");
    ok((await stu2("GET", "/me/pay")).j.pay.reference === myRef, "the reference stays the same");
    r = await coach("GET", "/me/pay"); ok(r.j.pay === null, "coaches don't get a fees card");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64").toString("base64");
    r = await stu2("POST", "/me/pay/proof", { name: "notes.txt", data: Buffer.from("just some text, not a proof").toString("base64") }); ok(r.s === 400 && /PDF or an image/.test(r.j.error), "a file that isn't a PDF or image is refused");
    r = await stu2("POST", "/me/pay/proof", { name: "IMG.HEIC", data: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(20)]).toString("base64") }); ok(r.s === 400 && /HEIC/.test(r.j.error), "an iPhone HEIC photo gets a clear message");
    r = await stu2("POST", "/me/pay/proof", { name: "pop.png", data: png, amountCents: 90000 }); const stuPop = r.j.payment;
    ok(r.s === 201 && stuPop.status === "pending" && stuPop.hasProof && stuPop.amountCents === 90000, "student sends a proof: it waits for the coach");
    await new Promise((res) => setTimeout(res, 300));
    r = await stu2("GET", "/me/pay"); ok(r.j.pay.pendingCents === 90000 && r.j.pay.paidCents === 0 && r.j.pay.payments.some((p) => p.id === stuPop.id && p.status === "pending") && !r.j.pay.payments[0].read, "it shows as being checked, and doesn't count as paid yet");
    r = await coach("GET", "/coach/payments"); const seenPop = r.j.payments.find((p) => p.id === stuPop.id);
    ok(seenPop && seenPop.status === "pending" && seenPop.source === "student" && seenPop.userId === sam.id && r.j.payments[0].id === stuPop.id, "coach sees it first, from that student");
    r = await coach("GET", "/coach/roster"); ok(r.j.people.find((p) => p.id === sam.id).pendingThisMonthCents === 90000 && r.j.people.find((p) => p.id === sam.id).paidThisMonthCents === 0, "roster keeps pending apart from paid");
    const tess = client(base); r = await tess("POST", "/auth/register", { code: (await coach("GET", "/me")).j.me.gym.studentCode, name: "Tess", email: "tess@example.com", password: "password7" }); const tessId = r.j.me.id;
    let pf = await fetch(`${base}/payments/${stuPop.id}/proof`, { headers: { cookie: "" } }); ok(pf.status === 401, "proof files need sign-in");
    r = await tess("GET", `/payments/${stuPop.id}/proof`); ok(r.s === 404, "another student can't open someone's proof");
    r = await other("GET", `/payments/${stuPop.id}/proof`); ok(r.s === 404, "another gym's coach can't open it");
    r = await coach("GET", `/payments/${stuPop.id}/proof`); ok(r.s === 200 && r.h.get("content-type") === "image/png" && /sandbox/.test(r.h.get("content-security-policy")), "the gym's coach opens the proof (sandboxed)");
    r = await stu2("GET", `/payments/${stuPop.id}/proof`); ok(r.s === 200, "the student can open their own proof");
    r = await coach("POST", "/coach/payments/proof", { name: "whatsapp.png", data: png }); const upl = r.j.payment;
    ok(r.s === 201 && upl.status === "pending" && upl.source === "upload" && upl.userId === null, "coach uploads a proof: unread without Claude, so no student or amount yet");
    r = await coach("PATCH", `/coach/payments/${upl.id}`, { status: "confirmed" }); ok(r.s === 400, "can't confirm without an amount and a student");
    r = await coach("PATCH", `/coach/payments/${upl.id}`, { userId: tessId, amountCents: 90000, method: "eft", status: "confirmed" }); ok(r.s === 200 && r.j.payment.status === "confirmed" && r.j.payment.method === "eft", "coach fills it in and confirms");
    r = await coach("GET", "/coach/roster"); ok(r.j.people.find((p) => p.id === tessId).paidThisMonthCents === 90000, "confirmed proof counts as paid");
    r = await coach("PATCH", `/coach/payments/${stuPop.id}`, { status: "rejected" }); ok(r.s === 200, "coach marks one as not a payment");
    r = await stu2("GET", "/me/pay"); ok(r.j.pay.pendingCents === 0 && r.j.pay.payments.find((p) => p.id === stuPop.id).status === "rejected", "the student sees it wasn't accepted");
    r = await coach("POST", "/coach/payments", { userId: sam.id, amountCents: 10000, paidOn: today, method: "cash" }); ok(r.s === 201 && r.j.payment.method === "cash" && r.j.payment.status === "confirmed", "recording by hand keeps the method and counts straight away");
    // --- forwarded emails (Cloudflare email worker -> /inbound/pop)
    const mime = (to, from, subject, body, pdf) => {
      const b = "XYZBOUNDARY";
      return `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n` +
        (pdf ? `--${b}\r\nContent-Type: application/pdf; name="pop.pdf"\r\nContent-Disposition: attachment; filename="pop.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${pdf.toString("base64").replace(/.{76}/g, "$&\r\n")}\r\n` : "") + `--${b}--\r\n`;
    };
    const inbound = (raw, to, secret = "test-inbound-secret") => fetch(`${base}/inbound/pop`, { method: "POST", headers: { "content-type": "message/rfc822", "x-jf": "1", "x-jf-inbound": secret, "x-jf-to": to }, body: raw });
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(4000, 32), Buffer.from("\n%%EOF")]);
    const notif = mime(popAddr, "FNB <inContact@fnb.co.za>", "FNB: proof of payment", `FNB: You have received a payment of R900.00 on ${today}.\nReference: ${myRef}\nFrom: C SMITH`, pdf);
    pf = await inbound(notif, popAddr, "wrong-secret"); ok(pf.status === 403, "the inbound address needs the worker's secret");
    pf = await inbound(notif, "pop-zzzzzzzzzz@jitsflow.com"); ok(pf.status === 404, "unknown forwarding address is refused");
    pf = await inbound(notif, popAddr); ok(pf.status === 201, "a forwarded bank email is accepted");
    r = await coach("GET", "/coach/payments"); const em = r.j.payments.find((p) => p.source === "email");
    ok(em && em.status === "pending" && em.amountCents === 90000 && em.userId === sam.id && em.read.match === "reference" && em.hasProof && /proof of payment/.test(em.emailSubject), "the email is read and matched to the student by their reference");
    pf = await inbound(notif, popAddr); r = await coach("GET", "/coach/payments");
    ok(r.j.payments.filter((p) => p.source === "email").some((p) => p.read && p.read.duplicateOf === em.id), "the same email twice is flagged as a duplicate");
    pf = await inbound(mime(popAddr, "Newsletter <news@example.com>", "Our sale", "Big discounts this weekend"), popAddr); ok(pf.status === 200 && (await pf.json()).skipped, "an email that isn't a payment is ignored");
    pf = await inbound(mime(popAddr, "Gmail Team <forwarding-noreply@google.com>", "(#123456789) Gmail Forwarding Confirmation - Receive Mail from owner@gmail.com", "Confirmation code: 123456789\n\nhttps://mail-settings.google.com/mail/vf-abc123"), popAddr);
    r = await coach("GET", "/coach/gym/pay"); ok(r.j.popNotice && r.j.popNotice.code === "123456789" && r.j.popNotice.from === "owner@gmail.com", "Gmail's forwarding confirmation code shows up for the coach");
    r = await coach("POST", "/coach/gym/pay/new-address"); ok(r.s === 200 && r.j.popAddress !== popAddr, "coach can get a new address");
    pf = await inbound(notif, popAddr); ok(pf.status === 404, "the old address stops working");
    // --- students who aren't on the app
    r = await coach("POST", "/coach/students", { name: "Nomsa Dube" }); ok(r.s === 400 && /WhatsApp number or an email/.test(r.j.error), "an added student needs a WhatsApp number or email");
    r = await coach("POST", "/coach/students", { name: "Tess Copy", email: "tess@example.com" }); ok(r.s === 409, "can't add someone whose email is already on JitsFlow");
    r = await coach("POST", "/coach/students/bulk", { people: [{ name: "Kid One", parentName: "Pat Parent", phone: "082 999 0001" }, { name: "Kid Two", parentName: "Pat Parent", phone: "082 999 0001" }, { name: "Name Only" }, { name: "Kid One", parentName: "Pat Parent" }] });
    ok(r.s === 201 && r.j.added === 3 && r.j.skipped === 1, "bulk: siblings on one parent's number both go in, a name alone is fine, a repeat is skipped: " + JSON.stringify(r.j));
    { const ro = (await coach("GET", "/coach/roster")).j.people; const k1 = ro.find((x) => x.name === "Kid One"), k2 = ro.find((x) => x.name === "Kid Two");
      ok(k1 && k2 && k1.parentName === "Pat Parent" && k2.phone === k1.phone, "kids keep their parent's name and number");
      r = await coach("PATCH", "/coach/students/" + k1.id, { parentName: "Pat P." }); const d = (await coach("GET", "/coach/students/" + k1.id)).j.student;
      ok(r.s === 200 && d.parentName === "Pat P.", "the parent's name can be changed"); }
    r = await coach("POST", "/coach/students", { name: "Solo Kid", parentName: "Sam Parent", phone: "082 999 0002" }); ok(r.s === 201, "a single kid can be added with their parent");
    r = await coach("POST", "/coach/students/read-people", { images: ["aGVsbG8="] }); ok(r.s === 503, "reading screenshots says so when AI is off");
    r = await stu2("POST", "/coach/students", { name: "X", phone: "0821234567" }); ok(r.s === 403, "students can't add students");
    r = await coach("POST", "/coach/students", { name: "Nomsa Dube", phone: "082 444 1111", belt: "blue", stripes: 2 }); const nomsa = r.j.id; ok(r.s === 201 && nomsa, "coach adds a student by WhatsApp number only");
    r = await coach("POST", "/coach/students", { name: "Pieter Botha", email: "pieter@example.com" }); const pieter = r.j.id; ok(r.s === 201, "coach adds a student by email");
    r = await coach("GET", "/coach/roster"); const nRow = r.j.people.find((p) => p.id === nomsa);
    ok(nRow && nRow.offline === true && nRow.belt === "blue" && nRow.phone === "082 444 1111" && nRow.email === "", "they're on the roster, marked as not on the app");
    r = await coach("POST", "/coach/payments", { userId: nomsa, amountCents: 90000, paidOn: today, method: "cash" }); ok(r.s === 201, "coach records a cash payment for them");
    r = await anon("POST", "/auth/login", { email: "pieter@example.com", password: "" }); ok(r.s === 401, "an added student can't sign in until they set a password");
    r = await coach("POST", `/coach/students/${nomsa}/claim-link`); const claimUrl = r.j.url, claimTok = new URL(claimUrl).searchParams.get("claim");
    ok(r.s === 200 && /\/app\/\?join=[A-Z0-9]{8}&claim=/.test(claimUrl), "coach gets a personal invite link for them");
    const nomsaApp = client(base);
    r = await nomsaApp("POST", "/auth/register", { code: new URL(claimUrl).searchParams.get("join"), claim: claimTok, name: "Nomsa Dube", email: "nomsa@example.com", password: "nomsapass1" });
    ok(r.s === 201 && r.j.me.id === nomsa && r.j.me.belt === "blue", "signing up with the invite link takes over their record");
    r = await nomsaApp("GET", "/me/pay"); ok(r.j.pay.paidCents === 90000, "their cash payment is there");
    r = await coach("GET", "/coach/roster"); ok(r.j.people.find((p) => p.id === nomsa).offline === false, "and they no longer show as not on the app");
    r = await client(base)("POST", "/auth/register", { code: new URL(claimUrl).searchParams.get("join"), claim: claimTok, name: "Someone", email: "someone@example.com", password: "somepass11" });
    ok(r.s === 201 && r.j.me.id !== nomsa, "a used invite link doesn't take over the record again");
    const pieterApp = client(base); r = await pieterApp("POST", "/auth/register", { code: (await coach("GET", "/me")).j.me.gym.studentCode, name: "Pieter B", email: "PIETER@example.com", password: "pieterpass1" });
    ok(r.s === 201 && r.j.me.id === pieter, "signing up with the email the coach added also takes over the record");
    r = await coach("POST", "/coach/students", { name: "Gone Soon", phone: "0831112222" }); const gone = r.j.id;
    r = await coach("DELETE", `/coach/students/${gone}`); ok(r.s === 200, "coach can remove a student who isn't on the app");
    r = await coach("DELETE", `/coach/students/${nomsa}`); ok(r.s === 400, "but not one with their own account");
    // --- notices: cancelled and moved classes
    const soon = new Date(Date.now() + 3 * 864e5); soon.setUTCHours(16, 0, 0, 0);
    r = await coach("POST", "/classes", { title: "Notice test", startsAt: soon.toISOString(), durationMin: 60 }); const ncls = r.j.class.id;
    await stu2("PUT", `/classes/${ncls}/rsvp`, { going: true });
    const mails0 = sink.mails.length;
    const later = new Date(soon.getTime() + 864e5);
    r = await coach("PUT", `/classes/${ncls}`, { startsAt: later.toISOString() }); ok(r.s === 200 && r.j.told === 1, "moving a class tells the people booked");
    await new Promise((res) => setTimeout(res, 400));
    ok(sink.mails.slice(mails0).some((m) => m.to[0] === "sam@example.com" && /Changed: Notice test/.test(m.subject)), "they get a 'class time changed' email");
    r = await tess("GET", "/me/notices"); ok(r.j.notices.some((n) => n.kind === "moved" && /Notice test/.test(n.title)) && r.j.unread >= 1, "every student sees the change in the app (group class)");
    r = await coach("DELETE", `/classes/${ncls}`); ok(r.s === 200 && r.j.notified === 1, "cancelling emails the people booked");
    r = await tess("GET", "/me/notices"); ok(r.j.notices.some((n) => n.kind === "cancelled" && /Notice test/.test(n.title)), "and every student sees the cancellation");
    r = await tess("POST", "/me/notices/seen"); r = await tess("GET", "/me/notices"); ok(r.j.unread === 0 && r.j.notices.length >= 2, "notices can be marked as seen");
    r = await coach("POST", "/coach/classes/bulk", { classes: [{ kind: "private", title: "Private lesson", startsAt: soon.toISOString(), durationMin: 60 }] });
    const priv = (await coach("GET", "/classes")).j.classes.find((c) => c.kind === "private" && c.title === "Private lesson" && new Date(c.startsAt).getTime() === soon.getTime());
    await stu2("PUT", `/classes/${priv.id}/rsvp`, { going: true });
    r = await coach("DELETE", `/classes/${priv.id}`); ok(r.s === 200 && r.j.notified === 1, "cancelling a private lesson emails the student who booked it");
    r = await stu2("GET", "/me/notices"); ok(r.j.notices.some((n) => /private lesson/i.test(n.body)), "and they see it in the app");
    r = await tess("GET", "/me/notices"); ok(!r.j.notices.some((n) => /private lesson/i.test(n.body)), "other students don't hear about someone's private lesson");
    // --- money overview and reminders
    r = await coach("GET", "/coach/money"); const M = r.j;
    ok(r.s === 200 && /^\d{4}-\d{2}$/.test(M.month) && M.history.length === 6 && M.students.length >= 3, "money overview: this month, six months of history, every active student");
    const mSam = M.students.find((s) => s.id === sam.id), mNomsa = M.students.find((s) => s.id === nomsa);
    ok(mSam && mSam.feeCents === 90000 && mSam.paidCents >= 10000 && /^JF/.test(mSam.reference) && mNomsa.paidCents === 90000, "each student's fee, what they've paid and their reference");
    ok(M.methods.some((m) => m.method === "cash") && M.collectedCents > 0, "money collected by method");
    r = await coach("GET", "/coach/money?month=2020-01"); ok(r.j.month === "2020-01" && r.j.collectedCents === 0 && r.j.students.length === 0, "an earlier month before anyone joined is empty");
    const mails1 = sink.mails.length;
    r = await coach("POST", "/coach/money/remind", { userIds: [sam.id, nomsa, pieter] }); ok(r.s === 200 && r.j.sent === 2 && r.j.paid.includes("Nomsa Dube"), "email reminders go to people who still owe, not to people who've paid");
    await new Promise((res) => setTimeout(res, 400));
    const rem = sink.mails.slice(mails1).find((m) => m.to[0] === "sam@example.com");
    ok(rem && /fees for/i.test(rem.subject) && rem.html.includes(mSam.reference) && /62123 456 789|62123456789/.test(rem.html), "a reminder has the amount, the bank details and their reference");
    // --- classes you attended (the training log fills itself in from these)
    { const past = new Date(Date.now() - 5 * 3600e3).toISOString();
      const pub = (await coach("POST", "/classes", { title: "Logged class", startsAt: past, durationMin: 60, plan: { focus: "Guard", ids: ["hip_bump"] } })).j.class.id;
      const hid2 = (await coach("POST", "/classes", { title: "Hidden plan class", startsAt: past, durationMin: 60, shared: false, plan: { ids: ["triangle"], notes: "secret" } })).j.class.id;
      const fut = (await coach("POST", "/classes", { title: "Not yet", startsAt: new Date(Date.now() + 864e5).toISOString(), durationMin: 60 })).j.class.id;
      for (const id of [pub, hid2]) await coach("PUT", `/coach/classes/${id}/attendance`, { userIds: [sam.id] });
      await stu2("PUT", `/classes/${fut}/rsvp`, { going: true });
      r = await stu2("GET", "/me/attended"); const got = Object.fromEntries(r.j.classes.map((c) => [c.id, c]));
      ok(r.s === 200 && got[pub] && got[pub].ids.join() === "hip_bump" && got[pub].durationMin === 60 && got[pub].checkedIn, "attended classes come back with what was taught");
      ok(got[hid2] && got[hid2].ids.length === 0 && !JSON.stringify(got[hid2]).includes("secret"), "a plan the coach didn't share stays hidden");
      ok(!got[fut], "classes that haven't happened yet aren't included");
      r = await tess("GET", "/me/attended"); ok(!r.j.classes.some((c) => c.id === pub), "only your own classes"); }
    // --- rate limit
    let last; for (let i = 0; i < 11; i++) last = await anon("POST", "/auth/login", { email: "sam@example.com", password: "bad" });
    ok(last.s === 429, "repeated wrong passwords are slowed down");
    r = await anon("GET", "/nope"); ok(r.s === 404, "unknown API path is 404");
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e)); }
  srv.kill(); site.close(); sink.close();
  console.log(`api: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
