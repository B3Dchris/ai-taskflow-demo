// Booking through the real screens: students racing for the last spot, the waitlist, check-in and plan limits,
// and what the coach sees. Usage: DATABASE_URL=postgres://.../<something>test node tests/booking-ui.js  (wipes that database)
const { chromium, devices } = require("playwright"); const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg");
const { startMailSink, startGymSite } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists autopay_charges, autopay, class_skips, plan_breaks, left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const sink = await startMailSink(), site = await startGymSite();
  const port = 9400 + Math.floor(Math.random() * 90), URL = `http://localhost:${port}`;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env: { ...process.env, PORT: String(port), DATABASE_URL: DB, RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, JF_IMPORT_ALLOW_LOOPBACK: "1", ANTHROPIC_API_KEY: "" }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60; i++) { try { await fetch(URL + "/healthz"); break; } catch (e) { await wait(150); } }
  const b = await chromium.launch(); const errs = [];
  const phone = async (name) => { const c = await b.newContext({ ...devices["iPhone 13"] }); await c.addInitScript(() => { if (!localStorage.getItem("rtb.progress")) localStorage.setItem("rtb.progress", JSON.stringify({ settings: { onboarded: true } })); }); const p = await c.newPage(); p.on("pageerror", (e) => errs.push(name + ": " + e.message)); return p; };
  const ev = (p, f, a) => p.evaluate(f, a), toast = (p) => ev(p, () => document.getElementById("toast").textContent);
  const wide2 = async (p, label) => ok(await ev(p, () => document.documentElement.scrollWidth <= 390), label + ": no sideways scroll");
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
    await co.tap('nav.tabs [data-v="coach-schedule"]'); await co.waitForTimeout(600);
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
    await ev(s2, async () => { await loadClasses(true); const k = dayKey(new Date(Date.now() + 20 * 60e3).toISOString()); S.ui.bcal = { mode: "week", sel: k, anchor: k }; render(); }); await s2.waitForTimeout(600);
    await s2.locator('.bookcard:has-text("Starting soon") [data-a="rsvp"]').tap(); await s2.waitForTimeout(900);
    ok(await ev(s2, () => [...document.querySelectorAll(".bookcard")].some((c) => /Starting soon/.test(c.innerText) && c.querySelector('[data-a="checkin"]'))), "a booked class starting soon shows Check in");
    await s2.locator('.bookcard:has-text("Starting soon") [data-a="checkin"]').tap(); await s2.waitForTimeout(900);
    ok(await ev(s2, () => [...document.querySelectorAll(".bookcard")].some((c) => /Starting soon/.test(c.innerText) && /Checked in/.test(c.innerText))), "student checks in from their phone");
    await ev(co, () => coachLoad("classes")); await co.waitForTimeout(500);
    const soonId = await ev(co, () => COACH.classes.find((c) => c.title === "Starting soon").id);
    await ev(co, (id) => classSheet(id), soonId); await co.waitForTimeout(800);
    ok(await ev(co, () => /Checked in/.test(document.getElementById("sheet").innerText)), "coach sees the student checked themselves in");
    // ---- competitions: coach imports an event, a student asks in, the coach enters them
    await ev(co, () => hideSheet()); await co.tap('nav.tabs [data-v="coach-members"]'); await co.tap('[data-a="coachgo"][data-v="comps"]'); await co.waitForTimeout(500);
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
    ok(/classes this week/.test(w.text) && /Starting soon/.test(w.text) && /spots? left|full/.test(w.text) && /\/app\/#classes/.test(w.text), "WhatsApp: this week's classes, with spots left and a booking link");
    await co.fill("#wa-text", "Edited message 123"); w = waText(await ev(co, () => document.getElementById("wa-go").href));
    ok(w.text === "Edited message 123", "WhatsApp: editing the message changes what gets sent");
    await co.tap('[data-a="wakind"][data-v="comp"]'); await co.waitForTimeout(400);
    w = waText(await ev(co, () => document.getElementById("wa-go").href));
    ok(/Gauteng Open/.test(w.text) && /Our team \(2\)/.test(w.text), "WhatsApp: a competition with the team list");
    ok(await ev(co, () => /coach access/.test(WA_T.coach()) && /join=/.test(WA_T.coach())), "WhatsApp: invite-a-coach message warns it gives coach access");
    await co.tap('nav.tabs [data-v="coach-home"]'); await co.waitForTimeout(500);
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
    // --- PayFast: the coach connects (test account), the gym's plan shows its free months
    await co.locator('details[data-g="m-pf"] summary').tap(); await co.waitForTimeout(200);
    ok(await ev(co, () => { const t = document.querySelector('details[data-g="m-pf"]').innerText; return /Split Payments/.test(t) && /10000100/.test(t) && /2%/.test(t); }), "Money explains card payments, the 2% fee and the PayFast steps");
    // the owner can show a PayFast button that says "coming soon" while card payments aren't live
    await co.locator("#pf-soon").check(); await co.waitForTimeout(600);
    ok(/coming soon/.test(await toast(co)), "the gym owner switches on the PayFast button");
    await ev(s1, async () => { await loadPay(); go("me"); }); await s1.waitForTimeout(500); await s1.tap('[data-a="mypay"]'); await s1.waitForTimeout(400);
    ok(await ev(s1, () => !!document.querySelector('#sheet [data-a="paysoon"]') && !document.querySelector('#sheet [data-a="paycard"]')), "students see the PayFast button");
    await s1.tap('#sheet [data-a="paysoon"]'); await s1.waitForTimeout(200);
    ok(/coming soon/i.test(await toast(s1)), "tapping it says coming soon"); await ev(s1, () => hideSheet());
    await co.locator("#pf-soon").uncheck(); await co.waitForTimeout(600);
    await ev(s1, async () => { await loadPay(); go("me"); }); await s1.waitForTimeout(400); await s1.tap('[data-a="mypay"]'); await s1.waitForTimeout(400);
    ok(await ev(s1, () => !document.querySelector('#sheet [data-a="paysoon"]')), "switched off, the button is gone"); await ev(s1, () => hideSheet());
    await co.tap('[data-a="pftest"]'); await co.waitForTimeout(900);
    ok(/Test account connected/.test(await toast(co)) && await ev(co, () => /Connected/.test(document.querySelector('details[data-g="m-pf"] summary').innerText)), "the coach connects PayFast (test account)");
    await ev(co, () => coachGo("gym")); await co.waitForTimeout(700);
    ok(await ev(co, () => { const p = document.querySelector(".planpanel"); return p && /Free until/.test(p.innerText) && /R\s?99/.test(p.innerText) && !!p.querySelector('[data-a="billcard"]'); }), "Gym shows the free months, the R99 plan and Add a card");
    await ev(co, () => coachGo("money")); await co.waitForTimeout(300);
    await ev(s1, () => { API.pay = undefined; go("me"); }); await s1.waitForTimeout(1200);
    const ref = await ev(s1, () => API.pay && API.pay.reference);
    ok(/^JF[A-Z2-9]{5}$/.test(ref) && await ev(s1, (r) => !!document.querySelector(".feecard") && document.querySelector(".feecard").innerText.includes(r), ref), "student's Me tab shows a fees card with their reference");
    await ev(s1, () => go("home")); await s1.waitForTimeout(300);
    ok(await ev(s1, () => (API.pay.dueCents > API.pay.paidCents) === !!document.querySelector("#app .feecard")), "Home shows the fees card only when something is due");
    await ev(s1, () => go("me")); await s1.waitForTimeout(300);
    await s1.tap('[data-a="mypay"]'); await s1.waitForTimeout(400);
    ok(await ev(s1, () => /^Pay$/.test(document.querySelector('.feecard [data-a="mypay"]').textContent.trim())), "the fees card's button just says Pay");
    ok(await ev(s1, () => { const ts = [...document.querySelectorAll("#paymethods .paytile")].map((b) => b.getAttribute("aria-label")); const wallet = canApplePay() ? "Apple Pay" : /iPhone|iPad|iPod/.test(navigator.userAgent) ? null : "Google Pay";
      return ts.includes("Card") && ts.some((x) => /^EFT/.test(x)) && (wallet ? ts.includes(wallet) : !ts.includes("Apple Pay") && !ts.includes("Google Pay")) && !document.getElementById("payeft"); }), "Pay opens on the ways to pay: the phone's wallet (Apple Pay on Apple, Google Pay elsewhere), card and EFT (EFT details stay closed)");
    ok(await ev(s1, () => { window.ApplePaySession = { canMakePayments: () => true }; myPaySheet(); const ts = [...document.querySelectorAll("#paymethods .paytile")].map((b) => b.getAttribute("aria-label")); delete window.ApplePaySession; myPaySheet(); return ts.includes("Apple Pay") && !ts.includes("Google Pay"); }), "on a device with Apple Pay, the Apple Pay button shows (and not Google Pay)");
    await s1.tap('#sheet [data-a="payeft"]'); await s1.waitForTimeout(300);
    ok(await ev(s1, () => !!document.getElementById("payeft") && !!document.getElementById("popzone")), "EFT opens the bank details and proof of payment");
    ok(await ev(s1, (r) => { const t = document.getElementById("sheet").innerText; return /62123456789/.test(t) && /250655/.test(t) && t.includes(r) && !!document.querySelector('#sheet [data-a="copy"][data-v="62123456789"]'); }, ref), "pay sheet: bank details, copy buttons and the reference");
    ok(await ev(s1, () => !!document.querySelector('#sheet [data-a="paycard"][data-v="cc"]') && !!document.querySelector('#sheet [data-a="paycard"][data-v="ef"]')), "the student can pay by card or Instant EFT");
    { let posted = null; await s1.route("https://sandbox.payfast.co.za/**", (rt) => { posted = rt.request().postData(); rt.fulfill({ status: 200, contentType: "text/html", body: "<title>PayFast</title>" }); });
      await s1.tap('#sheet [data-a="paycard"][data-v="cc"]'); await s1.waitForTimeout(1500);
      const f = new URLSearchParams(posted || "");
      ok(f.get("payment_method") === "cc", "the Card button opens PayFast on card only (payment_method cc)");
      ok(f.get("merchant_id") === "10000100" && /^\d+\.\d{2}$/.test(f.get("amount") || "") && f.get("custom_str1") === "pay" && /^[a-f0-9]{32}$/.test(f.get("signature") || ""), "Pay by card opens PayFast's checkout with a signed payment: " + (posted || "").slice(0, 80));
      await s1.unroute("https://sandbox.payfast.co.za/**"); await s1.goto(URL + "/app/?paid=card"); await s1.waitForTimeout(1500);
      ok(/PayFast confirms/.test(await toast(s1)), "back from PayFast, the student is told it shows once confirmed"); await ev(s1, () => go("me")); await s1.waitForTimeout(800); await s1.tap('[data-a="mypay"]'); await s1.waitForTimeout(400); await s1.tap('#sheet [data-a="payeft"]'); await s1.waitForTimeout(300); }
    // pasting a screenshot anywhere on the EFT view sends it as the proof (checked without sending: the real send is next)
    ok(await ev(s1, () => { let got = null; const keep = window.sendMyProof; window.sendMyProof = (f) => { got = f.type; };
      const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" })); document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
      window.sendMyProof = keep; return got === "image/png"; }), "pasting a screenshot on the Pay sheet sends it as proof of payment");
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
    ok(await ev(s1, () => { const at = (m) => new Date(Date.now() + m * 6e4).toISOString(), h = (c) => bookActions({ id: "9", kind: "private", durationMin: 60, myGoing: true, ...c });
      return !/data-a="rsvp"/.test(h({ startsAt: at(-10) })) && /data-a="rsvp"/.test(h({ startsAt: at(120) })) && /data-a="rsvp"/.test(bookActions({ id: "8", kind: "class", durationMin: 60, myGoing: true, startsAt: at(-10) })); }),
      "a booked private has a Cancel button until it starts, then not (a class still does)");
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
    ok(await ev(co, () => /Choose from your iPhone contacts/.test(document.getElementById("sheet").innerText) && /Contact Picker API/.test(document.getElementById("sheet").textContent) && !document.querySelector('[data-a="pickcontacts"]')), "on an iPhone without the contact picker, the steps to switch it on are offered");
    await co.locator("#sheet details.planbox summary").nth(1).tap(); await co.waitForTimeout(100);
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
    // --- with the phone's contact picker (Android, or iPhone with it switched on): the main button, several at once
    await ev(co, () => { window.ContactsManager = function () {}; Object.defineProperty(navigator, "contacts", { configurable: true, value: { select: async (props, o) => (window._pickOpts = o, [{ name: ["Musa Khoza"], tel: ["+27 82 121 3434"], email: [] }, { name: ["Naledi's Mom"], tel: ["083 222 1111"], email: [] }]) } }); });
    await ev(co, () => coachGo("students")); await co.waitForTimeout(300); await co.tap('[data-a="addstu"]'); await co.tap('[data-a="bulkopen"]'); await co.waitForTimeout(200);
    ok(await ev(co, () => { const b = document.querySelector('#sheet [data-a="pickcontacts"]'); return b && b.classList.contains("primary") && !/Contact Picker API/.test(document.getElementById("sheet").innerText); }), "the contacts picker is the main button when the phone has it");
    await co.tap('[data-a="pickcontacts"]'); await co.waitForTimeout(300);
    ok(await ev(co, () => { const r = [...document.querySelectorAll("#sheet .bulkrow")]; return window._pickOpts && window._pickOpts.multiple === true && r.length === 2 && /\+27 82 121 3434/.test(r[0].innerText) && r[1].querySelector("input").value === "Naledi" && /Kid/.test(r[1].innerText); }), "several contacts come in at once with their numbers; \"Naledi's Mom\" becomes the kid Naledi");
    await ev(co, () => hideSheet());
    // --- in the App Store app: the whole address book, searched and ticked
    await ev(co, () => { window.Capacitor = { isNativePlatform: () => true, Plugins: { Contacts: { checkPermissions: async () => ({ contacts: "prompt" }), requestPermissions: async () => ({ contacts: "granted" }),
      getContacts: async () => ({ contacts: [{ name: { display: "Zanele Dube" }, phones: [{ number: "+27 82 555 1111", isPrimary: true }] }, { name: { given: "Tom", family: "Botha" }, phones: [{ number: "083 555 2222" }] }, { name: { display: "Plumber Pete" }, phones: [{ number: "011 555 3333" }] }, { name: { display: "Kea's Mom" }, phones: [{ number: "084 555 4444" }] }] }) } } }; });
    await ev(co, () => coachGo("students")); await co.waitForTimeout(300); await co.tap('[data-a="addstu"]'); await co.tap('[data-a="bulkopen"]'); await co.waitForTimeout(200);
    await co.tap('[data-a="pickcontacts"]'); await co.waitForTimeout(400);
    ok(await ev(co, () => S.ui.sheet.k === "cpick" && document.querySelectorAll("#cp-list .bulkrow").length === 4 && /Kea's Mom[\s\S]*Plumber Pete[\s\S]*Tom Botha[\s\S]*Zanele Dube/.test(document.getElementById("cp-list").innerText)), "the app shows the phone's contacts, A to Z, after asking permission");
    await co.fill("#cp-q", "zan"); await co.waitForTimeout(150);
    ok(await ev(co, () => document.querySelectorAll("#cp-list .bulkrow").length === 1), "searching narrows the contacts");
    await co.tap('#cp-list [data-a="cpick"]'); await co.fill("#cp-q", "kea"); await co.waitForTimeout(150); await co.tap('#cp-list .bx'); await co.waitForTimeout(100);
    ok(await ev(co, () => /Add 2 to the list/.test(document.querySelector('#sheetbar [data-a="cpdone"]').innerText)), "ticks are kept while searching");
    await co.tap('#sheetbar [data-a="cpdone"]'); await co.waitForTimeout(300);
    ok(await ev(co, () => { const r = [...document.querySelectorAll("#sheet .bulkrow")]; return S.ui.sheet.k === "bulk" && r.length === 2 && r.some((x) => /\+27 82 555 1111/.test(x.innerText)) && r.some((x) => x.querySelector("input").value === "Kea" && /Kid/.test(x.innerText)); }), "the picked people go to the list with their numbers (Kea's Mom → the kid Kea)");
    await ev(co, () => { hideSheet(); COACH.bill = undefined; coachGo("gym"); }); await co.waitForTimeout(800);
    ok(await ev(co, () => { const p = document.querySelector(".planpanel"); return p && !p.querySelector('[data-a="billcard"]') && /managed on the JitsFlow website/.test(p.innerText); }), "in the App Store app there's no card button for the plan (Apple's rules)");
    await ev(co, () => { delete window.Capacitor; COACH.bill = undefined; });
    await ev(co, () => studentSheet(students().find((s) => s.name === "Aya").id)); await co.waitForTimeout(800);
    ok(await ev(co, () => { const a = [...document.querySelectorAll('#sheet a[href*="wa.me"]')].map((x) => decodeURIComponent(x.href)).join(" "); return document.getElementById("s-parent").value === "Nomsa Dube" && /Hi Nomsa, join .* for Aya/.test(a); }), "a kid's page shows the parent, and WhatsApp messages greet the parent");
    await ev(co, () => hideSheet());
    // --- with two coaches, the class forms offer a list of coaches
    const cc = await ev(co, () => API.me.gym.coachCode); const c2 = await phone("coach2");
    await signup(c2, "/app/?join=" + cc, { "#a-name": "Coach Raf", "#a-email": "raf@race.test", "#a-pass": "rafpass11" });
    await c2.waitForTimeout(600);
    ok(await ev(c2, () => isCoach() && !isHead() && API.me.gym.headCoach.name === "Coach Kim" && document.querySelector('nav.tabs [data-v="coach-money"]').hidden && !document.querySelector('nav.tabs [data-v="coach-schedule"]').hidden), "the second coach isn't the head coach: classes yes, Money tab no");
    await ev(co, async () => { await coachLoad("roster"); coachGo("classes"); }); await co.waitForTimeout(500);
    await co.tap('[data-a="classnew"]'); await co.waitForTimeout(300);
    ok(await ev(co, () => { const s = document.getElementById("c-coach"); return s && s.tagName === "SELECT" && s.value === "Coach Kim" && [...s.options].map((o) => o.text).join("|") === "Coach Kim|Coach Raf|Someone else…"; }), "a gym with two coaches picks the coach from a list (you first)");
    await co.fill("#c-title", "Raf's no-gi"); await co.selectOption("#c-coach", "Coach Raf"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1200);
    ok(await ev(co, () => (COACH.classes || []).some((c) => c.title === "Raf's no-gi" && c.coach === "Coach Raf")), "the picked coach is saved on the class");
    ok(await ev(co, () => (COACH.classes || []).find((c) => c.title === "Raf's no-gi").discipline === "BJJ No-Gi"), "the class type is worked out from the name when left empty");
    await co.tap('[data-a="classnew"]'); await co.waitForTimeout(300); await co.fill("#c-title", "Morning sweat"); await co.fill("#c-type", "HIIT"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1200);
    ok(await ev(co, () => { const c = (COACH.classes || []).find((x) => x.title === "Morning sweat"); return c && c.discipline === "HIIT" && [...document.querySelectorAll(".calrow")].some((r) => /Morning sweat/.test(r.innerText) && /HIIT/.test(r.innerText)); }), "any type of class can be added, and its type shows on the calendar");
    await ev(co, () => classForm((COACH.classes || []).find((c) => c.title === "Raf's no-gi"))); await co.waitForTimeout(300);
    ok(await ev(co, () => document.getElementById("c-coach").value === "Coach Raf"), "editing the class shows its coach");
    await co.selectOption("#c-coach", "__other"); await co.waitForTimeout(100);
    ok(await ev(co, () => !document.getElementById("c-coach-other").hidden), "'Someone else…' opens a box for a guest coach's name");
    await co.fill("#c-coach-other", "Guest Prof"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1200);
    ok(await ev(co, () => (COACH.classes || []).some((c) => c.title === "Raf's no-gi" && c.coach === "Guest Prof")), "a guest coach's name is saved");
    await ev(co, () => classForm((COACH.classes || []).find((c) => c.title === "Raf's no-gi"))); await co.waitForTimeout(300);
    ok(await ev(co, () => document.getElementById("c-coach").value === "Guest Prof"), "a guest coach stays selected when the class is edited again");
    await ev(co, () => hideSheet()); await c2.close();
    // --- money: Check & edit saves, a year plan's months, Record a payment fills in, one-tap Paid, Confirm N ready, leaving owing, a kid's invite link
    { const b64 = png.toString("base64"), upload = async () => { await co.setInputFiles("#pop-up", { name: "pop.png", mimeType: "image/png", buffer: png }); await co.waitForTimeout(1500); };
      await ev(co, async () => { hideSheet(); await coachLoad(); COACH.moneyView = "payments"; coachGo("money"); }); await co.waitForTimeout(600);
      await upload(); ok(await ev(co, () => S.ui.sheet && S.ui.sheet.k === "pop"), "uploading a proof opens Check payment");
      const benId = await ev(co, () => students().find((s) => s.name === "Ben Cole").id);
      await co.selectOption("#pop-user", benId); await co.fill("#pop-amt", "500"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1500);
      ok(!/[?&]amount=/.test(co.url()) && /Payment confirmed/.test(await toast(co)) && await ev(co, (id) => COACH.payments.some((p) => p.userId === id && p.amountCents === 50000 && p.status === "confirmed"), benId),
        "Check & edit: picking the student, typing the amount and tapping Confirm payment saves it: " + co.url());
      const catId = await ev(co, async () => { const pl = (await api("POST", "/coach/plans", { name: "Year up front", priceCents: 600000, period: "year" })).plan, c = students().find((s) => s.name === "Cat Diaz");
        await api("PATCH", "/coach/students/" + c.id, { planId: pl.id }); await coachLoad(); return c.id; });
      await upload(); await co.selectOption("#pop-user", catId); await co.fill("#pop-amt", "6000"); await co.waitForTimeout(200);
      ok(await ev(co, () => !document.getElementById("pop-covers").hidden && /Covers 12 months/.test(document.getElementById("pop-cov-txt").innerText)), "for someone on a year plan, the Check sheet says it covers 12 months");
      await co.tap('[data-a="popcov"]'); ok(await ev(co, () => !document.getElementById("pop-cov-pick").hidden && document.getElementById("pop-months").value === "12"), "with a Change link that shows the months");
      await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1500);
      ok(await ev(co, (id) => COACH.payments.some((p) => p.userId === id && p.amountCents === 600000 && p.months === 12 && p.status === "confirmed"), catId), "confirmed, the year's payment covers 12 months");
      // Record a payment: picking the student fills in what they owe, and the method used last time is remembered
      await co.tap('[data-a="paynew"]'); await co.waitForTimeout(300); await co.selectOption("#p-user", catId); await co.waitForTimeout(100);
      ok(await ev(co, () => document.getElementById("p-amt").value === "6000" && document.getElementById("p-months").value === "12"), "picking a student on a year plan fills in the year's price and 12 months");
      await co.selectOption("#p-user", benId); await co.waitForTimeout(100);
      ok(await ev(co, () => document.getElementById("p-amt").value === "500" && document.getElementById("p-months").value === "1"), "picking a monthly student fills in their fee");
      await co.selectOption("#p-method", "cash"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1500);
      await co.tap('[data-a="paynew"]'); await co.waitForTimeout(300); ok(await ev(co, () => document.getElementById("p-method").value === "cash"), "the next payment starts on the method used last time"); await ev(co, () => hideSheet());
      // One tap on Paid next to someone who owes
      // (Lee was added in bulk, so their fees start next month, on the gym's usual plan: the coach bills this month too, as the toast
      // offers, and takes them off the plan so they pay the gym's standard fee.)
      const lee = await ev(co, () => students().find((s) => s.name === "Lee Jones").id);
      await ev(co, (id) => api("POST", "/coach/students/bill-from", { userIds: [id], from: todayK().slice(0, 7) + "-01" }).then(() => api("PATCH", `/coach/students/${id}`, { planId: null })), lee);
      await ev(co, () => { COACH.moneyView = "month"; COACH.moneyFilter = "owing"; COACH.money = null; render(); }); await co.waitForTimeout(1500);
      ok(await ev(co, (id) => !!document.querySelector(`[data-a="paidnow"][data-v="${id}"]`) && !!document.querySelector('[data-a="paidhow"][data-v="cash"][aria-pressed="true"]'), lee), "owing rows have a Paid button (cash, the last method used)");
      await co.tap('[data-a="paidhow"][data-v="eft"]'); await co.waitForTimeout(200);
      await co.route("**/api/coach/payments", async (r) => { await wait(600); r.continue(); }); // a slow line, tapped twice
      await ev(co, (id) => { const b = document.querySelector(`[data-a="paidnow"][data-v="${id}"]`); b.click(); setTimeout(() => b.click(), 150); }, lee); await co.waitForTimeout(2200); await co.unroute("**/api/coach/payments");
      ok(await ev(co, (id) => COACH.payments.filter((p) => p.userId === id).length === 1, lee), "a double tap on Paid records it once");
      ok(/Recorded R\s?500 \(EFT\) for Lee Jones/.test(await toast(co)) && await ev(co, (id) => COACH.payments.some((p) => p.userId === id && p.amountCents === 50000 && p.method === "eft"), lee), "Paid records the full amount today by EFT: " + (await toast(co)));
      ok(await ev(co, (id) => !document.querySelector(`[data-a="paidnow"][data-v="${id}"]`), lee), "and they leave the owing list");
      await co.tap('#toast [data-a="toastact"]'); await co.waitForTimeout(1800);
      ok(await ev(co, (id) => !COACH.payments.some((p) => p.userId === id && p.amountCents === 50000), lee) && /Undone/.test(await toast(co)), "Undo takes it off again");
      // Confirm N ready: proofs with the student and amount filled in and nothing flagged
      for (const p of [s1, s2]) await ev(p, (d) => api("POST", "/me/pay/proof", { name: "pop.png", data: d, amountCents: 47000 }), b64); // not 50000: Ben paid that today, so it would look like a duplicate
      await co.waitForTimeout(800); await ev(co, async () => { await coachLoad(); COACH.moneyView = "payments"; render(); }); await co.waitForTimeout(500);
      ok(await ev(co, () => /Confirm 2 ready/.test((document.querySelector('[data-a="popall"]') || {}).innerText || "")), "two proofs ready to confirm: one button for both");
      await co.tap('[data-a="popall"]'); await co.waitForTimeout(2000);
      ok(/Confirmed 2 payments/.test(await toast(co)) && await ev(co, () => !COACH.payments.some((p) => p.status === "pending")), "one tap confirms both");
      await co.tap('#toast [data-a="toastact"]'); await co.waitForTimeout(2000);
      ok(await ev(co, () => COACH.payments.filter((p) => p.status === "pending").length === 2), "Undo puts them back under To check");
      // Leaving the gym while owing: it says how much, with Pay now or Leave anyway; the coach still sees it
      const s4 = await phone("s4"); await signup(s4, "/app/?join=" + code, { "#a-name": "Dee Owes", "#a-email": "dee@race.test", "#a-pass": "deepass111" });
      await ev(s4, () => { hideSheet(); go("settings"); }); await s4.waitForTimeout(300); await s4.tap('[data-a="leavegym"]'); await s4.waitForTimeout(800);
      ok(await ev(s4, () => /You still owe R\s?500 to Race Gym/.test(document.getElementById("sheet").innerText) && !!document.querySelector('#sheetbar [data-a="mypay"]') && /Leave anyway/.test(document.getElementById("sheetbar").innerText)), "leaving while owing says how much, with Pay now and Leave anyway");
      await s4.tap('#sheetbar [data-a="mypay"]'); await s4.waitForTimeout(400); ok(await ev(s4, () => S.ui.sheet.k === "mypay"), "Pay now opens the Pay sheet");
      await ev(s4, () => leaveSheet()); await s4.waitForTimeout(500); await s4.tap('#sheetbar [data-a="leavegymyes"]'); await s4.waitForTimeout(1200);
      ok(await ev(s4, () => API.me && !API.me.gym), "Leave anyway leaves");
      await ev(co, () => { COACH.moneyView = "month"; COACH.money = null; render(); }); await co.waitForTimeout(1500);
      ok(await ev(co, () => /Dee Owes[\s\S]*Left · owes R\s?500/.test(document.getElementById("app").innerText)), "the coach's Money still shows them: Left · owes R500");
      await ev(co, async () => { API.notices = undefined; coachGo("home"); }); await co.waitForTimeout(1200);
      ok(await ev(co, () => /Dee Owes left Race Gym owing R\s?500/.test(document.getElementById("app").innerText)), "and the head coach sees it on Home");
      await s4.context().close();
      // A kid's own invite link: the parent signs up for them
      const claim = await ev(co, async () => { const id = (await api("POST", "/coach/students", { name: "Lerato Kid", parentName: "Thandi", phone: "072 333 5555" })).id; return (await api("POST", `/coach/students/${id}/claim-link`)).url; });
      const k5 = await phone("kid"); await k5.goto(claim.replace(/^https?:\/\/[^/]+/, URL)); await k5.waitForTimeout(1500);
      ok(await ev(k5, () => /Signing up for\s+Lerato Kid/.test(document.getElementById("a-joining").innerText) && /Your name \(parent\)/.test(document.getElementById("sheet").innerText)), "a kid's invite link says who it's for and asks for the parent's name");
      await k5.context().close(); await ev(co, () => coachGo("money")); }
    // --- screen readers, small screens and finding people (review 2)
    { const at = (min) => new Date(Date.now() + min * 60e3).toISOString();
      const ids = await ev(co, async (at) => { const mk = async (b) => (await api("POST", "/classes", b)).class.id;
        const ppl = (await api("GET", "/coach/roster")).people, id = (n) => ppl.find((x) => x.name === n).id;
        const past = await mk({ title: "Regulars roll", startsAt: new Date(new Date(at.reg).getTime() - 7 * 864e5).toISOString() });
        await api("PUT", `/coach/classes/${past}/attendance`, { userIds: [id("Ana Lima"), id("Ben Cole")], attended: true });
        return { reg: await mk({ title: "Regulars roll", startsAt: at.reg }), mt: await mk({ title: "Muay Thai", discipline: "Muay Thai", startsAt: at.mt }), kids: await mk({ title: "Kids BJJ", level: "Kids", startsAt: at.kids }),
          ane: (await api("POST", "/coach/students", { name: "Ané-Marié Botha", phone: "082 001 0001" })).id, sib: (await api("POST", "/coach/students", { name: "Sìbọ̀nìsọ̀ Zulu", parentName: "Zodwa Zulu", phone: "071 222 3333" })).id,
          long: (await api("POST", "/coach/students", { name: "Q".repeat(60), phone: "071 222 4444" })).id, emo: (await api("POST", "/coach/students", { name: "E".repeat(79) + "😀", phone: "071 222 5555" })).id }; }, { reg: at(30), mt: at(45), kids: at(50) });
      // the regulars of this weekday and time come first, with one button to mark them here
      await ev(co, async (id) => { hideSheet(); await coachLoad("roster"); await classSheet(id); }, ids.reg); await co.waitForTimeout(600);
      ok(await ev(co, () => /Mark the usual 2 here/.test((document.querySelector('[data-a="clsusual"]') || {}).innerText || "")), "a class shows Mark the usual 2 here (the two who came last week at this time)");
      await co.tap('[data-a="clsaddopen"]'); await co.waitForTimeout(300);
      ok(await ev(co, () => { const l = document.querySelector("#clsadd .addlist"), h = l.querySelectorAll("h3"), rows = [...l.querySelectorAll(".trow")].map((b) => b.querySelector(".nm").textContent);
        return h[0] && h[0].textContent === "Usually here" && ["Ana Lima", "Ben Cole"].every((n) => rows.slice(0, 2).some((r) => r.startsWith(n))); }), "the add list starts with Usually here");
      await co.tap('#clsadd [data-a="clsusual"]'); await co.waitForTimeout(1200);
      ok(await ev(co, () => S.ui.classData.attendees.filter((a) => a.attended).length === 2 && /Marked 2 here/.test(document.getElementById("toast").textContent)), "one tap marks both here, to untick anyone who isn't");
      // search: no accents needed, parents' names and phone numbers work
      await ev(co, () => { hideSheet(); COACH.stuView = "list"; coachGo("members"); }); await co.waitForTimeout(500);
      const shown = (q) => co.fill("#r-q", q).then(() => ev(co, () => [...document.querySelectorAll("#roster-list .trow:not([hidden]) .nm")].map((x) => x.textContent)));
      ok((await shown("ane")).some((n) => /Ané-Marié/.test(n)), "searching ane finds Ané-Marié");
      ok((await shown("sibonis")).some((n) => /Sìbọ̀nìsọ̀/.test(n)) && (await shown("zodwa")).some((n) => /Sìbọ̀nìsọ̀/.test(n)), "accents don't matter, and a parent's name finds the kid");
      ok((await shown("082 001 0001")).some((n) => /Ané-Marié/.test(n)) && (await shown("0010001")).length === 1, "a phone number finds them");
      await co.fill("#r-q", ""); await ev(co, () => { COACH.q = ""; render(); });
      ok(await ev(co, () => document.documentElement.scrollWidth <= 390), "a 60-letter name with no spaces wraps instead of pushing the page sideways");
      ok(await ev(co, (id) => { const p = students().find((x) => x.id === id); return p.name === "E".repeat(79) + "😀"; }, ids.emo), "an 80-character name ending in an emoji keeps the whole emoji");
      // Muay Thai gets no BJJ advice; BJJ still does
      await ev(co, (id) => api("PUT", `/coach/classes/${id}/attendance`, { userId: students().find((x) => x.name === "Ana Lima").id, going: true, attended: false }), ids.mt);
      await ev(co, (id) => classSheet(id), ids.mt); await co.waitForTimeout(700);
      ok(await ev(co, () => { const t = document.getElementById("sheet").innerText; return /Ana Lima/.test(t) && !/Suggested focus/.test(t) && !/ready for/.test(t); }), "a Muay Thai class shows no BJJ suggestions or belt readiness");
      await ev(co, (id) => classSheet(id), soonId); await co.waitForTimeout(700);
      ok(await ev(co, () => /ready for/.test(document.getElementById("sheet").innerText)), "a BJJ class still does");
      // the notes box: tapping its label goes to the box, which is named
      await ev(co, () => { hideSheet(); classForm(); }); await co.waitForTimeout(300);
      await co.evaluate(() => { const d = document.querySelector("#c-notes").closest("details"); if (d) d.open = true; });
      await co.locator('label[for="c-notes"]').tap(); await co.waitForTimeout(100);
      ok(await ev(co, () => document.activeElement && document.activeElement.id === "c-notes" && document.getElementById("c-notes").labels[0].textContent === "Notes"), "tapping Notes goes to the notes box, not the mic, and the box is called Notes");
      ok(await ev(co, () => document.querySelector(".planbox summary").getBoundingClientRect().height >= 36), "Lesson plan (optional) is easy to tap");
      // Money's switch is a labelled group; settings checkboxes are full size; the WhatsApp button is readable
      await ev(co, () => { hideSheet(); COACH.moneyView = "month"; coachGo("money"); }); await co.waitForTimeout(400);
      ok(await ev(co, () => !document.querySelector('[role="tablist"]') && document.querySelector('[role="group"][aria-label="Money view"] [data-v="payments"][aria-pressed]')), "Money's switch is a group of pressed buttons, not a broken tablist");
      await ev(co, () => coachGo("gym")); await co.waitForTimeout(400);
      ok(await ev(co, () => ["g-show", "g-invite"].every((id) => { const r = document.getElementById(id).getBoundingClientRect(); return r.width >= 20 && r.height >= 20; })), "the Bookings checkboxes are full size");
      ok(await ev(co, () => getComputedStyle(document.getElementById("wa-go")).backgroundColor === "rgb(29, 119, 72)"), "the Open WhatsApp button uses the darker, readable green");
      // students: buttons say which class; days say what they are; the avatar's name starts with what it shows
      await ev(s1, async () => { hideSheet(); await loadClasses(true); S.ui.bcal = null; S.ui.bookView = "classes"; go("book"); }); await s1.waitForTimeout(700);
      ok(await ev(s1, () => [...document.querySelectorAll('.bookcard [data-a="rsvp"], .bookcard [data-a="checkin"]')].every((b) => { const c = API.classes.find((x) => x.id === b.dataset.v); return b.getAttribute("aria-label").startsWith(b.textContent.trim() + " " + c.title + ", "); })), "Book and Cancel buttons say which class and when");
      ok(await ev(s1, () => { const t = document.querySelector('.wday[aria-current="date"]'), l = t && t.getAttribute("aria-label"); return t && new RegExp("^" + new Date().getDate() + " \\w+day \\w+, \\d+ class").test(l); }), "today is marked as today, and its label starts with the date shown");
      await s1.locator(".wday").nth(3).tap(); await s1.waitForTimeout(200);
      ok(await ev(s1, () => document.querySelectorAll('.wday[aria-pressed="true"]').length === 1 && document.querySelectorAll(".wday")[3].getAttribute("aria-pressed") === "true"), "the picked day is pressed");
      ok(await ev(s1, () => document.querySelector(".avatar").getAttribute("aria-label") === "AL: your account and settings"), "the avatar's name starts with its initials");
      // an adult's Next class isn't the kids class; booking a kids class asks first
      ok(await ev(s1, (at) => { const was = API.classes; API.classes = [{ id: "k", title: "Kids BJJ", level: "Kids", startsAt: at[0], durationMin: 60, going: 0, capacity: 2 }, { id: "a", title: "Adult Fundamentals", startsAt: at[1], durationMin: 60, going: 0 }];
        const adult = nextClassCard(); API.me.kid = true; const kid = nextClassCard(); delete API.me.kid; API.classes = was; return /Adult Fundamentals/.test(adult) && !/Kids BJJ/.test(adult) && /Kids BJJ/.test(kid); }, [at(60), at(120)]), "an adult's Next class is the adults' class, a kid's is the kids class");
      await ev(s3, async () => { hideSheet(); await loadClasses(true); }); await ev(s3, (id) => doBook(id, true), ids.kids); await s3.waitForTimeout(300);
      ok(await ev(s3, () => S.ui.sheet && S.ui.sheet.k === "kidsask" && /This is a kids class/.test(document.getElementById("sheet").innerText)), "booking a kids class asks first");
      await s3.tap('#sheetbar [data-a="rsvpsure"]'); await s3.waitForTimeout(1200);
      ok(await ev(s3, (id) => API.classes.find((c) => c.id === id).myGoing, ids.kids), "Book anyway books it");
      // signed out: Sign in and Forgot your password are big enough to tap
      const out = await phone("out"); await out.goto(URL + "/app/"); await out.waitForTimeout(900); await ev(out, () => { if (S.ui.sheet) hideSheet(); render(); });
      ok(await ev(out, () => { const b = document.querySelector('.top [data-a="auth"]'); return b && b.getBoundingClientRect().height >= 34; }), "the header Sign in is a proper tap target (it was 25px)");
      await ev(out, () => { S.ui.authMode = "login"; authSheet(); }); await out.waitForTimeout(300);
      ok(await ev(out, () => document.querySelector('[data-v="forgot"]').getBoundingClientRect().height >= 40), "Forgot your password? is a proper tap target");
      // a member opens another gym's invite link: Move or Stay, in one tap
      await out.goto(URL + "/app/?start=1"); await out.waitForTimeout(900); for (const [k, v] of [["#a-gym", "Other Gym"], ["#a-name", "Coach Oz"], ["#a-email", "oz@other.test"], ["#a-pass", "ozpass1234"]]) await out.fill(k, v);
      await out.tap("#sheetbar [type=submit]"); await out.waitForTimeout(1500); const code2 = await ev(out, () => API.me.gym.studentCode); await out.context().close();
      await s2.goto(URL + "/app/?join=" + code2); await s2.waitForTimeout(1500);
      ok(await ev(s2, () => /Move from Race Gym to Other Gym\?/.test(document.getElementById("sheet").innerText) && /Stay/.test(document.getElementById("sheetbar").innerText)), "opening another gym's invite link asks: Move from Race Gym to Other Gym?");
      await s2.tap('#sheetbar [data-a="joingym"]'); await s2.waitForTimeout(1200);
      ok(await ev(s2, () => API.me.gym.name === "Other Gym" && /joined Other Gym/.test(document.getElementById("toast").textContent)), "Move moves them there in one tap");
    }
    // --- bad signal, double taps, signed out mid-form, the Back button, new versions, Home on slow 3G
    {
      const logs = async () => (await pool.query("select id, data from training_logs where user_id=(select id from users where email='ana@race.test')")).rows;
      const stu = await phone("stu"); await stu.goto(URL + "/app/?signin=1"); await stu.waitForTimeout(900);
      await stu.fill("#a-email", "ana@race.test"); await stu.fill("#a-pass", "anapass11"); await stu.tap("#sheetbar [type=submit]"); await stu.waitForTimeout(1500);
      await ev(stu, () => { if (S.ui.sheet) hideSheet(); go("journal"); });
      const logIt = async (p, worked) => { await ev(p, (w) => { S.ui.form = newForm(); S.ui.form.worked = w; logSheet(); }, worked); await p.waitForTimeout(200); await p.tap("#sheetbar [type=submit]"); await p.waitForTimeout(700); };
      // No signal: the session is kept on the phone and sent later; the note says so too.
      const n0 = (await logs()).length;
      await stu.context().setOffline(true); await logIt(stu, "Underhook worked");
      ok(/Saved on this phone/.test(await toast(stu)) && (await ev(stu, () => S.sessions.some((s) => s.worked === "Underhook worked") && JSON.parse(localStorage.getItem("rtb.pending")).length === 1)), "a session logged without signal is kept on the phone, waiting to sync: " + (await toast(stu)));
      const sid = await ev(stu, () => S.sessions.find((s) => s.worked === "Underhook worked").id);
      await ev(stu, (id) => tagSheet(id, "note"), sid); await stu.fill("#tag-note", "Ask coach about the underhook"); await stu.waitForTimeout(1200);
      ok(await ev(stu, () => /sync when you're back online/.test(document.getElementById("tag-st").textContent) && JSON.parse(localStorage.getItem("rtb.sessions")).some((s) => s.worked === "Ask coach about the underhook")), "a note typed without signal is on the phone, and the sheet doesn't claim it's saved");
      await stu.context().setOffline(false); await stu.reload(); await stu.waitForTimeout(1800);
      ok((await logs()).length === n0 + 1 && (await logs()).some((r) => r.id === sid && r.data.worked === "Ask coach about the underhook") && (await ev(stu, () => !JSON.parse(localStorage.getItem("rtb.pending") || "[]").length)), "opening the app with signal sends them to the account");
      await ev(stu, () => { if (S.ui.sheet) hideSheet(); });
      await stu.context().setOffline(true); await logIt(stu, "Offline again"); await stu.context().setOffline(false); await stu.waitForTimeout(1500);
      ok((await logs()).some((r) => r.data.worked === "Offline again"), "and when signal comes back while it's open, they go by themselves");
      // A double tap on Save with a slow line logs one session (the button is off while saving).
      const n1 = (await logs()).length;
      await stu.route("**/api/logs/**", async (r) => { await wait(600); await r.continue(); });
      await ev(stu, () => { S.ui.form = newForm(); logSheet(); }); await stu.waitForTimeout(200);
      const mid = await ev(stu, async () => { const b = document.querySelector("#sheetbar [type=submit]"); b.click(); await new Promise((r) => setTimeout(r, 120)); const st = b.disabled && b.textContent === "Saving…"; b.click(); return st; });
      await stu.waitForTimeout(1500); await stu.unroute("**/api/logs/**");
      ok(mid && (await logs()).length === n1 + 1, "Save tapped twice logs one session, and says Saving… meanwhile");
      // Signed out while filling in a form: sign in on top, the form comes back, and the save goes through.
      { const tok = (await stu.context().cookies()).find((c) => c.name === "jf_s").value; await pool.query("update sessions set expires_at=now()-interval '1 second' where token_hash=$1", [require("crypto").createHash("sha256").update(tok).digest("hex")]); }
      await ev(stu, () => { S.ui.form = newForm(); S.ui.form.worked = "Kept text"; logSheet(); }); await stu.waitForTimeout(200); await stu.tap("#sheetbar [type=submit]"); await stu.waitForTimeout(800);
      ok(await ev(stu, () => /Sign in again/.test(document.getElementById("sheet").innerText) && document.getElementById("a-email").value === "ana@race.test"), "signed out mid-save: the sign-in sheet opens on top, with the email filled in");
      await stu.tap('#sheetbar [data-a="back"]'); await stu.waitForTimeout(300);
      ok(await ev(stu, () => S.ui.sheet.k === "log" && document.getElementById("f-worked").value === "Kept text" && !document.querySelector("#sheetbar [type=submit]").disabled), "Cancel brings the form back as it was");
      await stu.tap("#sheetbar [type=submit]"); await stu.waitForTimeout(800); await stu.fill("#a-pass", "anapass11"); await stu.tap("#sheetbar [type=submit]"); await stu.waitForTimeout(1500);
      ok((await logs()).some((r) => r.data.worked === "Kept text") && /Session saved/.test(await toast(stu)) && (await ev(stu, () => !S.ui.sheet && API.me.email === "ana@race.test")), "after signing in, what they were saving is saved: " + (await toast(stu)));
      await stu.context().close();
      // The phone's Back button: back through the tabs, a sheet closes, and only then out of the app.
      const nav = await phone("nav"); await nav.goto(URL + "/"); await nav.goto(URL + "/app/"); await nav.waitForTimeout(900); await ev(nav, () => { if (S.ui.sheet) hideSheet(); render(); });
      for (const t of ["learn", "journal", "me"]) { await nav.tap(`nav.tabs [data-v="${t}"]`); await nav.waitForTimeout(150); }
      const back = async () => { await nav.goBack().catch(() => {}); await nav.waitForTimeout(300); return nav.evaluate(() => location.pathname === "/app/" ? S.ui.tab + (S.ui.sheet ? "+sheet" : "") : location.pathname).catch(() => "?"); };
      const t1 = await back(), t2 = await back();
      await ev(nav, () => techSheet(TECH[0].id)); await nav.waitForTimeout(200); await ev(nav, () => techSheet(TECH[1].id)); await nav.waitForTimeout(200);
      const t3 = await back(), t4 = await back(), t5 = await back(), t6 = await back();
      ok([t1, t2, t3, t4, t5, t6].join() === "journal,learn,learn+sheet,learn,home,/", "Back goes to the previous tab, closes sheets one step at a time, then leaves: " + [t1, t2, t3, t4, t5, t6].join());
      // An app left open gets a new version: quietly, and not while a sheet is open.
      await nav.goto(URL + "/app/"); await nav.waitForTimeout(900); await ev(nav, () => { if (S.ui.sheet) hideSheet(); render(); });
      await ev(nav, () => { window.__still = 1; verAt = 0; document.dispatchEvent(new Event("visibilitychange")); }); await nav.waitForTimeout(600);
      ok(await ev(nav, () => window.__still === 1 && !API.stale), "the same version: nothing happens");
      await ev(nav, () => { window.JF_BUILD = "old-build"; verAt = 0; techSheet(TECH[0].id); document.dispatchEvent(new Event("visibilitychange")); }); await nav.waitForTimeout(600);
      ok(await ev(nav, () => window.__still === 1 && API.stale === true), "a new version waits while a sheet is open");
      await nav.tap('#sheetbar [data-a="back"]'); await nav.waitForTimeout(1500);
      ok(await ev(nav, () => window.__still === undefined && /^\w+$/.test(window.JF_BUILD) && window.JF_BUILD !== "old-build"), "and the app reloads to it once the sheet is closed");
      await nav.context().close();
      // Two coaches, one class: an edit sends only what changed; a move made meanwhile isn't undone.
      const cls = await ev(co, async () => (await api("POST", "/classes", { title: "Edit me", startsAt: new Date(Date.now() + 5 * 864e5).toISOString(), capacity: 8, plan: { focus: "Guard" } })).class);
      await ev(co, (c) => { hideSheet(); S.ui.cplan = null; classForm(c); }, cls); await co.waitForTimeout(300);
      let sentBody = null; const onReq = (q) => { if (q.method() === "PUT" && /\/api\/classes\/\d+$/.test(q.url())) sentBody = q.postDataJSON(); }; co.on("request", onReq);
      await co.fill("#c-cap", "9"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1200); co.off("request", onReq);
      ok(sentBody && Object.keys(sentBody).sort().join() === "capacity,wasStartsAt" && sentBody.capacity === 9, "an edit sends only what changed: " + JSON.stringify(sentBody));
      const fresh = await ev(co, async (id) => (await api("GET", `/coach/classes/${id}`)).class, cls.id);
      await ev(co, (c) => { hideSheet(); S.ui.cplan = null; classForm(c); }, fresh); await co.waitForTimeout(300);
      const later = new Date(new Date(fresh.startsAt).getTime() + 3600e3);
      await pool.query("update classes set starts_at=$1 where id=$2", [later, cls.id]);
      await co.fill("#c-cap", "11"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1200);
      ok(/moved this class to .+ while you had it open/.test(await toast(co)) && (await ev(co, (t) => S.ui.sheet.k === "classform" && document.getElementById("c-cap").value === "11" && document.getElementById("c-time").value === fmtHM(t), later.toISOString())), "moved meanwhile: the coach is told, and the form shows the new time with their change kept: " + (await toast(co)));
      await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1200);
      { const row = (await pool.query("select capacity, starts_at, plan from classes where id=$1", [cls.id])).rows[0]; ok(row.capacity === 11 && row.starts_at.getTime() === later.getTime() && row.plan.focus === "Guard", "saving again keeps the new time"); }
      // Record payment tapped twice on a slow line: one payment.
      const p0 = Number((await pool.query("select count(*) from payments")).rows[0].count);
      await co.route("**/api/coach/payments", async (r) => { if (r.request().method() === "POST") await wait(600); await r.continue(); });
      await ev(co, () => { hideSheet(); paySheet(null); }); await co.waitForTimeout(300); await co.fill("#p-amt", "750");
      await ev(co, async () => { const b = document.querySelector("#sheetbar [type=submit]"); b.click(); await new Promise((r) => setTimeout(r, 120)); b.click(); });
      await co.waitForTimeout(2000); await co.unroute("**/api/coach/payments");
      ok(Number((await pool.query("select count(*) from payments")).rows[0].count) === p0 + 1, "Record payment tapped twice records one payment");
      // Home on a slow line: everything loads at once, and today's classes show before the roster arrives.
      await ev(co, () => { hideSheet(); coachGo("home"); });
      const starts = {}; const onStart = (q) => { const m = q.url().match(/\/api\/(coach\/roster|classes\?|coach\/payments|coach\/packs)/); if (m && !starts[m[1]]) starts[m[1]] = Date.now(); }; co.on("request", onStart);
      await co.route("**/api/coach/roster", async (r) => { await wait(2500); await r.continue(); });
      await co.reload(); await co.waitForTimeout(1500);
      ok(await ev(co, () => !COACH.roster && !!COACH.classes && !/Loading your gym/.test(document.getElementById("app").innerText) && /Needs you/i.test(document.getElementById("app").innerText) && /Loading…/.test(document.getElementById("app").innerText)), "Home draws with today's classes while the roster is still on its way");
      await co.waitForTimeout(2500); await co.unroute("**/api/coach/roster"); co.off("request", onStart);
      const spread = Math.max(...Object.values(starts)) - Math.min(...Object.values(starts));
      ok(Object.keys(starts).length === 4 && spread < 1000 && (await ev(co, () => !!COACH.roster && !/Loading…/.test(document.getElementById("app").innerText))), `roster, classes, payments and packs load together (${spread} ms apart), then Home fills in`);
    }
    // --- the weekly timetable: Every week is the default, and a booked class keeps its time until the coach moves it (one tap, everyone told)
    await ev(co, () => { hideSheet(); coachGo("schedule"); }); await co.waitForTimeout(300);
    await co.tap('[data-a="classnew"]'); await co.waitForTimeout(300); await co.fill("#c-title", "Weekly drills"); await co.fill("#c-time", "18:00");
    await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1200);
    ok(/on the calendar every \w+, 8 weeks ahead/.test(await toast(co)) && Number((await pool.query("select count(*) from classes where title='Weekly drills'")).rows[0].count) >= 7, "a new class repeats every week by default, 8 weeks ahead: " + (await toast(co)));
    const wFirst = (await pool.query("select id from classes where title='Weekly drills' order by starts_at limit 1")).rows[0].id, s1id = await ev(s1, () => API.me.id);
    await pool.query("insert into attendance(class_id,user_id,going) values($1,$2,true) on conflict do nothing", [wFirst, s1id]);
    await ev(co, () => coachGo("gym")); await co.waitForTimeout(300); await co.tap('[data-a="gymedit"]'); await co.waitForTimeout(300);
    const wRow = await ev(co, () => [...document.querySelectorAll('#gymeditform [name^="tt-title"]')].findIndex((x) => x.value === "Weekly drills"));
    ok(wRow >= 0, "the weekly class is on the gym's timetable in Gym details");
    const n1 = sink.mails.length, gymTime = "to_char(starts_at at time zone (select timezone from gyms where id=gym_id),'HH24:MI')";
    await co.fill(`[name="tt-start-${wRow}"]`, "19:15"); await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1500);
    ok(await ev(co, () => S.ui.sheet && S.ui.sheet.k === "ttheld" && /1 booking at the old time/.test(document.getElementById("sheet").innerText) && /at \d\d:\d\d → \w+days at 19:15/.test(document.getElementById("sheet").innerText)
      && /Move 1 booking and tell them/.test(document.querySelector('#sheetbar [data-a="ttapply"]').innerText)), "changing the time: the booked class waits, with 'Move 1 booking and tell them'");
    ok(Number((await pool.query(`select count(*) from classes where title='Weekly drills' and starts_at > now() and ${gymTime}='19:15'`)).rows[0].count) >= 6, "the classes nobody booked moved straight away");
    await wide2(co, "booked classes sheet");
    await co.tap('#sheetbar [data-a="ttapply"]'); await co.waitForTimeout(1200);
    ok(/Moved 1 class\. 1 person told\./.test(await toast(co)) && (await pool.query(`select ${gymTime} as t from classes where id=$1`, [wFirst])).rows[0].t === "19:15", "one tap moves it: " + (await toast(co)));
    await wait(300); ok(sink.mails.slice(n1).some((m) => /Changed: Weekly drills/.test(m.subject)), "and the person booked gets an email");
    ok(Number((await pool.query("select count(*) from attendance where class_id=$1 and user_id=$2 and going", [wFirst, s1id])).rows[0].count) === 1, "they're still booked");
    // --- Book my usual: last week's classes again, one tap (a student added straight to the database: this test has used up the sign-ups for one address)
    const gymId = await ev(co, () => API.me.gym.id), tok = require("crypto").randomBytes(32).toString("hex");
    const s4id = String((await pool.query("insert into users(gym_id,role,name,email,pass_hash) values($1,'student','Dee Usual','dee.usual@race.test','x') returning id", [gymId])).rows[0].id);
    await pool.query("insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '1 day')", [require("crypto").createHash("sha256").update(tok).digest("hex"), s4id]);
    const s4 = await phone("s4"); await s4.context().addCookies([{ name: "jf_s", value: tok, url: URL }]); await s4.goto(URL + "/app/"); await s4.waitForTimeout(1200);
    ok(await ev(s4, () => !!API.me && API.me.name === "Dee Usual"), "Dee is signed in");
    const hr = Math.floor(Date.now() / 36e5) * 36e5, mk = async (t, h) => (await pool.query("insert into classes(gym_id,title,starts_at,duration_min) values($1,$2,$3,60) returning id", [gymId, t, new Date(hr + h * 36e5)])).rows[0].id;
    const u1 = await mk("Usual roll", 26 - 168), u2 = await mk("Usual roll", 26), u3 = await mk("Usual roll", 27);
    await pool.query("insert into attendance(class_id,user_id,going,attended) values($1,$2,true,true)", [u1, s4id]);
    await ev(s4, async () => { hideSheet(); API.classes = null; go("book"); }); await s4.waitForTimeout(1200);
    ok(await ev(s4, () => /Book my usual \(1\)/.test(document.querySelector('[data-a="bookusual"]')?.innerText || "")), "a student who trained last week sees Book my usual (1)");
    await wide2(s4, "book my usual");
    await s4.tap('[data-a="bookusual"]'); await s4.waitForTimeout(1200);
    ok(/^Booked 1 class\. Undo$/.test(await toast(s4)) && !(await ev(s4, () => !!document.querySelector('[data-a="bookusual"]'))), "one tap books it, with one toast (with Undo), and the button goes: " + (await toast(s4)));
    ok(Number((await pool.query("select count(*) from attendance where user_id=$1 and going and class_id=$2", [s4id, u2])).rows[0].count) === 1 && !Number((await pool.query("select count(*) from attendance where user_id=$1 and class_id=$2", [s4id, u3])).rows[0].count), "the class at the same day and time, not the one an hour later");
    await s4.tap("#toast .toastbtn"); await s4.waitForTimeout(1200);
    ok(/Undone/.test(await toast(s4)) && !Number((await pool.query("select count(*) from attendance where user_id=$1 and going and class_id=$2", [s4id, u2])).rows[0].count), "Undo cancels the booking it made: " + (await toast(s4)));
    ok(!(await ev(s4, () => !!document.querySelector('[data-a="bookusual"]'))), "and a cancelled class isn't offered again as 'usual'");
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
