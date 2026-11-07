// JitsFlow API: accounts, synced progress, classes and attendance, coach roster and payments.
"use strict";
const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const importer = require("./importer");
const mail = require("./mail");

const COOKIE = "jf_s";
const SESSION_DAYS = 60;
const BELTS = ["white", "blue", "purple", "brown", "black"];

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const code = () => Array.from(crypto.randomBytes(8), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const isEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(e);
const intOr = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Simple in-memory limiter for sign-in attempts (per IP and per email).
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  h.n++;
  return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); }, 60000).unref();

function makeApi(pool, { secureCookies }) {
  const api = express.Router();
  const q = (text, params) => pool.query(text, params);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  api.use(express.json({ limit: "400kb" }));
  api.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    // Changes must come from our own pages: same-site cookie plus a custom header a form post can't send.
    if (req.method !== "GET" && req.headers["x-jf"] !== "1") return res.status(403).json({ error: "Request blocked." });
    next();
  });

  // Who is calling?
  api.use(wrap(async (req, res, next) => {
    const tok = cookies(req)[COOKIE];
    if (tok && tok.length === 64) {
      const r = await q(`select u.*, g.name as gym_name, g.student_code, g.coach_code, g.monthly_fee_cents as gym_fee, g.currency, g.logo_v
        from sessions s join users u on u.id=s.user_id left join gyms g on g.id=u.gym_id
        where s.token_hash=$1 and s.expires_at>now()`, [sha(tok)]);
      if (r.rows[0]) {
        req.user = r.rows[0];
        if (!req.user.last_seen || Date.now() - new Date(req.user.last_seen) > 3600e3) q("update users set last_seen=now() where id=$1", [req.user.id]).catch(() => {});
      }
    }
    next();
  }));
  const needUser = (req) => { if (!req.user) fail(401, "Sign in to continue."); return req.user; };
  const needCoach = (req) => { const u = needUser(req); if (u.role !== "coach" || !u.gym_id) fail(403, "Only coaches can do that."); return u; };

  async function startSession(res, userId) {
    const tok = crypto.randomBytes(32).toString("hex");
    await q("insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+($3||' days')::interval)", [sha(tok), userId, String(SESSION_DAYS)]);
    res.cookie(COOKIE, tok, { httpOnly: true, secure: secureCookies, sameSite: "lax", maxAge: SESSION_DAYS * 864e5, path: "/" });
  }
  function me(u) {
    const out = { id: String(u.id), name: u.name, email: u.email, role: u.role, belt: u.belt, stripes: u.stripes };
    if (u.gym_id) out.gym = { id: String(u.gym_id), name: u.gym_name, currency: u.currency, logo: u.logo_v ? `/api/gyms/${u.gym_id}/logo?v=${u.logo_v}` : null };
    if (u.role === "coach" && u.gym_id) Object.assign(out.gym, { studentCode: u.student_code, coachCode: u.coach_code, monthlyFeeCents: u.gym_fee });
    return out;
  }
  function checkSignIn(req, email) {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "?";
    if (limited("ip:" + ip, 30, 15 * 60e3) || limited("em:" + email, 10, 15 * 60e3)) fail(429, "Too many attempts. Wait 15 minutes and try again.");
  }
  async function newUser({ name, email, password, role, gymId }) {
    name = clean(name, 80); email = clean(email, 254).toLowerCase(); password = String(password || "");
    if (!name) fail(400, "Enter your name.");
    if (!isEmail(email)) fail(400, "Enter a valid email address.");
    if (password.length < 8) fail(400, "Use a password of at least 8 characters.");
    if (password.length > 200) fail(400, "That password is too long.");
    const hash = await bcrypt.hash(password, 11);
    try {
      const r = await q("insert into users(gym_id,role,name,email,pass_hash) values($1,$2,$3,$4,$5) returning id", [gymId, role, name, email, hash]);
      return r.rows[0].id;
    } catch (e) {
      if (e.code === "23505") fail(409, "An account with that email already exists. Sign in instead.");
      throw e;
    }
  }
  const loadMe = async (id) => (await q(`select u.*, g.name as gym_name, g.student_code, g.coach_code, g.monthly_fee_cents as gym_fee, g.currency, g.logo_v
      from users u left join gyms g on g.id=u.gym_id where u.id=$1`, [id])).rows[0];

  // ---------- accounts ----------
  api.post("/auth/start-gym", wrap(async (req, res) => {
    const b = req.body || {};
    checkSignIn(req, clean(b.email, 254).toLowerCase());
    const gymName = clean(b.gym, 100);
    if (!gymName) fail(400, "Enter your gym's name.");
    const g = await q("insert into gyms(name,student_code,coach_code) values($1,$2,$3) returning id", [gymName, code(), code()]);
    let id;
    try { id = await newUser({ ...b, role: "coach", gymId: g.rows[0].id }); }
    catch (e) { await q("delete from gyms where id=$1", [g.rows[0].id]); throw e; }
    await startSession(res, id);
    const m = await loadMe(id);
    mail.sendLater({ to: m.email, ...mail.templates.welcomeCoach(m.name, m.gym_name, mail.appUrl() + "/app/?join=" + m.student_code) });
    res.status(201).json({ me: me(m) });
  }));

  api.post("/auth/register", wrap(async (req, res) => {
    const b = req.body || {};
    checkSignIn(req, clean(b.email, 254).toLowerCase());
    let gymId = null, role = "student";
    const c = clean(b.code, 20).toUpperCase();
    if (c) {
      const g = await q("select id, (coach_code=$1) as coach from gyms where student_code=$1 or coach_code=$1", [c]);
      if (!g.rows[0]) fail(404, "That gym code isn't right. Check it with your coach.");
      gymId = g.rows[0].id; role = g.rows[0].coach ? "coach" : "student";
    }
    const id = await newUser({ ...b, role, gymId });
    await startSession(res, id);
    const m = await loadMe(id);
    if (m.role === "student") mail.sendLater({ to: m.email, ...mail.templates.welcomeStudent(m.name, m.gym_name) });
    res.status(201).json({ me: me(m) });
  }));

  api.post("/auth/login", wrap(async (req, res) => {
    const email = clean(req.body?.email, 254).toLowerCase();
    checkSignIn(req, email);
    const r = await q("select id, pass_hash from users where email=$1", [email]);
    const ok = r.rows[0] && (await bcrypt.compare(String(req.body?.password || ""), r.rows[0].pass_hash));
    if (!ok) fail(401, "That email and password don't match.");
    await startSession(res, r.rows[0].id);
    res.json({ me: me(await loadMe(r.rows[0].id)) });
  }));

  // Forgotten password: email a one-time link. The answer is the same whether or not the email has an account.
  api.post("/auth/forgot", wrap(async (req, res) => {
    const email = clean(req.body?.email, 254).toLowerCase();
    if (!isEmail(email)) fail(400, "Enter the email you signed up with.");
    checkSignIn(req, "reset:" + email);
    if (!mail.mailOn()) fail(503, "Password reset by email isn't switched on yet. Ask your coach or email hello@jitsflow.com.");
    const r = await q("select id, name from users where email=$1", [email]);
    if (r.rows[0]) {
      const tok = crypto.randomBytes(32).toString("hex");
      await q("delete from password_resets where user_id=$1", [r.rows[0].id]);
      await q("insert into password_resets(token_hash,user_id,expires_at) values($1,$2,now()+interval '1 hour')", [sha(tok), r.rows[0].id]);
      try { await mail.send({ to: email, ...mail.templates.reset(r.rows[0].name, mail.appUrl() + "/app/?reset=" + tok) }); }
      catch (e) { console.warn("mail:", e.message); fail(502, "Couldn't send the email just now. Try again in a minute."); }
    }
    res.json({ ok: true });
  }));
  api.post("/auth/reset", wrap(async (req, res) => {
    const tok = clean(req.body?.token, 100), password = String(req.body?.password || "");
    if (!/^[0-9a-f]{64}$/.test(tok)) fail(400, "That reset link isn't right. Ask for a new one.");
    if (password.length < 8) fail(400, "Use a password of at least 8 characters.");
    if (password.length > 200) fail(400, "That password is too long.");
    const r = await q("delete from password_resets where token_hash=$1 returning user_id, expires_at > now() as live", [sha(tok)]);
    if (!r.rows[0] || !r.rows[0].live) fail(400, "That reset link has expired or was already used. Ask for a new one.");
    const uid = r.rows[0].user_id;
    await q("update users set pass_hash=$1 where id=$2", [await bcrypt.hash(password, 11), uid]);
    await q("delete from sessions where user_id=$1", [uid]); // sign out everywhere else
    await startSession(res, uid);
    res.json({ me: me(await loadMe(uid)) });
  }));
  api.get("/status", (req, res) => res.json({ db: true, mail: mail.mailOn(), ai: !!process.env.ANTHROPIC_API_KEY }));

  api.post("/auth/logout", wrap(async (req, res) => {
    const tok = cookies(req)[COOKIE];
    if (tok) await q("delete from sessions where token_hash=$1", [sha(tok)]);
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  }));

  api.get("/me", wrap(async (req, res) => { res.json({ me: req.user ? me(req.user) : null }); }));

  api.patch("/me", wrap(async (req, res) => {
    const u = needUser(req), b = req.body || {};
    const name = b.name !== undefined ? clean(b.name, 80) : u.name;
    if (!name) fail(400, "Enter your name.");
    await q("update users set name=$1 where id=$2", [name, u.id]);
    res.json({ me: me(await loadMe(u.id)) });
  }));

  api.post("/me/join", wrap(async (req, res) => {
    const u = needUser(req);
    const c = clean(req.body?.code, 20).toUpperCase();
    const g = await q("select id, (coach_code=$1) as coach from gyms where student_code=$1 or coach_code=$1", [c]);
    if (!g.rows[0]) fail(404, "That gym code isn't right. Check it with your coach.");
    await q("update users set gym_id=$1, role=$2 where id=$3", [g.rows[0].id, g.rows[0].coach ? "coach" : "student", u.id]);
    res.json({ me: me(await loadMe(u.id)) });
  }));

  api.delete("/me", wrap(async (req, res) => {
    const u = needUser(req);
    if (!(await bcrypt.compare(String(req.body?.password || ""), u.pass_hash))) fail(401, "That password isn't right.");
    await q("delete from users where id=$1", [u.id]);
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  }));

  // ---------- your progress ----------
  api.get("/progress", wrap(async (req, res) => {
    const u = needUser(req);
    const r = await q("select data, updated_at from progress where user_id=$1", [u.id]);
    res.json(r.rows[0] ? { data: r.rows[0].data, updatedAt: r.rows[0].updated_at } : { data: null });
  }));
  api.put("/progress", wrap(async (req, res) => {
    const u = needUser(req), d = req.body?.data;
    if (!d || typeof d !== "object" || Array.isArray(d)) fail(400, "Progress must be an object.");
    if (JSON.stringify(d).length > 300000) fail(413, "Progress is too large.");
    await q(`insert into progress(user_id,data,updated_at) values($1,$2,now())
             on conflict(user_id) do update set data=excluded.data, updated_at=now()`, [u.id, d]);
    if (d.settings && typeof d.settings.goal === "string") {
      const cur = { blue: "white", purple: "blue", brown: "purple", black: "brown" }[d.settings.goal];
      if (cur && u.role === "student" && u.belt === "white" && cur !== "white") await q("update users set belt=$1 where id=$2 and belt='white'", [cur, u.id]);
    }
    res.json({ ok: true });
  }));

  api.get("/logs", wrap(async (req, res) => {
    const u = needUser(req);
    const r = await q("select id, data from training_logs where user_id=$1 order by date desc nulls last limit 1000", [u.id]);
    res.json({ logs: r.rows.map((x) => ({ ...x.data, id: x.id })) });
  }));
  api.put("/logs/:id", wrap(async (req, res) => {
    const u = needUser(req), id = req.params.id, d = req.body?.data;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) fail(400, "Bad session id.");
    if (!d || typeof d !== "object" || JSON.stringify(d).length > 20000) fail(400, "Bad session.");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(d.date || "") ? d.date : null;
    await q(`insert into training_logs(user_id,id,date,data) values($1,$2,$3,$4)
             on conflict(user_id,id) do update set date=excluded.date, data=excluded.data, updated_at=now()`, [u.id, id, date, d]);
    res.json({ ok: true });
  }));
  api.delete("/logs/:id", wrap(async (req, res) => {
    const u = needUser(req);
    await q("delete from training_logs where user_id=$1 and id=$2", [u.id, String(req.params.id)]);
    res.json({ ok: true });
  }));

  // ---------- classes ----------
  const classOut = (c, coach) => ({ id: String(c.id), title: c.title, startsAt: c.starts_at, durationMin: c.duration_min, shared: c.shared,
    plan: coach || c.shared ? c.plan : null, going: Number(c.going || 0), myGoing: !!c.my_going, myAttended: !!c.my_attended });

  api.get("/classes", wrap(async (req, res) => {
    const u = needUser(req);
    if (!u.gym_id) return res.json({ classes: [] });
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 864e5);
    const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 60 * 864e5);
    if (isNaN(from) || isNaN(to)) fail(400, "Bad date range.");
    const r = await q(`select c.*, (select count(*) from attendance a where a.class_id=c.id and a.going) as going,
        (select going from attendance a where a.class_id=c.id and a.user_id=$2) as my_going,
        (select attended from attendance a where a.class_id=c.id and a.user_id=$2) as my_attended
      from classes c where c.gym_id=$1 and c.starts_at between $3 and $4 order by c.starts_at limit 200`, [u.gym_id, u.id, from, to]);
    res.json({ classes: r.rows.map((c) => classOut(c, u.role === "coach")) });
  }));

  function readClass(b) {
    const title = clean(b.title, 120) || "Class";
    const startsAt = new Date(b.startsAt);
    if (isNaN(startsAt)) fail(400, "Pick a date and time for the class.");
    const durationMin = Math.min(600, Math.max(15, intOr(b.durationMin, 60)));
    const plan = b.plan && typeof b.plan === "object" ? b.plan : {};
    const p = { focus: clean(plan.focus, 120), notes: clean(plan.notes, 4000), ids: Array.isArray(plan.ids) ? plan.ids.map((x) => clean(x, 64)).filter(Boolean).slice(0, 30) : [] };
    return { title, startsAt, durationMin, plan: p, shared: b.shared !== false };
  }
  api.post("/classes", wrap(async (req, res) => {
    const u = needCoach(req), c = readClass(req.body || {});
    const r = await q("insert into classes(gym_id,title,starts_at,duration_min,plan,shared,created_by) values($1,$2,$3,$4,$5,$6,$7) returning *",
      [u.gym_id, c.title, c.startsAt, c.durationMin, c.plan, c.shared, u.id]);
    res.status(201).json({ class: classOut(r.rows[0], true) });
  }));
  async function ownClass(u, id) {
    const r = await q("select * from classes where id=$1 and gym_id=$2", [intOr(id, 0), u.gym_id]);
    if (!r.rows[0]) fail(404, "That class doesn't exist.");
    return r.rows[0];
  }
  api.put("/classes/:id", wrap(async (req, res) => {
    const u = needCoach(req); await ownClass(u, req.params.id);
    const c = readClass(req.body || {});
    const r = await q("update classes set title=$1,starts_at=$2,duration_min=$3,plan=$4,shared=$5 where id=$6 returning *",
      [c.title, c.startsAt, c.durationMin, c.plan, c.shared, intOr(req.params.id, 0)]);
    res.json({ class: classOut(r.rows[0], true) });
  }));
  api.delete("/classes/:id", wrap(async (req, res) => {
    const u = needCoach(req); await ownClass(u, req.params.id);
    await q("delete from classes where id=$1", [intOr(req.params.id, 0)]);
    res.json({ ok: true });
  }));
  api.put("/classes/:id/rsvp", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) fail(403, "Join a gym first.");
    const c = await q("select id from classes where id=$1 and gym_id=$2", [intOr(req.params.id, 0), u.gym_id]);
    if (!c.rows[0]) fail(404, "That class doesn't exist.");
    const going = req.body?.going !== false;
    await q(`insert into attendance(class_id,user_id,going) values($1,$2,$3)
             on conflict(class_id,user_id) do update set going=excluded.going, updated_at=now()`, [c.rows[0].id, u.id, going]);
    res.json({ ok: true, going });
  }));

  // ---------- coach: class detail, roster, students ----------
  async function summaries(gymId, userIds) {
    if (!userIds.length) return {};
    const p = await q("select user_id, data->'mastery' as mastery, data->'settings'->>'goal' as goal from progress where user_id = any($1)", [userIds]);
    const l = await q(`select user_id, max(date) as last, count(*) filter (where date >= current_date - 30) as n30,
        coalesce(jsonb_agg(data->'stuck') filter (where date >= current_date - 30), '[]') as stuck,
        coalesce(jsonb_agg(data->'tapped') filter (where date >= current_date - 30), '[]') as tapped
      from training_logs where user_id = any($1) group by user_id`, [userIds]);
    const a = await q(`select a.user_id, count(*) filter (where a.attended) as attended30 from attendance a join classes c on c.id=a.class_id
      where a.user_id = any($1) and c.starts_at >= now() - interval '30 days' and c.gym_id=$2 group by a.user_id`, [userIds, gymId]);
    const out = {};
    for (const id of userIds) out[id] = { mastery: {}, goal: null, last: null, n30: 0, stuck: {}, tapped: {}, attended30: 0 };
    const count = (arrs) => { const m = {}; for (const arr of arrs || []) for (const k of arr || []) if (typeof k === "string") m[k] = (m[k] || 0) + 1; return m; };
    for (const r of p.rows) Object.assign(out[r.user_id], { mastery: r.mastery || {}, goal: r.goal });
    for (const r of l.rows) Object.assign(out[r.user_id], { last: r.last, n30: Number(r.n30), stuck: count(r.stuck), tapped: count(r.tapped) });
    for (const r of a.rows) out[r.user_id].attended30 = Number(r.attended30);
    return out;
  }
  const person = (u, s) => ({ id: String(u.id), name: u.name, belt: u.belt, stripes: u.stripes, ...s });

  api.get("/coach/classes/:id", wrap(async (req, res) => {
    const u = needCoach(req), c = await ownClass(u, req.params.id);
    const r = await q(`select u.id,u.name,u.belt,u.stripes,a.going,a.attended from attendance a join users u on u.id=a.user_id
      where a.class_id=$1 and (a.going or a.attended) order by u.name`, [c.id]);
    const s = await summaries(u.gym_id, r.rows.map((x) => x.id));
    res.json({ class: classOut({ ...c, going: r.rows.filter((x) => x.going).length }, true),
      attendees: r.rows.map((x) => ({ ...person(x, s[x.id]), going: x.going, attended: x.attended })) });
  }));
  api.put("/coach/classes/:id/attendance", wrap(async (req, res) => {
    const u = needCoach(req), c = await ownClass(u, req.params.id);
    const sid = intOr(req.body?.userId, 0);
    const st = await q("select id from users where id=$1 and gym_id=$2", [sid, u.gym_id]);
    if (!st.rows[0]) fail(404, "That student isn't in your gym.");
    await q(`insert into attendance(class_id,user_id,going,attended) values($1,$2,true,$3)
             on conflict(class_id,user_id) do update set attended=excluded.attended, updated_at=now()`, [c.id, sid, req.body?.attended !== false]);
    res.json({ ok: true });
  }));

  api.get("/coach/roster", wrap(async (req, res) => {
    const u = needCoach(req);
    const r = await q("select id,name,email,role,belt,stripes,active,monthly_fee_cents,notes,created_at from users where gym_id=$1 order by role, name", [u.gym_id]);
    const s = await summaries(u.gym_id, r.rows.map((x) => x.id));
    const pay = await q(`select user_id, sum(amount_cents) as month_cents, max(paid_on) as last_paid from payments
      where gym_id=$1 and user_id is not null and paid_on >= date_trunc('month', current_date) group by user_id`, [u.gym_id]);
    const pm = Object.fromEntries(pay.rows.map((x) => [x.user_id, x]));
    res.json({ gymFeeCents: u.gym_fee, currency: u.currency, people: r.rows.map((x) => ({ ...person(x, s[x.id]), email: x.email, role: x.role, active: x.active,
      feeCents: x.monthly_fee_cents ?? u.gym_fee, notes: x.notes, joined: x.created_at,
      paidThisMonthCents: Number(pm[x.id]?.month_cents || 0), lastPaid: pm[x.id]?.last_paid || null })) });
  }));

  async function ownStudent(u, id) {
    const r = await q("select * from users where id=$1 and gym_id=$2", [intOr(id, 0), u.gym_id]);
    if (!r.rows[0]) fail(404, "That person isn't in your gym.");
    return r.rows[0];
  }
  api.get("/coach/students/:id", wrap(async (req, res) => {
    const u = needCoach(req), st = await ownStudent(u, req.params.id);
    const s = (await summaries(u.gym_id, [st.id]))[st.id];
    const logs = await q("select id,data from training_logs where user_id=$1 order by date desc nulls last limit 30", [st.id]);
    const pays = await q("select * from payments where user_id=$1 and gym_id=$2 order by paid_on desc limit 24", [st.id, u.gym_id]);
    res.json({ student: { ...person(st, s), email: st.email, role: st.role, active: st.active, feeCents: st.monthly_fee_cents ?? u.gym_fee, notes: st.notes },
      logs: logs.rows.map((x) => ({ ...x.data, id: x.id })), payments: pays.rows.map(payOut) });
  }));
  api.patch("/coach/students/:id", wrap(async (req, res) => {
    const u = needCoach(req), st = await ownStudent(u, req.params.id), b = req.body || {};
    const belt = b.belt !== undefined ? (BELTS.includes(b.belt) ? b.belt : fail(400, "Pick a belt.")) : st.belt;
    const stripes = b.stripes !== undefined ? Math.min(4, Math.max(0, intOr(b.stripes, 0))) : st.stripes;
    const notes = b.notes !== undefined ? clean(b.notes, 4000) : st.notes;
    const fee = b.feeCents !== undefined ? (b.feeCents === null ? null : Math.max(0, intOr(b.feeCents, 0))) : st.monthly_fee_cents;
    const active = b.active !== undefined ? !!b.active : st.active;
    await q("update users set belt=$1,stripes=$2,notes=$3,monthly_fee_cents=$4,active=$5 where id=$6", [belt, stripes, notes, fee, active, st.id]);
    res.json({ ok: true });
  }));

  api.patch("/coach/gym", wrap(async (req, res) => {
    const u = needCoach(req), b = req.body || {};
    const name = b.name !== undefined ? clean(b.name, 100) : u.gym_name;
    if (!name) fail(400, "Enter your gym's name.");
    const fee = b.monthlyFeeCents !== undefined ? Math.max(0, intOr(b.monthlyFeeCents, 0)) : u.gym_fee;
    await q("update gyms set name=$1, monthly_fee_cents=$2 where id=$3", [name, fee, u.gym_id]);
    res.json({ me: me(await loadMe(u.id)) });
  }));
  api.post("/coach/invite", wrap(async (req, res) => {
    const u = needCoach(req);
    if (!mail.mailOn()) fail(503, "Email isn't switched on yet. Copy the invite link and send it yourself.");
    const raw = Array.isArray(req.body?.emails) ? req.body.emails : String(req.body?.emails || "").split(/[\s,;]+/);
    const emails = [...new Set(raw.map((e) => clean(e, 254).toLowerCase()).filter(Boolean))];
    const bad = emails.filter((e) => !isEmail(e));
    if (bad.length) fail(400, `These don't look like email addresses: ${bad.slice(0, 3).join(", ")}`);
    if (!emails.length) fail(400, "Add at least one email address.");
    if (emails.length > 30) fail(400, "Send up to 30 invites at a time.");
    const have = new Set((await q("select email from users where gym_id=$1 and email = any($2)", [u.gym_id, emails])).rows.map((x) => x.email));
    let sent = 0; const failed = [];
    for (const e of emails) {
      if (have.has(e)) continue;
      if (limited("inv:" + u.gym_id, 100, 24 * 3600e3)) { failed.push(e); continue; } // 100 invite emails per gym per day
      try { await mail.send({ to: e, ...mail.templates.invite(u.name, u.gym_name, mail.appUrl() + "/app/?join=" + u.student_code) }); sent++; }
      catch (err) { console.warn("mail:", err.message); failed.push(e); }
    }
    res.json({ sent, already: [...have], failed });
  }));
  api.post("/coach/codes/rotate", wrap(async (req, res) => {
    const u = needCoach(req), which = req.body?.which === "coach" ? "coach_code" : "student_code";
    await q(`update gyms set ${which}=$1 where id=$2`, [code(), u.gym_id]);
    res.json({ me: me(await loadMe(u.id)) });
  }));

  // ---------- gym profile (imported from the gym's website or typed in) ----------
  api.get("/gym", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) return res.json({ gym: null });
    const r = await q("select id,name,profile,logo_v,currency,profile_updated_at from gyms where id=$1", [u.gym_id]);
    const g = r.rows[0];
    res.json({ gym: { id: String(g.id), name: g.name, currency: g.currency, profile: g.profile || {}, updatedAt: g.profile_updated_at, logo: g.logo_v ? `/api/gyms/${g.id}/logo?v=${g.logo_v}` : null } });
  }));
  api.get("/gyms/:id/logo", wrap(async (req, res) => {
    const r = await q("select logo, logo_type from gyms where id=$1 and logo is not null", [intOr(req.params.id, 0)]);
    if (!r.rows[0]) return res.status(404).json({ error: "No logo." });
    res.set({ "Content-Type": r.rows[0].logo_type, "Cache-Control": "public, max-age=31536000, immutable", "Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff" });
    res.send(r.rows[0].logo);
  }));
  // Read a gym website and return what was found. Nothing is saved until the coach confirms.
  api.post("/coach/import", wrap(async (req, res) => {
    const u = needCoach(req);
    if (limited("imp:" + u.gym_id, 12, 60 * 60e3)) fail(429, "That's a lot of imports. Try again in an hour.");
    try { res.json(await importer.importSite(clean(req.body?.url, 500), { log: (m) => console.warn(m) })); }
    catch (e) { if (e instanceof importer.ImportError) fail(400, e.message); throw e; }
  }));
  api.put("/coach/gym/profile", wrap(async (req, res) => {
    const u = needCoach(req), b = req.body || {};
    const profile = importer.cleanProfile(b.profile);
    const name = profile.name || u.gym_name;
    let fee = u.gym_fee;
    if (!fee) { const m = profile.rates.find((r) => r.period === "month" && (!r.currency || r.currency === (u.currency || "ZAR"))); if (m) fee = Math.round(m.price * 100); }
    await q("update gyms set name=$1, profile=$2, monthly_fee_cents=$3, profile_updated_at=now() where id=$4", [name, profile, fee, u.gym_id]);
    let logoNote = null;
    if (b.logoUrl === null) await q("update gyms set logo=null, logo_type=null, logo_v=null where id=$1", [u.gym_id]);
    else if (typeof b.logoUrl === "string" && b.logoUrl) {
      let img = null; try { img = await importer.fetchImage(clean(b.logoUrl, 600)); } catch (e) { img = null; }
      if (img) await q("update gyms set logo=$1, logo_type=$2, logo_v=$3 where id=$4", [img.body, img.type, sha(img.body.toString("base64")).slice(0, 10), u.gym_id]);
      else logoNote = "Couldn't download that logo. Everything else is saved.";
    }
    res.json({ me: me(await loadMe(u.id)), feeSet: !u.gym_fee && fee ? fee : 0, logoNote });
  }));
  // Add several classes at once (from the weekly timetable). Skips ones that already exist.
  api.post("/coach/classes/bulk", wrap(async (req, res) => {
    const u = needCoach(req), list = Array.isArray(req.body?.classes) ? req.body.classes.slice(0, 300) : fail(400, "No classes to add.");
    let added = 0, skipped = 0;
    for (const raw of list) {
      const c = readClass(raw || {});
      const dup = await q("select 1 from classes where gym_id=$1 and starts_at=$2 and lower(title)=lower($3)", [u.gym_id, c.startsAt, c.title]);
      if (dup.rows[0]) { skipped++; continue; }
      await q("insert into classes(gym_id,title,starts_at,duration_min,plan,shared,created_by) values($1,$2,$3,$4,$5,$6,$7)", [u.gym_id, c.title, c.startsAt, c.durationMin, c.plan, c.shared, u.id]);
      added++;
    }
    res.status(201).json({ added, skipped });
  }));

  // ---------- coach: payments ----------
  function payOut(p) {
    return { id: String(p.id), userId: p.user_id ? String(p.user_id) : null, amountCents: p.amount_cents, currency: p.currency, paidOn: p.paid_on,
      reference: p.reference, note: p.note, source: p.source, emailFrom: p.email_from, emailSubject: p.email_subject, createdAt: p.created_at };
  }
  api.get("/coach/payments", wrap(async (req, res) => {
    const u = needCoach(req);
    const r = await q("select * from payments where gym_id=$1 order by paid_on desc, id desc limit 300", [u.gym_id]);
    res.json({ payments: r.rows.map(payOut) });
  }));
  api.post("/coach/payments", wrap(async (req, res) => {
    const u = needCoach(req), b = req.body || {};
    const amount = intOr(b.amountCents, NaN);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) fail(400, "Enter the amount paid.");
    const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(b.paidOn || "") ? b.paidOn : fail(400, "Pick the date it was paid.");
    let userId = null;
    if (b.userId) userId = (await ownStudent(u, b.userId)).id;
    const r = await q(`insert into payments(gym_id,user_id,amount_cents,currency,paid_on,reference,note,source) values($1,$2,$3,$4,$5,$6,$7,'manual') returning *`,
      [u.gym_id, userId, amount, u.currency || "ZAR", paidOn, clean(b.reference, 140), clean(b.note, 500)]);
    res.status(201).json({ payment: payOut(r.rows[0]) });
  }));
  api.patch("/coach/payments/:id", wrap(async (req, res) => {
    const u = needCoach(req);
    const p = await q("select * from payments where id=$1 and gym_id=$2", [intOr(req.params.id, 0), u.gym_id]);
    if (!p.rows[0]) fail(404, "That payment doesn't exist.");
    const userId = req.body?.userId ? (await ownStudent(u, req.body.userId)).id : null;
    await q("update payments set user_id=$1 where id=$2", [userId, p.rows[0].id]);
    res.json({ ok: true });
  }));
  api.delete("/coach/payments/:id", wrap(async (req, res) => {
    const u = needCoach(req);
    await q("delete from payments where id=$1 and gym_id=$2", [intOr(req.params.id, 0), u.gym_id]);
    res.json({ ok: true });
  }));

  api.use((req, res) => res.status(404).json({ error: "Not found." }));
  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "That's too much data in one go." });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Bad request." });
    console.error("API error:", err);
    res.status(500).json({ error: "Something went wrong on the server. Try again." });
  });
  return api;
}

module.exports = { makeApi };
