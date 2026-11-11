// Outreach: previews of gyms made from their websites, the email to the owner, the public /try/<token> page and claiming it.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/outreach.js   (wipes that database)
const { spawn } = require("child_process"); const http = require("http"); const fs = require("fs"); const path = require("path"); const { Pool } = require("pg");
const { chromium, devices } = require("playwright");
const { startMailSink } = require("./fixture-gym");
const brand = require("../backend/brand"); const outreach = require("../backend/outreach");
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
  }

  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists prospects, outreach_dnc, autopay_charges, autopay, class_skips, plan_breaks, notices, left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
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

    // ---------- prospects from websites ----------
    r = await admin("POST", "/admin/prospects", { text: `http://127.0.0.1:${site.port}/, Thabo Nkosi, thabo@greenlions.test\nnot a website at all\nhttp://localhost:${site.port}/` }, { "x-jf-key": "add1" });
    ok(r.s === 201 && r.j.added.length === 2 && r.j.skipped.length === 1, "two websites added, the line that isn't one skipped: " + JSON.stringify(r.j));
    const [idA, idB] = r.j.added;
    r = await admin("POST", "/admin/prospects", { text: `http://127.0.0.1:${site.port}/` }, { "x-jf-key": "add2" });
    ok(r.s === 201 && !r.j.added.length && /on the list already/.test(r.j.skipped[0].why), "the same gym twice isn't added twice");
    let list = await settle(admin);
    const A = list.find((p) => p.id === idA);
    ok(A && A.name === "Green Lions BJJ" && A.label === "Draft" && A.counts.classes >= 5 && A.counts.coaches === 2 && A.counts.rates >= 2, "imported: name, classes, coaches, prices: " + JSON.stringify(A && { n: A.name, l: A.label, c: A.counts }));
    ok(A && A.accent === "#1b7f3b", "the brand colour comes from the site's stylesheet (white theme-color ignored): " + (A && A.accent));
    ok(A && A.ownerName === "Thabo Nkosi" && A.ownerEmail === "thabo@greenlions.test" && A.logo && /\/try\/[A-Za-z0-9_-]{32}\/logo$/.test(A.logo), "owner name and email from the pasted line; logo hosted at the token's address");
    const rowA = await row(idA), tokA = rowA.token;
    ok(/^[A-Za-z0-9_-]{32}$/.test(tokA) && Buffer.from(tokA, "base64url").length * 8 >= 128 && rowA.token !== (await row(idB)).token, "the token is random and at least 128 bits");
    ok(rowA.logo_type === "image/png" && rowA.logo.length === LOGO.length && rowA.subject === "Green Lions BJJ is already set up on JitsFlow", "logo stored as PNG; subject suggested");

    // ---------- the public page ----------
    r = await pub("GET", "/try/" + tokA);
    const t = r.t, csp = r.h.get("content-security-policy") || "";
    ok(r.s === 200 && /This is Green Lions BJJ on JitsFlow/.test(t) && /No-Gi Fundamentals/.test(t) && /Thabo Nkosi/.test(t) && /R850 a month/.test(t), "preview: the gym's name, classes, coaches and prices");
    ok(t.includes(`src="/try/${tokA}/logo"`) && t.includes("--acc:#1b7f3b"), "preview: their logo and colour");
    ok(/<meta name="robots" content="noindex/.test(t) && /noindex/.test(r.h.get("x-robots-tag") || "") && r.h.get("cache-control") === "no-store", "preview: noindex (tag and header), never cached");
    ok(/default-src 'self'/.test(csp) && /script-src 'self' 'unsafe-inline'/.test(csp) && !/<script[^>]+src=/.test(t) && ![...t.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].some((m) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com/.test(m[1])), "preview: the site's security policy, and nothing loaded from elsewhere but fonts");
    ok(!/googletagmanager|analytics/.test(t), "preview: no analytics");
    ok(t.includes(`/app/?claimgym=${tokA}`) && /Claim Green Lions BJJ, free for 3 months/.test(t) && /R99 a month/.test(t) && !/2% fee/.test(t), "preview: the claim button and the price line, no card fee while PayFast is on test");
    r = await pub("GET", `/try/${tokA}/logo`); ok(r.s === 200 && r.h.get("content-type") === "image/png", "logo served as PNG for email");
    r = await pub("GET", "/try/" + "x".repeat(32)); ok(r.s === 404 && /This page isn('|&#39;)t here/.test(r.t) && /noindex/.test(r.t), "unknown token: a friendly 404");
    r = await pub("GET", "/try/short"); ok(r.s === 404, "a malformed token is a 404 too");

    // ---------- counting views ----------
    const views = async () => (await row(idA)).views;
    ok((await views()) === 0, "opening the page (a GET, like an email scanner) counts nothing");
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
    ok(e.subject === "Green Lions on JitsFlow" && /Hi Thabo,/.test(e.html) && /Congrats on the new mats in Durbanville!/.test(e.html) && /Green Lions BJJ, your timetable is already on JitsFlow/.test(e.html), "email: subject, first name, personal line, headline");
    ok(e.html.includes(`https://www.jitsflow.test/try/${tokA}/logo`) && !/src="data:/.test(e.html) && e.html.includes(`href="https://www.jitsflow.test/try/${tokA}"`) && e.html.includes(`https://www.jitsflow.test/try/${tokA}/optout`), "email: hosted https logo (no data: URI), button to the preview, opt-out link");
    ok(/max-width:600px/.test(e.html) && /role="presentation"/.test(e.html) && /v:roundrect/.test(e.html) && !/<style[^>]*>[^<]*\.[a-z]+\s*\{[^}]*\}[^<]*<\/style>/.test(e.html.replace(/@media[^{]*\{[^}]*\{[^}]*\}[^}]*\}/g, "").replace(/:root\{[^}]*\}/g, "")), "email: 600px tables, inline styles, an Outlook-proof button");
    ok((e.html.match(/<tr><td style="padding:8px 0 8px 14px/g) || []).length >= 4 && (e.html.match(/<tr><td style="padding:8px 0 8px 14px/g) || []).length <= 6, "email: 4 to 6 of their real classes");
    ok(/I found Green Lions BJJ on your public website \(127\.0\.0\.1\)/.test(e.html) && /Free for 3 months, then R99 a month/.test(e.html) && /Boss Admin/.test(e.html), "email: why they got it, the price, the admin's name");
    ok(/Hi Thabo,/.test(e.text) && /optout/.test(e.text) && /See Green Lions BJJ on JitsFlow: https:\/\/www\.jitsflow\.test\/try\//.test(e.text) && !/</.test(e.text), "email: a plain-text version with the link and opt-out");
    ok(r.j.from === "Boss Admin from JitsFlow" && r.j.replyTo === "boss@jitsflow.test", "email: from the admin's name, replies to the admin");
    r = await admin("GET", `/admin/prospects/${idA}/email`); ok(r.s === 200 && /text\/html/.test(r.h.get("content-type")) && /Hi Thabo/.test(r.t), "the admin can open the rendered email in a tab");

    // ---------- sending ----------
    const before = sink.mails.length;
    const [s1, s2] = await Promise.all([admin("POST", `/admin/prospects/${idA}/send`, {}, { "x-jf-key": "send-a" }), admin("POST", `/admin/prospects/${idA}/send`, {}, { "x-jf-key": "send-a" })]);
    await wait(200);
    ok(s1.s === 200 && s2.s === 200 && sink.mails.length === before + 1, "a double tap on Send sends one email: " + [s1.s, s2.s, sink.mails.length - before]);
    r = await admin("POST", `/admin/prospects/${idA}/send`, {}, { "x-jf-key": "send-b" }); ok(r.s === 409 && sink.mails.length === before + 1, "sending again is refused");
    const m = sink.mails[sink.mails.length - 1];
    ok(m.to[0] === "thabo@greenlions.test" && m.from === `"Boss Admin from JitsFlow" <no-reply@jitsflow.test>` && m.reply_to === "boss@jitsflow.test", "sent to the owner, from the admin's name at our address, replies to the admin: " + m.from + " / " + m.reply_to);
    ok(m.subject === "Green Lions on JitsFlow" && m.html.includes(`/try/${tokA}/optout`) && /optout/.test(m.text) && /One-Click/.test(m.headers["List-Unsubscribe-Post"]) && m.headers["List-Unsubscribe"].includes(`/try/${tokA}/optout`), "the email carries the opt-out link and one-click unsubscribe headers");
    r = await admin("GET", "/admin/prospects"); const As = r.j.prospects.find((p) => p.id === idA);
    ok(As.status === "sent" && As.sentTo === "thabo@greenlions.test" && As.followupFrom && !As.followupReady, "status: sent, follow-up not yet");

    // ---------- the one follow-up ----------
    r = await admin("POST", `/admin/prospects/${idA}/followup`, {}, { "x-jf-key": "fu1" }); ok(r.s === 409 && /5 days/.test(r.j.error), "no follow-up before 5 days");
    await pool.query("update prospects set sent_at=now()-interval '6 days' where id=$1", [idA]);
    r = await admin("GET", `/admin/prospects/${idA}`); ok(r.j.prospect.followupReady && /Did you see Green Lions BJJ/.test(r.j.followup.html), "after 5 days the follow-up is ready to send");
    const fb = sink.mails.length;
    r = await admin("POST", `/admin/prospects/${idA}/followup`, {}, { "x-jf-key": "fu2" }); await wait(100);
    ok(r.s === 200 && sink.mails.length === fb + 1 && sink.mails[fb].subject === "Re: Green Lions on JitsFlow" && sink.mails[fb].reply_to === "boss@jitsflow.test", "the follow-up goes once, as a reply to the first");
    r = await admin("POST", `/admin/prospects/${idA}/followup`, {}, { "x-jf-key": "fu3" }); ok(r.s === 409 && sink.mails.length === fb + 1, "only one follow-up, ever");

    // ---------- opting out ----------
    const tokB = (await row(idB)).token;
    r = await admin("PATCH", `/admin/prospects/${idB}`, { ownerEmail: "Owner@Localhost.test" }); ok(r.s === 200, "owner email added to the second gym");
    r = await pub("GET", `/try/${tokB}/optout`); ok(r.s === 200 && /Stop emails/.test(r.t) && /<form method="post"/.test(r.t) && (await row(idB)).status === "draft", "the opt-out link shows one button; opening it (a scanner) opts nobody out");
    r = await pub("POST", `/try/${tokB}/optout`); const rb = await row(idB);
    ok(r.s === 200 && /opted out/.test(r.t) && rb.status === "optedout" && !rb.logo && JSON.stringify(rb.profile) === "{}" && !rb.owner_email, "opting out deletes what we read and the owner's details");
    const dnc = (await pool.query("select kind, value from outreach_dnc order by kind")).rows.map((x) => x.kind + ":" + x.value);
    ok(dnc.includes("domain:localhost") && dnc.includes("email:owner@localhost.test"), "domain and email go on the do-not-contact list: " + dnc);
    r = await pub("GET", "/try/" + tokB); ok(r.s === 404, "the opted-out page is gone");
    r = await admin("POST", `/admin/prospects/${idB}/send`, {}, { "x-jf-key": "sb" }); ok(r.s === 409, "an opted-out gym can't be emailed");
    r = await admin("POST", "/admin/prospects", { text: `http://localhost:${site.port}/about, Someone, new@other.test` }, { "x-jf-key": "add3" }); ok(r.s === 201 && !r.j.added.length && /asked not to be contacted/.test(r.j.skipped[0].why), "an opted-out domain can't be added again");
    r = await admin("GET", "/admin/prospects"); ok(r.j.prospects.find((p) => p.id === idB).label === "Opted out", "the list says Opted out");
    // "Not your gym? Remove this page" (a gym added straight to the database: the test site has only two addresses)
    const prof = { name: "Elsewhere MMA", timetable: [{ day: "Mon", start: "18:00", end: "19:00", title: "MMA", coach: "", level: "" }], coaches: [], rates: [] };
    const mk = async (name, domain, extra = {}) => (await pool.query("insert into prospects(token,website,domain,name,profile,import_state,owner_email,accent) values($1,$2,$3,$4,$5,'done',$6,$7) returning id, token",
      [outreach.newToken(), "https://" + domain, domain, name, { ...prof, name, ...extra }, "boss@" + domain, "#e65100"])).rows[0];
    const C = await mk("Elsewhere MMA", "elsewhere.test");
    r = await pub("POST", `/try/${C.token}/remove`); ok(r.s === 200 && /This page is gone/.test(r.t) && (await row(C.id)).status === "optedout", "Not your gym: the page is removed");
    ok((await pool.query("select 1 from outreach_dnc where kind='domain' and value='elsewhere.test'")).rows.length === 1 && (await pub("GET", "/try/" + C.token)).s === 404, "and its domain won't be contacted again");

    // ---------- claiming ----------
    r = await anon("GET", "/prospects/" + tokA); ok(r.s === 200 && r.j.gym.name === "Green Lions BJJ" && r.j.gym.classes >= 5 && r.j.gym.prices >= 2, "the claim screen's look at the preview");
    const adminMails = sink.mails.length;
    r = await owner("POST", "/auth/start-gym", { gym: "", name: "Thabo Nkosi", email: "thabo@greenlions.test", password: "thabopass1", prospect: tokA });
    ok(r.s === 201 && r.j.claimed && r.j.me.role === "coach" && r.j.me.gym.name === "Green Lions BJJ" && r.j.me.gym.head === true, "sign-up with the token makes the gym, with them as head coach: " + JSON.stringify(r.j && r.j.me && r.j.me.gym));
    ok(r.j.me.gym.brand.accent === "#1b7f3b" && /\/api\/gyms\/\d+\/logo/.test(r.j.me.gym.logo || ""), "the gym gets the site's colour and the logo");
    const gid = r.j.me.gym.id;
    r = await owner("GET", "/gym"); ok(r.j.gym.profile.timetable.length >= 5 && r.j.gym.profile.coaches.length === 2 && r.j.gym.profile.timetable.every((x) => x.id), "the timetable and coaches are saved through the import's own save");
    r = await owner("GET", "/coach/plans"); const plans = r.j.plans.map((p) => p.name + ":" + p.priceCents);
    ok(plans.some((x) => /Adult unlimited:85000/.test(x)) && plans.some((x) => /Kids.*:60000/.test(x)) && !plans.some((x) => /Joining/.test(x)), "membership prices became plans (not the joining fee): " + plans);
    r = await owner("GET", "/classes"); ok(r.j.classes.length >= 20, "the timetable rolls onto the calendar (" + r.j.classes.length + " classes)");
    const ra = await row(idA); ok(ra.status === "claimed" && String(ra.claimed_gym_id) === gid, "the prospect is marked claimed, with its gym");
    await wait(300);
    const told = sink.mails.slice(adminMails).filter((x) => x.subject === "Green Lions BJJ claimed JitsFlow").map((x) => x.to[0]).sort();
    ok(told.join() === "boss@jitsflow.test,second@jitsflow.test", "every admin is told: " + told);
    const gyms = Number((await pool.query("select count(*) from gyms")).rows[0].count);
    r = await anon("POST", "/auth/start-gym", { gym: "", name: "Someone Else", email: "else@gym.test", password: "elsepass12", prospect: tokA });
    ok(r.s === 409 && /claimed already/.test(r.j.error) && Number((await pool.query("select count(*) from gyms")).rows[0].count) === gyms, "a token can only be claimed once (no second gym)");
    r = await pub("GET", "/try/" + tokA); ok(r.s === 200 && /is on JitsFlow/.test(r.t) && !/claimgym/.test(r.t), "the claimed page says it's taken");
    r = await admin("POST", `/admin/prospects/${idA}/followup`, {}, { "x-jf-key": "fu4" }); ok(r.s === 409, "no follow-up to a claimed gym");
    r = await admin("GET", "/admin/prospects"); ok(r.j.prospects.find((p) => p.id === idA).label === "Claimed", "the list says Claimed");
    // Signed in with no gym: claim in one tap.
    const D = await mk("Durban Grappling", "durbangrappling.test", { rates: [{ name: "Unlimited", price: 700, currency: "ZAR", period: "month", note: "" }] });
    r = await stu("POST", "/auth/register", { name: "Lee Moodley", email: "lee@durban.test", password: "leepass123" }); ok(r.s === 201 && !r.j.me.gym, "someone signs up with no gym");
    r = await stu("POST", "/me/claim-gym", { token: D.token }); ok(r.s === 201 && r.j.me.role === "coach" && r.j.me.gym.name === "Durban Grappling" && r.j.me.gym.head && r.j.me.gym.monthlyFeeCents === 70000, "signed in with no gym, one tap claims it: " + JSON.stringify(r.j && r.j.me && r.j.me.gym && r.j.me.gym.name));
    r = await coach("POST", "/me/claim-gym", { token: (await mk("Third Gym", "third.test")).token }); ok(r.s === 409 && /already in Some Gym/.test(r.j.error), "a coach who has a gym can't claim another");
    r = await anon("POST", "/auth/start-gym", { gym: "", name: "Bad Token", email: "bad@gym.test", password: "badpass123", prospect: "nope" }); ok(r.s === 404, "a bad token is refused");
    r = await anon("POST", "/auth/start-gym", { gym: "", name: "X", email: "kim@gym.test", password: "xpass12345", prospect: (await mk("Fourth Gym", "fourth.test")).token });
    ok(r.s === 409 && (await pool.query("select status, claimed_at from prospects where domain='fourth.test'")).rows[0].claimed_at === null, "a sign-up that fails (email taken) leaves the preview claimable");

    // ---------- re-import and delete ----------
    const E = await mk("Re Import", "127.0.0.1x.test"); await pool.query("update prospects set website=$1 where id=$2", [`http://127.0.0.1:${site.port}/`, E.id]);
    r = await admin("POST", `/admin/prospects/${E.id}/reimport`, {}); ok(r.s === 200 && r.j.prospect.importing, "re-import starts");
    await settle(admin); ok((await row(E.id)).name === "Green Lions BJJ", "re-import reads the site again");
    r = await admin("DELETE", `/admin/prospects/${E.id}`); ok(r.s === 200 && !(await row(E.id)), "delete");

    // ---------- in the browser ----------
    b = await chromium.launch();
    const phone = async (cookie) => { const c = await b.newContext({ ...devices["iPhone 13"] }); if (cookie) await c.addCookies([{ name: "jf_s", value: cookie.replace("jf_s=", ""), url: BASE }]);
      await c.addInitScript(() => { if (!localStorage.getItem("rtb.progress")) localStorage.setItem("rtb.progress", JSON.stringify({ settings: { onboarded: true } })); window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI)); });
      const p = await c.newPage(); p.errs = []; p.on("pageerror", (x) => p.errs.push(x.message)); return p; };
    const ev = (p, f, a) => p.evaluate(f, a);
    // The preview page on a phone: no sideways scroll, nothing blocked by the security policy, and the beacon fires.
    const F = await mk("Fifth Gym", "fifth.test");
    { const p = await phone(); const beacon = p.waitForRequest((q) => q.url().endsWith(`/try/${F.token}/view`) && q.method() === "POST", { timeout: 6000 }).catch(() => null);
      await p.goto(`${BASE}/try/${F.token}`); const got = await beacon; await wait(400);
      ok(got && (await row(F.id)).views === 1, "the page's beacon counts the view once it's on screen");
      ok(await ev(p, () => document.documentElement.scrollWidth <= 390), "preview: no sideways scroll on a phone");
      ok((await ev(p, () => window.__csp)).length === 0 && !p.errs.length, "preview: nothing blocked by the security policy, no script errors: " + (await ev(p, () => window.__csp)).join(", ") + p.errs.join(", "));
      await p.tap("summary"); ok(await ev(p, () => !!document.querySelector("form[action$='/remove'] button") && document.querySelector("form[action$='/remove'] button").offsetHeight > 0), "Not your gym opens a Remove button");
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
    ok(/Outreach/.test(txt) && /Green Lions BJJ/.test(txt) && /Claimed/.test(txt) && /Opted out/.test(txt), "the list shows each gym with its status: " + txt.slice(0, 300).replace(/\n/g, " | "));
    ok(await ev(ap, () => document.documentElement.scrollWidth <= 390), "Outreach: no sideways scroll");
    const G = await mk("Sixth Gym", "sixth.test");
    await ap.tap('[data-a="back"]'); await wait(300); await ap.tap('[data-a="outopen"]'); await wait(1200);
    await ap.tap(`[data-a="outpro"][data-v="${G.id}"]`); await wait(1000);
    txt = await ev(ap, () => document.getElementById("sheet").innerText + " " + document.getElementById("sheetbar").innerText);
    ok(/Sixth Gym/.test(txt) && /Copy email HTML/.test(txt) && /Copy plain text/.test(txt) && /Re-import/.test(txt) && /Delete/.test(txt) && /Open preview/.test(txt) && /View email/.test(txt) && /Send email/.test(txt), "a gym's page: preview, email, copy, send, re-import, delete: " + txt.slice(0, 200).replace(/\n/g, " | "));
    await ap.fill('#outedit [name="ownerName"]', "Sam Owner"); await ap.fill('#outedit [name="ownerEmail"]', "sam@sixth.test"); await ap.fill('#outedit [name="personalLine"]', "Loved your open mat video.");
    const sb = sink.mails.length;
    await ap.tap('#sheetbar [data-a="outsend"]'); await ap.tap('#sheetbar [data-a="outsend"]').catch(() => {}); await wait(1500);
    const sent = sink.mails.slice(sb);
    ok(sent.length === 1 && sent[0].to[0] === "sam@sixth.test" && /Hi Sam,/.test(sent[0].html) && /Loved your open mat video\./.test(sent[0].html), "Send saves the edits and sends once, even tapped twice: " + sent.length);
    ok(/Sent/.test(await ev(ap, () => document.getElementById("sheetbar").innerText)) && (await row(G.id)).status === "sent", "the gym shows as Sent");
    ok(await ev(ap, () => document.documentElement.scrollWidth <= 390), "a gym's page: no sideways scroll");
    await ap.tap('[data-a="outdel"]'); await wait(400); await ap.tap('[data-a="outdel"]'); await wait(1000);
    ok(!(await row(G.id)) && await ev(ap, () => S.ui.sheet && S.ui.sheet.k === "outreach"), "Delete asks once more, then deletes and goes back to the list");
    ok(!ap.errs.length, "Outreach: no script errors " + ap.errs.join(", "));
    await ap.context().close();
    // Claiming in the app: the owner taps Claim on their page and signs up.
    const H = await mk("Seventh Gym", "seventh.test");
    { const p = await phone(); await p.goto(`${BASE}/try/${H.token}`); await wait(500);
      await p.tap(`a.btn[href*="claimgym"]`); await wait(1800);
      txt = await ev(p, () => (document.getElementById("a-claiming") || {}).innerText || "");
      ok(/Claiming\s+Seventh Gym/.test(txt) && await ev(p, () => document.getElementById("a-gym").value === "Seventh Gym" && !document.getElementById("a-site")), "the app opens sign-up saying which gym they're claiming: " + JSON.stringify(txt));
      ok(await ev(p, () => !/claimgym/.test(location.search)), "the token leaves the address bar");
      ok(await ev(p, () => getComputedStyle(document.documentElement).getPropertyValue("--blue").trim().toLowerCase() !== "#1d4fb5"), "sign-up already wears the gym's colour");
      await p.fill("#a-name", "Nomsa Dube"); await p.fill("#a-email", "nomsa@seventh.test"); await p.fill("#a-pass", "nomsapass1");
      await p.tap('#sheetbar [type=submit]'); await wait(2500);
      ok(await ev(p, () => API.me && API.me.gym && API.me.gym.name === "Seventh Gym" && API.me.gym.head && S.ui.sheet && S.ui.sheet.k === "welcome"), "claimed: they're the head coach and land on the normal first-run welcome");
      ok((await row(H.id)).status === "claimed" && !p.errs.length, "the preview is claimed " + p.errs.join(", "));
      await p.context().close(); }
  } catch (e) { fail++; fails.push("crashed: " + (e.stack || e.message)); }
  if (b) await b.close();
  srv.kill(); site.close(); sink.close(); await pool.end();
  console.log(`\noutreach: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  ✗ " + f));
  process.exit(fail ? 1 : 0);
})();
