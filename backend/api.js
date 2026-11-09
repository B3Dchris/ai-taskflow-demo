// JitsFlow API: accounts, synced progress, classes and attendance, coach roster and payments.
"use strict";
const express = require("express");
const crypto = require("crypto");
const net = require("net");
const bcrypt = require("bcryptjs");
const importer = require("./importer");
const mail = require("./mail");
const pop = require("./pop");
const ai = require("./ai");
const assistant = require("./assistant");
const people = require("./people");
const payfast = require("./payfast");
const { LONGEST } = require("./db");

const COOKIE = "jf_s";
const SESSION_DAYS = 60;
const BELTS = ["white", "blue", "purple", "brown", "black"];

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const code = () => Array.from(crypto.randomBytes(8), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
// Phone numbers as typed, minus anything that isn't a digit, space, + or dash ("082 123 4567", "+27 82 123 4567").
const cleanPhone = (v) => { const s = String(v == null ? "" : v).replace(/[^\d+\- ]/g, "").trim().slice(0, 24); return s.replace(/\D/g, "").length >= 7 ? s : ""; };
const isEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(e);
const first = (n) => String(n || "").trim().split(/\s+/)[0] || "";
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
// Has this key already used up its allowance? (Doesn't count this call: pair with limited() to count only what should count.)
const over = (key, max) => { const h = hits.get(key); return !!h && h.reset >= Date.now() && h.n >= max; };

// Cloudflare's published ranges (cloudflare.com/ips). Only a request that reaches us from one of these can set cf-connecting-ip.
const CLOUDFLARE = new net.BlockList();
for (const c of ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"]) { const [a, n] = c.split("/"); CLOUDFLARE.addSubnet(a, Number(n), "ipv4"); }
for (const c of ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"]) { const [a, n] = c.split("/"); CLOUDFLARE.addSubnet(a, Number(n), "ipv6"); }
const plainIp = (ip) => String(ip || "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
const fromCloudflare = (ip) => { const t = net.isIP(ip); return t ? CLOUDFLARE.check(ip, t === 4 ? "ipv4" : "ipv6") : false; };
// The visitor's address. The hop in front of us (req.ip, with Express's trust proxy) is Cloudflare when traffic came through it;
// then cf-connecting-ip is the visitor. Anyone else (e.g. calling the Render address directly) could put anything in that header.
function clientIp(req) {
  const peer = plainIp(req.ip || req.socket.remoteAddress), cf = plainIp(String(req.headers["cf-connecting-ip"] || "").trim());
  return (cf && net.isIP(cf) && fromCloudflare(peer) ? cf : peer) || "?";
}

// Who's signed in, with their gym and its head coach (only while that coach is still an active coach there).
const ME_COLS = `u.*, g.name as gym_name, g.student_code, g.coach_code, g.monthly_fee_cents as gym_fee, g.currency, g.logo_v, g.timezone, g.show_attendees, g.students_invite, g.wa_phone, g.brand, g.setup,
  g.profile->'socials'->>'whatsapp' as gym_wa_link, g.profile->>'phone' as gym_phone, g.access_fee_cents, g.access_mode, g.private_plan_ids, g.private_price_cents as gym_private_cents, h.id as head_id, h.name as head_name`;
const ME_JOIN = "left join gyms g on g.id=u.gym_id left join users h on h.id=g.head_coach_id and h.gym_id=g.id and h.role='coach' and h.active";

function makeApi(pool, { secureCookies }) {
  const api = express.Router();
  const q = (text, params) => pool.query(text, params);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // Proof-of-payment uploads carry a file (base64), so they get a bigger allowance than everything else.
  const smallJson = express.json({ limit: "400kb" }), bigJson = express.json({ limit: "12mb" });
  api.use((req, res, next) => (/\/(proof|read-people)$/.test(req.path) ? bigJson : smallJson)(req, res, next));
  api.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    // Changes must come from our own pages: same-site cookie plus a custom header a form post can't send.
    // (PayFast's payment notifications come from PayFast's servers and are checked separately.)
    if (req.method !== "GET" && req.headers["x-jf"] !== "1" && req.path !== "/payfast/notify") return res.status(403).json({ error: "Request blocked." });
    next();
  });

  // Who is calling?
  api.use(wrap(async (req, res, next) => {
    const tok = cookies(req)[COOKIE];
    if (tok && tok.length === 64) {
      const r = await q(`select ${ME_COLS}
        from sessions s join users u on u.id=s.user_id ${ME_JOIN}
        where s.token_hash=$1 and s.expires_at>now()`, [sha(tok)]);
      if (r.rows[0]) {
        req.user = await withHead(r.rows[0]);
        if (!req.user.last_seen || Date.now() - new Date(req.user.last_seen) > 3600e3) q("update users set last_seen=now() where id=$1", [req.user.id]).catch(() => {});
      }
    }
    next();
  }));
  // Each gym has one head coach: the only coach who sees money and gets payment emails.
  const isHead = (u) => isCoach(u) && String(u.head_id) === String(u.id);
  const needHead = (req) => { const u = needCoach(req); if (!isHead(u)) fail(403, "Only the head coach can see and change fees and payments."); return u; };
  // A gym with no active head coach (the head was removed, or the gym is older than head coaches): the longest-standing active coach takes it.
  async function fixHead(gymId) {
    const r = await q(`update gyms set head_coach_id=${LONGEST("$1::bigint")} where id=$1 and ${LONGEST("$1::bigint")} is not null
      and not exists (select 1 from users h where h.id=gyms.head_coach_id and h.gym_id=gyms.id and h.role='coach' and h.active) returning head_coach_id`, [gymId]);
    return r.rows[0] ? r.rows[0].head_coach_id : null;
  }
  async function withHead(u) {
    if (u && u.gym_id && !u.head_id && u.role === "coach" && u.active !== false && (await fixHead(u.gym_id))) return (await q(`select ${ME_COLS} from users u ${ME_JOIN} where u.id=$1`, [u.id])).rows[0];
    return u;
  }
  // The gym's head coach, for payment emails.
  async function headCoach(gymId) {
    const sql = "select h.id, h.name, h.email from gyms g join users h on h.id=g.head_coach_id and h.gym_id=g.id and h.role='coach' and h.active where g.id=$1";
    return (await q(sql, [gymId])).rows[0] || ((await fixHead(gymId)) ? (await q(sql, [gymId])).rows[0] : null);
  }
  const needUser = (req) => { if (!req.user) fail(401, "Sign in to continue."); return req.user; };
  // A coach the gym has marked inactive (or removed) has no coach access.
  const isCoach = (u) => !!u && u.role === "coach" && !!u.gym_id && u.active !== false;
  const needCoach = (req) => { const u = needUser(req); if (!isCoach(u)) fail(403, "Only coaches can do that."); return u; };

  async function validTz(tz) { tz = clean(tz, 64); if (!tz) return null; try { await q("select now() at time zone $1", [tz]); return tz; } catch (e) { return null; } }
  async function startSession(res, userId) {
    const tok = crypto.randomBytes(32).toString("hex");
    await q("insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+($3||' days')::interval)", [sha(tok), userId, String(SESSION_DAYS)]);
    res.cookie(COOKIE, tok, { httpOnly: true, secure: secureCookies, sameSite: "lax", maxAge: SESSION_DAYS * 864e5, path: "/" });
  }
  function me(u) {
    const out = { id: String(u.id), name: u.name, email: u.email, role: u.role === "coach" && !isCoach(u) ? "student" : u.role, belt: u.belt, stripes: u.stripes, phone: u.phone || "" };
    if (u.gym_id) out.gym = { id: String(u.gym_id), name: u.gym_name, currency: u.currency, logo: u.logo_v ? `/api/gyms/${u.gym_id}/logo?v=${u.logo_v}` : null };
    if (u.gym_id) Object.assign(out.gym, { timezone: u.timezone || "Africa/Johannesburg", showAttendees: u.show_attendees !== false, studentsInvite: u.students_invite !== false });
    // Students may share the student invite code (to bring friends) when the gym allows it. They never see the coach code.
    if (u.gym_id && u.role === "student" && u.students_invite !== false) out.gym.inviteCode = u.student_code;
    // Where lesson requests go on WhatsApp: the number the coach set, else the gym's WhatsApp link or a mobile number from its website.
    if (u.gym_id) { const link = (String(u.gym_wa_link || "").match(/(?:wa\.me\/|phone=)\+?(\d{8,15})/) || [])[1] || "";
      const site = /^(\+?27|0)[6-8]\d/.test(String(u.gym_phone || "").replace(/[\s()-]/g, "")) ? u.gym_phone : "";
      out.gym.waPhone = u.wa_phone || (link ? "+" + link : "") || site || ""; if (isCoach(u)) out.gym.waPhoneSet = u.wa_phone || ""; }
    if (u.gym_id) { const b = u.brand || {}; out.gym.brand = /^#[0-9a-f]{6}$/i.test(b.accent || "") ? { accent: b.accent } : {}; if (isCoach(u)) out.gym.setup = u.setup || {}; }
    if (isCoach(u)) Object.assign(out.gym, { studentCode: u.student_code, coachCode: u.coach_code, head: isHead(u), headCoach: u.head_id ? { id: String(u.head_id), name: u.head_name } : null });
    if (isHead(u)) out.gym.monthlyFeeCents = u.gym_fee;
    return out;
  }
  // Sign-ups and reset emails: every attempt counts, per address and per email.
  function checkSignIn(req, email) {
    if (limited("ip:" + clientIp(req), 30, 15 * 60e3) || limited("su:" + email, 10, 15 * 60e3)) fail(429, "Too many attempts. Wait 15 minutes and try again.");
  }
  // Sign-in: only wrong passwords count. Per email they count per address, so someone else guessing can't lock the owner out;
  // a much higher ceiling per email still stops guessing spread over many addresses.
  function checkLogin(req, email) {
    const ip = clientIp(req), keys = [["ip:" + ip, 30], ["em:" + email + "|" + ip, 10], ["em:" + email, 100]];
    if (keys.some(([k, max]) => over(k, max))) fail(429, "Too many attempts. Wait 15 minutes and try again.");
    return () => keys.forEach(([k]) => limited(k, Infinity, 15 * 60e3));
  }
  async function newUser({ name, email, password, role, gymId, phone }) {
    name = clean(name, 80); email = clean(email, 254).toLowerCase(); password = String(password || "");
    if (!name) fail(400, "Enter your name.");
    if (!isEmail(email)) fail(400, "Enter a valid email address.");
    if (password.length < 8) fail(400, "Use a password of at least 8 characters.");
    if (password.length > 200) fail(400, "That password is too long.");
    const hash = await bcrypt.hash(password, 11);
    // A coach added this person with this email before they had the app. Typing the email doesn't prove it's theirs,
    // so that record is only taken over through the coach's invite link (claim) or a password reset email.
    if ((await q("select 1 from users where email=$1 and pass_hash is null", [email])).rows[0]) fail(409, "Your coach already added you with this email. Ask them for your invite link and sign up from that.");
    try {
      const r = await q("insert into users(gym_id,role,name,email,pass_hash,phone) values($1,$2,$3,$4,$5,$6) returning id", [gymId, role, name, email, hash, cleanPhone(phone)]);
      return r.rows[0].id;
    } catch (e) {
      if (e.code === "23505") fail(409, "An account with that email already exists. Sign in instead.");
      throw e;
    }
  }
  // Students the coach added who aren't on the app, matching a name or phone number someone typed.
  const phoneKey = (v) => String(v || "").replace(/\D/g, "").slice(-9);
  const nameKey = (v) => clean(v, 80).toLowerCase().replace(/\s+/g, " ");
  async function offlineMatch(gymId, name, phone) {
    const n = nameKey(name), d = phoneKey(phone);
    const rows = (await q("select id, name, phone, parent_name from users where gym_id=$1 and role='student' and pass_hash is null", [gymId])).rows;
    const all = rows.filter((x) => (n && nameKey(x.name) === n) || (d.length >= 7 && phoneKey(x.phone) === d)), byName = all.filter((x) => n && nameKey(x.name) === n);
    return { all, one: byName.length === 1 ? byName[0] : all.length === 1 ? all[0] : null };
  }
  const loadMe = async (id) => withHead((await q(`select ${ME_COLS} from users u ${ME_JOIN} where u.id=$1`, [id])).rows[0]);

  // ---------- accounts ----------
  api.post("/auth/start-gym", wrap(async (req, res) => {
    const b = req.body || {};
    checkSignIn(req, clean(b.email, 254).toLowerCase());
    const gymName = clean(b.gym, 100);
    if (!gymName) fail(400, "Enter your gym's name.");
    const perIp = "gym:" + clientIp(req); // new gyms per address per day (each one sends a welcome email)
    if (over(perIp, 10)) fail(429, "That's a lot of new gyms today. Try again tomorrow, or email hello@jitsflow.com.");
    const g = await q("insert into gyms(name,student_code,coach_code,timezone) values($1,$2,$3,$4) returning id", [gymName, code(), code(), (await validTz(b.timezone)) || "Africa/Johannesburg"]);
    let id;
    try { id = await newUser({ ...b, role: "coach", gymId: g.rows[0].id }); }
    catch (e) { await q("delete from gyms where id=$1", [g.rows[0].id]); throw e; }
    await q("update gyms set head_coach_id=$1 where id=$2", [id, g.rows[0].id]);
    limited(perIp, Infinity, 24 * 3600e3);
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
    let id;
    const email = clean(b.email, 254).toLowerCase(), password = String(b.password || "");
    const checkNew = async (preId) => {
      if (!clean(b.name, 80)) fail(400, "Enter your name.");
      if (!isEmail(email)) fail(400, "Enter a valid email address.");
      if (password.length < 8) fail(400, "Use a password of at least 8 characters.");
      if (password.length > 200) fail(400, "That password is too long.");
      const taken = (await q("select id from users where email=$1 and id<>$2", [email, preId])).rows[0];
      if (taken) fail(409, "An account with that email already exists. Sign in instead.");
    };
    const claim = clean(b.claim, 40);
    let pre = claim ? (await q("select id, gym_id from users where claim_token=$1 and pass_hash is null", [claim])).rows[0] : null;
    if (pre && !(role === "student" && (!gymId || pre.gym_id === gymId))) pre = null;
    // Signed up with the gym's code: the coach may have added them already. Offer that record ("Are you Sipho?") when
    // their name or phone number matches it, and link to it only if they say yes. An email alone never links.
    if (!pre && gymId && role === "student" && b.link !== "no") {
      const { one, all } = await offlineMatch(gymId, b.name, b.phone);
      if (b.link) { pre = all.find((x) => String(x.id) === String(b.link)); if (!pre) fail(409, "We couldn't link you to that student. Ask your coach for your invite link."); }
      else if (one) { await checkNew(one.id); return res.json({ ask: { id: String(one.id), name: one.name, kid: !!one.parent_name } }); }
    }
    if (pre) {
      await checkNew(pre.id);
      await q("update users set name=$1, email=$2, pass_hash=$3, offline=false, claim_token=null, phone=case when phone='' then $5 else phone end where id=$4", [clean(b.name, 80), email, await bcrypt.hash(password, 11), pre.id, cleanPhone(b.phone)]);
      id = pre.id;
    } else id = await newUser({ ...b, role, gymId });
    await startSession(res, id);
    const m = await loadMe(id);
    if (m.role === "student") mail.sendLater({ to: m.email, ...mail.templates.welcomeStudent(m.name, m.gym_name) });
    res.status(201).json({ me: me(m) });
  }));

  api.post("/auth/login", wrap(async (req, res) => {
    const email = clean(req.body?.email, 254).toLowerCase();
    const failed = checkLogin(req, email);
    const r = await q("select id, pass_hash from users where email=$1", [email]);
    const ok = r.rows[0] && r.rows[0].pass_hash && (await bcrypt.compare(String(req.body?.password || ""), r.rows[0].pass_hash));
    if (!ok) { failed(); fail(401, "That email and password don't match."); }
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
    await q("update users set pass_hash=$1, offline=false, claim_token=null where id=$2", [await bcrypt.hash(password, 11), uid]);
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
    if (!(String(u.gym_id) === String(g.rows[0].id) && g.rows[0].coach)) await handOverFirst(u);
    if (String(u.gym_id) !== String(g.rows[0].id)) await leaveGym(u, g.rows[0].id, g.rows[0].coach ? "coach" : "student");
    else await q("update users set role=$1 where id=$2", [g.rows[0].coach ? "coach" : "student", u.id]);
    res.json({ me: me(await loadMe(u.id)) });
  }));
  // A student leaves their gym but keeps their account (technique library, training log).
  // The head coach can't walk away while other coaches are there: they hand the role over first.
  async function handOverFirst(u) {
    if (isHead(u) && (await q("select 1 from users where gym_id=$1 and id<>$2 and role='coach' and active and pass_hash is not null limit 1", [u.gym_id, u.id])).rows.length)
      fail(400, `You're the head coach of ${u.gym_name}. Hand that role to another coach first, in the Gym tab.`);
  }
  api.post("/me/leave", wrap(async (req, res) => {
    const u = needUser(req);
    if (!u.gym_id) fail(400, "You're not in a gym.");
    if (isCoach(u)) fail(400, `Coaches can't leave this way. Ask another coach to remove you${isHead(u) ? ", or delete the gym in the Gym tab" : ""}.`);
    await leaveGym(u);
    res.json({ me: me(await loadMe(u.id)) });
  }));

  api.delete("/me", wrap(async (req, res) => {
    const u = needUser(req);
    if (!u.pass_hash || !(await bcrypt.compare(String(req.body?.password || ""), u.pass_hash))) fail(401, "That password isn't right.");
    // The last coach can't walk away from a gym people still use: the gym would be left with nobody in charge of its data.
    if (isCoach(u) && (await q("select 1 from users where gym_id=$1 and id<>$2 and pass_hash is not null limit 1", [u.gym_id, u.id])).rows.length
      && !(await q("select 1 from users where gym_id=$1 and id<>$2 and role='coach' and active and pass_hash is not null limit 1", [u.gym_id, u.id])).rows.length)
      fail(400, `You're the only coach at ${u.gym_name}, and your students still use it. To close the gym, delete it first in the Gym tab. To hand it over, add another coach.`);
    await handOverFirst(u);
    if (u.gym_id) await releaseBookings(u.id, u.gym_id, u);
    await q("delete from users where id=$1", [u.id]);
    // A gym with nobody left in it goes too (its classes, plans and payments with it).
    // Offline students (no login) don't keep a gym alive: with nobody left who can sign in, they go too.
    if (u.gym_id && !(await q("select 1 from users where gym_id=$1 and pass_hash is not null limit 1", [u.gym_id])).rows.length) {
      await q("delete from users where gym_id=$1 and pass_hash is null", [u.gym_id]);
      await q("delete from gyms g where g.id=$1 and not exists (select 1 from users x where x.gym_id=g.id)", [u.gym_id]);
    }
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
  // Classes this student booked or was checked into that have finished: the training log fills itself in from these.
  api.get("/me/attended", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) return res.json({ classes: [] });
    const days = Math.min(90, Math.max(1, intOr(req.query.days, 45)));
    const r = await q(`select c.*, a.attended from attendance a join classes c on c.id=a.class_id
      where a.user_id=$1 and c.gym_id=$2 and (a.going or a.attended) and not coalesce(a.waitlisted,false)
        and c.starts_at > now() - ($3 || ' days')::interval and c.starts_at + (c.duration_min || ' minutes')::interval < now()
      order by c.starts_at desc limit 200`, [u.id, u.gym_id, String(days)]);
    res.json({ classes: r.rows.map((c) => { const p = c.shared !== false && c.plan ? c.plan : {};
      return { id: String(c.id), title: c.title, startsAt: c.starts_at, durationMin: c.duration_min, kind: c.kind, coach: c.coach || "", checkedIn: !!c.attended,
        focus: p.focus || "", ids: Array.isArray(p.ids) ? p.ids.slice(0, 30) : [] }; }) });
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
    kind: c.kind || "class", capacity: c.capacity ?? null, priceCents: c.price_cents ?? null, coach: c.coach || "", level: c.level || "", discipline: c.discipline || "",
    plan: coach || c.shared ? c.plan : null, going: Number(c.going || 0), waiting: Number(c.waiting || 0),
    myGoing: !!c.my_going, myWaitlisted: !!c.my_waitlisted, myAttended: !!c.my_attended, myPosition: c.my_position ? Number(c.my_position) : null });

  api.get("/classes", wrap(async (req, res) => {
    const u = needUser(req);
    if (!u.gym_id) return res.json({ classes: [] });
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 864e5);
    const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 60 * 864e5);
    if (isNaN(from) || isNaN(to)) fail(400, "Bad date range.");
    const coach = isCoach(u);
    const r = await q(`select c.*, (select count(*) from attendance a where a.class_id=c.id and a.going) as going,
        (select count(*) from attendance a where a.class_id=c.id and a.waitlisted) as waiting,
        m.going as my_going, m.waitlisted as my_waitlisted, m.attended as my_attended,
        case when m.waitlisted then (select count(*) from attendance w where w.class_id=c.id and w.waitlisted and w.booked_at <= m.booked_at) end as my_position
      from classes c left join attendance m on m.class_id=c.id and m.user_id=$2
      where c.gym_id=$1 and c.starts_at between $3 and $4
        and ($5 or c.kind <> 'private' or coalesce(m.going,false) or (select count(*) from attendance o where o.class_id=c.id and o.going) < coalesce(c.capacity, 1))
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
    // Students see what each private costs them: from a pack, at the price locked in when they booked, or at today's price for them.
    if (!coach && u.role === "student" && r.rows.some((c) => c.kind === "private")) {
      const plan = u.plan_id ? (await q("select * from plans where id=$1", [u.plan_id])).rows[0] : null, pv = (await privatesOf(u.gym_id, [u.id], tzOf(u), await todayIn(u)))[u.id];
      // Private-only clients on a gym with an access fee pay it once in each month they have a private: say so before they book.
      const fee = memberOf(u, plan, u) ? 0 : accessFee(u);
      for (const c of out) if (c.kind === "private") {
        const b = pv.prices[c.id], day = dayIn(c.startsAt, tzOf(u)), now = privatePrice(u, plan, u, c.priceCents);
        c.myPrice = b ? { cents: b.cents, label: b.label, pack: b.covered, left: pv.left } : { cents: now.cents, label: now.label, pack: pv.left > 0 && (!pv.until || day < pv.until), left: pv.left };
        if (!b && fee > 0 && !pv.months.has(day.slice(0, 7))) Object.assign(c.myPrice, { accessCents: fee, month: day.slice(0, 7) });
      }
    }
    const pa = coach ? null : await privateAccess(u);
    res.json({ classes: out, showAttendees: u.show_attendees !== false, ...(pa ? { privateAccess: pa } : {}) });
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
    return { title, startsAt, durationMin, plan: p, shared: b.shared !== false, kind, capacity, priceCents, coach: clean(b.coach, 60), level: clean(b.level, 40), discipline: clean(b.discipline, 40) };
  }
  const CLASS_COLS = "gym_id,title,starts_at,duration_min,plan,shared,created_by,kind,capacity,price_cents,coach,level,discipline";
  const classVals = (u, c) => [u.gym_id, c.title, c.startsAt, c.durationMin, c.plan, c.shared, u.id, c.kind, c.capacity, c.priceCents, c.coach, c.level, c.discipline || ""];
  api.post("/classes", wrap(async (req, res) => {
    const u = needCoach(req), c = readClass(req.body || {});
    const r = await q(`insert into classes(${CLASS_COLS}) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`, classVals(u, c));
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
      row = (await db.query("update classes set title=$1,starts_at=$2,duration_min=$3,plan=$4,shared=$5,kind=$6,capacity=$7,price_cents=$8,coach=$9,level=$10,discipline=$11 where id=$12 returning *",
        [c.title, c.startsAt, c.durationMin, c.plan, c.shared, c.kind, c.capacity, c.priceCents, c.coach, c.level, c.discipline, cur.id])).rows[0];
      // Bookings priced at the slot's own price (no tier price for them) follow it; tier prices stay as they were booked.
      if ((row.price_cents || 0) !== (cur.price_cents || 0)) await db.query("update attendance set price_cents=$1 where class_id=$2 and price_from='slot'", [row.price_cents || 0, row.id]);
      // A group class made into a private: the people already on it get their private price now, locked in like a booking.
      if (row.kind === "private" && cur.kind !== "private") await lockPrice(db, row, (await db.query("select user_id from attendance where class_id=$1 and (going or attended) and price_from is null", [row.id])).rows.map((x) => x.user_id));
      ids = await promoteWaitlist(db, row); // more spots (or no limit any more): people waiting move in
      await db.query("commit");
    } catch (e) { await db.query("rollback").catch(() => {}); throw e; } finally { db.release(); }
    await tellPromoted(ids, row, u);
    // Moved to another day or time: tell the people booked (email) and, for group classes, the whole gym (in the app).
    let told = 0;
    if (new Date(cur.starts_at).getTime() !== new Date(row.starts_at).getTime() && new Date(row.starts_at) > new Date() && b.notify !== false) {
      const booked = (await q("select u.id, u.email, u.name from attendance a join users u on u.id=a.user_id where a.class_id=$1 and (a.going or a.waitlisted)", [row.id])).rows;
      const was = whenText(cur.starts_at, tzOf(u)), now = whenText(row.starts_at, tzOf(u));
      for (const p of booked) mail.sendLater({ to: p.email, ...mail.templates.moved(p.name, u.gym_name, row.title, was, now) });
      if (row.kind !== "private" || booked.length) await notify(u, row, booked, "moved", `Moved: ${row.title}`, `Now ${now} (was ${was}).`);
      told = booked.length;
    }
    res.json({ class: classOut(row, true), promoted: ids.length, told });
  }));
  const whenText = (d, tz) => { try { return new Date(d).toLocaleString("en-ZA", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }); } catch (e) { return new Date(d).toISOString(); } };
  // In-app notices: a private lesson's change goes to the people booked; a group class's goes to every student in the gym.
  async function notify(u, c, booked, kind, title, body) {
    if (c.kind === "private") { for (const b of booked) await q("insert into notices(gym_id,user_id,kind,title,body) values($1,$2,$3,$4,$5)", [u.gym_id, b.id, kind, title, body]); }
    else await q("insert into notices(gym_id,user_id,kind,title,body) values($1,null,$2,$3,$4)", [u.gym_id, kind, title, body]);
  }
  api.delete("/classes/:id", wrap(async (req, res) => {
    const u = needCoach(req), c = await ownClass(u, req.params.id);
    const booked = (await q("select u.id, u.email, u.name from attendance a join users u on u.id=a.user_id where a.class_id=$1 and (a.going or a.waitlisted)", [c.id])).rows;
    await q("delete from classes where id=$1", [c.id]);
    const future = new Date(c.starts_at) > new Date(), tell = future && req.body?.notify !== false, when = whenText(c.starts_at, tzOf(u));
    if (tell) {
      for (const b of booked) mail.sendLater({ to: b.email, ...mail.templates.cancelled(b.name, u.gym_name, c.title, when) });
      if (c.kind === "private" ? booked.length : true) await notify(u, c, booked, "cancelled", `Cancelled: ${c.title}`, c.kind === "private" ? `Your private lesson on ${when} is cancelled.` : `${c.title} on ${when} is cancelled.${booked.length ? " Everyone booked has been told." : ""}`);
    }
    res.json({ ok: true, notified: tell ? booked.filter((b) => b.email).length : 0, noticed: tell ? (c.kind === "private" ? booked.length : "all") : 0 });
  }));
  api.get("/me/notices", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) return res.json({ notices: [], unread: 0 });
    const r = await q(`select id, kind, title, body, created_at from notices where gym_id=$1 and (user_id is null or user_id=$2) and created_at > now() - interval '30 days'
      and created_at >= $3 order by created_at desc limit 30`, [u.gym_id, u.id, u.created_at]);
    const seen = u.notices_seen_at ? new Date(u.notices_seen_at).getTime() : 0;
    res.json({ notices: r.rows.map((n) => ({ id: String(n.id), kind: n.kind, title: n.title, body: n.body, at: n.created_at, unread: new Date(n.created_at).getTime() > seen })), unread: r.rows.filter((n) => new Date(n.created_at).getTime() > seen).length });
  }));
  api.post("/me/notices/seen", wrap(async (req, res) => { const u = needUser(req); await q("update users set notices_seen_at=now() where id=$1", [u.id]); res.json({ ok: true }); }));

  // Fill free spots from the waitlist, longest-waiting first. Call inside a transaction holding the class row lock.
  async function promoteWaitlist(db, c) {
    if (new Date(c.starts_at) <= new Date()) return [];
    const booked = Number((await db.query("select count(*) from attendance where class_id=$1 and going", [c.id])).rows[0].count);
    const free = c.capacity ? c.capacity - booked : 1e6;
    if (free <= 0) return [];
    const r = await db.query(`update attendance set going=true, waitlisted=false, booked_at=clock_timestamp(), updated_at=now()
      where class_id=$1 and user_id in (select user_id from attendance where class_id=$1 and waitlisted order by booked_at limit $2) returning user_id`, [c.id, Math.min(free, 1000)]);
    await lockPrice(db, c, r.rows.map((x) => x.user_id));
    return r.rows.map((x) => x.user_id);
  }
  async function tellPromoted(ids, c, u) {
    if (!ids.length) return;
    const ppl = (await q("select email, name from users where id = any($1)", [ids])).rows;
    for (const p of ppl) mail.sendLater({ to: p.email, ...mail.templates.offWaitlist(p.name, u.gym_name, c.title, whenText(c.starts_at, tzOf(u))) });
  }
  // Release someone's future bookings at a gym (they left it or deleted their account) and hand the spots on.
  async function releaseBookings(userId, gymId, u) {
    const rows = (await q(`update attendance a set going=false, waitlisted=false, ${UNPRICE("a")}, updated_at=now() from classes c
      where c.id=a.class_id and a.user_id=$1 and c.gym_id=$2 and c.starts_at > now() and (a.going or a.waitlisted) returning c.id`, [userId, gymId])).rows;
    for (const { id } of rows) {
      const db = await pool.connect();
      try { await db.query("begin"); const c = (await db.query("select * from classes where id=$1 for update", [id])).rows[0]; const ids = c ? await promoteWaitlist(db, c) : []; await db.query("commit"); if (c) await tellPromoted(ids, c, u); }
      catch (e) { await db.query("rollback").catch(() => {}); } finally { db.release(); }
    }
  }
  // Someone leaves a gym, for no gym or another one. Their bookings there are released, and what that gym kept about them
  // (coach notes, fee, plan, parent's name, payment reference) stays behind, so a new gym never sees it.
  async function leaveGym(st, gymId = null, role = "student") {
    if (st.gym_id) await releaseBookings(st.id, st.gym_id, st);
    await q(`update users set gym_id=$2, role=$3, active=true, notes='', monthly_fee_cents=null, plan_id=null, plan_status='active', plan_started=null, parent_name='', pay_ref=null,
      gym_joined_at=case when $2::bigint is null then null else now() end where id=$1`, [st.id, gymId, role]);
  }
  // Can this person take a place in this class? Not if the gym marked them inactive or their plan is paused or cancelled.
  // A plan's weekly limit counts bookings and waitlist places (someone waiting can be moved in later). Call inside the transaction.
  async function canBook(db, u, c) {
    if (u.active === false) fail(403, "Your gym has marked you as inactive. Talk to your coach to book classes.");
    if (u.role !== "student") return;
    if (c.kind === "private") { const pa = await privateAccess(u, db); if (pa) fail(403, pa.status ? pa.message : `${pa.message} Your coach can put you on it.`); }
    if (!u.plan_id) return;
    if (u.plan_status === "paused" || u.plan_status === "cancelled") fail(403, `Your membership is ${u.plan_status}. Talk to your coach to book classes.`);
    const p = (await db.query("select * from plans where id=$1", [u.plan_id])).rows[0];
    if (p && p.classes_per_week && c.kind !== "private") {
      const n = Number((await db.query(`select count(*) from attendance a join classes k on k.id=a.class_id where a.user_id=$1 and (a.going or a.waitlisted) and k.kind<>'private' and k.id<>$2
        and date_trunc('week', k.starts_at at time zone $4) = date_trunc('week', $3::timestamptz at time zone $4)`, [u.id, c.id, c.starts_at, tzOf(u)])).rows[0].count);
      if (n >= p.classes_per_week) fail(403, `Your ${p.name} plan includes ${p.classes_per_week} class${p.classes_per_week > 1 ? "es" : ""} a week, and you've booked ${n} that week. Cancel one or ask your coach about upgrading.`);
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
      // A private uses its credit (or is owed at its price) once it starts with them booked, so it can't be cancelled from then on.
      if (!want && c.kind === "private" && mine && mine.going && new Date(c.starts_at).getTime() <= Date.now()) fail(400, "That private lesson has already started, so it can't be cancelled now. Talk to your coach.");
      const booked = Number((await db.query("select count(*) from attendance where class_id=$1 and going and user_id<>$2", [c.id, u.id])).rows[0].count);
      if (want) {
        if (mine && (mine.going || mine.waitlisted)) out = { going: !!mine.going, waitlisted: !!mine.waitlisted };
        else {
          await canBook(db, u, c);
          const full = c.capacity && booked >= c.capacity;
          if (full && c.kind === "private") fail(409, "Someone just booked that slot. Pick another time.");
          await db.query(`insert into attendance(class_id,user_id,going,waitlisted,booked_at) values($1,$2,$3,$4,clock_timestamp())
            on conflict(class_id,user_id) do update set going=excluded.going, waitlisted=excluded.waitlisted, booked_at=clock_timestamp(), updated_at=now()`, [c.id, u.id, !full, !!full]);
          out = { going: !full, waitlisted: !!full };
          if (!full && c.kind === "private") { await lockPrice(db, c, [u.id]); const a = (await db.query("select price_cents, price_label from attendance where class_id=$1 and user_id=$2", [c.id, u.id])).rows[0]; out.price = { cents: a.price_cents, label: a.price_label || "" }; }
        }
      } else {
        await db.query(`update attendance set going=false, waitlisted=false, ${UNPRICE()}, updated_at=now() where class_id=$1 and user_id=$2`, [c.id, u.id]);
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
        await canBook(db, u, c);
        const booked = Number((await db.query("select count(*) from attendance where class_id=$1 and going", [c.id])).rows[0].count);
        if (c.capacity && booked >= c.capacity) fail(409, "This class is full. Ask your coach at the mat.");
      }
      await db.query(`insert into attendance(class_id,user_id,going,attended,checked_in_at) values($1,$2,true,true,now())
               on conflict(class_id,user_id) do update set going=true, waitlisted=false, attended=true, checked_in_at=now(), updated_at=now()`, [c.id, u.id]);
      if (!mine || !mine.going) await lockPrice(db, c, [u.id]);
      await db.query("commit");
    } catch (e) { await db.query("rollback").catch(() => {}); throw e; } finally { db.release(); }
    res.json({ ok: true });
  }));

  // ---------- coach: class detail, roster, students ----------
  // Coaches see training logged since the student joined their gym, never what they logged at a gym before.
  // (No join date: they signed up with this gym's code, so everything they logged is theirs to see.)
  const SINCE_JOINED = "(select x.gym_joined_at is null or t.date >= (x.gym_joined_at at time zone g.timezone)::date from users x, gyms g where x.id=t.user_id and g.id=$2)";
  async function summaries(gymId, userIds) {
    if (!userIds.length) return {};
    const p = await q("select user_id, data->'mastery' as mastery, data->'settings'->>'goal' as goal from progress where user_id = any($1)", [userIds]);
    const l = await q(`select user_id, max(date) as last, count(*) filter (where date >= current_date - 30) as n30,
        coalesce(jsonb_agg(data->'stuck') filter (where date >= current_date - 30), '[]') as stuck,
        coalesce(jsonb_agg(data->'tapped') filter (where date >= current_date - 30), '[]') as tapped
      from training_logs t where user_id = any($1) and ${SINCE_JOINED} group by user_id`, [userIds, gymId]);
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
  // A payment counts toward every month it covers (a year paid in October covers October to September), split evenly.
  // m is SQL for the first day of the month, as a timestamp.
  const covers = (m) => `date_trunc('month', paid_on::timestamp) <= (${m}) and date_trunc('month', paid_on::timestamp) + make_interval(months => greatest(months, 1)) > (${m})`;
  const SHARE = "round(amount_cents::numeric / greatest(months, 1))";
  // Paused and cancelled members don't pay fees.
  const feeOff = (status) => status === "paused" || status === "cancelled";
  async function plansOf(gymId) { return (await q("select * from plans where gym_id=$1 order by active desc, price_cents", [gymId])).rows; }
  const planOut = (p) => ({ id: String(p.id), name: p.name, priceCents: p.price_cents, period: p.period, classesPerWeek: p.classes_per_week, active: p.active, monthlyCents: monthly(p), privateCents: p.private_price_cents ?? null });
  // A private-lesson price: null or "" for none (the slot's price), else from R0 to R100 000.
  const readPrivate = (v, msg) => { if (v === null || v === "") return null; const c = intOr(v, NaN); if (!Number.isFinite(c) || c < 0 || c > 1e7) fail(400, msg); return c; };
  // Payments for a private-lesson pack buy credits; they don't count toward monthly fees.
  const FEES = "coalesce(pack_lessons,0)=0";

  // ---------- private lessons: pack credits, and what a private costs without one ----------
  // The ledger, worked out from the payments and bookings themselves (so an edited payment or a cancelled booking is never out of step):
  // a confirmed pack payment adds its lessons from the day it was paid (until it expires); a private lesson the student was checked into,
  // or was still booked on when it started, uses one. Privates still to come hold a credit too, so "left" is what's free to book.
  // Credits closest to expiring go first. A private with no credit for it is owed at its price (privatePrice), in the month it happens,
  // if it's from after the gym's privates_from (privates before that were settled outside the app).
  async function privatesOf(gymId, userIds, tz, today) {
    const out = {}; for (const id of userIds) out[id] = { left: 0, booked: 0, used: 0, expiresOn: null, until: null, owed: [], months: new Set(), ledger: [], prices: {} };
    if (!userIds.length) return out;
    const pays = (await q(`select p.id, p.user_id, p.paid_on, p.pack_lessons, p.pack_months, coalesce(k.name, p.pack_lessons || ' private lessons') as name
      from payments p left join packs k on k.id=p.pack_id where p.gym_id=$1 and p.user_id = any($2) and p.status='confirmed' and p.pack_lessons > 0 order by p.paid_on, p.id`, [gymId, userIds])).rows;
    const uses = (await q(`select a.user_id, c.id, c.title, c.starts_at, c.price_cents, a.attended, a.price_cents as locked, a.price_label as locked_label, to_char(c.starts_at at time zone $3,'YYYY-MM-DD') as day, c.starts_at >= g.privates_from as charged
      from attendance a join classes c on c.id=a.class_id join gyms g on g.id=c.gym_id where c.gym_id=$1 and a.user_id = any($2) and c.kind='private' and (a.going or a.attended) order by c.starts_at, c.id`, [gymId, userIds, tz])).rows;
    // What each private costs: the price locked in when it was booked. A booking with no price on it (from before tiers) costs the slot's
    // price, as it did then, so setting or changing tier prices never reprices privates already booked or paid for.
    const priceOf = (a) => a.locked !== null ? { cents: a.locked, label: a.locked_label || "" } : { cents: a.price_cents, label: "" };
    const now = Date.now(), batches = {};
    for (const p of pays) {
      const b = { from: p.paid_on, until: p.pack_months ? addMonths(p.paid_on, p.pack_months) : null, n: p.pack_lessons };
      (batches[p.user_id] = batches[p.user_id] || []).push(b);
      out[p.user_id].ledger.push({ day: p.paid_on, kind: "pack", lessons: p.pack_lessons, title: p.name, paymentId: String(p.id), expiresOn: b.until });
    }
    for (const a of uses) {
      const o = out[a.user_id], st = a.attended || new Date(a.starts_at).getTime() <= now ? "used" : "booked";
      if (a.charged) o.months.add(a.day.slice(0, 7)); if (st === "booked") o.booked++; else o.used++;
      const b = (batches[a.user_id] || []).filter((x) => x.n > 0 && x.from <= a.day && (!x.until || a.day < x.until)).sort((x, y) => (x.until || "9999") < (y.until || "9999") ? -1 : (x.until || "9999") > (y.until || "9999") ? 1 : 0)[0];
      const pr = priceOf(a); o.prices[String(a.id)] = { ...pr, covered: !!b };
      if (b) { b.n--; o.ledger.push({ day: a.day, kind: st, lessons: -1, title: a.title, classId: String(a.id) }); }
      else if (a.charged) o.owed.push({ classId: String(a.id), title: a.title, startsAt: a.starts_at, day: a.day, month: a.day.slice(0, 7), priceCents: pr.cents || 0, label: pr.label, status: st });
    }
    for (const [uid, bs] of Object.entries(batches)) {
      const o = out[uid], live = bs.filter((x) => x.n > 0 && (!x.until || today < x.until));
      o.left = live.reduce((t, x) => t + x.n, 0); o.expiresOn = live.map((x) => x.until).filter(Boolean).sort()[0] || null;
      o.until = live.length && live.every((x) => x.until) ? live.map((x) => x.until).sort().pop() : null; // the last day a lesson left can be used
      for (const x of bs) if (x.n > 0 && x.until && today >= x.until) o.ledger.push({ day: x.until, kind: "expired", lessons: -x.n, title: "Unused lessons expired" });
    }
    for (const o of Object.values(out)) o.ledger.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
    return out;
  }
  const privOut = (o) => ({ left: o.left, booked: o.booked, used: o.used, expiresOn: o.expiresOn });
  // What someone owes for a month: their membership fee, the gym's access fee if they're a private-only client that month,
  // and any private lesson with no credit for it. Paused and cancelled members pay no membership fee.
  // A private-only client pays no membership fee at all (no active plan, and no fee of their own or the gym's standard fee)
  // and booked or attended a private that month. The access fee is added for them; it never replaces a membership fee.
  const realPlan = (p) => !!p && !/^(none|no plan)$/i.test(String(p.name || "").trim());
  const membershipOf = (x, plan, gym) => feeOff(x.plan_status) ? 0 : x.monthly_fee_cents ?? (plan ? monthly(plan) : null) ?? gym.gym_fee ?? 0;
  const memberOf = (x, plan, gym) => (realPlan(plan) && !feeOff(x.plan_status)) || membershipOf(x, plan, gym) > 0;
  // The access fee only applies when the gym picked it ('fee'): 'none' charges just the private, 'membership' needs a plan to book.
  const accessFee = (gym) => (gym.access_mode || "fee") === "fee" ? gym.access_fee_cents || 0 : 0;
  function duesFor(x, plan, gym, priv, month) {
    const membershipCents = membershipOf(x, plan, gym), member = memberOf(x, plan, gym), fee = accessFee(gym);
    const accessCents = !member && fee > 0 && priv && priv.months.has(month) ? fee : 0;
    const privates = priv ? priv.owed.filter((o) => o.month === month && o.priceCents > 0).map((o) => ({ classId: o.classId, title: o.title, startsAt: o.startsAt, priceCents: o.priceCents, label: o.label || "" })) : [];
    const privatesCents = privates.reduce((t, o) => t + o.priceCents, 0);
    return { membershipCents, accessCents, privatesCents, privates, dueCents: membershipCents + accessCents + privatesCents };
  }
  // Gyms on 'membership' only let students on one of the plans they ticked (and not paused or cancelled) book a private.
  // null: this student can book. Otherwise the plans that allow privates (the ones still offered, if any are), and what to tell them.
  // u needs role, gym_id, plan_id, plan_status, access_mode and private_plan_ids (the signed-in user has them).
  async function privateAccess(u, db = pool) {
    if (u.role !== "student" || u.access_mode !== "membership") return null;
    const ids = (u.private_plan_ids || []).map(String);
    const onIt = u.plan_id && ids.includes(String(u.plan_id));
    if (onIt && !feeOff(u.plan_status)) return null;
    // On a plan that allows privates, but it's paused or cancelled: restarting it is what they need, not joining.
    if (onIt) { const p = (await db.query("select * from plans where id=$1", [u.plan_id])).rows[0];
      return { plans: p ? [planOut(p)] : [], status: u.plan_status, message: `Your ${p ? p.name + " " : ""}membership is ${u.plan_status}. Ask your coach to restart it to book privates.` }; }
    const all = (await db.query("select * from plans where gym_id=$1 and id = any($2::bigint[]) order by price_cents, name", [u.gym_id, ids])).rows;
    const ps = all.some((p) => p.active) ? all.filter((p) => p.active) : all;
    const names = ps.map((p) => p.name), list = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0] || "a";
    return { plans: ps.map(planOut), message: `Join the ${list} membership to book privates.` };
  }
  // ---------- private-lesson price tiers ----------
  // What a private costs someone with no pack lesson for it. Someone on an active (or trial) plan with a private price pays that.
  // Someone without a membership pays the gym's price for them, if it has one. That's the same test as the access fee (memberOf):
  // no active plan and no monthly fee (their own or the gym's standard fee). Anyone else pays the slot's own price, as before tiers.
  // x needs plan_status and monthly_fee_cents; gym needs gym_private_cents and gym_fee.
  function privatePrice(x, plan, gym, slotCents) {
    const on = !!plan && !feeOff(x.plan_status);
    if (on && plan.private_price_cents !== null && plan.private_price_cents !== undefined) return { cents: plan.private_price_cents, from: "plan", label: plan.name };
    if (gym.gym_private_cents !== null && gym.gym_private_cents !== undefined && !memberOf(x, plan, gym)) return { cents: gym.gym_private_cents, from: "nonmember", label: "No membership" };
    return { cents: slotCents || 0, from: "slot", label: "" };
  }
  // Lock in what a private costs these people, now they have a place on it. Later price changes don't touch it
  // (except a slot priced at its own price, which follows the slot). Call inside the class's transaction.
  async function lockPrice(db, c, userIds) {
    if (c.kind !== "private" || !userIds.length) return;
    const g = (await db.query("select private_price_cents as gym_private_cents, monthly_fee_cents as gym_fee from gyms where id=$1", [c.gym_id])).rows[0];
    const xs = (await db.query("select u.id, u.plan_status, u.monthly_fee_cents, to_jsonb(p) as plan from users u left join plans p on p.id=u.plan_id where u.id = any($1)", [userIds])).rows;
    for (const x of xs) { const p = privatePrice(x, x.plan, g, c.price_cents); await db.query("update attendance set price_cents=$3, price_from=$4, price_label=$5 where class_id=$1 and user_id=$2", [c.id, x.id, p.cents, p.from, p.label]); }
  }
  // A cancelled booking lets go of its price (booking again prices it again). One they were checked into keeps it.
  const UNPRICE = (a = "attendance") => ["price_cents", "price_from", "price_label"].map((k) => `${k}=case when ${a}.attended then ${a}.${k} end`).join(", ");
  const dayIn = (d, tz) => { try { return new Date(d).toLocaleDateString("en-CA", { timeZone: tz }); } catch (e) { return new Date(d).toISOString().slice(0, 10); } };
  const packOut = (k) => ({ id: String(k.id), name: k.name, lessons: k.lessons, priceCents: k.price_cents, expiryMonths: k.expiry_months, active: k.active });
  async function packIn(gymId, id, activeOnly) {
    const k = (await q(`select * from packs where id=$1 and gym_id=$2${activeOnly ? " and active" : ""}`, [intOr(id, 0), gymId])).rows[0];
    if (!k) fail(404, "That private-lesson pack doesn't exist."); return k;
  }

  api.get("/coach/classes/:id", wrap(async (req, res) => {
    const u = needCoach(req), c = await ownClass(u, req.params.id);
    const r = await q(`select u.id,u.name,u.belt,u.stripes,a.going,a.attended,a.waitlisted,a.booked_at,a.checked_in_at from attendance a join users u on u.id=a.user_id
      where a.class_id=$1 and (a.going or a.attended or a.waitlisted) order by a.waitlisted, a.booked_at, u.name`, [c.id]);
    const s = await summaries(u.gym_id, r.rows.map((x) => x.id));
    if (c.kind === "private") { const pv = await privatesOf(u.gym_id, r.rows.map((x) => x.id), tzOf(u), await todayIn(u));
      for (const x of r.rows) { s[x.id].privatesLeft = pv[x.id].left; const b = pv[x.id].prices[c.id]; if (isHead(u) && b) Object.assign(s[x.id], { priceCents: b.cents, priceLabel: b.label, pack: b.covered }); } }
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
    const had = new Set((await q("select user_id from attendance where class_id=$1 and user_id = any($2) and (going or attended)", [c.id, ids])).rows.map((x) => String(x.user_id)));
    // going: true adds them as booked (a coach putting someone on a class or private), without touching a check-in they already have.
    const book = req.body?.going === true;
    for (const sid of ids) await q(`insert into attendance(class_id,user_id,going,attended,booked_at) values($1,$2,true,$3,clock_timestamp())
             on conflict(class_id,user_id) do update set attended=case when $4 then attendance.attended or excluded.attended else excluded.attended end,
               going=attendance.going or excluded.attended or $4, waitlisted=false, updated_at=now()`, [c.id, sid, req.body?.attended !== false, book]);
    // Someone the coach adds to a private gets today's price for them, locked in like a booking.
    await lockPrice(pool, c, ids.filter((x) => !had.has(String(x))));
    res.json({ ok: true, count: ids.length });
  }));

  async function rosterRows(u) {
    const r = await q(`select u.id,u.name,u.parent_name,u.email,u.phone,(u.pass_hash is null) as offline,u.role,u.belt,u.stripes,u.active,u.monthly_fee_cents,u.notes,u.created_at,u.plan_id,u.plan_status,u.plan_started,u.rank_changed_at
      from users u where u.gym_id=$1 order by u.role, u.name`, [u.gym_id]);
    const plans = await plansOf(u.gym_id), pm = Object.fromEntries(plans.map((p) => [String(p.id), p]));
    const s = await summaries(u.gym_id, r.rows.map((x) => x.id));
    const vs = await visitStats(u.gym_id, tzOf(u)), { visits } = vs;
    const today = await todayIn(u), month = today.slice(0, 7), priv = await privatesOf(u.gym_id, r.rows.map((x) => x.id), tzOf(u), today);
    const pay = await q(`select user_id, sum(${SHARE}) filter (where status='confirmed' and ${FEES} and ${covers("$2::timestamp")}) as month_cents,
        sum(amount_cents) filter (where status='pending' and ${FEES} and paid_on >= $2::date - 7) as pending_cents,
        max(paid_on) filter (where status='confirmed') as last_paid from payments
      where gym_id=$1 and user_id is not null and status<>'rejected' group by user_id`, [u.gym_id, month + "-01"]);
    const paid = Object.fromEntries(pay.rows.map((x) => [x.user_id, x]));
    // Someone the coach added who then signed up through the gym's link instead of their own: likely the same person twice.
    const off = r.rows.filter((x) => x.offline && x.role === "student"), same = {};
    for (const a of r.rows.filter((x) => !x.offline && x.role === "student")) {
      const o = off.find((x) => nameKey(x.name) === nameKey(a.name) || (phoneKey(a.phone).length >= 7 && phoneKey(x.phone) === phoneKey(a.phone)));
      if (o) { same[a.id] = same[a.id] || { id: String(o.id), name: o.name }; same[o.id] = same[o.id] || { id: String(a.id), name: a.name }; }
    }
    return { plans, vs, rows: r.rows.map((x) => {
      const plan = pm[String(x.plan_id)] || null, d = duesFor(x, plan, u, priv[x.id], month);
      return { ...person(x, s[x.id]), parentName: x.parent_name || "", email: x.email || "", phone: x.phone || "", offline: !!x.offline, role: x.role, active: x.active, notes: x.notes, joined: x.created_at,
        privatesLeft: priv[x.id].left, head: String(x.id) === String(u.head_id),
        feeCents: x.role === "student" ? d.dueCents : 0, accessCents: d.accessCents, privatesCents: d.privatesCents, planId: plan ? String(plan.id) : null, planName: plan ? plan.name : null, planStatus: x.plan_status, planStarted: x.plan_started,
        paidThisMonthCents: Number(paid[x.id]?.month_cents || 0), pendingThisMonthCents: Number(paid[x.id]?.pending_cents || 0), lastPaid: paid[x.id]?.last_paid || null,
        visits: x.role === "student" ? studentStats(x, visits[x.id]) : null, sameAs: same[x.id] || null };
    }) };
  }
  // Fees, plans and payments are the head coach's: other coaches get the roster without them.
  const MONEY_KEYS = ["feeCents", "accessCents", "privatesCents", "planId", "planName", "planStatus", "planStarted", "paidThisMonthCents", "pendingThisMonthCents", "lastPaid", "feeOverride", "payments"];
  const noMoney = (o) => { const c = { ...o }; for (const k of MONEY_KEYS) delete c[k]; return c; };
  api.get("/coach/roster", wrap(async (req, res) => {
    const u = needCoach(req), { plans, rows } = await rosterRows(u);
    if (!isHead(u)) return res.json({ currency: u.currency, people: rows.map(noMoney) });
    res.json({ gymFeeCents: u.gym_fee, accessFeeCents: accessFee(u), currency: u.currency, plans: plans.map(planOut), people: rows });
  }));

  async function ownStudent(u, id) {
    const r = await q("select * from users where id=$1 and gym_id=$2", [intOr(id, 0), u.gym_id]);
    if (!r.rows[0]) fail(404, "That person isn't in your gym.");
    return r.rows[0];
  }
  api.post("/coach/students", wrap(async (req, res) => {
    const u = needCoach(req), b = req.body || {};
    const name = clean(b.name, 80); if (!name) fail(400, "Enter the student's name.");
    const email = clean(b.email, 254).toLowerCase(), phone = cleanPhone(b.phone);
    if (email && !isEmail(email)) fail(400, "That email doesn't look right.");
    if (!email && !phone) fail(400, "Add a WhatsApp number or an email, so you can reach them.");
    const parentName = clean(b.parentName, 80);
    if (!isHead(u) && ((b.planId !== undefined && b.planId !== null && b.planId !== "") || (b.feeCents !== undefined && b.feeCents !== null && b.feeCents !== ""))) fail(403, "Only the head coach can set plans and fees.");
    if (email && (await q("select 1 from users where email=$1", [email])).rows[0]) fail(409, "Someone with that email is already on JitsFlow. Send them your gym's invite link instead.");
    const belt = BELTS.includes(b.belt) ? b.belt : "white", stripes = Math.min(4, Math.max(0, intOr(b.stripes, 0)));
    let planId = null; if (b.planId) { planId = intOr(b.planId, 0); if (!(await q("select 1 from plans where id=$1 and gym_id=$2", [planId, u.gym_id])).rows[0]) fail(404, "That plan doesn't exist."); }
    const fee = b.feeCents === undefined || b.feeCents === null || b.feeCents === "" ? null : Math.max(0, intOr(b.feeCents, 0));
    const r = await q(`insert into users(gym_id,role,name,email,pass_hash,phone,belt,stripes,plan_id,plan_status,plan_started,monthly_fee_cents,notes,offline,parent_name)
      values($1,'student',$2,$3,null,$4,$5,$6,$7,$8,$9,$10,$11,true,$12) returning id`,
      [u.gym_id, name, email || null, phone, belt, stripes, planId, "active", planId ? (isDay(b.planStarted) ? b.planStarted : await todayIn(u)) : null, fee, clean(b.notes, 4000), parentName]);
    res.status(201).json({ id: String(r.rows[0].id) });
  }));
  // Several at once (from the phone's contacts, a contacts file or a pasted list). Skips people already on the list.
  async function whoIsIn(gymId) {
    const have = (await q("select lower(name) as n, phone, parent_name, lower(coalesce(email,'')) as e from users where gym_id=$1", [gymId])).rows;
    const digits = (v) => String(v || "").replace(/\D/g, "").slice(-9), byName = new Map();
    const note = (n, ph, e) => { const k = String(n).toLowerCase(); if (!byName.has(k)) byName.set(k, []); byName.get(k).push({ d: digits(ph), e: e || "" }); };
    for (const h of have) note(h.n, h.phone, h.e);
    // The same name is the same person, unless both have a number or email and none of them match (two different Thabos).
    const sameName = (n, ph, e) => { const was = byName.get(String(n).toLowerCase()), d = digits(ph); if (!was) return false; if (d.length < 7 && !e) return true;
      return was.some((w) => (w.d.length < 7 && !w.e) || (d.length >= 7 && w.d === d) || (!!e && w.e === e)); };
    return { digits, note, sameName, seenPh: new Set(have.filter((h) => !h.parent_name).map((h) => digits(h.phone)).filter((d) => d.length >= 7)), seenEm: new Set(have.map((h) => h.e).filter(Boolean)) };
  }
  // Screenshots of a WhatsApp group: who's in it, as students (kids with their parent's number). Nothing is saved here.
  api.post("/coach/students/read-people", wrap(async (req, res) => {
    const u = needCoach(req);
    const client = ai.getClient(); if (!client) fail(503, "Reading screenshots isn't switched on yet. Paste the names instead.");
    const list = (Array.isArray(req.body?.images) ? req.body.images : []).slice(0, 8);
    if (!list.length) fail(400, "Choose a screenshot of your WhatsApp group.");
    const images = list.map((d) => { const data = Buffer.from(String(d || ""), "base64"), type = pop.sniff(data);
      if (!type || !/^image\/(jpeg|png|webp|gif)$/.test(type)) fail(400, "Those need to be screenshots (pictures)."); if (data.length > 4 * 1024 * 1024) fail(413, "One of those pictures is too big."); return { type, data }; });
    if (limited("ppl:" + u.gym_id, 30, 60 * 60e3)) fail(429, "That's a lot of screenshots. Try again in a while.");
    let rows;
    try { rows = await people.readPeople({ client, images }); }
    catch (e) { console.error("read-people:", e.message); fail(502, "Couldn't read those screenshots just now. Try again, or paste the names."); }
    const { seenPh, sameName, digits } = await whoIsIn(u.gym_id);
    res.json({ people: rows.map((r) => ({ ...r, already: !!((r.name && sameName(r.name, r.phone, "")) || (!r.parentName && r.phone && seenPh.has(digits(r.phone)))) })) });
  }));
  api.post("/coach/students/bulk", wrap(async (req, res) => {
    const u = needCoach(req), list = (Array.isArray(req.body?.people) ? req.body.people : []).slice(0, 300);
    if (!list.length) fail(400, "No one to add.");
    const { seenPh, seenEm, sameName, note, digits } = await whoIsIn(u.gym_id);
    let added = 0, skipped = 0;
    for (const p0 of list) {
      const name = clean(p0.name, 80), parentName = clean(p0.parentName, 80), phone = cleanPhone(p0.phone), email0 = clean(p0.email, 254).toLowerCase(), email = isEmail(email0) ? email0 : "";
      if (!name) { skipped++; continue; }
      // Brothers and sisters share a parent's number and email, so for kids those don't mean "already here".
      if ((!parentName && phone && seenPh.has(digits(phone))) || (!parentName && email && seenEm.has(email)) || sameName(name, phone, email)) { skipped++; continue; }
      // An email belongs to one person: a second kid of the same parent goes in without it (the parent's number still reaches them).
      let em = email; if (em && (seenEm.has(em) || (await q("select 1 from users where email=$1", [em])).rows[0])) { if (!parentName) { skipped++; continue; } em = ""; }
      await q("insert into users(gym_id,role,name,email,pass_hash,phone,offline,parent_name) values($1,'student',$2,$3,null,$4,true,$5)", [u.gym_id, name, em || null, phone, parentName]);
      if (phone && !parentName) seenPh.add(digits(phone)); if (em) seenEm.add(em); note(name, phone, email); added++;
    }
    res.status(201).json({ added, skipped });
  }));
  // Link that signs this person up straight into their existing record (plan, payments, attendance kept).
  api.post("/coach/students/:id/claim-link", wrap(async (req, res) => {
    const u = needCoach(req), st = await ownStudent(u, req.params.id);
    if (st.pass_hash) fail(400, "They already use the app.");
    res.json({ url: await claimUrl(u, st) });
  }));
  async function claimUrl(u, st) {
    let tok = st.claim_token;
    if (!tok) { tok = crypto.randomBytes(12).toString("base64url"); await q("update users set claim_token=$1 where id=$2", [tok, st.id]); }
    return `${mail.appUrl()}/app/?join=${u.student_code}&claim=${tok}`;
  }
  // Two records for one person (added by the coach, then signed up on their own): fold the one that isn't on the app
  // into their account. Payments, classes, competitions and the coach's plan and notes move over.
  api.post("/coach/students/:id/merge", wrap(async (req, res) => {
    const u = needCoach(req), o = await ownStudent(u, req.params.id), a = await ownStudent(u, req.body?.into);
    if (o.pass_hash || o.role !== "student") fail(400, "Only a student who isn't on the app can be merged.");
    if (!a.pass_hash || a.role !== "student" || a.id === o.id) fail(400, "Pick the student's own account to merge into.");
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("update payments set user_id=$2 where user_id=$1", [o.id, a.id]);
      await db.query("update payments set submitted_by=$2 where submitted_by=$1", [o.id, a.id]);
      await db.query("update attendance set user_id=$2 where user_id=$1 and class_id not in (select class_id from attendance where user_id=$2)", [o.id, a.id]);
      await db.query("update competitors set user_id=$2 where user_id=$1 and competition_id not in (select competition_id from competitors where user_id=$2)", [o.id, a.id]);
      await db.query("update notices set user_id=$2 where user_id=$1", [o.id, a.id]);
      const ref = !a.pay_ref && o.pay_ref ? o.pay_ref : null, rank = BELTS.indexOf(o.belt) * 10 + o.stripes > BELTS.indexOf(a.belt) * 10 + a.stripes;
      await db.query("update users set pay_ref=null, claim_token=null where id=$1", [o.id]);
      await db.query(`update users set plan_id=$2, plan_status=$3, plan_started=$4, monthly_fee_cents=$5, notes=$6, phone=$7, parent_name=$8, belt=$9, stripes=$10,
        pay_ref=coalesce(pay_ref,$11), created_at=least(created_at,$12) where id=$1`,
        [a.id, a.plan_id || o.plan_id, a.plan_id ? a.plan_status : o.plan_status, a.plan_id ? a.plan_started : o.plan_started, a.monthly_fee_cents ?? o.monthly_fee_cents,
          [a.notes, o.notes].filter(Boolean).join("\n"), a.phone || o.phone || "", a.parent_name || o.parent_name || "", rank ? o.belt : a.belt, rank ? o.stripes : a.stripes, ref, o.created_at]);
      await db.query("delete from users where id=$1", [o.id]);
      await db.query("commit");
    } catch (e) { await db.query("rollback").catch(() => {}); throw e; } finally { db.release(); }
    res.json({ ok: true, id: String(a.id) });
  }));
  api.delete("/coach/students/:id", wrap(async (req, res) => {
    const u = needCoach(req), st = await ownStudent(u, req.params.id);
    // Another coach leaving the gym: they keep their own account (as a student with no gym) but lose all access here.
    // Their sessions end, and the coach code changes in case they kept it.
    if (st.role === "coach" && st.pass_hash) {
      if (st.id === u.id) fail(400, "You can't remove yourself. Ask another coach to do it.");
      if (String(st.id) === String(u.head_id)) fail(400, `${first(st.name)} is the head coach. They need to hand that role to another coach first.`);
      await leaveGym(st);
      await q("delete from sessions where user_id=$1", [st.id]);
      await q("update gyms set coach_code=$1 where id=$2", [code(), u.gym_id]);
      tellCoaches(u.gym_id, "removed", u.name, st.name);
      return res.json({ ok: true, me: me(await loadMe(u.id)) });
    }
    // A student with their own account keeps it, with no gym. Payments you recorded stay with the gym.
    if (st.pass_hash) { await leaveGym(st); return res.json({ ok: true }); }
    await q("update payments set user_id=null where user_id=$1", [st.id]);
    await q("delete from users where id=$1", [st.id]);
    res.json({ ok: true });
  }));
  api.get("/coach/students/:id", wrap(async (req, res) => {
    const u = needCoach(req), st = await ownStudent(u, req.params.id);
    const s = (await summaries(u.gym_id, [st.id]))[st.id];
    const logs = await q(`select id,data from training_logs t where user_id=$1 and ${SINCE_JOINED} order by date desc nulls last limit 30`, [st.id, u.gym_id]);
    const pays = await q("select * from payments where user_id=$1 and gym_id=$2 and status<>'rejected' order by paid_on desc limit 24", [st.id, u.gym_id]);
    const { visits } = await visitStats(u.gym_id, tzOf(u));
    const recent = await q(`select c.title, c.starts_at, c.kind, a.attended from attendance a join classes c on c.id=a.class_id
      where a.user_id=$1 and c.gym_id=$2 and (a.attended or a.going) order by c.starts_at desc limit 12`, [st.id, u.gym_id]);
    const plan = st.plan_id ? (await q("select * from plans where id=$1", [st.plan_id])).rows[0] : null;
    const today = await todayIn(u), pv = (await privatesOf(u.gym_id, [st.id], tzOf(u), today))[st.id];
    const out = { student: { ...person(st, s), parentName: st.parent_name || "", email: st.email || "", phone: st.phone || "", offline: !st.pass_hash, role: st.role, active: st.active, feeCents: st.monthly_fee_cents ?? (plan ? monthly(plan) : null) ?? u.gym_fee, feeOverride: st.monthly_fee_cents,
        notes: st.notes, joined: st.created_at, planId: st.plan_id ? String(st.plan_id) : null, planStatus: st.plan_status, planStarted: st.plan_started, rankChangedAt: st.rank_changed_at,
        visits: studentStats(st, visits[st.id]), head: String(st.id) === String(u.head_id) },
      classes: recent.rows.map((x) => ({ title: x.title, startsAt: x.starts_at, kind: x.kind, attended: x.attended })),
      logs: logs.rows.map((x) => ({ ...x.data, id: x.id })), payments: pays.rows.map(payOut),
      privates: { ...privOut(pv), ledger: pv.ledger.slice(0, 30) } };
    if (isHead(u)) { const d = duesFor(st, plan, u, pv, today.slice(0, 7)); Object.assign(out.student, { accessCents: d.accessCents, privatesCents: d.privatesCents, dueCents: d.dueCents }); }
    else { out.student = noMoney(out.student); delete out.payments; }
    res.json(out);
  }));
  const PLAN_STATUS = ["active", "trial", "paused", "cancelled"];
  api.patch("/coach/students/:id", wrap(async (req, res) => {
    const u = needCoach(req), st = await ownStudent(u, req.params.id), b = req.body || {};
    if (!isHead(u) && ["feeCents", "planId", "planStatus", "planStarted"].some((k) => b[k] !== undefined)) fail(403, "Only the head coach can change plans and fees.");
    const belt = b.belt !== undefined ? (BELTS.includes(b.belt) ? b.belt : fail(400, "Pick a belt.")) : st.belt;
    const stripes = b.stripes !== undefined ? Math.min(4, Math.max(0, intOr(b.stripes, 0))) : st.stripes;
    const notes = b.notes !== undefined ? clean(b.notes, 4000) : st.notes;
    const fee = b.feeCents !== undefined ? (b.feeCents === null ? null : Math.max(0, intOr(b.feeCents, 0))) : st.monthly_fee_cents;
    const active = b.active !== undefined ? !!b.active : st.active;
    if (st.id === u.id && !active) fail(400, "You can't mark yourself inactive. Ask another coach to do it.");
    if (!active && st.active !== false && String(st.id) === String(u.head_id)) fail(400, `${first(st.name)} is the head coach. They need to hand that role to another coach first.`);
    let planId = st.plan_id;
    if (b.planId !== undefined) { planId = b.planId ? intOr(b.planId, 0) : null; if (planId && !(await q("select 1 from plans where id=$1 and gym_id=$2", [planId, u.gym_id])).rows[0]) fail(404, "That plan doesn't exist."); }
    const planStatus = b.planStatus !== undefined ? (PLAN_STATUS.includes(b.planStatus) ? b.planStatus : fail(400, "Pick a membership status.")) : st.plan_status;
    const planStarted = b.planStarted !== undefined ? (isDay(b.planStarted) ? b.planStarted : null) : st.plan_started;
    const rankChanged = belt !== st.belt || stripes !== st.stripes;
    if (b.phone !== undefined) await q("update users set phone=$1 where id=$2", [cleanPhone(b.phone), st.id]);
    if (b.parentName !== undefined) await q("update users set parent_name=$1 where id=$2", [clean(b.parentName, 80), st.id]);
    await q(`update users set belt=$1,stripes=$2,notes=$3,monthly_fee_cents=$4,active=$5,plan_id=$6,plan_status=$7,plan_started=$8,
      rank_changed_at=case when $9 then now() else rank_changed_at end where id=$10`, [belt, stripes, notes, fee, active, planId, planStatus, planStarted, rankChanged, st.id]);
    // Marked inactive: their places in classes still to come go to the people waiting.
    if (st.active !== false && !active) await releaseBookings(st.id, u.gym_id, u);
    // An inactive coach loses coach access straight away: sign them out everywhere.
    if (st.role === "coach" && st.active !== false && !active) { await q("delete from sessions where user_id=$1", [st.id]); tellCoaches(u.gym_id, "inactive", u.name, st.name); }
    res.json({ ok: true });
  }));

  // ---------- memberships ----------
  const PERIODS = ["month", "week", "year", "term", "class", "once"];
  // Website prices for private lessons (same test as the app's private-price chips) aren't membership plans.
  const PRIV_RATE = /private|\b1[\s-]?on[\s-]?1\b|one[\s-]on[\s-]one|personal train|\bpt\b/i;
  function readPlan(b) {
    const name = clean(b.name, 80); if (!name) fail(400, "Give the plan a name.");
    const price = intOr(b.priceCents, NaN); if (!Number.isFinite(price) || price < 0 || price > 1e8) fail(400, "Enter the price.");
    const period = PERIODS.includes(b.period) ? b.period : "month";
    const cpw = b.classesPerWeek === null || b.classesPerWeek === undefined || b.classesPerWeek === "" ? null : Math.min(30, Math.max(1, intOr(b.classesPerWeek, 0)));
    // What a private lesson costs someone on this plan: left out keeps it, null or "" means the slot's price.
    const priv = b.privateCents === undefined ? undefined : readPrivate(b.privateCents, "Enter the plan's private lesson price, or leave it empty.");
    return { name, price, period, cpw, active: b.active !== false, priv };
  }
  api.get("/coach/plans", wrap(async (req, res) => { const u = needHead(req); res.json({ plans: (await plansOf(u.gym_id)).map(planOut) }); }));
  api.post("/coach/plans", wrap(async (req, res) => {
    const u = needHead(req), p = readPlan(req.body || {});
    const r = await q("insert into plans(gym_id,name,price_cents,period,classes_per_week,active,private_price_cents) values($1,$2,$3,$4,$5,$6,$7) returning *", [u.gym_id, p.name, p.price, p.period, p.cpw, p.active, p.priv ?? null]);
    res.status(201).json({ plan: planOut(r.rows[0]) });
  }));
  api.patch("/coach/plans/:id", wrap(async (req, res) => {
    const u = needHead(req), p = readPlan(req.body || {});
    const r = await q("update plans set name=$1,price_cents=$2,period=$3,classes_per_week=$4,active=$5,private_price_cents=case when $8 then $9::int else private_price_cents end where id=$6 and gym_id=$7 returning *",
      [p.name, p.price, p.period, p.cpw, p.active, intOr(req.params.id, 0), u.gym_id, p.priv !== undefined, p.priv ?? null]);
    if (!r.rows[0]) fail(404, "That plan doesn't exist.");
    res.json({ plan: planOut(r.rows[0]) });
  }));
  // Turn the prices imported from the gym's website into plans (skips names that already exist).
  api.post("/coach/plans/from-rates", wrap(async (req, res) => {
    const u = needHead(req);
    const g = (await q("select profile from gyms where id=$1", [u.gym_id])).rows[0];
    const have = new Set((await plansOf(u.gym_id)).map((p) => p.name.toLowerCase()));
    let added = 0;
    for (const r of (g.profile && g.profile.rates) || []) {
      if (!r.name || have.has(r.name.toLowerCase()) || !PERIODS.includes(r.period) || PRIV_RATE.test(`${r.name} ${r.note || ""}`)) continue;
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
    const head = isHead(u), collected = head ? Number((await q("select coalesce(sum(amount_cents),0) as s from payments where gym_id=$1 and status='confirmed' and paid_on >= date_trunc('month', current_date)", [u.gym_id])).rows[0].s) : 0;
    const unpaid = studs.filter((p) => p.feeCents > 0 && p.paidThisMonthCents < p.feeCents && p.planStatus !== "paused" && p.planStatus !== "cancelled");
    const mix = plans.filter((p) => p.active).map((p) => { const m = studs.filter((s) => s.planId === String(p.id) && s.planStatus !== "cancelled"); return { id: String(p.id), name: p.name, members: m.length, monthlyCents: m.length * (monthly(p) || 0) }; });
    res.json({
      tz, currency: u.currency,
      kpis: { active: studs.length, visits28, prev28, perWeek: Math.round((visits28 / 4) * 10) / 10, perMember: studs.length ? Math.round((visits28 / 4 / studs.length) * 10) / 10 : 0,
        newMembers30: studs.filter((p) => now - new Date(p.joined).getTime() < 30 * DAY).length,
        retention: { base: old.length, retained: old.filter((p) => p.visits.d28 > 0).length } },
      weeks: weeks.map((w) => ({ wk: w.wk, visits: w.visits, people: w.people.size })),
      segments: seg, slots: slotList,
      ...(head ? { revenue: { collected, expected, unpaid: unpaid.map((p) => ({ id: p.id, name: p.name, dueCents: p.feeCents - p.paidThisMonthCents })) },
        plans: mix, noPlan: studs.filter((p) => !p.planId).length } : {}),
      students: studs.map((p) => ({ id: p.id, name: p.name, phone: p.phone, belt: p.belt, stripes: p.stripes, joined: p.joined, ...(head ? { planName: p.planName, planStatus: p.planStatus } : {}),
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
    const coach = isCoach(u);
    const cs = (await q("select * from competitions where gym_id=$1 and coalesce(ends_on, starts_on) >= current_date - 60 order by starts_on limit 100", [u.gym_id])).rows;
    const ent = cs.length ? (await q(`select k.*, u.name, u.belt, u.stripes from competitors k join users u on u.id=k.user_id where k.competition_id = any($1) order by u.name`, [cs.map((c) => c.id)])).rows : [];
    res.json({ competitions: cs.map((c) => {
      const mine = ent.find((e) => e.competition_id === c.id && String(e.user_id) === String(u.id));
      // Students see the team only when the gym shows who's coming, and never a teammate's weight.
      const people = ent.filter((e) => e.competition_id === c.id && (coach || (e.status === "entered" && (u.show_attendees !== false || String(e.user_id) === String(u.id)))));
      return { ...compOut(c), entered: ent.filter((e) => e.competition_id === c.id && e.status === "entered").length, requested: ent.filter((e) => e.competition_id === c.id && e.status === "requested").length,
        mine: mine ? { status: mine.status, division: mine.division, weight: mine.weight, note: mine.note, coachNote: mine.coach_note, result: mine.result } : null,
        team: people.map((e) => ({ id: String(e.user_id), name: coach ? e.name : shortName(e.name), belt: e.belt, stripes: e.stripes, status: e.status, division: e.division, weight: coach || String(e.user_id) === String(u.id) ? e.weight : "", result: e.result, me: String(e.user_id) === String(u.id),
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
    let sent = 0; const failed = [], noEmail = [];
    for (const p of to) {
      if (!p.email) { noEmail.push(p.name); continue; }
      if (limited("msg:" + u.gym_id, 300, 24 * 3600e3)) { failed.push(p.name); continue; }
      try { await mail.send({ to: p.email, replyTo: u.email, ...mail.templates.message(p.name, u.name, u.gym_name, subject, text) }); sent++; }
      catch (e) { console.warn("mail:", e.message); failed.push(p.name); }
    }
    res.json({ sent, failed, noEmail });
  }));

  // The head coach closes the gym. Everything it kept goes: classes and bookings, plans, payments and proofs, competitions, notices,
  // and the students added by a coach who never signed up. People with their own accounts keep them, with no gym.
  api.delete("/coach/gym", wrap(async (req, res) => {
    const u = needCoach(req); if (!isHead(u)) fail(403, "Only the head coach can delete the gym.");
    if (!u.pass_hash || !(await bcrypt.compare(String(req.body?.password || ""), u.pass_hash))) fail(401, "That password isn't right.");
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("delete from users where gym_id=$1 and pass_hash is null", [u.gym_id]);
      await db.query(`update users set gym_id=null, role='student', active=true, notes='', monthly_fee_cents=null, plan_id=null, plan_status='active', plan_started=null,
        parent_name='', pay_ref=null, gym_joined_at=null where gym_id=$1`, [u.gym_id]);
      await db.query("delete from gyms where id=$1", [u.gym_id]);
      await db.query("commit");
    } catch (e) { await db.query("rollback").catch(() => {}); throw e; } finally { db.release(); }
    res.json({ ok: true, me: me(await loadMe(u.id)) });
  }));
  api.patch("/coach/gym", wrap(async (req, res) => {
    const u = needCoach(req), b = req.body || {};
    const name = b.name !== undefined ? clean(b.name, 100) : u.gym_name;
    if (!name) fail(400, "Enter your gym's name.");
    if (b.monthlyFeeCents !== undefined && !isHead(u)) fail(403, "Only the head coach can change fees.");
    const fee = b.monthlyFeeCents !== undefined ? Math.max(0, intOr(b.monthlyFeeCents, 0)) : u.gym_fee;
    const show = b.showAttendees !== undefined ? !!b.showAttendees : u.show_attendees !== false;
    const invite = b.studentsInvite !== undefined ? !!b.studentsInvite : u.students_invite !== false;
    const tz = b.timezone !== undefined ? await validTz(b.timezone) || tzOf(u) : tzOf(u);
    const wa = b.waPhone !== undefined ? cleanPhone(b.waPhone) : u.wa_phone || "";
    if (b.brandAccent !== undefined) { const a = String(b.brandAccent || ""); await q("update gyms set brand = brand || $1 where id=$2", [{ accent: /^#[0-9a-f]{6}$/i.test(a) ? a.toLowerCase() : null }, u.gym_id]); }
    if (b.setup && typeof b.setup === "object") { const st = {}; for (const k of ["welcomed", "assistantUsed", "dismissed"]) if (b.setup[k] !== undefined) st[k] = !!b.setup[k]; await q("update gyms set setup = setup || $1 where id=$2", [st, u.gym_id]); }
    if (b.waPhone !== undefined && String(b.waPhone).trim() && !wa) fail(400, "That doesn't look like a phone number.");
    await q("update gyms set name=$1, monthly_fee_cents=$2, show_attendees=$3, timezone=$4, students_invite=$5, wa_phone=$6 where id=$7", [name, fee, show, tz, invite, wa, u.gym_id]);
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
      // 100 invite emails per gym, per coach and per address a day (gyms are free to start, so one person could start several)
      const keys = ["inv:" + u.gym_id, "inv-c:" + u.id, "inv-ip:" + clientIp(req)];
      if (keys.some((k) => over(k, 100))) { failed.push(e); continue; }
      keys.forEach((k) => limited(k, Infinity, 24 * 3600e3));
      try { await mail.send({ to: e, ...mail.templates.invite(u.name, u.gym_name, mail.appUrl() + "/app/?join=" + u.student_code) }); sent++; }
      catch (err) { console.warn("mail:", err.message); failed.push(e); }
    }
    res.json({ sent, already: [...have], failed });
  }));
  // The head coach hands the role (money, payment emails) to another active coach in the gym.
  api.post("/coach/head", wrap(async (req, res) => {
    const u = needHead(req), to = await ownStudent(u, req.body?.userId);
    if (String(to.id) === String(u.id)) fail(400, "You're already the head coach.");
    if (to.role !== "coach" || !to.active || !to.pass_hash) fail(400, "Pick an active coach who's on the app.");
    await q("update gyms set head_coach_id=$1 where id=$2", [to.id, u.gym_id]);
    if (to.email) mail.sendLater({ to: to.email, ...mail.templates.headCoach(first(to.name), u.gym_name, u.name) });
    res.json({ me: me(await loadMe(u.id)) });
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
  // The first screen checks a gym code before sign-up ("Joining Lions BJJ"). Just the name; an unknown code is { gym: null }.
  api.get("/gyms/by-code/:code", wrap(async (req, res) => {
    if (limited("code:" + clientIp(req), 30, 15 * 60e3)) fail(429, "Too many tries. Wait 15 minutes and try again.");
    const c = clean(req.params.code, 20).toUpperCase();
    const g = c ? (await q("select name, (coach_code=$1) as coach from gyms where student_code=$1 or coach_code=$1", [c])).rows[0] : null;
    res.json({ gym: g ? { name: g.name, coach: !!g.coach } : null });
  }));
  api.get("/gyms/:id/logo", wrap(async (req, res) => {
    const r = await q("select logo, logo_type from gyms where id=$1 and logo is not null", [intOr(req.params.id, 0)]);
    if (!r.rows[0]) return res.status(404).json({ error: "No logo." });
    res.set({ "Content-Type": r.rows[0].logo_type, "Cache-Control": "public, max-age=31536000, immutable", "Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff" });
    res.send(r.rows[0].logo);
  }));
  // Read a gym website and return what was found. Nothing is saved until the coach confirms.
  // Website import in the background: start it, keep using the app, review the result when it's ready.
  const jobs = new Map(); // gym id -> running promise (one at a time per gym)
  api.post("/coach/import/start", wrap(async (req, res) => {
    const u = needCoach(req), url = clean(req.body?.url, 500);
    if (!url) fail(400, "Enter your gym's website address.");
    if (!importer.siteCandidates(url).length) fail(400, "That doesn't look like a web address. Try something like yourgym.co.za");
    if (jobs.has(u.gym_id)) return res.status(202).json({ job: (await q("select import_job from gyms where id=$1", [u.gym_id])).rows[0].import_job });
    if (limited("imp:" + u.gym_id, 12, 60 * 60e3)) fail(429, "That's a lot of imports. Try again in an hour.");
    const job = { status: "running", url, startedAt: new Date().toISOString() };
    await q("update gyms set import_job=$1 where id=$2", [job, u.gym_id]);
    const run = (async () => {
      let done;
      try { const r = await importer.importSite(url, { log: (m) => console.warn(m) }); done = { ...job, status: "done", finishedAt: new Date().toISOString(), result: r }; }
      catch (e) { done = { ...job, status: "error", finishedAt: new Date().toISOString(), error: e instanceof importer.ImportError ? e.message : "Couldn't read that site just now. Try again in a minute." }; if (!(e instanceof importer.ImportError)) console.error("import job:", e.message); }
      await q("update gyms set import_job=$1 where id=$2", [done, u.gym_id]).catch(() => {});
    })().finally(() => jobs.delete(u.gym_id));
    jobs.set(u.gym_id, run);
    res.status(202).json({ job });
  }));
  api.get("/coach/import/job", wrap(async (req, res) => {
    const u = needCoach(req); let job = (await q("select import_job from gyms where id=$1", [u.gym_id])).rows[0].import_job;
    // a job left "running" by a restart is over
    if (job && job.status === "running" && !jobs.has(u.gym_id) && Date.now() - new Date(job.startedAt).getTime() > 5 * 60e3) { job = { ...job, status: "error", error: "That import was interrupted. Try again." }; await q("update gyms set import_job=$1 where id=$2", [job, u.gym_id]); }
    res.json({ job: job || null });
  }));
  api.delete("/coach/import/job", wrap(async (req, res) => { const u = needCoach(req); await q("update gyms set import_job=null where id=$1", [u.gym_id]); res.json({ ok: true }); }));
  // The coach assistant: plain-language requests ("update my bank details", "add Thabo, blue belt") turned into changes.
  api.post("/coach/assistant", wrap(async (req, res) => {
    const u = needCoach(req);
    // Switched off in the app for now; JF_ASSISTANT=1 turns the endpoint back on.
    if (process.env.JF_ASSISTANT !== "1" || !ai.getClient()) fail(503, "The assistant isn't switched on yet.");
    if (limited("ast:" + u.id, 60, 60 * 60e3)) fail(429, "That's a lot of requests. Give it a few minutes.");
    const msgs = (Array.isArray(req.body?.messages) ? req.body.messages : []).slice(-12)
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: clean(m.text, 2000) })).filter((m) => m.content);
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") fail(400, "Say what you'd like to do.");
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    const out = await assistant.run({ u, q, msgs, helpers: { ownStudent, readPaySettings, tellHead, head: isHead(u), bankChanged, todayIn, payRef, cleanPhone, isDay, isEmail, clean, intOr, plansOf, monthly, readClass, CLASS_COLS, classVals, BELTS, METHODS, tzOf } });
    await q("update gyms set setup = setup || $1 where id=$2", [{ assistantUsed: true }, u.gym_id]);
    res.json(out);
  }));
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
    if (!fee && isHead(u)) { const m = profile.rates.find((r) => r.period === "month" && (!r.currency || r.currency === (u.currency || "ZAR"))); if (m) fee = Math.round(m.price * 100); }
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
      await q(`insert into classes(${CLASS_COLS}) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, classVals(u, c));
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
      method: p.method || "", status: p.status || "confirmed", hasProof: !!p.has_proof, months: p.months || 1,
      packId: p.pack_id ? String(p.pack_id) : null, packLessons: p.pack_lessons || null, packName: p.pack_name || null,
      read: p.ai ? { amountCents: a.amountCents || 0, date: a.date || "", reference: a.reference || "", payer: a.payer || "", bank: a.bank || "", match: a.match || "", isPayment: a.method === "claude" ? a.isPayment !== false : true, duplicateOf: a.duplicateOf || null, otherRef: a.otherRef || null, reading: !!a.reading, error: a.error ? "Couldn't read it automatically." : "" } : null };
  }
  const PAY_COLS = "p.*, exists(select 1 from pop_files f where f.payment_id=p.id) as has_proof, (select name from packs k where k.id=p.pack_id) as pack_name";
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
  async function addProof({ u, gymId, userId, read, source, files, text, from, subject, note, method, pack }) {
    let match = { userId: userId || null, how: userId ? "student" : "" };
    if (!userId && read) match = pop.matchStudent(read, text || "", await gymStudents(gymId));
    const amount = (read && read.amountCents) || 0, paidOn = (read && read.date) || (await todayIn(u || { timezone: null }));
    const reference = clean((read && read.reference) || "", 140);
    const dup = amount ? (await q(`select id from payments where gym_id=$1 and amount_cents=$2 and paid_on=$3 and status<>'rejected' and (($4::bigint is not null and user_id=$4) or ($5<>'' and reference=$5)) limit 1`,
      [gymId, amount, paidOn, match.userId, reference])).rows[0] : null;
    const ai = read ? { ...read, match: match.how, duplicateOf: dup ? String(dup.id) : null } : null;
    const r = await q(`insert into payments(gym_id,user_id,amount_cents,currency,paid_on,reference,note,source,email_from,email_subject,status,method,ai,submitted_by,pack_id,pack_lessons,pack_months)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13,$14,$15,$16) returning id`,
      [gymId, match.userId, amount, (u && u.currency) || "ZAR", paidOn, reference, clean(note, 500), source, from ? clean(from, 200) : null, subject ? clean(subject, 200) : null, method || "eft", ai, u ? u.id : null,
        pack ? pack.id : null, pack ? pack.lessons : null, pack ? pack.expiry_months : null]);
    for (const f of files || []) await q("insert into pop_files(payment_id,name,type,data) values($1,$2,$3,$4)", [r.rows[0].id, f.name, f.type, f.data]);
    return (await q(`select ${PAY_COLS} from payments p where p.id=$1`, [r.rows[0].id])).rows[0];
  }
  const aiClient = () => importer.getClient ? importer.getClient() : null;

  // ---------- how students pay ----------
  const PAY_FIELDS = { holder: 80, bank: 60, account: 30, branch: 20, type: 30, link: 400, note: 300 };
  function readPaySettings(b) {
    const out = {}; for (const [k, n] of Object.entries(PAY_FIELDS)) out[k] = clean(b[k], n);
    out.dueDay = Math.min(28, Math.max(1, intOr(b.dueDay, 1)));
    if (out.link && !/^https:\/\//i.test(out.link)) fail(400, "The payment link must start with https://");
    out.account = out.account.replace(/[^\d ]/g, ""); out.branch = out.branch.replace(/[^\d ]/g, "");
    return out;
  }
  // Who the coaches are changed: tell every active coach, so a change nobody expected gets noticed.
  function tellCoaches(gymId, kind, who, detail) {
    q("select name, email from users where gym_id=$1 and role='coach' and active and email is not null", [gymId])
      .then(({ rows }) => { for (const c of rows) mail.sendLater({ to: c.email, ...mail.templates.gymChange(kind, first(c.name), who, detail) }); })
      .catch((e) => console.warn("tell coaches:", e.message));
  }
  // Money news (bank details or PayFast changed, a proof to check, a card payment in) goes to the head coach only.
  function toHead(gymId, make) {
    headCoach(gymId).then((h) => { if (h && h.email) mail.sendLater({ to: h.email, ...make(first(h.name)) }); }).catch((e) => console.warn("tell head coach:", e.message));
  }
  const tellHead = (gymId, kind, who, detail) => toHead(gymId, (name) => mail.templates.gymChange(kind, name, who, detail));
  const BANK_KEYS = ["holder", "bank", "account", "branch", "type", "link"];
  const bankChanged = (was, now) => BANK_KEYS.some((k) => (was[k] || "") !== (now[k] || ""));
  const popAddress = (tok) => `pop-${tok}@${process.env.POP_DOMAIN || "jitsflow.com"}`;
  api.get("/coach/gym/pay", wrap(async (req, res) => {
    const u = needHead(req), g = (await q("select pay, pop_token, pop_notice from gyms where id=$1", [u.gym_id])).rows[0];
    let tok = g.pop_token;
    if (!tok) { tok = Array.from(crypto.randomBytes(10), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join(""); await q("update gyms set pop_token=$1 where id=$2 and pop_token is null", [tok, u.gym_id]); tok = (await q("select pop_token from gyms where id=$1", [u.gym_id])).rows[0].pop_token; }
    res.json({ pay: g.pay || {}, popAddress: popAddress(tok), popReady: !!process.env.INBOUND_SECRET, popNotice: g.pop_notice || null, accessFeeCents: u.access_fee_cents || 0, accessMode: u.access_mode || "fee", privatePlanIds: (u.private_plan_ids || []).map(String), privateCents: u.gym_private_cents ?? null });
  }));
  api.patch("/coach/gym/pay", wrap(async (req, res) => {
    const u = needHead(req), pay = readPaySettings(req.body || {});
    const was = (await q("select pay from gyms where id=$1", [u.gym_id])).rows[0].pay || {};
    await q("update gyms set pay = coalesce(pay,'{}'::jsonb) || $1 where id=$2", [pay, u.gym_id]); // keeps switches like cardSoon
    if (bankChanged(was, pay)) tellHead(u.gym_id, "bank", u.name);
    res.json({ pay });
  }));
  // The PayFast button students see before card payments are live: it says "coming soon".
  api.patch("/coach/gym/pay-soon", wrap(async (req, res) => {
    const u = needHead(req), on = !!(req.body && req.body.on);
    await q("update gyms set pay = coalesce(pay,'{}'::jsonb) || $1 where id=$2", [{ cardSoon: on }, u.gym_id]);
    res.json({ cardSoon: on });
  }));
  // What clients who only take private lessons need: mode 'none' (just the private's price), 'fee' (an access fee each month
  // they book one; 0 switches it off) or 'membership' (one of planIds to book a private). No mode is 'fee', as before modes.
  // The fee and plans not in use are kept, so switching back brings them back.
  api.patch("/coach/gym/access-fee", wrap(async (req, res) => {
    const u = needHead(req), b = req.body || {}, mode = b.mode === undefined ? "fee" : b.mode;
    if (!["none", "fee", "membership"].includes(mode)) fail(400, "Pick what clients who only take private lessons pay.");
    let c = u.access_fee_cents || 0, ids = (u.private_plan_ids || []).map(String);
    if (mode === "fee" || b.accessFeeCents !== undefined) { c = intOr(b.accessFeeCents, NaN); if (!Number.isFinite(c) || c < 0 || c > 1e7) fail(400, "Enter the access fee, or 0 to switch it off."); }
    if (mode === "membership" || b.planIds !== undefined) {
      ids = [...new Set((Array.isArray(b.planIds) ? b.planIds : []).map((x) => intOr(x, 0)).filter(Boolean))].slice(0, 50);
      if ((await q("select id from plans where gym_id=$1 and id = any($2::bigint[])", [u.gym_id, ids])).rows.length !== ids.length) fail(404, "That plan doesn't exist.");
      if (mode === "membership" && !ids.length) fail(400, "Tick the plans that allow private lessons.");
    }
    await q("update gyms set access_mode=$1, access_fee_cents=$2, private_plan_ids=$3::bigint[] where id=$4", [mode, c, ids, u.gym_id]);
    res.json({ accessMode: mode, accessFeeCents: c, privatePlanIds: ids.map(String) });
  }));
  // What a private lesson costs a client without a membership (null: the slot's own price). Bookings already made keep their price.
  api.patch("/coach/gym/private-price", wrap(async (req, res) => {
    const u = needHead(req), c = readPrivate(req.body?.privateCents ?? null, "Enter the private lesson price, or leave it empty.");
    await q("update gyms set private_price_cents=$1 where id=$2", [c, u.gym_id]);
    res.json({ privateCents: c });
  }));
  // Private-lesson packs: "10 private lessons" for R4500, optionally expiring some months after they're bought.
  function readPack(b) {
    const name = clean(b.name, 80); if (!name) fail(400, "Give the pack a name, like 10 private lessons.");
    const lessons = intOr(b.lessons, 0); if (lessons < 1 || lessons > 100) fail(400, "How many lessons are in the pack? From 1 to 100.");
    const price = intOr(b.priceCents, NaN); if (!Number.isFinite(price) || price < 500 || price > 5e6) fail(400, "Enter the pack's price, from R5.");
    const exp = b.expiryMonths === null || b.expiryMonths === undefined || b.expiryMonths === "" || Number(b.expiryMonths) === 0 ? null : Math.min(36, Math.max(1, intOr(b.expiryMonths, 0)));
    return { name, lessons, price, exp, active: b.active !== false };
  }
  api.get("/coach/packs", wrap(async (req, res) => { const u = needHead(req); res.json({ packs: (await q("select * from packs where gym_id=$1 order by active desc, lessons, price_cents", [u.gym_id])).rows.map(packOut) }); }));
  api.post("/coach/packs", wrap(async (req, res) => {
    const u = needHead(req), k = readPack(req.body || {});
    const r = await q("insert into packs(gym_id,name,lessons,price_cents,expiry_months,active) values($1,$2,$3,$4,$5,$6) returning *", [u.gym_id, k.name, k.lessons, k.price, k.exp, k.active]);
    res.status(201).json({ pack: packOut(r.rows[0]) });
  }));
  api.patch("/coach/packs/:id", wrap(async (req, res) => {
    const u = needHead(req), k = readPack(req.body || {});
    const r = await q("update packs set name=$1,lessons=$2,price_cents=$3,expiry_months=$4,active=$5 where id=$6 and gym_id=$7 returning *", [k.name, k.lessons, k.price, k.exp, k.active, intOr(req.params.id, 0), u.gym_id]);
    if (!r.rows[0]) fail(404, "That private-lesson pack doesn't exist.");
    res.json({ pack: packOut(r.rows[0]) });
  }));
  // A new forwarding address (the old one stops working), e.g. if it leaked.
  api.post("/coach/gym/pay/new-address", wrap(async (req, res) => {
    const u = needHead(req), tok = Array.from(crypto.randomBytes(10), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
    await q("update gyms set pop_token=$1, pop_notice=null where id=$2", [tok, u.gym_id]);
    res.json({ popAddress: popAddress(tok) });
  }));

  // ---------- students: what's due, where to pay, send proof ----------
  api.get("/me/pay", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id || u.role !== "student") return res.json({ pay: null });
    const g = (await q("select pay, payfast from gyms where id=$1", [u.gym_id])).rows[0], today = await todayIn(u);
    const sums = (await q(`select coalesce(sum(${SHARE}) filter (where status='confirmed'),0) as paid, coalesce(sum(${SHARE}) filter (where status='pending'),0) as pending
      from payments where user_id=$1 and gym_id=$2 and ${FEES} and ${covers("$3::timestamp")}`, [u.id, u.gym_id, today.slice(0, 7) + "-01"])).rows[0];
    const recent = (await q(`select ${PAY_COLS} from payments p where p.user_id=$1 and p.gym_id=$2 and p.paid_on > current_date - 200 order by p.paid_on desc, p.id desc limit 12`, [u.id, u.gym_id])).rows;
    const plan = u.plan_id ? (await q("select * from plans where id=$1", [u.plan_id])).rows[0] : null, pv = (await privatesOf(u.gym_id, [u.id], tzOf(u), today))[u.id];
    const d = duesFor(u, plan, u, pv, today.slice(0, 7)), packs = (await q("select * from packs where gym_id=$1 and active order by lessons, price_cents", [u.gym_id])).rows.map(packOut);
    const pa = await privateAccess(u);
    res.json({ pay: { dueCents: d.dueCents, privateAccess: pa, membershipCents: d.membershipCents, accessCents: d.accessCents, privatesCents: d.privatesCents, privates: d.privates,
      paidCents: Number(sums.paid), pendingCents: Number(sums.pending), currency: u.currency || "ZAR", privatesLeft: privOut(pv), packs,
      reference: await payRef(u.id), bank: g.pay || {}, card: !!pfLive(pfOf(g)), payments: recent.map((p) => { const o = payOut(p); delete o.read; delete o.emailFrom; delete o.emailSubject; return o; }) } });
  }));
  api.post("/me/pay/proof", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id || u.role !== "student") fail(403, "Join a gym first.");
    if (limited("pop-u:" + u.id, 20, 24 * 3600e3)) fail(429, "That's a lot of uploads today. Ask your coach if something's wrong.");
    const b = req.body || {}, file = proofFile(b), pack = b.packId ? await packIn(u.gym_id, b.packId, true) : null;
    const typed = intOr(b.amountCents, 0) || (pack ? pack.price_cents : 0), on = isDay(b.paidOn) ? b.paidOn : "";
    const row = await addProof({ u, gymId: u.gym_id, userId: u.id, read: { amountCents: typed > 0 && typed < 1e8 ? typed : 0, date: on, reference: await payRef(u.id), reading: true }, source: "student", files: [file], note: b.note, method: "eft", pack });
    res.status(201).json({ payment: payOut(row) });
    toHead(u.gym_id, (name) => mail.templates.proofIn(name, u.name, row.amount_cents ? fmtMoney(row.amount_cents, u.currency) : ""));
    // Read it in the background: the student doesn't need to wait, the coach sees what it says.
    const c = aiClient();
    setImmediate(async () => {
      try {
        const read = await pop.readPop({ client: c, files: [file] });
        const amount = row.amount_cents || read.amountCents || 0, mismatch = row.amount_cents && read.amountCents && read.amountCents !== row.amount_cents;
        const otherRef = pop.refsIn(read.reference).find((r) => r !== (u.pay_ref || "")) || null;
        const paidOn = on || read.date || row.paid_on;
        // Now the amount and date are known: is this the same payment as one already on the list (e.g. the coach uploaded it too)?
        const dup = amount ? (await q(`select id from payments where gym_id=$1 and id<>$2 and amount_cents=$3 and paid_on=$4 and status<>'rejected' and (user_id=$5 or ($6<>'' and reference=$6)) limit 1`,
          [u.gym_id, row.id, amount, paidOn, u.id, clean(read.reference || "", 140)])).rows[0] : null;
        await q("update payments set ai=$1, amount_cents=$2, paid_on=$3 where id=$4 and status='pending'",
          [{ ...read, match: "student", typedCents: row.amount_cents || 0, amountMismatch: !!mismatch, otherRef, duplicateOf: dup ? String(dup.id) : null }, amount, paidOn, row.id]);
      } catch (e) { console.error("pop read:", e.message); await q("update payments set ai = coalesce(ai,'{}'::jsonb) - 'reading' || '{\"error\":\"read failed\"}' where id=$1", [row.id]).catch(() => {}); }
    });
  }));
  // The proof file itself: for the gym's coaches and the student who sent it.
  api.get("/payments/:id/proof", wrap(async (req, res) => {
    const u = needUser(req), p = (await q("select * from payments where id=$1", [intOr(req.params.id, 0)])).rows[0];
    if (!p || !(u.gym_id === p.gym_id && (isHead(u) || u.id === p.user_id))) fail(404, "Not found.");
    const f = (await q("select * from pop_files where payment_id=$1 order by id limit 1", [p.id])).rows[0]; if (!f) fail(404, "No proof attached.");
    res.set({ "Content-Type": f.type, "Content-Disposition": `inline; filename="${f.name.replace(/[^\w.\- ]/g, "_")}"`, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'", "Cache-Control": "private, no-store" });
    res.send(f.data);
  }));

  // ---------- coach: payments ----------
  api.get("/coach/payments", wrap(async (req, res) => {
    const u = needHead(req);
    const r = await q(`select ${PAY_COLS} from payments p where p.gym_id=$1 and (p.status<>'rejected' or p.created_at > now() - interval '30 days') order by (p.status='pending') desc, p.paid_on desc, p.id desc limit 400`, [u.gym_id]);
    res.json({ payments: r.rows.map(payOut) });
  }));
  const fmtMoney = (c, currency) => new Intl.NumberFormat("en-ZA", { style: "currency", currency: currency || "ZAR" }).format(c / 100);
  const coverMonths = (v) => Math.min(24, Math.max(1, intOr(v, 1)));
  api.post("/coach/payments", wrap(async (req, res) => {
    const u = needHead(req), b = req.body || {};
    const amount = intOr(b.amountCents, NaN);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) fail(400, "Enter the amount paid.");
    const paidOn = isDay(b.paidOn) ? b.paidOn : fail(400, "Pick the date it was paid.");
    let userId = null;
    if (b.userId) userId = (await ownStudent(u, b.userId)).id;
    const method = METHODS.includes(b.method) ? b.method : "", pack = b.packId ? await packIn(u.gym_id, b.packId) : null, months = pack ? 1 : coverMonths(b.months);
    const r = await q(`insert into payments(gym_id,user_id,amount_cents,currency,paid_on,reference,note,source,method,submitted_by,months,pack_id,pack_lessons,pack_months) values($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9,$10,$11,$12,$13) returning id`,
      [u.gym_id, userId, amount, u.currency || "ZAR", paidOn, clean(b.reference, 140), clean(b.note, 500), method, u.id, months, pack ? pack.id : null, pack ? pack.lessons : null, pack ? pack.expiry_months : null]);
    res.status(201).json({ payment: payOut((await q(`select ${PAY_COLS} from payments p where p.id=$1`, [r.rows[0].id])).rows[0]) });
  }));
  // Coach uploads a proof (e.g. a screenshot a student WhatsApped them): read it now so they can confirm straight away.
  api.post("/coach/payments/proof", wrap(async (req, res) => {
    const u = needHead(req), file = proofFile(req.body || {});
    // Each upload is a Claude read and up to 8 MB stored: cap them per gym a day.
    if (limited("pop-c:" + u.gym_id, 50, 24 * 3600e3)) fail(429, "That's a lot of uploads today. Record the rest by hand, or try again tomorrow.");
    const read = await pop.readPop({ client: aiClient(), files: [file] });
    const row = await addProof({ u, gymId: u.gym_id, read, source: "upload", files: [file], method: "eft" });
    res.status(201).json({ payment: payOut(row) });
  }));
  // Edit, match, confirm or reject. Only the fields sent change.
  api.patch("/coach/payments/:id", wrap(async (req, res) => {
    const u = needHead(req), b = req.body || {};
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
    // A pack: sent as an id to pick one (its lessons and expiry are copied now), null or "" for an ordinary payment, left out to keep it.
    let pk = [p.pack_id, p.pack_lessons, p.pack_months];
    if (b.packId !== undefined) { const k = b.packId ? (String(b.packId) === String(p.pack_id) ? null : await packIn(u.gym_id, b.packId)) : null; if (k) pk = [k.id, k.lessons, k.expiry_months]; else if (!b.packId) pk = [null, null, null]; }
    await q("update payments set user_id=$1, amount_cents=$2, paid_on=$3, status=$4, method=$5, reference=$6, note=$7, months=$8, pack_id=$10, pack_lessons=$11, pack_months=$12 where id=$9",
      [userId, amount, paidOn, status, method, b.reference === undefined ? p.reference : clean(b.reference, 140), b.note === undefined ? p.note : clean(b.note, 500), pk[1] ? 1 : b.months === undefined ? p.months : coverMonths(b.months), p.id, ...pk]);
    res.json({ payment: payOut((await q(`select ${PAY_COLS} from payments p where p.id=$1`, [p.id])).rows[0]) });
  }));
  api.delete("/coach/payments/:id", wrap(async (req, res) => {
    const u = needHead(req);
    const r = await q("delete from payments where id=$1 and gym_id=$2", [intOr(req.params.id, 0), u.gym_id]);
    if (!r.rowCount) fail(404, "That payment doesn't exist.");
    res.json({ ok: true });
  }));

  // ---------- coach: money overview for a month ----------
  // Who owes what this month, what came in, and the last six months. Expected uses each student's current fee.
  // Each row has dues(month): what they owe that month (membership, access fee, privates with no credit).
  async function moneyRows(u, month) {
    const plans = await plansOf(u.gym_id), pm = Object.fromEntries(plans.map((p) => [String(p.id), p]));
    const ppl = (await q(`select id, name, parent_name, email, phone, pass_hash is null as offline, claim_token, monthly_fee_cents, plan_id, plan_status, pay_ref, created_at from users
      where gym_id=$1 and role='student' and active order by name`, [u.gym_id])).rows;
    const priv = await privatesOf(u.gym_id, ppl.map((x) => x.id), tzOf(u), await todayIn(u));
    return ppl.map((x) => { const plan = pm[String(x.plan_id)] || null; const dues = (m) => duesFor(x, plan, u, priv[x.id], m); return { ...x, plan, dues, fee: dues(month).dueCents }; });
  }
  // The lines that make up what someone owes, for reminders.
  const dueParts = (d, currency) => (d.accessCents || d.privatesCents ? [d.membershipCents && `Membership: ${fmtMoney(d.membershipCents, currency)}`, d.accessCents && `Access fee: ${fmtMoney(d.accessCents, currency)}`,
    ...d.privates.map((o) => `Private lesson, ${new Date(o.startsAt).toLocaleDateString("en-ZA", { day: "numeric", month: "short" })}: ${fmtMoney(o.priceCents, currency)}`)].filter(Boolean) : []);
  api.get("/coach/money", wrap(async (req, res) => {
    const u = needHead(req), today = await todayIn(u);
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month || "") ? req.query.month : today.slice(0, 7);
    const start = month + "-01", next = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)).toISOString().slice(0, 10);
    const rows = await moneyRows(u, month);
    for (const x of rows) { if (!x.pay_ref) x.pay_ref = await payRef(x.id); if (x.offline) x.claimUrl = await claimUrl(u, x); }
    const sums = Object.fromEntries((await q(`select user_id, coalesce(sum(${SHARE}) filter (where status='confirmed'),0) as paid, coalesce(sum(${SHARE}) filter (where status='pending'),0) as pending
      from payments where gym_id=$1 and user_id is not null and ${FEES} and ${covers("$2::timestamp")} group by user_id`, [u.gym_id, start])).rows.map((r) => [String(r.user_id), r]));
    const lastEver = Object.fromEntries((await q("select user_id, max(paid_on) as last from payments where gym_id=$1 and status='confirmed' and user_id is not null group by user_id", [u.gym_id])).rows.map((r) => [String(r.user_id), r.last]));
    const inMonth = rows.filter((x) => new Date(x.created_at).toISOString().slice(0, 10) < next);
    const students = inMonth.map((x) => { const s = sums[String(x.id)] || {}, d = x.dues(month); return { id: String(x.id), name: x.name, parentName: x.parent_name || "", email: x.email || "", phone: x.phone || "", offline: x.offline, plan: x.plan ? x.plan.name : null,
      feeCents: x.fee, membershipCents: d.membershipCents, accessCents: d.accessCents, privatesCents: d.privatesCents, privates: d.privates, planStatus: x.plan_status, paidCents: Number(s.paid || 0), pendingCents: Number(s.pending || 0), lastPaid: lastEver[String(x.id)] || null, reference: x.pay_ref, claimUrl: x.claimUrl || null }; });
    const methods = (await q(`select coalesce(nullif(method,''),'other') as m, sum(amount_cents) as c, count(*) as n from payments where gym_id=$1 and status='confirmed' and paid_on >= $2 and paid_on < $3 group by 1 order by 2 desc`, [u.gym_id, start, next])).rows.map((r) => ({ method: r.m, cents: Number(r.c), n: Number(r.n) }));
    const total = (await q(`select coalesce(sum(amount_cents) filter (where status='confirmed'),0) as c, coalesce(sum(amount_cents) filter (where status='confirmed' and user_id is null),0) as unmatched,
      coalesce(sum(amount_cents) filter (where status='pending'),0) as pending from payments where gym_id=$1 and paid_on >= $2 and paid_on < $3`, [u.gym_id, start, next])).rows[0];
    // six months up to this one
    const hist = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 - i, 1)), m = d.toISOString().slice(0, 7), nx = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
      const col = Number((await q("select coalesce(sum(amount_cents),0) as c from payments where gym_id=$1 and status='confirmed' and paid_on >= $2 and paid_on < $3", [u.gym_id, m + "-01", nx])).rows[0].c);
      hist.push({ month: m, collectedCents: col, expectedCents: rows.filter((x) => new Date(x.created_at).toISOString().slice(0, 10) < nx).reduce((a, x) => a + x.dues(m).dueCents, 0) });
    }
    const g = (await q("select pay from gyms where id=$1", [u.gym_id])).rows[0];
    res.json({ month, today, currency: u.currency || "ZAR", accessFeeCents: accessFee(u), dueDay: Math.min(28, Math.max(1, intOr((g.pay || {}).dueDay, 1))), students, methods, history: hist,
      collectedCents: Number(total.c), unmatchedCents: Number(total.unmatched), pendingCents: Number(total.pending) });
  }));
  // Fee reminders by email (WhatsApp reminders are sent from the coach's phone).
  api.post("/coach/money/remind", wrap(async (req, res) => {
    const u = needHead(req), b = req.body || {};
    if (!mail.mailOn()) fail(503, "Email isn't switched on yet. Use WhatsApp for reminders.");
    const today = await todayIn(u), month = /^\d{4}-\d{2}$/.test(b.month || "") ? b.month : today.slice(0, 7);
    const ids = (Array.isArray(b.userIds) ? b.userIds : []).map((x) => intOr(x, 0)).filter(Boolean).slice(0, 300);
    const rows = (await moneyRows(u, month)).filter((x) => ids.includes(Number(x.id)));
    const start = month + "-01";
    const pay = (await q("select pay from gyms where id=$1", [u.gym_id])).rows[0].pay || {};
    const bank = [pay.holder && `Account holder: ${pay.holder}`, pay.bank && `Bank: ${pay.bank}`, pay.account && `Account number: ${pay.account}`, pay.branch && `Branch code: ${pay.branch}`].filter(Boolean);
    const label = new Date(start + "T12:00:00Z").toLocaleDateString("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" });
    let sent = 0; const noEmail = [], paid = [];
    for (const x of rows) {
      if (feeOff(x.plan_status) && !x.fee) continue;
      const got = Number((await q(`select coalesce(sum(${SHARE}),0) as c from payments where user_id=$1 and gym_id=$2 and status='confirmed' and ${FEES} and ${covers("$3::timestamp")}`, [x.id, u.gym_id, start])).rows[0].c);
      const left = Math.max(0, (x.fee || 0) - got);
      if (!left) { paid.push(x.name); continue; }
      if (!x.email) { noEmail.push(x.name); continue; }
      if (limited("remind:" + u.gym_id, 300, 24 * 3600e3)) break;
      const amount = new Intl.NumberFormat("en-ZA", { style: "currency", currency: u.currency || "ZAR" }).format(left / 100);
      mail.sendLater({ to: x.email, replyTo: u.email, ...mail.templates.feeReminder(first(x.name), u.gym_name, amount, label, x.pay_ref || (await payRef(x.id)), bank, x.offline ? await claimUrl(u, x) : null, dueParts(x.dues(month), u.currency)) }); sent++;
    }
    res.json({ sent, noEmail, paid });
  }));

  // ---------- PayFast: the gym's JitsFlow plan, and students paying their gym by card ----------
  const LAUNCH = "2026-11-08"; // gyms that joined before paid plans began get their free months from this day
  // The same day n months on, or the last day of that month if it's shorter (31 January + 1 month is 28 February, not 3 March).
  const addMonths = (day, n) => { const [y, m, dd] = day.split("-").map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1));
    t.setUTCDate(Math.min(dd, new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate())); return t.toISOString().slice(0, 10); };
  async function billingOf(gymId) {
    const g = (await q("select billing, created_at from gyms where id=$1", [gymId])).rows[0]; const b = g.billing || {};
    // A card added while JitsFlow was in test mode was never real: once live, the gym adds one again.
    if (b.sandbox && !payfast.platform().sandbox) { delete b.status; delete b.token; }
    if (!b.trialEnds) { const start = g.created_at.toISOString().slice(0, 10); b.trialEnds = addMonths(start > LAUNCH ? start : LAUNCH, payfast.TRIAL_MONTHS()); await q("update gyms set billing = billing || $1 where id=$2", [{ trialEnds: b.trialEnds }, gymId]); }
    return b;
  }
  const notifyUrl = () => mail.appUrl() + "/api/payfast/notify";
  api.get("/coach/billing", wrap(async (req, res) => {
    const u = needHead(req), b = await billingOf(u.gym_id), P = payfast.platform();
    res.json({ billing: { status: b.status || "trial", trialEnds: b.trialEnds, card: !!b.token, lastPaidAt: b.lastPaidAt || null, priceCents: payfast.PRICE_CENTS(), feePct: payfast.FEE_PCT(), test: P.sandbox } });
  }));
  // Card details for the monthly plan. During the free months nothing is charged now; PayFast starts on the first day after them.
  api.post("/coach/billing/checkout", wrap(async (req, res) => {
    const u = needHead(req), b = await billingOf(u.gym_id), P = payfast.platform(), today = await todayIn(u);
    const inTrial = today < b.trialEnds, price = payfast.money(payfast.PRICE_CENTS());
    const c = payfast.checkout({ merchant_id: P.id, merchant_key: P.key, return_url: mail.appUrl() + "/app/?billing=done", cancel_url: mail.appUrl() + "/app/?billing=cancel", notify_url: notifyUrl(),
      name_first: first(u.name), email_address: u.email || "", m_payment_id: `sub-${u.gym_id}-${Date.now()}`, amount: inTrial ? "0.00" : price, item_name: "JitsFlow monthly plan",
      item_description: clean(u.gym_name, 100), custom_int1: String(u.gym_id), custom_str1: "sub", subscription_type: "1", billing_date: inTrial ? b.trialEnds : addMonths(today, 1),
      recurring_amount: price, frequency: "3", cycles: "0" }, { pass: P.pass, sandbox: P.sandbox });
    res.json(c);
  }));
  // A gym's own PayFast account, for students paying by card or Instant EFT. Keys are kept encrypted.
  const pfOf = (row) => { const p = row && row.payfast; if (!p || !p.merchantId) return null; return { id: p.merchantId, key: payfast.open(p.key), pass: payfast.open(p.pass), sandbox: p.merchantId === payfast.TEST.id }; };
  // PayFast's test account only works while JitsFlow itself is in test mode: once live, a gym still connected to it takes no payments.
  const pfLive = (p) => (p && !(p.sandbox && !payfast.platform().sandbox) ? p : null);
  api.get("/coach/payfast", wrap(async (req, res) => {
    const u = needHead(req), p = pfLive(pfOf((await q("select payfast from gyms where id=$1", [u.gym_id])).rows[0]));
    res.json({ payfast: { connected: !!p, merchantId: p ? p.id : "", test: p ? p.sandbox : false, feePct: payfast.FEE_PCT(), jitsflowMerchantId: payfast.platform().id, testMode: payfast.platform().sandbox } });
  }));
  api.put("/coach/payfast", wrap(async (req, res) => {
    const u = needHead(req), b = req.body || {};
    let id = String(b.merchantId || "").replace(/\s/g, ""), key = String(b.merchantKey || "").trim(), pass = String(b.passphrase || "").trim();
    if (b.test) { if (!payfast.platform().sandbox) fail(400, "Test payments are switched off."); ({ id, key, pass } = payfast.TEST); }
    // PayFast's public test account takes no real money: only allowed while JitsFlow itself is in test mode.
    if (id === payfast.TEST.id && !payfast.platform().sandbox) fail(400, "That's PayFast's test account. Use your own Merchant ID and Key from PayFast.");
    if (!/^\d{8}$/.test(id)) fail(400, "Your PayFast Merchant ID is 8 digits. Find it in PayFast under Settings, Developer settings.");
    if (!/^[a-z0-9]{13}$/i.test(key)) fail(400, "Your PayFast Merchant Key is 13 letters and numbers, from the same page.");
    if (pass.length > 100) fail(400, "That passphrase is too long.");
    await q("update gyms set payfast=$1 where id=$2", [{ merchantId: id, key: payfast.seal(key), pass: payfast.seal(pass), at: new Date().toISOString() }, u.gym_id]);
    tellHead(u.gym_id, "payfast", u.name, id);
    res.json({ ok: true });
  }));
  api.delete("/coach/payfast", wrap(async (req, res) => { const u = needHead(req); await q("update gyms set payfast=null where id=$1", [u.gym_id]); res.json({ ok: true }); }));
  // A student pays their gym. The money goes to the gym's PayFast account; PayFast sends JitsFlow's share to JitsFlow.
  api.post("/me/pay/payfast", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id || u.role !== "student") fail(403, "Join a gym first.");
    const g = (await q("select name, payfast from gyms where id=$1", [u.gym_id])).rows[0], p = pfLive(pfOf(g));
    if (!p) fail(400, "Your gym doesn't take card payments yet.");
    // A private-lesson pack is paid at its price; anything else is the amount the student typed.
    const pack = req.body?.packId ? await packIn(u.gym_id, req.body.packId, true) : null;
    const cents = pack ? pack.price_cents : intOr(req.body?.amountCents, 0); if (cents < 500 || cents > 5e6) fail(400, "Enter an amount from R5.");
    const P = payfast.platform(), split = p.id !== P.id ? { merchant_id: Number(P.id), percentage: payfast.FEE_PCT() } : null;
    const [fn, ...ln] = String(u.name || "").trim().split(/\s+/);
    res.json(payfast.checkout({ merchant_id: p.id, merchant_key: p.key, return_url: mail.appUrl() + "/app/?paid=card", cancel_url: mail.appUrl() + "/app/", notify_url: notifyUrl(),
      name_first: clean(fn, 100), name_last: clean(ln.join(" "), 100), email_address: u.email || "", m_payment_id: `pay-${u.id}-${Date.now()}`, amount: payfast.money(cents),
      item_name: clean(pack ? `${g.name}: ${pack.name}` : `${g.name} fees`, 100), item_description: clean(u.name, 255), custom_int1: String(u.id), custom_int2: String(u.gym_id),
      custom_int3: pack ? String(pack.id) : "", custom_str1: "pay" }, { pass: p.pass, sandbox: p.sandbox, split }));
  }));
  // PayFast's payment notification. Answer straight away, then check it four ways before anything changes.
  api.post("/payfast/notify", express.text({ type: () => true, limit: "64kb" }), wrap(async (req, res) => {
    res.status(200).end();
    const pairs = payfast.parseItn(req.body), d = Object.fromEntries(pairs);
    try {
      let pass, sandbox, merchant, gymId;
      if (d.custom_str1 === "sub") { const P = payfast.platform(); pass = P.pass; sandbox = P.sandbox; merchant = P.id; gymId = intOr(d.custom_int1, 0); }
      else if (d.custom_str1 === "pay") { gymId = intOr(d.custom_int2, 0); const p = pfLive(pfOf((await q("select payfast from gyms where id=$1", [gymId])).rows[0])); if (!p) throw new Error("gym has no PayFast"); pass = p.pass; sandbox = p.sandbox; merchant = p.id; }
      else throw new Error("unknown notification " + String(d.custom_str1 || "").slice(0, 20));
      if (!payfast.itnSignatureOk(pairs, pass)) throw new Error("bad signature");
      if (String(d.merchant_id) !== String(merchant)) throw new Error("wrong merchant");
      const ip = String(req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress || "").trim();
      if (!(await payfast.payfastIps()).has(ip)) console.warn("payfast itn: from an unlisted address " + ip + " (still confirmed with PayFast below)");
      if (!(await payfast.confirmWithPayfast(pairs, sandbox))) throw new Error("PayFast didn't confirm it");
      const gross = Math.round(Number(d.amount_gross || 0) * 100);
      if (d.custom_str1 === "sub") {
        const now = new Date().toISOString();
        const patch = d.payment_status === "COMPLETE" ? { status: "active", token: clean(d.token, 80), cardAt: now, sandbox, ...(gross > 0 ? { lastPaidAt: now, lastPaidCents: gross } : {}) } : d.payment_status === "CANCELLED" ? { status: "cancelled", sandbox } : null;
        if (patch) await q("update gyms set billing = billing || $1 where id=$2", [patch, gymId]);
      } else if (d.payment_status === "COMPLETE" && gross > 0) {
        const uid = intOr(d.custom_int1, 0), ref = "PayFast " + clean(d.pf_payment_id, 40);
        const st = (await q("select u.id, u.name, g.timezone, g.currency from users u join gyms g on g.id=u.gym_id where u.id=$1 and u.gym_id=$2", [uid, gymId])).rows[0];
        const asked = d.custom_int3 ? (await q("select * from packs where id=$1 and gym_id=$2", [intOr(d.custom_int3, 0), gymId])).rows[0] : null;
        // A pack's lessons only come with its full price. The checkout form is in the student's hands, so a smaller amount
        // for a pack is kept as an ordinary payment, with no lessons, and the head coach is told.
        const pack = asked && gross >= asked.price_cents ? asked : null, short = asked && !pack ? { name: asked.name, price: fmtMoney(asked.price_cents, st && st.currency) } : null;
        const note = `Card or Instant EFT via PayFast${d.amount_fee ? ` (PayFast fee R${Math.abs(Number(d.amount_fee)).toFixed(2)})` : ""}${short ? `. Less than ${short.name} costs (${short.price}), so no lessons were added.` : ""}`;
        // A payment through PayFast's test account moved no real money: kept as 'test', which no total counts (and gives no lessons).
        const r = st ? await q(`insert into payments(gym_id,user_id,amount_cents,paid_on,reference,note,source,method,status,pack_id,pack_lessons,pack_months) values($1,$2,$3,(now() at time zone $4)::date,$5,$6,'payfast','payfast',$7,$8,$9,$10) on conflict do nothing returning id`,
          [gymId, uid, gross, st.timezone || "Africa/Johannesburg", ref, note, sandbox ? "test" : "confirmed",
            pack ? pack.id : null, pack ? pack.lessons : null, pack ? pack.expiry_months : null]) : null;
        if (r && r.rows[0] && !sandbox) toHead(gymId, (name) => mail.templates.cardPaid(name, st.name, fmtMoney(gross, st.currency), pack ? pack.name : "", short));
      }
    } catch (e) { console.warn("payfast itn:", e.message); }
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
