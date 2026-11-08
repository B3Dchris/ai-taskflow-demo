// Bookings, waitlists, private lessons, memberships and coach insights against a real PostgreSQL.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/bookings.js   (wipes that database)
const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg");
const { startMailSink } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
function client(base) {
  let cookie = "";
  return async (method, url, body) => {
    const h = {}; if (cookie) h.cookie = cookie; if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; }
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = m[1] ? "jf_s=" + m[1] : ""; }
    let j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j };
  };
}
const DAY = 864e5, wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const sink = await startMailSink();
  const port = 9600 + Math.floor(Math.random() * 90), base = `http://127.0.0.1:${port}/api`;
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB, RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, APP_URL: "https://www.jitsflow.test" };
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch (e) { await wait(150); } }
  try {
    const coach = client(base), other = client(base);
    let r = await coach("POST", "/auth/start-gym", { gym: "JPB Martial Arts Academy", name: "Coach JP", email: "coach@example.com", password: "coachpass1", timezone: "Africa/Johannesburg" });
    const code = r.j.me.gym.studentCode; ok(r.j.me.gym.timezone === "Africa/Johannesburg" && r.j.me.gym.showAttendees === true, "gym keeps its time zone; attendee lists on by default");
    await other("POST", "/auth/start-gym", { gym: "Other", name: "Other", email: "other@example.com", password: "otherpass1" });
    const names = ["Chris Buys", "Sam Khumalo", "Lee Naidoo", "Ana Silva"], S = [];
    for (const [i, n] of names.entries()) { const c = client(base); r = await c("POST", "/auth/register", { code, name: n, email: `s${i}@example.com`, password: "studentpass" + i }); c.id = r.j.me.id; S.push(c); }
    const [chris, sam, lee, ana] = S;
    const at = (d, h) => { const x = new Date(Date.now() + d * DAY); x.setUTCHours(h, 0, 0, 0); return x.toISOString(); };

    // ---- capacity, waitlist and automatic promotion
    r = await coach("POST", "/classes", { title: "No-Gi Advanced", startsAt: at(2, 16), durationMin: 60, capacity: 2, coach: "JP", level: "Advanced" });
    const cid = r.j.class.id; ok(r.s === 201 && r.j.class.capacity === 2 && r.j.class.kind === "class" && r.j.class.level === "Advanced", "coach creates a class with 2 spots");
    r = await chris("PUT", `/classes/${cid}/rsvp`, { going: true }); ok(r.j.going && !r.j.waitlisted, "first student books");
    r = await sam("PUT", `/classes/${cid}/rsvp`, { going: true }); ok(r.j.going, "second student books (class now full)");
    r = await lee("PUT", `/classes/${cid}/rsvp`, { going: true }); ok(!r.j.going && r.j.waitlisted && r.j.position === 1, "third student goes on the waitlist at #1");
    r = await ana("PUT", `/classes/${cid}/rsvp`, { going: true }); ok(r.j.waitlisted && r.j.position === 2, "fourth student is #2 on the waitlist");
    r = await lee("GET", "/classes"); let mine = r.j.classes.find((c) => c.id === cid);
    ok(mine.going === 2 && mine.waiting === 2 && mine.myWaitlisted && mine.myPosition === 1 && mine.capacity === 2, "students see spots taken, waitlist and their place");
    ok(mine.attendees.length === 2 && mine.attendees.map((a) => a.name).join() === "Chris B.,Sam K." && mine.attendees.every((a) => a.belt), "students see who's booked (first name, initial, belt)");
    const n0 = sink.mails.length;
    r = await sam("PUT", `/classes/${cid}/rsvp`, { going: false }); ok(r.j.going === false, "a booked student cancels");
    await wait(300);
    r = await lee("GET", "/classes"); mine = r.j.classes.find((c) => c.id === cid);
    ok(mine.myGoing && !mine.myWaitlisted && mine.going === 2 && mine.waiting === 1, "first on the waitlist gets the spot automatically");
    ok(sink.mails.slice(n0).some((m) => m.to[0] === "s2@example.com" && /You're in/.test(m.subject)), "they get a \"you're in\" email");
    r = await ana("GET", "/classes"); ok(r.j.classes.find((c) => c.id === cid).myPosition === 1, "the rest of the waitlist moves up");
    r = await coach("GET", `/coach/classes/${cid}`);
    ok(r.j.attendees.length === 2 && r.j.waitlist.length === 1 && r.j.waitlist[0].name === "Ana Silva" && r.j.attendees[0].name === "Chris Buys", "coach sees bookings (full names) and the waitlist");
    r = await other("PUT", `/classes/${cid}/rsvp`, { going: true }); ok(r.s === 404, "another gym can't book");
    r = await coach("PUT", `/classes/${cid}`, { title: "No-Gi Advanced", startsAt: at(2, 16), plan: { focus: "Leg locks", ids: [] } });
    ok(r.j.class.capacity === 2 && r.j.class.coach === "JP" && r.j.class.level === "Advanced" && r.j.class.durationMin === 60 && r.j.class.plan.focus === "Leg locks", "editing the plan keeps the class's spots, coach, level and length");

    // ---- parallel booking of the last spot
    r = await coach("POST", "/classes", { title: "Open mat", startsAt: at(3, 9), capacity: 1 }); const race = r.j.class.id;
    const both = await Promise.all([sam("PUT", `/classes/${race}/rsvp`, { going: true }), ana("PUT", `/classes/${race}/rsvp`, { going: true })]);
    ok(both.filter((x) => x.j.going).length === 1 && both.filter((x) => x.j.waitlisted).length === 1, "two people tapping at once can't both get the last spot");

    // ---- attendee lists can be switched off
    r = await coach("PATCH", "/coach/gym", { showAttendees: false }); ok(r.j.me.gym.showAttendees === false, "coach hides who's booked");
    r = await chris("GET", "/classes"); ok(!r.j.classes.find((c) => c.id === cid).attendees && r.j.showAttendees === false, "students then only see counts");
    r = await coach("GET", `/coach/classes/${cid}`); ok(r.j.attendees.length === 2 && r.j.attendees[0].name === "Chris Buys", "coaches still see names (in the class)");
    await coach("PATCH", "/coach/gym", { showAttendees: true });

    // ---- private lessons
    r = await coach("POST", "/classes", { kind: "private", title: "Private with JP", startsAt: at(4, 8), durationMin: 60, priceCents: 45000, coach: "JP" });
    const pid = r.j.class.id; ok(r.j.class.kind === "private" && r.j.class.capacity === 1 && r.j.class.priceCents === 45000, "coach posts a private lesson slot");
    r = await sam("GET", "/classes"); ok(r.j.classes.some((c) => c.id === pid && c.kind === "private" && !c.attendees), "students see open private slots, with no attendee list");
    r = await sam("PUT", `/classes/${pid}/rsvp`, { going: true }); ok(r.j.going, "a student books the private");
    r = await lee("GET", "/classes"); ok(!r.j.classes.some((c) => c.id === pid), "a booked private disappears for everyone else");
    r = await lee("PUT", `/classes/${pid}/rsvp`, { going: true }); ok(r.s === 409, "nobody can double-book a private");
    r = await coach("GET", "/classes"); ok(r.j.classes.find((c) => c.id === pid).attendees[0].name === "Sam Khumalo", "coach sees who booked the private");
    r = await coach("POST", "/coach/classes/bulk", { classes: [{ kind: "private", title: "Semi-private", startsAt: at(5, 7), capacity: 2, priceCents: 30000, coach: "JP" }] });
    r = await coach("GET", "/classes"); const bulkP = r.j.classes.find((c) => c.title === "Semi-private");
    ok(bulkP && bulkP.kind === "private" && bulkP.capacity === 2 && bulkP.priceCents === 30000 && bulkP.coach === "JP", "slots added in bulk keep their type, spots, price and coach");

    // ---- memberships: weekly limits and status
    r = await coach("POST", "/coach/plans", { name: "2x a week", priceCents: 65000, period: "month", classesPerWeek: 2 }); const plan2 = r.j.plan.id;
    ok(r.s === 201 && r.j.plan.monthlyCents === 65000 && r.j.plan.classesPerWeek === 2, "coach makes a membership plan");
    r = await coach("POST", "/coach/plans", { name: "Unlimited", priceCents: 85000, period: "month" }); const planU = r.j.plan.id;
    r = await coach("PATCH", `/coach/students/${ana.id}`, { planId: plan2, planStatus: "active", planStarted: "2026-01-01" }); ok(r.s === 200, "coach puts a student on a plan");
    const wk = (() => { const d = new Date(Date.now() + 14 * DAY); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); d.setUTCHours(15, 0, 0, 0); return d; })();
    const ids = [];
    for (let i = 0; i < 3; i++) { r = await coach("POST", "/classes", { title: "Fundamentals " + i, startsAt: new Date(wk.getTime() + i * DAY).toISOString() }); ids.push(r.j.class.id); }
    await ana("PUT", `/classes/${ids[0]}/rsvp`, { going: true }); await ana("PUT", `/classes/${ids[1]}/rsvp`, { going: true });
    r = await ana("PUT", `/classes/${ids[2]}/rsvp`, { going: true }); ok(r.s === 403 && /2 classes a week/.test(r.j.error), "the plan's weekly limit is enforced: " + (r.j && r.j.error));
    await ana("PUT", `/classes/${ids[0]}/rsvp`, { going: false });
    r = await ana("PUT", `/classes/${ids[2]}/rsvp`, { going: true }); ok(r.j.going, "after cancelling one, they can book another");
    r = await ana("GET", "/me/membership"); ok(r.j.membership.plan.name === "2x a week" && r.j.membership.status === "active", "students see their membership");
    r = await coach("PATCH", `/coach/students/${ana.id}`, { planStatus: "paused" });
    r = await ana("PUT", `/classes/${ids[0]}/rsvp`, { going: true }); ok(r.s === 403 && /paused/.test(r.j.error), "a paused membership can't book");
    await coach("PATCH", `/coach/students/${ana.id}`, { planStatus: "active" });
    await coach("PATCH", `/coach/students/${chris.id}`, { planId: planU });
    r = await coach("GET", "/coach/roster"); const rc = r.j.people.find((p) => p.name === "Chris Buys");
    ok(rc.planName === "Unlimited" && rc.feeCents === 85000 && r.j.plans.length === 2, "roster shows each student's plan and the fee it implies");

    // ---- check-in window
    r = await coach("POST", "/classes", { title: "Lunch no-gi", startsAt: new Date(Date.now() + 20 * 60e3).toISOString(), durationMin: 60 }); const soon = r.j.class.id;
    r = await chris("POST", `/classes/${soon}/checkin`); ok(r.s === 200, "students check themselves in shortly before class");
    r = await coach("GET", `/coach/classes/${soon}`); ok(r.j.attendees[0].attended && r.j.attendees[0].self, "coach sees the self check-in");
    r = await chris("POST", `/classes/${ids[1]}/checkin`); ok(r.s === 400 && /45 minutes/.test(r.j.error), "check-in isn't open days ahead");
    r = await coach("PUT", `/coach/classes/${soon}/attendance`, { userIds: [sam.id, lee.id], attended: true }); ok(r.j.count === 2, "coach checks in several at once");

    // ---- cancelling a class tells the people booked
    const n1 = sink.mails.length;
    r = await coach("DELETE", `/classes/${cid}`); await wait(300);
    ok(r.j.notified === 3 && sink.mails.slice(n1).filter((m) => /Cancelled: No-Gi Advanced/.test(m.subject)).length === 3, "cancelling a class emails everyone booked or waiting");

    // ---- insights from 10 weeks of history
    const gym = (await pool.query("select gym_id from users where email='coach@example.com'")).rows[0].gym_id;
    const uid = Object.fromEntries((await pool.query("select id, email from users")).rows.map((x) => [x.email, x.id]));
    await pool.query("update users set created_at=now()-interval '200 days' where gym_id=$1 and email <> 's3@example.com'", [gym]);
    await pool.query("update users set created_at=now()-interval '5 days' where email='s3@example.com'");
    const past = async (daysAgo, title, cap, who, checked) => {
      const t = new Date(Date.now() - daysAgo * DAY); t.setUTCHours(16, 0, 0, 0);
      const c = (await pool.query("insert into classes(gym_id,title,starts_at,capacity) values($1,$2,$3,$4) returning id", [gym, title, t, cap])).rows[0].id;
      for (const w of who) await pool.query("insert into attendance(class_id,user_id,going,attended) values($1,$2,true,$3)", [c, uid[w], checked]);
    };
    for (let d = 3; d <= 70; d += 7) await past(d, "Tuesday Advanced", 3, ["s0@example.com", "s1@example.com", "s2@example.com"], true);   // full every week
    for (let d = 5; d <= 70; d += 7) await past(d, "Thursday Fundamentals", 20, ["s0@example.com"], false);                               // quiet, never checked in (bookings count)
    for (let d = 30; d <= 70; d += 3) await past(d, "Extra", null, ["s1@example.com"], true);                                              // Sam used to come a lot more
    await pool.query("update attendance set attended=false, going=false where user_id=$1 and class_id in (select id from classes where starts_at > now() - interval '25 days' and title='Tuesday Advanced')", [uid["s1@example.com"]]);
    r = await coach("GET", "/coach/insights");
    const I = r.j, seg = Object.fromEntries(I.students.map((s) => [s.name, s.segment]));
    ok(r.s === 200 && I.kpis.active === 4 && I.weeks.length === 12, "insights: active members and 12 weeks of attendance");
    ok(seg["Chris Buys"] === "regular" && seg["Sam Khumalo"] === "at_risk" && seg["Ana Silva"] === "new", "students are grouped: " + JSON.stringify(seg));
    const tue = I.slots.find((s) => s.title === "Tuesday Advanced"), thu = I.slots.find((s) => s.title === "Thursday Fundamentals");
    ok(tue && tue.fill >= 60 && thu && thu.avg === 1 && thu.fill === 5, "class slots show how full they run: " + JSON.stringify([tue, thu]));
    ok(I.students.find((s) => s.name === "Chris Buys").streak >= 8 && I.students.find((s) => s.name === "Chris Buys").d28 >= 8, "streaks and visits per 4 weeks");
    ok(I.revenue.expected >= 85000 + 65000 && I.revenue.unpaid.some((u) => u.name === "Chris Buys"), "revenue: expected from plans, and who hasn't paid");
    ok(I.plans.find((p) => p.name === "Unlimited").members === 1, "membership mix by plan");
    r = await chris("GET", "/coach/insights"); ok(r.s === 403, "students can't see insights");

    // ---- emailing students from insights
    const n2 = sink.mails.length;
    r = await coach("POST", "/coach/message", { userIds: [sam.id], subject: "Missed you on the mats", text: "Hey, we haven't seen you in a while.\n\nTuesday advanced has a spot for you." });
    await wait(200);
    const msg = sink.mails.slice(n2)[0];
    ok(r.j.sent === 1 && msg && msg.to[0] === "s1@example.com" && msg.reply_to === "coach@example.com" && /Tuesday advanced/.test(msg.text), "coach emails a student; replies go to the coach");
    r = await coach("POST", "/coach/message", { userIds: [999999], subject: "x", text: "y" }); ok(r.s === 400, "can't email people outside the gym");

    // ---- plans from imported website rates
    await pool.query("update gyms set profile=$1 where id=$2", [{ rates: [{ name: "Unlimited", price: 850, period: "month" }, { name: "3 times a week", price: 750, period: "month" }, { name: "Drop-in", price: 150, period: "class" }] }, gym]);
    r = await coach("POST", "/coach/plans/from-rates"); ok(r.j.added === 2 && r.j.plans.find((p) => p.name === "3 times a week").classesPerWeek === 3, "website rates become plans (with weekly limits read from the name)");
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e)); }
  srv.kill(); sink.close(); await pool.end();
  console.log(`bookings: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
