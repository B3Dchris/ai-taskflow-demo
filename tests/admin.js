// The JitsFlow team's dashboard: visitors counted on the server without cookies, where sign-ups came from, and GET /api/admin/overview.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/admin.js   (wipes that database)
const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg");
const { chromium, devices } = require("playwright");
const visits = require("../backend/visits");
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
    return { s: r.status, j, t };
  };
  c.cookie = () => cookie;
  return c;
}
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

function start(port, extra = {}) {
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB, TRUST_PROXY: "1", PAGEVIEW_FLUSH_MS: "300", APP_URL: "https://www.jitsflow.test",
    JF_ADMIN_EMAILS: "boss@jitsflow.test", ...extra }; delete env.ANTHROPIC_API_KEY; delete env.GA_ID; delete env.RESEND_API_KEY;
  return spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
}
const up = async (base) => { for (let i = 0; i < 80; i++) { try { await fetch(base + "/healthz"); return; } catch (e) { await wait(150); } } };

(async () => {
  // ---------- sources and the sign-up source check (no server) ----------
  {
    const ch = visits.channel;
    ok(ch({ click: "gclid", ref: "google.com" }).name === "Google Ads" && ch({ click: "gclid" }).paid, "a Google Ads click id is Google Ads (paid), even with Google as the referring site");
    ok(ch({ ref: "google.co.za" }).name === "Google search" && !ch({ ref: "google.co.za" }).paid, "a Google referral without a click id is Google search (not paid)");
    ok(ch({ utm_source: "google", utm_medium: "cpc" }).name === "Google Ads" && ch({ utm_source: "facebook", utm_medium: "paid_social" }).name === "Facebook ads", "utm tags: paid Google is Google Ads; paid Facebook is Facebook ads");
    ok(ch({ utm_source: "ig" }).name === "Instagram" && ch({ ref: "l.facebook.com" }).name === "Facebook" && ch({ ref: "t.co" }).name === "X (Twitter)" && ch({ ref: "somegym.co.za" }).name === "somegym.co.za", "referring sites get plain names");
    ok(ch({}).name === "Direct" && ch({ via: "outreach" }).name === "Outreach email" && ch({ via: "code" }).name === "Gym code or invite link", "no source: direct, outreach or gym code");
    const s = visits.signupSource({ utm_source: "x".repeat(500), ref: "<script>", gclid: "abc def", gbraid: "G" + "a".repeat(400), land: "javascript:alert(1)", t: "soon", extra: { a: 1 } });
    ok(s && s.utm_source.length === 80 && !s.ref && !s.land && !s.first_at && !s.extra && !s.click, "sign-up source: cut to size; bad hosts, paths, click ids and unknown fields dropped: " + JSON.stringify(s));
    ok(visits.signupSource("nope") === null && visits.signupSource(null, "code").via === "code" && visits.signupSource({ wbraid: "WB_1-2.3" }).click === "wbraid", "sign-up source: not an object is nothing; how they signed up is kept; wbraid ids count");
    ok(visits.isBot("Mozilla/5.0 (compatible; Googlebot/2.1)") && visits.isBot("curl/8.0") && visits.isBot("") && visits.isBot("facebookexternalhit/1.1") && !visits.isBot(IPHONE) && !visits.isBot(ANDROID), "bots, scripts and link previews are spotted; phones aren't");
  }

  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists beta_feedback, site_daily, site_visitors, site_salt, prospects, outreach_dnc, autopay_charges, autopay, class_skips, plan_breaks, notices, left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const port = 9100 + Math.floor(Math.random() * 600), BASE = `http://127.0.0.1:${port}`, base = BASE + "/api";
  let srv = start(port); await up(BASE);
  const page = (url, { ua = IPHONE, ip = "198.51.100.1", headers = {}, method = "GET" } = {}) =>
    fetch(BASE + url, { method, headers: { "user-agent": ua, "x-forwarded-for": ip, "sec-fetch-dest": "document", ...headers }, redirect: "manual" }).then(async (r) => { await r.arrayBuffer(); return r.status; });
  const settle = async () => { let last = ""; for (let i = 0; i < 40; i++) { await wait(250); const r = (await pool.query("select coalesce(sum(views),0)::int as v from site_daily")).rows[0].v + "|" + (await pool.query("select count(*)::int as n, coalesce(sum(pages+app),0)::int as h from site_visitors")).rows.map((x) => x.n + "," + x.h).join(); if (r === last) return; last = r; } };
  let b;
  try {
    const admin = client(base), coach = client(base), anon = client(base), stu = client(base), solo = client(base);
    // ---------- sign-ups keep where they came from ----------
    let r = await admin("POST", "/auth/register", { name: "Boss Admin", email: "boss@jitsflow.test", password: "adminpass1", source: { utm_source: "Google", utm_medium: "cpc", utm_campaign: "Spring BJJ", gclid: "Cj0KCQiA_test-123", ref: "www.google.com", land: "/coaches/", t: Date.now() - 3600e3 } });
    ok(r.s === 201 && r.j.me.admin, "the admin signs up");
    const src = async (email) => (await pool.query("select signup_source, signed_up_at from users where email=$1", [email])).rows[0];
    let x = await src("boss@jitsflow.test");
    ok(x.signup_source.click === "gclid" && x.signup_source.click_id === "Cj0KCQiA_test-123" && x.signup_source.utm_source === "google" && x.signup_source.utm_campaign === "spring bjj" && x.signup_source.ref === "google.com" && x.signup_source.land === "/coaches/" && x.signed_up_at, "register stores the sign-up source with the Google Ads click id: " + JSON.stringify(x.signup_source));
    r = await coach("POST", "/auth/start-gym", { gym: "Lions BJJ", name: "Coach Kim", email: "kim@lions.test", password: "coachpass1", source: { utm_source: "facebook", utm_medium: "paid_social", ref: "l.facebook.com" } });
    ok(r.s === 201 && !r.j.me.admin, "a coach starts a gym (and isn't an admin)");
    x = await src("kim@lions.test"); ok(x.signup_source.utm_source === "facebook" && x.signup_source.ref === "l.facebook.com" && !x.signup_source.via, "start-gym stores the sign-up source: " + JSON.stringify(x.signup_source));
    const code = (await pool.query("select student_code from gyms where name='Lions BJJ'")).rows[0].student_code;
    r = await stu("POST", "/auth/register", { name: "Sipho Student", email: "sipho@lions.test", password: "studentpass1", code });
    x = await src("sipho@lions.test"); ok(r.s === 201 && x.signup_source && x.signup_source.via === "code", "joining with a gym code says so, with no other source: " + JSON.stringify(x.signup_source));
    r = await solo("POST", "/auth/register", { name: "Solo Sam", email: "sam@solo.test", password: "solopass12", source: "not an object" });
    await solo("GET", "/me"); x = await src("sam@solo.test"); ok(r.s === 201 && x.signup_source === null, "a sign-up with no (or a broken) source is stored without one");

    // ---------- who can see the dashboard ----------
    r = await anon("GET", "/admin/overview"); ok(r.s === 401, "the dashboard needs sign-in (" + r.s + ")");
    r = await coach("GET", "/admin/overview"); ok(r.s === 403, "a coach gets 403 (" + r.s + ")");
    r = await stu("GET", "/admin/overview?days=7"); ok(r.s === 403, "a student gets 403 (" + r.s + ")");
    r = await admin("GET", "/me"); ok(r.j.me.admin === true, "/me says admin for the admin");

    // ---------- visitors counted on the server ----------
    ok((await page("/", { ip: "198.51.100.1" })) === 200, "home page served");
    await page("/", { ip: "198.51.100.1" }); await page("/coaches/", { ip: "198.51.100.1", headers: { "cf-ipcountry": "ZA" } }); // same person: 1 visitor, 3 views
    await page("/?gclid=EAIaIQ_ads-1&utm_campaign=Gym%20Owners", { ua: ANDROID, ip: "203.0.113.7", headers: { referer: "https://www.google.com/", "cf-ipcountry": "ZA" } });
    await page("/coaches/", { ua: MAC, ip: "192.0.2.44", headers: { referer: "https://www.google.co.za/", "cf-ipcountry": "GB" } });
    await page("/coaches/", { ua: MAC, ip: "192.0.2.45", headers: { referer: "https://www.jitsflow.test/" } }); // our own site as referrer: direct
    await page("/", { ua: IPHONE, ip: "198.51.100.1, 192.0.2.99" }); // a different address at the last proxy hop: a different visitor
    await page("/app/", { ua: ANDROID, ip: "203.0.113.8" }); // an app open, not a website visitor
    // Not counted: bots, scripts, HEAD, prefetch, the service worker's offline copy, files that aren't pages, 404s and the API.
    await page("/", { ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", ip: "66.249.66.1" });
    await page("/", { ua: "curl/8.5.0", ip: "203.0.113.50" });
    await page("/", { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0 Safari/537.36", ip: "203.0.113.51" });
    await page("/", { method: "HEAD", ua: IPHONE, ip: "203.0.113.52" });
    await page("/coaches/", { ua: IPHONE, ip: "203.0.113.53", headers: { "sec-purpose": "prefetch;prerender" } });
    await page("/coaches/", { ua: IPHONE, ip: "203.0.113.54", headers: { purpose: "prefetch" } });
    await page("/", { ua: IPHONE, ip: "203.0.113.55", headers: { "sec-fetch-dest": "empty" } });
    await page("/manifest.webmanifest", { ua: IPHONE, ip: "203.0.113.56" });
    ok((await page("/no-such-page", { ua: IPHONE, ip: "203.0.113.57" })) === 404, "unknown page is a 404");
    await page("/api/status", { ua: IPHONE, ip: "203.0.113.58" });
    await wait(1000); await settle();
    const daily = Object.fromEntries((await pool.query("select path, views from site_daily")).rows.map((x) => [x.path, x.views]));
    ok(daily["/"] === 4 && daily["/coaches/"] === 3 && daily["/app/"] === 1 && Object.keys(daily).length === 3, "page views per page, bots and the rest left out: " + JSON.stringify(daily));
    const vrows = (await pool.query("select * from site_visitors order by first_path, pages")).rows;
    ok(vrows.length === 6 && vrows.filter((v) => v.pages > 0).length === 5 && vrows.filter((v) => v.app > 0).length === 1, "unique visitors per day, the same browser and address once: " + vrows.map((v) => `${v.first_path}:${v.pages}/${v.app}`).join(" "));
    const one = vrows.find((v) => v.pages === 3); ok(one && one.country === "" && one.first_path === "/", "a visitor's first page is kept (and the country from their first page)");
    const ads = vrows.find((v) => v.click); ok(ads && ads.click === "gclid" && ads.click_id === "EAIaIQ_ads-1" && ads.utm_campaign === "gym owners" && ads.ref === "google.com" && ads.country === "ZA", "a Google Ads visit keeps its click id, campaign, referrer and country: " + JSON.stringify(ads));
    const flat = JSON.stringify(vrows);
    ok(!/198\.51|203\.0|192\.0|Mozilla|iPhone|Android/.test(flat) && vrows.every((v) => /^[0-9a-f]{20}$/.test(v.vhash)), "no addresses or browser strings are stored, only a short hash");
    const salts = (await pool.query("select to_char(day,'YYYY-MM-DD') as d from site_salt")).rows;
    ok(salts.length === 1 && salts[0].d === new Date().toISOString().slice(0, 10), "one secret, for today only");

    // ---------- a gym with members, classes, bookings and payments ----------
    const G = (await pool.query("select id from gyms where name='Lions BJJ'")).rows[0].id;
    await pool.query(`insert into users(gym_id, role, name, email, pass_hash, last_seen, created_at, signed_up_at) select $1, 'student', 'Member ' || i, 'm' || i || '@lions.test', 'x',
      case when i <= 3 then now() - interval '2 days' else now() - interval '20 days' end, now() - interval '40 days', now() - interval '40 days' from generate_series(1, 6) i`, [G]);
    await pool.query("insert into users(gym_id, role, name, offline) values($1, 'student', 'Offline Olga', true)", [G]); // added by the coach, not on the app
    const parent = (await pool.query("select id from users where email='m1@lions.test'")).rows[0].id;
    await pool.query("insert into users(gym_id, role, name, parent_id, parent_name) values($1, 'student', 'Kid Kai', $2, 'Member 1')", [G, parent]);
    const cls = (await pool.query("insert into classes(gym_id, title, starts_at) select $1, 'No-gi', now() + (i || ' days')::interval from generate_series(1, 3) i returning id", [G])).rows;
    await pool.query("insert into classes(gym_id, title, starts_at) values($1, 'Far away', now() + interval '10 days'), ($1, 'Past', now() - interval '1 day')", [G]);
    const mids = (await pool.query("select id from users where email like 'm%@lions.test' order by id limit 4")).rows.map((x) => x.id);
    for (const m of mids) await pool.query("insert into attendance(class_id, user_id, going, booked_at) values($1, $2, true, now() - interval '1 day')", [cls[0].id, m]);
    await pool.query("insert into attendance(class_id, user_id, going, booked_at) values($1, $2, true, now() - interval '30 days')", [cls[1].id, mids[0]]);
    await pool.query("insert into payments(gym_id, user_id, amount_cents, paid_on, status) values($1, $2, 85000, (now() at time zone 'UTC')::date, 'confirmed'), ($1, $2, 60000, (now() at time zone 'UTC')::date, 'confirmed'), ($1, $2, 99900, (now() at time zone 'UTC')::date, 'pending'), ($1, $2, 1000, (now() - interval '62 days')::date, 'confirmed')", [G, mids[0]]);
    const G2 = (await pool.query("insert into gyms(name, student_code, coach_code, billing, created_at) values('Old Gym', 'OLDS1', 'OLDC1', $1, now() - interval '200 days') returning id", [{ status: "active", trialEnds: "2026-01-01", lastPaidAt: "2026-11-01T10:00:00Z" }])).rows[0].id;
    await pool.query("insert into gyms(name, student_code, coach_code, billing) values('Late Gym', 'LATS1', 'LATC1', $1)", [{ trialEnds: "2026-01-15" }]);
    await pool.query("update gyms set created_at=now() - interval '300 days' where name='Late Gym'");
    await pool.query("insert into prospects(token, website, domain, status, sent_at, views) values('t1', 'http://a.test', 'a.test', 'sent', now(), 2), ('t2', 'http://b.test', 'b.test', 'sent', now(), 0), ('t3', 'http://c.test', 'c.test', 'claimed', now(), 5), ('t4', 'http://d.test', 'd.test', 'draft', null, 0), ('t5', 'http://e.test', 'e.test', 'optedout', now(), 1)");

    // A gym outreach built that nobody has claimed: not a gym yet, just "built, not claimed" in the funnel.
    const BG = (await pool.query(`insert into gyms(name, student_code, coach_code, claim) values('Built Gym', 'BLTS1', 'BLTC1', '{"prospectId":"x","builtAt":"2026-11-01T00:00:00Z"}') returning id`)).rows[0].id;
    await pool.query("update prospects set gym_id=$1 where token='t4'", [BG]);
    r = await admin("GET", "/admin/overview?days=7");
    const d = r.j || {};
    ok(r.s === 200 && d.days === 7 && d.series.length === 7 && d.series[6].day === new Date().toISOString().slice(0, 10), "the admin gets the overview with 7 days of series");
    const T = d.totals || {};
    ok(T.gyms === 3 && T.coaches === 1 && T.members === 9 && T.membersOnApp === 8 && T.selfStudy === 2 && T.kids === 1, "totals: gyms, coaches, members (on the app), on their own, kids: " + JSON.stringify(T));
    ok(T.logins === 10 && T.active7 === 7 && T.active30 === 10 && T.active1 === 4 && T.new7 === 4 && T.new1 === 4 && T.new30 === 4 && T.gymsActive === 1, "people who used the app (1/7/30 days) and new sign-ups: " + JSON.stringify(T));
    ok(d.visitors.today === 5 && d.series[6].visitors === 5 && d.series[6].views === 7 && d.series[6].appOpens === 1 && d.series[6].appPeople === 1, "visitors today, page views and app opens: " + JSON.stringify(d.visitors) + JSON.stringify(d.series[6]));
    ok(d.series[6].students === 3 && d.series[6].coaches === 1 && d.series[6].gyms === 1, "sign-ups and new gyms per day: " + JSON.stringify(d.series[6]));
    const so = Object.fromEntries((d.sources || []).map((s) => [s.name, s]));
    ok(so["Google Ads"] && so["Google Ads"].n === 1 && so["Google Ads"].paid && so["Google search"] && so["Google search"].n === 1 && !so["Google search"].paid && so.Direct && so.Direct.n === 3, "visitor sources: Google Ads (paid) apart from Google search: " + JSON.stringify(d.sources));
    ok(d.campaigns.length === 1 && d.campaigns[0].name === "gym owners" && d.campaigns[0].ads, "campaigns, marked when they came from ads");
    ok(d.pages[0].path === "/" && d.pages[0].n === 4 && !d.pages.some((p) => p.path === "/app/"), "top pages (the app's page isn't a website page)");
    ok(d.countries.find((c) => c.code === "ZA").n === 1 && d.countries.find((c) => c.code === "GB").n === 1, "countries from Cloudflare's header: " + JSON.stringify(d.countries));
    const ss = Object.fromEntries((d.signupSources || []).map((s) => [s.name, s]));
    ok(ss["Google Ads"] && ss["Google Ads"].paid && ss["Google Ads"].students === 1 && ss["Facebook ads"] && ss["Facebook ads"].coaches === 1 && ss["Gym code or invite link"] && ss.Direct, "sign-ups by source: " + JSON.stringify(d.signupSources));
    const lg = d.gyms.find((g) => g.name === "Lions BJJ");
    ok(lg && lg.members === 9 && lg.onApp === 8 && lg.active7 === 4 && lg.coaches === 1 && lg.classes7 === 3 && lg.bookings7 === 4 && lg.head.name === "Coach Kim" && lg.head.email === "kim@lions.test", "a gym's members, who used the app, classes next week, bookings, head coach: " + JSON.stringify(lg));
    ok(lg.payments.n === 2 && lg.payments.cents === 145000 && lg.billing.state === "trial" && lg.lastSeen, "payments recorded this month (confirmed only) and the free trial: " + JSON.stringify(lg.payments) + JSON.stringify(lg.billing));
    const og = d.gyms.find((g) => g.name === "Old Gym"), late = d.gyms.find((g) => g.name === "Late Gym");
    ok(og.billing.state === "paying" && og.billing.lastPaidAt && late.billing.state === "due" && !og.head && og.members === 0, "billing: paying, and card needed once the free months are over");
    ok(!(await pool.query("select billing from gyms where id=$1", [G])).rows[0].billing.trialEnds, "the dashboard doesn't write to a gym's billing");
    ok(d.recent.length === 10 && d.recent.every((u) => u.at) && d.recent.find((u) => u.email === "boss@jitsflow.test").source.name === "Google Ads" && d.recent.find((u) => u.email === "kim@lions.test").role === "coach", "newest sign-ups with email, role and source");
    ok(JSON.stringify(d.outreach) === JSON.stringify({ added: 5, built: 1, sent: 4, opened: 3, claimed: 1, optedOut: 1 }), "outreach funnel, with built but not claimed: " + JSON.stringify(d.outreach));
    ok(!d.gyms.some((g) => g.name === "Built Gym") && d.series[6].gyms === 1, "an unclaimed gym isn't in the gym list, the totals or new gyms per day");
    ok(d.countingSince === new Date().toISOString().slice(0, 10), "the day visitor counting started");
    r = await admin("GET", "/admin/overview?days=90"); ok(r.j.series.length === 90 && r.j.days === 90, "90 days");
    r = await admin("GET", "/admin/overview?days=5000"); ok(r.j.days === 30, "other ranges fall back to 30 days");

    // ---------- speed on a bigger database (4,000 people) ----------
    await pool.query(`insert into gyms(name, student_code, coach_code, created_at) select 'Gym ' || i, 'S' || i, 'C' || i, now() - (i || ' days')::interval from generate_series(1, 40) i`);
    await pool.query(`insert into users(gym_id, role, name, email, pass_hash, last_seen, created_at, signed_up_at, signup_source)
      select g.id, case when i % 50 = 0 then 'coach' else 'student' end, 'P' || i, 'p' || i || '@big.test', 'x', now() - ((i % 60) || ' days')::interval, now() - ((i % 120) || ' days')::interval, now() - ((i % 120) || ' days')::interval,
        case i % 4 when 0 then '{"ref":"google.com"}'::jsonb when 1 then '{"click":"gclid","click_id":"abc"}'::jsonb else null end
      from generate_series(1, 4000) i join lateral (select id from gyms where name = 'Gym ' || (1 + i % 40)) g on true`);
    await pool.query(`insert into classes(gym_id, title, starts_at) select g.id, 'C', now() + ((k - 28) || ' days')::interval from gyms g, generate_series(1, 35) k where g.name like 'Gym %'`);
    await pool.query(`insert into attendance(class_id, user_id, booked_at) select c.id, u.id, c.starts_at - interval '2 days' from classes c join users u on u.gym_id=c.gym_id and u.id % 7 = c.id % 7 where c.title='C'`);
    await pool.query(`insert into payments(gym_id, user_id, amount_cents, paid_on) select gym_id, id, 50000, (now() - ((id % 90) || ' days')::interval)::date from users where email like '%@big.test'`);
    await pool.query(`insert into site_visitors(day, vhash, first_path, ref, pages, app) select (now() - ((i % 400) || ' days')::interval)::date, md5(i::text), '/', case when i % 3 = 0 then 'google.com' else '' end, 1, 0 from generate_series(1, 60000) i on conflict do nothing`);
    await pool.query(`insert into site_daily(day, path, views) select (now() - (d || ' days')::interval)::date, '/p' || k || '/', 3 from generate_series(1, 395) d, generate_series(1, 150) k on conflict do nothing`);
    await pool.query("analyze");
    await admin("GET", "/admin/overview?days=30");
    const times = []; for (const dd of [7, 30, 90, 30]) { const t0 = Date.now(); r = await admin("GET", "/admin/overview?days=" + dd); times.push(Date.now() - t0); }
    const best = Math.min(...times);
    console.log("overview on 4,000 people, 60,000 visitor-days: " + times.join(" / ") + " ms");
    ok(r.s === 200 && r.j.totals.logins > 4000 && best < 200, "the overview answers in under 200 ms on a 4,000-person database (" + times.join("/") + " ms)");

    // ---------- in the browser ----------
    b = await chromium.launch();
    const phone = async (cookie, opts = {}) => { const c = await b.newContext({ ...devices["iPhone 13"], ...opts }); if (cookie) await c.addCookies([{ name: "jf_s", value: cookie.replace("jf_s=", ""), url: BASE }]);
      await c.addInitScript(() => { if (!localStorage.getItem("rtb.progress")) localStorage.setItem("rtb.progress", JSON.stringify({ settings: { onboarded: true } })); });
      const p = await c.newPage(); p.errs = []; p.on("pageerror", (x) => p.errs.push(x.message)); return p; };
    const ev = (p, f, a) => p.evaluate(f, a);
    // A visitor from a Google ad: the landing page keeps the click id in the browser and it goes with their sign-up.
    { const p = await phone(); await p.goto(BASE + "/coaches/?utm_source=google&utm_medium=cpc&utm_campaign=owners&gclid=TeSt_CLICK-9"); await wait(300);
      const saved = await ev(p, () => JSON.parse(localStorage.getItem("jf.src") || "null"));
      ok(saved && saved.gclid === "TeSt_CLICK-9" && saved.land === "/coaches/" && saved.utm_campaign === "owners", "the landing page keeps the ad click in the browser (no cookie): " + JSON.stringify(saved));
      ok(!(await p.context().cookies()).length, "no cookies set on the website");
      await p.goto(BASE + "/?utm_source=other"); ok((await ev(p, () => JSON.parse(localStorage.getItem("jf.src")).gclid)) === "TeSt_CLICK-9", "the first ad click isn't replaced by a later visit");
      await p.goto(BASE + "/app/?start=1"); await wait(1500);
      await p.fill("#a-gym", "Ad Gym"); await p.fill("#a-name", "Ada Owner"); await p.fill("#a-email", "ada@adgym.test"); await p.fill("#a-pass", "adapass123");
      await p.tap("#sheetbar [type=submit]"); await wait(2000);
      x = await src("ada@adgym.test");
      ok(x && x.signup_source && x.signup_source.click === "gclid" && x.signup_source.click_id === "TeSt_CLICK-9" && x.signup_source.utm_campaign === "owners" && x.signup_source.land === "/coaches/", "a gym started after the ad keeps the click id: " + JSON.stringify(x && x.signup_source));
      ok(!p.errs.length, "no script errors signing up: " + p.errs.join(", "));
      await p.context().close(); }
    // Only admins see the dashboard.
    { const p = await phone(coach.cookie()); await p.goto(BASE + "/app/#me"); await wait(1500);
      ok(await ev(p, () => !document.querySelector('[data-a="dashopen"]') && !document.getElementById("dashpanel")), "a coach doesn't see the dashboard"); await p.context().close(); }
    for (const [label, opts] of [["phone", {}], ["phone, dark", { colorScheme: "dark" }], ["desktop", { viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 }]]) {
      const p = await phone(admin.cookie(), opts); const w = opts.viewport ? opts.viewport.width : 390;
      await p.goto(BASE + "/app/#me"); await wait(1500);
      ok(await ev(p, () => !!document.querySelector('#dashpanel [data-a="dashopen"]')), `${label}: the admin sees the dashboard panel in Me`);
      await ev(p, () => { if (!document.getElementById("sheet").hidden) hideSheet(); go("me"); }); await wait(300); // the first-run welcome
      await p.click('[data-a="dashopen"]'); await wait(1500);
      ok(await ev(p, () => document.querySelectorAll("#dash-gyms .dgym").length === 12 && /Show all 44 gyms/.test(document.getElementById("dash-gyms").innerText)), `${label}: the 12 biggest gyms first, with Show all`);
      await p.click('[data-a="dashallgyms"]'); await wait(200);
      const t = await ev(p, () => document.getElementById("sheet").innerText);
      ok(/Dashboard/.test(t) && /Visitors today/i.test(t) && /Lions BJJ/.test(t) && /Google Ads/.test(t) && /Coach Kim/.test(t) && /kim@lions\.test/.test(t) && /Used the app this week/i.test(t), `${label}: the dashboard shows tiles, gyms, sources and head coaches: ` + t.slice(0, 200).replace(/\n/g, " | "));
      ok(await ev(p, (w) => document.documentElement.scrollWidth <= w && [...document.querySelectorAll("#sheet *")].every((e) => e.getBoundingClientRect().right <= w + 1), w), `${label}: no sideways scroll`);
      ok(await ev(p, () => document.querySelectorAll("#sheet .chart svg").length === 2 && document.querySelectorAll("#sheet .chart .bar").length === 60), `${label}: two charts, 30 days each`);
      if (label === "phone") {
        await p.tap('[data-a="dashdays"][data-v="7"]'); await wait(1200);
        ok(await ev(p, () => DASH.days === 7 && document.querySelectorAll("#sheet .chart .bar").length === 14 && document.querySelector('[data-a="dashdays"][data-v="7"]').getAttribute("aria-pressed") === "true"), "the range switches to 7 days");
        await p.fill("#dash-q", "lions"); await wait(200);
        ok(await ev(p, () => document.querySelectorAll("#dash-gyms .dgym").length === 1), "searching gyms filters the list");
        await p.fill("#dash-q", ""); await p.tap('[data-a="dashsort"][data-v="newest"]'); await wait(200);
        ok(await ev(p, () => document.querySelector("#dash-gyms .dgym b").textContent === "Ad Gym"), "sorting by newest puts the newest gym first");
        await p.tap("#sheetbar [data-a=back]"); await wait(400);
        ok(await ev(p, () => document.getElementById("sheet").hidden), "Close goes back to Me");
      }
      ok(!p.errs.length, `${label}: no script errors: ` + p.errs.join(", "));
      await p.context().close();
    }

    // ---------- the last minute's counts are written when the server stops; old days are deleted ----------
    srv.kill("SIGTERM"); await wait(800);
    await pool.query("insert into site_daily(day, path, views) values((now() - interval '14 months')::date, '/old/', 5)");
    await pool.query("insert into site_salt(day, salt) values('2020-01-01', 'old')");
    const port2 = port + 1, B2 = `http://127.0.0.1:${port2}`; srv = start(port2, { PAGEVIEW_FLUSH_MS: "600000" }); await up(B2);
    const before = (await pool.query("select coalesce(sum(views),0)::int as v from site_daily where path='/privacy/'")).rows[0].v;
    await fetch(B2 + "/privacy/", { headers: { "user-agent": IPHONE, "x-forwarded-for": "198.51.100.200" } }).then((x) => x.text());
    await wait(300);
    const exited = new Promise((res) => srv.once("exit", res)); srv.kill("SIGTERM"); await Promise.race([exited, wait(6000)]);
    const after = (await pool.query("select coalesce(sum(views),0)::int as v from site_daily where path='/privacy/'")).rows[0].v;
    ok(after === before + 1, `the counts still in memory are written on SIGTERM (${before} → ${after})`);
    ok(!(await pool.query("select 1 from site_daily where path='/old/'")).rows.length && !(await pool.query("select 1 from site_salt where day='2020-01-01'")).rows.length, "days older than 13 months, and old secrets, are deleted");
    srv = null;
  } catch (e) { fail++; fails.push("crashed: " + (e.stack || e.message)); }
  if (b) await b.close();
  if (srv) srv.kill(); await pool.end();
  console.log(`\nadmin: ${pass} passed, ${fail} failed`); fails.forEach((f) => console.log("  ✗ " + f));
  process.exit(fail ? 1 : 0);
})();
