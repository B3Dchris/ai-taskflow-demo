// JitsFlow API: accounts, synced progress, classes and attendance, coach roster and payments.
"use strict";
const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const importer = require("./importer");
const mail = require("./mail");
const pop = require("./pop");

const COOKIE = "jf_s";
const SESSION_DAYS = 60;
const BELTS = ["white", "blue", "purple", "brown", "black"];

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const code = () => Array.from(crypto.randomBytes(8), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
// Phone numbers as typed, minus anything that isn't a digit, space, + or dash ("082 123 4567", "+27 82 123 4567").
const cleanPhone = (v) => { const s = String(v == null ? "" : v).replace(/[^\d+\- ]/g, "").trim().slice(0, 24); return s.replace(/\D/g, "").length >= 7 ? s : ""; };
const isEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(e);
const intOr = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
// "2026-02-31" and "2027-13-45" match the pattern but aren't dates: check the calendar too.
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "") && (() => { const d = new Date(v + "T00:00:00Z"); return !isNaN(d) && d.toISOString().slice(0, 10) === v; })();

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

  // Proof-of-payment uploads carry a file (base64), so they get a bigger allowance than everything else.
  const smallJson = express.json({ limit: "400kb" }), bigJson = express.json({ limit: "12mb" });
  api.use((req, res, next) => (/\/proof$/.test(req.path) ? bigJson : smallJson)(req, res, next));
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
      const r = await q(`select u.*, g.name as gym_name, g.student_code, g.coach_code, g.monthly_fee_cents as gym_fee, g.currency, g.logo_v, g.timezone, g.show_attendees, g.students_invite
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

  async function validTz(tz) { tz = clean(tz, 64); if (!tz) return null; try { await q("select now() at time zone $1", [tz]); return tz; } catch (e) { return null; } }
  async function startSession(res, userId) {
    const tok = crypto.randomBytes(32).toString("hex");
    await q("insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+($3||' days')::interval)", [sha(tok), userId, String(SESSION_DAYS)]);
    res.cookie(COOKIE, tok, { httpOnly: true, secure: secureCookies, sameSite: "lax", maxAge: SESSION_DAYS * 864e5, path: "/" });
  }
  function me(u) {
    const out = { id: String(u.id), name: u.name, email: u.email, role: u.role, belt: u.belt, stripes: u.stripes, phone: u.phone || "" };
    if (u.gym_id) out.gym = { id: String(u.gym_id), name: u.gym_name, currency: u.currency, logo: u.logo_v ? `/api/gyms/${u.gym_id}/logo?v=${u.logo_v}` : null };
    if (u.gym_id) Object.assign(out.gym, { timezone: u.timezone || "Africa/Johannesburg", showAttendees: u.show_attendees !== false, studentsInvite: u.students_invite !== false });
    // Students may share the student invite code (to bring friends) when the gym allows it. They never see the coach code.
    if (u.gym_id && u.role === "student" && u.students_invite !== false) out.gym.inviteCode = u.student_code;
    if (u.role === "coach" && u.gym_id) Object.assign(out.gym, { studentCode: u.student_code, coachCode: u.coach_code, monthlyFeeCents: u.gym_fee });
    return out;
  }
  function checkSignIn(req, email) {
    // Not the first X-Forwarded-For entry: a visitor can put anything there. Cloudflare sets cf-connecting-ip;
    // otherwise use the address Express trusts (the proxy hop in front of us).
    const ip = (req.headers["cf-connecting-ip"] || req.ip || req.socket.remoteAddress || "?").toString();
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
  const loadMe = async (id) => (await q(`select u.*, g.name as gym_name, g.student_code, g.coach_code, g.monthly_fee_cents as gym_fee, g.currency, g.logo_v, g.timezone, g.show_attendees, g.students_invite
      from users u left join gyms g on g.id=u.gym_id where u.id=$1`, [id])).rows[0];

  // ---------- accounts ----------
  api.post("/auth/start-gym", wrap(async (req, res) => {
    const b = req.body || {};
    checkSignIn(req, clean(b.email, 254).toLowerCase());
    const gymName = clean(b.gym, 100);
    if (!gymName) fail(400, "Enter your gym's name.");
    const g = await q("insert into gyms(name,student_code,coach_code,timezone) values($1,$2,$3,$4) returning id", [gymName, code(), code(), (await validTz(b.timezone)) || "Africa/Johannesburg"]);
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
    const phone = b.phone !== undefined ? cleanPhone(b.phone) : u.phone || "";
    await q("update users set name=$1, phone=$2 where id=$3", [name, phone, u.id]);
    res.json({ me: me(await loadMe(u.id)) });
  }));

  api.post("/me/join", wrap(async (req, res) => {
    const u = needUser(req);
    const c = clean(req.body?.code, 20).toUpperCase();
    const g = await q("select id, (coach_code=$1) as coach from gyms where student_code=$1 or coach_code=$1", [c]);
    if (!g.rows[0]) fail(404, "That gym code isn't right. Check it with your coach.");
    if (u.gym_id && String(u.gym_id) !== String(g.rows[0].id)) await releaseBookings(u.id, u.gym_id, u);
    await q("update users set gym_id=$1, role=$2 where id=$3", [g.rows[0].id, g.rows[0].coach ? "coach" : "student", u.id]);
    res.json({ me: me(await loadMe(u.id)) });
  }));

  api.delete("/me", wrap(async (req, res) => {
    const u = needUser(req);
    if (!(await bcrypt.compare(String(req.body?.password || ""), u.pass_hash))) fail(401, "That password isn't right.");
    if (u.gym_id) await releaseBookings(u.id, u.gym_id, u);
    await q("delete from users where id=$1", [u.id]);
    // A gym with nobody left in it goes too (its classes, plans and payments with it).
    if (u.gym_id) await q("delete from gyms g where g.id=$1 and not exists (select 1 from users x where x.gym_id=g.id)", [u.gym_id]);
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
    const date = isDay(d.date) ? d.date : null;
    await q(`insert into training_logs(user_id,id,date,data) values($1,$2,$3,$4)
             on conflict(user_id,id) do update set date=excluded.date, data=excluded.data, updated_at=now()`, [u.id, id, date, d]);
    res.json({ ok: true });
  }));
  api.delete("/logs/:id", wrap(async (req, res) => {
    const u = needUser(req);
    await q("delete from training_logs where user_id=$1 and id=$2", [u.id, String(req.params.id)]);
    res.json({ ok: true });
  }));

  // ---------- classes and bookings ----------
  // attendance rows: going = booked, waitlisted = on the waitlist, attended = checked in (by the student or a coach).
  const tzOf = (u) => u.timezone || "Africa/Johannesburg";
  const shortName = (n) => { const p = String(n || "").trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : p[0] || "Member"; };
  const classOut = (c, coach) => ({ id: String(c.id), title: c.title, startsAt: c.starts_at, durationMin: c.duration_min, shared: c.shared,
    kind: c.kind || "class", capacity: c.capacity ?? null, priceCents: c.price_cents ?? null, coach: c.coach || "", level: c.level || "",
    plan: coach || c.shared ? c.plan : null, going: Number(c.going || 0), waiting: Number(c.waiting || 0),
    myGoing: !!c.my_going, myWaitlisted: !!c.my_waitlisted, myAttended: !!c.my_attended, myPosition: c.my_position ? Number(c.my_position) : null });

  api.get("/classes", wrap(async (req, res) => {
    const u = needUser(req);
    if (!u.gym_id) return res.json({ classes: [] });
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 864e5);
    const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 60 * 864e5);
    if (isNaN(from) || isNaN(to)) fail(400, "Bad date range.");
    const coach = u.role === "coach";
    const r = await q(`select c.*, (select count(*) from attendance a where a.class_id=c.id and a.going) as going,
        (select count(*) from attendance a where a.class_id=c.id and a.waitlisted) as waiting,
        m.going as my_going, m.waitlisted as my_waitlisted, m.attended as my_attended,
        case when m.waitlisted then (select count(*) from attendance w where w.class_id=c.id and w.waitlisted and w.booked_at <= m.booked_at) end as my_position
      from classes c left join attendance m on m.class_id=c.id and m.user_id=$2
      where c.gym_id=$1 and c.starts_at between $3 and $4
        and ($5 or c.kind <> 'private' or coalesce(m.going,false) or not exists (select 1 from attendance o where o.class_id=c.id and o.going))
      order by c.starts_at limit 2000`, [u.gym_id, u.id, from, to, coach]);
    const out = r.rows.map((c) => classOut(c, coach));
    // Who's booked, for classes still to come and only where a screen shows it: coaches get names for private
    // lessons ("Booked by"); students get group classes (first name + initial) if the gym allows it.
    const soon = Date.now() - 864e5;
    const ids = r.rows.filter((c) => new Date(c.starts_at).getTime() > soon && (coach ? c.kind === "private" : c.kind !== "private" && u.show_attendees !== false)).map((c) => c.id);
    if (ids.length) {
      const a = await q(`select a.class_id, u.id, u.name, u.belt, u.stripes from attendance a join users u on u.id=a.user_id
        where a.class_id = any($1) and a.going order by a.booked_at`, [ids]);
      const by = {};
      for (const x of a.rows) (by[x.class_id] = by[x.class_id] || []).push({ id: String(x.id), name: coach ? x.name : shortName(x.name), belt: x.belt, stripes: x.stripes, me: String(x.id) === String(u.id) });
      out.forEach((c) => { if (ids.includes(Number(c.id)) || ids.includes(c.id)) c.attendees = by[c.id] || []; });
    }
    res.json({ classes: out, showAttendees: u.show_attendees !== false });
  }));

  function readClass(b) {
    const kind = b.kind === "private" ? "private" : "class";
    const title = clean(b.title, 120) || (kind === "private" ? "Private lesson" : "Class");
    const startsAt = new Date(b.startsAt);
    if (isNaN(startsAt)) fail(400, "Pick a date and time for the class.");
    const durationMin = Math.min(600, Math.max(15, intOr(b.durationMin, 60)));
    const plan = b.plan && typeof b.plan === "object" ? b.plan : {};
    const p = { focus: clean(plan.focus, 120), notes: clean(plan.notes, 4000), ids: Array.isArray(plan.ids) ? plan.ids.map((x) => clean(x, 64)).filter(Boolean).slice(0, 30) : [] };
    let capacity = b.capacity === null || b.capacity === undefined || b.capacity === "" ? null : Math.min(500, Math.max(1, intOr(b.capacity, 0)));
    if (kind === "private") capacity = Math.min(capacity || 1, 6);
    const priceCents = b.priceCents === null || b.priceCents === undefined || b.priceCents === "" ? null : Math.max(0, intOr(b.priceCents, 0));
    return { title, startsAt, durationMin, plan: p, shared: b.shared !== false, kind, capacity, priceCents, coach: clean(b.coach, 60), level: clean(b.level, 40) };
  }
  const CLASS_COLS = "gym_id,title,starts_at,duration_min,plan,shared,created_by,kind,capacity,price_cents,coach,level";
  const classVals = (u, c) => [u.gym_id, c.title, c.startsAt, c.durationMin, c.plan, c.shared, u.id, c.kind, c.capacity, c.priceCents, c.coach, c.level];
  api.post("/classes", wrap(async (req, res) => {
    const u = needCoach(req), c = readClass(req.body || {});
    const r = await q(`insert into classes(${CLASS_COLS}) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`, classVals(u, c));
    res.status(201).json({ class: classOut(r.rows[0], true) });
  }));
  async function ownClass(u, id) {
    const r = await q("select * from classes where id=$1 and gym_id=$2", [intOr(id, 0), u.gym_id]);
    if (!r.rows[0]) fail(404, "That class doesn't exist.");
    return r.rows[0];
  }
  // Edits only change what they send: anything left out keeps its current value.
  const classBody = (r) => ({ title: r.title, startsAt: r.starts_at, durationMin: r.duration_min, plan: r.plan, shared: r.shared, kind: r.kind, capacity: r.capacity, priceCents: r.price_cents, coach: r.coach, level: r.level });
  api.put("/classes/:id", wrap(async (req, res) => {
    const u = needCoach(req), cur = await ownClass(u, req.params.id), b = req.body || {};
    const c = readClass({ ...classBody(cur), ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) });
    const db = await pool.connect(); let row, ids = [];
    try {
      await db.query("begin");
      await db.query("select id from classes where id=$1 for update", [cur.id]);
      row = (await db.query("update classes set title=$1,starts_at=$2,duration_min=$3,plan=$4,shared=$5,kind=$6,capacity=$7,price_cents=$8,coach=$9,level=$10 where id=$11 returning *",
        [c.title, c.startsAt, c.durationMin, c.plan, c.shared, c.kind, c.capacity, c.priceCents, c.coach, c.level, cur.id])).rows[0];
      ids = await promoteWaitlist(db, row); // more spots (or no limit any more): people waiting move in
      await db.query("commit");
    } catch (e) { await db.query("rollback").catch(() => {}); throw e; } finally { db.release(); }
    await tellPromoted(ids, row, u);
    res.json({ class: classOut(row, true), promoted: ids.length });
  }));
  const whenText = (d, tz) => { try { return new Date(d).toLocaleString("en-ZA", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }); } catch (e) { return new Date(d).toISOString(); } };
  api.delete("/classes/:id", wrap(async (req, res) => {
    const u = needCoach(req), c = await ownClass(u, req.params.id);
    const booked = await q("select u.email, u.name from attendance a join users u on u.id=a.user_id where a.class_id=$1 and (a.going or a.waitlisted)", [c.id]);
    await q("delete from classes where id=$1", [c.id]);
    if (new Date(c.starts_at) > new Date() && req.body?.notify !== false)
      for (const b of booked.rows) mail.sendLater({ to: b.email, ...mail.templates.cancelled(b.name, u.gym_name, c.title, whenText(c.starts_at, tzOf(u))) });
    res.json({ ok: true, notified: new Date(c.starts_at) > new Date() ? booked.rows.length : 0 });
  }));

  // Fill free spots from the waitlist, longest-waiting first. Call inside a transaction holding the class row lock.
  async function promoteWaitlist(db, c) {
    if (new Date(c.starts_at) <= new Date()) return [];
    const booked = Number((await db.query("select count(*) from attendance where class_id=$1 and going", [c.id])).rows[0].count);
    const free = c.capacity ? c.capacity - booked : 1e6;
    if (free <= 0) return [];
    const r = await db.query(`update attendance set going=true, waitlisted=false, booked_at=clock_timestamp(), updated_at=now()
      where class_id=$1 and user_id in (select user_id from attendance where class_id=$1 and waitlisted order by booked_at limit $2) returning user_id`, [c.id, Math.min(free, 1000)]);
    return r.rows.map((x) => x.user_id);
  }
  async function tellPromoted(ids, c, u) {
    if (!ids.length) return;
    const ppl = (await q("select email, name from users where id = any($1)", [ids])).rows;
    for (const p of ppl) mail.sendLater({ to: p.email, ...mail.templates.offWaitlist(p.name, u.gym_name, c.title, whenText(c.starts_at, tzOf(u))) });
  }
  // Release someone's future bookings at a gym (they left it or deleted their account) and hand the spots on.
  async function releaseBookings(userId, gymId, u) {
    const rows = (await q(`update attendance a set going=false, waitlisted=false, updated_at=now() from classes c
      where c.id=a.class_id and a.user_id=$1 and c.gym_id=$2 and c.starts_at > now() and (a.going or a.waitlisted) returning c.id`, [userId, gymId])).rows;
    for (const { id } of rows) {
      const db = await pool.connect();
      try { await db.query("begin"); const c = (await db.query("select * from classes where id=$1 for update", [id])).rows[0]; const ids = c ? await promoteWaitlist(db, c) : []; await db.query("commit"); if (c) await tellPromoted(ids, c, u); }
      catch (e) { await db.query("rollback").catch(() => {}); } finally { db.release(); }
    }
  }
  // Book or cancel. Runs in a transaction that locks the student (so weekly limits can't be beaten by booking
  // several classes at once) and then the class (so two people can't take the last spot).
  api.put("/classes/:id/rsvp", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) fail(403, "Join a gym first.");
    const want = req.body?.going !== false;
    const db = await pool.connect(); let promoted = null, out;
    try {
      await db.query("begin");
      await db.query("select id from users where id=$1 for update", [u.id]);
      const c = (await db.query("select * from classes where id=$1 and gym_id=$2 for update", [intOr(req.params.id, 0), u.gym_id])).rows[0];
      if (!c) fail(404, "That class doesn't exist.");
      if (new Date(c.starts_at).getTime() + c.duration_min * 6e4 < Date.now()) fail(400, "That class has already finished.");
      const mine = (await db.query("select * from attendance where class_id=$1 and user_id=$2", [c.id, u.id])).rows[0];
      const booked = Number((await db.query("select count(*) from attendance where class_id=$1 and going and user_id<>$2", [c.id, u.id])).rows[0].count);
      if (want) {
        if (mine && (mine.going || mine.waitlisted)) out = { going: !!mine.going, waitlisted: !!mine.waitlisted };
        else {
          if (u.role === "student" && u.plan_id) {
            const p = (await db.query("select * from plans where id=$1", [u.plan_id])).rows[0];
            if (u.plan_status === "paused" || u.plan_status === "cancelled") fail(403, `Your membership is ${u.plan_status}. Talk to your coach to book classes.`);
            if (p && p.classes_per_week && c.kind !== "private") {
              const n = Number((await db.query(`select count(*) from attendance a join classes k on k.id=a.class_id where a.user_id=$1 and a.going and k.kind<>'private' and k.id<>$2
                and date_trunc('week', k.starts_at at time zone $4) = date_trunc('week', $3::timestamptz at time zone $4)`, [u.id, c.id, c.starts_at, tzOf(u)])).rows[0].count);
              if (n >= p.classes_per_week) fail(403, `Your ${p.name} plan includes ${p.classes_per_week} class${p.classes_per_week > 1 ? "es" : ""} a week, and you've booked ${n} that week. Cancel one or ask your coach about upgrading.`);
            }
          }
          const full = c.capacity && booked >= c.capacity;
          if (full && c.kind === "private") fail(409, "Someone just booked that slot. Pick another time.");
          await db.query(`insert into attendance(class_id,user_id,going,waitlisted,booked_at) values($1,$2,$3,$4,clock_timestamp())
            on conflict(class_id,user_id) do update set going=excluded.going, waitlisted=excluded.waitlisted, booked_at=clock_timestamp(), updated_at=now()`, [c.id, u.id, !full, !!full]);
          out = { going: !full, waitlisted: !!full };
        }
      } else {
        await db.query("update attendance set going=false, waitlisted=false, updated_at=now() where class_id=$1 and user_id=$2", [c.id, u.id]);
        out = { going: false, waitlisted: false };
        // A spot opened: give it to whoever has waited longest.
        if (mine && mine.going) { const ids = await promoteWaitlist(db, c); if (ids.length) promoted = { ids, c }; }
      }
      if (out.waitlisted) out.position = Number((await db.query("select count(*) from attendance where class_id=$1 and waitlisted and booked_at <= (select booked_at from attendance where class_id=$1 and user_id=$2)", [c.id, u.id])).rows[0].count);
      await db.query("commit");
    } catch (e) { await db.query("rollback").catch(() => {}); throw e; } finally { db.release(); }
    if (promoted) await tellPromoted(promoted.ids, promoted.c, u);
    res.json({ ok: true, ...out });
  }));
  // Students check themselves in from 45 minutes before a class until it ends.
  api.post("/classes/:id/checkin", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) fail(403, "Join a gym first.");
    const db = await pool.connect();
    try {
      await db.query("begin");
      const c = (await db.query("select * from classes where id=$1 and gym_id=$2 for update", [intOr(req.params.id, 0), u.gym_id])).rows[0];
      if (!c) fail(404, "That class doesn't exist.");
      const start = new Date(c.starts_at).getTime(), now = Date.now();
      if (now < start - 45 * 6e4) fail(400, "Check-in opens 45 minutes before the class.");
      if (now > start + c.duration_min * 6e4) fail(400, "That class has finished.");
      const mine = (await db.query("select going from attendance where class_id=$1 and user_id=$2", [c.id, u.id])).rows[0];
      if (!mine || !mine.going) {
        if (c.kind === "private") fail(403, "That private lesson is booked for someone else.");
        const booked = Number((await db.query("select count(*) from attendance where class_id=$1 and going", [c.id])).rows[0].count);
        if (c.capacity && booked >= c.capacity) fail(409, "This class is full. Ask your coach at the mat.");
      }
      await db.query(`insert into attendance(class_id,user_id,going,attended,checked_in_at) values($1,$2,true,true,now())
               on conflict(class_id,user_id) do update set going=true, waitlisted=false, attended=true, checked_in_at=now(), updated_at=now()`, [c.id, u.id]);
      await db.query("commit");
    } catch (e) { await db.query("rollback").catch(() => {}); throw e; } finally { db.release(); }
    res.json({ ok: true });
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

  // Attendance analysis. A visit = a check-in, or a booking for a class where nobody was checked in
  // (so gyms that never take attendance still get numbers).
  const DAY = 864e5;
  async function visitStats(gymId, tz) {
    const cls = (await q(`select c.id, c.title, c.kind, c.capacity, c.starts_at,
        extract(isodow from c.starts_at at time zone $2)::int as dow, to_char(c.starts_at at time zone $2,'HH24:MI') as hm,
        to_char(date_trunc('week', c.starts_at at time zone $2),'YYYY-MM-DD') as wk,
        coalesce(a.checked,0)::int as checked, coalesce(a.booked,0)::int as booked, coalesce(a.waiting,0)::int as waiting
      from classes c left join (select class_id, count(*) filter (where attended) as checked, count(*) filter (where going) as booked, count(*) filter (where waitlisted) as waiting
          from attendance where class_id in (select id from classes where gym_id=$1 and starts_at > now() - interval '180 days') group by class_id) a on a.class_id=c.id
      where c.gym_id=$1 and c.starts_at > now() - interval '180 days' and c.starts_at + (c.duration_min || ' minutes')::interval < now()`, [gymId, tz])).rows;
    const byId = Object.fromEntries(cls.map((c) => [c.id, c]));
    const att = (await q(`select a.user_id, a.class_id, a.attended, a.going from attendance a join classes c on c.id=a.class_id
      where c.gym_id=$1 and c.starts_at > now() - interval '180 days' and c.starts_at + (c.duration_min || ' minutes')::interval < now() and (a.attended or a.going)`, [gymId])).rows;
    const visits = {};
    for (const a of att) { const c = byId[a.class_id]; if (!c) continue; if (a.attended || (a.going && c.checked === 0)) (visits[a.user_id] = visits[a.user_id] || []).push({ at: new Date(c.starts_at).getTime(), wk: c.wk, kind: c.kind, classId: c.id }); }
    for (const c of cls) c.count = c.checked || c.booked;
    return { cls, visits };
  }
  function studentStats(u, vs, now = Date.now()) {
    const v = (vs || []).slice().sort((a, b) => a.at - b.at);
    const d28 = v.filter((x) => x.at > now - 28 * DAY).length, p28 = v.filter((x) => x.at <= now - 28 * DAY && x.at > now - 56 * DAY).length;
    const last = v.length ? v[v.length - 1].at : null;
    const since = new Date(u.rank_changed_at || u.created_at).getTime();
    // weeks in a row with at least one visit, counting back from this week (or last week if none yet this week)
    const weeks = new Set(v.map((x) => x.wk)); let streak = 0;
    const wkKey = (t) => { const d = new Date(t); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); };
    let t = now; if (!weeks.has(wkKey(t))) t -= 7 * DAY;
    while (weeks.has(wkKey(t)) && streak < 104) { streak++; t -= 7 * DAY; }
    const joinedDays = (now - new Date(u.created_at).getTime()) / DAY, daysSince = last ? (now - last) / DAY : null;
    let segment;
    if (joinedDays < 30) segment = "new";
    else if (d28 >= 6) segment = "regular";
    else if ((d28 === 0 && p28 >= 2) || (p28 >= 4 && d28 <= p28 / 2)) segment = "at_risk";
    else if (!last || daysSince > 60) segment = "inactive";
    else if (d28 === 0) segment = "at_risk";
    else segment = "occasional";
    return { d28, p28, perWeek: Math.round((d28 / 4) * 10) / 10, last: last ? new Date(last).toISOString() : null, daysSince: daysSince === null ? null : Math.floor(daysSince),
      streak, total180: v.length, privates180: v.filter((x) => x.kind === "private").length, sinceRank: v.filter((x) => x.at > since).length, segment };
  }
  const monthly = (p) => !p ? null : p.period === "month" ? p.price_cents : p.period === "week" ? Math.round(p.price_cents * 52 / 12) : p.period === "year" ? Math.round(p.price_cents / 12) : p.period === "term" ? Math.round(p.price_cents / 3) : 0;
  async function plansOf(gymId) { return (await q("select * from plans where gym_id=$1 order by active desc, price_cents", [gymId])).rows; }
  const planOut = (p) => ({ id: String(p.id), name: p.name, priceCents: p.price_cents, period: p.period, classesPerWeek: p.classes_per_week, active: p.active, monthlyCents: monthly(p) });

  api.get("/coach/classes/:id", wrap(async (req, res) => {
    const u = needCoach(req), c = await ownClass(u, req.params.id);
    const r = await q(`select u.id,u.name,u.belt,u.stripes,a.going,a.attended,a.waitlisted,a.booked_at,a.checked_in_at from attendance a join users u on u.id=a.user_id
      where a.class_id=$1 and (a.going or a.attended or a.waitlisted) order by a.waitlisted, a.booked_at, u.name`, [c.id]);
    const s = await summaries(u.gym_id, r.rows.map((x) => x.id));
    const att = r.rows.filter((x) => !x.waitlisted);
    res.json({ class: classOut({ ...c, going: att.filter((x) => x.going).length, waiting: r.rows.length - att.length }, true),
      attendees: att.map((x) => ({ ...person(x, s[x.id]), going: x.going, attended: x.attended, bookedAt: x.booked_at, checkedInAt: x.checked_in_at, self: !!x.checked_in_at })),
      waitlist: r.rows.filter((x) => x.waitlisted).map((x) => ({ ...person(x, {}), bookedAt: x.booked_at })) });
  }));
  api.put("/coach/classes/:id/attendance", wrap(async (req, res) => {
    const u = needCoach(req), c = await ownClass(u, req.params.id);
    const ids = (Array.isArray(req.body?.userIds) ? req.body.userIds : [req.body?.userId]).map((x) => intOr(x, 0)).filter(Boolean).slice(0, 300);
    const st = await q("select id from users where id = any($1) and gym_id=$2", [ids, u.gym_id]);
    if (st.rows.length !== ids.length || !ids.length) fail(404, "That student isn't in your gym.");
    for (const sid of ids) await q(`insert into attendance(class_id,user_id,going,attended) values($1,$2,true,$3)
             on conflict(class_id,user_id) do update set attended=excluded.attended, going=attendance.going or excluded.attended, waitlisted=false, updated_at=now()`, [c.id, sid, req.body?.attended !== false]);
    res.json({ ok: true, count: ids.length });
  }));

  async function rosterRows(u) {
    const r = await q(`select u.id,u.name,u.email,u.phone,u.role,u.belt,u.stripes,u.active,u.monthly_fee_cents,u.notes,u.created_at,u.plan_id,u.plan_status,u.plan_started,u.rank_changed_at
      from users u where u.gym_id=$1 order by u.role, u.name`, [u.gym_id]);
    const plans = await plansOf(u.gym_id), pm = Object.fromEntries(plans.map((p) => [String(p.id), p]));
    const s = await summaries(u.gym_id, r.rows.map((x) => x.id));
    const vs = await visitStats(u.gym_id, tzOf(u)), { visits } = vs;
    const pay = await q(`select user_id, sum(amount_cents) filter (where status='confirmed' and paid_on >= date_trunc('month', current_date)) as month_cents,
        sum(amount_cents) filter (where status='pending' and paid_on >= date_trunc('month', current_date) - interval '7 days') as pending_cents,
        max(paid_on) filter (where status='confirmed') as last_paid from payments
      where gym_id=$1 and user_id is not null and status<>'rejected' group by user_id`, [u.gym_id]);
    const paid = Object.fromEntries(pay.rows.map((x) => [x.user_id, x]));
    return { plans, vs, rows: r.rows.map((x) => {
      const plan = pm[String(x.plan_id)] || null;
      const fee = x.monthly_fee_cents ?? (plan ? monthly(plan) : null) ?? u.gym_fee;
      return { ...person(x, s[x.id]), email: x.email, phone: x.phone || "", role: x.role, active: x.active, notes: x.notes, joined: x.created_at,
        feeCents: fee || 0, planId: plan ? String(plan.id) : null, planName: plan ? plan.name : null, planStatus: x.plan_status, planStarted: x.plan_started,
        paidThisMonthCents: Number(paid[x.id]?.month_cents || 0), pendingThisMonthCents: Number(paid[x.id]?.pending_cents || 0), lastPaid: paid[x.id]?.last_paid || null,
        visits: x.role === "student" ? studentStats(x, visits[x.id]) : null };
    }) };
  }
  api.get("/coach/roster", wrap(async (req, res) => {
    const u = needCoach(req), { plans, rows } = await rosterRows(u);
    res.json({ gymFeeCents: u.gym_fee, currency: u.currency, plans: plans.map(planOut), people: rows });
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
    const pays = await q("select * from payments where user_id=$1 and gym_id=$2 and status<>'rejected' order by paid_on desc limit 24", [st.id, u.gym_id]);
    const { visits } = await visitStats(u.gym_id, tzOf(u));
    const recent = await q(`select c.title, c.starts_at, c.kind, a.attended from attendance a join classes c on c.id=a.class_id
      where a.user_id=$1 and c.gym_id=$2 and (a.attended or a.going) order by c.starts_at desc limit 12`, [st.id, u.gym_id]);
    const plan = st.plan_id ? (await q("select * from plans where id=$1", [st.plan_id])).rows[0] : null;
    res.json({ student: { ...person(st, s), email: st.email, phone: st.phone || "", role: st.role, active: st.active, feeCents: st.monthly_fee_cents ?? (plan ? monthly(plan) : null) ?? u.gym_fee, feeOverride: st.monthly_fee_cents,
        notes: st.notes, joined: st.created_at, planId: st.plan_id ? String(st.plan_id) : null, planStatus: st.plan_status, planStarted: st.plan_started, rankChangedAt: st.rank_changed_at,
        visits: studentStats(st, visits[st.id]) },
      classes: recent.rows.map((x) => ({ title: x.title, startsAt: x.starts_at, kind: x.kind, attended: x.attended })),
      logs: logs.rows.map((x) => ({ ...x.data, id: x.id })), payments: pays.rows.map(payOut) });
  }));
  const PLAN_STATUS = ["active", "trial", "paused", "cancelled"];
  api.patch("/coach/students/:id", wrap(async (req, res) => {
    const u = needCoach(req), st = await ownStudent(u, req.params.id), b = req.body || {};
    const belt = b.belt !== undefined ? (BELTS.includes(b.belt) ? b.belt : fail(400, "Pick a belt.")) : st.belt;
    const stripes = b.stripes !== undefined ? Math.min(4, Math.max(0, intOr(b.stripes, 0))) : st.stripes;
    const notes = b.notes !== undefined ? clean(b.notes, 4000) : st.notes;
    const fee = b.feeCents !== undefined ? (b.feeCents === null ? null : Math.max(0, intOr(b.feeCents, 0))) : st.monthly_fee_cents;
    const active = b.active !== undefined ? !!b.active : st.active;
    let planId = st.plan_id;
    if (b.planId !== undefined) { planId = b.planId ? intOr(b.planId, 0) : null; if (planId && !(await q("select 1 from plans where id=$1 and gym_id=$2", [planId, u.gym_id])).rows[0]) fail(404, "That plan doesn't exist."); }
    const planStatus = b.planStatus !== undefined ? (PLAN_STATUS.includes(b.planStatus) ? b.planStatus : fail(400, "Pick a membership status.")) : st.plan_status;
    const planStarted = b.planStarted !== undefined ? (isDay(b.planStarted) ? b.planStarted : null) : st.plan_started;
    const rankChanged = belt !== st.belt || stripes !== st.stripes;
    if (b.phone !== undefined) await q("update users set phone=$1 where id=$2", [cleanPhone(b.phone), st.id]);
    await q(`update users set belt=$1,stripes=$2,notes=$3,monthly_fee_cents=$4,active=$5,plan_id=$6,plan_status=$7,plan_started=$8,
      rank_changed_at=case when $9 then now() else rank_changed_at end where id=$10`, [belt, stripes, notes, fee, active, planId, planStatus, planStarted, rankChanged, st.id]);
    res.json({ ok: true });
  }));

  // ---------- memberships ----------
  const PERIODS = ["month", "week", "year", "term", "class", "once"];
  function readPlan(b) {
    const name = clean(b.name, 80); if (!name) fail(400, "Give the plan a name.");
    const price = intOr(b.priceCents, NaN); if (!Number.isFinite(price) || price < 0 || price > 1e8) fail(400, "Enter the price.");
    const period = PERIODS.includes(b.period) ? b.period : "month";
    const cpw = b.classesPerWeek === null || b.classesPerWeek === undefined || b.classesPerWeek === "" ? null : Math.min(30, Math.max(1, intOr(b.classesPerWeek, 0)));
    return { name, price, period, cpw, active: b.active !== false };
  }
  api.get("/coach/plans", wrap(async (req, res) => { const u = needCoach(req); res.json({ plans: (await plansOf(u.gym_id)).map(planOut) }); }));
  api.post("/coach/plans", wrap(async (req, res) => {
    const u = needCoach(req), p = readPlan(req.body || {});
    const r = await q("insert into plans(gym_id,name,price_cents,period,classes_per_week,active) values($1,$2,$3,$4,$5,$6) returning *", [u.gym_id, p.name, p.price, p.period, p.cpw, p.active]);
    res.status(201).json({ plan: planOut(r.rows[0]) });
  }));
  api.patch("/coach/plans/:id", wrap(async (req, res) => {
    const u = needCoach(req), p = readPlan(req.body || {});
    const r = await q("update plans set name=$1,price_cents=$2,period=$3,classes_per_week=$4,active=$5 where id=$6 and gym_id=$7 returning *", [p.name, p.price, p.period, p.cpw, p.active, intOr(req.params.id, 0), u.gym_id]);
    if (!r.rows[0]) fail(404, "That plan doesn't exist.");
    res.json({ plan: planOut(r.rows[0]) });
  }));
  // Turn the prices imported from the gym's website into plans (skips names that already exist).
  api.post("/coach/plans/from-rates", wrap(async (req, res) => {
    const u = needCoach(req);
    const g = (await q("select profile from gyms where id=$1", [u.gym_id])).rows[0];
    const have = new Set((await plansOf(u.gym_id)).map((p) => p.name.toLowerCase()));
    let added = 0;
    for (const r of (g.profile && g.profile.rates) || []) {
      if (!r.name || have.has(r.name.toLowerCase()) || !PERIODS.includes(r.period)) continue;
      const cpw = /(\d)\s*(x|times|classes)\s*(a|per)\s*week/i.exec(r.name + " " + (r.note || ""));
      await q("insert into plans(gym_id,name,price_cents,period,classes_per_week) values($1,$2,$3,$4,$5)", [u.gym_id, clean(r.name, 80), Math.round(r.price * 100), r.period, cpw ? Number(cpw[1]) : null]);
      have.add(r.name.toLowerCase()); added++;
    }
    res.status(201).json({ added, plans: (await plansOf(u.gym_id)).map(planOut) });
  }));

  // ---------- your membership (students) ----------
  api.get("/me/membership", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) return res.json({ membership: null });
    const plan = u.plan_id ? (await q("select * from plans where id=$1", [u.plan_id])).rows[0] : null;
    const wk = Number((await q(`select count(*) from attendance a join classes k on k.id=a.class_id where a.user_id=$1 and a.going and k.kind<>'private'
      and date_trunc('week', k.starts_at at time zone $2) = date_trunc('week', now() at time zone $2)`, [u.id, tzOf(u)])).rows[0].count);
    const mine = (await q(`select c.starts_at, c.kind, to_char(date_trunc('week', c.starts_at at time zone $3),'YYYY-MM-DD') as wk, a.attended,
        (a.attended or (a.going and not exists (select 1 from attendance x where x.class_id=c.id and x.attended))) as counts
      from attendance a join classes c on c.id=a.class_id where a.user_id=$1 and c.gym_id=$2 and c.starts_at > now() - interval '180 days'
        and c.starts_at + (c.duration_min || ' minutes')::interval < now() and (a.attended or a.going)`, [u.id, u.gym_id, tzOf(u)])).rows
      .filter((x) => x.counts).map((x) => ({ at: new Date(x.starts_at).getTime(), wk: x.wk, kind: x.kind }));
    const st = studentStats(u, mine);
    const month = mine.filter((v) => new Date(v.at).getMonth() === new Date().getMonth() && Date.now() - v.at < 32 * DAY).length;
    res.json({ membership: { plan: plan ? planOut(plan) : null, status: u.plan_status, started: u.plan_started, bookedThisWeek: wk, visitsThisMonth: month, streak: st.streak, perWeek: st.perWeek, total180: st.total180 } });
  }));

  // ---------- coach: insights ----------
  api.get("/coach/insights", wrap(async (req, res) => {
    const u = needCoach(req), tz = tzOf(u), now = Date.now();
    const { plans, rows, vs } = await rosterRows(u);
    const { cls, visits } = vs;
    const studs = rows.filter((p) => p.role === "student" && p.active);
    // weekly visits for the last 12 weeks
    const wkKey = (t) => { const d = new Date(t); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); };
    const weeks = []; for (let i = 11; i >= 0; i--) weeks.push({ wk: wkKey(now - i * 7 * DAY), visits: 0, people: new Set() });
    const wi = Object.fromEntries(weeks.map((w, i) => [w.wk, i]));
    for (const [uid, vs] of Object.entries(visits)) for (const v of vs) if (wi[v.wk] !== undefined) { weeks[wi[v.wk]].visits++; weeks[wi[v.wk]].people.add(uid); }
    // class slots (same weekday, time and title) over the last 8 weeks
    const slots = {};
    for (const c of cls) {
      if (c.kind === "private" || new Date(c.starts_at).getTime() < now - 56 * DAY) continue;
      const k = c.dow + "|" + c.hm + "|" + c.title.toLowerCase();
      const s = (slots[k] = slots[k] || { dow: c.dow, hm: c.hm, title: c.title, n: 0, sum: 0, cap: 0, capN: 0, waitlisted: 0 });
      s.n++; s.sum += c.count; if (c.capacity) { s.cap += c.count / c.capacity; s.capN++; } if (c.waiting) s.waitlisted++;
    }
    const slotList = Object.values(slots).filter((s) => s.n >= 2).map((s) => ({ dow: s.dow, hm: s.hm, title: s.title, n: s.n, avg: Math.round((s.sum / s.n) * 10) / 10,
      fill: s.capN ? Math.round((100 * s.cap) / s.capN) : null, waitlisted: s.waitlisted })).sort((a, b) => b.avg - a.avg);
    const seg = { regular: 0, occasional: 0, at_risk: 0, new: 0, inactive: 0 };
    studs.forEach((p) => { seg[p.visits.segment]++; });
    const visits28 = studs.reduce((s, p) => s + p.visits.d28, 0), prev28 = studs.reduce((s, p) => s + p.visits.p28, 0);
    const old = studs.filter((p) => now - new Date(p.joined).getTime() > 90 * DAY);
    const expected = studs.filter((p) => !["paused", "cancelled", "trial"].includes(p.planStatus)).reduce((s, p) => s + (p.feeCents || 0), 0);
    const collected = Number((await q("select coalesce(sum(amount_cents),0) as s from payments where gym_id=$1 and status='confirmed' and paid_on >= date_trunc('month', current_date)", [u.gym_id])).rows[0].s);
    const unpaid = studs.filter((p) => p.feeCents > 0 && p.paidThisMonthCents < p.feeCents && p.planStatus !== "paused" && p.planStatus !== "cancelled");
    const mix = plans.filter((p) => p.active).map((p) => { const m = studs.filter((s) => s.planId === String(p.id) && s.planStatus !== "cancelled"); return { id: String(p.id), name: p.name, members: m.length, monthlyCents: m.length * (monthly(p) || 0) }; });
    res.json({
      tz, currency: u.currency,
      kpis: { active: studs.length, visits28, prev28, perWeek: Math.round((visits28 / 4) * 10) / 10, perMember: studs.length ? Math.round((visits28 / 4 / studs.length) * 10) / 10 : 0,
        newMembers30: studs.filter((p) => now - new Date(p.joined).getTime() < 30 * DAY).length,
        retention: { base: old.length, retained: old.filter((p) => p.visits.d28 > 0).length } },
      weeks: weeks.map((w) => ({ wk: w.wk, visits: w.visits, people: w.people.size })),
      segments: seg, slots: slotList,
      revenue: { collected, expected, unpaid: unpaid.map((p) => ({ id: p.id, name: p.name, dueCents: p.feeCents - p.paidThisMonthCents })) },
      plans: mix, noPlan: studs.filter((p) => !p.planId).length,
      students: studs.map((p) => ({ id: p.id, name: p.name, phone: p.phone, belt: p.belt, stripes: p.stripes, joined: p.joined, planName: p.planName, planStatus: p.planStatus,
        mastery: p.mastery, goal: p.goal, ...p.visits })),
    });
  }));


  // ---------- competitions ----------
  const COMP_STATUS = ["requested", "entered", "declined", "withdrawn"];
  const RESULTS = ["", "gold", "silver", "bronze", "competed", "didn't compete"];
  const dateOut = (d) => (d ? String(d).slice(0, 10) : null);
  const compOut = (c) => ({ id: String(c.id), name: c.name, startsOn: dateOut(c.starts_on), endsOn: dateOut(c.ends_on), venue: c.venue, city: c.city, organiser: c.organiser,
    url: c.url, registerBy: dateOut(c.register_by), fee: c.fee, style: c.style, divisions: c.divisions || [], details: c.details });
  function readComp(b) {
    const name = clean(b.name, 140); if (!name) fail(400, "Give the competition a name.");
    const d = (v) => (isDay(v) ? v : null);
    const startsOn = d(b.startsOn) || fail(400, "Pick the competition date.");
    const endsOn = d(b.endsOn) && b.endsOn >= startsOn ? b.endsOn : null;
    const url = /^https?:\/\//i.test(b.url || "") ? clean(b.url, 400) : "";
    return { name, startsOn, endsOn, venue: clean(b.venue, 140), city: clean(b.city, 80), organiser: clean(b.organiser, 100), url, registerBy: d(b.registerBy), fee: clean(b.fee, 120),
      style: ["gi", "nogi", "both"].includes(b.style) ? b.style : "", divisions: (Array.isArray(b.divisions) ? b.divisions : []).map((x) => clean(x, 80)).filter(Boolean).slice(0, 30), details: clean(b.details, 1500) };
  }
  async function ownComp(u, id) { const r = await q("select * from competitions where id=$1 and gym_id=$2", [intOr(id, 0), u.gym_id]); if (!r.rows[0]) fail(404, "That competition doesn't exist."); return r.rows[0]; }
  const compWhen = (c) => { try { const o = { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }; const a = new Date(dateOut(c.starts_on) + "T00:00:00Z").toLocaleDateString("en-ZA", o); return c.ends_on ? `${a} to ${new Date(dateOut(c.ends_on) + "T00:00:00Z").toLocaleDateString("en-ZA", o)}` : a; } catch (e) { return dateOut(c.starts_on); } };

  api.get("/competitions", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) return res.json({ competitions: [] });
    const coach = u.role === "coach";
    const cs = (await q("select * from competitions where gym_id=$1 and coalesce(ends_on, starts_on) >= current_date - 60 order by starts_on limit 100", [u.gym_id])).rows;
    const ent = cs.length ? (await q(`select k.*, u.name, u.belt, u.stripes from competitors k join users u on u.id=k.user_id where k.competition_id = any($1) order by u.name`, [cs.map((c) => c.id)])).rows : [];
    res.json({ competitions: cs.map((c) => {
      const mine = ent.find((e) => e.competition_id === c.id && String(e.user_id) === String(u.id));
      const people = ent.filter((e) => e.competition_id === c.id && (coach || e.status === "entered"));
      return { ...compOut(c), entered: ent.filter((e) => e.competition_id === c.id && e.status === "entered").length, requested: ent.filter((e) => e.competition_id === c.id && e.status === "requested").length,
        mine: mine ? { status: mine.status, division: mine.division, weight: mine.weight, note: mine.note, coachNote: mine.coach_note, result: mine.result } : null,
        team: people.map((e) => ({ id: String(e.user_id), name: coach ? e.name : shortName(e.name), belt: e.belt, stripes: e.stripes, status: e.status, division: e.division, weight: e.weight, result: e.result, me: String(e.user_id) === String(u.id),
          ...(coach ? { note: e.note, coachNote: e.coach_note, paid: e.paid } : {}) })) };
    }) });
  }));
  api.post("/coach/competitions/import", wrap(async (req, res) => {
    const u = needCoach(req);
    if (limited("cimp:" + u.gym_id, 30, 60 * 60e3)) fail(429, "That's a lot of imports. Try again in an hour.");
    try { res.json(await importer.importEvent(clean(req.body?.url, 500), { log: (m) => console.warn(m) })); }
    catch (e) { if (e instanceof importer.ImportError) fail(400, e.message); throw e; }
  }));
  api.post("/coach/competitions", wrap(async (req, res) => {
    const u = needCoach(req), c = readComp(req.body || {});
    const r = await q(`insert into competitions(gym_id,name,starts_on,ends_on,venue,city,organiser,url,register_by,fee,style,divisions,details,created_by)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`, [u.gym_id, c.name, c.startsOn, c.endsOn, c.venue, c.city, c.organiser, c.url, c.registerBy, c.fee, c.style, JSON.stringify(c.divisions), c.details, u.id]);
    res.status(201).json({ competition: compOut(r.rows[0]) });
  }));
  api.put("/coach/competitions/:id", wrap(async (req, res) => {
    const u = needCoach(req), cur = await ownComp(u, req.params.id), c = readComp(req.body || {});
    const r = await q(`update competitions set name=$1,starts_on=$2,ends_on=$3,venue=$4,city=$5,organiser=$6,url=$7,register_by=$8,fee=$9,style=$10,divisions=$11,details=$12 where id=$13 returning *`,
      [c.name, c.startsOn, c.endsOn, c.venue, c.city, c.organiser, c.url, c.registerBy, c.fee, c.style, JSON.stringify(c.divisions), c.details, cur.id]);
    res.json({ competition: compOut(r.rows[0]) });
  }));
  api.delete("/coach/competitions/:id", wrap(async (req, res) => {
    const u = needCoach(req), c = await ownComp(u, req.params.id);
    await q("delete from competitions where id=$1", [c.id]); res.json({ ok: true });
  }));
  // Coach adds, approves, declines or updates a competitor.
  api.put("/coach/competitions/:id/competitors/:userId", wrap(async (req, res) => {
    const u = needCoach(req), c = await ownComp(u, req.params.id), st = await ownStudent(u, req.params.userId), b = req.body || {};
    const cur = (await q("select * from competitors where competition_id=$1 and user_id=$2", [c.id, st.id])).rows[0];
    const status = b.status !== undefined ? (COMP_STATUS.includes(b.status) ? b.status : fail(400, "Bad status.")) : cur ? cur.status : "entered";
    const v = (k, col, max) => (b[k] !== undefined ? clean(b[k], max) : cur ? cur[col] : "");
    const result = b.result !== undefined ? (RESULTS.includes(b.result) ? b.result : fail(400, "Bad result.")) : cur ? cur.result : "";
    await q(`insert into competitors(competition_id,user_id,status,division,weight,coach_note,paid,result) values($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict(competition_id,user_id) do update set status=excluded.status, division=excluded.division, weight=excluded.weight, coach_note=excluded.coach_note, paid=excluded.paid, result=excluded.result, updated_at=now()`,
      [c.id, st.id, status, v("division", "division", 80), v("weight", "weight", 30), v("coachNote", "coach_note", 500), b.paid !== undefined ? !!b.paid : cur ? cur.paid : false, result]);
    const decided = (!cur || cur.status !== status) && (status === "entered" || (status === "declined" && cur && cur.status === "requested"));
    if (decided && b.notify !== false) mail.sendLater({ to: st.email, ...mail.templates.compDecision(st.name, c.name, compWhen(c), status === "entered", v("coachNote", "coach_note", 500)) });
    res.json({ ok: true, status });
  }));
  api.delete("/coach/competitions/:id/competitors/:userId", wrap(async (req, res) => {
    const u = needCoach(req), c = await ownComp(u, req.params.id);
    await q("delete from competitors where competition_id=$1 and user_id=$2", [c.id, intOr(req.params.userId, 0)]); res.json({ ok: true });
  }));
  // Students ask to compete (or withdraw).
  api.post("/competitions/:id/request", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) fail(403, "Join a gym first.");
    const c = (await q("select * from competitions where id=$1 and gym_id=$2", [intOr(req.params.id, 0), u.gym_id])).rows[0];
    if (!c) fail(404, "That competition doesn't exist.");
    if (dateOut(c.ends_on || c.starts_on) < new Date().toISOString().slice(0, 10)) fail(400, "That competition is over.");
    const cur = (await q("select status from competitors where competition_id=$1 and user_id=$2", [c.id, u.id])).rows[0];
    if (cur && cur.status === "entered") fail(409, "You're already on the team for this one.");
    if (cur && cur.status === "declined") fail(409, "Your coach has decided on this one. Talk to them if things have changed.");
    const b = req.body || {};
    await q(`insert into competitors(competition_id,user_id,status,division,weight,note) values($1,$2,'requested',$3,$4,$5)
      on conflict(competition_id,user_id) do update set status='requested', division=excluded.division, weight=excluded.weight, note=excluded.note, updated_at=now()`,
      [c.id, u.id, clean(b.division, 80), clean(b.weight, 30), clean(b.note, 500)]);
    if (!cur || cur.status !== "requested") {
      const coaches = (await q("select name, email from users where gym_id=$1 and role='coach' and active", [u.gym_id])).rows;
      for (const k of coaches) mail.sendLater({ to: k.email, replyTo: u.email, ...mail.templates.compRequest(k.name, u.name, c.name, compWhen(c), clean(b.division, 80)) });
    }
    res.json({ ok: true, status: "requested" });
  }));
  api.delete("/competitions/:id/request", wrap(async (req, res) => {
    const u = needUser(req);
    const r = await q(`update competitors k set status='withdrawn', updated_at=now() from competitions c where c.id=k.competition_id and c.gym_id=$3 and k.competition_id=$1 and k.user_id=$2 returning k.status`, [intOr(req.params.id, 0), u.id, u.gym_id]);
    if (!r.rows[0]) fail(404, "You haven't asked to enter that one.");
    res.json({ ok: true, status: "withdrawn" });
  }));

  // ---------- coach: email students ----------
  api.post("/coach/message", wrap(async (req, res) => {
    const u = needCoach(req), b = req.body || {};
    if (!mail.mailOn()) fail(503, "Email isn't switched on yet.");
    const subject = clean(b.subject, 140), text = String(b.text || "").trim().slice(0, 4000);
    if (!subject || !text) fail(400, "Write a subject and a message.");
    const ids = (Array.isArray(b.userIds) ? b.userIds : []).map((x) => intOr(x, 0)).filter(Boolean).slice(0, 200);
    const to = (await q("select id, name, email from users where id = any($1) and gym_id=$2", [ids, u.gym_id])).rows;
    if (!to.length) fail(400, "Pick who to send it to.");
    let sent = 0; const failed = [];
    for (const p of to) {
      if (limited("msg:" + u.gym_id, 300, 24 * 3600e3)) { failed.push(p.name); continue; }
      try { await mail.send({ to: p.email, replyTo: u.email, ...mail.templates.message(p.name, u.name, u.gym_name, subject, text) }); sent++; }
      catch (e) { console.warn("mail:", e.message); failed.push(p.name); }
    }
    res.json({ sent, failed });
  }));

  api.patch("/coach/gym", wrap(async (req, res) => {
    const u = needCoach(req), b = req.body || {};
    const name = b.name !== undefined ? clean(b.name, 100) : u.gym_name;
    if (!name) fail(400, "Enter your gym's name.");
    const fee = b.monthlyFeeCents !== undefined ? Math.max(0, intOr(b.monthlyFeeCents, 0)) : u.gym_fee;
    const show = b.showAttendees !== undefined ? !!b.showAttendees : u.show_attendees !== false;
    const invite = b.studentsInvite !== undefined ? !!b.studentsInvite : u.students_invite !== false;
    const tz = b.timezone !== undefined ? await validTz(b.timezone) || tzOf(u) : tzOf(u);
    await q("update gyms set name=$1, monthly_fee_cents=$2, show_attendees=$3, timezone=$4, students_invite=$5 where id=$6", [name, fee, show, tz, invite, u.gym_id]);
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
      await q(`insert into classes(${CLASS_COLS}) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, classVals(u, c));
      added++;
    }
    res.status(201).json({ added, skipped });
  }));

  // ---------- coach: payments ----------
  const METHODS = ["eft", "cash", "card", "snapscan", "payfast", "other"];
  const PAY_STATUS = ["pending", "confirmed", "rejected"];
  function payOut(p) {
    const a = p.ai || {};
    return { id: String(p.id), userId: p.user_id ? String(p.user_id) : null, amountCents: p.amount_cents, currency: p.currency, paidOn: p.paid_on,
      reference: p.reference, note: p.note, source: p.source, emailFrom: p.email_from, emailSubject: p.email_subject, createdAt: p.created_at,
      method: p.method || "", status: p.status || "confirmed", hasProof: !!p.has_proof,
      read: p.ai ? { amountCents: a.amountCents || 0, date: a.date || "", reference: a.reference || "", payer: a.payer || "", bank: a.bank || "", match: a.match || "", isPayment: a.method === "claude" ? a.isPayment !== false : true, duplicateOf: a.duplicateOf || null, reading: !!a.reading, error: a.error ? "Couldn't read it automatically." : "" } : null };
  }
  const PAY_COLS = "p.*, exists(select 1 from pop_files f where f.payment_id=p.id) as has_proof";
  const todayIn = async (u) => (await q("select to_char(now() at time zone $1,'YYYY-MM-DD') as d", [tzOf(u)])).rows[0].d;
  async function payRef(userId) {
    const cur = (await q("select pay_ref from users where id=$1", [userId])).rows[0];
    if (cur && cur.pay_ref) return cur.pay_ref;
    for (let i = 0; i < 8; i++) {
      const ref = "JF" + Array.from(crypto.randomBytes(5), (b) => pop.REF_ALPHABET[b % 32]).join("");
      try { const r = await q("update users set pay_ref=$1 where id=$2 and pay_ref is null returning pay_ref", [ref, userId]); if (r.rows[0]) return ref; return (await q("select pay_ref from users where id=$1", [userId])).rows[0].pay_ref; }
      catch (e) { if (e.code !== "23505") throw e; }
    }
    fail(500, "Couldn't make a payment reference. Try again.");
  }
  // A proof file from the browser: base64, at most 8 MB, and really a PDF or an image Claude can read.
  function proofFile(b) {
    const data = Buffer.from(String(b.data || ""), "base64");
    if (!data.length) fail(400, "Choose the proof of payment (a PDF or a screenshot).");
    if (data.length > 8 * 1024 * 1024) fail(413, "That file is over 8 MB. Send a screenshot of the payment instead.");
    const type = pop.sniff(data);
    if (type === "image/heic") fail(400, "That photo is in HEIC format. Take a screenshot of the payment and send that instead.");
    if (!type) fail(400, "Send a PDF or an image (a screenshot is fine).");
    return { name: clean(b.name, 120) || (type === "application/pdf" ? "proof.pdf" : "proof"), type, data };
  }
  const gymStudents = async (gymId) => (await q("select id, name, pay_ref from users where gym_id=$1 and role='student'", [gymId])).rows;
  // Store a proof as a payment waiting for the coach. Flags a likely duplicate (same amount, date and student or reference).
  async function addProof({ u, gymId, userId, read, source, files, text, from, subject, note, method }) {
    let match = { userId: userId || null, how: userId ? "student" : "" };
    if (!userId && read) match = pop.matchStudent(read, text || "", await gymStudents(gymId));
    const amount = (read && read.amountCents) || 0, paidOn = (read && read.date) || (await todayIn(u || { timezone: null }));
    const reference = clean((read && read.reference) || "", 140);
    const dup = amount ? (await q(`select id from payments where gym_id=$1 and amount_cents=$2 and paid_on=$3 and status<>'rejected' and (($4::bigint is not null and user_id=$4) or ($5<>'' and reference=$5)) limit 1`,
      [gymId, amount, paidOn, match.userId, reference])).rows[0] : null;
    const ai = read ? { ...read, match: match.how, duplicateOf: dup ? String(dup.id) : null } : null;
    const r = await q(`insert into payments(gym_id,user_id,amount_cents,currency,paid_on,reference,note,source,email_from,email_subject,status,method,ai,submitted_by)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13) returning id`,
      [gymId, match.userId, amount, (u && u.currency) || "ZAR", paidOn, reference, clean(note, 500), source, from ? clean(from, 200) : null, subject ? clean(subject, 200) : null, method || "eft", ai, u ? u.id : null]);
    for (const f of files || []) await q("insert into pop_files(payment_id,name,type,data) values($1,$2,$3,$4)", [r.rows[0].id, f.name, f.type, f.data]);
    return (await q(`select ${PAY_COLS} from payments p where p.id=$1`, [r.rows[0].id])).rows[0];
  }
  const aiClient = () => importer.getClient ? importer.getClient() : null;

  // ---------- how students pay ----------
  const PAY_FIELDS = { holder: 80, bank: 60, account: 30, branch: 20, type: 30, link: 400, note: 300 };
  function readPaySettings(b) {
    const out = {}; for (const [k, n] of Object.entries(PAY_FIELDS)) out[k] = clean(b[k], n);
    if (out.link && !/^https:\/\//i.test(out.link)) fail(400, "The payment link must start with https://");
    out.account = out.account.replace(/[^\d ]/g, ""); out.branch = out.branch.replace(/[^\d ]/g, "");
    return out;
  }
  const popAddress = (tok) => `pop-${tok}@${process.env.POP_DOMAIN || "jitsflow.com"}`;
  api.get("/coach/gym/pay", wrap(async (req, res) => {
    const u = needCoach(req), g = (await q("select pay, pop_token, pop_notice from gyms where id=$1", [u.gym_id])).rows[0];
    let tok = g.pop_token;
    if (!tok) { tok = Array.from(crypto.randomBytes(10), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join(""); await q("update gyms set pop_token=$1 where id=$2 and pop_token is null", [tok, u.gym_id]); tok = (await q("select pop_token from gyms where id=$1", [u.gym_id])).rows[0].pop_token; }
    res.json({ pay: g.pay || {}, popAddress: popAddress(tok), popReady: !!process.env.INBOUND_SECRET, popNotice: g.pop_notice || null });
  }));
  api.patch("/coach/gym/pay", wrap(async (req, res) => {
    const u = needCoach(req), pay = readPaySettings(req.body || {});
    await q("update gyms set pay=$1 where id=$2", [pay, u.gym_id]);
    res.json({ pay });
  }));
  // A new forwarding address (the old one stops working), e.g. if it leaked.
  api.post("/coach/gym/pay/new-address", wrap(async (req, res) => {
    const u = needCoach(req), tok = Array.from(crypto.randomBytes(10), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
    await q("update gyms set pop_token=$1, pop_notice=null where id=$2", [tok, u.gym_id]);
    res.json({ popAddress: popAddress(tok) });
  }));

  // ---------- students: what's due, where to pay, send proof ----------
  async function feeFor(u) {
    const plan = u.plan_id ? (await q("select * from plans where id=$1", [u.plan_id])).rows[0] : null;
    return u.monthly_fee_cents ?? (plan ? monthly(plan) : null) ?? u.gym_fee ?? 0;
  }
  api.get("/me/pay", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id || u.role !== "student") return res.json({ pay: null });
    const g = (await q("select pay from gyms where id=$1", [u.gym_id])).rows[0];
    const sums = (await q(`select coalesce(sum(amount_cents) filter (where status='confirmed'),0) as paid, coalesce(sum(amount_cents) filter (where status='pending'),0) as pending
      from payments where user_id=$1 and gym_id=$2 and paid_on >= date_trunc('month', now() at time zone $3)`, [u.id, u.gym_id, tzOf(u)])).rows[0];
    const recent = (await q(`select ${PAY_COLS} from payments p where p.user_id=$1 and p.gym_id=$2 and p.paid_on > current_date - 200 order by p.paid_on desc, p.id desc limit 12`, [u.id, u.gym_id])).rows;
    res.json({ pay: { dueCents: (await feeFor(u)) || 0, paidCents: Number(sums.paid), pendingCents: Number(sums.pending), currency: u.currency || "ZAR",
      reference: await payRef(u.id), bank: g.pay || {}, payments: recent.map((p) => { const o = payOut(p); delete o.read; delete o.emailFrom; delete o.emailSubject; return o; }) } });
  }));
  api.post("/me/pay/proof", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id || u.role !== "student") fail(403, "Join a gym first.");
    if (limited("pop-u:" + u.id, 20, 24 * 3600e3)) fail(429, "That's a lot of uploads today. Ask your coach if something's wrong.");
    const b = req.body || {}, file = proofFile(b);
    const typed = intOr(b.amountCents, 0), on = isDay(b.paidOn) ? b.paidOn : "";
    const row = await addProof({ u, gymId: u.gym_id, userId: u.id, read: { amountCents: typed > 0 && typed < 1e8 ? typed : 0, date: on, reference: await payRef(u.id), reading: true }, source: "student", files: [file], note: b.note, method: "eft" });
    res.status(201).json({ payment: payOut(row) });
    // Read it in the background: the student doesn't need to wait, the coach sees what it says.
    const c = aiClient();
    setImmediate(async () => {
      try {
        const read = await pop.readPop({ client: c, files: [file] });
        const amount = row.amount_cents || read.amountCents || 0, mismatch = row.amount_cents && read.amountCents && read.amountCents !== row.amount_cents;
        const otherRef = pop.refsIn(read.reference).find((r) => r !== (u.pay_ref || "")) || null;
        await q("update payments set ai=$1, amount_cents=$2, paid_on=coalesce($3::date, paid_on) where id=$4 and status='pending'",
          [{ ...read, match: "student", typedCents: row.amount_cents || 0, amountMismatch: !!mismatch, otherRef }, amount, on ? null : (read.date || null), row.id]);
      } catch (e) { console.error("pop read:", e.message); await q("update payments set ai = coalesce(ai,'{}'::jsonb) - 'reading' || '{\"error\":\"read failed\"}' where id=$1", [row.id]).catch(() => {}); }
    });
  }));
  // The proof file itself: for the gym's coaches and the student who sent it.
  api.get("/payments/:id/proof", wrap(async (req, res) => {
    const u = needUser(req), p = (await q("select * from payments where id=$1", [intOr(req.params.id, 0)])).rows[0];
    if (!p || !(u.gym_id === p.gym_id && (u.role === "coach" || u.id === p.user_id))) fail(404, "Not found.");
    const f = (await q("select * from pop_files where payment_id=$1 order by id limit 1", [p.id])).rows[0]; if (!f) fail(404, "No proof attached.");
    res.set({ "Content-Type": f.type, "Content-Disposition": `inline; filename="${f.name.replace(/[^\w.\- ]/g, "_")}"`, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'", "Cache-Control": "private, no-store" });
    res.send(f.data);
  }));

  // ---------- coach: payments ----------
  api.get("/coach/payments", wrap(async (req, res) => {
    const u = needCoach(req);
    const r = await q(`select ${PAY_COLS} from payments p where p.gym_id=$1 and (p.status<>'rejected' or p.created_at > now() - interval '30 days') order by (p.status='pending') desc, p.paid_on desc, p.id desc limit 400`, [u.gym_id]);
    res.json({ payments: r.rows.map(payOut) });
  }));
  api.post("/coach/payments", wrap(async (req, res) => {
    const u = needCoach(req), b = req.body || {};
    const amount = intOr(b.amountCents, NaN);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) fail(400, "Enter the amount paid.");
    const paidOn = isDay(b.paidOn) ? b.paidOn : fail(400, "Pick the date it was paid.");
    let userId = null;
    if (b.userId) userId = (await ownStudent(u, b.userId)).id;
    const method = METHODS.includes(b.method) ? b.method : "";
    const r = await q(`insert into payments(gym_id,user_id,amount_cents,currency,paid_on,reference,note,source,method,submitted_by) values($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9) returning id`,
      [u.gym_id, userId, amount, u.currency || "ZAR", paidOn, clean(b.reference, 140), clean(b.note, 500), method, u.id]);
    res.status(201).json({ payment: payOut((await q(`select ${PAY_COLS} from payments p where p.id=$1`, [r.rows[0].id])).rows[0]) });
  }));
  // Coach uploads a proof (e.g. a screenshot a student WhatsApped them): read it now so they can confirm straight away.
  api.post("/coach/payments/proof", wrap(async (req, res) => {
    const u = needCoach(req), file = proofFile(req.body || {});
    const read = await pop.readPop({ client: aiClient(), files: [file] });
    const row = await addProof({ u, gymId: u.gym_id, read, source: "upload", files: [file], method: "eft" });
    res.status(201).json({ payment: payOut(row) });
  }));
  // Edit, match, confirm or reject. Only the fields sent change.
  api.patch("/coach/payments/:id", wrap(async (req, res) => {
    const u = needCoach(req), b = req.body || {};
    const p = (await q("select * from payments where id=$1 and gym_id=$2", [intOr(req.params.id, 0), u.gym_id])).rows[0];
    if (!p) fail(404, "That payment doesn't exist.");
    const userId = b.userId === undefined ? p.user_id : b.userId ? (await ownStudent(u, b.userId)).id : null;
    const amount = b.amountCents === undefined ? p.amount_cents : intOr(b.amountCents, NaN);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100000000) fail(400, "Enter the amount paid.");
    const paidOn = b.paidOn === undefined ? p.paid_on : isDay(b.paidOn) ? b.paidOn : fail(400, "Pick the date it was paid.");
    const status = b.status === undefined ? p.status : PAY_STATUS.includes(b.status) ? b.status : fail(400, "Bad status.");
    const method = b.method === undefined ? p.method : METHODS.includes(b.method) ? b.method : "";
    if (status === "confirmed" && !(amount > 0)) fail(400, "Enter the amount before confirming.");
    if (status === "confirmed" && !userId) fail(400, "Pick the student this payment is from.");
    await q("update payments set user_id=$1, amount_cents=$2, paid_on=$3, status=$4, method=$5, reference=$6, note=$7 where id=$8",
      [userId, amount, paidOn, status, method, b.reference === undefined ? p.reference : clean(b.reference, 140), b.note === undefined ? p.note : clean(b.note, 500), p.id]);
    res.json({ payment: payOut((await q(`select ${PAY_COLS} from payments p where p.id=$1`, [p.id])).rows[0]) });
  }));
  api.delete("/coach/payments/:id", wrap(async (req, res) => {
    const u = needCoach(req);
    const r = await q("delete from payments where id=$1 and gym_id=$2", [intOr(req.params.id, 0), u.gym_id]);
    if (!r.rowCount) fail(404, "That payment doesn't exist.");
    res.json({ ok: true });
  }));

  // ---------- inbound proof-of-payment email (from the Cloudflare email worker) ----------
  // The worker posts the raw message with a shared secret. Each gym has its own address: pop-<token>@jitsflow.com.
  api.post("/inbound/pop", express.raw({ type: () => true, limit: "26mb" }), wrap(async (req, res) => {
    const secret = process.env.INBOUND_SECRET || "", got = String(req.headers["x-jf-inbound"] || "");
    if (!secret || got.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(secret))) fail(403, "Not allowed.");
    const to = String(req.headers["x-jf-to"] || "").toLowerCase(), tok = (to.match(/^pop-([a-z0-9]{6,32})@/) || [])[1];
    const g = tok && (await q("select g.id, g.currency, g.timezone from gyms g where g.pop_token=$1", [tok])).rows[0];
    if (!g) fail(404, "Unknown address.");
    if (limited("pop-g:" + g.id, 300, 24 * 3600e3)) fail(429, "Too many emails today.");
    const { simpleParser } = require("mailparser");
    const parsed = await simpleParser(Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || "")));
    const notice = pop.gmailConfirm(parsed);
    if (notice) { await q("update gyms set pop_notice=$1 where id=$2", [notice, g.id]); return res.json({ ok: true, gmailConfirm: true }); }
    const files = (parsed.attachments || []).map((a) => ({ name: clean(a.filename, 120) || "attachment", data: a.content, type: pop.sniff(a.content) }))
      .filter((f) => f.type && f.type !== "image/heic" && f.data.length <= 8 * 1024 * 1024 && f.data.length > 2048).slice(0, 3);
    const text = `From: ${(parsed.from && parsed.from.text) || ""}\nSubject: ${parsed.subject || ""}\n\n${(parsed.text || "").slice(0, 20000)}`;
    const read = await pop.readPop({ client: aiClient(), text, files });
    if (!read.isPayment && !files.length) return res.json({ ok: true, skipped: "not a payment" });
    const row = await addProof({ u: { id: null, currency: g.currency, timezone: g.timezone }, gymId: g.id, read, source: "email", files, text,
      from: (parsed.from && parsed.from.text) || String(req.headers["x-jf-from"] || ""), subject: parsed.subject || "", method: "eft" });
    res.status(201).json({ ok: true, id: String(row.id) });
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
