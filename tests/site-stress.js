// Whole-site stress and abuse test against a real server and PostgreSQL:
//   1. every API route refuses the wrong people (signed out, students on coach routes, other gyms, cross-site posts)
//   2. bad input (broken JSON, huge bodies, junk values, script and SQL in text) is refused or stored harmlessly
//   3. sign-in limits can't be dodged by faking the visitor's address
//   4. 150 students and a coach using the site at the same time: no errors, and how long each kind of request takes
//   5. the public website: every page in the sitemap loads, no broken internal links or images
// Usage: DATABASE_URL=postgres://.../<something>test node tests/site-stress.js   (wipes that database)
const { spawn } = require("child_process"); const path = require("path"); const crypto = require("crypto"); const { Pool } = require("pg");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = [], notes = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const DAY = 864e5, wait = (ms) => new Promise((r) => setTimeout(r, ms)), N = 150;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };

(async () => {
  const pool = new Pool({ connectionString: DB, max: 10 });
  await pool.query("drop table if exists autopay_charges, autopay, class_skips, plan_breaks, left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const port = 9200 + Math.floor(Math.random() * 90), ORIGIN = `http://127.0.0.1:${port}`, base = ORIGIN + "/api";
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB, TRUST_PROXY: "0" }; // the test client talks to the app directly, with no proxy in between delete env.RESEND_API_KEY; delete env.ANTHROPIC_API_KEY; delete env.GA_ID;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60; i++) { try { await fetch(ORIGIN + "/healthz"); break; } catch (e) { await wait(150); } }
  const stat = {}; let serverErrors = 0;
  const call = (cookie) => async (method, url, body, extra = {}) => {
    const h = { ...(extra.headers || {}) }; if (cookie) h.cookie = "jf_s=" + cookie;
    if (method !== "GET" && !extra.noJf) { h["content-type"] = h["content-type"] || "application/json"; h["x-jf"] = "1"; }
    const t = Date.now(); const r = await fetch(base + url, { method, headers: h, body: extra.raw !== undefined ? extra.raw : body === undefined ? undefined : JSON.stringify(body) });
    const ms = Date.now() - t, key = method + " " + url.replace(/\/\d+/g, "/:id").replace(/\?.*/, "");
    (stat[key] = stat[key] || []).push(ms); if (r.status >= 500) serverErrors++;
    let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j };
  };
  const anon = call(null);
  try {
    // ---- seed: a busy gym and a second gym
    const mk = async (gym, role, name, email) => {
      const hash = "$2a$11$" + "x".repeat(53);
      const id = (await pool.query("insert into users(gym_id,role,name,email,pass_hash,created_at) values($1,$2,$3,$4,$5,now()-interval '150 days') returning id", [gym, role, name, email, hash])).rows[0].id;
      const tok = crypto.randomBytes(32).toString("hex"); await pool.query("insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '1 day')", [sha(tok), id]);
      return { id: String(id), tok, api: call(tok) };
    };
    const g1 = (await pool.query("insert into gyms(name,student_code,coach_code) values('Busy Gym','STUDENT1','COACHAA1') returning id")).rows[0].id;
    const g2 = (await pool.query("insert into gyms(name,student_code,coach_code) values('Other Gym','STUDENT2','COACHAA2') returning id")).rows[0].id;
    const coach = await mk(g1, "coach", "Coach Kim", "kim@stress.test"), other = await mk(g2, "coach", "Other Coach", "oc@stress.test");
    const studs = []; for (let i = 0; i < N; i++) studs.push(await mk(g1, "student", `Student ${i}`, `s${i}@stress.test`));
    const stu = studs[0], xss = await mk(g1, "student", `<img src=x onerror="window.__x=1">Mallory`, "mallory@stress.test");
    const cls = [];
    for (let d = -120; d <= 30; d++) for (const h of [6, 17, 18]) { const t = new Date(Date.now() + d * DAY); t.setUTCHours(h, 0, 0, 0); cls.push({ t, cap: h === 18 ? 25 : null }); }
    const ids = [];
    for (let i = 0; i < cls.length; i += 200) {
      const chunk = cls.slice(i, i + 200), vals = [], params = [];
      chunk.forEach((c, k) => { vals.push(`($${k * 4 + 1},$${k * 4 + 2},$${k * 4 + 3},$${k * 4 + 4})`); params.push(g1, "Class " + c.t.getUTCHours(), c.t, c.cap); });
      ids.push(...(await pool.query(`insert into classes(gym_id,title,starts_at,capacity) values ${vals.join(",")} returning id, starts_at`, params)).rows);
    }
    const past = ids.filter((c) => new Date(c.starts_at) < new Date()), future = ids.filter((c) => new Date(c.starts_at) > new Date());
    const att = []; past.forEach((c, i) => { for (let k = 0; k < 10; k++) att.push(`(${c.id},${studs[(i * 13 + k * 7) % N].id},true,true)`); });
    for (let i = 0; i < att.length; i += 3000) await pool.query("insert into attendance(class_id,user_id,going,attended) values " + att.slice(i, i + 3000).join(",") + " on conflict do nothing");
    const otherCls = (await pool.query("insert into classes(gym_id,title,starts_at) values($1,'Theirs',now()+interval '2 days') returning id", [g2])).rows[0].id;
    const comp = (await coach.api("POST", "/coach/competitions", { name: "Open", startsOn: new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10) })).j.competition.id;
    const plan = (await coach.api("POST", "/coach/plans", { name: "Unlimited", priceCents: 85000, period: "month" })).j.plan.id;
    const pay = (await coach.api("POST", "/coach/payments", { userId: stu.id, amountCents: 85000, paidOn: new Date().toISOString().slice(0, 10) })).j.payment.id;
    notes.push(`seeded ${N + 1} students, ${ids.length} classes, ${att.length} past check-ins`);

    // ---- 1. who can call what
    const fid = future[0].id;
    const studentRoutes = [["GET", "/progress"], ["PUT", "/progress", { data: {} }], ["GET", "/logs"], ["PUT", "/logs/abc", { data: { date: "2026-01-01" } }], ["GET", "/classes"], ["PUT", `/classes/${fid}/rsvp`, { going: true }],
      ["POST", `/classes/${fid}/checkin`], ["GET", "/competitions"], ["POST", `/competitions/${comp}/request`, {}], ["GET", "/gym"], ["GET", "/me/membership"], ["PATCH", "/me", { name: "x" }], ["DELETE", "/me", { password: "x" }]];
    const coachRoutes = [["POST", "/classes", { title: "x", startsAt: new Date().toISOString() }], ["PUT", `/classes/${fid}`, { title: "x" }], ["DELETE", `/classes/${fid}`], ["GET", `/coach/classes/${fid}`], ["PUT", `/coach/classes/${fid}/attendance`, { userId: stu.id }],
      ["GET", "/coach/roster"], ["GET", `/coach/students/${stu.id}`], ["PATCH", `/coach/students/${stu.id}`, { belt: "black" }], ["PATCH", "/coach/gym", { name: "Hacked" }], ["POST", "/coach/codes/rotate", {}], ["POST", "/coach/invite", { emails: "a@b.co" }],
      ["GET", "/coach/payments"], ["POST", "/coach/payments", { amountCents: 1, paidOn: "2026-01-01" }], ["PATCH", `/coach/payments/${pay}`, { userId: null }], ["DELETE", `/coach/payments/${pay}`], ["GET", "/coach/plans"], ["POST", "/coach/plans", { name: "x", priceCents: 1 }],
      ["PATCH", `/coach/plans/${plan}`, { name: "x", priceCents: 1 }], ["POST", "/coach/plans/from-rates"], ["GET", "/coach/insights"], ["POST", "/coach/message", { userIds: [stu.id], subject: "x", text: "y" }], ["POST", "/coach/import", { url: "https://example.com" }],
      ["PUT", "/coach/gym/profile", { profile: {} }], ["POST", "/coach/classes/bulk", { classes: [] }], ["POST", "/coach/competitions", { name: "x", startsOn: "2027-01-01" }], ["PUT", `/coach/competitions/${comp}`, { name: "x", startsOn: "2027-01-01" }],
      ["DELETE", `/coach/competitions/${comp}`], ["PUT", `/coach/competitions/${comp}/competitors/${stu.id}`, { status: "entered" }], ["POST", "/coach/competitions/import", { url: "https://example.com" }]];
    let bad = [];
    for (const [m, u, b] of [...studentRoutes, ...coachRoutes]) { const r = await anon(m, u, b); if (r.s !== 401) bad.push(`${m} ${u} -> ${r.s}`); }
    ok(!bad.length, "signed out: every account route answers 401 " + bad.join("; "));
    bad = []; for (const [m, u, b] of coachRoutes) { const r = await stu.api(m, u, b); if (r.s !== 403) bad.push(`${m} ${u} -> ${r.s}`); }
    ok(!bad.length, "students get 403 on every coach route " + bad.join("; "));
    bad = []; for (const [m, u, b] of coachRoutes.filter(([, u]) => /\/\d+/.test(u))) { const r = await other.api(m, u, b); if (![404, 400].includes(r.s)) bad.push(`${m} ${u} -> ${r.s}`); }
    ok(!bad.length, "another gym's coach can't reach this gym's classes, students, payments, plans or competitions " + bad.join("; "));
    const r404 = await stu.api("PUT", `/classes/${otherCls}/rsvp`, { going: true }); ok(r404.s === 404, "students can't book another gym's class");
    bad = []; for (const [m, u, b] of [...studentRoutes, ...coachRoutes].filter(([m]) => m !== "GET")) { const r = await coach.api(m, u, b, { noJf: true }); if (r.s !== 403) bad.push(`${m} ${u} -> ${r.s}`); }
    ok(!bad.length, "every change without the site's own header (a cross-site form post) is blocked " + bad.join("; "));
    ok((await pool.query("select name from gyms where id=$1", [g1])).rows[0].name === "Busy Gym", "and none of those attempts changed anything");

    // ---- 2. bad input
    let r = await stu.api("PUT", "/progress", undefined, { raw: "{not json" }); ok(r.s === 400, "broken JSON is refused cleanly");
    r = await stu.api("PUT", "/progress", undefined, { raw: JSON.stringify({ data: { x: "y".repeat(450000) } }) }); ok(r.s === 413, "a body over 400 KB is refused");
    r = await stu.api("PUT", "/progress", { data: { notes: { a: "y".repeat(310000) } } }); ok(r.s === 413 || r.s === 400, "progress over the size limit is refused");
    r = await stu.api("PUT", "/logs/x'; drop table users;--", { data: { date: "2026-01-01" } }); ok(r.s === 400, "odd log ids are refused");
    r = await coach.api("POST", "/classes", { title: "'); drop table classes;-- <script>alert(1)</script>", startsAt: new Date(Date.now() + 5 * DAY).toISOString(), capacity: -5, durationMin: 99999 });
    ok(r.s === 201 && r.j.class.title.includes("drop table") && r.j.class.capacity === 1 && r.j.class.durationMin === 600, "SQL and script in a class title are stored as plain text; silly numbers are clamped");
    ok(Number((await pool.query("select count(*) from users")).rows[0].count) === N + 3, "the users table is still there");
    r = await coach.api("POST", "/coach/payments", { amountCents: "NaN", paidOn: "2026-01-01" }); ok(r.s === 400, "a payment with no amount is refused");
    r = await coach.api("POST", "/coach/payments", { amountCents: -500, paidOn: "2026-01-01" }); ok(r.s === 400, "a negative payment is refused");
    r = await coach.api("PATCH", `/coach/students/${stu.id}`, { belt: "rainbow" }); ok(r.s === 400, "unknown belts are refused");
    r = await coach.api("POST", "/coach/competitions", { name: "x", startsOn: "2027-13-45" }); ok(r.s === 400, "impossible dates are refused");
    r = await coach.api("POST", "/coach/payments", { amountCents: 100, paidOn: "2026-02-31" }); ok(r.s === 400, "31 February is refused");
    r = await coach.api("POST", "/coach/import", { url: "file:///etc/passwd" }); ok(r.s === 400, "importing a local file is refused");
    r = await coach.api("POST", "/coach/import", { url: "http://169.254.169.254/latest/meta-data" }); ok(r.s === 400, "importing the cloud metadata address is refused");
    r = await stu.api("PATCH", "/me", { name: "z".repeat(5000) }); ok(r.s === 200 && r.j.me.name.length === 80, "very long names are cut to 80 characters");
    r = await coach.api("GET", "/coach/roster"); ok(r.j.people.some((p) => p.name.startsWith("<img")), "a name containing HTML is kept as text (the screens must escape it: see ui-sweep)");

    // ---- 3. sign-in limits
    let last; for (let i = 0; i < 32; i++) last = await anon("POST", "/auth/login", { email: `nobody${i}@stress.test`, password: "wrong" }, { headers: { "x-forwarded-for": `10.0.${i}.${i}` } });
    ok(last.s === 429, "faking a different address on each try doesn't get round the sign-in limit (got " + last.s + ")");

    // ---- 4. everyone at once
    const fut = future.map((c) => c.id), logBody = { date: "2026-11-01", type: "Class", mins: 90, rolls: 5, taught: ["knee_cut"], hits: [], tapped: [], stuck: [], worked: "x".repeat(400), fix: "" };
    const prog = { v: 1, mastery: Object.fromEntries(Array.from({ length: 137 }, (_, i) => ["t" + i, i % 5])), notes: { a: "n".repeat(20000) }, srs: {}, settings: { onboarded: true } };
    const session = async (s, i) => {
      await s.api("GET", "/me"); await s.api("GET", "/classes"); await s.api("GET", "/competitions"); await s.api("GET", "/gym"); await s.api("GET", "/me/membership");
      await s.api("PUT", "/progress", { data: prog }); await s.api("PUT", `/logs/s${i}x`, { data: logBody }); await s.api("GET", "/logs");
      const c = fut[(i * 7) % fut.length]; await s.api("PUT", `/classes/${c}/rsvp`, { going: true }); if (i % 3 === 0) await s.api("PUT", `/classes/${c}/rsvp`, { going: false });
      await s.api("GET", "/classes");
    };
    const coachLoop = async () => { for (let k = 0; k < 6; k++) { await coach.api("GET", "/coach/roster"); await coach.api("GET", "/coach/insights"); await coach.api("GET", `/classes?from=${new Date(Date.now() - 60 * DAY).toISOString()}&to=${new Date(Date.now() + 100 * DAY).toISOString()}`); await coach.api("GET", "/coach/payments"); await coach.api("GET", "/competitions"); } };
    const t0 = Date.now(); const errs0 = serverErrors;
    await Promise.all([...studs.map((s, i) => session(s, i)), coachLoop()]);
    const took = Date.now() - t0;
    ok(serverErrors === errs0, `no server errors with ${N} students and a coach using the site at once (${serverErrors - errs0})`);
    notes.push(`${N} simultaneous student sessions (11 requests each) plus a busy coach finished in ${took} ms`);
    const slow = Object.entries(stat).filter(([k]) => !/import|auth\/login/.test(k)).map(([k, a]) => [k, pct(a, 95), a.length]).filter(([, p]) => p > 2000);
    ok(!slow.length, "95% of every kind of request under 2 seconds under load: " + slow.map(([k, p]) => `${k} ${p}ms`).join("; "));
    const booked = Number((await pool.query("select count(*) from attendance a join classes c on c.id=a.class_id where a.going and a.waitlisted")).rows[0].count);
    ok(booked === 0, "after the rush nobody is both booked and waiting");
    const over = (await pool.query("select c.id from classes c where c.capacity is not null and (select count(*) from attendance a where a.class_id=c.id and a.going) > c.capacity and c.starts_at > now()")).rows;
    ok(!over.length, "no class went over its spot limit");

    // ---- 5. the public website
    const sm = await (await fetch(ORIGIN + "/sitemap.xml")).text();
    const urls = [...sm.matchAll(/<loc>https:\/\/www\.jitsflow\.com([^<]*)<\/loc>/g)].map((m) => m[1]);
    const seen = new Map(), broken = [];
    const check = async (u) => { if (seen.has(u)) return seen.get(u); const r = await fetch(ORIGIN + u, { redirect: "manual" }); seen.set(u, r.status); return r.status; };
    let biggest = 0;
    // The app (/app/) is one big page of JavaScript, not a content page: its size and its code aren't link-checked here.
    for (let i = 0; i < urls.length; i += 20) await Promise.all(urls.slice(i, i + 20).map(async (u) => {
      const r = await fetch(ORIGIN + u); const html = await r.text(); if (u === "/app/") { if (r.status !== 200) broken.push("/app/ -> " + r.status); return; } biggest = Math.max(biggest, html.length);
      if (r.status !== 200) { broken.push(`${u} -> ${r.status}`); return; }
      const refs = [...html.matchAll(/(?:href|src)="(\/[^"#?]*)/g)].map((m) => m[1]).filter((x) => !x.startsWith("//") && !x.startsWith("/app/") && !x.startsWith("/api/"));
      for (const ref of refs) { const s = await check(ref); if (s !== 200 && s !== 301) broken.push(`${u} links to ${ref} (${s})`); }
    }));
    ok(urls.length > 150 && !broken.length, `all ${urls.length} public pages load and none has a broken internal link or image ` + broken.slice(0, 8).join("; "));
    ok(biggest < 200000, `no content page is over 200 KB (largest ${Math.round(biggest / 1024)} KB)`);
    const t1 = Date.now(); await Promise.all(Array.from({ length: 200 }, (_, i) => fetch(ORIGIN + urls[i % urls.length]).then((r) => r.text())));
    notes.push(`200 page views at once: ${Date.now() - t1} ms`);
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e)); }
  srv.kill(); await pool.end();
  console.log(`site-stress: ${pass} passed, ${fail} failed`); notes.forEach((n) => console.log("  note", n));
  Object.entries(stat).sort((a, b) => pct(b[1], 95) - pct(a[1], 95)).slice(0, 8).forEach(([k, a]) => console.log(`  p95 ${String(pct(a, 95)).padStart(5)} ms  p50 ${String(pct(a, 50)).padStart(4)} ms  ×${a.length}  ${k}`));
  fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
