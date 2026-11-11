// Stress test: lots of students booking, cancelling and checking in at the same moment, against a real server and PostgreSQL.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/stress.js   (wipes that database)
const { spawn } = require("child_process"); const path = require("path"); const crypto = require("crypto"); const { Pool } = require("pg");
const { startMailSink } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = [], timings = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
const DAY = 864e5, wait = (ms) => new Promise((r) => setTimeout(r, ms)), N = 120;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
async function timed(label, fn) { const t = Date.now(); const r = await fn(); timings.push(`${label}: ${Date.now() - t} ms`); return r; }

(async () => {
  const pool = new Pool({ connectionString: DB, max: 20 });
  await pool.query("drop table if exists autopay_charges, autopay, class_skips, plan_breaks, left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const sink = await startMailSink();
  const port = 9500 + Math.floor(Math.random() * 90), base = `http://127.0.0.1:${port}/api`;
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env: { ...process.env, PORT: String(port), DATABASE_URL: DB, RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch (e) { await wait(150); } }
  const call = (tok) => async (method, url, body) => {
    const h = { cookie: "jf_s=" + tok }; if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; }
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j };
  };
  try {
    // ---- setup straight in the database (signing up 120 people through the API would hit the sign-in rate limit)
    const tokC = crypto.randomBytes(32).toString("hex");
    const coachRes = await fetch(base + "/auth/start-gym", { method: "POST", headers: { "content-type": "application/json", "x-jf": "1" }, body: JSON.stringify({ gym: "Stress Gym", name: "Coach", email: "coach@stress.test", password: "coachpass1", timezone: "Africa/Johannesburg" }) });
    const coachCookie = coachRes.headers.get("set-cookie").match(/jf_s=([^;]*)/)[1];
    const coach = call(coachCookie);
    const gym = (await pool.query("select gym_id from users where email='coach@stress.test'")).rows[0].gym_id;
    const studs = [];
    const hash = (await pool.query("select pass_hash from users where email='coach@stress.test'")).rows[0].pass_hash;
    for (let i = 0; i < N; i++) {
      const id = (await pool.query("insert into users(gym_id,role,name,email,pass_hash,created_at) values($1,'student',$2,$3,$4,now()-interval '200 days') returning id", [gym, `Student ${i}`, `s${i}@stress.test`, hash])).rows[0].id;
      const tok = crypto.randomBytes(32).toString("hex");
      await pool.query("insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '1 day')", [sha(tok), id]);
      studs.push({ id: String(id), api: call(tok) });
    }
    void tokC;
    const at = (d, h, m = 0) => { const x = new Date(Date.now() + d * DAY); x.setUTCHours(h, m, 0, 0); return x.toISOString(); };
    const counts = async (cid) => (await pool.query("select count(*) filter (where going) g, count(*) filter (where waitlisted) w, count(*) filter (where going and waitlisted) both from attendance where class_id=$1", [cid])).rows[0];

    // ---- A. 120 people tap Book on a 20-spot class at the same moment
    let r = await coach("POST", "/classes", { title: "Big class", startsAt: at(3, 16), capacity: 20 }); const big = r.j.class.id;
    const res = await timed(`${N} simultaneous bookings`, () => Promise.all(studs.map((s) => s.api("PUT", `/classes/${big}/rsvp`, { going: true }))));
    ok(res.every((x) => x.s === 200), "every booking request answered OK: " + [...new Set(res.map((x) => x.s))].join(","));
    let c = await counts(big);
    ok(Number(c.g) === 20 && Number(c.w) === N - 20 && Number(c.both) === 0, `exactly 20 booked and ${N - 20} waiting (got ${c.g} booked, ${c.w} waiting)`);
    const pos = res.filter((x) => x.j.waitlisted).map((x) => x.j.position).sort((a, b) => a - b);
    ok(pos.length === N - 20 && pos.every((p, i) => p === i + 1), "waitlist places are 1, 2, 3… with no gaps or repeats");

    // ---- B. 40 of the booked and waiting cancel at once; spots go to the waitlist in order
    const booked = res.map((x, i) => ({ x, s: studs[i] })).filter((o) => o.x.j.going).map((o) => o.s);
    const order = (await pool.query("select user_id from attendance where class_id=$1 and waitlisted order by booked_at", [big])).rows.map((x) => String(x.user_id));
    const mails0 = sink.mails.length;
    await timed("30 simultaneous cancellations", () => Promise.all(booked.slice(0, 10).concat(studs.filter((s) => order.slice(50, 70).includes(s.id))).concat(booked.slice(10, 20)).map((s) => s.api("PUT", `/classes/${big}/rsvp`, { going: false }))));
    await wait(600);
    c = await counts(big);
    const nowBooked = (await pool.query("select user_id from attendance where class_id=$1 and going", [big])).rows.map((x) => String(x.user_id));
    ok(Number(c.g) === 20 && Number(c.both) === 0, `class refilled to exactly 20 after cancellations (got ${c.g})`);
    const expected = order.filter((id, i) => !(i >= 50 && i < 70)).slice(0, 20);
    ok(expected.every((id) => nowBooked.includes(id)), "the people who'd waited longest got the spots");
    ok(sink.mails.length - mails0 === 20, `each promoted person got one "you're in" email (${sink.mails.length - mails0})`);

    // ---- C. one student double/triple-taps Book
    r = await coach("POST", "/classes", { title: "Tap tap", startsAt: at(4, 16), capacity: 5 }); const tap = r.j.class.id;
    await Promise.all(Array.from({ length: 10 }, () => studs[0].api("PUT", `/classes/${tap}/rsvp`, { going: true })));
    c = await counts(tap); ok(Number(c.g) === 1 && Number(c.w) === 0, "ten taps from one person = one booking");

    // ---- D. weekly plan limit with bookings fired at once across different classes
    r = await coach("POST", "/coach/plans", { name: "2x", priceCents: 50000, period: "month", classesPerWeek: 2 }); const plan = r.j.plan.id;
    const ltd = studs[1]; await coach("PATCH", `/coach/students/${ltd.id}`, { planId: plan });
    const wkStart = (() => { const d = new Date(Date.now() + 14 * DAY); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d; })();
    const wkIds = [];
    for (let i = 0; i < 5; i++) { const d = new Date(wkStart.getTime() + i * DAY); d.setUTCHours(15, 0, 0, 0); wkIds.push((await coach("POST", "/classes", { title: "Week " + i, startsAt: d.toISOString() })).j.class.id); }
    const lim = await Promise.all(wkIds.map((id) => ltd.api("PUT", `/classes/${id}/rsvp`, { going: true })));
    ok(lim.filter((x) => x.j && x.j.going).length === 2 && lim.filter((x) => x.s === 403).length === 3, `a 2-a-week plan stays at 2 even when 5 bookings fire at once (got ${lim.filter((x) => x.j && x.j.going).length})`);

    // ---- E. limit uses the gym's local week: Sunday 23:00 and Monday 00:30 in Johannesburg are different weeks
    const ltd2 = studs[2]; await coach("PATCH", `/coach/students/${ltd2.id}`, { planId: (await coach("POST", "/coach/plans", { name: "1x", priceCents: 1, period: "month", classesPerWeek: 1 })).j.plan.id });
    const sun = new Date(wkStart.getTime() + 6 * DAY); sun.setUTCHours(21, 0, 0, 0); // 23:00 SAST Sunday
    const mon = new Date(wkStart.getTime() + 6 * DAY); mon.setUTCHours(22, 30, 0, 0); // 00:30 SAST Monday
    const a1 = (await coach("POST", "/classes", { title: "Sunday late", startsAt: sun.toISOString() })).j.class.id, a2 = (await coach("POST", "/classes", { title: "Monday early", startsAt: mon.toISOString() })).j.class.id;
    const e1 = await ltd2.api("PUT", `/classes/${a1}/rsvp`, { going: true }), e2 = await ltd2.api("PUT", `/classes/${a2}/rsvp`, { going: true });
    ok(e1.j.going && e2.j.going, "weekly limits follow the gym's time zone, not the server's");

    // ---- F. book/cancel spam from many people; counts stay consistent
    r = await coach("POST", "/classes", { title: "Flappy", startsAt: at(5, 16), capacity: 8 }); const flap = r.j.class.id;
    await Promise.all(studs.slice(10, 40).flatMap((s, i) => [s.api("PUT", `/classes/${flap}/rsvp`, { going: true }), s.api("PUT", `/classes/${flap}/rsvp`, { going: i % 2 === 0 }), s.api("PUT", `/classes/${flap}/rsvp`, { going: true })]));
    c = await counts(flap); const fl = (await coach("GET", `/coach/classes/${flap}`)).j;
    ok(Number(c.both) === 0 && Number(c.g) <= 8 && fl.attendees.filter((a) => a.going).length === Number(c.g) && fl.waitlist.length === Number(c.w), `after a booking/cancelling storm: never over 8, nobody both booked and waiting (booked ${c.g}, waiting ${c.w})`);
    ok(Number(c.g) === 8 || Number(c.w) === 0, "no free spot left while people are waiting");

    // ---- G. coach raises the spots: waiting people move in
    r = await coach("PUT", `/classes/${big}`, { capacity: 30 }); await wait(500);
    c = await counts(big); ok(Number(c.g) === 30, `raising the limit from 20 to 30 books 10 people off the waitlist (got ${c.g})`);
    r = await coach("PUT", `/classes/${big}`, { capacity: 10 });
    c = await counts(big); ok(Number(c.g) === 30, "lowering the limit doesn't kick anyone out");
    const cx = await studs.find((s) => nowBooked.includes(s.id)).api("PUT", `/classes/${big}/rsvp`, { going: false }); await wait(300);
    c = await counts(big); ok(Number(c.g) === 29, "while over the new limit, a cancellation doesn't pull someone off the waitlist");
    r = await coach("PUT", `/classes/${big}`, { capacity: null }); await wait(500);
    c = await counts(big); ok(Number(c.w) === 0, "removing the limit books everyone who was waiting");

    // ---- H. 30 people race for one private lesson
    r = await coach("POST", "/classes", { kind: "private", title: "Private", startsAt: at(6, 8), priceCents: 40000 }); const pv = r.j.class.id;
    const pr = await Promise.all(studs.slice(40, 70).map((s) => s.api("PUT", `/classes/${pv}/rsvp`, { going: true })));
    c = await counts(pv); ok(Number(c.g) === 1 && Number(c.w) === 0 && pr.filter((x) => x.s === 409).length === 29, "30 people tapping one private slot: exactly one gets it, the rest are told it's gone");

    // ---- I. walk-ins checking in at once can't overfill a class
    r = await coach("POST", "/classes", { title: "Now", startsAt: new Date(Date.now() + 10 * 60e3).toISOString(), capacity: 10 }); const now = r.j.class.id;
    await Promise.all(studs.slice(70, 75).map((s) => s.api("PUT", `/classes/${now}/rsvp`, { going: true })));
    await Promise.all(studs.slice(75, 115).map((s) => s.api("POST", `/classes/${now}/checkin`)));
    c = await counts(now); ok(Number(c.g) <= 10, `40 walk-ins checking in at once don't overfill a 10-spot class (booked ${c.g})`);
    const ci = await Promise.all(studs.slice(70, 75).map((s) => s.api("POST", `/classes/${now}/checkin`)));
    ok(ci.every((x) => x.s === 200), "people who booked can always check in");

    // ---- J. a student who switches gym loses their future bookings at the old gym
    const other = await fetch(base + "/auth/start-gym", { method: "POST", headers: { "content-type": "application/json", "x-jf": "1" }, body: JSON.stringify({ gym: "Other", name: "Other", email: "other@stress.test", password: "otherpass1" }) });
    const otherCode = (await other.json()).me.gym.studentCode;
    const mover = studs[100], moveCls = (await coach("POST", "/classes", { title: "Mover", startsAt: at(8, 16), capacity: 1 })).j.class.id;
    await mover.api("PUT", `/classes/${moveCls}/rsvp`, { going: true }); await studs[101].api("PUT", `/classes/${moveCls}/rsvp`, { going: true });
    await mover.api("POST", "/me/join", { code: otherCode }); await wait(300);
    ok(Number((await counts(moveCls)).g) === 1 && (await pool.query("select going from attendance where class_id=$1 and user_id=$2", [moveCls, studs[101].id])).rows[0].going, "their spot goes to the next person waiting");
    const left = (await pool.query("select count(*) from attendance a join classes c on c.id=a.class_id where a.user_id=$1 and c.gym_id=$2 and c.starts_at>now() and (a.going or a.waitlisted)", [mover.id, gym])).rows[0].count;
    ok(Number(left) === 0, "moving to another gym cancels future bookings at the old one (" + left + " left)");

    // ---- K. load: calendar and insights with a busy history
    const ins = [];
    for (let d = 1; d <= 180; d++) for (const h of [6, 12, 17, 18]) ins.push([new Date(Date.now() - d * DAY).setUTCHours(h, 0, 0, 0)]);
    const cids = [];
    for (const [t] of ins) cids.push((await pool.query("insert into classes(gym_id,title,starts_at,capacity) values($1,$2,$3,25) returning id", [gym, "Class " + new Date(t).getUTCHours(), new Date(t)])).rows[0].id);
    const vals = []; cids.forEach((cid, i) => { for (let k = 0; k < 12; k++) vals.push(`(${cid},${studs[(i * 7 + k * 11) % N].id},true,true)`); });
    for (let i = 0; i < vals.length; i += 2000) await pool.query("insert into attendance(class_id,user_id,going,attended) values " + vals.slice(i, i + 2000).join(",") + " on conflict do nothing");
    const g1 = await timed("coach calendar load (classes for 5 months)", () => coach("GET", `/classes?from=${new Date(Date.now() - 60 * DAY).toISOString()}&to=${new Date(Date.now() + 100 * DAY).toISOString()}`));
    ok(g1.s === 200 && g1.j.classes.length >= 240, "calendar loads a busy gym's classes");
    const g2 = await timed("student class list", () => studs[3].api("GET", "/classes"));
    ok(g2.s === 200, "student class list loads");
    const ins1 = await timed(`insights for ${N} students and ${cids.length} past classes`, () => coach("GET", "/coach/insights"));
    ok(ins1.s === 200 && ins1.j.kpis.active >= N - 2, "insights load for a busy gym");
    const ros = await timed("roster", () => coach("GET", "/coach/roster")); ok(ros.s === 200, "roster loads");
    const t1 = Date.now(); await Promise.all(studs.slice(0, 50).map((s) => s.api("GET", "/classes"))); timings.push(`50 students opening Classes at once: ${Date.now() - t1} ms`);
    const slow = timings.filter((t) => /: (\d+) ms/.exec(t) && Number(/: (\d+) ms/.exec(t)[1]) > 3000);
    ok(!slow.length, "nothing takes over 3 seconds: " + slow.join("; "));
  } catch (e) { fail++; fails.push("CRASH " + (e.stack || e)); }
  srv.kill(); sink.close(); await pool.end();
  console.log(`stress: ${pass} passed, ${fail} failed`); timings.forEach((t) => console.log("  time", t)); fails.forEach((f) => console.log("  FAIL", f));
  process.exit(fail ? 1 : 0);
})();
