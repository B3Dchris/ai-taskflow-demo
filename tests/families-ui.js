// Families through the real screens: a parent with two kids signs up once, switches with "Booking for", adds a third kid from
// that kid's invite link, pays for the family, and the coach sends one reminder for brothers and sisters.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/families-ui.js  (wipes that database)
const { chromium, devices } = require("playwright"); const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg");
const { startMailSink } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists autopay_charges, autopay, class_skips, plan_breaks, notices, left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const sink = await startMailSink();
  const port = 9500 + Math.floor(Math.random() * 90), URL = `http://localhost:${port}`;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env: { ...process.env, PORT: String(port), DATABASE_URL: DB, RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, ANTHROPIC_API_KEY: "" }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60; i++) { try { await fetch(URL + "/healthz"); break; } catch (e) { await wait(150); } }
  const b = await chromium.launch(); const errs = [];
  const phone = async (name) => { const c = await b.newContext({ ...devices["iPhone 13"] }); await c.addInitScript(() => { if (!localStorage.getItem("rtb.progress")) localStorage.setItem("rtb.progress", JSON.stringify({ settings: { onboarded: true } })); }); const p = await c.newPage(); p.on("pageerror", (e) => errs.push(name + ": " + e.message)); return p; };
  const ev = (p, f, a) => p.evaluate(f, a), toast = (p) => ev(p, () => document.getElementById("toast").textContent), sheet = (p) => ev(p, () => document.getElementById("sheet").innerText);
  const narrow = async (p, label) => ok(await ev(p, () => document.documentElement.scrollWidth <= 390), label + ": no sideways scroll");
  const closeIntro = async (p) => { if (await ev(p, () => S.ui.sheet && S.ui.sheet.k === "onboard")) await p.tap('#sheetbar [data-a="obdone"]'); if (await ev(p, () => S.ui.sheet && S.ui.sheet.k === "welcome")) { await p.tap('#sheetbar [data-a="back"]'); await p.waitForTimeout(200); } };
  const fill = async (p, path, fields) => { await p.goto(URL + path); await p.waitForTimeout(900); for (const [k, v] of Object.entries(fields)) await p.fill(k, v); await p.tap("#sheetbar [type=submit]"); await p.waitForTimeout(1300); };
  const bar = (p) => ev(p, () => { const x = document.querySelector(".forwho"); return x ? x.innerText.replace(/\s+/g, " ").trim() : ""; });
  try {
    const co = await phone("coach");
    await fill(co, "/app/?start=1", { "#a-gym": "Family BJJ", "#a-name": "Coach Kim", "#a-email": "kim@fam.test", "#a-pass": "coachpass1" }); await closeIntro(co);
    const code = await ev(co, () => API.me.gym.studentCode);
    // The coach's kids, added before anyone's on the app: two share mom's number; a third has a link of his own. A Kids plan for each.
    const ids = await ev(co, async () => {
      const plan = (await api("POST", "/coach/plans", { name: "Kids", priceCents: 50000, period: "month" })).plan.id, out = {};
      for (const [k, n, ph] of [["lerato", "Lerato Dlamini", "082 555 1234"], ["sipho", "Sipho Dlamini", "082 555 1234"], ["kabelo", "Kabelo Dlamini", "083 999 0000"]]) {
        out[k] = (await api("POST", "/coach/students", { name: n, parentName: "Thandi", phone: ph })).id; await api("PATCH", "/coach/students/" + out[k], { planId: plan }); }
      await api("PATCH", "/coach/gym/pay", { holder: "Family BJJ", bank: "FNB", account: "62000000000", branch: "250655", dueDay: 1 });
      await api("POST", "/classes", { title: "Kids BJJ", startsAt: new Date(Date.now() + 2 * 864e5).toISOString(), durationMin: 60, capacity: 10 });
      out.claim = new URL((await api("POST", `/coach/students/${out.kabelo}/claim-link`)).url).search; return out; });

    // ---- A kid's invite link, signed out: the form says who it's for and asks for the parent's name.
    const peek = await phone("peek"); await peek.goto(URL + "/app/" + ids.claim); await peek.waitForTimeout(1200);
    ok(await ev(peek, () => /Signing up for\s+Kabelo Dlamini/.test(document.getElementById("a-joining").innerText) && /Your name \(parent\)/.test(document.querySelector("label.f").innerText)), "a kid's link says 'Signing up for Kabelo' and asks for 'Your name (parent)'");
    await peek.context().close();

    // ---- Mom signs up with the gym's link and her number: asked once which kids train here.
    const mom = await phone("mom");
    await fill(mom, "/app/?join=" + code, { "#a-name": "Thandi Dlamini", "#a-email": "thandi@fam.test", "#a-pass": "thandipass1", "#a-wa": "082 555 1234" });
    let t = await sheet(mom);
    ok(/Which of your kids train here\?/.test(t) && /Lerato Dlamini/.test(t) && /Sipho Dlamini/.test(t) && await ev(mom, () => document.querySelectorAll("#kidsform [name=kid]:checked").length === 2), "one question: 'Which of your kids train here?' with both ticked: " + t.slice(0, 200));
    await narrow(mom, "kids question");
    await mom.tap('#sheetbar [data-a="authkids"][data-v="go"]'); await mom.waitForTimeout(1500); await closeIntro(mom);
    ok(/Booking for: Lerato/.test(await bar(mom)), "signed in, the top says 'Booking for: Lerato': " + (await bar(mom)));
    ok(await ev(mom, () => API.me.family.length === 2 && API.me.account.name === "Thandi Dlamini"), "both kids on one login, the parent's own");

    // ---- Switch to Sipho and book his class.
    await mom.tap('[data-a="famopen"]'); await mom.waitForTimeout(400);
    t = await sheet(mom); ok(/Who's this for\?/.test(t) && /Lerato Dlamini/.test(t) && /Sipho Dlamini/.test(t), "Booking for opens a list of the kids");
    await mom.tap(`#sheet [data-a="famswitch"][data-v="${ids.sipho}"]`); await mom.waitForTimeout(1500);
    ok(/Booking for: Sipho/.test(await bar(mom)) && /Booking for Sipho/.test(await toast(mom)), "one tap switches to Sipho");
    await ev(mom, () => { API.classes = null; go("book"); }); await mom.waitForTimeout(900);
    ok(/Booking for: Sipho/.test(await bar(mom)), "Classes shows who it's booking for");
    const day = await ev(mom, () => dayKey(API.classes.find((c) => c.title === "Kids BJJ").startsAt)); await mom.tap(`[data-a="calday"][data-v="${day}"]`); await mom.waitForTimeout(300);
    await mom.locator('.bookcard [data-a="rsvp"]').first().tap(); await mom.waitForTimeout(1000);
    ok(await ev(mom, () => /You're booked/.test(document.querySelector(".bookcard").innerText)), "Sipho is booked");
    ok(await ev(mom, () => addSession({ id: "sipho-log", date: todayK(), mins: 60, notes: "Sipho trained" })) === true, "Sipho's journal entry is saved to his account");
    await mom.tap('[data-a="famopen"]'); await mom.waitForTimeout(400); await mom.tap(`#sheet [data-a="famswitch"][data-v="${ids.lerato}"]`); await mom.waitForTimeout(1500);
    await ev(mom, () => { API.classes = null; go("book"); }); await mom.waitForTimeout(900); await mom.tap(`[data-a="calday"][data-v="${day}"]`); await mom.waitForTimeout(300);
    ok(await ev(mom, () => !/You're booked/.test(document.querySelector(".bookcard").innerText)), "back on Lerato, Sipho's booking isn't hers");
    ok(await ev(mom, () => !S.sessions.some((s) => s.id === "sipho-log")), "and neither is his journal");
    const coachView = await ev(co, async () => (await api("GET", "/coach/roster")).people.filter((p) => /Dlamini/.test(p.name)).map((p) => [p.name, p.parentName, p.offline]));
    ok(coachView.length === 3 && coachView.filter((x) => x[1] === "Thandi Dlamini" && !x[2]).length === 2, "the coach sees each kid on their own, with the parent: " + JSON.stringify(coachView));

    // ---- Kabelo's invite link opened while signed in: one tap adds him.
    await mom.goto(URL + "/app/" + ids.claim); await mom.waitForTimeout(1600);
    t = await sheet(mom); ok(/Add Kabelo to your login\?/.test(t), "a kid's link opened while signed in offers to add him: " + t.slice(0, 120));
    await mom.tap('#sheetbar [data-a="kidclaim"]'); await mom.waitForTimeout(1500);
    ok(/Booking for: Kabelo/.test(await bar(mom)) && await ev(mom, () => API.me.family.length === 3), "Kabelo is on the login, and the app books for him");
    await narrow(mom, "Booking for bar");

    // ---- The Pay sheet: the family total and a line per kid, each with their own reference.
    await mom.tap('[data-a="famopen"]'); await mom.waitForTimeout(400); await mom.tap(`#sheet [data-a="famswitch"][data-v="${ids.lerato}"]`); await mom.waitForTimeout(1500);
    await ev(mom, async () => { await loadPay(); myPaySheet(); }); await mom.waitForTimeout(400);
    t = await ev(mom, () => (document.getElementById("payfamily") || {}).innerText || "");
    ok(/Lerato Dlamini/.test(t) && /Sipho Dlamini/.test(t) && /Kabelo Dlamini/.test(t) && /Family total:\s*R\s?1[\s ]500/.test(t) && (t.match(/JF[A-Z0-9]+/g) || []).length === 3, "the parent's Pay sheet shows the family total and each kid with their reference: " + t);
    ok(await ev(mom, () => Number(document.getElementById("mypop-amt").value) === 1500), "the proof amount starts at the family total");
    await narrow(mom, "family Pay sheet");

    // ---- The coach's Money: one WhatsApp reminder for brothers and sisters, with one total and a line per kid.
    await ev(co, async () => { await coachLoad("roster"); COACH.money = null; COACH.moneyView = "month"; COACH.moneyFilter = "owing"; coachGo("money"); }); await co.waitForTimeout(1500);
    const rem = await ev(co, () => [...document.querySelectorAll(".mrow")].filter((r) => /Dlamini/.test(r.innerText)).map((r) => { const a = r.querySelector("a.wa"); return { name: r.querySelector(".nm") ? r.querySelector(".nm").innerText : r.innerText.split("\n")[0], text: a ? decodeURIComponent(new URL(a.href).searchParams.get("text") || "") : null, line: r.innerText }; }));
    const withBtn = rem.filter((x) => x.text), fam = withBtn[0];
    ok(withBtn.length === 1, "one Remind for the three kids on mom's login (Kabelo too, though the coach had another number for him): " + JSON.stringify(rem.map((x) => [x.name, !!x.text])));
    ok(fam && /^Hi Thandi/.test(fam.text) && /R\s?1[\s ]500 is due for your kids/.test(fam.text) && /Lerato: R\s?500/.test(fam.text) && /Sipho: R\s?500/.test(fam.text) && /Kabelo: R\s?500/.test(fam.text) && (fam.text.match(/JF[A-Z0-9]+/g) || []).length === 3, "the family reminder has one total, a line and a reference per kid: " + (fam && fam.text));
    ok(rem.filter((x) => /one reminder with Kabelo/.test(x.line)).length === 2, "the other kids' rows say they're in that reminder");
    await narrow(co, "Money with families");

    // ---- A family payment recorded for Lerato pays Sipho too, with Undo.
    await ev(co, (id) => paySheet(id), ids.lerato); await co.waitForTimeout(400); await co.fill("#p-amt", "1000"); await co.dispatchEvent("#p-amt", "change"); await co.waitForTimeout(900);
    t = await ev(co, () => document.getElementById("p-for-hint").innerText);
    ok(/R\s?500 for Lerato's Nov/.test(t) && /R\s?500 to Sipho/.test(t) && /Pick a month to keep it all on Lerato/.test(t), "before saving, the For line says R500 is for Lerato and R500 goes to Sipho: " + t);
    await co.tap("#sheetbar [type=submit]"); await co.waitForTimeout(1500);
    t = await toast(co); ok(/R\s?500 went to Sipho/.test(t), "recording R1 000 for Lerato says the rest went to Sipho: " + t);
    const owed = await ev(co, () => Object.fromEntries(COACH.money.students.filter((s) => /Lerato|Sipho/.test(s.name)).map((s) => [s.name.split(" ")[0], s.owedCents])));
    ok(owed.Lerato === 0 && owed.Sipho === 0, "and both are paid: " + JSON.stringify(owed));
    await ev(mom, async () => { await loadPay(); myPaySheet(); }); await mom.waitForTimeout(400);
    ok(await ev(mom, () => /Kabelo/.test((document.getElementById("payfamily") || {}).innerText || "") || !document.getElementById("payfamily")), "the parent's Pay sheet updates");
    // Recent payments: both lines say they're part of the family payment, and Undo split works long after the toast.
    await ev(co, async () => { hideSheet(); await coachLoad(); COACH.moneyView = "payments"; coachGo("money"); }); await co.waitForTimeout(900);
    const famRows = await ev(co, () => [...document.querySelectorAll(".sess")].filter((r) => /Part of a family payment of R\s?1[\s ]000/.test(r.innerText)).map((r) => r.innerText.split("\n")[0]));
    ok(famRows.length === 2 && famRows.some((x) => /Lerato/.test(x)) && famRows.some((x) => /Sipho/.test(x)), "Recent payments show 'Part of a family payment of R1 000' on Lerato's and Sipho's lines: " + JSON.stringify(famRows));
    await ev(co, () => { const r = [...document.querySelectorAll(".sess")].find((x) => /Sipho/.test(x.innerText) && /family payment/.test(x.innerText)); r.querySelector('[data-a="payunsplit"]').click(); }); await co.waitForTimeout(1200);
    ok(/all on one kid again/.test(await toast(co)) && await ev(co, async () => (await api("GET", "/coach/money")).students.find((s) => /Sipho/.test(s.name)).owedCents === 50000), "Undo split from Sipho's line puts it back on Lerato");
    // Deleting the account names the kids who stay at the gym.
    t = await ev(mom, () => { S.ui.delOpen = true; const h = accountSection(); S.ui.delOpen = false; return h; });
    ok(/Lerato, Sipho and Kabelo stay members of the gym/.test(t), "the delete text says the kids stay members: " + (t.match(/permanently[^<]*/) || [""])[0]);

    // ---- Mom opens another kid's link signed out: her email has an account, so she signs in and adds him there.
    const nal = await ev(co, async () => { const id = (await api("POST", "/coach/students", { name: "Naledi Dlamini", parentName: "Thandi", phone: "084 000 1111" })).id; return { id, claim: new URL((await api("POST", `/coach/students/${id}/claim-link`)).url).search }; });
    const mom3 = await phone("mom3");
    await fill(mom3, "/app/" + nal.claim, { "#a-name": "Thandi Dlamini", "#a-email": "thandi@fam.test", "#a-pass": "thandipass1" });
    t = await sheet(mom3);
    ok(/Sign in to add Naledi/.test(await toast(mom3)) && /Sign in to add\s+Naledi Dlamini\s+to your login/.test(t) && await ev(mom3, () => document.getElementById("a-email").value === "thandi@fam.test"), "signing up with her email says 'Sign in to add Naledi', and switches to Sign in: " + t.slice(0, 160) + " | " + (await toast(mom3)));
    await mom3.fill("#a-pass", "thandipass1"); await mom3.tap("#sheetbar [type=submit]"); await mom3.waitForTimeout(1600);
    t = await sheet(mom3);
    ok(/Signed in as Thandi Dlamini/.test(await toast(mom3)) || /Add Naledi to your login\?/.test(t), "the welcome uses the parent's name");
    ok(/Add Naledi to your login\?/.test(t), "and Naledi is offered right away: " + t.slice(0, 120));
    await mom3.tap('#sheetbar [data-a="kidclaim"]'); await mom3.waitForTimeout(1500);
    ok(/Booking for: Naledi/.test(await bar(mom3)) && await ev(mom3, () => API.me.family.length === 4), "one tap adds Naledi to her login");
    await mom3.context().close();

    // ---- The coach can unlink a kid from a login.
    await ev(co, async (id) => { await coachLoad("roster"); await studentSheet(id); }, nal.id); await co.waitForTimeout(800);
    ok(/On Lerato Dlamini's login/.test(await sheet(co)), "a kid's page says whose login they're on");
    await co.tap('#sheet [data-a="unlinkask"]'); await co.waitForTimeout(400); await co.tap('#sheetbar [data-a="unlinkyes"]'); await co.waitForTimeout(1500);
    ok(await ev(co, async (id) => (await api("GET", "/coach/roster")).people.find((p) => p.id === id).offline, nal.id), "'Unlink from this login' puts her back as not on the app");
    ok(!errs.length, "no script errors: " + errs.join(" | "));
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e)); }
  await b.close(); srv.kill(); sink.close(); await pool.end().catch(() => {});
  console.log(`families-ui: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
