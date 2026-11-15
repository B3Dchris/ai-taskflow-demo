// A demo head-coach account and a fictional gym ("Mayhem Jiu-Jitsu") with a few plans, members and two weeks of classes,
// for a payment provider's site review (Payfast checks the logged-in product before switching on live payments).
// Safe to run again: it finds the same account and gym, adds only what's missing, and sets a new password (or the one given).
// Nothing is charged, no email is sent, and no card is added.
//
// Usage: DATABASE_URL=postgres://... [DATABASE_SSL=true] node tools/reviewer-account.js [--email you@example.com] [--password ...]
//   REVIEWER_EMAIL / REVIEWER_PASSWORD work too. Without a password, a random one is made and printed.
//   Against production, add --production (so it's never run there by accident). The server must have run once (the tables exist).
"use strict";
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { makePool, popToken } = require("../backend/db");

const arg = (k) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : undefined; };
const EMAIL = String(arg("email") || process.env.REVIEWER_EMAIL || "reviewer@jitsflow.com").trim().toLowerCase();
const PASSWORD = String(arg("password") || process.env.REVIEWER_PASSWORD || "") || crypto.randomBytes(12).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 14) + "7a";
const GYM = "Mayhem Jiu-Jitsu", COACH = "Demo Head Coach", TZ = "Africa/Johannesburg";
const code = () => Array.from(crypto.randomBytes(8), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
const PLANS = [{ name: "Unlimited", price: 85000, cpw: null }, { name: "2x a week", price: 65000, cpw: 2 }, { name: "Kids", price: 50000, cpw: 2 }];
// Fictional members, added by the coach (not on the app): no email or phone, so nobody is ever contacted.
const MEMBERS = [["Thabo Nkosi", "blue", 2, "Unlimited"], ["Lerato Dlamini", "white", 3, "2x a week"], ["Pieter van Wyk", "purple", 1, "Unlimited"],
  ["Ayesha Patel", "white", 1, "2x a week"], ["Sipho Mahlangu", "brown", 0, "Unlimited"], ["Megan O'Neill", "blue", 0, "2x a week"]];
// The weekly timetable (local time): weekday (0 Sunday), hour, minutes, title, length.
const WEEK = [[1, 18, 0, "No-gi fundamentals", 60], [2, 6, 0, "No-gi advanced", 60], [3, 18, 0, "No-gi fundamentals", 60], [4, 6, 0, "No-gi advanced", 60],
  [5, 18, 0, "No-gi fundamentals", 60], [6, 10, 0, "Open mat", 90]];

(async () => {
  const url = process.env.DATABASE_URL || "";
  if (!url) { console.error("Set DATABASE_URL to the database to add the reviewer account to."); process.exit(2); }
  if (!/test|localhost|127\.0\.0\.1/.test(url) && !process.argv.includes("--production")) {
    console.error("This looks like a production database. Run again with --production if that's what you mean."); process.exit(2);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(EMAIL)) { console.error("That email doesn't look right: " + EMAIL); process.exit(2); }
  if (PASSWORD.length < 8) { console.error("Use a password of at least 8 characters."); process.exit(2); }
  const pool = makePool(), db = await pool.connect();
  const added = [];
  try {
    if (!(await db.query("select to_regclass('public.gyms') as t")).rows[0].t) throw new Error("No JitsFlow tables in that database: start the server against it once first.");
    await db.query("begin");
    const hash = await bcrypt.hash(PASSWORD, 11);
    let coach = (await db.query("select id, gym_id, role from users where email=$1 for update", [EMAIL])).rows[0];
    let gym = coach && coach.gym_id ? (await db.query("select id, name, student_code from gyms where id=$1", [coach.gym_id])).rows[0] : null;
    if (coach && (coach.role !== "coach" || (gym && gym.name !== GYM))) throw new Error(`${EMAIL} is already someone's account (not the demo gym's head coach). Pick another --email.`);
    if (!gym) {
      gym = (await db.query("insert into gyms(name,student_code,coach_code,timezone,bill_start,pop_token) values($1,$2,$3,$4,date_trunc('month', now() at time zone $4)::date,$5) returning id, name, student_code",
        [GYM, code(), code(), TZ, popToken()])).rows[0];
      added.push("the gym");
    }
    if (!coach) {
      coach = (await db.query("insert into users(gym_id,role,name,email,pass_hash,signed_up_at,email_verified_at,email_verified_for) values($1,'coach',$2,$3,$4,now(),now(),$3) returning id, gym_id",
        [gym.id, COACH, EMAIL, hash])).rows[0];
      added.push("the head coach account");
    } else {
      // A new password signs the account out everywhere else, as a password reset does.
      await db.query("update users set pass_hash=$2, gym_id=$3, active=true where id=$1", [coach.id, hash, gym.id]);
      await db.query("delete from sessions where user_id=$1", [coach.id]);
    }
    await db.query("update gyms set head_coach_id=$1 where id=$2", [coach.id, gym.id]);
    const today = (await db.query("select (now() at time zone $1)::date::text as d", [TZ])).rows[0].d;
    // plans
    const plan = {};
    for (const p of PLANS) {
      let r = (await db.query("select id from plans where gym_id=$1 and name=$2", [gym.id, p.name])).rows[0];
      if (!r) { r = (await db.query("insert into plans(gym_id,name,price_cents,period,classes_per_week,active) values($1,$2,$3,'month',$4,true) returning id", [gym.id, p.name, p.price, p.cpw])).rows[0]; added.push(`plan ${p.name}`); }
      plan[p.name] = r.id;
    }
    // members
    for (const [name, belt, stripes, pl] of MEMBERS) {
      if ((await db.query("select 1 from users where gym_id=$1 and name=$2", [gym.id, name])).rows[0]) continue;
      await db.query(`insert into users(gym_id,role,name,email,pass_hash,phone,belt,stripes,plan_id,plan_status,plan_started,offline)
        values($1,'student',$2,null,null,'',$3,$4,$5,'active',$6,true)`, [gym.id, name, belt, stripes, plan[pl], today]);
      added.push(name);
    }
    // two weeks of classes from today (South Africa is UTC+2 all year)
    let nc = 0;
    for (let d = 0; d < 14; d++) {
      const day = new Date(Date.parse(today + "T12:00:00Z") + d * 864e5);
      for (const [wd, h, m, title, len] of WEEK) {
        if (day.getUTCDay() !== wd) continue;
        const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h - 2, m));
        if (at < new Date()) continue;
        if ((await db.query("select 1 from classes where gym_id=$1 and starts_at=$2", [gym.id, at])).rows[0]) continue;
        await db.query("insert into classes(gym_id,title,starts_at,duration_min,plan,shared,created_by,kind,capacity,coach,level,discipline) values($1,$2,$3,$4,'{}',true,$5,'class',$6,$7,'','No-gi')",
          [gym.id, title, at, len, coach.id, title === "Open mat" ? null : 20, COACH]);
        nc++;
      }
    }
    if (nc) added.push(`${nc} classes`);
    await db.query("commit");
    console.log(`\nReviewer account ready (${added.length ? "added: " + added.join(", ") : "nothing new to add"}).\n
  Sign in:   https://www.jitsflow.com/app/?signin=1
  Email:     ${EMAIL}
  Password:  ${PASSWORD}
  Gym:       ${GYM} (head coach; members join with code ${gym.student_code})

  The plan and the Add a card checkout are in the Gym tab. Nothing is charged unless a card is added.
  Running this again keeps the same gym and sets a new password (or the one you pass with --password).\n`);
  } catch (e) {
    await db.query("rollback").catch(() => {});
    console.error("Not done: " + e.message); process.exitCode = 1;
  } finally { db.release(); await pool.end(); }
})();
