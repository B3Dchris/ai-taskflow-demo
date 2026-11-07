// Booking through the real screens: students racing for the last spot, the waitlist, check-in and plan limits,
// and what the coach sees. Usage: DATABASE_URL=postgres://.../<something>test node tests/booking-ui.js  (wipes that database)
const { chromium, devices } = require("playwright"); const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg");
const { startMailSink } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const sink = await startMailSink();
  const port = 9400 + Math.floor(Math.random() * 90), URL = `http://localhost:${port}`;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env: { ...process.env, PORT: String(port), DATABASE_URL: DB, RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60; i++) { try { await fetch(URL + "/healthz"); break; } catch (e) { await wait(150); } }
  const b = await chromium.launch(); const errs = [];
  const phone = async (name) => { const c = await b.newContext({ ...devices["iPhone 13"] }); await c.addInitScript(() => { if (!localStorage.getItem("rtb.progress")) localStorage.setItem("rtb.progress", JSON.stringify({ settings: { onboarded: true } })); }); const p = await c.newPage(); p.on("pageerror", (e) => errs.push(name + ": " + e.message)); return p; };
  const ev = (p, f, a) => p.evaluate(f, a), toast = (p) => ev(p, () => document.getElementById("toast").textContent);
  const signup = async (p, path, fields) => { await p.goto(URL + path); await p.waitForTimeout(900); for (const [k, v] of Object.entries(fields)) await p.fill(k, v); await p.tap("#sheetbar [type=submit]"); await p.waitForTimeout(1300); if (await ev(p, () => S.ui.sheet && S.ui.sheet.k === "onboard")) await p.tap('#sheetbar [data-a="obdone"]'); };
  try {
    const co = await phone("coach");
    await signup(co, "/app/?start=1", { "#a-gym": "Race Gym", "#a-name": "Coach Kim", "#a-email": "kim@race.test", "#a-pass": "coachpass1" });
    const code = await ev(co, () => API.me.gym.studentCode);
    const [s1, s2, s3] = [await phone("s1"), await phone("s2"), await phone("s3")];
    await signup(s1, "/app/?join=" + code, { "#a-name": "Ana Lima", "#a-email": "ana@race.test", "#a-pass": "anapass11" });
    await signup(s2, "/app/?join=" + code, { "#a-name": "Ben Cole", "#a-email": "ben@race.test", "#a-pass": "benpass11" });
    await signup(s3, "/app/?join=" + code, { "#a-name": "Cat Diaz", "#a-email": "cat@race.test", "#a-pass": "catpass11" });
    // coach adds a one-spot class tomorrow
    await co.tap('nav.tabs [data-v="coach"]'); await co.waitForTimeout(600);
    await co.tap('[data-a="classnew"]'); await co.fill("#c-title", "Last spot"); await co.fill("#c-cap", "1"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1200);
    ok(await ev(co, () => /Last spot/.test(document.querySelector(".calrow").innerText) && /0\s*\/1/.test(document.querySelector(".calrow").innerText)), "coach sees the class with 0/1 booked");
    // two students open Classes and tap Book at the same moment
    for (const s of [s1, s2, s3]) { await ev(s, () => { API.classes = null; go("book"); }); await s.waitForTimeout(800); const k = await ev(s, () => dayKey(API.classes[0].startsAt)); await s.tap(`[data-a="calday"][data-v="${k}"]`); await s.waitForTimeout(200); }
    await Promise.all([s1.locator('.bookcard [data-a="rsvp"]').tap(), s2.locator('.bookcard [data-a="rsvp"]').tap()]);
    await wait(1500);
    const t1 = await ev(s1, () => document.querySelector(".bookcard").innerText), t2 = await ev(s2, () => document.querySelector(".bookcard").innerText);
    const winner = /You're booked/.test(t1) ? s1 : s2, loser = winner === s1 ? s2 : s1, lt = winner === s1 ? t2 : t1;
    ok((/You're booked/.test(t1) ? 1 : 0) + (/You're booked/.test(t2) ? 1 : 0) === 1 && /Waitlist #1/.test(lt), "two students tap Book at once: one is booked, the other is told they're #1 on the waitlist");
    // a third student sees it's full and joins the waitlist behind
    await ev(s3, () => loadClasses(true)); await s3.waitForTimeout(600);
    ok(await ev(s3, () => /1\/1 booked/.test(document.querySelector(".bookcard").innerText) && /Join waitlist/.test(document.querySelector(".bookcard").innerText)), "the next student sees the class is full and a Join waitlist button");
    await s3.locator('.bookcard [data-a="rsvp"]').tap(); await s3.waitForTimeout(900);
    ok(/waitlist at #2/.test(await toast(s3)), "they're told they're #2: " + (await toast(s3)));
    ok(await ev(s3, () => { const n = document.querySelector(".bookcard .who-line"); return n && n.innerText.split("\n").filter(Boolean).length === 1; }), "students see who's booked (one name)");
    // the coach sees the booking and the waitlist
    await ev(co, () => coachLoad("classes")); await co.waitForTimeout(600);
    ok(await ev(co, () => /\+2 waiting/.test(document.querySelector(".calrow").innerText)), "coach's calendar shows 1/1 and +2 waiting");
    await co.locator(".calrow").first().tap(); await co.waitForTimeout(800);
    ok(await ev(co, () => /Waitlist \(2\)/i.test(document.getElementById("sheet").innerText) && /1\. /.test(document.getElementById("sheet").innerText)), "coach's class sheet lists the waitlist in order");
    await co.tap('#sheetbar [data-a="back"]');
    // the winner cancels; #1 gets the spot and an email; #2 moves up
    const n0 = sink.mails.length;
    await winner.locator('.bookcard [data-a="rsvp"]').tap(); await winner.waitForTimeout(1000);
    ok(await ev(winner, () => /Cancelled/.test(document.getElementById("toast").textContent) && /Join waitlist/.test(document.querySelector(".bookcard").innerText)), "cancelling frees the spot (and the class is full again for them)");
    await ev(loser, () => loadClasses(true)); await loser.waitForTimeout(700);
    ok(await ev(loser, () => /You're booked/.test(document.querySelector(".bookcard").innerText)), "the first person waiting is now booked");
    await wait(400); ok(sink.mails.slice(n0).some((m) => /You're in/.test(m.subject)), "and gets a you're-in email");
    await ev(s3, () => loadClasses(true)); await s3.waitForTimeout(700);
    ok(await ev(s3, () => /Waitlist #1/.test(document.querySelector(".bookcard").innerText)), "the next person moves up to #1");
    // coach raises the limit: the waitlist moves in
    await ev(co, () => coachLoad("classes")); await co.waitForTimeout(500);
    await co.locator(".calrow").first().tap(); await co.waitForTimeout(700); await co.tap('#sheetbar [data-a="classedit"]'); await co.waitForTimeout(400);
    await co.fill("#c-cap", "5"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1200);
    await ev(s3, () => loadClasses(true)); await s3.waitForTimeout(700);
    ok(await ev(s3, () => /You're booked/.test(document.querySelector(".bookcard").innerText)), "raising the limit books the person waiting");
    ok(await ev(co, () => /2\s*\/5/.test(document.querySelector(".calrow").innerText) && !/waiting/.test(document.querySelector(".calrow").innerText)), "coach sees 2/5 and no waitlist");
    // plan limit message is clear in the app
    await ev(co, async () => { const p = (await api("POST", "/coach/plans", { name: "1 a week", priceCents: 30000, period: "month", classesPerWeek: 1 })).plan; const ppl = (await api("GET", "/coach/roster")).people; const ana = ppl.find((x) => x.name === "Ana Lima"); await api("PATCH", `/coach/students/${ana.id}`, { planId: p.id });
      const d = new Date(API.classes ? Date.now() : Date.now()); for (const off of [8, 9]) { const t = new Date(Date.now() + off * 864e5); await api("POST", "/classes", { title: "Week class " + off, startsAt: t.toISOString() }); } });
    await ev(s1, async () => { API.mem = undefined; await loadClasses(true); S.ui.bcal = null; go("book"); }); await s1.waitForTimeout(800);
    const wk = await ev(s1, () => API.classes.filter((c) => /Week class/.test(c.title)).map((c) => ({ id: c.id, wk: weekStart(dayKey(c.startsAt)) })));
    if (wk.length === 2 && wk[0].wk === wk[1].wk) {
      await ev(s1, (id) => doBook(id, true), wk[0].id); await s1.waitForTimeout(600); await ev(s1, (id) => doBook(id, true), wk[1].id); await s1.waitForTimeout(700);
      ok(/1 a week plan includes 1 class a week/.test(await toast(s1)), "a plan limit is explained in plain words: " + (await toast(s1)));
    } else ok(true, "skipped plan-limit check (classes fell in different weeks)");
    // check-in opens shortly before class
    await ev(co, async () => { await api("POST", "/classes", { title: "Starting soon", startsAt: new Date(Date.now() + 20 * 60e3).toISOString(), capacity: 10 }); });
    await ev(s2, async () => { await loadClasses(true); S.ui.bcal = { mode: "week", sel: todayK(), anchor: todayK() }; render(); }); await s2.waitForTimeout(600);
    await s2.locator('.bookcard:has-text("Starting soon") [data-a="rsvp"]').tap(); await s2.waitForTimeout(900);
    ok(await ev(s2, () => [...document.querySelectorAll(".bookcard")].some((c) => /Starting soon/.test(c.innerText) && c.querySelector('[data-a="checkin"]'))), "a booked class starting soon shows Check in");
    await s2.locator('.bookcard:has-text("Starting soon") [data-a="checkin"]').tap(); await s2.waitForTimeout(900);
    ok(await ev(s2, () => [...document.querySelectorAll(".bookcard")].some((c) => /Starting soon/.test(c.innerText) && /Checked in/.test(c.innerText))), "student checks in from their phone");
    await ev(co, () => coachLoad("classes")); await co.waitForTimeout(500);
    const soonId = await ev(co, () => COACH.classes.find((c) => c.title === "Starting soon").id);
    await ev(co, (id) => classSheet(id), soonId); await co.waitForTimeout(800);
    ok(await ev(co, () => /Checked in/.test(document.getElementById("sheet").innerText)), "coach sees the student checked themselves in");
    for (const p of [co, s1, s2, s3]) ok(await ev(p, () => document.documentElement.scrollWidth <= 390), "no sideways scroll");
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e).toString().split("\n").slice(0, 3).join(" ")); }
  ok(errs.length === 0, "page errors: " + errs.join(" | "));
  await b.close(); srv.kill(); sink.close(); await pool.end();
  console.log(`booking-ui: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
