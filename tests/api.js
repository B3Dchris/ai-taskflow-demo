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
  // Stands in for PayFast's "is this notification real?" check.
  let pfValid = "VALID", pfDelay = 0; const pfSrv = require("http").createServer((q, r) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => { pfSrv.last = b; setTimeout(() => r.end(pfValid), pfDelay); }); }).listen(0);
  const env = { PAYFAST_VALIDATE_URL: `http://127.0.0.1:${pfSrv.address().port}/eng/query/validate`, ...process.env, PORT: String(port), DATABASE_URL: DB, JF_IMPORT_ALLOW_LOOPBACK: "1", RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, APP_URL: "https://www.jitsflow.test", INBOUND_SECRET: "test-inbound-secret" }; delete env.ANTHROPIC_API_KEY;
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
    { // Moving gym, leaving, being removed, a gym closing: what a gym kept about someone stays with that gym (or goes with it)
      const pl = new Pool({ connectionString: DB }), ca = client(base), cb = client(base), tina = client(base), uma = client(base);
      const ga = (await ca("POST", "/auth/start-gym", { gym: "Gym A", name: "Coach A", email: "coacha@example.com", password: "coachapass1" })).j.me.gym;
      const gb = (await cb("POST", "/auth/start-gym", { gym: "Gym B", name: "Coach B", email: "coachb@example.com", password: "coachbpass1" })).j.me.gym;
      r = await tina("POST", "/auth/register", { code: ga.studentCode, name: "Tina", email: "tina@example.com", password: "tinapass11" }); const tinaId = r.j.me.id;
      await ca("PATCH", `/coach/students/${tinaId}`, { notes: "Knee surgery Jan; owes R1300", feeCents: 50000, parentName: "Dad" });
      await tina("GET", "/me/pay");
      const ago = new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10);
      await tina("PUT", "/logs/t1", { data: { date: ago, mins: 60, stuck: ["hg_bot"] } });
      r = await ca("GET", `/coach/students/${tinaId}`); ok(r.j.logs.length === 1 && r.j.student.n30 === 1, "her gym sees the session she logged");
      r = await tina("POST", "/me/join", { code: gb.studentCode }); ok(r.s === 200 && r.j.me.gym.name === "Gym B", "a student moves to another gym");
      r = await cb("GET", "/coach/roster"); const t = r.j.people.find((p) => p.id === tinaId);
      ok(t && t.notes === "" && t.parentName === "" && t.feeCents === 0, "the new gym doesn't see the old gym's notes, fee or parent's name: " + JSON.stringify(t && [t.notes, t.parentName, t.feeCents]));
      ok(!(await pl.query("select pay_ref from users where id=$1", [tinaId])).rows[0].pay_ref, "and her old gym's payment reference goes");
      r = await cb("GET", `/coach/students/${tinaId}`); ok(r.j.logs.length === 0 && r.j.student.n30 === 0 && !Object.keys(r.j.student.stuck).length, "nor the training she logged before she joined");
      await tina("PUT", "/logs/t2", { data: { date: today, mins: 60 } });
      r = await cb("GET", `/coach/students/${tinaId}`); ok(r.j.logs.length === 1 && r.j.logs[0].id === "t2", "it sees what she logs from now on");
      r = await tina("GET", "/logs"); ok(r.j.logs.length === 2, "and she still has her whole log");
      r = await tina("POST", "/me/leave", {}); ok(r.s === 200 && r.j.me && !r.j.me.gym, "a student leaves their gym and keeps their account");
      r = await cb("GET", "/coach/roster"); ok(!r.j.people.some((p) => p.id === tinaId), "and is off the gym's list");
      r = await tina("POST", "/me/leave", {}); ok(r.s === 400, "leaving needs a gym to leave");
      r = await cb("POST", "/me/leave", {}); ok(r.s === 400, "coaches can't leave that way");
      await tina("POST", "/me/join", { code: gb.studentCode }); await cb("PATCH", `/coach/students/${tinaId}`, { notes: "Back again" });
      r = await cb("DELETE", `/coach/students/${tinaId}`); ok(r.s === 200, "a coach removes a student who has their own account");
      r = await tina("GET", "/me"); ok(r.j.me && !r.j.me.gym, "they keep their account, with no gym");
      ok((await pl.query("select notes from users where id=$1", [tinaId])).rows[0].notes === "", "and the coach's notes about them go");
      // Closing a gym
      r = await uma("POST", "/auth/register", { code: ga.studentCode, name: "Uma", email: "uma@example.com", password: "umapass11" }); const umaId = r.j.me.id;
      await ca("PATCH", `/coach/students/${umaId}`, { notes: "Pays late" });
      r = await ca("POST", "/coach/students", { name: "Lerato Kid", parentName: "Mama Lerato", phone: "0821234567" }); const kid = r.j.id;
      await ca("POST", "/coach/payments", { userId: umaId, amountCents: 50000, paidOn: today });
      r = await ca("DELETE", "/me", { password: "coachapass1" }); ok(r.s === 400 && /only coach/.test(r.j.error) && /delete it/.test(r.j.error), "the last coach can't delete their account while students use the gym; they're told to delete the gym");
      r = await uma("DELETE", "/coach/gym", { password: "umapass11" }); ok(r.s === 403, "students can't delete the gym");
      r = await ca("DELETE", "/coach/gym", { password: "wrong" }); ok(r.s === 401, "deleting the gym needs the password");
      r = await ca("DELETE", "/coach/gym", { password: "coachapass1" }); ok(r.s === 200 && r.j.me.role === "student" && !r.j.me.gym, "a coach deletes their gym and keeps their own account");
      const gone = (await pl.query("select (select count(*) from gyms where id=$1) g, (select count(*) from users where id=$2) k, (select count(*) from payments where gym_id=$1) p, (select gym_id from users where id=$3) ug, (select notes from users where id=$3) un", [ga.id, kid, umaId])).rows[0];
      ok(Number(gone.g) === 0 && Number(gone.k) === 0 && Number(gone.p) === 0, "the gym, its payments and the kids it added are gone");
      ok(gone.ug === null && gone.un === "", "students with accounts keep them, with no gym and no notes about them");
      r = await uma("GET", "/me"); ok(r.j.me && !r.j.me.gym, "the student sees they're not in a gym");
      r = await ca("DELETE", "/me", { password: "coachapass1" }); ok(r.s === 200, "then the coach can delete their own account");
      // Rejected proofs of payment are deleted after 30 days, with their files
      const pid = async (age) => { const p = (await pl.query("insert into payments(gym_id,amount_cents,paid_on,status,source,created_at) values($1,100,current_date,'rejected','student',now() - ($2 || ' days')::interval) returning id", [gb.id, String(age)])).rows[0].id;
        await pl.query("insert into pop_files(payment_id,name,type,data) values($1,'statement.pdf','application/pdf',$2)", [p, Buffer.from("x")]); return p; };
      const oldP = await pid(31), newP = await pid(5);
      await require("../backend/db").migrate(pl);
      const pf = (await pl.query("select payment_id from pop_files where payment_id = any($1)", [[oldP, newP]])).rows.map((x) => String(x.payment_id));
      ok(pf.length === 1 && pf[0] === String(newP) && !(await pl.query("select 1 from payments where id=$1", [oldP])).rows[0], "rejected proofs older than 30 days are deleted, files and all");
      await pl.end(); }
    const pool2 = new Pool({ connectionString: DB });
    const left = await pool2.query("select (select count(*) from progress where user_id=$1) p, (select count(*) from training_logs where user_id=$1) l", [chris.id]);
    ok(Number(left.rows[0].p) === 0 && Number(left.rows[0].l) === 0, "their progress and sessions are deleted too");
    await pool2.end();
    // --- gym website import
    r = await stu2("POST", "/coach/import", { url: site.url }); ok(r.s === 403, "students can't import");
    r = await coach("POST", "/coach/import", { url: "http://10.0.0.5/" }); ok(r.s === 400 && /public website/.test(r.j.error), "private addresses are refused by the API");
    r = await coach("POST", "/coach/import", { url: site.url });
    ok(r.s === 200 && r.j.method === "basic" && r.j.profile.timetable.length === 9 && r.j.logos.length > 0 && r.j.pages.length === 10, "coach imports their whole website");
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
    ok(wc && wc.subject === "Your gym is set up on JitsFlow" && wc.html.includes("JPB Martial Arts Academy is ready") && wc.html.includes("https://www.jitsflow.test/app/?join=" + sc) && wc.from === "JitsFlow <no-reply@jitsflow.com>" && wc.reply_to === "hello@jitsflow.com" && wc.text, "coach gets a welcome email with the invite link");
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
    ok(inv.to[0] === "lee@example.com" && inv.html.includes("https://www.jitsflow.test/app/?join=" + (await coach("GET", "/me")).j.me.gym.studentCode) && /invited you to/.test(inv.text), "invite email carries the join link");
    ok(inv.subject === "You're invited to join your gym on JitsFlow" && !/Coach JP|JPB/.test(wc.subject + inv.subject), "email subjects never carry a gym or coach name someone typed");
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
    r = await coach("POST", "/coach/students/bulk", { people: [{ name: "Liam Smith", parentName: "Jane Smith", phone: "082 777 0001", email: "jane@example.com" }, { name: "Emma Smith", parentName: "Jane Smith", phone: "082 777 0001", email: "jane@example.com" },
      { name: "Thabo", phone: "083 777 2222" }, { name: "Thabo", phone: "084 777 4444" }, { name: "thabo", phone: "083 777 2222" }] });
    ok(r.s === 201 && r.j.added === 4 && r.j.skipped === 1, "bulk: a sister on the parent's email goes in, and so does a different Thabo; the same Thabo twice doesn't: " + JSON.stringify(r.j));
    { const ro = (await coach("GET", "/coach/roster")).j.people, emma = ro.find((x) => x.name === "Emma Smith");
      ok(emma && emma.phone === "082 777 0001" && emma.email === "" && ro.find((x) => x.name === "Liam Smith").email === "jane@example.com" && ro.filter((x) => x.name === "Thabo").length === 2, "the second kid keeps the parent's number (an email belongs to one person)"); }
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
    ok(r.s === 409 && /invite link/.test(r.j.error) && !(await pieterApp("GET", "/me")).j.me, "typing the email the coach added doesn't take over the record (it could be anyone)");
    r = await client(base)("POST", "/auth/register", { name: "Pieter B", email: "pieter@example.com", password: "pieterpass1" }); ok(r.s === 409, "nor does signing up with no gym code");
    r = await client(base)("POST", "/auth/register", { code: (await other("GET", "/me")).j.me.gym.studentCode, name: "Pieter B", email: "pieter@example.com", password: "pieterpass1" }); ok(r.s === 409, "nor with another gym's code");
    r = await coach("GET", "/coach/roster"); { const pr = r.j.people.find((p) => p.id === pieter); ok(pr && pr.offline && pr.email === "pieter@example.com", "the record stays in the gym, not on the app"); }
    r = await coach("POST", `/coach/students/${pieter}/claim-link`); r = await pieterApp("POST", "/auth/register", { code: new URL(r.j.url).searchParams.get("join"), claim: new URL(r.j.url).searchParams.get("claim"), name: "Pieter B", email: "PIETER@example.com", password: "pieterpass1" });
    ok(r.s === 201 && r.j.me.id === pieter, "the coach's invite link signs them into it");
    // --- added by the coach, then signs up with the gym's code (not their own link): "Are you ...?"
    { const ipA = { "x-forwarded-for": "198.51.100.40" }, sc2 = (await coach("GET", "/me")).j.me.gym.studentCode;
      const sipho = (await coach("POST", "/coach/students", { name: "Sipho Ndlovu", phone: "082 555 0001" })).j.id;
      await coach("POST", "/coach/payments", { userId: sipho, amountCents: 50000, paidOn: today, method: "cash" });
      const sApp = client(base);
      r = await sApp("POST", "/auth/register", { code: sc2, name: "sipho  ndlovu", email: "sipho@example.com", password: "short" }, ipA); ok(r.s === 400, "the form is checked before asking");
      r = await sApp("POST", "/auth/register", { code: sc2, name: "sipho  ndlovu", email: "sipho@example.com", password: "siphopass1" }, ipA);
      ok(r.s === 200 && r.j.ask && r.j.ask.id === sipho && r.j.ask.name === "Sipho Ndlovu" && !r.j.me && !(await sApp("GET", "/me")).j.me, "the same name in that gym asks 'Are you Sipho Ndlovu?' and makes no account yet");
      r = await client(base)("POST", "/auth/register", { code: sc2, name: "Someone Else", email: "else@example.com", password: "elsepass11", link: sipho }, ipA);
      ok(r.s === 409 && !(await coach("GET", "/coach/roster")).j.people.find((p) => p.id === sipho).email, "someone whose name and number don't match can't link to that record");
      r = await sApp("POST", "/auth/register", { code: sc2, name: "Sipho Ndlovu", email: "sipho@example.com", password: "siphopass1", link: sipho }, ipA);
      ok(r.s === 201 && r.j.me.id === sipho && (await sApp("GET", "/me/pay")).j.pay.paidCents === 50000, "saying yes signs them into that record, payments and all");
      const lindi = (await coach("POST", "/coach/students", { name: "Lindiwe Zulu", phone: "082 555 0002", notes: "pays cash" })).j.id;
      await coach("POST", "/coach/payments", { userId: lindi, amountCents: 40000, paidOn: today, method: "cash" });
      const lApp = client(base);
      r = await lApp("POST", "/auth/register", { code: sc2, name: "Lindi Z", email: "lindi@example.com", password: "lindipass1", phone: "+27 82 555 0002" }, ipA);
      ok(r.s === 200 && r.j.ask && r.j.ask.id === lindi, "the same WhatsApp number asks too");
      r = await client(base)("POST", "/auth/register", { code: sc2, name: "Lindi Z", email: "lindi2@example.com", password: "lindipass1" }, ipA); ok(r.s === 201 && r.j.me.id !== lindi, "a different name with no number doesn't ask");
      r = await lApp("POST", "/auth/register", { code: sc2, name: "Lindi Z", email: "lindi@example.com", password: "lindipass1", phone: "+27 82 555 0002", link: "no" }, ipA);
      const lindiApp = r.j.me.id; ok(r.s === 201 && lindiApp !== lindi && r.j.me.phone === "+27 82 555 0002", "saying no makes a new account (with their number)");
      r = await coach("GET", "/coach/roster"); const lo = r.j.people.find((p) => p.id === lindi), la = r.j.people.find((p) => p.id === lindiApp);
      ok(lo.sameAs && lo.sameAs.id === lindiApp && la.sameAs && la.sameAs.id === lindi, "the coach sees them as a possible duplicate");
      r = await stu2("POST", `/coach/students/${lindi}/merge`, { into: lindiApp }); ok(r.s === 403, "students can't merge");
      r = await coach("POST", `/coach/students/${lindiApp}/merge`, { into: lindi }); ok(r.s === 400, "an app account can't be merged away");
      r = await coach("POST", `/coach/students/${lindi}/merge`, { into: lindiApp }); ok(r.s === 200, "coach merges the two");
      r = await coach("GET", "/coach/roster"); const lm = r.j.people.find((p) => p.id === lindiApp);
      ok(!r.j.people.some((p) => p.id === lindi) && !lm.sameAs && /pays cash/.test(lm.notes) && (await lApp("GET", "/me/pay")).j.pay.paidCents === 40000, "one record is left, with the payments and notes"); }
    r = await coach("POST", "/coach/students", { name: "Gone Soon", phone: "0831112222" }); const gone = r.j.id;
    r = await coach("DELETE", `/coach/students/${gone}`); ok(r.s === 200, "coach can remove a student who isn't on the app");
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
    { const off = (await coach("POST", "/coach/students", { name: "Offline Olga", phone: "082 555 0077", email: "olga@example.com" })).j.id;
      const mo = (await coach("GET", "/coach/money")).j.students.find((s) => s.id === off);
      ok(mo && /\/app\/\?join=[A-Z0-9]{8}&claim=/.test(mo.claimUrl || "") && !mSam.claimUrl, "for someone who isn't on the app, the money page gives their invite link for reminders");
      const m3 = sink.mails.length; await coach("POST", "/coach/money/remind", { userIds: [off] }); await new Promise((res) => setTimeout(res, 400));
      const om = sink.mails.slice(m3).find((m) => m.to[0] === "olga@example.com");
      ok(om && om.html.includes(mo.claimUrl.replace(/&/g, "&amp;")) || (om && om.html.includes(mo.claimUrl)), "their email reminder links to it too");
      const olga = client(base); r = await olga("POST", "/auth/register", { code: new URL(mo.claimUrl).searchParams.get("join"), claim: new URL(mo.claimUrl).searchParams.get("claim"), name: "Olga O", email: "olga@example.com", password: "olgapass11" }, { "x-forwarded-for": "198.51.100.41" });
      ok(r.s === 201 && r.j.me.id === off, "and the link signs them into their record"); }
    // --- paused and cancelled members don't owe fees
    { r = await coach("POST", "/coach/plans", { name: "Monthly R800", priceCents: 80000, period: "month" }); const p800 = r.j.plan.id;
      await coach("PATCH", `/coach/students/${pieter}`, { planId: p800, planStatus: "paused" });
      r = await coach("GET", "/coach/money"); const mp = r.j.students.find((s) => s.id === pieter);
      ok(mp && mp.feeCents === 0 && mp.planStatus === "paused", "a paused member owes nothing on the money page: " + JSON.stringify(mp));
      const m2 = sink.mails.length; r = await coach("POST", "/coach/money/remind", { userIds: [pieter] }); await new Promise((res) => setTimeout(res, 400));
      ok(r.j.sent === 0 && !sink.mails.slice(m2).some((m) => m.to[0] === "pieter@example.com"), "and gets no fee reminder");
      r = await pieterApp("GET", "/me/pay"); ok(r.j.pay.dueCents === 0, "and sees no fee due");
      await coach("PATCH", `/coach/students/${pieter}`, { planStatus: "cancelled" }); r = await pieterApp("GET", "/me/pay"); ok(r.j.pay.dueCents === 0, "nor does a cancelled member");
      await coach("PATCH", `/coach/students/${pieter}`, { planStatus: "active" }); r = await pieterApp("GET", "/me/pay"); ok(r.j.pay.dueCents === 80000, "back to active, the fee is due again"); }
    // --- a payment counts toward every month it covers: a year paid up front isn't owing next month
    { r = await coach("POST", "/coach/plans", { name: "Yearly", priceCents: 600000, period: "year" }); const py = r.j.plan.id;
      r = await coach("POST", "/coach/students", { name: "Yara Year", email: "yara@example.com", planId: py }); const yara = r.j.id;
      const mon = (await coach("GET", "/coach/money")).j.month, mAdd = (n, day) => new Date(Date.UTC(+mon.slice(0, 4), +mon.slice(5, 7) - 1 + n, day || 1)).toISOString().slice(0, 10);
      r = await coach("POST", "/coach/payments", { userId: yara, amountCents: 600000, paidOn: mAdd(-1, 15), method: "eft", months: 12 }); ok(r.s === 201 && r.j.payment.months === 12, "a payment can cover 12 months");
      r = await coach("GET", "/coach/money"); const my = r.j.students.find((s) => s.id === yara);
      ok(my && my.feeCents === 50000 && my.paidCents === 50000, "a year paid last month counts toward this month's fee: " + JSON.stringify(my));
      r = await coach("POST", "/coach/money/remind", { userIds: [yara] }); ok(r.j.sent === 0 && r.j.paid.includes("Yara Year"), "so they get no reminder");
      r = await coach("GET", "/coach/money?month=" + mAdd(10).slice(0, 7)); ok(r.j.students.find((s) => s.id === yara).paidCents === 50000, "it still counts in its last month");
      r = await coach("GET", "/coach/money?month=" + mAdd(11).slice(0, 7)); ok(r.j.students.find((s) => s.id === yara).paidCents === 0, "and stops after 12 months");
      r = await coach("POST", "/coach/payments", { userId: yara, amountCents: 50000, paidOn: mAdd(0, 2) }); ok(r.j.payment.months === 1, "a payment covers one month unless the coach says more"); }
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
    // --- PayFast: the gym's plan, card payments, payment notifications
    { const pf = require("../backend/payfast");
      r = await coach("GET", "/coach/billing"); ok(r.s === 200 && r.j.billing.status === "trial" && r.j.billing.trialEnds === "2027-02-08" && r.j.billing.priceCents === 9900 && r.j.billing.feePct === 2 && r.j.billing.test, "a gym gets three free months, then R99 a month: " + JSON.stringify(r.j.billing));
      r = await coach("POST", "/coach/billing/checkout", {}); const f = r.j.fields;
      ok(r.s === 200 && /sandbox\.payfast\.co\.za\/eng\/process$/.test(r.j.action) && f.amount === "0.00" && f.billing_date === "2027-02-08" && f.recurring_amount === "99.00" && f.frequency === "3" && f.subscription_type === "1" && f.cycles === "0", "adding a card charges nothing until the free months end, then R99 monthly");
      ok(f.signature === pf.sign(f, pf.TEST.pass) && f.notify_url === "https://www.jitsflow.test/api/payfast/notify", "the checkout is signed with the passphrase");
      r = await coach("PUT", "/coach/payfast", { merchantId: "123", merchantKey: "x" }); ok(r.s === 400, "a wrong Merchant ID is refused with how to find it");
      r = await coach("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12", passphrase: "gym secret" }); ok(r.s === 200, "a coach connects their own PayFast account");
      { const raw = (await (new Pool({ connectionString: DB })).query("select payfast from gyms where payfast is not null limit 1")).rows[0].payfast; ok(raw.merchantId === "10000105" && raw.key !== "abcdefghijk12" && !JSON.stringify(raw).includes("gym secret"), "their key and passphrase are stored encrypted"); }
      r = await stu2("GET", "/me/pay"); ok(r.j.pay.card === true, "students see they can pay by card");
      r = await stu2("POST", "/me/pay/payfast", { amountCents: 65000 }); const sf = r.j.fields, split = JSON.parse(sf.setup || "{}").split_payment;
      ok(r.s === 200 && sf.merchant_id === "10000105" && sf.amount === "650.00" && sf.custom_str1 === "pay" && split && split.merchant_id === 10000100 && split.percentage === 2, "a student pays into the gym's account, with JitsFlow's 2% split off");
      ok(sf.signature === pf.sign(sf, "gym secret"), "signed with the gym's passphrase (the split isn't part of the signature)");
      r = await stu2("POST", "/me/pay/payfast", { amountCents: 100 }); ok(r.s === 400, "tiny amounts are refused");
      const meId = (await stu2("GET", "/me")).j.me.id;
      const itn = (fields, pass) => { const pairs = Object.entries(fields); const str = pairs.map(([k, v]) => `${k}=${encodeURIComponent(String(v).trim()).replace(/%20/g, "+")}`).join("&") + (pass ? `&passphrase=${encodeURIComponent(pass).replace(/%20/g, "+")}` : "");
        return str.replace(/&passphrase=.*$/, "") + "&signature=" + require("crypto").createHash("md5").update(str).digest("hex"); };
      const post = (body) => fetch(base + "/payfast/notify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
      const pay = { m_payment_id: "pay-x", pf_payment_id: "1089250", payment_status: "COMPLETE", item_name: "Gym fees", item_description: "", amount_gross: "650.00", amount_fee: "-15.18", amount_net: "634.82", custom_str1: "pay", custom_str2: "", custom_int1: String(meId), custom_int2: "", name_first: "", email_address: "", merchant_id: "10000105" };
      const gymId = (await coach("GET", "/me")).j.me.gym.id; pay.custom_int2 = String(gymId);
      const countPf = async () => Number((await (new Pool({ connectionString: DB })).query("select count(*) from payments where source='payfast'")).rows[0].count);
      r = await post(itn(pay, "wrong")); await new Promise((s) => setTimeout(s, 400)); ok(r.status === 200 && (await countPf()) === 0, "a notification with a bad signature changes nothing");
      pfValid = "INVALID"; await post(itn(pay, "gym secret")); await new Promise((s) => setTimeout(s, 400)); ok((await countPf()) === 0, "nor one PayFast doesn't confirm"); pfValid = "VALID";
      await post(itn(pay, "gym secret")); await new Promise((s) => setTimeout(s, 400));
      r = await stu2("GET", "/me/pay"); const got = r.j.pay.payments.find((x) => x.method === "payfast");
      ok((await countPf()) === 1 && got && got.amountCents === 65000 && got.status === "confirmed", "a confirmed card payment is marked paid by itself");
      ok(pfSrv.last && /pf_payment_id=1089250/.test(pfSrv.last) && !/signature=/.test(pfSrv.last), "every notification is checked with PayFast first");
      await post(itn(pay, "gym secret")); await new Promise((s) => setTimeout(s, 400)); ok((await countPf()) === 1, "the same notification twice is recorded once");
      pfDelay = 200; await Promise.all([1, 2, 3].map(() => post(itn({ ...pay, pf_payment_id: "1089260" }, "gym secret")))); await new Promise((s) => setTimeout(s, 900)); pfDelay = 0;
      ok((await countPf()) === 2, "three copies arriving at once are recorded once too");
      const sub = { m_payment_id: "sub-x", pf_payment_id: "1089251", payment_status: "COMPLETE", item_name: "JitsFlow monthly plan", amount_gross: "0.00", custom_str1: "sub", custom_int1: String(gymId), token: "dc0521d3-55fe-269b-fa00-b647310d760f", merchant_id: "10000100" };
      await post(itn(sub, pf.TEST.pass)); await new Promise((s) => setTimeout(s, 400));
      r = await coach("GET", "/coach/billing"); ok(r.j.billing.status === "active" && r.j.billing.card === true, "after adding a card the plan shows as active");
      r = await coach("DELETE", "/coach/payfast"); r = await stu2("GET", "/me/pay"); ok(r.j.pay.card === false, "disconnecting PayFast hides card payments");
      // PayFast's test account (while JitsFlow is in test mode): payments through it are marked TEST and count nowhere.
      r = await coach("PUT", "/coach/payfast", { test: true }); ok(r.s === 200, "in test mode a coach can try PayFast's test account");
      const col0 = (await coach("GET", "/coach/money")).j.collectedCents, paid0 = (await stu2("GET", "/me/pay")).j.pay.paidCents;
      await post(itn({ ...pay, pf_payment_id: "2000001", merchant_id: pf.TEST.id, amount_gross: "800.00" }, pf.TEST.pass)); await new Promise((s) => setTimeout(s, 400));
      r = await stu2("GET", "/me/pay"); const tp = r.j.pay.payments.find((x) => x.reference === "PayFast 2000001");
      ok(tp && tp.status === "test" && r.j.pay.paidCents === paid0, "a test payment is stored as TEST and doesn't count as paid: " + JSON.stringify(tp));
      ok((await coach("GET", "/coach/money")).j.collectedCents === col0, "nor as collected");
      await coach("DELETE", "/coach/payfast"); }
    // --- coaches leaving: an inactive or removed coach loses access, and every coach hears when payment details change
    { const co2 = client(base), x2 = { "x-forwarded-for": "198.51.100.20" }, coachId = (await coach("GET", "/me")).j.me.id;
      r = await co2("POST", "/auth/register", { code: cc, name: "Bad Coach", email: "badcoach@example.com", password: "badcoach1" }, x2); const co2Id = r.j.me.id;
      ok(r.s === 201 && r.j.me.role === "coach", "a second coach joins with the coach code");
      let m0 = sink.mails.length;
      r = await co2("PATCH", "/coach/gym/pay", { holder: "Bad Coach", bank: "Capitec", account: "1234567890", branch: "470010", type: "Savings" }); await wait();
      const told = sink.mails.slice(m0).filter((m) => m.subject === "Your gym's bank details changed");
      ok(r.s === 200 && told.some((m) => m.to[0] === "coach@example.com") && told.some((m) => m.to[0] === "badcoach@example.com") && told.every((m) => /Bad Coach changed the bank details/.test(m.text)), "when the bank details change, every coach gets an email saying who did it");
      m0 = sink.mails.length; r = await coach("PATCH", "/coach/gym/pay", { holder: "Bad Coach", bank: "Capitec", account: "1234567890", branch: "470010", type: "Savings", note: "New note" }); await wait();
      ok(r.s === 200 && !sink.mails.slice(m0).some((m) => /bank details changed/.test(m.subject)), "a change that leaves the bank account alone sends nothing");
      m0 = sink.mails.length; r = await co2("PUT", "/coach/payfast", { merchantId: "12345678", merchantKey: "abcdefghijk12" }); await wait();
      ok(r.s === 200 && sink.mails.slice(m0).some((m) => m.to[0] === "coach@example.com" && m.subject === "Your gym's PayFast account changed" && /Merchant ID 12345678/.test(m.text)), "connecting a PayFast account emails every coach too");
      await coach("DELETE", "/coach/payfast");
      await coach("PATCH", "/coach/gym/pay", { holder: "Test Gym", bank: "FNB", account: "62-123 456 789", branch: "250655", type: "Cheque", note: "Due by the 3rd" });
      r = await coach("PATCH", `/coach/students/${co2Id}`, { active: false }); ok(r.s === 200, "a coach marks the other coach inactive");
      r = await co2("GET", "/me"); ok(r.j.me === null, "which signs them out");
      r = await co2("POST", "/auth/login", { email: "badcoach@example.com", password: "badcoach1" }, x2);
      ok(r.s === 200 && r.j.me.role === "student" && !r.j.me.gym.coachCode && !r.j.me.gym.studentCode, "signed back in, they're not a coach and can't see the codes");
      r = await co2("PATCH", "/coach/gym/pay", { holder: "Bad Coach", bank: "Capitec", account: "1234567890" }); ok(r.s === 403, "an inactive coach can't change the bank details");
      r = await co2("PUT", "/coach/payfast", { merchantId: "12345678", merchantKey: "abcdefghijk12" }); ok(r.s === 403, "or the PayFast account");
      r = await co2("GET", "/coach/roster"); ok(r.s === 403, "or see the roster");
      r = await coach("PATCH", `/coach/students/${coachId}`, { active: false }); ok(r.s === 400, "a coach can't switch themselves off");
      r = await coach("PATCH", `/coach/students/${co2Id}`, { active: true }); r = await co2("GET", "/coach/roster"); ok(r.s === 200, "switched back on, they're a coach again");
      const cc0 = (await coach("GET", "/me")).j.me.gym.coachCode; m0 = sink.mails.length;
      r = await coach("DELETE", `/coach/students/${co2Id}`); ok(r.s === 200 && r.j.me.gym.coachCode !== cc0, "a coach removes another coach, and the coach code changes");
      await wait(); ok(sink.mails.slice(m0).some((m) => m.to[0] === "coach@example.com" && m.subject === "A coach was removed from your gym"), "coaches are told someone was removed");
      r = await co2("GET", "/me"); ok(r.j.me === null, "the removed coach is signed out");
      r = await co2("POST", "/auth/login", { email: "badcoach@example.com", password: "badcoach1" }, x2); ok(r.s === 200 && r.j.me.role === "student" && !r.j.me.gym, "they keep their own account, with no gym");
      r = await co2("PUT", "/coach/payfast", { merchantId: "12345678", merchantKey: "abcdefghijk12" }); ok(r.s === 403, "and can't touch the gym's payments");
      r = await co2("POST", "/me/join", { code: cc0 }); ok(r.s === 404, "the old coach code no longer works");
      r = await coach("GET", "/coach/roster"); ok(!r.j.people.some((p) => p.id === co2Id), "they're off the gym's list");
      r = await coach("DELETE", `/coach/students/${coachId}`); ok(r.s === 400, "a coach can't remove themselves"); }
    // --- a live server (JitsFlow's own PayFast account set): no test merchant, and limits per address that can't be faked
    { const port2 = port + 100, base2 = `http://127.0.0.1:${port2}/api`, pfm = require("../backend/payfast");
      const srv2 = spawn("node", [path.resolve(__dirname, "../server.js")], { env: { ...env, PORT: String(port2), PAYFAST_MERCHANT_ID: "12345678", PAYFAST_MERCHANT_KEY: "abcdefghijk12", PAYFAST_PASSPHRASE: "live pass" }, stdio: ["ignore", "ignore", "inherit"] });
      try {
        for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port2}/healthz`); break; } catch (e) { await new Promise((res) => setTimeout(res, 150)); } }
        const live = client(base2), ipx = { "x-forwarded-for": "203.0.113.50" };
        r = await live("POST", "/auth/start-gym", { gym: "Live Gym", name: "Live Coach", email: "live@example.com", password: "livepass1" }, ipx); ok(r.s === 201, "a gym starts on the live server");
        r = await live("PUT", "/coach/payfast", { merchantId: pfm.TEST.id, merchantKey: pfm.TEST.key, passphrase: pfm.TEST.pass }); ok(r.s === 400 && /test account/.test(r.j.error), "once JitsFlow is live, a gym can't save PayFast's test account");
        r = await live("PUT", "/coach/payfast", { test: true }); ok(r.s === 400, "nor switch on test payments");
        { // A gym that connected the test account (or added a card) while JitsFlow was in test mode
          const db = new Pool({ connectionString: DB }), lg = (await live("GET", "/me")).j.me.gym, lst = client(base2);
          r = await lst("POST", "/auth/register", { code: lg.studentCode, name: "Live Student", email: "livestu@example.com", password: "livestu11" }, { "x-forwarded-for": "203.0.113.61" });
          await db.query("update gyms set payfast=$1, billing = billing || $2 where id=$3", [{ merchantId: pfm.TEST.id, key: pfm.seal(pfm.TEST.key), pass: pfm.seal(pfm.TEST.pass) }, { status: "active", token: "sandbox-token", sandbox: true }, lg.id]);
          r = await lst("GET", "/me/pay"); ok(r.j.pay.card === false, "once live, a test PayFast connection shows no card button");
          r = await lst("POST", "/me/pay/payfast", { amountCents: 80000 }); ok(r.s === 400, "and takes no card payments");
          r = await live("GET", "/coach/payfast"); ok(r.j.payfast.connected === false, "the coach sees it's not connected");
          const tf = { m_payment_id: "pay-t", pf_payment_id: "2000002", payment_status: "COMPLETE", item_name: "Gym fees", amount_gross: "800.00", custom_str1: "pay", custom_int1: String((await lst("GET", "/me")).j.me.id), custom_int2: String(lg.id), merchant_id: pfm.TEST.id };
          const tstr = Object.entries(tf).map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, "+")}`).join("&");
          await fetch(base2 + "/payfast/notify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tstr + "&signature=" + require("crypto").createHash("md5").update(tstr + "&passphrase=" + encodeURIComponent(pfm.TEST.pass)).digest("hex") });
          await new Promise((res) => setTimeout(res, 500));
          ok(!(await db.query("select 1 from payments where reference='PayFast 2000002'")).rows[0], "a test-account payment notification is ignored once live");
          r = await live("GET", "/coach/billing"); ok(r.j.billing.status === "trial" && r.j.billing.card === false, "a card added in test mode has to be added again once live: " + JSON.stringify(r.j.billing));
          await db.end(); }
        r = await live("PUT", "/coach/payfast", { merchantId: "10000105", merchantKey: "abcdefghijk12" }); ok(r.s === 200, "their own account is fine");
        // New gyms: 10 a day from one address (each sends a welcome email).
        let codes = []; for (let i = 0; i < 9; i++) codes.push((await client(base2)("POST", "/auth/start-gym", { gym: "Spam " + i, name: "S", email: `spam${i}@example.com`, password: "spampass1" }, ipx)).s);
        r = await client(base2)("POST", "/auth/start-gym", { gym: "Spam 9", name: "S", email: "spam9@example.com", password: "spampass1" }, ipx);
        ok(codes.every((c) => c === 201) && r.s === 429 && /new gyms today/.test(r.j.error), "one address can start 10 gyms a day: " + codes.join() + " " + r.s);
        r = await client(base2)("POST", "/auth/start-gym", { gym: "Spam 9", name: "S", email: "spam9@example.com", password: "spampass1" }, { "x-forwarded-for": "198.51.100.1", "cf-connecting-ip": "192.0.2.77" });
        ok(r.s === 201, "another address still can");
        // Invite emails: 100 a day per coach (and per gym, and per address).
        let sent = 0, failed = 0; for (let b = 0; b < 4; b++) { r = await live("POST", "/coach/invite", { emails: Array.from({ length: 30 }, (_, i) => `inv${b}-${i}@example.com`) }, ipx); sent += r.j.sent; failed += r.j.failed.length; }
        ok(sent === 100 && failed === 20, `at most 100 invite emails a day (${sent} sent, ${failed} held back)`);
        // Proof uploads by coaches: 50 a day per gym.
        codes = []; for (let i = 0; i < 51; i++) codes.push((await live("POST", "/coach/payments/proof", { name: "p.png", data: png })).s);
        ok(codes.slice(0, 50).every((c) => c === 201) && codes[50] === 429, "a gym can upload 50 proofs a day: the 51st waits");
        // Sign-in: a made-up cf-connecting-ip from outside Cloudflare is ignored.
        const spoof = (i) => ({ "x-forwarded-for": "198.51.100.2", "cf-connecting-ip": "192.0.2." + i });
        codes = []; for (let i = 0; i < 31; i++) codes.push((await client(base2)("POST", "/auth/login", { email: `nobody${i}@example.com`, password: "wrong-pass" }, spoof(i))).s);
        ok(codes.slice(0, 30).every((c) => c === 401) && codes[30] === 429, "changing cf-connecting-ip doesn't get round the limit per address");
        codes = []; for (let i = 0; i < 35; i++) codes.push((await client(base2)("POST", "/auth/login", { email: `cf${i}@example.com`, password: "wrong-pass" }, { "x-forwarded-for": "104.16.0.1", "cf-connecting-ip": "192.0.2." + (100 + i) })).s);
        ok(codes.every((c) => c === 401), "through Cloudflare, each visitor is counted on their own address");
        for (let i = 0; i < 11; i++) await client(base2)("POST", "/auth/login", { email: "live@example.com", password: "wrong-pass" }, { "x-forwarded-for": "198.51.100.3" });
        r = await client(base2)("POST", "/auth/login", { email: "live@example.com", password: "livepass1" }, { "x-forwarded-for": "198.51.100.3" }); ok(r.s === 429, "wrong passwords from one address lock that address out");
        r = await client(base2)("POST", "/auth/login", { email: "live@example.com", password: "livepass1" }, ipx); ok(r.s === 200, "but not the real owner signing in from their own address");
        codes = []; for (let i = 0; i < 12; i++) codes.push((await client(base2)("POST", "/auth/login", { email: "live@example.com", password: "livepass1" }, ipx)).s);
        ok(codes.every((c) => c === 200), "signing in correctly doesn't count towards the limit");
      } finally { srv2.kill(); } }
    // --- rate limit
    let last; for (let i = 0; i < 11; i++) last = await anon("POST", "/auth/login", { email: "sam@example.com", password: "bad" });
    ok(last.s === 429, "repeated wrong passwords are slowed down");
    r = await anon("GET", "/nope"); ok(r.s === 404, "unknown API path is 404");
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e)); }
  pfSrv.close();
  srv.kill(); site.close(); sink.close();
  console.log(`api: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
