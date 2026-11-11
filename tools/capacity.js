// Capacity test: how much traffic the app handles on a given server size, against a real server and PostgreSQL.
// Seeds GYMS gyms with MEMBERS members each (months of classes, check-ins, payments, journals), then sends app
// "visits" at rising rates (each visit = the requests the app makes when a member or coach opens it and does one thing)
// until 95% of requests take longer than P95_LIMIT ms or more than 1% fail.
// Usage (wipes that database):
//   DATABASE_URL=postgres://.../<something>test node tools/capacity.js
// Optional: GYMS=40 MEMBERS=100 STEP_S=30 RATES=2,4,8,... APP_CGROUP=jfapp DB_CGROUP=jfdb (cgroup v1 names that cap CPU/memory)
const { spawn, execSync } = require("child_process"); const path = require("path"); const crypto = require("crypto"); const fs = require("fs"); const { Pool } = require("pg");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
const GYMS = Number(process.env.GYMS) || 40, MEMBERS = Number(process.env.MEMBERS) || 100, STEP_S = Number(process.env.STEP_S) || 30;
const RATES = (process.env.RATES || "1,2,3,4,6,8,12,16,24,32,48").split(",").map(Number), P95_LIMIT = Number(process.env.P95_LIMIT) || 1000;
const DAY = 864e5, wait = (ms) => new Promise((r) => setTimeout(r, ms)), sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };
const toCgroup = (name, pids) => { if (!name) return; for (const c of ["cpu", "memory"]) { const f = `/sys/fs/cgroup/${c}/${name}/cgroup.procs`; if (fs.existsSync(f)) for (const p of pids) try { fs.writeFileSync(f, String(p)); } catch (e) {} } };
const rssOf = (pid) => { try { return Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))[1]) / 1024; } catch (e) { return 0; } };

