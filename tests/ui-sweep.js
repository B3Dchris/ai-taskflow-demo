// Every screen, every role, five screen sizes, light and dark, with a busy gym's data:
// no script errors, nothing wider than the screen, the right tabs for each role, fast redraws,
// names containing HTML shown as text (never run), and the swipe-to-edit/delete gestures.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/ui-sweep.js   (wipes that database)
const { chromium, devices } = require("playwright"); const { spawn } = require("child_process"); const path = require("path"); const crypto = require("crypto"); const { Pool } = require("pg");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; if (fails.length < 60) fails.push(m); } };
const DAY = 864e5, wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const SIZES = [["iPhone SE", { ...devices["iPhone SE"] }], ["iPhone 13", { ...devices["iPhone 13"] }], ["Pixel 7", { ...devices["Pixel 7"] }], ["iPad Mini", { ...devices["iPad Mini"] }], ["Desktop", { viewport: { width: 1280, height: 800 } }]];
const XSS = `<img src=x onerror="window.__x=1">`;

(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const port = 9100 + Math.floor(Math.random() * 90), URL = `http://localhost:${port}`;
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB }; delete env.RESEND_API_KEY; delete env.ANTHROPIC_API_KEY; delete env.GA_ID;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60; i++) { try { await fetch(URL + "/healthz"); break; } catch (e) { await wait(150); } }
  const b = await chromium.launch();
  // No text sends people to tabs that no longer exist (Today, Settings, the Coach tab, a Classes tab for bank details).
  { const fs = require("fs"), src = ["../src/app.html", "../src/accounts.js", "../backend/api.js", "../backend/mail.js"].map((f) => fs.readFileSync(path.resolve(__dirname, f), "utf8")).join("\n");
    const old = src.split("\n").filter((l) => !/^\s*(\/\/|\/\*)/.test(l)).join("\n").match(/.{0,40}(Today screen|in Settings\.|Settings\.<|Classes tab|Coach tab)/g) || [];
    ok(!old.length, "no text names the old tabs: " + old.join(" | ")); }
  try {
    // ---- a busy gym
    const g1 = (await pool.query("insert into gyms(name,student_code,coach_code,profile) values($1,'STUDENT1','COACHAA1',$2) returning id",
      ["JPB Martial Arts Academy " + XSS, { timetable: [{ day: "Mon", start: "18:00", end: "19:00", title: "No-Gi " + XSS, coach: "JP", level: "" }], rates: [{ name: "Unlimited", price: 850, currency: "ZAR", period: "month", note: "" }], coaches: [{ name: "JP Buys", rank: "Black belt", bio: "" }], address: "Fourways", phone: "011 555 0101", notes: "" }])).rows[0].id;
    const hash = "$2a$11$" + "x".repeat(53);
    const mk = async (role, name, email, extra = "") => { const id = (await pool.query(`insert into users(gym_id,role,name,email,pass_hash,created_at,belt) values($1,$2,$3,$4,$5,now()-interval '150 days',$6) returning id`, [g1, role, name, email, hash, extra || "white"])).rows[0].id;
      const tok = crypto.randomBytes(32).toString("hex"); await pool.query("insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '1 day')", [sha(tok), id]); return { id: String(id), tok }; };
    const coach = await mk("coach", "Coach Kim", "kim@sweep.test");
    const studs = []; for (let i = 0; i < 120; i++) studs.push(await mk("student", i === 0 ? "Chris Buys" : i === 1 ? "Mallory " + XSS : `Student Number ${i} With A Long Name`, `s${i}@sweep.test`, ["white", "blue", "purple", "brown"][i % 4]));
    const plan = (await pool.query("insert into plans(gym_id,name,price_cents,period,classes_per_week) values($1,'2x a week',65000,'month',2) returning id", [g1])).rows[0].id;
    await pool.query("update users set plan_id=$1 where gym_id=$2 and role='student'", [plan, g1]);
    // private lessons: a pack bought, an access fee, and a private-only client
    const pack = (await pool.query("insert into packs(gym_id,name,lessons,price_cents,expiry_months) values($1,$2,10,450000,6) returning id", [g1, "10 privates " + XSS])).rows[0].id;
    await pool.query("insert into payments(gym_id,user_id,amount_cents,paid_on,pack_id,pack_lessons,pack_months) values($1,$2,450000,current_date-3,$3,10,6)", [g1, studs[0].id, pack]);
    await pool.query("update gyms set access_fee_cents=15000 where id=$1", [g1]); await pool.query("update users set plan_id=null where id=$1", [studs[2].id]);
    const coach2 = await mk("coach", "Coach Two", "two@sweep.test");
    const ids = [];
    for (let d = -90; d <= 40; d++) for (const h of [6, 12, 17, 18, 19]) { const t = new Date(Date.now() + d * DAY); t.setUTCHours(h, 0, 0, 0); ids.push((await pool.query("insert into classes(gym_id,title,starts_at,capacity,coach,level,kind,price_cents) values($1,$2,$3,$4,'JP','All levels',$5,$6) returning id, starts_at", [g1, h === 12 ? "Private " + XSS : "No-Gi All Levels " + (h === 19 ? XSS : ""), t, h === 12 ? 1 : 20, h === 12 ? "private" : "class", h === 12 ? 45000 : null])).rows[0]); }
    const vals = []; ids.forEach((c, i) => { const n = new Date(c.starts_at) < new Date() ? 12 : 18; for (let k = 0; k < n; k++) vals.push(`(${c.id},${studs[(i * 11 + k * 5) % 120].id},true,${new Date(c.starts_at) < new Date()})`); });
    for (let i = 0; i < vals.length; i += 3000) await pool.query("insert into attendance(class_id,user_id,going,attended) values " + vals.slice(i, i + 3000).join(",") + " on conflict do nothing");
    const comp = (await pool.query("insert into competitions(gym_id,name,starts_on,city,divisions) values($1,$2,current_date+20,'Johannesburg','[\"Adult blue -76kg\"]') returning id", [g1, "Gauteng Open " + XSS])).rows[0].id;
    for (let i = 0; i < 25; i++) await pool.query("insert into competitors(competition_id,user_id,status,division) values($1,$2,$3,'Adult blue -76kg')", [comp, studs[i].id, i % 5 === 0 ? "requested" : "entered"]);
    for (let i = 0; i < 60; i++) await pool.query("insert into payments(gym_id,user_id,amount_cents,paid_on,reference) values($1,$2,65000,current_date-$3::int,$4)", [g1, studs[i].id, i % 30, "REF " + i]);
    await pool.query("insert into training_logs(user_id,id,date,data) select $1, 'l'||g, current_date-g, jsonb_build_object('date', (current_date-g)::text, 'type','Class','mins',90,'rolls',5,'worked',$2::text) from generate_series(1,40) g", [studs[0].id, "Worked " + XSS]);

    const SCREENS = {
      anon: ["home", "learn", "learn-map", "learn-belt", "journal", "me"],
      student: ["home", "learn", "learn-map", "learn-belt", "journal", "classes", "classes:private", "classes:comps", "me"],
      coach: ["coach-home", "coach-schedule", "coach-schedule:month", "coach-members", "coach-members:insights", "coach-comps", "coach-money", "coach-money:payments", "coach-money:setup", "coach-gym"],
      study: ["home", "learn", "learn-map", "learn-belt", "journal", "me"],
      coach2: ["coach-home", "coach-schedule", "coach-members", "coach-members:insights", "coach-comps", "coach-gym"],
    };
    const roles = { anon: null, student: studs[0].tok, coach: coach.tok, study: coach.tok, coach2: coach2.tok };
    for (const [sizeName, dev] of SIZES) for (const scheme of ["light", "dark"]) for (const [role, tok] of Object.entries(roles)) {
      const ctx = await b.newContext({ ...dev, colorScheme: scheme });
      if (tok) await ctx.addCookies([{ name: "jf_s", value: tok, url: URL }]);
      await ctx.addInitScript((r) => { try { if (r === "study") localStorage.setItem("jf.coachMode", "study"); if (r === "anon") localStorage.setItem("rtb.progress", JSON.stringify({ settings: { onboarded: true } })); } catch (e) {} }, role);
      const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("dialog", (d) => { errs.push("dialog opened: " + d.message()); d.dismiss(); });
      await p.goto(URL + "/app/" + (role === "coach" || role === "coach2" ? "#coach-home" : "#today")); await p.waitForTimeout(1600);
      await p.evaluate(async () => { if (S.ui.sheet) { if (S.ui.sheet.k === "onboard") { P().settings.onboarded = true; saveProgress(); } hideSheet(); } });
      const tag = `${role} · ${sizeName} · ${scheme}`;
      const navOk = await p.evaluate((r) => { const vis = [...document.querySelectorAll("nav.tabs button")].filter((x) => !x.hidden).map((x) => x.dataset.v || x.dataset.a);
        if (r === "coach") return vis.join() === "coach-home,coach-schedule,coach-members,coach-money,coach-gym";
        if (r === "coach2") return vis.join() === "coach-home,coach-schedule,coach-members,coach-gym";
        if (r === "student") return vis.join() === "home,classes,learn,journal,me";
        if (r === "study") return vis.join() === "home,learn,journal,me" && /^Manage /.test(document.querySelector(".managebtn").textContent);
        return vis.join() === "home,learn,journal,me"; }, role);
      ok(navOk, `${tag}: the bottom bar shows the right tabs`);
      ok(await p.evaluate(() => { const h = document.querySelector("header.top"), b = h && h.querySelector(".brand"), r = h && h.querySelector(".row"); if (!b || !r) return false; const A = b.getBoundingClientRect(), B = r.getBoundingClientRect();
        return (A.right <= B.left + 1 || A.bottom <= B.top + 1) && [...document.querySelectorAll("nav.tabs button:not([hidden])")].every((x) => x.scrollWidth <= x.clientWidth + 1); }), `${tag}: header and tab labels fit without overlapping`);
      for (const scr of SCREENS[role]) {
        const [tab, sub] = scr.split(":");
        const ms = await p.evaluate(async ([tab, sub]) => { hideSheet(); if (sub === "month") calState("coach").mode = "month"; if (tab === "coach-schedule" && !sub) calState("coach").mode = "week";
          if (tab === "coach-members") COACH.stuView = sub === "insights" ? "insights" : "list"; if (tab === "classes") S.ui.bookView = sub || "classes"; if (tab === "coach-money") COACH.moneyView = sub || "month";
          const t = performance.now(); go(tab); return performance.now() - t; }, [tab, sub]);
        await p.waitForTimeout((tab === "coach-members" && sub === "insights") || (tab === "coach-money" && !sub) ? 1100 : 350);
        const r = await p.evaluate(() => ({ w: document.documentElement.scrollWidth, vw: innerWidth, len: document.getElementById("app").innerText.length, loading: /Loading/.test(document.getElementById("app").innerText.slice(0, 400)), x: !!window.__x, raw: /onerror=/.test(document.getElementById("app").innerText) ? 1 : 0 }));
        ok(r.w <= r.vw, `${tag} · ${scr}: nothing wider than the screen (${r.w} > ${r.vw})`);
        ok(r.len > 60 && !r.loading, `${tag} · ${scr}: screen has content (not stuck loading)`);
        ok(ms < 900, `${tag} · ${scr}: drew in ${Math.round(ms)} ms`);
        ok(!r.x, `${tag} · ${scr}: a name containing HTML didn't run`);
      }
      ok(!errs.length, `${tag}: no script errors ` + errs.slice(0, 3).join(" | "));
      await ctx.close();
    }

    // ---- HTML in names shows as text
    { const ctx = await b.newContext({ ...devices["iPhone 13"] }); await ctx.addCookies([{ name: "jf_s", value: coach.tok, url: URL }]); const p = await ctx.newPage(); await p.goto(URL + "/app/#coach-students"); await p.waitForTimeout(1500);
      ok(await p.evaluate(() => /Mallory <img src=x onerror/.test(document.getElementById("app").innerText) && !window.__x), "a student called Mallory <img…> appears as plain text on the roster");
      await ctx.close(); }

    // ---- swipes
    const touchSwipe = (p, sel, dx) => p.evaluate(({ sel, dx }) => { const el = document.querySelector(sel); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); const x0 = r.left + r.width / 2, y = r.top + r.height / 2;
      const T = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y }); el.dispatchEvent(new TouchEvent("touchstart", { touches: [T(x0)], changedTouches: [T(x0)], bubbles: true }));
      for (let i = 1; i <= 8; i++) { const t = T(x0 + (dx * i) / 8); el.dispatchEvent(new TouchEvent("touchmove", { touches: [t], changedTouches: [t], bubbles: true })); }
      el.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [T(x0 + dx)], bubbles: true })); }, { sel, dx });
    { const ctx = await b.newContext({ ...devices["iPhone 13"] }); await ctx.addCookies([{ name: "jf_s", value: coach.tok, url: URL }]); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
      await p.goto(URL + "/app/#coach-classes"); await p.waitForTimeout(800); await p.evaluate(async () => { hideSheet(); if (!COACH.classes) await coachLoad(); });
      const d = await p.evaluate(() => { const k = addDays2(todayK(), 2); const st = calState("coach"); st.sel = k; st.anchor = k; render(); return k; });
      ok(await p.evaluate(() => /swipe a class right to edit/.test(document.body.innerText)), "a first-time coach sees the swipe tip");
      await touchSwipe(p, ".calrows .swipe .sw-front", 140); await p.waitForTimeout(300);
      ok(await p.evaluate(() => { const w = document.querySelector(".calrows .swipe"); return w.classList.contains("open") && getComputedStyle(w.querySelector(".sw-edit")).visibility === "visible"; }), "swiping a class right reveals Edit");
      await p.locator(".calrows .swipe.open .sw-edit").tap(); await p.waitForTimeout(400);
      ok(await p.evaluate(() => S.ui.sheet && S.ui.sheet.k === "classform" && !!S.ui.sheet.id), "tapping Edit opens that class to edit");
      await p.evaluate(() => { hideSheet(); render(); });
      await touchSwipe(p, ".calrows .swipe .sw-front", -140); await p.waitForTimeout(300);
      ok(await p.evaluate(() => getComputedStyle(document.querySelector(".calrows .swipe.open .sw-del")).visibility === "visible"), "swiping a class left reveals Delete");
      const before = await p.evaluate(() => COACH.classes.length);
      await p.locator(".calrows .swipe.open .sw-del").tap(); await p.waitForTimeout(400);
      ok(await p.evaluate(() => S.ui.sheet && S.ui.sheet.k === "confirm" && /people have booked|person has booked|Nobody is booked/.test(document.getElementById("sheet").innerText)), "Delete asks first and says who'll be emailed");
      await p.tap('#sheetbar [data-a="close"]'); await p.waitForTimeout(300);
      ok(await p.evaluate((n) => COACH.classes.length === n, before), "Keep it leaves the class alone");
      await touchSwipe(p, ".calrows .swipe .sw-front", -140); await p.waitForTimeout(250);
      const gone = await p.evaluate(() => document.querySelector(".calrows .swipe.open .sw-del").dataset.v);
      await p.locator(".calrows .swipe.open .sw-del").tap(); await p.waitForTimeout(300);
      await p.tap('#sheetbar [data-a="classdelyes"]'); await p.waitForTimeout(1200);
      ok(await p.evaluate(async (id) => !COACH.classes.some((c) => c.id === id) && (await fetch(`/api/coach/classes/${id}`)).status === 404, gone), "confirming deletes it");
      await touchSwipe(p, ".calrows .swipe .sw-front", 20); await p.waitForTimeout(250);
      ok(await p.evaluate(() => !document.querySelector(".calrows .swipe.open")), "a short nudge doesn't open anything");
      const sx = await p.evaluate(() => { const f = document.querySelector(".calrows .swipe .sw-front"); const r = f.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; });
      await p.evaluate(() => { const el = document.querySelector(".calrows .swipe .sw-front"); const r = el.getBoundingClientRect(); const T = (x, y) => new Touch({ identifier: 2, target: el, clientX: x, clientY: y });
        el.dispatchEvent(new TouchEvent("touchstart", { touches: [T(r.left + 40, r.top + 10)], bubbles: true })); el.dispatchEvent(new TouchEvent("touchmove", { touches: [T(r.left + 46, r.top + 90)], bubbles: true })); el.dispatchEvent(new TouchEvent("touchend", { changedTouches: [T(r.left + 46, r.top + 90)], bubbles: true })); });
      ok(await p.evaluate(() => !document.querySelector(".calrows .swipe.open")), "scrolling up and down doesn't open a row");
      void sx; void d;
      // payments and competitions
      await p.evaluate(() => { COACH.moneyView = "payments"; coachGo("money"); }); await p.waitForTimeout(700);
      await touchSwipe(p, ".list .swipe .sw-front", -140); await p.waitForTimeout(250); await p.locator(".swipe.open .sw-del").tap(); await p.waitForTimeout(300);
      ok(await p.evaluate(() => S.ui.sheet && S.ui.sheet.k === "confirm" && /Delete this payment/.test(document.getElementById("sheet").innerText)), "swipe left on a payment asks to delete it");
      const pn = await p.evaluate(() => COACH.payments.length); await p.tap('#sheetbar [data-a="paydelyes"]'); await p.waitForTimeout(1200);
      ok(await p.evaluate((n) => COACH.payments.length === n - 1, pn), "and deletes it");
      await p.evaluate(() => coachGo("comps")); await p.waitForTimeout(900);
      await touchSwipe(p, ".swipe.cardsw .sw-front", 140); await p.waitForTimeout(250); await p.locator(".swipe.open .sw-edit").tap(); await p.waitForTimeout(300);
      ok(await p.evaluate(() => S.ui.sheet && S.ui.sheet.k === "compform"), "swipe right on a competition opens it to edit");
      ok(!errs.length, "no script errors while swiping " + errs.join(" | "));
      await ctx.close(); }
    { const ctx = await b.newContext({ ...devices["iPhone 13"] }); await ctx.addCookies([{ name: "jf_s", value: studs[0].tok, url: URL }]); const p = await ctx.newPage();
      await p.goto(URL + "/app/#log"); await p.waitForTimeout(1500); await p.evaluate(() => { hideSheet(); go("log"); }); await p.waitForTimeout(300);
      const n0 = await p.evaluate(() => S.sessions.length);
      await touchSwipe(p, ".swipe .sw-front", 140); await p.waitForTimeout(250); await p.locator(".swipe.open .sw-edit").tap(); await p.waitForTimeout(300);
      ok(await p.evaluate(() => S.ui.sheet && S.ui.sheet.k === "log"), "student swipes a session right to edit it");
      await p.evaluate(() => { hideSheet(); render(); });
      await touchSwipe(p, ".swipe .sw-front", -140); await p.waitForTimeout(250); await p.locator(".swipe.open .sw-del").tap(); await p.waitForTimeout(300);
      await p.waitForTimeout(900);
      ok(await p.evaluate((n) => S.sessions.length === n - 1 && !!document.querySelector('#toast [data-a="toastact"]'), n0), "and left to delete it (one tap, with Undo)");
      await ctx.close(); }
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e).toString().split("\n").slice(0, 4).join(" ")); }
  await b.close(); srv.kill(); await pool.end();
  console.log(`ui-sweep: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
