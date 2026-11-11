// The weekly timetable keeps the calendar going, the import finishes setup, and "Book my usual", against a real PostgreSQL.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/timetable.js   (wipes that database)
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
  await pool.query("drop table if exists autopay_charges, autopay, class_skips, plan_breaks, notices, left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const sink = await startMailSink();
  const port = 9500 + Math.floor(Math.random() * 90), base = `http://127.0.0.1:${port}/api`;
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB, RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, APP_URL: "https://www.jitsflow.test" };
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch (e) { await wait(150); } }
  const { rollAll, rollTimetable } = require("../backend/db");
  try {
    const coach = client(base), coach2 = client(base), other = client(base);
    let r = await coach("POST", "/auth/start-gym", { gym: "JPB Martial Arts Academy", name: "Coach JP", email: "coach@example.com", password: "coachpass1", timezone: "Africa/Johannesburg" });
    const code = r.j.me.gym.studentCode, ccode = r.j.me.gym.coachCode, gym = Number(r.j.me.gym.id);
    await coach2("POST", "/auth/register", { code: ccode, name: "Coach Anna", email: "anna@example.com", password: "annapass12" });
    await other("POST", "/auth/start-gym", { gym: "Other", name: "Other", email: "other@example.com", password: "otherpass1" });
    const S = [];
    for (const [i, n] of ["Chris Buys", "Sam Khumalo", "Lee Naidoo"].entries()) { const c = client(base); r = await c("POST", "/auth/register", { code, name: n, email: `s${i}@example.com`, password: "studentpass" + i }); c.id = r.j.me.id; S.push(c); }
    const [chris, sam, lee] = S;
    const classes = async (who = coach) => (await who("GET", `/classes?from=${new Date(Date.now() - 9 * DAY).toISOString()}&to=${new Date(Date.now() + 70 * DAY).toISOString()}`)).j.classes;
    const future = (cs, title) => cs.filter((c) => c.title === title && new Date(c.startsAt) > new Date());
    const local = (iso) => new Date(iso).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    const dupes = (cs) => { const k = cs.map((c) => c.title + c.startsAt); return k.length - new Set(k).size; };

    // ---- a manual class already on the calendar at a timetable time is linked to it, not doubled
    const sjDay = (n) => new Date(Date.now() + n * DAY).toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" });
    const dow = (k) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(k + "T12:00:00Z").getUTCDay()];
    const d3 = sjDay(3), d4 = sjDay(4), d5 = sjDay(5);
    r = await coach("POST", "/classes", { title: "Fundamentals", startsAt: `${d3}T18:00:00+02:00`, durationMin: 60 }); const manual = r.j.class.id;

    // ---- saving the timetable puts about 8 weeks of classes on the calendar, with no button
    const tt = [{ day: dow(d3), start: "18:00", end: "19:00", title: "Fundamentals", coach: "JP" }, { day: dow(d4), start: "18:00", end: "19:30", title: "Muay Thai", type: "Muay Thai" },
      { day: dow(d5), start: "09:00", end: "10:00", title: "Open mat" }];
    r = await coach("PUT", "/coach/gym/profile", { profile: { name: "JPB Martial Arts Academy", timetable: tt, rates: [] } });
    ok(r.s === 200 && r.j.classesAdded >= 21 && r.j.classesAdded <= 24, "saving the timetable fills the calendar 8 weeks ahead: " + r.j.classesAdded);
    r = await coach("GET", "/gym"); const rows = r.j.gym.profile.timetable;
    ok(rows.length === 3 && rows.every((x) => /^[a-z0-9]{4,16}$/.test(x.id)) && new Set(rows.map((x) => x.id)).size === 3, "each timetable row gets its own id");
    let cs = await classes();
    ok(future(cs, "Fundamentals").length === 8 && future(cs, "Muay Thai").length === 8 && future(cs, "Open mat").length === 8, "each weekly class is on the calendar for the next 8 weeks");
    ok(dupes(cs) === 0 && cs.filter((c) => c.id === manual).length === 1 && cs.find((c) => c.id === manual).weekly, "a class already there at that time is used, not doubled");
    ok(future(cs, "Muay Thai").every((c) => c.durationMin === 90 && c.discipline === "Muay Thai" && local(c.startsAt).includes("18:00")), "classes get the row's time, length and style (in the gym's time zone)");
    ok(!future(cs, "Fundamentals").some((c) => new Date(c.startsAt) > new Date(Date.now() + 57 * DAY)), "nothing is added past 8 weeks");
    r = await other("GET", "/classes"); ok(!r.j.classes.length, "other gyms don't get these classes");

    // ---- the daily job: safe to run again, and on several servers at once
    await pool.query("update gyms set timetable_rolled=null");
    const runs = await Promise.all([rollAll(pool), rollAll(pool), rollTimetable(pool, gym)]);
    cs = await classes();
    ok(runs.reduce((a, b) => a + b, 0) === 0 && dupes(cs) === 0 && future(cs, "Fundamentals").length === 8, "running the job again (three at once) adds nothing: " + runs.join(","));
    // the calendar keeps itself going: weeks that have run out are filled again
    await pool.query("delete from classes where gym_id=$1 and starts_at > now() + interval '20 days'", [gym]);
    ok(future(await classes(), "Open mat").length < 4, "(weeks later the calendar would run out)");
    await pool.query("update gyms set timetable_rolled=null");
    ok((await rollAll(pool)) >= 12 && future(await classes(), "Open mat").length === 8, "the job tops the calendar back up to 8 weeks");
    await pool.query("update gyms set timetable_rolled=current_date");
    ok((await rollAll(pool)) === 0, "a gym already filled today is skipped");

    // ---- a deleted class (a public holiday) stays deleted
    cs = future(await classes(), "Open mat"); const hol = cs[1];
    r = await coach("DELETE", `/classes/${hol.id}`, { notify: false }); ok(r.s === 200, "coach deletes one Open mat");
    await pool.query("update gyms set timetable_rolled=null"); await rollAll(pool);
    cs = future(await classes(), "Open mat");
    ok(cs.length === 7 && !cs.some((c) => c.startsAt === hol.startsAt), "the job doesn't put a deleted class back");

    // ---- editing a row moves the classes nobody booked; booked ones wait for the coach
    cs = future(await classes(), "Muay Thai");
    r = await chris("PUT", `/classes/${cs[0].id}/rsvp`, { going: true }); ok(r.j.going, "Chris books the next Muay Thai");
    r = await sam("PUT", `/classes/${cs[0].id}/rsvp`, { going: true });
    let prof = (await coach("GET", "/gym")).j.gym.profile, mt = prof.timetable.find((x) => x.title === "Muay Thai");
    mt.start = "18:30"; mt.end = "20:00"; mt.coach = "Anna";
    r = await coach2("PUT", "/coach/gym/profile", { profile: prof });
    ok(r.s === 200 && r.j.moved === 7 && r.j.held.length === 1 && r.j.held[0].bookings === 2 && r.j.held[0].classes === 1 && r.j.held[0].slot === mt.id && /18:00/.test(r.j.held[0].was) && /18:30/.test(r.j.held[0].now), "a time change moves 7 empty classes and holds the booked one: " + JSON.stringify(r.j.held));
    cs = future(await classes(), "Muay Thai");
    ok(cs.length === 8 && dupes(cs) === 0 && cs.filter((c) => local(c.startsAt).includes("18:30")).length === 7 && local(cs[0].startsAt).includes("18:00") && cs.every((c) => c.coach === "Anna"), "no duplicates: 7 at the new time, the booked one still at 18:00 (new coach on all)");
    await pool.query("update gyms set timetable_rolled=null"); await rollAll(pool);
    ok(future(await classes(), "Muay Thai").length === 8, "the job doesn't add a second class in the booked class's week");
    const n0 = sink.mails.length;
    r = await chris("POST", `/coach/timetable/apply`, { slots: [mt.id] }); ok(r.s === 403, "students can't move classes");
    r = await coach2("POST", "/coach/timetable/apply", { slots: [mt.id] });
    ok(r.s === 200 && r.j.moved === 1 && r.j.told === 2, "Move 2 bookings and tell them: " + JSON.stringify(r.j));
    await wait(300);
    cs = future(await classes(chris), "Muay Thai");
    ok(cs[0].myGoing && local(cs[0].startsAt).includes("18:30") && cs.length === 8, "Chris's booking moved with the class");
    ok(sink.mails.slice(n0).filter((m) => /Changed: Muay Thai/.test(m.subject)).length === 2, "both people booked get an email");
    r = await chris("GET", "/me/notices"); ok(r.j.notices.some((n) => n.title === "Moved: Muay Thai" && /Tuesdays|Mondays|Wednesdays|Thursdays|Fridays|Saturdays|Sundays/.test(n.body)), "and a notice in the app");

    // ---- taking a row off the timetable
    cs = future(await classes(), "Open mat"); r = await lee("PUT", `/classes/${cs[0].id}/rsvp`, { going: true });
    prof = (await coach("GET", "/gym")).j.gym.profile; const om = prof.timetable.find((x) => x.title === "Open mat");
    const stale = JSON.parse(JSON.stringify(prof)), omN = future(await classes(), "Open mat").length;
    prof.timetable = prof.timetable.filter((x) => x !== om);
    r = await coach("PUT", "/coach/gym/profile", { profile: prof });
    ok(r.j.held.length === 0 && future(await classes(), "Open mat").length === omN && (await coach("GET", "/gym")).j.gym.profile.timetable.some((x) => x.id === om.id), "a row left out of a save isn't taken off (only one the coach removed is)");
    r = await coach("PUT", "/coach/gym/profile", { profile: prof, removed: [om.id], ttBase: stale.timetable });
    ok(r.j.held.length === 1 && r.j.held[0].removed && r.j.held[0].bookings === 1 && future(await classes(), "Open mat").length === 1, "removing a row deletes its empty classes and holds the booked one");
    r = await coach("POST", "/coach/timetable/apply", { slots: [om.id] });
    ok(r.j.cancelled === 1 && r.j.told === 1 && future(await classes(), "Open mat").length === 0, "Cancel and tell them");
    await wait(300); ok(sink.mails.some((m) => m.to[0] === "s2@example.com" && /Cancelled: Open mat/.test(m.subject)), "the person booked is told");
    r = await coach("PUT", "/coach/gym/profile", { profile: prof }); ok(r.j.moved === 0 && !r.j.held.length && r.j.classesAdded === 0 && !(await coach("GET", "/gym")).j.gym.profile.timetable.some((x) => x.id === om.id), "saving again without changes does nothing");

    // ---- a new import of the same site (rows without ids) keeps the classes already there
    prof = (await coach("GET", "/gym")).j.gym.profile; const fid = prof.timetable.find((x) => x.title === "Fundamentals").id, fBefore = future(await classes(), "Fundamentals").map((c) => c.id).join();
    r = await coach("PUT", "/coach/gym/profile", { profile: { ...prof, timetable: prof.timetable.map(({ id, ...x }) => x) } });
    ok(r.j.classesAdded === 0 && r.j.moved === 0 && !r.j.held.length && (await coach("GET", "/gym")).j.gym.profile.timetable.find((x) => x.title === "Fundamentals").id === fid
      && future(await classes(), "Fundamentals").map((c) => c.id).join() === fBefore, "saving the same rows without ids (a new import) keeps their ids and classes");

    // ---- Repeat: every week (the class form) becomes a timetable row from that day on
    const d10 = sjDay(10);
    r = await coach("POST", "/coach/timetable/slot", { title: "Kids BJJ", startsAt: `${d10}T16:00:00+02:00`, durationMin: 45, capacity: 12, coach: "Anna", level: "Kids", plan: { focus: "Shrimping", notes: "", ids: [] } });
    ok(r.s === 201 && r.j.added >= 6 && r.j.added <= 7 && r.j.slot.from === d10 && r.j.slot.start === "16:00" && r.j.slot.end === "16:45" && r.j.slot.cap === 12, "a weekly class is saved as a timetable row: " + JSON.stringify(r.j));
    cs = future(await classes(), "Kids BJJ");
    ok(cs.length === r.j.added && cs[0].startsAt.slice(0, 10) >= d10.slice(0, 10) && new Date(cs[0].startsAt) >= new Date(`${d10}T00:00:00+02:00`) && cs.every((c) => c.capacity === 12 && c.durationMin === 45 && c.level === "Kids"), "it starts on the day picked, with its spots, length and level");
    ok(cs[0].plan.focus === "Shrimping" && !cs[1].plan.focus, "the lesson plan goes on the first class");
    r = await coach("GET", "/gym"); ok(r.j.gym.profile.timetable.some((x) => x.title === "Kids BJJ" && x.day === dow(d10)), "and shows on the gym's timetable");
    r = await chris("POST", "/coach/timetable/slot", { title: "x", startsAt: `${d10}T16:00:00+02:00` }); ok(r.s === 403, "students can't add weekly classes");
    r = await coach("POST", "/coach/timetable/slot", { kind: "private", title: "Private", startsAt: `${d10}T16:00:00+02:00` }); ok(r.s === 400, "private slots repeat from their own sheet");

    // ---- rows from before ids get one, and work
    await pool.query("update gyms set profile = jsonb_set(profile, '{timetable}', profile->'timetable' || '[{\"day\":\"Sun\",\"start\":\"10:00\",\"end\":\"11:00\",\"title\":\"Sunday roll\"}]'::jsonb), timetable_rolled=null where id=$1", [gym]);
    await rollAll(pool);
    r = await coach("GET", "/gym"); ok(r.j.gym.profile.timetable.find((x) => x.title === "Sunday roll").id, "an old row without an id gets one");
    ok(future(await classes(), "Sunday roll").length === 8, "and its classes go on the calendar");

    // ---- import review: plans and calendar ticked by default; once-off and per-class prices aren't plans
    const rates = [{ name: "Adult unlimited", price: 850, period: "month" }, { name: "Kids (6-12)", price: 600, period: "month" }, { name: "Drop-in class", price: 150, period: "class" },
      { name: "Joining fee", price: 250, period: "once" }, { name: "Registration", price: 300, period: "month" }, { name: "Private lesson", price: 500, period: "month" }];
    prof = (await coach("GET", "/gym")).j.gym.profile;
    r = await coach2("PUT", "/coach/gym/profile", { profile: { ...prof, rates }, plans: true });
    ok(r.s === 200 && r.j.plansAdded === 0, "only the head coach makes plans");
    r = await coach("PUT", "/coach/gym/profile", { profile: { ...prof, rates }, plans: true });
    ok(r.j.plansAdded === 2, "Create 2 membership plans: " + r.j.plansAdded);
    r = await coach("GET", "/coach/plans"); ok(r.j.plans.map((p) => p.name).sort().join() === "Adult unlimited,Kids (6-12)", "the joining fee, drop-in, registration and private lesson aren't plans: " + r.j.plans.map((p) => p.name).join());
    r = await coach("PUT", "/coach/gym/profile", { profile: { ...prof, rates }, plans: true }); ok(r.j.plansAdded === 0, "saving again doesn't make them twice");
    r = await coach("POST", "/coach/plans/from-rates"); ok(r.j.added === 0, "Use my website prices skips them too");
    // unticked: the timetable is saved to show, not put on the calendar
    const g2 = client(base);
    r = await g2("POST", "/auth/start-gym", { gym: "Quiet Gym", name: "Coach Q", email: "q@example.com", password: "quietpass1" });
    r = await g2("PUT", "/coach/gym/profile", { profile: { name: "Quiet Gym", timetable: tt }, calendar: false });
    ok(r.j.classesAdded === 0 && (await classes(g2)).length === 0, "unticking 'put on the calendar' adds no classes");
    r = await g2("GET", "/gym"); ok(r.j.gym.profile.timetable.length === 3 && r.j.gym.profile.timetable.every((x) => x.off), "the timetable is still saved to show");
    await pool.query("update gyms set timetable_rolled=null"); await rollAll(pool); ok((await classes(g2)).length === 0, "and the job leaves it alone");
    r = await g2("PUT", "/coach/gym/profile", { profile: (await g2("GET", "/gym")).j.gym.profile, calendar: true });
    ok(r.j.classesAdded >= 21 && (await classes(g2)).length >= 21, "ticking it later puts them on");

    // ---- Book my usual
    await pool.query("delete from attendance");
    const mk = async (title, at, cap) => (await pool.query("insert into classes(gym_id,title,starts_at,duration_min,capacity) values($1,$2,$3,60,$4) returning id", [gym, title, at, cap || null])).rows[0].id;
    const h = (d, hh) => `${sjDay(d)}T${hh}:00+02:00`;
    const a1 = await mk("Usual A", h(-6, "06:00")), b1 = await mk("Usual B", h(-5, "06:00")), c1 = await mk("Usual C", h(-4, "06:00")), x1 = await mk("Skipped", h(-3, "06:00"));
    const a2 = await mk("Usual A", h(1, "06:00")), b2 = await mk("Usual B", h(2, "06:00"), 1), c2 = await mk("Usual C", h(3, "06:00")), x2 = await mk("Skipped", h(4, "06:00"));
    const other2 = await mk("Usual A", h(1, "07:00")), late = await mk("Usual A", h(8, "06:00"));
    await pool.query("insert into attendance(class_id,user_id,going,attended) values($1,$4,true,true),($2,$4,true,false),($3,$4,false,true),($5,$4,false,false)", [a1, b1, c1, sam.id, x1]);
    await pool.query("insert into attendance(class_id,user_id,going) values($1,$2,true)", [b2, lee.id]);
    r = await sam("GET", "/classes"); ok(r.j.usual && r.j.usual.sort().join() === [a2, b2, c2].map(String).sort().join(), "the Classes tab knows Sam's usual classes this week: " + JSON.stringify(r.j.usual));
    r = await coach("GET", "/classes"); ok(r.j.usual === undefined, "coaches don't get it");
    const pl = (await coach("POST", "/coach/plans", { name: "Twice a week", priceCents: 50000, classesPerWeek: 2 })).j.plan.id;
    await coach("PATCH", `/coach/students/${sam.id}`, { planId: pl, planStatus: "active" });
    const wk = await pool.query("select count(distinct date_trunc('week', starts_at at time zone 'Africa/Johannesburg')) as n from classes where id = any($1)", [[a2, b2, c2]]);
    r = await sam("POST", "/me/book-usual");
    const got = (k) => r.j[k].map((x) => x.id).sort().join();
    ok(r.s === 200 && [...r.j.booked, ...r.j.waiting, ...r.j.failed].length === 3, "Book my usual tries the 3 classes Sam booked or came to a week ago");
    ok(r.j.waiting.some((x) => x.id === String(b2) && x.position === 1), "a full class puts Sam on the waitlist: " + JSON.stringify(r.j));
    if (Number(wk.rows[0].n) === 1) ok(r.j.booked.length === 1 && r.j.failed.length === 1 && /2 classes a week/.test(r.j.failed[0].reason), "the plan's weekly limit still applies: " + JSON.stringify(r.j.failed));
    else ok(r.j.booked.length + r.j.failed.length === 2, "the plan's weekly limit is checked per week");
    const mine = await pool.query("select class_id from attendance where user_id=$1 and (going or waitlisted)", [sam.id]);
    ok(!mine.rows.some((x) => [x2, other2, late].includes(Number(x.class_id))), "a class they skipped, another time, or one more than a week away isn't booked");
    r = await sam("POST", "/me/book-usual"); ok(r.j.booked.length + r.j.waiting.length === 0, "tapping again books nothing twice");
    await pool.query("update users set plan_id=$1, plan_status='paused' where id=$2", [pl, chris.id]);
    await pool.query("insert into attendance(class_id,user_id,going,attended) values($1,$2,true,true)", [a1, chris.id]);
    r = await chris("POST", "/me/book-usual"); ok(!r.j.booked.length && r.j.failed.length === 1, "a paused member is told why: " + JSON.stringify(r.j.failed));
    r = await lee("POST", "/me/book-usual"); ok(r.s === 200 && !r.j.booked.length && !r.j.failed.length, "nothing last week: nothing to book");

    // ======== second round: another gym, so the counts above aren't touched ========
    const hc = client(base), an = client(base);
    r = await hc("POST", "/auth/start-gym", { gym: "Round Two BJJ", name: "Head Coach", email: "head2@example.com", password: "headpass12", timezone: "Africa/Johannesburg" });
    const code2 = r.j.me.gym.studentCode, gym2 = Number(r.j.me.gym.id);
    await an("POST", "/auth/register", { code: r.j.me.gym.coachCode, name: "Anna Coach", email: "anna2@example.com", password: "annapass12" });
    const st = client(base); r = await st("POST", "/auth/register", { code: code2, name: "Tumi Dlamini", email: "tumi@example.com", password: "tumipass12" }); st.id = r.j.me.id;
    const at = (who, title) => classes(who).then((cs) => cs.filter((c) => c.title === title));
    const atLocal = (cs, hhmm) => cs.filter((c) => local(c.startsAt).includes(hhmm));
    const d6 = sjDay(6), d1 = sjDay(-1);
    r = await hc("PUT", "/coach/gym/profile", { profile: { name: "Round Two BJJ", phone: "021 555 0000", timetable: [{ day: dow(d6), start: "18:00", end: "19:00", title: "Fundamentals", coach: "Head Coach" }], rates: [] } });
    ok(r.s === 200 && r.j.classesAdded >= 7, "round two: Fundamentals on the calendar");

    // ---- 1. a save from an old copy of Gym details doesn't take off another coach's weekly class
    const headCopy = (await hc("GET", "/gym")).j.gym.profile;
    r = await an("POST", "/coach/timetable/slot", { title: "Kids BJJ", startsAt: `${d5}T16:00:00+02:00`, durationMin: 45, level: "Beginners" });
    ok(r.s === 201 && r.j.rowNew, "Anna adds a weekly Kids BJJ");
    let kids = future(await at(hc, "Kids BJJ"), "Kids BJJ"); r = await st("PUT", `/classes/${kids[0].id}/rsvp`, { going: true }); ok(r.j.going, "Tumi books one");
    const n1 = kids.length;
    r = await hc("PUT", "/coach/gym/profile", { profile: { ...headCopy, phone: "021 555 1111" }, removed: [], ttBase: headCopy.timetable });
    let tt2 = (await hc("GET", "/gym")).j.gym.profile;
    ok(r.s === 200 && !r.j.held.length && r.j.moved === 0 && tt2.timetable.some((x) => x.title === "Kids BJJ") && tt2.phone === "021 555 1111", "the head coach's phone change keeps Anna's row, and nothing is held: " + JSON.stringify(r.j.held));
    ok(future(await at(hc, "Kids BJJ"), "Kids BJJ").length === n1, "and Anna's classes are all still there");
    // an old copy doesn't undo another coach's change to a row either
    const copy2 = (await hc("GET", "/gym")).j.gym.profile, mine2 = JSON.parse(JSON.stringify(copy2));
    mine2.timetable.find((x) => x.title === "Fundamentals").coach = "Anna Coach";
    r = await an("PUT", "/coach/gym/profile", { profile: mine2, removed: [], ttBase: copy2.timetable });
    r = await hc("PUT", "/coach/gym/profile", { profile: { ...copy2, tagline: "Jiu-jitsu for everyone" }, removed: [], ttBase: copy2.timetable });
    tt2 = (await hc("GET", "/gym")).j.gym.profile;
    ok(tt2.timetable.find((x) => x.title === "Fundamentals").coach === "Anna Coach" && future(await at(hc, "Fundamentals"), "Fundamentals").every((c) => c.coach === "Anna Coach"), "rows the head coach didn't touch keep Anna's newer change");
    // a row this coach removed still goes, even from an older copy
    const kidsRow = tt2.timetable.find((x) => x.title === "Kids BJJ");

    // ---- 2. 'Kids BJJ (Beginners)', as the class form suggests it, is the same class as the row
    r = await hc("POST", "/coach/timetable/slot", { title: "Kids BJJ (Beginners)", startsAt: `${d5}T16:00:00+02:00`, durationMin: 45, level: "Beginners" });
    tt2 = (await hc("GET", "/gym")).j.gym.profile;
    ok(r.s === 201 && !r.j.rowNew && r.j.slot.id === kidsRow.id && tt2.timetable.filter((x) => x.day === dow(d5) && x.start === "16:00").length === 1, "picking the suggested 'Kids BJJ (Beginners)' uses the row there, not a second one");
    let all = await classes(hc);
    ok(atLocal(all.filter((c) => /^Kids BJJ/.test(c.title) && new Date(c.startsAt) > new Date()), "16:00").length === n1 && dupes(all) === 0, "no second Kids class at 16:00 any week");
    // a gym from before this: hand-made 'Name (Level)' classes at a row's time are linked, not doubled
    const d9 = sjDay(9);
    for (const d of [d9, sjDay(16)]) await hc("POST", "/classes", { title: "Teens (Advanced)", startsAt: `${d}T17:00:00+02:00`, durationMin: 60 });
    await pool.query(`update gyms set profile = jsonb_set(profile, '{timetable}', profile->'timetable' || $1::jsonb), timetable_rolled=null where id=$2`,
      [JSON.stringify([{ id: "teens00001", day: dow(d9), start: "17:00", end: "18:00", title: "Teens", level: "Advanced" }]), gym2]);
    await rollAll(pool);
    all = (await classes(hc)).filter((c) => /^Teens/.test(c.title) && new Date(c.startsAt) > new Date());
    ok(all.length === 8 && all.filter((c) => c.title === "Teens (Advanced)").length === 2 && all.every((c) => c.weekly), "the job links 'Teens (Advanced)' to the Teens row instead of adding 'Teens' beside it: " + all.length);

    // ---- 6. a class changed by hand for one week keeps its change when the row is edited
    let fun = future(await at(hc, "Fundamentals"), "Fundamentals");
    const sem = fun[1], sub = fun[2];
    const semAt = new Date(new Date(sem.startsAt).getTime() - 8 * 3600e3).toISOString();
    r = await hc("PUT", `/classes/${sem.id}`, { title: "Seminar with Prof. Silva", startsAt: semAt, durationMin: 180, wasStartsAt: sem.startsAt }); ok(r.s === 200, "the coach makes one week a seminar");
    r = await hc("PUT", `/classes/${sub.id}`, { coach: "Guest Coach" }); ok(r.s === 200, "and puts a substitute coach on another week");
    let pr = (await hc("GET", "/gym")).j.gym.profile, base6 = JSON.parse(JSON.stringify(pr.timetable));
    pr.timetable.find((x) => x.title === "Fundamentals").coach = "Head Coach";
    r = await hc("PUT", "/coach/gym/profile", { profile: pr, removed: [], ttBase: base6 });
    all = await classes(hc);
    let s1 = all.find((c) => c.id === sem.id), s2 = all.find((c) => c.id === sub.id);
    ok(s1.title === "Seminar with Prof. Silva" && s1.durationMin === 180 && s1.startsAt === new Date(semAt).toISOString() && s1.coach === "Head Coach", "the seminar keeps its name, time and length (the coach follows the row): " + JSON.stringify([s1.title, s1.durationMin, s1.coach]));
    ok(s2.coach === "Guest Coach" && future(all, "Fundamentals").filter((c) => c.id !== sub.id).every((c) => c.coach === "Head Coach"), "the substitute coach stays; other weeks get the row's coach");
    pr = (await hc("GET", "/gym")).j.gym.profile; base6 = JSON.parse(JSON.stringify(pr.timetable));
    Object.assign(pr.timetable.find((x) => x.title === "Fundamentals"), { start: "18:30", end: "19:30" });
    r = await hc("PUT", "/coach/gym/profile", { profile: pr, removed: [], ttBase: base6 });
    all = await classes(hc); s1 = all.find((c) => c.id === sem.id);
    ok(s1 && s1.startsAt === new Date(semAt).toISOString() && s1.title === "Seminar with Prof. Silva", "a row time change doesn't move the seminar back");
    ok(atLocal(future(all, "Fundamentals"), "18:30").length === future(all, "Fundamentals").length, "the other weeks move to 18:30: " + r.j.moved);

    // ---- 3. re-importing with the calendar box unticked keeps the classes already there going
    pr = (await hc("GET", "/gym")).j.gym.profile;
    const reimp = pr.timetable.filter((x) => x.title === "Fundamentals").map(({ id, ...x }) => x).concat([{ day: dow(d4), start: "06:00", end: "07:00", title: "Morning drills" }]);
    r = await hc("PUT", "/coach/gym/profile", { profile: { ...pr, timetable: reimp }, calendar: false, removed: [], ttBase: pr.timetable });
    tt2 = (await hc("GET", "/gym")).j.gym.profile.timetable;
    ok(r.s === 200 && !tt2.find((x) => x.title === "Fundamentals").off && !tt2.find((x) => x.title === "Kids BJJ").off && tt2.find((x) => x.title === "Morning drills").off, "unticked: only the new row stays off the calendar");
    await pool.query("delete from classes where gym_id=$1 and starts_at > now() + interval '30 days'", [gym2]);
    await pool.query("update gyms set timetable_rolled=null where id=$1", [gym2]); await rollAll(pool);
    all = await classes(hc);
    ok(future(all, "Fundamentals").length >= 7 && future(all, "Kids BJJ").length >= 7 && !future(all, "Morning drills").length, "the existing classes keep rolling; the new one isn't put on");

    // ---- 9. the website moves a class: a re-import moves it, it doesn't make a second one
    pr = (await hc("GET", "/gym")).j.gym.profile; const fId = pr.timetable.find((x) => x.title === "Fundamentals").id;
    const web = pr.timetable.filter((x) => x.title === "Fundamentals").map(({ id, ...x }) => ({ ...x, start: "19:00", end: "20:00" }));
    r = await hc("PUT", "/coach/gym/profile", { profile: { ...pr, timetable: web }, calendar: true, removed: [], ttBase: pr.timetable });
    tt2 = (await hc("GET", "/gym")).j.gym.profile.timetable;
    all = future(await classes(hc), "Fundamentals");
    ok(tt2.filter((x) => x.title === "Fundamentals").length === 1 && tt2.find((x) => x.title === "Fundamentals").id === fId && tt2.find((x) => x.title === "Fundamentals").start === "19:00", "the moved row keeps its id and gets the new time");
    ok(atLocal(all, "18:30").length === 0 && atLocal(all, "19:00").length === all.length && all.length >= 7, "every Fundamentals moves to 19:00, none left at 18:30: " + all.map((c) => local(c.startsAt)).join(","));

    // ---- 5. putting back a deleted weekly class with the form
    all = future(await classes(hc), "Fundamentals"); const gone = all[2], rows0 = (await hc("GET", "/gym")).j.gym.profile.timetable.length;
    r = await hc("DELETE", `/classes/${gone.id}`, { notify: false }); ok(r.s === 200 && r.j.undo && r.j.undo.slot === fId, "deleting a class nobody booked offers Undo");
    r = await hc("POST", "/coach/timetable/slot", { title: "Fundamentals", startsAt: gone.startsAt, durationMin: 60, plan: { focus: "Guard retention", notes: "", ids: [] } });
    all = future(await classes(hc), "Fundamentals"); const back = all.find((c) => c.startsAt === gone.startsAt);
    ok(r.s === 201 && r.j.added === 1 && !r.j.rowNew && back && back.plan.focus === "Guard retention", "adding it again puts it back, with its lesson plan: " + JSON.stringify(r.j.added));
    ok((await hc("GET", "/gym")).j.gym.profile.timetable.length === rows0 && dupes(all) === 0, "and no second row");
    ok(!(await pool.query("select 1 from class_skips where gym_id=$1 and starts_at=$2", [gym2, gone.startsAt])).rows.length, "it's no longer on the deleted list");
    r = await hc("POST", "/coach/timetable/slot/undo", r.j.undo);
    ok(r.s === 200 && !future(await classes(hc), "Fundamentals").some((c) => c.startsAt === gone.startsAt), "Undo takes it off again");
    await pool.query("update gyms set timetable_rolled=null where id=$1", [gym2]); await rollAll(pool);
    ok(!future(await classes(hc), "Fundamentals").some((c) => c.startsAt === gone.startsAt), "and it stays deleted");
    // Undo on the delete toast
    all = future(await classes(hc), "Fundamentals"); const oops = all[3];
    r = await hc("DELETE", `/classes/${oops.id}`, {}); const u5 = r.j.undo;
    ok(u5 && u5.notice && (await st("GET", "/me/notices")).j.notices.some((n) => n.title === "Cancelled: Fundamentals"), "a deleted class tells the gym");
    r = await hc("POST", "/coach/classes/restore", { class: u5 });
    all = future(await classes(hc), "Fundamentals");
    ok(r.s === 201 && all.some((c) => c.startsAt === oops.startsAt && c.weekly), "Undo puts the class back, still weekly");
    ok(!(await st("GET", "/me/notices")).j.notices.some((n) => n.title === "Cancelled: Fundamentals"), "and the 'cancelled' notice goes");
    await pool.query("update gyms set timetable_rolled=null where id=$1", [gym2]); await rollAll(pool);
    ok(dupes(await classes(hc)) === 0 && future(await classes(hc), "Fundamentals").filter((c) => c.startsAt === oops.startsAt).length === 1, "the job doesn't double it");
    kids = future(await at(hc, "Kids BJJ"), "Kids BJJ"); r = await hc("DELETE", `/classes/${kids[0].id}`, {}); ok(r.s === 200 && !r.j.undo, "no Undo once people were booked and told");

    // ---- 4. a class on a day already gone, left on Every week
    r = await hc("POST", "/coach/timetable/slot", { title: "Open mat", startsAt: `${d1}T18:00:00+02:00`, durationMin: 60 });
    all = await at(hc, "Open mat"); const yday = all.find((c) => new Date(c.startsAt) < new Date());
    ok(r.s === 201 && r.j.rowNew && yday && local(yday.startsAt).includes("18:00"), "yesterday's class is made, so the register can be taken");
    ok(all.length === r.j.added && all.length >= 8, "and the weekly row fills the weeks ahead: " + all.length);
    await pool.query("insert into attendance(class_id,user_id,going) values($1,$2,true)", [all.find((c) => new Date(c.startsAt) > new Date()).id, st.id]);
    r = await hc("POST", "/coach/timetable/slot/undo", r.j.undo);
    all = await at(hc, "Open mat");
    ok(r.s === 200 && all.length === 1 && !all[0].weekly && !(await hc("GET", "/gym")).j.gym.profile.timetable.some((x) => x.title === "Open mat"), "Undo takes the row off with its classes (a booked one stays, as a one-off)");
    r = await st("POST", "/coach/timetable/slot/undo", { slot: "abcd1234", rowNew: true }); ok(r.s === 403, "students can't undo");

    // ---- 7. Book my usual leaves a class they cancelled alone, and Undo cancels what it booked
    await pool.query("delete from attendance where user_id=$1", [st.id]);
    const u1 = await mk("Nogi", h(-6, "19:00")), u2 = await mk("Nogi", h(1, "19:00")), v1 = await mk("Wrestling", h(-5, "19:00")), v2 = await mk("Wrestling", h(2, "19:00"));
    await pool.query("update classes set gym_id=$1 where id = any($2)", [gym2, [u1, u2, v1, v2]]);
    await pool.query("insert into attendance(class_id,user_id,going,attended) values($1,$3,true,true),($2,$3,true,true)", [u1, v1, st.id]);
    await st("PUT", `/classes/${u2}/rsvp`, { going: true }); await st("PUT", `/classes/${u2}/rsvp`, { going: false });
    r = await st("GET", "/classes"); ok(r.j.usual.join() === String(v2), "a class booked then cancelled isn't in 'usual': " + JSON.stringify(r.j.usual));
    r = await st("POST", "/me/book-usual");
    ok(r.j.booked.length === 1 && r.j.booked[0].id === String(v2), "Book my usual doesn't re-book it");
    ok(!(await pool.query("select going from attendance where class_id=$1 and user_id=$2", [u2, st.id])).rows[0].going, "it stays cancelled");

    // ---- 8. monthly prices with 'no joining fee' or 'trial' in the note are plans
    r = await hc("PUT", "/coach/gym/profile", { profile: { ...(await hc("GET", "/gym")).j.gym.profile, rates: [{ name: "Adult unlimited", price: 950, period: "month", note: "No joining fee" },
      { name: "Kids", price: 650, period: "month", note: "First trial class free" }, { name: "Joining fee", price: 300, period: "once" }, { name: "Trial month", price: 400, period: "month" }] }, plans: true });
    ok(r.j.plansAdded === 2, "the two memberships become plans: " + r.j.plansAdded);
    r = await hc("GET", "/coach/plans"); ok(r.j.plans.map((p) => p.name).sort().join() === "Adult unlimited,Kids", "the joining fee and the trial aren't plans: " + r.j.plans.map((p) => p.name).join());
    // a row taken off: a week changed by hand (a grading) stays on as a one-off
    let teens = (await classes(hc)).filter((c) => /^Teens/.test(c.title) && new Date(c.startsAt) > new Date());
    await hc("PUT", `/classes/${teens[3].id}`, { title: "Teens grading" });
    pr = (await hc("GET", "/gym")).j.gym.profile;
    r = await hc("PUT", "/coach/gym/profile", { profile: { ...pr, timetable: pr.timetable.filter((x) => x.id !== "teens00001") }, removed: ["teens00001"], ttBase: pr.timetable });
    teens = (await classes(hc)).filter((c) => /^Teens/.test(c.title) && new Date(c.startsAt) > new Date());
    ok(r.s === 200 && !r.j.held.length && teens.length === 1 && teens[0].title === "Teens grading" && !teens[0].weekly, "removing a row keeps a class changed by hand, as a one-off: " + teens.map((c) => c.title).join());
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e)); }
  srv.kill(); sink.close(); await pool.end();
  console.log(`timetable: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
