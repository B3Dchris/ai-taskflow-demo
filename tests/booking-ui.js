// Booking through the real screens: students racing for the last spot, the waitlist, check-in and plan limits,
// and what the coach sees. Usage: DATABASE_URL=postgres://.../<something>test node tests/booking-ui.js  (wipes that database)
const { chromium, devices } = require("playwright"); const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg");
const { startMailSink, startGymSite } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const sink = await startMailSink(), site = await startGymSite();
  const port = 9400 + Math.floor(Math.random() * 90), URL = `http://localhost:${port}`;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env: { ...process.env, PORT: String(port), DATABASE_URL: DB, RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, JF_IMPORT_ALLOW_LOOPBACK: "1", ANTHROPIC_API_KEY: "" }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60; i++) { try { await fetch(URL + "/healthz"); break; } catch (e) { await wait(150); } }
  const b = await chromium.launch(); const errs = [];
  const phone = async (name) => { const c = await b.newContext({ ...devices["iPhone 13"] }); await c.addInitScript(() => { if (!localStorage.getItem("rtb.progress")) localStorage.setItem("rtb.progress", JSON.stringify({ settings: { onboarded: true } })); }); const p = await c.newPage(); p.on("pageerror", (e) => errs.push(name + ": " + e.message)); return p; };
  const ev = (p, f, a) => p.evaluate(f, a), toast = (p) => ev(p, () => document.getElementById("toast").textContent);
  const signup = async (p, path, fields) => { await p.goto(URL + path); await p.waitForTimeout(900); for (const [k, v] of Object.entries(fields)) await p.fill(k, v); await p.tap("#sheetbar [type=submit]"); await p.waitForTimeout(1300); if (await ev(p, () => S.ui.sheet && S.ui.sheet.k === "onboard")) await p.tap('#sheetbar [data-a="obdone"]'); if (await ev(p, () => S.ui.sheet && S.ui.sheet.k === "welcome")) { await p.tap('#sheetbar [data-a="back"]'); await p.waitForTimeout(200); } };
  try {
    const co = await phone("coach");
    await signup(co, "/app/?start=1", { "#a-gym": "Race Gym", "#a-name": "Coach Kim", "#a-email": "kim@race.test", "#a-pass": "coachpass1" });
    const code = await ev(co, () => API.me.gym.studentCode);
    const [s1, s2, s3] = [await phone("s1"), await phone("s2"), await phone("s3")];
    await signup(s1, "/app/?join=" + code, { "#a-name": "Ana Lima", "#a-email": "ana@race.test", "#a-pass": "anapass11" });
    await signup(s2, "/app/?join=" + code, { "#a-name": "Ben Cole", "#a-email": "ben@race.test", "#a-pass": "benpass11" });
    await signup(s3, "/app/?join=" + code, { "#a-name": "Cat Diaz", "#a-email": "cat@race.test", "#a-pass": "catpass11" });
    // coach adds a one-spot class tomorrow
    await co.tap('nav.tabs [data-v="coach-classes"]'); await co.waitForTimeout(600);
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
    // ---- competitions: coach imports an event, a student asks in, the coach enters them
    await ev(co, () => hideSheet()); await co.tap('nav.tabs [data-v="coach-comps"]'); await co.waitForTimeout(500);
    await co.fill("#ci-url", site.url + "/events/gauteng-open"); await co.tap("#compimpform [type=submit]"); await co.waitForSelector("#compform", { timeout: 15000 });
    ok(await ev(co, () => document.getElementById("cp-name").value === "Gauteng Open No-Gi 2026" && document.getElementById("cp-start").value === "2026-12-12" && document.getElementById("cp-reg").value === "2026-12-05" && /date was found/.test(document.getElementById("sheet").innerText)), "coach pastes an event link and the form fills in");
    await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1200);
    ok(await ev(co, () => S.ui.sheet && S.ui.sheet.k === "comp" && /Gauteng Open/.test(document.getElementById("sheet").innerText) && /Nobody entered yet/.test(document.getElementById("sheet").innerText)), "saved competition opens with an empty team");
    await ev(s3, async () => { hideSheet(); API.comps = null; S.ui.bookView = "comps"; go("book"); }); await s3.waitForTimeout(900);
    ok(await ev(s3, () => /Gauteng Open/.test(document.querySelector(".compcard").innerText) && /Registration/.test(document.querySelector(".compcard").innerText)), "student sees it under Classes › Comps");
    await s3.locator(".compcard").first().tap(); await s3.waitForTimeout(500); await s3.tap('[data-a="compreq"]'); await s3.waitForTimeout(300);
    await s3.fill('#compreqform [name="division"]', "Adult blue belt -76kg"); await s3.fill('#compreqform [name="weight"]', "74"); await s3.tap("#sheetbar [type=submit]"); await s3.waitForTimeout(1200);
    ok(await ev(s3, () => /Asked to enter/.test(document.getElementById("sheet").innerText)), "student asks to compete");
    await ev(co, async () => { await loadComps(true); }); await co.waitForTimeout(400);
    await ev(co, () => { hideSheet(); COACH.rosterAt = 0; render(); }); await co.locator(".compcard").first().tap(); await co.waitForTimeout(1200);
    ok(await ev(co, () => /Asking to enter \(1\)/i.test(document.getElementById("sheet").innerText) && /Cat Diaz/.test(document.getElementById("sheet").innerText)), "coach sees the request");
    await co.tap('[data-a="compyes"]'); await co.waitForTimeout(1200);
    ok(await ev(co, () => /The team \(1\)/i.test(document.getElementById("sheet").innerText)), "coach enters the student; the team shows 1");
    await co.selectOption("#comp-add", { label: "Ana Lima" }); await co.tap('[data-a="compadd"]'); await co.waitForTimeout(1200);
    ok(await ev(co, () => /The team \(2\)/i.test(document.getElementById("sheet").innerText)), "coach adds another student straight onto the team");
    await ev(s3, async () => { await loadComps(true); hideSheet(); go("book"); }); await s3.waitForTimeout(700);
    ok(await ev(s3, () => /On the team/.test(document.querySelector(".compcard").innerText) && document.querySelectorAll(".compcard .whochip").length === 2), "student sees they're on the team with their teammate");
    await ev(s3, () => go("today")); await s3.waitForTimeout(500);
    ok(await ev(s3, () => /Competing/i.test(document.getElementById("app").innerText) && /Gauteng Open/.test(document.getElementById("app").innerText)), "Today shows the upcoming competition");
    await wait(300); ok(sink.mails.some((m) => /Cat Diaz wants to compete/.test(m.subject)) && sink.mails.some((m) => m.to[0] === "cat@race.test" && /on the team/.test(m.subject)), "request and decision emails go out");
    // ---- WhatsApp
    const waText = (href) => { const u = new globalThis.URL(href); return { num: u.pathname.slice(1), text: u.searchParams.get("text") || "" }; };
    await ev(co, () => { hideSheet(); }); await co.tap('nav.tabs [data-v="coach-gym"]'); await co.waitForTimeout(500);
    let w = waText(await ev(co, () => document.getElementById("wa-go").href));
    ok(/\/app\/\?join=[A-Z0-9]{8}/.test(w.text), "WhatsApp: the invite message carries the join link: " + w.text.slice(0, 80));
    await co.tap('[data-a="wakind"][data-v="week"]'); await co.waitForTimeout(400);
    w = waText(await ev(co, () => document.getElementById("wa-go").href));
    ok(/classes this week/.test(w.text) && /Starting soon/.test(w.text) && /spots? left|full/.test(w.text) && /#book/.test(w.text), "WhatsApp: this week's classes, with spots left and a booking link");
    await co.fill("#wa-text", "Edited message 123"); w = waText(await ev(co, () => document.getElementById("wa-go").href));
    ok(w.text === "Edited message 123", "WhatsApp: editing the message changes what gets sent");
    await co.tap('[data-a="wakind"][data-v="comp"]'); await co.waitForTimeout(400);
    w = waText(await ev(co, () => document.getElementById("wa-go").href));
    ok(/Gauteng Open/.test(w.text) && /Our team \(2\)/.test(w.text), "WhatsApp: a competition with the team list");
    ok(await ev(co, () => /coach access/.test(WA_T.coach()) && /join=/.test(WA_T.coach())), "WhatsApp: invite-a-coach message warns it gives coach access");
    await co.tap('nav.tabs [data-v="coach-today"]'); await co.waitForTimeout(500);
    ok(await ev(co, () => [...document.querySelectorAll('.quick a[data-wa]')].length === 2), "Today has WhatsApp quick actions");
    // a student's number becomes a direct chat link
    await ev(s1, async () => { hideSheet(); go("settings"); }); await s1.waitForTimeout(400);
    await s1.fill("#a-phone", "082 123 4567"); await s1.tap('#phoneform [type=submit]'); await s1.waitForTimeout(700);
    ok(/WhatsApp number saved/.test(await toast(s1)), "student saves their WhatsApp number");
    const anaId = await ev(co, async () => { await coachLoad("roster"); return students().find((p) => p.name === "Ana Lima").id; });
    await ev(co, (id) => studentSheet(id), anaId); await co.waitForTimeout(800);
    w = waText(await ev(co, () => document.querySelector('#sheet a[data-wa="student"]').href));
    ok(w.num === "27821234567" && w.text === "Hi Ana, ", "coach's Message button opens Ana's own chat (082… becomes 27 82…)");
    // student sharing
    await ev(s1, () => { API.me = null; }); await ev(s1, async () => { const j = await api("GET", "/me"); API.me = j.me; render(); }); await s1.waitForTimeout(400);
    w = waText(await ev(s1, () => document.querySelector('a[data-wa="invite_friend"]').href));
    ok(/Come train with me at Race Gym/.test(w.text) && /join=[A-Z0-9]{8}/.test(w.text), "student invites a friend to the gym on WhatsApp");
    const tid = await ev(s1, () => TECH.find((t) => t.id === "kimura_sc").id); await ev(s1, (id) => techSheet(id), tid); await s1.waitForTimeout(400);
    w = waText(await ev(s1, () => document.querySelector('#sheet a[data-wa="technique"]').href));
    const pageUrl = w.text.match(/https:\/\/www\.jitsflow\.com(\/techniques\/[^\s]+)/);
    ok(pageUrl && (await fetch(URL + pageUrl[1])).status === 200, "technique share links to its real public page: " + (pageUrl && pageUrl[1]));
    // --- fees: coach adds bank details, student pays by EFT and sends proof, coach confirms
    for (const p of [s1, co]) if (await ev(p, () => !!S.ui.sheet)) await ev(p, () => hideSheet());
    await ev(co, () => { COACH.moneyView = "setup"; coachGo("money"); }); await co.waitForTimeout(1200);
    ok(await ev(co, () => document.querySelector('details[data-g="m-bank"]').open && !!document.getElementById("bankform")), "Money: bank details form is open until they're filled in");
    await co.fill('#bankform [name="bank"]', "FNB"); await co.fill('#bankform [name="account"]', "62123456789"); await co.fill('#bankform [name="branch"]', "250655");
    await co.tap('#bankform [type=submit]'); await co.waitForTimeout(800);
    ok(/Payment details saved/.test(await toast(co)) && await ev(co, () => /FNB · 62123456789/.test(document.querySelector('details[data-g="m-bank"] summary').innerText)), "coach saves bank details");
    ok(await ev(co, () => /^pop-[a-z0-9]{10}@jitsflow\.com$/.test(document.getElementById("pop-addr").value)), "Money shows the gym's forwarding address");
    await ev(s1, () => { API.pay = undefined; go("book"); }); await s1.waitForTimeout(1200);
    const ref = await ev(s1, () => API.pay && API.pay.reference);
    ok(/^JF[A-Z2-9]{5}$/.test(ref) && await ev(s1, (r) => !!document.querySelector(".feecard") && document.querySelector(".feecard").innerText.includes(r), ref), "student's Classes tab shows a fees card with their reference");
    await s1.tap('[data-a="mypay"]'); await s1.waitForTimeout(400);
    ok(await ev(s1, (r) => { const t = document.getElementById("sheet").innerText; return /62123456789/.test(t) && /250655/.test(t) && t.includes(r) && !!document.querySelector('#sheet [data-a="copy"][data-v="62123456789"]'); }, ref), "pay sheet: bank details, copy buttons and the reference");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    await s1.fill("#mypop-amt", "650"); await s1.setInputFiles("#mypop", { name: "pop.png", mimeType: "image/png", buffer: png }); await s1.waitForTimeout(1500);
    ok(/Sent/.test(await toast(s1)) && await ev(s1, () => /Checking/.test(document.getElementById("sheet").innerText)), "student sends a screenshot as proof; it shows as Checking");
    await ev(co, () => { COACH.moneyView = "payments"; return coachLoad(); }); await co.waitForTimeout(1000);
    ok(await ev(co, () => /To check \(1\)/i.test(document.getElementById("app").innerText) && /Ana Lima/.test(document.querySelector(".popcard").innerText) && /R\s?650/.test(document.querySelector(".popcard").innerText)), "coach sees it under To check, from Ana, R650");
    ok(await ev(co, () => !!document.querySelector('.popcard a[href*="/proof"]')), "coach can open the proof");
    await co.tap('.popcard [data-a="popok"]'); await co.waitForTimeout(1000);
    ok(/Payment confirmed/.test(await toast(co)) && await ev(co, () => !/To check/i.test(document.getElementById("app").innerText) && /Ana Lima/.test([...document.querySelectorAll(".sess")].map((x) => x.innerText).join(" "))), "coach confirms it: it moves to recent payments");
    await ev(s1, () => loadPay().then(myPaySheet)); await s1.waitForTimeout(800);
    ok(await ev(s1, () => /Received/.test(document.getElementById("sheet").innerText)), "student sees it was received");
    await ev(s1, () => hideSheet());
    await co.tap('[data-a="paynew"]'); await co.waitForTimeout(300);
    ok(await ev(co, () => [...document.querySelectorAll("#p-method option")].map((o) => o.value).join(",") === "eft,cash,card,snapscan,other"), "recording a payment asks how it was paid");
    await ev(co, () => hideSheet());
    // --- "Want a different time?" goes to the coach on WhatsApp with the request written out
    await ev(s1, () => { S.ui.bookView = "private"; go("book"); }); await s1.waitForTimeout(600);
    w = waText(await ev(s1, () => document.querySelector('a[data-wa="private_ask"]').href));
    ok(w.num === "" && /Could I book a private lesson\?/.test(w.text) && /Day: \nTime: /.test(w.text) && /it's Ana from Race Gym/.test(w.text), "no number set yet: the request opens WhatsApp to pick the coach, with the message written");
    await ev(co, () => coachGo("gym")); await co.waitForTimeout(600);
    await co.fill("#g-wa", "082 555 1234"); await co.tap("#gwaform [type=submit]"); await co.waitForTimeout(700);
    ok(/Lesson requests come to this number/.test(await toast(co)), "coach saves the WhatsApp number for lesson requests");
    await ev(s1, async () => { API.me = (await api("GET", "/me")).me; render(); }); await s1.waitForTimeout(600);
    w = waText(await ev(s1, () => document.querySelector('a[data-wa="private_ask"]').href));
    ok(w.num === "27825551234" && /Day: /.test(w.text), "then the request goes straight to the coach's WhatsApp");
    await co.fill("#g-wa", "hello"); await co.tap("#gwaform [type=submit]"); await co.waitForTimeout(600);
    ok(/doesn't look like a phone number/.test(await toast(co)), "a non-number is refused");
    // --- Money: this month / payments / setup
    for (const p of [co, s1, s2]) if (await ev(p, () => !!S.ui.sheet)) await ev(p, () => hideSheet());
    await ev(co, () => api("PATCH", "/coach/gym", { monthlyFeeCents: 50000 })); await ev(co, () => coachLoad()); await ev(co, () => { COACH.moneyView = "month"; coachGo("money"); }); await co.waitForTimeout(1500);
    ok(await ev(co, () => document.querySelectorAll(".mchart .mcol").length === 6 && /Collected/i.test(document.querySelector(".stats").innerText) && /Outstanding/i.test(document.querySelector(".stats").innerText)), "Money › This month: totals and six months of history");
    ok(await ev(co, () => { const t = document.getElementById("app").innerText; return /Ben Cole/.test(t) && /Cat Diaz/.test(t) && /(Due|Overdue)/i.test(t) && !/Ana Lima/.test(t); }), "the owing list shows who still owes (Ana has paid)");
    await co.tap('[data-a="moneyfilter"][data-v="paid"]'); await co.waitForTimeout(200); ok(await ev(co, () => /Ana Lima/.test(document.getElementById("app").innerText)), "filter: paid");
    await co.tap('[data-a="moneymonth"][data-v="-1"]'); await co.waitForTimeout(1200); ok(await ev(co, () => COACH.money.month < todayK().slice(0, 7)), "step back a month");
    await co.tap('[data-a="moneymonth"][data-v="1"]'); await co.waitForTimeout(1200);
    await co.tap('[data-a="moneyview"][data-v="setup"]'); await co.waitForTimeout(300); ok(await ev(co, () => !!document.querySelector('#bankform [name="dueDay"]') && !!document.getElementById("pop-addr")), "Setup: bank details with the due date, and the forwarding address");
    await co.tap('[data-a="moneyview"][data-v="payments"]'); await co.waitForTimeout(300); ok(await ev(co, () => !!document.querySelector('label[for="pop-up"]') && !!document.querySelector('[data-a="paynew"]')), "Payments: upload proof and record a payment");
    await ev(co, () => { COACH.moneyView = "month"; render(); });
    // --- a student who isn't on the app
    await ev(co, () => coachGo("students")); await co.waitForTimeout(500); await co.tap('[data-a="addstu"]'); await co.waitForTimeout(300);
    await co.fill('#addstuform [name="name"]', "Nomsa Dube"); await co.fill('#addstuform [name="phone"]', "082 444 1111"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1800);
    const inv = await ev(co, () => { const a = document.querySelector('#sheet a[data-wa="claim_invite"]'); return a && a.href; });
    ok(await ev(co, () => /Not on the app/.test(document.getElementById("sheet").innerText)) && inv && /27824441111/.test(inv) && /claim%3D|claim=/.test(decodeURIComponent(inv)), "coach adds Nomsa by WhatsApp number; her sheet has a personal invite on WhatsApp");
    await ev(co, () => hideSheet()); await co.waitForTimeout(200);
    ok(await ev(co, () => /Nomsa Dube/.test(document.getElementById("roster-list").innerText) && /Not on app/.test(document.getElementById("roster-list").innerText)), "she's on the roster, tagged Not on app");
    // --- notices: a cancelled class reaches every student
    const cid = await ev(co, async () => { const d = new Date(Date.now() + 2 * 864e5); d.setHours(18, 0, 0, 0); return (await api("POST", "/classes", { title: "Cancel me", startsAt: d.toISOString(), durationMin: 60 })).class.id; });
    await ev(s2, (id) => api("PUT", `/classes/${id}/rsvp`, { going: true }), cid);
    await ev(co, (id) => api("DELETE", `/classes/${id}`), cid);
    await ev(s3, () => { API.notices = undefined; go("book"); }); await s3.waitForTimeout(1200);
    ok(await ev(s3, () => { const n = document.querySelector(".notices"); return n && /Cancelled: Cancel me/.test(n.innerText); }), "every student sees the cancellation under Gym updates (even if they hadn't booked)");
    // --- thumbnails: Rate what you know and the flow map
    await ev(s1, () => { S.ui.qr = { q: ["kimura_sc"], i: 0 }; qrSheet(); }); await s1.waitForTimeout(300);
    ok(await ev(s1, () => !!document.querySelector('#sheet .ytembed iframe[src*="youtube-nocookie.com/embed/"]')), "Rate what you know shows the move's own video thumbnail");
    ok(await ev(s1, () => { const was = JFI.tech; JFI.tech = ["kimura_sc"]; qrSheet(); const src = (document.querySelector("#sheet .revealcard img") || {}).getAttribute?.("src"); const th = techThumb(TM.kimura_sc); JFI.tech = was; qrSheet(); return src === "/img/techniques/kimura_sc.jpg" && /img\/techniques\/kimura_sc/.test(th); }), "a move's own photo, once added, replaces its video thumbnail in Rate what you know and the lists");
    await ev(s1, () => { hideSheet(); S.ui.flowSel = "cg_bot"; go("flow"); }); await s1.waitForTimeout(500);
    ok(await ev(s1, () => document.querySelectorAll(".fsk .fmv .thumb img").length > 0), "flow map moves have their thumbnails back");
    await ev(s1, () => go("book"));
    // --- training log fills itself in from classes attended
    for (const p of [co, s1]) if (await ev(p, () => !!S.ui.sheet)) await ev(p, () => hideSheet());
    const logUid = await ev(s1, () => API.me.id);
    const pastId = await ev(co, async () => { const d = new Date(Date.now() - 3 * 3600e3); return (await api("POST", "/classes", { title: "No-gi: half guard", startsAt: d.toISOString(), durationMin: 60, plan: { focus: "Half guard bottom", ids: ["hg_frames", "knee_cut"] } })).class.id; });
    await ev(co, ([id, uid]) => api("PUT", `/coach/classes/${id}/attendance`, { userIds: [uid] }), [pastId, logUid]);
    await ev(s1, async () => { P().mastery = {}; P().srs = {}; API.autoLogAt = 0; await autoLog(true); go("log"); }); await s1.waitForTimeout(600);
    ok(await ev(s1, (cid) => { const s = S.sessions.find((x) => x.classId === cid); const t = document.getElementById("app").innerText; return s && s.auto && s.mins === 60 && s.taught.join() === "hg_frames,knee_cut" && /No-gi: half guard/.test(t) && /Booked/.test(t) && /Taught:/.test(t); }, pastId), "a class you went to logs itself, with what was taught");
    ok(await ev(s1, () => lv("hg_frames") >= 1 && !!P().srs.hg_frames && !!P().srs.knee_cut), "what was taught goes straight into your reviews");
    await ev(s1, () => go("today")); await s1.waitForTimeout(300);
    ok(await ev(s1, () => /How did it go\?/i.test(document.getElementById("app").innerText)), "Today asks how the class went");
    await s1.locator('.qtags [data-a="tag"][data-k="hits"]').first().tap(); await s1.waitForTimeout(300);
    ok(await ev(s1, () => /What worked\?/.test(document.getElementById("sheet").innerText) && /Taught in this class/i.test(document.getElementById("sheet").innerText)), "What worked opens with the moves taught in that class first");
    await s1.locator('#sheet [data-a="tagset"][data-v="knee_cut"]').first().tap(); await s1.waitForTimeout(400);
    ok(await ev(s1, (cid) => S.sessions.find((x) => x.classId === cid).hits.includes("knee_cut") && lv("knee_cut") === 4 && document.querySelector('#sheet [data-v="knee_cut"]').getAttribute("aria-pressed") === "true", pastId), "one tap saves it and moves the move up to Live");
    await s1.tap('#sheetbar [data-a="back"]'); await s1.waitForTimeout(200);
    await ev(s1, () => go("log")); await s1.locator('.qtags [data-a="tag"][data-k="tapped"]').first().tap(); await s1.waitForTimeout(300);
    await s1.fill("#tag-q", "rear"); await s1.waitForTimeout(200);
    ok(await ev(s1, () => [...document.querySelectorAll("#tag-list [data-a=tagset]")].every((b) => /rear/i.test(b.innerText + TM[b.dataset.v].n + POS[TM[b.dataset.v].f].l)) && !!document.querySelector('#tag-list [data-v="rnc"]')), "search finds the submission");
    await s1.locator('#tag-list [data-v="rnc"]').tap(); await s1.waitForTimeout(300); await s1.tap('#sheetbar [data-a="back"]'); await s1.waitForTimeout(300);
    ok(await ev(s1, () => { const d = defFor("rnc"); return d && P().srs[d.id] && P().srs[d.id].due <= today() && /got you/i.test(document.querySelector(".nextsteps").innerText); }), "what got you puts its defense in your reviews, and What to work on next says so");
    ok(await ev(s1, () => /Tapped: Rear-naked choke|Tapped: Rear naked/i.test(document.getElementById("app").innerText) && /✓ Knee/i.test(document.getElementById("app").innerText)), "the session shows what worked and what got you");
    await s1.locator('.lcard [data-a="del"]').first().tap(); await s1.waitForTimeout(400);
    await ev(s1, async () => { API.autoLogAt = 0; await autoLog(true); }); await s1.waitForTimeout(300);
    ok(await ev(s1, (cid) => !S.sessions.some((x) => x.classId === cid) && (P().logSkip || []).includes(cid), pastId), "a class log you delete isn't added back");
    // --- Previous / Next on review cards and Rate what you know
    await ev(s1, () => { ["hip_bump", "triangle", "kimura_cg"].forEach((id) => { if (TM[id]) ensureCard(id); }); S.ui.review = { q: ["hip_bump", "triangle"].filter((id) => TM[id]), i: 0, shown: false }; reviewSheet(); });
    ok(await ev(s1, () => document.querySelector('#sheetbar [data-a="revprev"]').disabled && !!document.querySelector('#sheetbar [data-a="revnext"]')), "review: Previous is off on the first card, Next is there");
    await s1.tap('#sheetbar [data-a="revnext"]'); ok(await ev(s1, () => S.ui.review.i === 1 && /Review 2 of 2/.test(document.getElementById("sheet").innerText)), "Next skips to the next card");
    await s1.tap('#sheetbar [data-a="revprev"]'); ok(await ev(s1, () => S.ui.review.i === 0), "Previous goes back");
    await ev(s1, () => { S.ui.review = null; S.ui.qr = { q: ["hip_bump", "triangle"], i: 0 }; qrSheet(); });
    await s1.tap('#sheetbar [data-a="qrset"][data-v="2"]'); await s1.tap('#sheetbar [data-a="qrprev"]');
    ok(await ev(s1, () => S.ui.qr.i === 0 && document.querySelector('#sheetbar [data-a="qrset"][data-v="2"]').getAttribute("aria-pressed") === "true"), "Rate what you know: Previous goes back and shows what you picked");
    await ev(s1, () => { S.ui.qr = null; hideSheet(); go("book"); });
    // --- the assistant is switched off: no ✦ button for coaches
    for (const p of [co, s1]) if (await ev(p, () => !!S.ui.sheet)) await ev(p, () => hideSheet());
    await ev(co, () => coachGo("today")); await co.waitForTimeout(300);
    ok(await ev(co, () => !document.querySelector(".fab.ask") && !document.querySelector('[data-a="ast"]')), "no assistant button while it's switched off");
    // --- add several students: a WhatsApp group screenshot first, then contacts or typed names
    await ev(co, () => coachGo("students")); await co.waitForTimeout(400); await co.tap('[data-a="addstu"]'); await co.tap('[data-a="bulkopen"]'); await co.waitForTimeout(200);
    ok(await ev(co, () => { const t = document.getElementById("sheet").innerText; return /Screenshot of your WhatsApp group/.test(document.querySelector('label[for="ppl-in"]').innerText) && !/\.vcf|\.csv|vcard/i.test(t); }), "adding several leads with a WhatsApp screenshot, and never mentions file types");
    await co.locator("#sheet details.planbox summary").tap(); await co.waitForTimeout(100);
    await co.fill("#bulk-paste", "Pat Smith 082 111 2222\nLee Jones, lee@bulk.test\nSipho Ndlovu\nLerato's mom 083 555 1234"); await co.tap('[data-a="bulkparse"]'); await co.waitForTimeout(200);
    ok(await ev(co, () => { const r = [...document.querySelectorAll("#sheet .bulkrow")]; return r.length === 4 && /No number yet/.test(r[2].innerText) && r[3].querySelector("input").value === "Lerato" && /Kid/.test(r[3].querySelector(".kindchip").innerText); }), "typed names work with or without a number, and \"Lerato's mom\" becomes the kid Lerato");
    await co.locator("#sheet .bulkrow .bx").first().tap(); await co.waitForTimeout(150);
    ok(await ev(co, () => /Add 3 students/.test(document.querySelector('#sheetbar [data-a="bulkadd"]').innerText)), "tap the tick to leave someone out");
    let shots = 0;
    await co.route("**/api/coach/students/read-people", (rt) => { shots = (rt.request().postDataJSON().images || []).length; rt.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ people: [
      { name: "Aya", parentName: "Nomsa Dube", phone: "+27 82 444 5555" }, { name: "Ben", parentName: "Nomsa Dube", phone: "+27 82 444 5555" },
      { name: "", parentName: "Kev", phone: "+27 82 666 7777" }, { name: "Ana Lima", parentName: "", phone: "", already: true }, { name: "Tom Adult", parentName: "", phone: "082 777 8888" } ] }) }); });
    const shot = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    await co.setInputFiles("#ppl-in", [{ name: "IMG_1.PNG", mimeType: "image/png", buffer: shot }, { name: "IMG_2.PNG", mimeType: "image/png", buffer: shot }]); await co.waitForTimeout(900);
    ok(shots === 2 && await ev(co, () => document.querySelectorAll("#sheet .bulkrow").length === 9), "two screenshots of the group are read together and their people join the list");
    ok(await ev(co, () => { const r = [...document.querySelectorAll("#sheet .bulkrow")]; return !r[7].classList.contains("on") && /Already on your list/.test(r[7].innerText) && /Parent: Nomsa Dube/.test(r[4].innerText) && /Parent: Nomsa Dube/.test(r[5].innerText); }), "someone already in the gym starts unticked; brother and sister share their parent");
    await co.tap('#sheetbar [data-a="bulkadd"]'); await co.waitForTimeout(300);
    ok(/kid's name for Kev/.test(await toast(co)) && await ev(co, () => document.activeElement && document.activeElement.dataset.i === "6"), "a parent without the kid's name asks for it");
    await co.fill('[data-bk="name"][data-i="6"]', "Kai");
    await co.tap('[data-a="bulkkind"][data-v="8"]'); await co.waitForTimeout(200);
    ok(await ev(co, () => { const r = document.querySelectorAll("#sheet .bulkrow")[8]; return /Parent: Tom Adult/.test(r.innerText) && r.querySelector("input").value === "" && document.activeElement === r.querySelector("input"); }), "tapping Adult turns a parent into a Kid row, ready for the kid's name");
    await co.fill('[data-bk="name"][data-i="8"]', "Tim");
    const vcf = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Zoe Khumalo\r\nTEL;type=CELL:+27 82 333 4444\r\nEND:VCARD\r\n";
    await co.setInputFiles("#ppl-in", { name: "contacts.vcf", mimeType: "text/vcard", buffer: Buffer.from(vcf) }); await co.waitForTimeout(400);
    ok(await ev(co, () => { const r = document.querySelectorAll("#sheet .bulkrow"); return r.length === 10 && r[9].querySelector("input").value === "Zoe Khumalo" && r[6].querySelector("input").value === "Kai" && r[8].querySelector("input").value === "Tim"; }), "a shared contact file goes in the same button, and typed names are kept");
    await co.tap('#sheetbar [data-a="bulkadd"]'); await co.waitForTimeout(1200); await co.unroute("**/api/coach/students/read-people");
    ok(/Added 8 students/.test(await toast(co)) && await ev(co, () => { const t = document.getElementById("roster-list").innerText; return /Lee Jones/.test(t) && /Zoe Khumalo/.test(t) && /Sipho Ndlovu/.test(t) && !/Pat Smith/.test(t) && /Aya[\s\S]*Kid · Nomsa Dube/.test(t) && /Ben/.test(t) && /Tim/.test(t); }), "the ticked people are added, kids with their parent (siblings both)");
    await ev(co, () => studentSheet(students().find((s) => s.name === "Aya").id)); await co.waitForTimeout(800);
    ok(await ev(co, () => { const a = [...document.querySelectorAll('#sheet a[href*="wa.me"]')].map((x) => decodeURIComponent(x.href)).join(" "); return document.getElementById("s-parent").value === "Nomsa Dube" && /Hi Nomsa, join .* for Aya/.test(a); }), "a kid's page shows the parent, and WhatsApp messages greet the parent");
    await ev(co, () => hideSheet());
    // --- with two coaches, the class forms offer a list of coaches
    const cc = await ev(co, () => API.me.gym.coachCode); const c2 = await phone("coach2");
    await signup(c2, "/app/?join=" + cc, { "#a-name": "Coach Raf", "#a-email": "raf@race.test", "#a-pass": "rafpass11" });
    await ev(co, async () => { await coachLoad("roster"); coachGo("classes"); }); await co.waitForTimeout(500);
    await co.tap('[data-a="classnew"]'); await co.waitForTimeout(300);
    ok(await ev(co, () => { const s = document.getElementById("c-coach"); return s && s.tagName === "SELECT" && s.value === "Coach Kim" && [...s.options].map((o) => o.text).join("|") === "Coach Kim|Coach Raf|Someone else…"; }), "a gym with two coaches picks the coach from a list (you first)");
    await co.fill("#c-title", "Raf's no-gi"); await co.selectOption("#c-coach", "Coach Raf"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1200);
    ok(await ev(co, () => (COACH.classes || []).some((c) => c.title === "Raf's no-gi" && c.coach === "Coach Raf")), "the picked coach is saved on the class");
    await ev(co, () => classForm((COACH.classes || []).find((c) => c.title === "Raf's no-gi"))); await co.waitForTimeout(300);
    ok(await ev(co, () => document.getElementById("c-coach").value === "Coach Raf"), "editing the class shows its coach");
    await co.selectOption("#c-coach", "__other"); await co.waitForTimeout(100);
    ok(await ev(co, () => !document.getElementById("c-coach-other").hidden), "'Someone else…' opens a box for a guest coach's name");
    await co.fill("#c-coach-other", "Guest Prof"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1200);
    ok(await ev(co, () => (COACH.classes || []).some((c) => c.title === "Raf's no-gi" && c.coach === "Guest Prof")), "a guest coach's name is saved");
    await ev(co, () => classForm((COACH.classes || []).find((c) => c.title === "Raf's no-gi"))); await co.waitForTimeout(300);
    ok(await ev(co, () => document.getElementById("c-coach").value === "Guest Prof"), "a guest coach stays selected when the class is edited again");
    await ev(co, () => hideSheet()); await c2.close();
    // --- the gym's colour
    const before = await ev(co, () => getComputedStyle(document.documentElement).getPropertyValue("--blue").trim());
    await ev(co, () => coachGo("gym")); await co.waitForTimeout(300); await co.tap('[data-a="brandset"][data-v="#c62828"]'); await co.waitForTimeout(600);
    ok(await ev(co, (b) => { const now = getComputedStyle(document.documentElement).getPropertyValue("--blue").trim(); return now !== b && /^#[0-9a-f]{6}$/.test(now) && API.me.gym.brand.accent === "#c62828"; }, before), "picking a colour restyles the app");
    await ev(s1, async () => { API.me = (await api("GET", "/me")).me; render(); }); await s1.waitForTimeout(300);
    ok(await ev(s1, () => !!document.getElementById("brandcss") && API.me.gym.brand.accent === "#c62828"), "students see the gym's colour too");
    await ev(co, () => api("PATCH", "/coach/gym", { brandAccent: "" }).then((j) => { API.me = j.me; applyBrand(); }));
    for (const p of [co, s1, s2, s3]) ok(await ev(p, () => document.documentElement.scrollWidth <= 390), "no sideways scroll");
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e).toString().split("\n").slice(0, 3).join(" ")); }
  ok(errs.length === 0, "page errors: " + errs.join(" | "));
  await b.close(); srv.kill(); sink.close(); site.close(); await pool.end();
  console.log(`booking-ui: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
