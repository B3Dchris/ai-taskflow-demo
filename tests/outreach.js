// Outreach: gyms built from their websites before anyone owns them, the email to the owner, the read-only preview of the real app
// their link opens (/app/?gym=<token>, and the older /try/<token>), claiming it, and the beta ("founding gyms").
// Usage: DATABASE_URL=postgres://.../<something>test node tests/outreach.js   (wipes that database)
const { spawn } = require("child_process"); const http = require("http"); const fs = require("fs"); const path = require("path"); const { Pool } = require("pg");
const { chromium, devices } = require("playwright");
const { startMailSink } = require("./fixture-gym");
const brand = require("../backend/brand"); const outreach = require("../backend/outreach"); const beta = require("../backend/beta");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(base) {
  let cookie = "";
  const c = async (method, url, body, headers = {}) => {
    const h = { ...headers }; if (cookie) h.cookie = cookie;
    if (method !== "GET") { h["content-type"] = "application/json"; if (!("x-jf" in headers)) h["x-jf"] = "1"; }
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = m[1] ? "jf_s=" + m[1] : ""; }
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { s: r.status, j, t, h: r.headers };
  };
  c.cookie = () => cookie;
  return c;
}

// A gym website: green buttons in its stylesheet (and greys, which don't count), a white theme-color (doesn't count either),
// a timetable, prices, coaches and a logo in the header.
const LOGO = fs.readFileSync(path.resolve(__dirname, "../web/icons/icon-192.png"));
const nav = `<header><img src="/img/logo.png" alt="Green Lions logo" class="logo"><nav><a href="/timetable">Timetable</a><a href="/pricing">Pricing</a><a href="/coaches">Coaches</a></nav></header>`;
const page = (title, body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta name="theme-color" content="#ffffff"><link rel="stylesheet" href="/site.css">${head}</head><body>${nav}<main>${body}</main></body></html>`;
const SITE = {
  "/": page("Home | Green Lions BJJ", `<h1>Green Lions BJJ</h1><p>Jiu-jitsu for adults and kids in Durbanville.</p><p><a href="mailto:hello@greenlions.test">hello@greenlions.test</a></p>`, `<meta property="og:site_name" content="Green Lions BJJ">`),
  "/timetable": page("Timetable | Green Lions BJJ", `<h3>Monday &amp; Wednesday</h3><p>06:00 - 07:00 No-Gi Fundamentals with Coach Thabo</p><p>18:00 - 19:30 No-Gi All Levels with Coach Anna</p>
    <table><tr><th>Day</th><th>Time</th><th>Class</th></tr><tr><td>Tuesday</td><td>17:00-17:45</td><td>Kids BJJ</td></tr><tr><td>Thursday</td><td>6pm - 7:30pm</td><td>Gi Fundamentals</td></tr><tr><td>Saturday</td><td>9am - 10:30am</td><td>Open Mat</td></tr></table>`),
  "/pricing": page("Pricing | Green Lions BJJ", `<h1>Membership</h1><div><h3>Adult unlimited</h3><p>R 850 per month</p></div><div><p>Kids (6-12): R600/month</p></div><p>Joining fee R 250 once-off</p>`),
  "/coaches": page("Coaches | Green Lions BJJ", `<h1>Our coaches</h1><h3>Thabo Nkosi</h3><p>Black belt, head coach</p><h3>Anna Smit</h3><p>Brown belt, instructor</p>`),
};
const CSS = `body{color:#222;background:#fff}.nav a{color:#333}.btn,.button{background:#1b7f3b;color:#fff}.cta{background-color:#1b7f3b}a:hover{color:#1b7f3b}.hero{border-color:#1b7f3b}h1{color:#111}.muted{color:#777}footer{background:#f5f5f5}`;
function startSite() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/img/logo.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(LOGO); }
      if (u.pathname === "/site.css") { res.writeHead(200, { "content-type": "text/css" }); return res.end(CSS); }
      const b = SITE[u.pathname]; if (!b) { res.writeHead(404, { "content-type": "text/html" }); return res.end("<h1>Not found</h1>"); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(b);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

(async () => {
  // ---------- colours, contrast and the small helpers (no server) ----------
  {
    const t = new Map(); brand.tallyCss(".a{color:#333;background:#fafafa}.b{background:#000}.btn{background:#c62828}.btn2{background-color:rgb(198, 40, 40)}.x{color:#0d6efd}", t);
    ok(brand.pick(t) === "#c62828" && !t.has("#333333") && !t.has("#fafafa") && !t.has("#000000") && !t.has("#0d6efd"), "colour: the brand colour wins; greys, near-white, near-black and framework defaults don't count: " + JSON.stringify([...t]));
    const css = { "http://site.test/a.css": ":root{--brand-primary:#6a1b9a}.btn{background:#6a1b9a}.n{color:#2e7d32}" };
    const got = await brand.fromSite(`<html><head><link rel="stylesheet" href="/a.css"><style>.z{color:#2e7d32}</style></head><body style="background:#fff"></body></html>`, "http://site.test/",
      { get: async (u) => ({ status: 200, body: Buffer.from(css[u] || "") }) });
    ok(got.accent === "#6a1b9a" && got.source === "site", "colour: read from the linked stylesheet, weighted by where it's used: " + JSON.stringify(got));
    const meta = await brand.fromSite(`<meta name="theme-color" content="#E65100"><style>.a{color:#2e7d32}</style>`, "http://site.test/", {});
    ok(meta.accent === "#e65100", "colour: the theme-color tag counts most: " + JSON.stringify(meta));
    const none = await brand.fromSite(`<meta name="theme-color" content="#ffffff"><style>.a{color:#444;background:#000}</style>`, "http://site.test/", {});
    ok(none.accent === brand.JF_ACCENT && none.source === "default", "colour: a black-and-white site falls back to JitsFlow's blue");
    const slow = Date.now(); await brand.fromSite(`<link rel="stylesheet" href="/slow.css">`, "http://site.test/", { get: () => new Promise(() => {}), budgetMs: 300 });
    ok(Date.now() - slow < 1500, "colour: a stylesheet that never answers can't hold up the import");
    const all = ["#ffeb3b", "#c6ff00", "#1b7f3b", "#e53935", "#00bcd4", "#ff9800", "#1d4fb5", "#9e9e9e"];
    ok(all.every((c) => brand.contrast(brand.button(c).bg, brand.button(c).fg) >= 4.5) && all.every((c) => brand.contrast(c, brand.textOn(c)) >= Math.min(4.5, Math.max(brand.contrast(c, "#ffffff"), brand.contrast(c, "#111722")))), "button text is readable (4.5:1) on every brand colour: " + all.map((c) => `${c}→${brand.button(c).bg}/${brand.button(c).fg}`).join(" "));
    ok(brand.button("#ffeb3b").fg !== "#ffffff" && brand.button("#1d4fb5").fg === "#ffffff", "yellow buttons get dark text, blue ones white");
    ok(brand.contrast(brand.ink("#00bcd4"), "#ffffff") >= 4.5, "the colour as text on white is darkened until it reads");
    const lines = outreach.parseLines("jpbuys.com/academy, JP Buys, JP@Example.com\nhttps://www.apexgym.co.za\n\nnot a site, someone");
    ok(lines.length === 3 && lines[0].url === "jpbuys.com/academy" && lines[0].name === "JP Buys" && lines[0].email === "jp@example.com" && lines[1].url === "https://www.apexgym.co.za" && !lines[2].url, "pasted lines: website, owner's name and email: " + JSON.stringify(lines));
    ok(JSON.stringify(outreach.imageSize(LOGO, "image/png")) === "[192,192]", "logo size read from the PNG header");
    ok(outreach.fromName({ name: "Chris Scott" }) === "Chris from JitsFlow" && outreach.fromName({ name: "  Thandi  " }) === "Thandi from JitsFlow", "From: the admin's first name only");
    ok(outreach.noObligation() === "3 months free. After that R99/month only if you want to keep going — no card needed to start, no contract, nothing charged unless you add a card.", "the no-obligation line: " + outreach.noObligation());
    // The beta's default deal: free for 6 months after acceptance, then R49 a month while in the beta (the switch-over day counts as paid).
    const d = beta.acceptDeal("2026-11-11");
    ok(d.feeCents === 0 && d.feeUntil === "2027-05-11" && d.afterCents === 4900, "beta: Accept defaults to free for 6 months, then R49: " + JSON.stringify(d));
    const B = { status: "accepted", ...d };
    ok(beta.priceFor(B, "2027-05-10", 9900) === 0 && beta.priceFor(B, "2027-05-11", 9900) === 4900 && beta.priceFor(B, "2028-01-01", 9900) === 4900, "beta: free until the day before, R49 from the switch-over day on");
    ok(beta.feeLine(B, "2026-11-11", 9900) === "Beta: free until 11 May 2027, then R49/month (instead of R99)" && beta.feeLine(B, "2027-06-01", 9900) === "Beta price R49/month (instead of R99)", "beta: the line the gym sees: " + beta.feeLine(B, "2026-11-11", 9900));
    ok(beta.priceFor({ ...B, status: "applied" }, "2026-11-11", 9900) === null && beta.priceFor({ status: "left", feeCents: 0 }, "2026-11-11", 9900) === null, "beta: only accepted gyms get the beta price");
    const c = beta.acceptDeal("2026-11-11", { feeCents: 2500, feeUntil: "2027-01-31" });
    ok(c.feeCents === 2500 && c.feeUntil === "2027-01-31" && c.afterCents === null && beta.priceFor({ status: "accepted", ...c }, "2027-02-01", 9900) === 9900 && beta.acceptDeal("2026-11-11", { feeCents: 0 }).feeUntil === null, "beta: a custom fee with an end date goes back to the normal price after it; free with no date stays free");
    ok(JSON.stringify(beta.readFeatures("Kiosk, grading sheets,, kiosk\n<b>x</b>")) === JSON.stringify(["kiosk", "grading-sheets", "b-x-b"]), "beta: feature flags are short, clean and unique: " + JSON.stringify(beta.readFeatures("Kiosk, grading sheets,, kiosk\n<b>x</b>")));
  }

  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists beta_feedback, prospects, outreach_dnc, autopay_charges, autopay, class_skips, plan_breaks, notices, left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const port = 9800 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${port}`, base = BASE + "/api";
  const site = await startSite(), sink = await startMailSink();
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB, JF_IMPORT_ALLOW_LOOPBACK: "1", RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, APP_URL: "https://www.jitsflow.test",
    JF_ADMIN_EMAILS: " Boss@JitsFlow.test, second@jitsflow.test ", MAIL_FROM: "JitsFlow <no-reply@jitsflow.test>" }; delete env.ANTHROPIC_API_KEY; delete env.GA_ID;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60; i++) { try { await fetch(BASE + "/healthz"); break; } catch (e) { await wait(150); } }
  const pub = (method, url, headers = {}) => fetch(BASE + url, { method, headers, redirect: "manual" }).then(async (r) => ({ s: r.status, t: await r.text(), h: r.headers }));
  const row = async (id) => (await pool.query("select * from prospects where id=$1", [id])).rows[0];
  const settle = async (admin) => { for (let i = 0; i < 120; i++) { const r = await admin("GET", "/admin/prospects"); if (r.j && !r.j.prospects.some((p) => p.importing)) return r.j.prospects; await wait(250); } return []; };
  let b;
  try {
    const admin = client(base), coach = client(base), anon = client(base), owner = client(base), stu = client(base);
    // ---------- who's an admin ----------
    let r = await admin("POST", "/auth/register", { name: "Boss Admin", email: "boss@jitsflow.test", password: "adminpass1" });
    ok(r.s === 201 && r.j.me.admin === true, "an email in JF_ADMIN_EMAILS (any case, spaces around it) is an admin");
    r = await coach("POST", "/auth/start-gym", { gym: "Some Gym", name: "Coach Kim", email: "kim@gym.test", password: "coachpass1" });
    ok(r.s === 201 && !r.j.me.admin, "a coach isn't an admin");
    r = await anon("GET", "/admin/prospects"); ok(r.s === 401, "admin routes need sign-in");
    for (const [m, u] of [["GET", "/admin/prospects"], ["POST", "/admin/prospects"], ["GET", "/admin/prospects/1"], ["PATCH", "/admin/prospects/1"], ["POST", "/admin/prospects/1/send"], ["POST", "/admin/prospects/1/followup"], ["POST", "/admin/prospects/1/reimport"], ["DELETE", "/admin/prospects/1"], ["GET", "/admin/prospects/1/email"]]) {
      r = await coach(m, u, m === "GET" ? undefined : { text: "x.com" }); ok(r.s === 403, `${m} ${u} is 403 for a coach (${r.s})`);
    }
    { const src = ["../backend/outreach.js", "../backend/api.js", "../backend/brand.js", "../server.js"].map((f) => fs.readFileSync(path.resolve(__dirname, f), "utf8")).join("\n");
      const lits = (src.match(/[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+/gi) || []).filter((x) => !/^(hello|no-reply)@jitsflow\.com$|^pop-|@example\.com$/.test(x));
      ok(/process\.env\.JF_ADMIN_EMAILS/.test(src) && !lits.length, "admins come from JF_ADMIN_EMAILS; no email address is written into the code: " + lits); }
    r = await admin("GET", "/admin/prospects"); ok(r.s === 200 && Array.isArray(r.j.prospects) && r.j.prospects.length === 0, "the admin sees the (empty) outreach list");
    r = await admin("POST", "/admin/prospects", { text: "x" }, { "x-jf": "" }); ok(r.s === 403, "adding needs the app's header like every other change");

    // ---------- prospects from websites, and the gyms built from them ----------
    r = await admin("POST", "/admin/prospects", { text: `http://127.0.0.1:${site.port}/, Thabo Nkosi, thabo@greenlions.test\nnot a website at all\nhttp://localhost:${site.port}/` }, { "x-jf-key": "add1" });
    ok(r.s === 201 && r.j.added.length === 2 && r.j.skipped.length === 1, "two websites added, the line that isn't one skipped: " + JSON.stringify(r.j));
    const [idA, idB] = r.j.added;
    r = await admin("POST", "/admin/prospects", { text: `http://127.0.0.1:${site.port}/` }, { "x-jf-key": "add2" });
    ok(r.s === 201 && !r.j.added.length && /on the list already/.test(r.j.skipped[0].why), "the same gym twice isn't added twice");
    let list = await settle(admin);
    const A = list.find((p) => p.id === idA);
    ok(A && A.name === "Green Lions BJJ" && A.label === "Gym built" && A.counts.classes >= 5 && A.counts.coaches === 2 && A.counts.rates >= 2, "imported: name, classes, coaches, prices: " + JSON.stringify(A && { n: A.name, l: A.label, c: A.counts }));
    ok(A && A.accent === "#1b7f3b", "the brand colour comes from the site's stylesheet (white theme-color ignored): " + (A && A.accent));
    ok(A && A.ownerName === "Thabo Nkosi" && A.ownerEmail === "thabo@greenlions.test" && A.logo && /\/try\/[A-Za-z0-9_-]{32}\/logo$/.test(A.logo), "owner name and email from the pasted line; logo hosted at the token's address");
    const rowA = await row(idA), tokA = rowA.token;
    ok(/^[A-Za-z0-9_-]{32}$/.test(tokA) && Buffer.from(tokA, "base64url").length * 8 >= 128 && rowA.token !== (await row(idB)).token, "the token is random and at least 128 bits");
    ok(rowA.token_hash === require("crypto").createHash("sha256").update(tokA).digest("hex"), "the link is looked up by the token's hash");
    ok(rowA.logo_type === "image/png" && rowA.logo.length === LOGO.length && rowA.subject === "Green Lions BJJ is already set up on JitsFlow", "logo stored as PNG; subject suggested");
    // Built straight after the import (no admin step): a real gym, owned by nobody.
    const gA = rowA.gym_id, gym = async (id) => (await pool.query("select * from gyms where id=$1", [id])).rows[0];
    let G0 = await gym(gA);
    ok(A.gym && A.gym.id === String(gA) && A.gym.unclaimed && A.appUrl === `/app/?gym=${tokA}`, "the import builds the gym by itself: " + JSON.stringify(A.gym));
    ok(G0 && G0.claim && G0.claim.prospectId === idA && G0.claim.builtAt && G0.head_coach_id === null && G0.name === "Green Lions BJJ", "the built gym: unclaimed, no head coach, the gym's name");
    ok(G0.logo && G0.logo.length === LOGO.length && G0.brand.accent === "#1b7f3b" && G0.monthly_fee_cents === 85000 && G0.profile.timetable.length >= 5 && G0.profile.timetable.every((x) => x.id) && G0.profile.coaches.length === 2, "the logo, colour, fee, timetable and coaches come through the import's own save");
    const plansA = (await pool.query("select name, price_cents from plans where gym_id=$1", [gA])).rows.map((p) => p.name + ":" + p.price_cents);
    ok(plansA.some((x) => /Adult unlimited:85000/.test(x)) && plansA.some((x) => /Kids.*:60000/.test(x)) && !plansA.some((x) => /Joining/.test(x)), "its prices are plans already: " + plansA);
    const nClassesA = Number((await pool.query("select count(*) from classes where gym_id=$1", [gA])).rows[0].count);
    ok(nClassesA >= 20, "its timetable is on its calendar (" + nClassesA + " classes)");
    ok(!G0.billing.trialEnds, "no free months start while nobody owns it");

    // ---------- an unclaimed gym is invisible and does nothing ----------
    r = await stu("POST", "/auth/register", { name: "Early Bird", email: "early@bird.test", password: "earlypass1", code: G0.student_code });
    ok(r.s === 404 && /isn't on JitsFlow yet/.test(r.j.error), "its student code doesn't work: " + (r.j && r.j.error));
    r = await anon("POST", "/auth/register", { name: "Early Coach", email: "earlyc@bird.test", password: "earlypass1", code: G0.coach_code });
    ok(r.s === 404 && /isn't on JitsFlow yet/.test(r.j.error), "nor its coach code");
    r = await anon("GET", "/gyms/by-code/" + G0.student_code); ok(r.s === 200 && r.j.gym === null, "looking its code up finds nothing");
    r = await stu("POST", "/auth/register", { name: "Lee Moodley", email: "lee@durban.test", password: "leepass123" });
    r = await stu("POST", "/me/join", { code: G0.student_code }); ok(r.s === 404 && /isn't on JitsFlow yet/.test(r.j.error) && !(await stu("GET", "/me")).j.me.gym, "joining it signed in is refused too");
    r = await anon("GET", `/gyms/${gA}/logo`); ok(r.s === 404, "its logo isn't served by gym id");
    { const cls = (await pool.query("select id from classes where gym_id=$1 limit 1", [gA])).rows[0].id;
      r = await coach("GET", `/coach/classes/${cls}`); ok(r.s === 404, "another gym's coach can't open its classes (" + r.s + ")");
      r = await coach("GET", "/classes"); ok(r.s === 200 && !r.j.classes.some((c) => /No-Gi Fundamentals|Kids BJJ|Open Mat/.test(c.title)), "nor see them on their calendar"); }
    r = await admin("GET", "/admin/overview?days=7");
    ok(r.j.totals.gyms === 1 && !r.j.gyms.some((g) => g.name === "Green Lions BJJ") && r.j.outreach.built === 2, "the dashboard doesn't count it as a gym; outreach shows it as built, not claimed: " + JSON.stringify(r.j.outreach) + " gyms " + r.j.totals.gyms);
    { const { rollAll } = require("../backend/db");
      await pool.query("update gyms set timetable_rolled=null"); await rollAll(pool);
      const rolled = (await pool.query("select timetable_rolled is not null as r from gyms where id=$1", [gA])).rows[0].r;
      const src = fs.readFileSync(path.resolve(__dirname, "../backend/api.js"), "utf8");
      ok(!rolled && /from gyms where auto_remind and claim is null/.test(src) && /g\.claim is null and exists \(select 1 from autopay/.test(src) && /pop_token=\$1 and g\.claim is null/.test(src),
        "no jobs run for it: not in the daily calendar roll, reminders, card payments or proof-of-payment email"); }

    // ---------- its link opens the real app, read only ----------
    r = await pub("GET", "/try/" + tokA);
    ok(r.s === 302 && r.h.get("location") === `/app/?gym=${tokA}` && /noindex/.test(r.h.get("x-robots-tag") || "") && r.h.get("cache-control") === "no-store", "the old /try/ link goes to the app's preview of the gym");
    r = await pub("GET", `/app/?gym=${tokA}`); ok(r.s === 200 && /JF_BUILD/.test(r.t), "the app opens for it");
    const pv = (method, url, body, extra = {}) => anon(method, url, body, { "x-jf-preview": tokA, ...extra });
    r = await pv("GET", "/me");
    ok(r.s === 200 && r.j.me.preview && r.j.me.preview.name === "Green Lions BJJ" && r.j.me.preview.email === "thabo@greenlions.test" && r.j.me.role === "coach" && r.j.me.gym.head === true && r.j.me.gym.id === String(gA) && r.j.me.id === "preview" && !r.j.me.email && !r.j.me.admin,
      "the link shows the gym as its head coach would see it (nobody signed in): " + JSON.stringify(r.j && r.j.me && { p: r.j.me.preview, g: r.j.me.gym && r.j.me.gym.id }));
    ok(r.j.me.gym.logo === `/try/${tokA}/logo` && /noindex/.test(r.h.get("x-robots-tag") || "") && r.h.get("cache-control") === "no-store", "its logo comes from the link; noindex, never cached");
    r = await pv("GET", "/classes"); ok(r.s === 200 && r.j.classes.length >= 5 && r.j.classes.some((c) => c.title === "No-Gi Fundamentals"), "Schedule: their classes on the calendar");
    r = await pv("GET", "/coach/roster"); ok(r.s === 200 && r.j.people.length === 0 && r.j.plans.length >= 2, "Members: empty; their plans");
    r = await pv("GET", "/coach/money"); ok(r.s === 200, "Money opens");
    r = await pv("GET", "/coach/billing"); const today = new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);
    ok(r.s === 200 && r.j.billing.trialEnds === beta.addMonths(today, 3) && r.j.billing.priceCents === 9900 && !(await gym(gA)).billing.trialEnds, "the plan says its free months would start today; nothing saved");
    r = await pv("GET", "/coach/gym/pay"); ok(r.s === 200 && !(await gym(gA)).pop_token, "payment settings open without making the gym an address");
    r = await pv("GET", "/gym"); ok(r.s === 200 && r.j.gym.profile.timetable.length >= 5 && r.j.gym.logo === `/try/${tokA}/logo`, "Gym: details and logo");
    const before = JSON.stringify([await gym(gA), (await pool.query("select count(*) from classes where gym_id=$1", [gA])).rows[0], (await pool.query("select count(*) from plans where gym_id=$1", [gA])).rows[0], (await pool.query("select count(*) from users")).rows[0]]);
    const writes = [["POST", "/coach/students", { name: "Sneaky", phone: "0821234567" }], ["POST", "/classes", { title: "Hack", startsAt: new Date(Date.now() + 864e5).toISOString() }], ["PUT", "/coach/gym/profile", { profile: { name: "Hacked" } }],
      ["PATCH", "/coach/gym", { name: "Hacked" }], ["DELETE", "/coach/gym", { password: "x" }], ["POST", "/coach/codes/rotate", { which: "student" }], ["POST", "/coach/plans", { name: "Free", priceCents: 0, period: "month" }],
      ["PATCH", "/coach/gym/pay", { account: "123" }], ["POST", "/coach/beta", { action: "apply" }], ["POST", "/coach/billing/checkout", {}], ["PUT", "/coach/payfast", { test: true }], ["POST", "/me/join", { code: G0.student_code }],
      ["PATCH", "/me", { name: "x" }], ["PUT", "/progress", { data: {} }], ["POST", "/auth/logout", {}], ["POST", "/me/claim-gym", { token: tokA }], ["POST", "/coach/import/start", { url: "x.com" }], ["DELETE", "/me", {}]];
    const refused = [];
    for (const [m, u, bd] of writes) { r = await pv(m, u, bd); if (!(r.s === 403 && r.j.preview === true && /Claim your gym first/.test(r.j.error))) refused.push(`${m} ${u}: ${r.s}`); }
    ok(!refused.length, "every change through the link is refused with Claim your gym first: " + refused.join(", "));
    for (const u of ["/coach/students/1", "/admin/prospects", "/admin/overview", "/me/pay", "/progress", "/logs", "/payments/1/proof"]) { r = await pv("GET", u); if (r.s !== 403) refused.push(`GET ${u}: ${r.s}`); }
    r = await admin("GET", "/admin/prospects", undefined, { "x-jf-preview": tokA }); if (r.s !== 403) refused.push("admin cookie + link: " + r.s);
    ok(!refused.length, "only the screens a head coach reads: other reads are refused, even with the team's own sign-in: " + refused.join(", "));
    ok(JSON.stringify([await gym(gA), (await pool.query("select count(*) from classes where gym_id=$1", [gA])).rows[0], (await pool.query("select count(*) from plans where gym_id=$1", [gA])).rows[0], (await pool.query("select count(*) from users")).rows[0]]) === before, "and nothing changed");
    { const kim = (await coach("GET", "/me")).j.me; await coach("POST", "/classes", { title: "Kim's class", startsAt: new Date(Date.now() + 2 * 864e5).toISOString() });
      const kc = (await pool.query("select id from classes where gym_id=$1 limit 1", [kim.gym.id])).rows[0].id;
      r = await pv("GET", `/coach/classes/${kc}`); ok(r.s === 404, "another gym's class can't be reached through the link (" + r.s + ")");
      r = await pv("GET", "/classes"); ok(!r.j.classes.some((c) => c.title === "Kim's class"), "nor seen on its calendar"); }
    r = await anon("GET", "/me", undefined, { "x-jf-preview": "x".repeat(32) }); ok(r.s === 404 && r.j.previewGone, "a wrong token is a 404");
    r = await anon("GET", "/me", undefined, { "x-jf-preview": tokA.slice(0, 31) + (tokA[31] === "A" ? "B" : "A") }); ok(r.s === 404, "one character off is a 404");
    r = await anon("GET", "/me", undefined, { "x-jf-preview": "short" }); ok(r.s === 404, "a malformed token is a 404");
    r = await anon("GET", "/prospects/" + tokA); ok(r.s === 200 && r.j.gym.built && r.j.gym.email === "thabo@greenlions.test" && r.j.gym.pitch.length === 5 && /no card needed to start/.test(r.j.gym.deal) && /R49\/month instead of R99/.test(r.j.gym.betaDeal), "the claim screen's look at it: built, the owner's email to fill in, the pitch, the deal");
    // The older page, for a gym that isn't built (yet).
    const S0 = (await pool.query(`insert into prospects(token,website,domain,name,profile,logo,logo_type,accent,import_state) select $1, website, 'static.test', name, profile, logo, logo_type, accent, 'done' from prospects where id=$2 returning id, token`, [outreach.newToken(), idA])).rows[0];
    r = await pub("GET", "/try/" + S0.token);
    const t = r.t, csp = r.h.get("content-security-policy") || "";
    ok(r.s === 200 && /This is Green Lions BJJ on JitsFlow/.test(t) && /No-Gi Fundamentals/.test(t) && /Thabo Nkosi/.test(t) && /R850 a month/.test(t), "not built: the page shows the gym's name, classes, coaches and prices");
    ok(t.includes(`src="/try/${S0.token}/logo"`) && t.includes("--acc:#1b7f3b"), "page: their logo and colour");
    ok(/<meta name="robots" content="noindex/.test(t) && /noindex/.test(r.h.get("x-robots-tag") || "") && r.h.get("cache-control") === "no-store", "page: noindex (tag and header), never cached");
    ok(/default-src 'self'/.test(csp) && /script-src 'self' 'unsafe-inline'/.test(csp) && !/<script[^>]+src=/.test(t) && ![...t.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].some((m) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com/.test(m[1])), "page: the site's security policy, and nothing loaded from elsewhere but fonts");
    ok(!/googletagmanager|analytics/.test(t), "page: no analytics");
    ok(t.includes(`/app/?gym=${S0.token}`) && /Claim Green Lions BJJ, free for 3 months/.test(t) && /R99\/month only if you want to keep going/.test(t) && /Apple Pay and Google Pay are coming soon/.test(t) && !/2% fee/.test(t), "page: the claim button, the no-obligation line, payments coming soon");
    await pool.query("delete from prospects where id=$1", [S0.id]);
    r = await pub("GET", `/try/${tokA}/logo`); ok(r.s === 200 && r.h.get("content-type") === "image/png", "logo served as PNG for email");
    r = await pub("GET", "/try/" + "x".repeat(32)); ok(r.s === 404 && /This page isn('|&#39;)t here/.test(r.t) && /noindex/.test(r.t), "unknown token: a friendly 404");
    r = await pub("GET", "/try/short"); ok(r.s === 404, "a malformed token is a 404 too");

    // ---------- counting views ----------
    const views = async () => (await row(idA)).views;
    ok((await views()) === 0, "opening the link (a GET, like an email scanner) counts nothing");
    const UA = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" };
    r = await pub("POST", `/try/${tokA}/view`, UA); ok(r.s === 403 && (await views()) === 0, "the beacon needs the page's header");
    await pub("POST", `/try/${tokA}/view`, { ...UA, "x-jf": "1", cookie: admin.cookie(), "x-forwarded-for": "10.0.0.1" }); ok((await views()) === 0, "the admin's own views don't count");
    await pub("POST", `/try/${tokA}/view`, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)", "x-jf": "1", "x-forwarded-for": "10.0.0.2" }); ok((await views()) === 0, "robots don't count");
    await pub("POST", `/try/${tokA}/view`, { ...UA, "x-jf": "1", "x-forwarded-for": "10.0.0.3" }); ok((await views()) === 1, "a real view counts");
    await pub("POST", `/try/${tokA}/view`, { ...UA, "x-jf": "1", "x-forwarded-for": "10.0.0.3" }); ok((await views()) === 1, "the same visitor again within 30 minutes counts once");
    await pub("POST", `/try/${tokA}/view`, { ...UA, "x-jf": "1", "x-forwarded-for": "10.0.0.4" }); ok((await views()) === 2, "another visitor counts");
    r = await admin("GET", "/admin/prospects"); ok(r.j.prospects.find((p) => p.id === idA).label === "Viewed 2×", "the list says Viewed 2×");

    // ---------- the email ----------
    r = await admin("PATCH", `/admin/prospects/${idA}`, { personalLine: "Congrats on the new mats in Durbanville!", subject: "Green Lions on JitsFlow" }); ok(r.s === 200, "admin edits the personal line and subject");
    r = await admin("PATCH", `/admin/prospects/${idA}`, { ownerEmail: "not an email" }); ok(r.s === 400, "a bad owner email is refused");
    r = await admin("GET", `/admin/prospects/${idA}`);
    const e = r.j.email;
    ok(e.subject === "Green Lions on JitsFlow" && /Hi Thabo,/.test(e.html) && /Congrats on the new mats in Durbanville!/.test(e.html) && /Green Lions BJJ is already set up on JitsFlow/.test(e.html), "email: subject, first name, personal line, headline");
    ok(/run Green Lions BJJ from your phone: less admin for you, and room to grow/.test(e.html) && /Members book classes themselves, with waitlists and check-in/.test(e.html) && /automatic reminders and EFT references\. Card, Apple Pay and Google Pay are coming soon\./.test(e.html)
      && /kids and parents, and coaches all in one place/.test(e.html) && /Already set up from your website/.test(e.html) && /Helps you grow: invite links and WhatsApp/.test(e.html), "email: what JitsFlow does for the gym, in five plain lines (payments: EFT now, card and Apple/Google Pay coming soon)");
    ok(e.html.includes(`https://www.jitsflow.test/try/${tokA}/logo`) && !/src="data:/.test(e.html) && e.html.includes(`href="https://www.jitsflow.test/app/?gym=${tokA}"`) && e.html.includes(`https://www.jitsflow.test/try/${tokA}/optout`), "email: hosted https logo (no data: URI), one button to their gym in the app, opt-out link");
    ok((e.html.match(/>See Green Lions BJJ on JitsFlow<\/a>/g) || []).length === 1 && !/<img(?![^>]*\/try\/[^>]*\/logo)/.test(e.html), "email: one button; no remote images but their logo");
    ok(/max-width:600px/.test(e.html) && /role="presentation"/.test(e.html) && /v:roundrect/.test(e.html) && !/<style[^>]*>[^<]*\.[a-z]+\s*\{[^}]*\}[^<]*<\/style>/.test(e.html.replace(/@media[^{]*\{[^}]*\{[^}]*\}[^}]*\}/g, "").replace(/:root\{[^}]*\}/g, "")), "email: 600px tables, inline styles, an Outlook-proof button");
    const rowsN = (e.html.match(/<tr><td style="font-family:Arial,Helvetica,sans-serif;padding:7px 0 7px 14px/g) || []).length;
    ok(rowsN >= 4 && rowsN <= 6 && /Green Lions BJJ &middot; Classes/.test(e.html) && />Book</.test(e.html), "email: a card like their Classes screen, with 4 to 6 of their real classes: " + rowsN);
    ok(/I found Green Lions BJJ on your public website \(127\.0\.0\.1\)/.test(e.html) && e.html.includes("<b>No obligation.</b> 3 months free. After that R99/month only if you want to keep going — no card needed to start, no contract, nothing charged unless you add a card."), "email: why they got it, and the no-obligation line");
    ok(/Join the JitsFlow beta\.<\/b> We build features for your gym and you pay less: free for your first 6 months in the beta, then R49\/month instead of R99/.test(e.html) && /short monthly check-in/.test(e.html), "email: the beta invitation");
    ok(e.html.indexOf("See Green Lions BJJ on JitsFlow") < e.html.indexOf("No obligation.") && e.html.indexOf("No obligation.") < e.html.indexOf("Join the JitsFlow beta") && e.html.indexOf("Join the JitsFlow beta") < e.html.indexOf("Thanks,"), "email: the button, then the no-obligation line, then the beta, then the sign-off");
    ok(/Thanks,<br>Boss Admin<br>and the JitsFlow team/.test(e.html) && /I(&#39;|')m Boss from JitsFlow\./.test(e.html), "email: introduced by first name, signed with the full name and the team");
    ok(/Hi Thabo,/.test(e.text) && /optout/.test(e.text) && e.text.includes(`See Green Lions BJJ on JitsFlow: https://www.jitsflow.test/app/?gym=${tokA}`) && !/</.test(e.text) && /\nThanks,\nBoss Admin\nand the JitsFlow team\n/.test(e.text)
      && /No obligation\. 3 months free/.test(e.text) && /Join the JitsFlow beta\./.test(e.text) && /Card, Apple Pay and Google Pay are coming soon/.test(e.text), "email: a plain-text version with the link, the deal, the beta, the sign-off and opt-out");
    ok(r.j.from === "Boss from JitsFlow" && r.j.replyTo === "boss@jitsflow.test", "email: from the admin's first name, replies to the admin");
    r = await admin("GET", `/admin/prospects/${idA}/email`); ok(r.s === 200 && /text\/html/.test(r.h.get("content-type")) && /Hi Thabo/.test(r.t), "the admin can open the rendered email in a tab");

    // ---------- sending ----------
    const before2 = sink.mails.length;
    const [s1, s2] = await Promise.all([admin("POST", `/admin/prospects/${idA}/send`, {}, { "x-jf-key": "send-a" }), admin("POST", `/admin/prospects/${idA}/send`, {}, { "x-jf-key": "send-a" })]);
    await wait(200);
    ok(s1.s === 200 && s2.s === 200 && sink.mails.length === before2 + 1, "a double tap on Send sends one email: " + [s1.s, s2.s, sink.mails.length - before2]);
    r = await admin("POST", `/admin/prospects/${idA}/send`, {}, { "x-jf-key": "send-b" }); ok(r.s === 409 && sink.mails.length === before2 + 1, "sending again is refused");
    const m = sink.mails[sink.mails.length - 1];
    ok(m.to[0] === "thabo@greenlions.test" && m.from === `"Boss from JitsFlow" <no-reply@jitsflow.test>` && m.reply_to === "boss@jitsflow.test", "sent to the owner, from the admin's first name at our address, replies to the admin: " + m.from + " / " + m.reply_to);
    ok(/Thanks,<br>Boss Admin<br>and the JitsFlow team/.test(m.html) && /\nBoss Admin\nand the JitsFlow team\n/.test(m.text), "the sent email is signed with the full name and the team");
    ok(m.subject === "Green Lions on JitsFlow" && m.html.includes(`/try/${tokA}/optout`) && /optout/.test(m.text) && /One-Click/.test(m.headers["List-Unsubscribe-Post"]) && m.headers["List-Unsubscribe"].includes(`/try/${tokA}/optout`), "the email carries the opt-out link and one-click unsubscribe headers");
    r = await admin("GET", "/admin/prospects"); const As = r.j.prospects.find((p) => p.id === idA);
    ok(As.status === "sent" && As.sentTo === "thabo@greenlions.test" && As.followupFrom && !As.followupReady, "status: sent, follow-up not yet");

    // ---------- the one follow-up ----------
    r = await admin("POST", `/admin/prospects/${idA}/followup`, {}, { "x-jf-key": "fu1" }); ok(r.s === 409 && /5 days/.test(r.j.error), "no follow-up before 5 days");
    await pool.query("update prospects set sent_at=now()-interval '6 days' where id=$1", [idA]);
    r = await admin("GET", `/admin/prospects/${idA}`); ok(r.j.prospect.followupReady && /Did you see Green Lions BJJ/.test(r.j.followup.html), "after 5 days the follow-up is ready to send");
    const fb = sink.mails.length;
    r = await admin("POST", `/admin/prospects/${idA}/followup`, {}, { "x-jf-key": "fu2" }); await wait(100);
    const fm = sink.mails[fb] || {};
    ok(r.s === 200 && sink.mails.length === fb + 1 && fm.subject === "Re: Green Lions on JitsFlow" && fm.reply_to === "boss@jitsflow.test", "the follow-up goes once, as a reply to the first");
    ok(fm.from === `"Boss from JitsFlow" <no-reply@jitsflow.test>` && /Thanks,<br>Boss Admin<br>and the JitsFlow team/.test(fm.html) && /\nBoss Admin\nand the JitsFlow team\n/.test(fm.text) && fm.html.includes(`/app/?gym=${tokA}`) && /No obligation\./.test(fm.html) && /List-Unsubscribe/.test(Object.keys(fm.headers || {}).join()), "the follow-up: the same From and sign-off, the link, the deal, unsubscribe headers");
    r = await admin("POST", `/admin/prospects/${idA}/followup`, {}, { "x-jf-key": "fu3" }); ok(r.s === 409 && sink.mails.length === fb + 1, "only one follow-up, ever");

    // ---------- opting out, and "not my gym": the built gym goes ----------
    const rB = await row(idB), tokB = rB.token, gB = rB.gym_id;
    ok(gB && (await gym(gB)).claim, "the second gym was built too");
    r = await admin("PATCH", `/admin/prospects/${idB}`, { ownerEmail: "Owner@Localhost.test" }); ok(r.s === 200, "owner email added to the second gym");
    r = await pub("GET", `/try/${tokB}/optout`); ok(r.s === 200 && /Stop emails/.test(r.t) && /<form method="post"/.test(r.t) && (await row(idB)).status === "draft", "the opt-out link shows one button; opening it (a scanner) opts nobody out");
    r = await pub("POST", `/try/${tokB}/optout`); const rb = await row(idB);
    ok(r.s === 200 && /opted out/.test(r.t) && rb.status === "optedout" && !rb.logo && JSON.stringify(rb.profile) === "{}" && !rb.owner_email, "opting out deletes what we read and the owner's details");
    ok(!(await gym(gB)) && Number((await pool.query("select count(*) from classes where gym_id=$1", [gB])).rows[0].count) === 0 && Number((await pool.query("select count(*) from plans where gym_id=$1", [gB])).rows[0].count) === 0, "and the gym built for it, with its classes, plans and logo");
    const dnc = (await pool.query("select kind, value from outreach_dnc order by kind")).rows.map((x) => x.kind + ":" + x.value);
    ok(dnc.includes("domain:localhost") && dnc.includes("email:owner@localhost.test"), "domain and email go on the do-not-contact list: " + dnc);
    r = await pub("GET", "/try/" + tokB); ok(r.s === 404, "the opted-out link is gone");
    r = await anon("GET", "/me", undefined, { "x-jf-preview": tokB }); ok(r.s === 404, "and its preview");
    r = await admin("POST", `/admin/prospects/${idB}/send`, {}, { "x-jf-key": "sb" }); ok(r.s === 409, "an opted-out gym can't be emailed");
    r = await admin("POST", `/admin/prospects/${idB}/build`, {}); ok(r.s === 409, "nor built again");
    r = await admin("POST", "/admin/prospects", { text: `http://localhost:${site.port}/about, Someone, new@other.test` }, { "x-jf-key": "add3" }); ok(r.s === 201 && !r.j.added.length && /asked not to be contacted/.test(r.j.skipped[0].why), "an opted-out domain can't be added again");
    r = await admin("GET", "/admin/prospects"); ok(r.j.prospects.find((p) => p.id === idB).label === "Opted out", "the list says Opted out");
    const prof = { name: "Elsewhere MMA", timetable: [{ day: "Mon", start: "18:00", end: "19:00", title: "MMA", coach: "", level: "" }], coaches: [], rates: [] };
    const mk = async (name, domain, extra = {}) => (await pool.query("insert into prospects(token,website,domain,name,profile,import_state,owner_email,accent) values($1,$2,$3,$4,$5,'done',$6,$7) returning id, token",
      [outreach.newToken(), "https://" + domain, domain, name, { ...prof, name, ...extra }, "boss@" + domain, "#e65100"])).rows[0];
    const C = await mk("Elsewhere MMA", "elsewhere.test");
    r = await admin("POST", `/admin/prospects/${C.id}/build`, {}); const gC = (await row(C.id)).gym_id;
    ok(r.s === 200 && gC && r.j.prospect.gym.unclaimed && r.j.prospect.label === "Gym built", "Build gym builds it on demand");
    r = await pub("POST", `/try/${C.token}/remove`); ok(r.s === 200 && /This page is gone/.test(r.t) && (await row(C.id)).status === "optedout" && !(await gym(gC)), "Not your gym: removed, with the gym built for it");
    ok((await pool.query("select 1 from outreach_dnc where kind='domain' and value='elsewhere.test'")).rows.length === 1 && (await pub("GET", "/try/" + C.token)).s === 404, "and its domain won't be contacted again");

    // ---------- claiming ----------
    r = await anon("GET", "/prospects/" + tokA); ok(r.s === 200 && r.j.gym.name === "Green Lions BJJ" && r.j.gym.classes >= 5 && r.j.gym.prices >= 2, "the claim screen's look at the gym");
    const adminMails = sink.mails.length, codesBefore = [G0.student_code, G0.coach_code];
    r = await owner("POST", "/auth/start-gym", { gym: "", name: "Thabo Nkosi", email: "thabo@greenlions.test", password: "thabopass1", prospect: tokA });
    ok(r.s === 201 && r.j.claimed && r.j.me.role === "coach" && r.j.me.gym.name === "Green Lions BJJ" && r.j.me.gym.head === true && r.j.me.gym.id === String(gA), "sign-up with the link: the built gym becomes theirs, with them as head coach: " + JSON.stringify(r.j && r.j.me && r.j.me.gym && r.j.me.gym.id));
    ok(r.j.me.gym.brand.accent === "#1b7f3b" && /\/api\/gyms\/\d+\/logo/.test(r.j.me.gym.logo || "") && !r.j.me.preview, "the gym keeps the site's colour and the logo");
    G0 = await gym(gA);
    ok(!G0.claim && G0.claimed_at && String(G0.head_coach_id) === r.j.me.id && G0.student_code !== codesBefore[0] && G0.coach_code !== codesBefore[1], "claimed: no longer unclaimed, a head coach, and new invite codes");
    ok(G0.billing.trialEnds === beta.addMonths(today, 3), "its free months start the day it's claimed: " + G0.billing.trialEnds);
    r = await owner("GET", "/gym"); ok(r.j.gym.profile.timetable.length >= 5 && r.j.gym.profile.coaches.length === 2, "the timetable and coaches are there");
    r = await owner("GET", "/coach/plans"); ok(r.j.plans.some((p) => p.name === "Adult unlimited" && p.priceCents === 85000), "and its plans");
    r = await owner("GET", "/classes"); ok(r.j.classes.length >= 20, "the timetable is on the calendar (" + r.j.classes.length + " classes)");
    const ra = await row(idA); ok(ra.status === "claimed" && String(ra.claimed_gym_id) === String(gA) && String(ra.claimed_by) === String(G0.head_coach_id), "the prospect is marked claimed, with its gym and who claimed it");
    r = await admin("GET", "/admin/prospects"); const Ac = r.j.prospects.find((p) => p.id === idA);
    ok(Ac.label === "Claimed" && Ac.claimedBy && Ac.claimedBy.email === "thabo@greenlions.test" && Ac.claimedBy.name === "Thabo Nkosi", "the team sees who claimed it, with their email");
    await wait(300);
    const told = sink.mails.slice(adminMails).filter((x) => x.subject === "Green Lions BJJ claimed JitsFlow").map((x) => x.to[0]).sort();
    ok(told.join() === "boss@jitsflow.test,second@jitsflow.test", "every admin is told: " + told);
    const gyms = Number((await pool.query("select count(*) from gyms")).rows[0].count);
    r = await anon("POST", "/auth/start-gym", { gym: "", name: "Someone Else", email: "else@gym.test", password: "elsepass12", prospect: tokA });
    ok(r.s === 409 && /claimed already/.test(r.j.error) && Number((await pool.query("select count(*) from gyms")).rows[0].count) === gyms && String((await gym(gA)).head_coach_id) === String(G0.head_coach_id), "a second claim is refused (first come), and changes nothing");
    r = await anon("GET", "/me", undefined, { "x-jf-preview": tokA }); ok(r.s === 404, "the link no longer previews a claimed gym");
    r = await pub("GET", "/try/" + tokA); ok(r.s === 200 && /is on JitsFlow/.test(r.t) && !/claimgym|\?gym=/.test(r.t), "the old page says it's taken");
    r = await stu("POST", "/me/join", { code: G0.student_code }); ok(r.s === 200 && r.j.me.gym.name === "Green Lions BJJ", "its new invite code works now");
    r = await admin("GET", "/admin/overview?days=7"); ok(r.j.totals.gyms === 2 && r.j.gyms.some((g) => g.name === "Green Lions BJJ" && g.outreach) && r.j.outreach.claimed === 1, "it counts as a gym on the dashboard now");
    r = await admin("POST", `/admin/prospects/${idA}/followup`, {}, { "x-jf-key": "fu4" }); ok(r.s === 409, "no follow-up to a claimed gym");
    // Signed in with no gym: claim in one tap (built at that moment if it wasn't yet).
    const D = await mk("Durban Grappling", "durbangrappling.test", { rates: [{ name: "Unlimited", price: 700, currency: "ZAR", period: "month", note: "" }] });
    const lee = client(base); r = await lee("POST", "/auth/register", { name: "Lee Naidoo", email: "leen@durban.test", password: "leepass123" }); ok(r.s === 201 && !r.j.me.gym, "someone signs up with no gym");
    r = await lee("POST", "/me/claim-gym", { token: D.token }); const gD = (await row(D.id)).gym_id;
    ok(r.s === 201 && r.j.me.role === "coach" && r.j.me.gym.name === "Durban Grappling" && r.j.me.gym.head && r.j.me.gym.monthlyFeeCents === 70000 && r.j.me.gym.id === String(gD), "signed in with no gym, one tap claims it: " + JSON.stringify(r.j && r.j.me && r.j.me.gym && r.j.me.gym.name));
    ok((await gym(gD)).billing.trialEnds === beta.addMonths(today, 3), "free months from the claim");
    r = await coach("POST", "/me/claim-gym", { token: (await mk("Third Gym", "third.test")).token }); ok(r.s === 409 && /already in Some Gym/.test(r.j.error), "a coach who has a gym can't claim another");
    r = await anon("POST", "/auth/start-gym", { gym: "", name: "Bad Token", email: "bad@gym.test", password: "badpass123", prospect: "nope" }); ok(r.s === 404, "a bad token is refused");
    const P4 = await mk("Fourth Gym", "fourth.test"); await admin("POST", `/admin/prospects/${P4.id}/build`, {});
    r = await anon("POST", "/auth/start-gym", { gym: "", name: "X", email: "kim@gym.test", password: "xpass12345", prospect: P4.token });
    const p4 = (await pool.query("select status, claimed_at, gym_id from prospects where id=$1", [P4.id])).rows[0];
    ok(r.s === 409 && p4.claimed_at === null && (await gym(p4.gym_id)).claim, "a sign-up that fails (email taken) leaves the gym built and claimable");
    // The team looks at gyms through their links, but never claims one: only the owner does.
    r = await admin("POST", "/me/claim-gym", { token: P4.token });
    ok(r.s === 403 && /only its owner can/.test(r.j.error) && !(await admin("GET", "/me")).j.me.gym, "an admin signed in can't claim a gym from its link");
    r = await anon("POST", "/auth/start-gym", { gym: "", name: "Second Admin", email: "Second@JitsFlow.test", password: "secondpass1", prospect: P4.token });
    const p4b = (await pool.query("select status, claimed_at, gym_id from prospects where id=$1", [P4.id])).rows[0];
    ok(r.s === 403 && /only its owner can/.test(r.j.error) && p4b.claimed_at === null && (await gym(p4b.gym_id)).claim && !(await pool.query("select 1 from users where email='second@jitsflow.test'")).rows[0], "nor sign up with a team address to claim it; the gym stays claimable");
    // The wrong person claimed it: the team unclaims it, or gives it to the right account.
    r = await admin("POST", `/admin/gyms/${gD}/unclaim`, {});
    const Dg = await gym(gD), leeMe = (await lee("GET", "/me")).j.me;
    ok(r.s === 200 && Dg.claim && !Dg.head_coach_id && !leeMe.gym && (await row(D.id)).status === "draft" && !(await row(D.id)).claimed_by, "Unclaim: back to its link, nobody in it");
    r = await lee("POST", "/me/claim-gym", { token: D.token }); ok(r.s === 201 && r.j.me.gym.id === String(gD), "the link claims it again");
    const right = client(base); await right("POST", "/auth/register", { name: "Ravi Pillay", email: "ravi@durban.test", password: "ravipass12" });
    r = await admin("POST", `/admin/gyms/${gD}/reassign`, { email: "nobody@durban.test" }); ok(r.s === 404, "reassigning needs an account");
    r = await admin("POST", `/admin/gyms/${gD}/reassign`, { email: "kim@gym.test" }); ok(r.s === 409, "one with no gym of its own");
    r = await admin("POST", `/admin/gyms/${gD}/reassign`, { email: "Ravi@Durban.test" });
    ok(r.s === 200 && r.j.prospect.claimedBy.email === "ravi@durban.test" && (await right("GET", "/me")).j.me.gym.head && !(await lee("GET", "/me")).j.me.gym, "Reassign: the right person is head coach, the wrong one is out");
    r = await admin("POST", `/admin/gyms/${gA}/unclaim`, {}); ok(r.s === 409 && /other person/.test(r.j.error), "a gym with members in it can't be unclaimed (reassign instead)");

    // ---------- past the free months: nothing locks ----------
    await pool.query("update gyms set billing = billing || $2 where id=$1", [gA, { trialEnds: "2026-01-01" }]);
    r = await owner("GET", "/coach/billing"); ok(r.s === 200 && r.j.billing.due === true && r.j.billing.priceCents === 9900, "after the free months with no card, the plan is due");
    r = await owner("POST", "/classes", { title: "Still works", startsAt: new Date(Date.now() + 3 * 864e5).toISOString() }); const r2 = await owner("GET", "/coach/roster"), r3 = await owner("GET", "/coach/money");
    const sx = client(base); const r4 = await sx("POST", "/auth/register", { name: "New Member", email: "newm@gl.test", password: "newmpass1", code: G0.student_code });
    ok(r.s === 201 && r2.s === 200 && r3.s === 200 && r4.s === 201 && r4.j.me.gym.name === "Green Lions BJJ", "but everything keeps working: classes, members, money, new members joining");
    r = await stu("GET", "/me"); ok(!r.j.me.gym.beta && !("due" in r.j.me.gym), "members aren't told anything about the gym's plan");
    r = await admin("GET", "/admin/overview?days=7"); ok(r.j.gyms.find((g) => g.name === "Green Lions BJJ").billing.state === "due", "the dashboard shows it as due");

    // ---------- the beta ----------
    r = await owner("GET", "/coach/beta"); ok(r.s === 200 && r.j.beta.status === null && /free for your first 6 months in the beta, then R49\/month instead of R99/.test(r.j.deal), "a head coach sees the beta and its deal");
    r = await stu("GET", "/coach/beta"); ok(r.s === 403, "members can't");
    const bm = sink.mails.length;
    r = await owner("POST", "/coach/beta", { action: "apply", note: "Grading sheets for the kids, please." });
    ok(r.s === 200 && r.j.beta.status === "applied" && (await gym(gA)).beta.note === "Grading sheets for the kids, please.", "applying takes one tap, with what they'd want built");
    await wait(300); ok(sink.mails.slice(bm).filter((x) => x.subject === "Green Lions BJJ applied for the beta").length === 2, "the team is emailed");
    r = await owner("GET", "/me"); ok(r.j.me.gym.beta === "applied" && JSON.stringify(r.j.me.gym.features) === "[]", "applied: no features yet");
    r = await owner("POST", "/coach/beta/feedback", { text: "Hi" }); ok(r.s === 403, "feedback is for gyms in the beta");
    await coach("POST", "/coach/beta", { action: "apply" });
    r = await admin("GET", "/admin/beta"); const bA = r.j.gyms.find((g) => g.name === "Green Lions BJJ");
    ok(r.s === 200 && r.j.gyms.length === 2 && bA.beta.status === "applied" && bA.beta.note && bA.head.email === "thabo@greenlions.test" && bA.members >= 2, "the team sees the applicants with their note, head coach and size");
    r = await coach("PATCH", `/admin/gyms/${gA}/beta`, { action: "accept" }); ok(r.s === 403, "only the team can accept");
    r = await admin("PATCH", `/admin/gyms/${gA}/beta`, { action: "accept", features: "kiosk, Grading sheets" });
    ok(r.s === 200 && r.j.beta.status === "accepted" && r.j.beta.feeCents === 0 && r.j.beta.feeUntil === beta.addMonths(today, 6) && r.j.beta.afterCents === 4900, "Accept: free for 6 months, then R49, by default: " + JSON.stringify(r.j.beta));
    r = await owner("GET", "/coach/billing");
    ok(r.j.billing.priceCents === 0 && r.j.billing.due === false && r.j.billing.beta.line === `Beta: free until ${beta.longDay(beta.addMonths(today, 6))}, then R49/month (instead of R99)`, "billing honours it: nothing to pay, and it says so: " + (r.j.billing.beta && r.j.billing.beta.line));
    r = await owner("GET", "/me"); ok(r.j.me.gym.beta === "accepted" && JSON.stringify(r.j.me.gym.features) === '["kiosk","grading-sheets"]', "the app reads the gym's feature flags: " + JSON.stringify(r.j.me.gym.features));
    r = await stu("GET", "/me"); ok(JSON.stringify(r.j.me.gym.features) === '["kiosk","grading-sheets"]' && !r.j.me.gym.beta, "for everyone in the gym (members don't see its beta status)");
    r = await admin("GET", "/admin/overview?days=7"); ok(r.j.gyms.find((g) => g.name === "Green Lions BJJ").billing.state === "beta" && r.j.gyms.find((g) => g.name === "Green Lions BJJ").beta === "accepted", "the dashboard: in the beta, nothing to pay");
    r = await owner("POST", "/coach/billing/checkout", {}); ok(r.s === 200 && r.j.fields.recurring_amount === "49.00" && r.j.fields.billing_date === beta.addMonths(today, 6) && r.j.fields.amount === "0.00", "a card added now starts at R49 on the day the free beta months end: " + JSON.stringify(r.j.fields && [r.j.fields.recurring_amount, r.j.fields.billing_date, r.j.fields.amount]));
    // The switch-over day: R49 from then on.
    await pool.query("update gyms set beta = beta || $2 where id=$1", [gA, { feeUntil: today }]);
    r = await owner("GET", "/coach/billing"); ok(r.j.billing.priceCents === 4900 && r.j.billing.due === true && /Beta price R49\/month \(instead of R99\)/.test(r.j.billing.beta.line), "from the switch-over day, the beta price is R49: " + r.j.billing.beta.line);
    r = await admin("PATCH", `/admin/gyms/${gA}/beta`, { action: "fee", feeCents: 0 }); r = await owner("GET", "/coach/billing");
    ok(r.j.billing.priceCents === 0 && /free while you're in the beta/.test(r.j.billing.beta.line), "the team can make it free for as long as they're in the beta");
    r = await owner("POST", "/coach/billing/checkout", {}); ok(r.s === 400 && /nothing to add a card for/.test(r.j.error), "then there's no card to add (no PayFast needed)");
    r = await admin("PATCH", `/admin/gyms/${gA}/beta`, { action: "fee", feeCents: 2500, feeUntil: "2027-03-31" }); ok(r.j.beta.feeCents === 2500 && r.j.beta.feeUntil === "2027-03-31", "or any amount, with an end date");
    r = await admin("PATCH", `/admin/gyms/${(await pool.query("select id from gyms where name='Some Gym'")).rows[0].id}/beta`, { action: "decline" });
    ok(r.s === 200 && r.j.beta.status === "declined" && (await coach("GET", "/coach/beta")).j.beta.status === "declined", "Decline: the gym sees Not this round");
    // Feedback with a screenshot, emailed to the team, in their inbox.
    const fm2 = sink.mails.length;
    r = await owner("POST", "/coach/beta/feedback", { text: "The kids' class list should show parents' numbers.", file: { data: LOGO.toString("base64"), name: "shot.png" } }, { "x-jf-key": "fb1" });
    ok(r.s === 201 && (await pool.query("select shot_type, length(shot) as n from beta_feedback where id=$1", [r.j.id])).rows[0].n === LOGO.length, "a beta gym sends feedback with a screenshot (stored like a proof of payment)");
    const fid = r.j.id;
    r = await owner("POST", "/coach/beta/feedback", { text: "x", file: { data: Buffer.from("%PDF-1.4 hello world padding padding").toString("base64") } }); ok(r.s === 400, "a screenshot must be a picture");
    await wait(300); const fbm = sink.mails.slice(fm2).filter((x) => x.subject === "Beta feedback from Green Lions BJJ");
    ok(fbm.length === 2 && /parents(&#39;|')s? numbers/.test(fbm[0].html) && /with a screenshot/.test(fbm[0].html), "every admin is emailed it");
    r = await admin("GET", "/admin/beta"); const f1 = r.j.feedback.find((x) => x.id === fid);
    ok(f1 && f1.shot && !f1.done && f1.gym === "Green Lions BJJ" && f1.email === "thabo@greenlions.test", "it's in the team's feedback inbox");
    r = await admin("GET", `/admin/feedback/${fid}/shot`); ok(r.s === 200 && r.h.get("content-type") === "image/png" && /default-src 'none'/.test(r.h.get("content-security-policy")), "the screenshot opens for the team");
    r = await owner("GET", `/admin/feedback/${fid}/shot`); ok(r.s === 403, "only for the team");
    r = await admin("POST", `/admin/feedback/${fid}/done`, {}); ok(r.s === 200 && (await admin("GET", "/admin/beta")).j.feedback.find((x) => x.id === fid).done, "mark done");
    r = await admin("PATCH", `/admin/gyms/${gA}/beta`, { action: "remove" }); r = await owner("GET", "/coach/billing");
    ok(r.j.billing.priceCents === 9900 && !r.j.billing.beta && JSON.stringify((await owner("GET", "/me")).j.me.gym.features) === "[]", "Remove: back to the normal price, features off");

    // ---------- unclaimed gyms nobody opens are tidied away after 60 days ----------
    { const { makeApi } = require("../backend/api"); const inproc = makeApi(pool, { secureCookies: false });
      const mkBuilt = async (name, domain) => { const x = await mk(name, domain); await admin("POST", `/admin/prospects/${x.id}/build`, {}); return { ...x, gym: (await row(x.id)).gym_id }; };
      const old1 = await mkBuilt("Old Unseen", "old1.test"), old2 = await mkBuilt("Old Seen", "old2.test"), fresh = await mkBuilt("Fresh Gym", "fresh.test");
      await pool.query("update gyms set claim = claim || jsonb_build_object('builtAt', (now() - interval '61 days')::text) where id = any($1)", [[old1.gym, old2.gym]]);
      await pool.query("update prospects set last_viewed_at=now() - interval '3 days' where id=$1", [old2.id]);
      await pool.query("update prospects set last_viewed_at=now() - interval '20 days' where id=$1", [old1.id]);
      const n = await inproc.jobs.tidyUnclaimed();
      ok(n === 1 && !(await gym(old1.gym)) && (await gym(old2.gym)) && (await gym(fresh.gym)) && (await gym(gA)), "built 60+ days ago and not opened in 14 days: deleted; opened lately, newer, or claimed: kept (" + n + ")");
      ok((await row(old1.id)) && !(await row(old1.id)).gym_id, "its prospect stays (it can be built again)"); }

    // ---------- re-import, rebuild and delete ----------
    const E = await mk("Re Import", "127.0.0.1x.test"); await pool.query("update prospects set website=$1 where id=$2", [`http://127.0.0.1:${site.port}/`, E.id]);
    await admin("POST", `/admin/prospects/${E.id}/build`, {}); const gE = (await row(E.id)).gym_id;
    r = await admin("POST", `/admin/prospects/${E.id}/reimport`, {}); ok(r.s === 200 && r.j.prospect.importing, "re-import starts");
    await settle(admin); ok((await row(E.id)).name === "Green Lions BJJ" && (await row(E.id)).gym_id === gE && (await gym(gE)).name === "Green Lions BJJ" && (await gym(gE)).claim.rebuiltAt && (await gym(gE)).profile.timetable.length >= 5, "re-import reads the site again and updates the same unclaimed gym");
    r = await admin("DELETE", `/admin/prospects/${E.id}/gym`); ok(r.s === 200 && !(await gym(gE)) && !r.j.prospect.gym, "Delete gym");
    r = await admin("POST", `/admin/prospects/${E.id}/build`, {}); const gE2 = (await row(E.id)).gym_id; ok(r.s === 200 && gE2 && gE2 !== gE, "Build again");
    r = await admin("DELETE", `/admin/prospects/${E.id}`); ok(r.s === 200 && !(await row(E.id)) && !(await gym(gE2)), "deleting the prospect deletes its unclaimed gym");
    r = await admin("DELETE", `/admin/prospects/${idA}`); ok(r.s === 200 && (await gym(gA)), "deleting a claimed prospect keeps the gym (it's theirs)");

    // ---------- in the browser ----------
    b = await chromium.launch();
    const phone = async (cookie) => { const c = await b.newContext({ ...devices["iPhone 13"] }); if (cookie) await c.addCookies([{ name: "jf_s", value: cookie.replace("jf_s=", ""), url: BASE }]);
      await c.addInitScript(() => { if (!localStorage.getItem("rtb.progress")) localStorage.setItem("rtb.progress", JSON.stringify({ settings: { onboarded: true } })); window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI)); });
      const p = await c.newPage(); p.errs = []; p.on("pageerror", (x) => p.errs.push(x.message)); return p; };
    const ev = (p, f, a) => p.evaluate(f, a);
    // The preview on a phone: the real app, their gym, the claim bar; a change asks them to claim.
    const F = await mk("Fifth Gym", "fifth.test", { rates: [{ name: "Unlimited", price: 800, currency: "ZAR", period: "month" }] }); await pool.query("update prospects set owner_email='owner@fifth.test' where id=$1", [F.id]);
    await admin("POST", `/admin/prospects/${F.id}/build`, {}); const gF = (await row(F.id)).gym_id;
    // The team's "Open their gym": a team preview with no way to claim it.
    { const p = await phone(admin.cookie()); await p.goto(`${BASE}/app/?gym=${F.token}`); await wait(2500);
      const bar = await ev(p, () => (document.getElementById("pvbar") || {}).innerText || "");
      ok(/Team preview — only the owner can claim Fifth Gym/.test(bar) && await ev(p, () => !document.querySelector('[data-a="pvclaim"]') && /Your gym, already set up/i.test(document.getElementById("app").innerText)), "an admin opening the link sees a team preview with no Claim button: " + JSON.stringify(bar));
      await p.tap('nav.tabs [data-v="coach-gym"]'); await wait(1200); await p.tap('[data-a="copy"]'); await wait(400);
      ok(await ev(p, () => document.getElementById("sheet").hidden && !!API.preview && API.real && API.real.admin), "a change there opens no claim (just a note), and the admin stays signed in as themselves");
      ok((await row(F.id)).status === "draft" && (await gym(gF)).claim && (await row(F.id)).views === 0 && !p.errs.length, "nothing claimed, the team's view isn't counted, no script errors " + p.errs.join(", "));
      await p.context().close(); }
    { const p = await phone(); const beacon = p.waitForRequest((q) => q.url().endsWith(`/try/${F.token}/view`) && q.method() === "POST", { timeout: 6000 }).catch(() => null);
      await p.goto(`${BASE}/try/${F.token}`); await wait(2500); const got = await beacon; await wait(400);
      ok(await ev(p, () => !!API.preview && !location.search && location.pathname === "/app/"), "the link opens the app and leaves the address bar clean");
      ok(got && (await row(F.id)).views === 1, "the preview's beacon counts the view once it's on screen");
      const bar = await ev(p, () => { const b = document.getElementById("pvbar"); return b && { t: b.innerText, top: b.getBoundingClientRect().top, w: b.getBoundingClientRect().right }; });
      ok(bar && /This is Fifth Gym, built from your website\./.test(bar.t) && /Claim it free/.test(bar.t) && bar.w <= 390, "the claim bar: " + JSON.stringify(bar));
      ok(await ev(p, () => document.documentElement.scrollWidth <= 390 && [...document.querySelectorAll("#app *")].every((e) => e.getBoundingClientRect().right <= 391)), "preview: no sideways scroll on a 390px phone");
      ok(await ev(p, () => S.ui.tab === "coach" && COACH.view === "home" && /Your gym, already set up/i.test(document.getElementById("app").innerText) && /No obligation/.test(document.getElementById("app").innerText)), "Home: what JitsFlow does for them and the no-obligation line");
      await p.evaluate(() => scrollTo(0, 2000)); await wait(200); ok(await ev(p, () => { const b = document.getElementById("pvbar").getBoundingClientRect(); return b.top >= 0 && b.top < 40; }), "the bar stays on screen while scrolling");
      await p.tap('nav.tabs [data-v="coach-schedule"]'); await wait(1500);
      ok(await ev(p, () => (COACH.classes || []).filter((c) => c.title === "MMA").length >= 7), "Schedule: their classes on the calendar");
      await p.tap('nav.tabs [data-v="coach-members"]'); await wait(800); ok(/Your members go here/.test(await ev(p, () => document.getElementById("app").innerText)), "Members: what happens once it's theirs (invites, WhatsApp)");
      await p.tap('nav.tabs [data-v="coach-money"]'); await wait(1200); await p.tap('nav.tabs [data-v="coach-gym"]'); await wait(1200);
      ok(await ev(p, () => /Your JitsFlow plan/i.test(document.getElementById("app").innerText) && /Join the JitsFlow beta/i.test(document.getElementById("app").innerText)), "Gym: the plan and the beta");
      const nClasses = Number((await pool.query("select count(*) from classes where gym_id=$1", [gF])).rows[0].count);
      await p.tap('#betaform [type=submit]'); await wait(600);
      ok(await ev(p, () => S.ui.sheet && S.ui.sheet.k === "auth" && /Claim Fifth Gym/.test(document.getElementById("sheet").innerText)), "applying for the beta in the preview opens the claim");
      await ev(p, () => hideSheet()); await p.tap('[data-a="copy"]'); await wait(400); ok(await ev(p, () => S.ui.sheet && S.ui.sheet.k === "auth"), "so does copying the invite link"); await ev(p, () => hideSheet());
      await p.tap('nav.tabs [data-v="coach-schedule"]'); await wait(800); await p.tap('[data-a="classnew"]').catch(() => {}); await wait(600);
      if (await ev(p, () => !!document.getElementById("classform"))) { await p.fill("#classform [name=title]", "Sneaky class").catch(() => {}); await p.tap('#sheetbar [type=submit]').catch(() => {}); await wait(800); }
      ok(Number((await pool.query("select count(*) from classes where gym_id=$1", [gF])).rows[0].count) === nClasses && await ev(p, () => S.ui.sheet && S.ui.sheet.k === "auth"), "saving a class asks them to claim instead, and adds nothing");
      ok((await ev(p, () => window.__csp)).length === 0 && !p.errs.length, "preview: nothing blocked by the security policy, no script errors: " + (await ev(p, () => window.__csp)).join(", ") + p.errs.join(", "));
      // Claim it from the preview, with the beta ticked.
      await ev(p, () => hideSheet()); await p.tap('#pvbar [data-a="pvclaim"]'); await wait(500);
      ok(await ev(p, () => document.getElementById("a-email").value === "owner@fifth.test" && /Claiming\s+Fifth Gym/.test(document.getElementById("a-claiming").innerText) && /no card needed to start/.test(document.getElementById("sheet").innerText) && !!document.getElementById("a-beta")), "the claim screen: their email filled in, what's ready, the deal, the beta");
      ok(await ev(p, () => document.documentElement.scrollWidth <= 390), "claim screen: no sideways scroll");
      await p.fill("#a-name", "Fifi Owner"); await p.fill("#a-pass", "fifipass12"); await p.check("#a-beta"); await p.tap("#sheetbar [type=submit]"); await wait(3000);
      ok(await ev(p, (g) => !API.preview && API.me && API.me.gym && API.me.gym.id === g && API.me.gym.head && API.me.email === "owner@fifth.test" && S.ui.sheet && S.ui.sheet.k === "welcome", String(gF)), "claimed from the preview: their gym, them as head coach, the normal welcome");
      const fg = await gym(gF); ok(!fg.claim && fg.beta && fg.beta.status === "applied" && (await row(F.id)).status === "claimed", "the gym is theirs and the beta application went in");
      ok(!p.errs.length, "no script errors claiming: " + p.errs.join(", "));
      await p.context().close(); }
    // The Outreach screen: only for admins.
    { const p = await phone(coach.cookie()); await p.goto(BASE + "/app/#coach-gym"); await wait(1500);
      ok(await ev(p, () => !document.querySelector('[data-a="outopen"]')), "a coach doesn't see Outreach"); await p.context().close(); }
    const ap = await phone(admin.cookie());
    await ap.goto(BASE + "/app/#me"); await wait(1500);
    ok(await ev(ap, () => !!document.querySelector('#outpanel [data-a="outopen"]')), "the admin sees Outreach in Me");
    const closeIntro = async (p) => { if (await ev(p, () => S.ui.sheet && S.ui.sheet.k === "onboard")) await p.tap('#sheetbar [data-a="obdone"]'); await wait(200); };
    await closeIntro(ap); await ev(ap, () => go("me")); await wait(300);
    ok(await ev(ap, () => document.getElementById("sheet").hidden), "Me opens with no sheet over it: " + (await ev(ap, () => JSON.stringify(S.ui.sheet) + document.getElementById("sheet").innerText.slice(0, 200))));
    await ap.tap('[data-a="outopen"]'); await wait(1200);
    let txt = await ev(ap, () => document.getElementById("sheet").innerText);
    ok(/Outreach/.test(txt) && /Fifth Gym/.test(txt) && /Claimed/.test(txt) && /Opted out/.test(txt), "the list shows each gym with its status: " + txt.slice(0, 300).replace(/\n/g, " | "));
    ok(await ev(ap, () => document.documentElement.scrollWidth <= 390), "Outreach: no sideways scroll");
    const G = await mk("Sixth Gym", "sixth.test");
    await ap.tap('[data-a="back"]'); await wait(300); await ap.tap('[data-a="outopen"]'); await wait(1200);
    await ap.tap(`[data-a="outpro"][data-v="${G.id}"]`); await wait(1000);
    txt = await ev(ap, () => document.getElementById("sheet").innerText + " " + document.getElementById("sheetbar").innerText);
    ok(/Sixth Gym/.test(txt) && /Copy email HTML/.test(txt) && /Copy plain text/.test(txt) && /Re-import/.test(txt) && /Delete/.test(txt) && /Build gym/.test(txt) && /No gym built yet/.test(txt) && /View email/.test(txt) && /Send email/.test(txt), "a gym's page: build, email, copy, send, re-import, delete: " + txt.slice(0, 300).replace(/\n/g, " | "));
    await ap.tap('[data-a="outbuild"]'); await wait(1500);
    txt = await ev(ap, () => document.getElementById("sheet").innerText);
    ok((await row(G.id)).gym_id && /Gym built/.test(txt) && /Open their gym/.test(txt) && /Delete gym/.test(txt) && await ev(ap, () => /\/app\/\?gym=/.test(document.querySelector('#sheet a.btn[target=_blank]').getAttribute("href"))), "Build gym builds it; Open their gym opens the app's preview");
    await ap.fill('#outedit [name="ownerName"]', "Sam Owner"); await ap.fill('#outedit [name="ownerEmail"]', "sam@sixth.test"); await ap.fill('#outedit [name="personalLine"]', "Loved your open mat video.");
    const sb = sink.mails.length;
    await ap.tap('#sheetbar [data-a="outsend"]'); await ap.tap('#sheetbar [data-a="outsend"]').catch(() => {}); await wait(1500);
    const sent = sink.mails.slice(sb);
    ok(sent.length === 1 && sent[0].to[0] === "sam@sixth.test" && /Hi Sam,/.test(sent[0].html) && /Loved your open mat video\./.test(sent[0].html) && sent[0].from === `"Boss from JitsFlow" <no-reply@jitsflow.test>`, "Send saves the edits and sends once, even tapped twice: " + sent.length);
    ok(/Sent/.test(await ev(ap, () => document.getElementById("sheetbar").innerText)) && (await row(G.id)).status === "sent", "the gym shows as Sent");
    ok(await ev(ap, () => document.documentElement.scrollWidth <= 390), "a gym's page: no sideways scroll");
    const gG = (await row(G.id)).gym_id;
    await ap.tap('[data-a="outdel"]'); await wait(400); await ap.tap('[data-a="outdel"]'); await wait(1000);
    ok(!(await row(G.id)) && !(await gym(gG)) && await ev(ap, () => S.ui.sheet && S.ui.sheet.k === "outreach"), "Delete asks once more, then deletes it and its gym, and goes back to the list");
    ok(!ap.errs.length, "Outreach: no script errors " + ap.errs.join(", "));
    await ap.context().close();
    // A gym not built yet (the older page): Claim on the page, then sign up.
    const H = await mk("Seventh Gym", "seventh.test");
    { const p = await phone(); await p.goto(`${BASE}/try/${H.token}`); await wait(500);
      await p.tap(`a.btn[href*="?gym="]`); await wait(1800);
      txt = await ev(p, () => (document.getElementById("a-claiming") || {}).innerText || "");
      ok(/Claiming\s+Seventh Gym/.test(txt) && await ev(p, () => document.getElementById("a-gym").value === "Seventh Gym" && !document.getElementById("a-site")), "the app opens sign-up saying which gym they're claiming: " + JSON.stringify(txt));
      ok(await ev(p, () => !/gym=/.test(location.search)), "the token leaves the address bar");
      ok(await ev(p, () => getComputedStyle(document.documentElement).getPropertyValue("--blue").trim().toLowerCase() !== "#1d4fb5"), "sign-up already wears the gym's colour");
      await p.fill("#a-name", "Nomsa Dube"); await p.fill("#a-email", "nomsa@seventh.test"); await p.fill("#a-pass", "nomsapass1");
      await p.tap('#sheetbar [type=submit]'); await wait(2500);
      ok(await ev(p, () => API.me && API.me.gym && API.me.gym.name === "Seventh Gym" && API.me.gym.head && S.ui.sheet && S.ui.sheet.k === "welcome"), "claimed: they're the head coach and land on the normal first-run welcome");
      ok((await row(H.id)).status === "claimed" && (await row(H.id)).gym_id && !(await gym((await row(H.id)).gym_id)).claim && !p.errs.length, "the gym is built at the claim and theirs " + p.errs.join(", "));
      // The beta from the Gym tab.
      await ev(p, () => { hideSheet(); coachGo("gym"); }); await wait(1500);
      ok(await ev(p, () => !!document.getElementById("betaform") && /free for your first 6 months in the beta, then R49\/month instead of R99/.test(document.getElementById("betaform").innerText)), "the Gym tab offers the beta, with its deal");
      await p.fill("#betaform [name=note]", "A check-in kiosk."); await p.tap("#betaform [type=submit]"); await wait(1200);
      ok(await ev(p, () => /Applied/.test(document.getElementById("betacard").innerText)) && (await gym((await row(H.id)).gym_id)).beta.note === "A check-in kiosk.", "applied from the Gym tab in one tap");
      ok(await ev(p, () => document.documentElement.scrollWidth <= 390) && !p.errs.length, "Gym tab: no sideways scroll, no script errors " + p.errs.join(", "));
      // The team accepts it from the dashboard.
      const a2 = await phone(admin.cookie()); await a2.goto(BASE + "/app/#me"); await wait(1500); await closeIntro(a2); await ev(a2, () => { if (!document.getElementById("sheet").hidden) hideSheet(); go("me"); }); await wait(300);
      await a2.tap('[data-a="dashopen"]'); await wait(2500);
      const gH = (await row(H.id)).gym_id;
      ok(await ev(a2, () => /Seventh Gym/.test(document.getElementById("dash-beta").innerText) && /A check-in kiosk/.test(document.getElementById("dash-beta").innerText) && /Built, not claimed/.test(document.getElementById("sheet").innerText)), "the dashboard's Beta section lists the applicant; the funnel shows built gyms");
      await a2.tap(`[data-a="betaopen"][data-v="${gH}"]`); await wait(300); await a2.fill("#betaadm [name=features]", "kiosk"); await a2.tap('#betaadm [type=submit]'); await wait(1500);
      const hb = (await gym(gH)).beta;
      ok(hb.status === "accepted" && hb.feeCents === 0 && hb.feeUntil === beta.addMonths(today, 6) && hb.afterCents === 4900 && JSON.stringify(hb.features) === '["kiosk"]', "Accept from the dashboard: the default deal and the feature: " + JSON.stringify(hb));
      ok(await ev(a2, () => /In the beta/.test(document.getElementById("dash-beta").innerText) && document.documentElement.scrollWidth <= 390) && !a2.errs.length, "the dashboard shows it in the beta; no sideways scroll; no script errors " + a2.errs.join(", "));
      await a2.context().close();
      await ev(p, () => { COACH.beta = undefined; COACH.bill = undefined; return api("GET", "/me").then((j) => { API.me = j.me; render(); }); }); await wait(1500);
      ok(await ev(p, () => /You're in the beta/.test(document.getElementById("betacard").innerText) && /Free until .*, then R49\/month \(instead of R99\)/.test(document.getElementById("betacard").innerText) && !!document.querySelector(".betapill")), "the gym sees it: in the beta, free until …, a Beta pill");
      await p.tap('[data-a="betafb"]'); await wait(400); await p.fill("#fb-text", "Love it. Could the kiosk show belts?"); await p.tap('#sheetbar [type=submit]'); await wait(1200);
      ok((await pool.query("select text from beta_feedback where gym_id=$1", [gH])).rows.some((x) => /kiosk show belts/.test(x.text)), "Send feedback from the app");
      await p.context().close(); }
  } catch (e) { fail++; fails.push("crashed: " + (e.stack || e.message)); }
  if (b) await b.close();
  srv.kill(); site.close(); sink.close(); await pool.end();
  console.log(`\noutreach: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  ✗ " + f));
  process.exit(fail ? 1 : 0);
})();
