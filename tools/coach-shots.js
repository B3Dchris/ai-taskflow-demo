// Screenshots of the coach side for /coaches/, from a made-up gym with two months of history.
// Usage: DATABASE_URL=postgres://.../<something>test node tools/coach-shots.js   (wipes that database)
// Writes web/img/coach/{today,calendar,insights,whatsapp,comps}.jpg
const { chromium, devices } = require("playwright"); const { spawn } = require("child_process"); const path = require("path"); const fs = require("fs"); const { Pool } = require("pg");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
const ROOT = path.resolve(__dirname, ".."), OUT = path.join(ROOT, "web", "img", "coach");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TZ = "Africa/Johannesburg";
// Wall-clock date in Johannesburg (UTC+2, no DST), n days from today.
const sast = (n) => { const d = new Date(Date.now() + 2 * 3600e3 + n * 864e5); return d.toISOString().slice(0, 10); };
const dow = (ymd) => new Date(ymd + "T12:00:00Z").getUTCDay();
const TIMETABLE = [ // day of week, start, minutes, title, level, coach
  [1, "06:00", 60, "Morning No-Gi", "All levels", "Coach Dan"], [1, "18:00", 60, "No-Gi Fundamentals", "Beginners", "Coach Dan"], [1, "19:15", 75, "No-Gi Advanced", "Blue belt +", "Coach Dan"],
  [2, "18:00", 60, "Wrestling for BJJ", "All levels", "Coach Lebo"], [3, "06:00", 60, "Morning No-Gi", "All levels", "Coach Dan"], [3, "18:00", 60, "No-Gi Fundamentals", "Beginners", "Coach Dan"],
  [3, "19:15", 75, "No-Gi Advanced", "Blue belt +", "Coach Dan"], [4, "18:00", 60, "Leg Lock Lab", "Blue belt +", "Coach Lebo"], [5, "12:00", 60, "Lunch Rolls", "All levels", "Coach Lebo"],
  [6, "09:00", 90, "Open Mat", "All levels", "Coach Dan"], [0, "16:00", 90, "Sunday Open Mat", "All levels", "Coach Lebo"],
];
const PEOPLE = [ // name, belt, stripes, plan, how many classes a week they usually come (0 = gone quiet lately)
  ["Thabo Mokoena", "purple", 2, "Unlimited", 4], ["Lerato Dlamini", "blue", 3, "Unlimited", 3], ["Pieter van Wyk", "blue", 1, "2x a week", 2], ["Aisha Patel", "white", 4, "2x a week", 2],
  ["Sipho Ndlovu", "white", 2, "Unlimited", 3], ["Megan Botha", "blue", 0, "2x a week", 2], ["Kyle Naidoo", "white", 1, "Unlimited", 0], ["Zanele Khumalo", "white", 3, "2x a week", 2],
  ["Ruan Steyn", "brown", 1, "Unlimited", 3], ["Naledi Mahlangu", "white", 0, "Drop-in", 1], ["Daniel Smith", "blue", 2, "Unlimited", 0], ["Jessica Pillay", "white", 2, "2x a week", 2],
  ["Bongani Zulu", "purple", 0, "Unlimited", 4], ["Chloe Fourie", "white", 1, "2x a week", 1], ["Tumi Sithole", "white", 0, "Unlimited", 3], ["Liam O'Connor", "blue", 1, "2x a week", 2],
];
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists autopay_charges, autopay, class_skips, plan_breaks, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const port = 9600 + Math.floor(Math.random() * 90), URL = `http://localhost:${port}`;
  const srv = spawn("node", [path.join(ROOT, "server.js")], { env: { ...process.env, PORT: String(port), DATABASE_URL: DB, RESEND_API_KEY: "", ANTHROPIC_API_KEY: "" }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60; i++) { try { await fetch(URL + "/healthz"); break; } catch (e) { await wait(150); } }
  const client = () => { let cookie = ""; return async (method, p, body) => {
    const r = await fetch(URL + "/api" + p, { method, headers: { "content-type": "application/json", "x-jf": "1", cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const j = await r.json().catch(() => ({})); if (r.status >= 400) throw new Error(`${method} ${p}: ${r.status} ${j.error}`); j.cookie = cookie; return j; }; };
  try {
    const coach = client();
    const start = await coach("POST", "/auth/start-gym", { gym: "Southside Grappling", name: "Coach Dan", email: "dan@southside.test", password: "coachpass1", timezone: TZ });
    const code = start.me.gym.studentCode;
    // Two months back, two weeks ahead.
    const list = [];
    for (let n = -56; n <= 14; n++) { const k = sast(n); for (const [d, t, mins, title, level, who] of TIMETABLE) if (dow(k) === d) list.push({ title, startsAt: `${k}T${t}:00+02:00`, durationMin: mins, level, coach: who, capacity: title === "Open Mat" ? null : 24 }); }
    await coach("POST", "/coach/classes/bulk", { classes: list });
    await coach("POST", "/coach/classes/bulk", { classes: [
      { kind: "private", title: "Private lesson", startsAt: `${sast(1)}T17:00:00+02:00`, durationMin: 60, coach: "Coach Dan", priceCents: 45000 },
      { kind: "private", title: "Private lesson", startsAt: `${sast(3)}T07:30:00+02:00`, durationMin: 60, coach: "Coach Lebo", priceCents: 40000 }] });
    const plans = {};
    for (const [name, price, period, cpw] of [["Unlimited", 95000, "month", null], ["2x a week", 65000, "month", 2], ["Drop-in", 15000, "class", null]])
      plans[name] = (await coach("POST", "/coach/plans", { name, priceCents: price, period, classesPerWeek: cpw })).plan.id;
    const students = [];
    for (const [name, belt, stripes, plan, perWeek] of PEOPLE) {
      const s = client(); const email = name.toLowerCase().replace(/[^a-z]+/g, ".") + "@southside.test";
      const me = (await s("POST", "/auth/register", { code, name, email, password: "studentpass1" })).me;
      await coach("PATCH", "/coach/students/" + me.id, { belt, stripes, planId: plans[plan], planStatus: "active", planStarted: sast(-120 + students.length * 5), phone: "08" + String(21234500 + students.length) });
      students.push({ id: me.id, name, perWeek, api: s });
    }
    // The app only lists recent and upcoming classes, so read the history straight from the database.
    const classes = (await pool.query("select id, title, starts_at from classes where kind<>'private' order by starts_at")).rows.map((r) => ({ id: r.id, title: r.title, startsAt: r.starts_at }));
    // Members joined over the last year, not all this week.
    for (const [i, s] of students.entries()) await pool.query("update users set created_at = now() - make_interval(days => $1) where id=$2", [i === 9 ? 4 : 30 + i * 21, s.id]);
    const now = Date.now(); let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    // Past: each student comes about perWeek times a week; the two "0" people stopped three weeks ago.
    for (const c of classes.filter((c) => new Date(c.startsAt) < now)) {
      const daysAgo = (now - new Date(c.startsAt)) / 864e5;
      const ids = students.filter((s) => { const rate = s.perWeek || (daysAgo > 21 ? 3 : 0); return rnd() < rate / 6.5; }).map((s) => s.id);
      if (ids.length) await coach("PUT", `/coach/classes/${c.id}/attendance`, { userIds: ids });
    }
    // Upcoming: bookings for the next week, heavier on the evening classes.
    for (const c of classes.filter((c) => new Date(c.startsAt) > now && new Date(c.startsAt) < now + 8 * 864e5)) {
      const busy = /Fundamentals|Advanced|Open Mat/.test(c.title) ? 0.6 : 0.35;
      for (const s of students) if (s.perWeek && rnd() < busy * s.perWeek / 3) await s.api("PUT", `/classes/${c.id}/rsvp`, { going: true }).catch(() => {});
    }
    // This month's fees: most have paid.
    for (const [i, s] of students.entries()) if (i % 5 !== 2) await coach("POST", "/coach/payments", { userId: s.id, amountCents: PEOPLE[i][3] === "Unlimited" ? 95000 : PEOPLE[i][3] === "Drop-in" ? 15000 : 65000, paidOn: sast(-(i % 6)), reference: "EFT " + s.name.split(" ")[1] });
    const comp = (await coach("POST", "/coach/competitions", { name: "Gauteng No-Gi Open", startsOn: sast(26), venue: "Rand Show Hall 4", city: "Johannesburg", organiser: "SA Grappling League", registerBy: sast(16), fee: "R550 per division", style: "nogi", details: "IBJJF-style rules, heel hooks brown and black only." })).competition;
    for (const [i, div] of [[0, "Adult purple, -82kg"], [1, "Adult blue, -64kg"], [3, "Adult white, -58kg"], [8, "Adult brown, -88kg"], [12, "Adult purple, -94kg"]])
      await coach("PUT", `/coach/competitions/${comp.id}/competitors/${students[i].id}`, { status: "entered", division: div, paid: i % 2 === 0 });
    await students[5].api("POST", `/competitions/${comp.id}/request`, { division: "Adult blue, -70kg", note: "First comp!" }).catch(() => {});

    // ---- screenshots
    fs.mkdirSync(OUT, { recursive: true });
    const b = await chromium.launch();
    const ctx = await b.newContext({ ...devices["iPhone 13"], deviceScaleFactor: 2, colorScheme: "light", timezoneId: TZ });
    await ctx.addCookies([{ name: "jf_s", value: start.cookie.split("=")[1], url: URL }]);
    await ctx.addInitScript(() => { localStorage.setItem("rtb.progress", JSON.stringify({ settings: { onboarded: true } })); localStorage.setItem("jf.coachMode", "manage"); localStorage.setItem("jf.theme", "light"); });
    const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    await p.goto(URL + "/app/#coach-today"); await p.waitForTimeout(2500);
    // no first-visit tips in the pictures
    await p.evaluate(() => { lsSet(tipStore(), Object.fromEntries(Object.keys(TIPS).map((k) => [k, -1]))); render(); });
    const clean = () => p.evaluate(() => { const t = document.getElementById("toast"); if (t) t.hidden = true; document.querySelectorAll(".fab").forEach((f) => f.remove()); });
    const shot = async (name, fn) => { await fn(); await p.waitForTimeout(1200); await clean(); await p.screenshot({ path: path.join(OUT, name + ".jpg"), type: "jpeg", quality: 82 }); };
    const scrollTo = (sel) => p.evaluate((s) => { const e = document.querySelector(s); if (e) window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 12); }, sel);
    await shot("today", async () => { await p.evaluate(() => { location.hash = "#coach-today"; window.scrollTo(0, 0); }); });
    await shot("calendar", async () => { await p.evaluate(() => { location.hash = "#coach-classes"; }); await p.waitForTimeout(900);
      // show the next Monday: the busiest day
      await p.evaluate(() => { let d = new Date(); do d = new Date(d.getTime() + 864e5); while (d.getDay() !== 1); const k = ymd(d); COACH.cal = { mode: "week", sel: k, anchor: k }; render(); window.scrollTo(0, 0); }); });
    await shot("insights", async () => { await p.evaluate(() => { location.hash = "#coach-students"; }); await p.waitForTimeout(800); await p.evaluate(() => { COACH.stuView = "insights"; render(); }); await p.waitForTimeout(1500); await p.evaluate(() => window.scrollTo(0, 0)); });
    await shot("whatsapp", async () => { await p.evaluate(() => { location.hash = "#coach-gym"; }); await p.waitForTimeout(900); await p.evaluate(() => { S.ui.wa = { kind: "week" }; render(); }); await p.waitForTimeout(400); await scrollTo("#wa-panel"); });
    await shot("comps", async () => { await p.evaluate(() => { location.hash = "#coach-comps"; }); await p.waitForTimeout(900); await p.evaluate(() => window.scrollTo(0, 0)); });
    await b.close();
    if (errs.length) console.log("page errors:", errs);
    console.log("coach screenshots written to web/img/coach/");
  } finally { srv.kill(); await pool.end(); }
})().catch((e) => { console.error(e); process.exit(1); });
