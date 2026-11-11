// Automatic fee reminders and members who stopped coming, against a real PostgreSQL.
// Usage: DATABASE_URL=postgres://.../<something>test node tests/automation.js   (wipes that database)
const { spawn } = require("child_process"); const path = require("path"); const { Pool } = require("pg");
const { startMailSink } = require("./fixture-gym");
const DB = process.env.DATABASE_URL; if (!DB || !/test/.test(DB)) { console.error("Set DATABASE_URL to a *test* database."); process.exit(2); }
let pass = 0, fail = 0; const fails = []; const ok = (c, m) => { if (c) pass++; else { fail++; fails.push(m); } };
function client(base) {
  let cookie = "";
  return async (method, url, body) => {
    const h = {}; if (cookie) h.cookie = cookie; if (method !== "GET") { h["content-type"] = "application/json"; h["x-jf"] = "1"; }
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = sc.match(/jf_s=([^;]*)/); if (m) cookie = m[1] ? "jf_s=" + m[1] : ""; }
    let j = null; try { j = await r.json(); } catch (e) {}
    return { s: r.status, j };
  };
}
const DAY = 864e5, wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const pool = new Pool({ connectionString: DB });
  await pool.query("drop table if exists autopay_charges, autopay, class_skips, plan_breaks, notices, left_owing, packs, pop_files, competitors, competitions, plans, password_resets, payments, attendance, classes, training_logs, progress, sessions, users, gyms cascade");
  const sink = await startMailSink();
  const port = 9400 + Math.floor(Math.random() * 90), base = `http://127.0.0.1:${port}/api`;
  const env = { ...process.env, PORT: String(port), DATABASE_URL: DB, RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, APP_URL: "https://www.jitsflow.test" };
  const srv = spawn("node", [path.resolve(__dirname, "../server.js")], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch (e) { await wait(150); } }
  // The scheduled jobs, run here the way server.js runs them (two "servers" at once, to show they never double up).
  Object.assign(process.env, { RESEND_API_KEY: "test-key", RESEND_API_URL: sink.url, APP_URL: "https://www.jitsflow.test" });
  const { makeApi } = require("../backend/api"), pool2 = new Pool({ connectionString: DB });
  const jobsA = makeApi(pool, {}).jobs, jobsB = makeApi(pool2, {}).jobs;
  const settle = () => wait(400); // emails from tellMissed go out in the background
  const to = (addr, from = 0) => sink.mails.slice(from).filter((m) => m.to[0] === addr);
  try {
    const coach = client(base), coach2 = client(base), other = client(base);
    let r = await coach("POST", "/auth/start-gym", { gym: "JPB Martial Arts Academy", name: "Coach JP", email: "coach@example.com", password: "coachpass1", timezone: "Africa/Johannesburg" });
    const code = r.j.me.gym.studentCode, ccode = r.j.me.gym.coachCode, gym = Number(r.j.me.gym.id);
    await coach2("POST", "/auth/register", { code: ccode, name: "Coach Anna", email: "anna@example.com", password: "annapass12" });
    const today = (await coach("GET", "/coach/roster")).j.today, dd = +today.slice(8, 10);
    const weekAgo = +new Date(Date.parse(today + "T12:00:00Z") - 7 * DAY).toISOString().slice(8, 10);
    r = await coach("POST", "/coach/plans", { name: "Adults", priceCents: 85000, period: "month" }); const plan = r.j.plan.id;
    const S = {};
    const join = async (key, name, email) => { const c = client(base); const x = await c("POST", "/auth/register", { code, name, email, password: "studentpass1" }); c.id = x.j.me.id; c.email = email; S[key] = c;
      await coach("PATCH", `/coach/students/${c.id}`, { planId: plan }); return c; };
    for (const [k, n] of [["olivia", "Olivia Owing"], ["sally", "Sally Second"], ["pete", "Pete Paid"], ["tom", "Tom Trial"], ["pam", "Pam Paused"], ["pat", "Pat Proof"], ["rita", "Rita Reminded"], ["ed", "Ed Early"], ["zach", "Zach Zero"]])
      await join(k, n, `${k}@example.com`);
    await coach("PATCH", `/coach/students/${S.zach.id}`, { planId: null });
    r = await coach("POST", "/coach/students", { name: "Fiona Offline", phone: "082 555 0101" }); const fiona = r.j.id;
    await coach("PATCH", `/coach/students/${fiona}`, { planId: plan });
    await coach("POST", "/coach/payments", { userId: S.pete.id, amountCents: 85000, paidOn: today, method: "cash" });
    await coach("POST", "/coach/payments", { userId: S.ed.id, amountCents: 10000, paidOn: today, method: "cash" });
    await coach("PATCH", `/coach/students/${S.tom.id}`, { planStatus: "trial" });
    await coach("PATCH", `/coach/students/${S.pam.id}`, { planStatus: "paused" });
    await pool.query("insert into payments(gym_id,user_id,amount_cents,paid_on,status,source) values($1,$2,85000,$3,'pending','upload')", [gym, S.pat.id, today]);
    await pool.query("update users set reminded_at=now() - interval '3 days' where id=$1", [S.rita.id]);
    const due = dd <= 28 ? dd : weekAgo;
    // The Setup form always sends every field.
    const setDue = (d) => coach("PATCH", "/coach/gym/pay", { holder: "JPB", bank: "FNB", account: "62000000000", branch: "250655", dueDay: d });
    await setDue(due);

    // ---- never asked yet: nothing goes by itself
    r = await coach("GET", "/coach/money"); ok(r.j.autoRemind === null, "automatic reminders start unasked (null)");
    let m0 = sink.mails.length;
    ok((await jobsA.autoRemind({ hour: 9 })) === 0 && sink.mails.length === m0, "until the head coach says yes, the daily job sends nothing");

    // ---- the first manual send carries the answer to "Send these automatically?"
    r = await coach2("PUT", "/coach/money/auto", { on: true }); ok(r.s === 403, "only the head coach can switch automatic reminders on");
    r = await S.olivia("PUT", "/coach/money/auto", { on: true }); ok(r.s === 403, "students can't either");
    r = await coach2("POST", "/coach/money/remind", { userIds: [S.olivia.id], auto: true }); ok(r.s === 403, "nor answer the question by sending reminders");
    r = await coach("POST", "/coach/money/remind", { userIds: [S.olivia.id], auto: true }); await settle();
    ok(r.s === 200 && r.j.sent === 1 && r.j.autoRemind === true, "\"Yes, automatically\": these go now and the gym is switched on: " + JSON.stringify(r.j));
    r = await coach("GET", "/coach/money"); ok(r.j.autoRemind === true, "Money says automatic reminders are on");
    r = await coach("GET", "/coach/gym/pay"); ok(r.j.autoRemind === true, "and so does Money › Setup");

    // ---- the daily job: on the due day (or 7 days after), from 8am
    m0 = sink.mails.length;
    ok((await jobsA.autoRemind({ hour: 6 })) === 0 && sink.mails.length === m0, "before 8am nothing goes");
    await setDue([1, 2, 3, 4, 5].find((d) => d !== dd && d !== weekAgo));
    ok((await jobsA.autoRemind({ hour: 9 })) === 0 && sink.mails.length === m0, "on a day that's neither the due day nor 7 days after it, nothing goes");
    await setDue(due);
    const [a1, b1] = await Promise.all([jobsA.autoRemind({ hour: 9 }), jobsB.autoRemind({ hour: 9 })]); await settle();
    const got = sink.mails.slice(m0).map((m) => m.to[0]).filter((a) => a !== "coach@example.com");
    ok(a1 + b1 === 1 && got.length === 1 && got[0] === "sally@example.com", "on the due day only Sally gets one (two servers at once, still one email): " + JSON.stringify(got));
    const sm = to("sally@example.com", m0)[0];
    ok(sm && /R\s?850/.test(sm.text) && /62000000000/.test(sm.text) && /JF[A-Z0-9]+/.test(sm.text) && sm.reply_to === "coach@example.com", "the email has the amount, the bank details and her reference, and replies go to the head coach");
    ok(!got.includes("olivia@example.com"), "not Olivia, reminded by hand a moment ago");
    ok(!["pete", "tom", "pam", "pat", "rita", "ed", "zach"].some((k) => got.includes(`${k}@example.com`)), "not paid, trial, paused, proof being checked, reminded 3 days ago, paid this week, or owing R0");
    m0 = sink.mails.length;
    ok((await jobsA.autoRemind({ hour: 15 })) + (await jobsB.autoRemind({ hour: 20 })) === 0 && sink.mails.length === m0, "running again later that day sends nothing more");
    r = await coach("GET", "/coach/roster"); ok(r.j.reminders && r.j.reminders.sent === 1 && r.j.reminders.noEmail.includes("Fiona Offline"), "Home hears: reminders sent to 1 today, and who has no email: " + JSON.stringify(r.j.reminders));
    r = await coach2("GET", "/coach/roster"); ok(r.j.reminders === undefined && r.j.idle === undefined, "other coaches don't see money lines on Home");

    // ---- 7 days later: still owing, so another one (but never two within 6 days)
    if (weekAgo <= 28 && weekAgo !== dd && dd >= 9) {
      await setDue(weekAgo);
      await pool.query("update gyms set remind_log=null where id=$1", [gym]);
      m0 = sink.mails.length; await jobsA.autoRemind({ hour: 9 });
      ok(sink.mails.length === m0, "a week on, people reminded in the last 6 days aren't reminded again");
      await pool.query("update gyms set remind_log=null where id=$1", [gym]);
      await pool.query("update users set reminded_at=now() - interval '7 days' where gym_id=$1 and reminded_at is not null", [gym]);
      await pool.query("update payments set created_at=now() - interval '8 days', paid_on=$2::date - 8 where gym_id=$1 and status='confirmed'", [gym, today]);
      m0 = sink.mails.length; await jobsA.autoRemind({ hour: 9 }); await settle();
      const g2 = sink.mails.slice(m0).map((m) => m.to[0]).filter((a) => a !== "coach@example.com").sort();
      ok(JSON.stringify(g2) === JSON.stringify(["ed@example.com", "olivia@example.com", "rita@example.com", "sally@example.com"]), "7 days after the due day, everyone still owing gets one (Ed's part payment was over a week ago): " + JSON.stringify(g2));
      ok(!g2.includes("pete@example.com"), "Pete paid in full, so still nothing");
      await setDue(due);
    }

    // ---- due day 25: the run 7 days later falls in the next month, and asks only for what fell due on the 25th
    { const M = today.slice(0, 7), N = new Date(Date.UTC(+M.slice(0, 4), +M.slice(5, 7), 1)).toISOString().slice(0, 7);
      const label = (m) => new Date(m + "-01T12:00:00Z").toLocaleDateString("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" });
      await setDue(25);
      await pool.query("update gyms set remind_log=null where id=$1", [gym]); await pool.query("update users set reminded_at=null where gym_id=$1", [gym]);
      await pool.query("update payments set created_at=now() - interval '20 days', paid_on=$2::date - 10 where gym_id=$1 and status='confirmed'", [gym, today]);
      m0 = sink.mails.length; ok((await jobsA.autoRemind({ hour: 9, day: N + "-01" })) === 0 && sink.mails.length === m0, "due day 25: nothing on the 1st of next month");
      await jobsA.autoRemind({ hour: 9, day: N + "-02" }); await settle();
      const g3 = sink.mails.slice(m0).filter((m) => m.to[0] !== "coach@example.com");
      ok(JSON.stringify(g3.map((m) => m.to[0]).sort()) === JSON.stringify(["ed@example.com", "olivia@example.com", "rita@example.com", "sally@example.com"]), "on the 2nd of next month (the 25th + 7) the people who owe for this month get one, and Pete, who paid it, doesn't: " + JSON.stringify(g3.map((m) => m.to[0])));
      ok(g3.length && g3.every((m) => m.subject.endsWith("fees for " + label(M)) && !m.text.includes(label(N).split(" ")[0])), "each asks only for this month, never next month (not due until the 25th): " + JSON.stringify(g3.map((m) => m.subject)));
      const sl = g3.find((m) => m.to[0] === "sally@example.com"); ok(sl && /R\s?850(,00)? is due/.test(sl.text) && !/1[\s\u00a0]?700/.test(sl.text), "Sally is asked for R 850, not R 1 700");
      await setDue(due); }

    // ---- a send that fails (the mail service's rate limit) isn't counted: a run half an hour later tries again, and Home says so
    { await pool.query("update gyms set remind_log=null where id=$1", [gym]); await pool.query("update users set reminded_at=null where gym_id=$1", [gym]);
      sink.fail.add("rita@example.com");
      m0 = sink.mails.length; const t0 = Date.now(), n1 = await jobsA.autoRemind({ hour: 9 }), took = Date.now() - t0, g4 = sink.mails.slice(m0).map((m) => m.to[0]).sort();
      ok(n1 === 3 && JSON.stringify(g4) === JSON.stringify(["ed@example.com", "olivia@example.com", "sally@example.com"]), "Rita's email fails; the others go: " + JSON.stringify([n1, g4]));
      ok(took >= 1400, "they go one at a time, half a second apart, not all at once: " + took + "ms");
      ok((await pool.query("select reminded_at from users where id=$1", [S.rita.id])).rows[0].reminded_at === null, "a failed email doesn't count as a reminder");
      r = await coach("GET", "/coach/roster");
      ok(r.j.reminders.sent === 3 && JSON.stringify(r.j.reminders.failed) === JSON.stringify(["Rita Reminded"]) && JSON.stringify(r.j.reminders.to.slice().sort()) === JSON.stringify(["Ed Early", "Olivia Owing", "Sally Second"]), "Home: who was emailed, and who couldn't be: " + JSON.stringify(r.j.reminders));
      sink.fail.clear();
      ok((await jobsA.autoRemind({ hour: 10 })) === 0, "it isn't tried again straight away");
      await pool.query("update gyms set remind_log=remind_log || jsonb_build_object('at', now() - interval '31 minutes') where id=$1", [gym]);
      m0 = sink.mails.length; const [x1, x2] = await Promise.all([jobsA.autoRemind({ hour: 10 }), jobsB.autoRemind({ hour: 10 })]);
      ok(x1 + x2 === 1 && JSON.stringify(sink.mails.slice(m0).map((m) => m.to[0])) === JSON.stringify(["rita@example.com"]), "half an hour on, Rita is tried again (once, on one server), and nobody else gets a second one");
      r = await coach("GET", "/coach/roster"); ok(r.j.reminders.sent === 4 && !r.j.reminders.failed.length && r.j.reminders.to.includes("Rita Reminded"), "Home: sent to 4, none failed");
      await pool.query("update gyms set remind_log=remind_log || jsonb_build_object('at', now() - interval '31 minutes') where id=$1", [gym]);
      ok((await jobsA.autoRemind({ hour: 11 })) === 0, "with nobody left to try, that's it for the day");
      // Money shows who was reminded, and emailing them again by hand the same day sends nothing.
      r = await coach("GET", "/coach/money"); const mr = r.j.students.find((s) => s.id === S.rita.id);
      ok(mr.remindedRecently === true && !!mr.remindedAt && r.j.students.find((s) => s.id === S.pete.id).remindedRecently === false, "Money says who was reminded this week");
      m0 = sink.mails.length; r = await coach("POST", "/coach/money/remind", { userIds: [S.rita.id, S.sally.id] }); await settle();
      ok(r.j.sent === 0 && JSON.stringify(r.j.recent.sort()) === JSON.stringify(["Rita Reminded", "Sally Second"]) && sink.mails.length === m0, "Email reminders by hand leaves out anyone reminded this week: " + JSON.stringify(r.j));
      const [h1, h2] = await Promise.all([coach("POST", "/coach/money/remind", { userIds: [S.ed.id] }), coach("POST", "/coach/money/remind", { userIds: [S.ed.id] })]);
      ok(h1.j.sent + h2.j.sent === 0, "Ed too");
      await pool.query("update users set reminded_at=null where id=$1", [S.ed.id]); m0 = sink.mails.length;
      const [k1, k2] = await Promise.all([coach("POST", "/coach/money/remind", { userIds: [S.ed.id] }), coach("POST", "/coach/money/remind", { userIds: [S.ed.id] })]); await settle();
      ok(k1.j.sent + k2.j.sent === 1 && to("ed@example.com", m0).length === 1, "and a double tap on Email reminders sends one"); }

    // ---- the off switch
    r = await coach("PUT", "/coach/money/auto", { on: false }); ok(r.s === 200 && r.j.autoRemind === false, "Money › Setup switches them off");
    await pool.query("update gyms set remind_log=null where id=$1", [gym]); await pool.query("update users set reminded_at=null where gym_id=$1", [gym]);
    m0 = sink.mails.length; ok((await jobsA.autoRemind({ hour: 9 })) === 0 && sink.mails.length === m0, "switched off: nothing goes on the due day");
    r = await coach("POST", "/coach/money/remind", { userIds: [S.sally.id] }); ok(r.j.sent === 1 && r.j.autoRemind === false, "sending by hand still works, and leaves it off");
    r = await coach("POST", "/coach/money/remind", { userIds: [S.olivia.id], auto: false }); ok(r.j.autoRemind === false, "\"Just this once\" keeps it off (and isn't asked again)");
    await coach("PUT", "/coach/money/auto", { on: true });

    // ---- members who stopped coming
    // Three regulars came this month; four people on the plan joined over 60 days ago and haven't been since.
    const DAY_MS = DAY, past = new Date(Date.now() - 5 * DAY_MS).toISOString(), soon = new Date(Date.now() + 2 * DAY_MS).toISOString();
    r = await coach("POST", "/classes", { title: "Fundamentals", startsAt: past, durationMin: 60 }); const pastCls = r.j.class.id;
    r = await coach("POST", "/classes", { title: "No-gi", startsAt: soon, durationMin: 60 }); const soonCls = r.j.class.id;
    for (const k of ["pete", "ed", "rita"]) await coach("PUT", `/coach/classes/${pastCls}/attendance`, { userId: S[k].id, attended: true });
    await pool.query("update users set created_at=now() - interval '90 days' where gym_id=$1 and role='student' and id = any($2)", [gym, [S.olivia.id, S.sally.id, S.pat.id, fiona, S.tom.id, S.pam.id].map(Number)]);
    // Pat is booked into a class still to come: that counts as coming.
    await S.pat("PUT", `/classes/${soonCls}/rsvp`, { going: true });
    r = await coach("GET", "/coach/roster");
    let idle = (r.j.idle || []).map((x) => x.name).sort();
    ok(JSON.stringify(idle) === JSON.stringify(["Fiona Offline", "Olivia Owing", "Sally Second"]), "Home lists the 3 on a paying plan who haven't trained or booked in 60 days: " + JSON.stringify(idle));
    ok(!idle.includes("Tom Trial") && !idle.includes("Pam Paused") && !idle.includes("Zach Zero"), "not trial members, people already paused, or people with no fee");
    ok(!idle.includes("Pat Proof"), "not someone with a booking still to come");
    ok(!idle.some((n) => ["Pete Paid", "Ed Early", "Rita Reminded"].includes(n)), "not people who came recently (or joined recently)");
    // Nothing to go on yet (a gym that doesn't take the register): no card.
    await pool.query("update attendance set attended=false, going=false where class_id=$1", [pastCls]);
    r = await coach("GET", "/coach/roster"); ok(Array.isArray(r.j.idle) && r.j.idle.length === 0, "a gym where hardly anyone books or checks in gets no card (it would just be everyone)");
    await pool.query("update attendance set attended=true, going=true where class_id=$1", [pastCls]);

    // [Keep]: off the card for 30 days
    r = await coach2("POST", "/coach/idle", { action: "keep", userIds: [fiona] }); ok(r.s === 403, "only the head coach can act on the card");
    r = await coach("POST", "/coach/idle", { action: "keep", userIds: [fiona] }); ok(r.s === 200 && r.j.kept === 1, "Keep");
    r = await coach("GET", "/coach/roster"); idle = r.j.idle.map((x) => x.name).sort();
    ok(JSON.stringify(idle) === JSON.stringify(["Olivia Owing", "Sally Second"]), "Keep hides them from the card");
    const kept = (await pool.query("select idle_kept_until - $2::date as d, plan_status from users where id=$1", [fiona, today])).rows[0];
    ok(kept.d === 30 && kept.plan_status === "active", "for 30 days, and their fees carry on");

    // [Pause their fees]
    await pool.query("update gyms set remind_log=null where id=$1", [gym]); await pool.query("update users set reminded_at=null where gym_id=$1", [gym]);
    r = await coach("POST", "/coach/idle", { action: "pause", userIds: [S.olivia.id, S.sally.id] }); ok(r.s === 200 && r.j.paused === 2, "one tap pauses them all");
    r = await coach("GET", "/coach/roster");
    const ol = r.j.people.find((p) => p.id === S.olivia.id);
    ok(ol.planStatus === "paused" && ol.pause && ol.pause.until === null && r.j.idle.length === 0, "paused until they're back, and the card is gone");
    r = await S.olivia("GET", "/me/membership"); ok(r.j.membership.status === "paused" && r.j.membership.pause.idle === true, "her app knows it's a pause for being away (so it says: book a class and you're back)");
    r = await coach("GET", "/coach/money"); const mo = r.j.students.find((s) => s.id === S.olivia.id);
    ok(mo.feeCents === 0, "this month's fee is off, so they're out of Expected");
    m0 = sink.mails.length; await jobsA.autoRemind({ hour: 9 }); await settle();
    ok(!to("olivia@example.com", m0).length && !to("sally@example.com", m0).length, "and out of the automatic reminders");
    // "We miss you" waits a few minutes, so Undo can stop it.
    m0 = sink.mails.length;
    ok((await jobsA.tellMissed()) === 0 && sink.mails.length === m0, "nobody is told straight away");
    await pool.query("update plan_breaks set created_at=now() - interval '11 minutes' where reason='idle'");
    const [t1, t2] = await Promise.all([jobsA.tellMissed(), jobsB.tellMissed()]); await settle();
    const miss = sink.mails.slice(m0).filter((m) => /We miss you/.test(m.subject));
    ok(t1 + t2 === 2 && miss.length === 2 && miss.some((m) => m.to[0] === "olivia@example.com"), "a few minutes later each gets one friendly \"we miss you\" (two servers, still one each)");
    ok(miss[0] && /book a class/i.test(miss[0].text) && !/R\s?\d/.test(miss[0].text), "it says how to come back, and isn't about money");
    r = await S.olivia("GET", "/me/notices"); ok(r.j.notices.some((n) => n.kind === "missyou"), "and a note in the app");
    ok((await jobsA.tellMissed()) === 0, "only once");

    // Booking again brings them back, and the head coach hears.
    r = await S.pam("PUT", `/classes/${soonCls}/rsvp`, { going: true }); ok(r.s === 403, "someone the coach paused by hand still can't book");
    m0 = sink.mails.length;
    r = await S.olivia("PUT", `/classes/${soonCls}/rsvp`, { going: true }); await settle();
    ok(r.s === 200 && r.j.going, "someone paused for not coming can book");
    r = await coach("GET", "/coach/roster"); const ol2 = r.j.people.find((p) => p.id === S.olivia.id);
    ok(ol2.planStatus === "active" && !ol2.pause, "booking resumes them");
    r = await coach("GET", "/me/notices"); ok(r.j.notices.some((n) => n.kind === "resumed" && /Olivia Owing booked a class/.test(n.body)), "the head coach gets a note");
    ok(to("coach@example.com", m0).some((m) => /training again/i.test(m.subject)), "and an email");
    // Checked in by a coach: the same.
    await pool.query("update plan_breaks set created_at=now() - interval '20 days' where reason='idle'");
    await coach("PUT", `/coach/classes/${pastCls}/attendance`, { userId: S.sally.id, attended: true });
    r = await coach("GET", "/coach/roster"); ok(r.j.people.find((p) => p.id === S.sally.id).planStatus === "active", "a coach checking them in resumes them too");
    ok((await pool.query("select count(*)::int as n from plan_breaks where user_id=$1 and ended_at is not null", [S.sally.id])).rows[0].n === 1, "their paused month stays free (the pause is ended, not deleted)");

    // Checking themselves in: the same.
    await coach("POST", "/coach/idle", { action: "pause", userIds: [S.olivia.id] });
    await pool.query("update plan_breaks set created_at=now() - interval '20 days' where reason='idle' and ended_at is null");
    r = await coach("POST", "/classes", { title: "Open mat", startsAt: new Date(Date.now() + 10 * 6e4).toISOString(), durationMin: 60 });
    r = await S.olivia("POST", `/classes/${r.j.class.id}/checkin`); ok(r.s === 200, "someone paused for not coming can check in");
    ok((await pool.query("select plan_status from users where id=$1", [S.olivia.id])).rows[0].plan_status === "active", "and checking in resumes them");
    // Undo straight after: back as they were, and nobody hears.
    await pool.query("update users set created_at=now() - interval '90 days', idle_kept_until=null where id=$1", [fiona]);
    await pool.query("update attendance set going=false, attended=false where user_id = any($1)", [[S.olivia.id, S.sally.id].map(Number)]);
    r = await coach("POST", "/coach/idle", { action: "pause", userIds: [fiona] }); ok(r.j.paused === 1, "pause Fiona");
    r = await coach("POST", "/coach/idle", { action: "undo", userIds: [fiona] }); ok(r.s === 200 && r.j.resumed === 1, "Undo");
    const fz = (await pool.query("select plan_status, (select count(*)::int from plan_breaks where user_id=$1) as n from users where id=$1", [fiona])).rows[0];
    ok(fz.plan_status === "active" && fz.n === 0, "she's active again with no pause left behind");
    await pool.query("update plan_breaks set created_at=now() - interval '1 hour' where reason='idle'");
    ok((await jobsA.tellMissed()) === 0, "and gets no \"we miss you\"");
    // Someone just back from a pause (or a trial, or a cancelled plan) counts as new: Olivia and Sally aren't on the card again.
    r = await coach("GET", "/coach/roster"); idle = r.j.idle.map((x) => x.name).sort();
    ok(JSON.stringify(idle) === JSON.stringify(["Fiona Offline"]), "people back from a pause in the last 60 days aren't asked about: " + JSON.stringify(idle));
    const M = today.slice(0, 7), mBack = (n) => new Date(Date.UTC(+M.slice(0, 4), +M.slice(5, 7) - 1 - n, 1)).toISOString().slice(0, 10);
    await pool.query("update plan_breaks set from_month=$2, until_month=$3, ended_at=now() - interval '61 days' where user_id = any($1)", [[S.olivia.id, S.sally.id].map(Number), mBack(5), mBack(4)]);
    r = await coach("GET", "/coach/roster"); idle = r.j.idle.map((x) => x.name).sort();
    ok(JSON.stringify(idle) === JSON.stringify(["Fiona Offline", "Olivia Owing", "Sally Second"]), "after 60 days back without training, they are: " + JSON.stringify(idle));
    // A pause the coach set by hand runs out (tick): the day after, Pam isn't on the card.
    { const { tick } = require("../backend/db");
      await pool.query("update users set created_at=now() - interval '90 days' where id=$1", [S.pam.id]);
      await pool.query("update plan_breaks set from_month=$2, until_month=$3 where user_id=$1 and ended_at is null", [S.pam.id, mBack(2), mBack(1)]); await tick(pool);
      r = await coach("GET", "/coach/roster"); const pm = r.j.people.find((p) => p.id === S.pam.id);
      ok(pm.planStatus === "active" && !r.j.idle.some((x) => x.name === "Pam Paused"), "someone whose pause just ended isn't asked about straight away: " + JSON.stringify(r.j.idle)); }
    // A double tap on Pause their fees: each is paused once and hears once.
    { const [d1, d2] = await Promise.all([coach("POST", "/coach/idle", { action: "pause", userIds: [fiona, S.sally.id] }), coach("POST", "/coach/idle", { action: "pause", userIds: [fiona, S.sally.id] })]);
      ok(d1.j.paused + d2.j.paused === 2, "a double tap pauses them once: " + JSON.stringify([d1.j, d2.j]));
      ok((await pool.query("select count(*)::int as n from plan_breaks where user_id = any($1) and reason='idle' and ended_at is null", [[fiona, S.sally.id].map(Number)])).rows[0].n === 2, "one pause each");
      const ne = [...d1.j.noEmail, ...d2.j.noEmail];
      ok(ne.length === 1 && ne[0].name === "Fiona Offline" && /082/.test(ne[0].phone), "the coach hears who has no email (to send it on WhatsApp), with their number: " + JSON.stringify(ne));
      await pool.query("update plan_breaks set created_at=now() - interval '11 minutes' where reason='idle' and told_at is null and ended_at is null");
      const notes = async () => (await pool.query("select count(*)::int as n from notices where user_id=$1 and kind='missyou'", [S.sally.id])).rows[0].n, n0 = await notes();
      m0 = sink.mails.length; await Promise.all([jobsA.tellMissed(), jobsB.tellMissed()]); await settle();
      ok(to("sally@example.com", m0).filter((m) => /We miss you/.test(m.subject)).length === 1, "Sally gets one \"we miss you\", not two");
      ok((await notes()) === n0 + 1, "and one note in the app"); }
    // Answering it straight away: the paused month stays free, the same as coming back weeks later.
    { await pool.query("update gyms set pay = pay || '{\"dueDay\": 1}'::jsonb where id=$1", [gym]);
      r = await coach("GET", "/coach/money"); ok(r.j.students.find((s) => s.id === S.sally.id).feeCents === 0, "paused: this month is free");
      m0 = sink.mails.length; r = await S.sally("PUT", `/classes/${soonCls}/rsvp`, { going: true }); await settle();
      r = await coach("GET", "/coach/money"); const sy = r.j.students.find((s) => s.id === S.sally.id);
      ok(sy.planStatus === "active" && sy.feeCents === 0, "Sally books two days later: she's active again, and the month she was told was on hold stays free: " + JSON.stringify([sy.planStatus, sy.feeCents, sy.owedMonths]));
      const N1 = new Date(Date.UTC(+M.slice(0, 4), +M.slice(5, 7), 1)).toISOString().slice(0, 7);
      ok((await coach("GET", "/coach/money?month=" + N1)).j.students.find((s) => s.id === S.sally.id).feeCents === 85000, "and next month is billed as usual");
      ok((await pool.query("select count(*)::int as n from plan_breaks where user_id=$1 and reason='idle' and ended_at is not null and created_at > now() - interval '1 hour'", [S.sally.id])).rows[0].n === 1, "the pause is ended, not deleted");
      r = await coach("GET", "/me/notices"); const nb = r.j.notices.find((n) => n.kind === "resumed" && /Sally Second booked a class/.test(n.body));
      ok(nb && /stay free/.test(nb.body) && /start again from 1 /.test(nb.body), "the head coach's note says the months away stay free and when fees start again: " + (nb && nb.body));
      // Undo straight after the pause still takes it away completely.
      r = await coach("POST", "/coach/idle", { action: "undo", userIds: [fiona] }); ok(r.j.resumed === 1, "Undo for Fiona");
      ok((await pool.query("select count(*)::int as n from plan_breaks where user_id=$1 and created_at > now() - interval '1 hour'", [fiona])).rows[0].n === 0, "Undo deletes the pause (nothing was freed)"); }
    r = await coach("POST", "/coach/idle", { action: "nap", userIds: [fiona] }); ok(r.s === 400, "unknown actions are refused");
    r = await other("POST", "/auth/start-gym", { gym: "Other", name: "Other", email: "other@example.com", password: "otherpass1" });
    r = await other("POST", "/coach/idle", { action: "pause", userIds: [S.ed.id] }); ok(r.s === 200 && r.j.paused === 0, "another gym's head coach can't pause your members");
    ok((await pool.query("select plan_status from users where id=$1", [S.ed.id])).rows[0].plan_status === "active", "Ed is untouched");
  } catch (e) { fail++; fails.push("crashed: " + (e.stack || e.message)); }
  finally { srv.kill(); await pool.end(); await pool2.end(); sink.close(); }
  console.log(`automation: ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log("  FAIL", f);
  process.exit(fail ? 1 : 0);
})();