(async () => {
  const pool = new Pool({ connectionString: DB, max: 8 });
  const t00 = Date.now();
  await pool.query("drop schema public cascade; create schema public");
  const port = 9600 + Math.floor(Math.random() * 90), ORIGIN = `http://127.0.0.1:${port}`, base = ORIGIN + "/api";
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB, TRUST_PROXY: "0", NODE_ENV: "production" };
  delete env.RESEND_API_KEY; delete env.ANTHROPIC_API_KEY; delete env.GA_ID;
  const start = () => { const s = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] }); return s; };
  let srv = start();
  for (let i = 0; i < 100; i++) { try { if ((await fetch(ORIGIN + "/healthz")).ok) break; } catch (e) {} await wait(150); }
  srv.kill(); await wait(500); // tables are made; seed straight into the database

  // ---------- seed ----------
  const hash = "$2a$11$" + "x".repeat(53), users = [];
  const now = Date.now(), planBlob = JSON.stringify({ v: 1, mastery: Object.fromEntries(Array.from({ length: 137 }, (_, i) => ["t" + i, i % 5])), notes: { a: "n".repeat(3000) }, srs: {}, settings: { onboarded: true } });
  for (let g = 0; g < GYMS; g++) {
    const gym = (await pool.query("insert into gyms(name,student_code,coach_code,created_at) values($1,$2,$3,now()-interval '200 days') returning id", [`Gym ${g}`, "S" + crypto.randomBytes(5).toString("hex"), "C" + crypto.randomBytes(5).toString("hex")])).rows[0].id;
    const plan = (await pool.query("insert into plans(gym_id,name,price_cents) values($1,'Adult unlimited',85000) returning id", [gym])).rows[0].id;
    const coach = (await pool.query("insert into users(gym_id,role,name,email,pass_hash,created_at) values($1,'coach',$2,$3,$4,now()-interval '200 days') returning id", [gym, `Coach ${g}`, `c${g}@cap.test`, hash])).rows[0].id;
    await pool.query("update gyms set head_coach_id=$1 where id=$2", [coach, gym]);
    const vals = []; for (let m = 0; m < MEMBERS; m++) vals.push(`(${gym},'student','Member ${g}-${m}','m${g}_${m}@cap.test','${hash}',now()-interval '180 days',${plan},current_date-150)`);
    const studs = (await pool.query("insert into users(gym_id,role,name,email,pass_hash,created_at,plan_id,plan_started) values " + vals.join(",") + " returning id")).rows.map((r) => r.id);
    // classes: 4 a day, 120 days back to 56 ahead; evening ones have a 30-spot limit
    const cl = []; for (let d = -120; d <= 56; d++) for (const h of [4, 10, 15, 17]) { const t = new Date(now + d * DAY); t.setUTCHours(h, 0, 0, 0); cl.push(`(${gym},'${h < 12 ? "Fundamentals" : "All levels"}','${t.toISOString()}',${h >= 15 ? 30 : "null"},${coach})`); }
    const cls = (await pool.query("insert into classes(gym_id,title,starts_at,capacity,created_by) values " + cl.join(",") + " returning id, starts_at")).rows;
    const past = cls.filter((c) => new Date(c.starts_at) < new Date()), fut = cls.filter((c) => new Date(c.starts_at) > new Date() && new Date(c.starts_at) < new Date(now + 3 * DAY));
    const att = []; past.forEach((c, i) => { for (let k = 0; k < 12; k++) att.push(`(${c.id},${studs[(i * 13 + k * 7) % MEMBERS]},true,true)`); });
    for (let i = 0; i < att.length; i += 4000) await pool.query("insert into attendance(class_id,user_id,going,attended) values " + att.slice(i, i + 4000).join(",") + " on conflict do nothing");
    const pay = []; studs.forEach((u, i) => { for (let mo = 1; mo <= 4; mo++) if (!(mo === 1 && i % 10 === 0)) pay.push(`(${gym},${u},85000,current_date-${mo * 30 - 25},'EFT')`); });
    await pool.query("insert into payments(gym_id,user_id,amount_cents,paid_on,reference) values " + pay.join(","));
    await pool.query("insert into progress(user_id,data) select unnest($1::bigint[]), $2::jsonb", [studs, planBlob]);
    const logs = []; studs.forEach((u) => { for (let k = 0; k < 30; k++) logs.push(`(${u},'l${k}',current_date-${k * 4},'{"type":"Class","mins":90,"rolls":5,"worked":"${"w".repeat(300)}"}')`); });
    for (let i = 0; i < logs.length; i += 4000) await pool.query("insert into training_logs(user_id,id,date,data) values " + logs.slice(i, i + 4000).join(","));
    const mk = async (id, role) => { const tok = crypto.randomBytes(32).toString("hex"); await pool.query("insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '60 days')", [sha(tok), id]); users.push({ role, id, gym, tok, fut: fut.map((c) => c.id) }); };
    await mk(coach, "coach"); for (const s of studs) await mk(s, "student");
  }
  await pool.query("update users set last_seen=now()-interval '10 minutes'"); // people who used the app recently (no first-visit writes)
  await pool.query("vacuum analyze");
  const size = (await pool.query("select pg_size_pretty(pg_database_size(current_database())) s")).rows[0].s;
  const counts = (await pool.query("select (select count(*) from users) u, (select count(*) from classes) c, (select count(*) from attendance) a, (select count(*) from payments) p, (select count(*) from training_logs) l")).rows[0];
  console.log(`seeded in ${Math.round((Date.now() - t00) / 1000)}s: ${GYMS} gyms, ${counts.u} people, ${counts.c} classes, ${counts.a} check-ins, ${counts.p} payments, ${counts.l} journal entries; database ${size}`);

  // ---------- server, capped like the host ----------
  if (process.env.DB_CGROUP) toCgroup(process.env.DB_CGROUP, execSync("pgrep -u postgres").toString().trim().split(/\s+/));
  srv = start(); toCgroup(process.env.APP_CGROUP, [srv.pid]);
  for (let i = 0; i < 200; i++) { try { if ((await fetch(ORIGIN + "/healthz")).ok) break; } catch (e) {} await wait(150); }
  await wait(8000); // let the start-up jobs (timetable roll, reminders) finish
  let peakRss = 0; const rssTimer = setInterval(() => { peakRss = Math.max(peakRss, rssOf(srv.pid)); }, 500);

  let lat = [], errs = 0, n = 0, byKey = {}; const refused = {};
  const call = (u) => async (method, url, body) => {
    const h = { cookie: "jf_s=" + u.tok, "accept-encoding": "gzip" }; if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; }
    const t = performance.now(); let s = 0;
    try { const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) }); s = r.status; await r.arrayBuffer(); } catch (e) { s = 0; }
    const ms = performance.now() - t; lat.push(ms); n++; if (s === 0 || s >= 500 || s === 429) errs++;
    const k = method + " " + url.replace(/\/\d+/g, "/:id").replace(/\?.*/, "").replace(/\/l\w+$/, "/:id"); (byKey[k] = byKey[k] || []).push(ms); if (s >= 400 && s < 500 && s !== 429) refused[k + " " + s] = (refused[k + " " + s] || 0) + 1;
    return s;
  };
  const students = users.filter((u) => u.role === "student"), coaches = users.filter((u) => u.role === "coach");
  let seq = 0;
  const studentVisit = async (u) => {
    const api = call(u), r = Math.random();
    await api("GET", "/me");
    await Promise.all(["/classes", "/gym", "/competitions", "/me/membership", "/me/notices", "/me/pay", "/progress", "/logs"].map((p) => api("GET", p)));
    if (r < 0.45) { const c = u.fut[seq++ % u.fut.length]; await api("PUT", `/classes/${c}/rsvp`, { going: Math.random() < 0.8 }); await api("GET", "/classes"); }
    else if (r < 0.6) await api("PUT", `/logs/l${seq++ % 1000}x`, { data: { date: new Date().toISOString().slice(0, 10), type: "Class", mins: 90, rolls: 5, taught: ["knee_cut"], worked: "x".repeat(300) } });
    else if (r < 0.7) await api("PUT", "/progress", { data: JSON.parse(planBlob) });
    else if (r < 0.9) await api("GET", "/me/attended");
  };
  const coachVisit = async (u) => {
    const api = call(u), r = Math.random();
    await api("GET", "/me");
    await Promise.all(["/coach/roster", "/coach/insights", "/coach/money", "/gym", `/classes?from=${new Date(Date.now() - 7 * DAY).toISOString()}&to=${new Date(Date.now() + 7 * DAY).toISOString()}`].map((p) => api("GET", p)));
    if (r < 0.4) { const c = u.fut[0]; const s = students.find((x) => x.gym === u.gym); await api("PUT", `/coach/classes/${c}/attendance`, { userId: s.id, attended: true }); }
    else if (r < 0.7) { const s = students.filter((x) => x.gym === u.gym)[seq++ % MEMBERS]; await api("POST", "/coach/payments", { userId: s.id, amountCents: 85000, paidOn: new Date().toISOString().slice(0, 10) }); await api("GET", "/coach/money"); }
    else await api("GET", "/coach/payments");
  };
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  // ---------- ramp ----------
  const results = []; let best = null;
  for (const rate of RATES) {
    lat = []; errs = 0; n = 0; byKey = {}; const inflight = new Set(); let backlog = false;
    const cpu0 = process.cpuUsage(), t0 = Date.now(), dur = STEP_S * 1000;
    await new Promise((done) => {
      let sent = 0; const tick = setInterval(() => {
        const due = Math.floor(((Date.now() - t0) / 1000) * rate) - sent;
        for (let i = 0; i < due; i++) { sent++; const p = (Math.random() < 0.1 ? coachVisit(pick(coaches)) : studentVisit(pick(students))).finally(() => inflight.delete(p)); inflight.add(p); }
        if (inflight.size > rate * 30) backlog = true;
        if (Date.now() - t0 >= dur) { clearInterval(tick); done(); }
      }, 20);
    });
    await Promise.race([Promise.all([...inflight]), wait(30000)]);
    const secs = (Date.now() - t0) / 1000, p50 = pct(lat, 50), p95 = pct(lat, 95), p99 = pct(lat, 99), errPct = (100 * errs) / Math.max(1, n);
    const row = { rate, reqPerS: Math.round(n / secs), p50: Math.round(p50), p95: Math.round(p95), p99: Math.round(p99), errPct: +errPct.toFixed(2), rssMB: Math.round(rssOf(srv.pid)) };
    results.push(row); console.log(`${rate} visits/s → ${row.reqPerS} req/s, p50 ${row.p50} ms, p95 ${row.p95} ms, p99 ${row.p99} ms, errors ${row.errPct}%, app memory ${row.rssMB} MB`);
    const good = p95 <= P95_LIMIT && errPct <= 1 && !backlog;
    if (good) best = { ...row, slow: Object.entries(byKey).map(([k, a]) => [k, Math.round(pct(a, 95))]).sort((a, b) => b[1] - a[1]).slice(0, 5) };
    if (!good) { console.log("  slowest at this rate: " + Object.entries(byKey).map(([k, a]) => `${k} ${Math.round(pct(a, 95))}ms`).sort((a, b) => parseInt(b.split(" ").pop()) - parseInt(a.split(" ").pop())).slice(0, 6).join("; ")); break; }
    await wait(5000);
  }

  // ---------- sign-ins (password checks are deliberately slow) and the public website ----------
  const pageTimes = []; { const t0 = Date.now(); await Promise.all(Array.from({ length: 50 }, async () => { while (Date.now() - t0 < 10000) { const t = performance.now(); await fetch(ORIGIN + "/", { headers: { "accept-encoding": "gzip" } }).then((r) => r.arrayBuffer()); pageTimes.push(performance.now() - t); } })); }
  clearInterval(rssTimer);
  console.log(`home page: ${Math.round(pageTimes.length / 10)}/s (p95 ${Math.round(pct(pageTimes, 95))} ms)`);
  console.log(`peak app memory ${Math.round(peakRss)} MB`);
  console.log("refused (4xx) by kind: " + JSON.stringify(refused));
  console.log("BEST " + JSON.stringify(best));
  srv.kill(); await pool.end(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
