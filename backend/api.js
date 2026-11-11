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
const brand = require("./brand");
const outreach = require("./outreach");
const { LONGEST, rollTimetable } = require("./db");

const COOKIE = "jf_s";
const SESSION_DAYS = 60;
const BELTS = ["white", "blue", "purple", "brown", "black"];

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const code = () => Array.from(crypto.randomBytes(8), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
// Cut on whole characters, so a long name ending in an emoji never ends in half of one.
const clean = (v, max) => Array.from(String(v == null ? "" : v).trim().slice(0, max * 2)).slice(0, max).join("");
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
  g.profile->'socials'->>'whatsapp' as gym_wa_link, g.profile->>'phone' as gym_phone, g.access_fee_cents, g.access_mode, g.private_plan_ids, g.private_price_cents as gym_private_cents, g.bill_start as gym_bill_start, h.id as head_id, h.name as head_name`;
const ME_JOIN = "left join gyms g on g.id=u.gym_id left join users h on h.id=g.head_coach_id and h.gym_id=g.id and h.role='coach' and h.active";
// A login and the kids linked to it (in a gym), for "Booking for: Lerato ▾". The login first.
const FAM = (x) => `(select coalesce(json_agg(json_build_object('id', f.id::text, 'name', f.name, 'gymId', f.gym_id::text) order by f.id<>${x}, f.id), '[]'::json)
  from users f where f.id=${x} or (f.parent_id=${x} and f.gym_id is not null)) as family`;
// Who a session is for: the kid the parent picked (as_user), or the login itself. A login that isn't in a gym itself (a parent who
// doesn't train, or whose kid holding the login left) starts on the first of their kids who is, not on a "join a gym" screen.
const FIRST_KID = (l) => `(select k.id from users k where k.parent_id=${l} and k.gym_id is not null and not exists (select 1 from users l2 where l2.id=${l} and l2.gym_id is not null) order by k.id limit 1)`;
const AS_USER = `coalesce((select k.id from users k where k.id=s.as_user and (k.id=s.user_id or (k.parent_id=s.user_id and k.gym_id is not null))), ${FIRST_KID("s.user_id")}, s.user_id)`;
// The email that reaches someone: their own, or (a kid linked to a parent's login) their parent's.
const EMAIL = (a) => `coalesce(${a}.email, (select pe.email from users pe where pe.id=${a}.parent_id))`;

function makeApi(pool, { secureCookies, build }) {
  const api = express.Router();
  const q = (text, params) => pool.query(text, params);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  // Adding something from a form (a payment, a class, a student): the app sends one key per opened form, so the same form sent twice
  // (a double tap, or sent again after the answer got lost on bad signal) gets the first answer back instead of adding it twice.
  const sent = new Map();
  const once = (fn) => wrap(async (req, res, next) => {
    const k = String(req.headers["x-jf-key"] || "").slice(0, 64);
    if (!k || !req.user) return fn(req, res, next);
    const id = `${req.user.id} ${req.path} ${k}`, had = sent.get(id);
    if (had) { const r = await had.p; return res.status(r.s).json(r.j); }
    for (const [x, v] of sent) if (Date.now() - v.at > 30 * 60e3) sent.delete(x);
    let done; sent.set(id, { at: Date.now(), p: new Promise((r) => (done = r)) });
    const json = res.json.bind(res);
    res.json = (j) => { done({ s: res.statusCode, j }); return json(j); };
    try { await fn(req, res, next); }
    catch (e) { sent.delete(id); done({ s: e.status || 500, j: { error: e.status ? e.message : "Something went wrong on the server. Try again." } }); throw e; }
  });

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
      // A parent's session books for one of their kids (as_user): everything they do (bookings, fees, journal) is that kid's.
      const row = await bySession(tok);
      if (row) {
        const ends = row.session_ends;
        req.user = row;
        if (!req.user.last_seen || Date.now() - new Date(req.user.last_seen) > 3600e3) q("update users set last_seen=now() where id = any($1)", [[req.user.id, req.user.login_id]]).catch(() => {});
        // Sessions roll: someone who uses the app stays signed in. At most hourly, push the end back to SESSION_DAYS from now.
        if (!req.path.startsWith("/auth/") && new Date(ends) - Date.now() < SESSION_DAYS * 864e5 - 3600e3) {
          q("update sessions set expires_at=now()+($2||' days')::interval where token_hash=$1", [sha(tok), String(SESSION_DAYS)]).catch(() => {});
          res.cookie(COOKIE, tok, cookieOpts());
        }
      }
    }
    next();
  }));
  // The signed-in person for a session token (see AS_USER), or nothing.
  async function bySession(tok) {
    const r = await q(`select ${ME_COLS}, s.expires_at as session_ends, s.user_id as login_id, ${FAM("s.user_id")}
      from sessions s join users u on u.id=${AS_USER} ${ME_JOIN} where s.token_hash=$1 and s.expires_at>now()`, [sha(tok)]);
    if (!r.rows[0]) return null;
    const u = await withHead(r.rows[0]); if (String(u.login_id) !== String(u.id)) await asKid(u);
    return u;
  }
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
  // Platform admins: the people whose email is in JF_ADMIN_EMAILS. Everyone else gets 403.
  const needAdmin = (req) => { const u = needUser(req); if (!outreach.isAdmin(loginOf(u).email)) fail(403, "Not allowed."); return u; };

  async function validTz(tz) { tz = clean(tz, 64); if (!tz) return null; try { await q("select now() at time zone $1", [tz]); return tz; } catch (e) { return null; } }
  async function startSession(res, userId) {
    const tok = crypto.randomBytes(32).toString("hex");
    await q("insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+($3||' days')::interval)", [sha(tok), userId, String(SESSION_DAYS)]);
    res.cookie(COOKIE, tok, cookieOpts());
  }
  const cookieOpts = () => ({ httpOnly: true, secure: secureCookies, sameSite: "lax", maxAge: SESSION_DAYS * 864e5, path: "/" });
  function me(u) {
    const out = { id: String(u.id), name: u.name, email: u.email, role: u.role === "coach" && !isCoach(u) ? "student" : u.role, belt: u.belt, stripes: u.stripes, phone: u.phone || "" };
    if (u.parent_name || u.parent_id) out.kid = true; // a kid's record, signed in by the parent: Home suggests kids classes first
    // A parent with kids on their login: who they can book for, and who they're booking for now. account: the login itself.
    if (Array.isArray(u.family) && u.family.length > 1 && !isCoach(loginOf(u))) {
      out.family = u.family.map((f) => ({ id: f.id, name: f.name, inGym: !!f.gymId, ...(String(f.id) === String(u.login_id || u.id) ? { login: true } : {}) }));
    }
    // account: the login itself, when it's a parent's (kids on it, or a kid's record the parent signed up for). Its name is the parent's.
    { const lg = loginOf(u); if (!isCoach(lg) && (out.family || lg.parent_name)) out.account = { name: parentNameOf(lg), email: lg.email }; }
    // Who stays a member of the gym if this account is deleted (the delete text names them).
    if (!isCoach(loginOf(u))) { const st = staysOf(u); if (st.length) out.stays = st.map((x) => x.name); }
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
    if (outreach.isAdmin(loginOf(u).email)) out.admin = true; // JitsFlow's own people (JF_ADMIN_EMAILS): the Outreach screen
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
    const rows = (await q("select id, name, phone, parent_name from users where gym_id=$1 and role='student' and pass_hash is null and parent_id is null order by id", [gymId])).rows;
    const all = rows.filter((x) => (n && nameKey(x.name) === n) || (d.length >= 7 && phoneKey(x.phone) === d)), byName = all.filter((x) => n && nameKey(x.name) === n);
    return { all, one: byName.length === 1 ? byName[0] : all.length === 1 ? all[0] : null };
  }
  // id: who they're booking for; loginId: who signed in (a parent booking for a kid), when that's someone else.
  const loadMe = async (id, loginId = id) => { const u = await withHead((await q(`select ${ME_COLS}, $2::bigint as login_id, ${FAM("$2::bigint")} from users u ${ME_JOIN} where u.id=$1`, [id, loginId])).rows[0]);
    return u && String(u.id) !== String(loginId) ? asKid(u) : u; };
  // Booking for a kid: the parent's login comes along. The kid's emails go to the parent, and the parent's password deletes the account.
  async function asKid(u) { u.login = (await q(`select ${ME_COLS} from users u ${ME_JOIN} where u.id=$1`, [u.login_id])).rows[0] || null; if (!u.email && u.login) u.email = u.login.email; return u; }
  const loginOf = (u) => (u && u.login) || u;
  const reMe = (u) => loadMe(u.id, u.login_id || u.id);
  // Just signed in: who the app is for (see AS_USER: a login with no gym of its own starts on a kid who has one).
  const loginMe = async (id) => loadMe((await q(`select coalesce(${FIRST_KID("$1::bigint")}, $1::bigint) as id`, [id])).rows[0].id, id);
  // The signed-in person again, after something changed who the session is for (the kid holding the login left the gym).
  const sessionMe = async (req) => bySession(cookies(req)[COOKIE] || "");
  // Where someone's emails go (a users row): their own address, or their parent's for a kid on a parent's login.
  const emailOf = async (x) => x.email || (x.parent_id ? ((await q("select email from users where id=$1", [x.parent_id])).rows[0] || {}).email || null : null);
  // Everyone on a parent's login who's in a gym, and the login itself.
  const familyIds = (u) => (Array.isArray(u.family) ? u.family : []).map((f) => String(f.id));

  // ---------- accounts ----------
  // prospect: the token of a gym's preview page (/try/<token>): the gym starts with what the preview showed (see claimProspect).
  api.post("/auth/start-gym", wrap(async (req, res) => {
    const b = req.body || {};
    checkSignIn(req, clean(b.email, 254).toLowerCase());
    const perIp = "gym:" + clientIp(req); // new gyms per address per day (each one sends a welcome email)
    if (over(perIp, 10)) fail(429, "That's a lot of new gyms today. Try again tomorrow, or email hello@jitsflow.com.");
    const pro = b.prospect ? await takeProspect(b.prospect) : null;
    let id, gymId;
    try {
      const gymName = clean(b.gym, 100) || (pro ? clean(outreach.nameOf(pro), 100) : "");
      if (!gymName) fail(400, "Enter your gym's name.");
      const tz = (await validTz(b.timezone)) || "Africa/Johannesburg";
      const g = await q("insert into gyms(name,student_code,coach_code,timezone,bill_start) values($1,$2,$3,$4,date_trunc('month', now() at time zone $4)::date) returning id", [gymName, code(), code(), tz]);
      gymId = g.rows[0].id;
      try { id = await newUser({ ...b, role: "coach", gymId }); }
      catch (e) { await q("delete from gyms where id=$1", [gymId]); throw e; }
    } catch (e) { if (pro) await untakeProspect(pro); throw e; }
    await q("update gyms set head_coach_id=$1 where id=$2", [id, gymId]);
    limited(perIp, Infinity, 24 * 3600e3);
    await startSession(res, id);
    if (pro) await claimProspect(await loadMe(id), pro);
    const m = await loadMe(id);
    mail.sendLater({ to: m.email, ...mail.templates.welcomeCoach(m.name, m.gym_name, mail.appUrl() + "/app/?join=" + m.student_code) });
    res.status(201).json({ me: me(m), ...(pro ? { claimed: true } : {}) });
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
      // A parent with a login already, opening another kid's link: signing in adds the kid (the app offers it straight after).
      if (taken) fail(409, claim && pre && pre.parent_name ? `You already have an account with that email. Sign in to add ${first(pre.name)} to it.` : "An account with that email already exists. Sign in instead.");
    };
    const claim = clean(b.claim, 40);
    let pre = claim ? (await q("select id, gym_id, name, phone, parent_name from users where claim_token=$1 and pass_hash is null and parent_id is null", [claim])).rows[0] : null;
    if (pre && !(role === "student" && (!gymId || pre.gym_id === gymId))) pre = null;
    // Kids the parent ticked ("Which of your kids train here?"): they all go on this one login. cands: the kids they could tick.
    const kidOut = (x) => ({ id: String(x.id), name: x.name }), asked = Array.isArray(b.kids);
    let cands = [];
    // Signed up with the gym's code: the coach may have added them already. Offer that record ("Are you Sipho?") when
    // their name or phone number matches it, and link to it only if they say yes. An email alone never links.
    // A number that matches several kids (brothers and sisters share a parent's number): ask once which of them train here.
    if (!pre && gymId && role === "student") {
      const { one, all } = await offlineMatch(gymId, b.name, b.phone), adult = one && !one.parent_name ? one : null;
      cands = all.filter((x) => x.parent_name);
      if (b.link && b.link !== "no") { pre = all.find((x) => String(x.id) === String(b.link)); if (!pre) fail(409, "We couldn't link you to that student. Ask your coach for your invite link."); }
      else if (!b.link && !asked) {
        if (cands.length >= 2 || (adult && cands.length)) { await checkNew(0); return res.json({ ask: { ...(adult ? { id: String(adult.id), name: adult.name, kid: false } : {}), kids: cands.map(kidOut) } }); }
        if (one) { await checkNew(one.id); return res.json({ ask: { id: String(one.id), name: one.name, kid: !!one.parent_name } }); }
      }
    } else if (pre && pre.parent_name) {
      // A kid's own invite link: their brothers and sisters the coach added with the same number can come on the same login.
      cands = (await offlineMatch(pre.gym_id, "", pre.phone || b.phone)).all.filter((x) => x.parent_name && String(x.id) !== String(pre.id));
      if (cands.length && !asked) { await checkNew(pre.id); return res.json({ ask: { claim: String(pre.id), kids: [pre, ...cands].map(kidOut) } }); }
    }
    let kids = asked ? [...new Set(b.kids.map(String))].filter((k) => !pre || k !== String(pre.id)).slice(0, 12)
      .map((k) => cands.find((x) => String(x.id) === k) || fail(409, "We couldn't link one of those kids. Ask your coach for their invite link.")) : [];
    if (!pre && kids.length) { pre = kids[0]; kids = kids.slice(1); } // no record of their own: the first kid's record holds the login
    if (pre) {
      await checkNew(pre.id);
      // A kid's record (it has a parent's name): the parent signs up for them. The kid keeps their name; the parent's goes in as the parent.
      await q(`update users set name=case when parent_name<>'' then name else $1 end, parent_name=case when parent_name<>'' then $1 else parent_name end,
        email=$2, pass_hash=$3, offline=false, claim_token=null, phone=case when phone='' then $5 else phone end where id=$4`, [clean(b.name, 80), email, await bcrypt.hash(password, 11), pre.id, cleanPhone(b.phone)]);
      id = pre.id;
      if (kids.length) await linkKids(id, kids.map((x) => x.id), clean(b.name, 80));
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
    res.json({ me: me(await loginMe(r.rows[0].id)) });
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
    res.json({ me: me(await loginMe(uid)) });
  }));
  // build: which version of the app the server has. An app left open compares it with its own and reloads when it changed.
  api.get("/status", (req, res) => res.json({ db: true, mail: mail.mailOn(), ai: !!process.env.ANTHROPIC_API_KEY, build: build || null }));

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
    res.json({ me: me(await reMe(u)) });
  }));

  // ---------- families: one parent login, several kids ----------
  // Kids the coach added (or the parent adds) go on the parent's login. They keep their own name, bookings, fees and journal.
  async function linkKids(loginId, ids, parentName) {
    await q(`update users set parent_id=$1, offline=false, claim_token=null, parent_name=case when $3<>'' then $3 else parent_name end
      where id = any($2) and id<>$1 and pass_hash is null and parent_id is null`, [loginId, ids, clean(parentName, 80)]);
  }
  const setAs = (req, id) => q("update sessions set as_user=$2 where token_hash=$1", [sha(cookies(req)[COOKIE] || ""), id]);
  const parentNameOf = (lg) => (lg.parent_name && lg.parent_name !== "Parent" ? lg.parent_name : lg.name);
  // A login that's a kid's own record (a parent signed up for them), in a gym: deleting the account keeps the kid there.
  const isKidLogin = (lg) => !!(lg.parent_name && lg.gym_id && lg.role === "student");
  // Who stays a member of a gym when this login is deleted (kids on it, and the kid holding it): [{id, name, gymId}].
  const staysOf = (u) => { const lg = loginOf(u), fam = Array.isArray(u.family) ? u.family : [];
    const kids = fam.filter((f) => f.gymId && String(f.id) !== String(lg.id));
    return [...(isKidLogin(lg) ? [{ id: String(lg.id), name: lg.name, gymId: String(lg.gym_id) }] : []), ...kids]; };
  // "Booking for: Lerato ▾": who this phone books for, pays for and keeps a journal for, until they switch again.
  api.post("/me/as", wrap(async (req, res) => {
    const u = needUser(req), lg = loginOf(u), id = String(req.body?.id || "");
    if (!familyIds(u).includes(id)) fail(404, "That's not one of your kids.");
    await setAs(req, id);
    res.json({ me: me(await loadMe(id, lg.id)) });
  }));
  // Add a kid to this login: with their own invite link (claim, a record the coach added), or by name (the coach may have added them
  // already: that record is linked, not copied). The phone then books for them.
  api.post("/me/kids", once(async (req, res) => {
    const u = needUser(req), lg = loginOf(u), b = req.body || {}, pname = parentNameOf(lg), firstKid = familyIds(u).length <= 1;
    if (isCoach(lg)) fail(400, "Coaches add their own kids as members in the Members tab.");
    if (familyIds(u).length >= 12) fail(400, "That's a lot of kids on one login. Ask your coach to help.");
    let kid, keepParent = false;
    if (b.claim) {
      kid = (await q("select id, name, parent_name, gym_id from users where claim_token=$1 and pass_hash is null and parent_id is null and role='student'", [clean(b.claim, 40)])).rows[0];
      if (!kid) fail(404, "That invite link was used already or isn't right. Ask your coach for a new one.");
      if (!kid.parent_name) fail(400, `That invite link is for ${first(kid.name)}'s own account. Sign out first, then open it again to sign up.`);
    } else {
      const name = clean(b.name, 80); if (!name) fail(400, "Enter your kid's name.");
      if (!u.gym_id) fail(400, "Join your gym first, then add your kids.");
      // Only a kid's record (it has a parent's name) is linked by name: an adult's record is theirs to claim, with their own link.
      // And only with the same proof sign-up asks for: the parent's number is the one the coach has for the kid. Anyone else
      // (a name is easy to guess) is asked for the kid's invite link, and the head coach hears about it.
      const rec = (await q(`select id, name, parent_name, gym_id, phone from users where gym_id=$1 and role='student' and pass_hash is null and parent_id is null and parent_name<>''
        and lower(regexp_replace(trim(name), '\\s+', ' ', 'g'))=$2 order by id limit 1`, [u.gym_id, nameKey(name)])).rows[0];
      if (rec && !(phoneKey(rec.phone).length >= 7 && phoneKey(rec.phone) === phoneKey(lg.phone || u.phone))) {
        if (!limited("kidask:" + lg.id, 3, 24 * 3600e3)) await tellCoach(u.gym_id, await headCoach(u.gym_id), "kidask", `${pname} asked to add ${rec.name} to their login, from a number you don't have for ${first(rec.name)}. If they're ${first(rec.name)}'s parent, send them ${first(rec.name)}'s invite link (on ${first(rec.name)}'s page).`);
        fail(409, `${u.gym_name} already has ${rec.name}, with another number. Ask your coach for ${first(rec.name)}'s invite link and open it here. That adds ${first(rec.name)} to your login.`);
      }
      kid = rec; keepParent = !!rec; // the name the coach has for the parent stays
      if (!kid) kid = (await q("insert into users(gym_id,role,name,phone,parent_name,offline) values($1,'student',$2,$3,$4,false) returning id, name, parent_name, gym_id", [u.gym_id, name, lg.phone || "", pname])).rows[0];
    }
    await linkKids(lg.id, [kid.id], keepParent ? "" : pname);
    await setAs(req, kid.id);
    // A parent who signed up with the gym's code but doesn't train (never booked, no plan, nothing paid) and adds their first kid:
    // they come off the gym's member list, so the coach doesn't wonder whether to bill them. One tap ("I train too") undoes it.
    let parentOnly = false;
    if (firstKid && String(lg.id) === String(u.id) && lg.role === "student" && !lg.parent_name && !lg.plan_id && String(lg.gym_id) === String(kid.gym_id)
      && !(await q("select 1 from attendance where user_id=$1 union all select 1 from payments where user_id=$1 limit 1", [lg.id])).rows.length) {
      await leaveGym(lg); parentOnly = true;
    }
    res.status(201).json({ me: me(await loadMe(kid.id, lg.id)), kid: { id: String(kid.id), name: kid.name }, ...(parentOnly ? { parentOnly } : {}) });
  }));
  // "I train too": the parent goes back on their kids' gym's member list (undoing parentOnly above).
  api.post("/me/train", wrap(async (req, res) => {
    const u = needUser(req), lg = loginOf(u);
    if (!u.gym_id) fail(400, "Join your gym first.");
    if (lg.gym_id && String(lg.gym_id) !== String(u.gym_id)) fail(400, "You're a member of another gym.");
    if (!lg.gym_id) await q("update users set gym_id=$2, role='student', active=true, gym_joined_at=now() where id=$1 and gym_id is null", [lg.id, u.gym_id]);
    res.json({ me: me(await reMe(u)) });
  }));
  // The coach takes a kid off a parent's login (linked by mistake, or by someone who isn't their parent). The kid stays a member,
  // not on the app, and the coach can send the real parent the kid's invite link.
  api.post("/coach/students/:id/unlink", wrap(async (req, res) => {
    const u = needCoach(req), st = await ownStudent(u, req.params.id);
    if (!st.parent_id) fail(400, `${first(st.name)} isn't on anyone else's login.`);
    // A card saved on that login stops paying for them (it's cancelled with PayFast once it pays for nobody else).
    await dropAutopay("a.user_id=$1 and a.payer_id<>a.user_id", [st.id]);
    await q("update users set parent_id=null, offline=true where id=$1", [st.id]);
    res.json({ ok: true });
  }));

  api.post("/me/join", wrap(async (req, res) => {
    // A parent booking for a kid: it's the login that joins or moves (and books for itself again).
    const u = loginOf(needUser(req)); if (req.user.login) await setAs(req, null);
    const c = clean(req.body?.code, 20).toUpperCase();
    const g = await q("select id, (coach_code=$1) as coach from gyms where student_code=$1 or coach_code=$1", [c]);
    if (!g.rows[0]) fail(404, "That gym code isn't right. Check it with your coach.");
    if (!(String(u.gym_id) === String(g.rows[0].id) && g.rows[0].coach)) await handOverFirst(u);
    if (String(u.gym_id) !== String(g.rows[0].id)) { if (u.gym_id && u.role === "student") await tellLeaving(u); await leaveGym(u, g.rows[0].id, g.rows[0].coach ? "coach" : "student"); }
    else await q("update users set role=$1 where id=$2", [g.rows[0].coach ? "coach" : "student", u.id]);
    res.json({ me: me(await reMe(u)) });
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
    await tellLeaving(u);
    await leaveGym(u);
    // The kid holding a parent's login left: the app carries on for a brother or sister still in the gym (see AS_USER).
    res.json({ me: me((await sessionMe(req)) || (await reMe(u))) });
  }));

  api.delete("/me", wrap(async (req, res) => {
    const u = loginOf(needUser(req)); // the account that signed in (a parent's kids go back to the coach's list as they were)
    if (!u.pass_hash || !(await bcrypt.compare(String(req.body?.password || ""), u.pass_hash))) fail(401, "That password isn't right.");
    // The last coach can't walk away from a gym people still use: the gym would be left with nobody in charge of its data.
    if (isCoach(u) && (await q("select 1 from users where gym_id=$1 and id<>$2 and pass_hash is not null limit 1", [u.gym_id, u.id])).rows.length
      && !(await q("select 1 from users where gym_id=$1 and id<>$2 and role='coach' and active and pass_hash is not null limit 1", [u.gym_id, u.id])).rows.length)
      fail(400, `You're the only coach at ${u.gym_name}, and your students still use it. To close the gym, delete it first in the Gym tab. To hand it over, add another coach.`);
    await handOverFirst(u);
    // The login is a kid's record (the parent signed up for them): only the login goes. The kid stays a member, not on the app, like
    // their brothers and sisters, with their bookings, attendance and payments. What the parent kept on it (journal, progress) goes.
    const stay = staysOf(req.user), kidLogin = isKidLogin(u);
    // A card saved on this login stops paying for everyone, and is cancelled with PayFast (nobody could sign in to stop it).
    await dropAutopay("a.payer_id=$1 or a.user_id=$1", [u.id]);
    if (kidLogin) {
      await q("update users set parent_id=null, offline=true where parent_id=$1", [u.id]);
      for (const t of ["sessions", "password_resets", "progress", "training_logs"]) await q(`delete from ${t} where user_id=$1`, [u.id]);
      await q("update users set email=null, pass_hash=null, offline=true, claim_token=null, last_seen=null where id=$1", [u.id]);
    } else {
      if (u.gym_id) await releaseBookings(u.id, u.gym_id, u);
      await q("delete from users where id=$1", [u.id]);
    }
    if (stay.length && stay[0].gymId) await tellCoach(stay[0].gymId, await headCoach(stay[0].gymId), "unlinked", `${parentNameOf(u)} deleted their JitsFlow login. ${namesOf(stay)} ${stay.length > 1 ? "are" : "is"} still ${stay.length > 1 ? "members" : "a member"}, now not on the app. Send their invite link if they want back on.`);
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
      where a.user_id=$1 and c.gym_id=$2 and ${VISIT("a", "c")}
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
    myGoing: !!c.my_going, myWaitlisted: !!c.my_waitlisted, myAttended: !!c.my_attended, myPosition: c.my_position ? Number(c.my_position) : null, weekly: !!c.slot_id });

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
    res.json({ classes: out, showAttendees: u.show_attendees !== false, ...(pa ? { privateAccess: pa } : {}), ...(coach ? {} : { usual: (await usualOf(u)).map((c) => String(c.id)) }) });
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
  api.post("/classes", once(async (req, res) => {
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
  const classBody = (r) => ({ title: r.title, startsAt: r.starts_at, durationMin: r.duration_min, plan: r.plan, shared: r.shared, kind: r.kind, capacity: r.capacity, priceCents: r.price_cents, coach: r.coach, level: r.level, discipline: r.discipline });
  api.put("/classes/:id", wrap(async (req, res) => {
    const u = needCoach(req), cur = await ownClass(u, req.params.id), b = req.body || {};
    // Someone else moved the class while this coach had it open: say so (with the class as it is now) rather than move it back.
    if (b.wasStartsAt && new Date(b.wasStartsAt).getTime() !== new Date(cur.starts_at).getTime()) {
      const by = cur.moved_by && String(cur.moved_by) !== String(u.id) ? (await q("select name from users where id=$1", [cur.moved_by])).rows[0] : null;
      return res.status(409).json({ error: `${by ? first(by.name) : "Another coach"} moved this class to ${whenText(cur.starts_at, tzOf(u))} while you had it open. Check it and save again.`, class: classOut(cur, true) });
    }
    const c = readClass({ ...classBody(cur), ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) });
    const db = await pool.connect(); let row, ids = [];
    try {
      await db.query("begin");
      await db.query("select id from classes where id=$1 for update", [cur.id]);
      row = (await db.query(`update classes set title=$1,starts_at=$2,duration_min=$3,plan=$4,shared=$5,kind=$6,capacity=$7,price_cents=$8,coach=$9,level=$10,discipline=$11,
        moved_by=case when starts_at is distinct from $2 then $13 else moved_by end where id=$12 returning *`,
        [c.title, c.startsAt, c.durationMin, c.plan, c.shared, c.kind, c.capacity, c.priceCents, c.coach, c.level, c.discipline, cur.id, u.id])).rows[0];
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
      const booked = (await q(`select u.id, ${EMAIL("u")} as email, u.name from attendance a join users u on u.id=a.user_id where a.class_id=$1 and (a.going or a.waitlisted)`, [row.id])).rows;
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
    if (c.kind === "private") { for (const b of booked) await q("insert into notices(gym_id,user_id,kind,title,body) values($1,$2,$3,$4,$5)", [u.gym_id, b.id, kind, title, body]); return null; }
    return String((await q("insert into notices(gym_id,user_id,kind,title,body) values($1,null,$2,$3,$4) returning id", [u.gym_id, kind, title, body])).rows[0].id);
  }
  api.delete("/classes/:id", wrap(async (req, res) => {
    const u = needCoach(req), c = await ownClass(u, req.params.id);
    const booked = (await q(`select u.id, ${EMAIL("u")} as email, u.name from attendance a join users u on u.id=a.user_id where a.class_id=$1 and (a.going or a.waitlisted)`, [c.id])).rows;
    await q("delete from classes where id=$1", [c.id]);
    // A class from the weekly timetable stays deleted: the calendar doesn't put it back.
    if (c.slot_id) await q("insert into class_skips(gym_id,slot_id,week,starts_at,title) values($1,$2,$3,$4,$5)", [u.gym_id, c.slot_id, c.slot_week, c.starts_at, c.title]);
    const future = new Date(c.starts_at) > new Date(), tell = future && req.body?.notify !== false, when = whenText(c.starts_at, tzOf(u));
    let notice = null;
    if (tell) {
      for (const b of booked) mail.sendLater({ to: b.email, ...mail.templates.cancelled(b.name, u.gym_name, c.title, when) });
      if (c.kind === "private" ? booked.length : true) notice = await notify(u, c, booked, "cancelled", `Cancelled: ${c.title}`, c.kind === "private" ? `Your private lesson on ${when} is cancelled.` : `${c.title} on ${when} is cancelled.${booked.length ? " Everyone booked has been told." : ""}`);
    }
    // Deleted by mistake: Undo puts it back (POST /coach/classes/restore), when nobody was booked and so nobody was emailed.
    const undo = booked.length ? null : { ...classOut(c, true), id: undefined, slot: c.slot_id || null, week: c.slot_week ? (await q("select $1::date::text as w", [c.slot_week])).rows[0].w : null, notice };
    res.json({ ok: true, notified: tell ? booked.filter((b) => b.email).length : 0, noticed: tell ? (c.kind === "private" ? booked.length : "all") : 0, undo });
  }));
  api.post("/coach/classes/restore", wrap(async (req, res) => {
    const u = needCoach(req), b = req.body?.class || {}, c = readClass(b), slot = b.slot ? clean(b.slot, 16) : null, week = slot && isDay(b.week) ? b.week : null;
    if (slot) await q("delete from class_skips where gym_id=$1 and ((slot_id=$2 and week=$3) or (starts_at=$4 and lower(title)=lower($5)))", [u.gym_id, slot, week, c.startsAt, c.title]);
    if (b.notice) await q("delete from notices where id=$1 and gym_id=$2 and user_id is null and kind='cancelled'", [intOr(b.notice, 0), u.gym_id]);
    const r = await q(`insert into classes(${CLASS_COLS},slot_id,slot_week) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict do nothing returning *`, [...classVals(u, c), week ? slot : null, week]);
    res.status(201).json({ class: r.rows[0] ? classOut(r.rows[0], true) : null });
  }));
  api.get("/me/notices", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) return res.json({ notices: [], unread: 0 });
    // Coaches get the notices meant for them (a private booked, a member left), not the gym-wide ones they made themselves.
    // A parent also sees their other kids' notices at this gym ("Sipho: Cancelled: Kids BJJ"), whoever they're booking for now.
    const fam = Object.fromEntries((u.family || []).map((f) => [String(f.id), f.name]));
    const r = await q(`select id, user_id, kind, title, body, created_at from notices where gym_id=$1 and (user_id=$2 or user_id = any($5::bigint[]) or (user_id is null and not $4)) and created_at > now() - interval '30 days'
      and created_at >= $3 order by created_at desc limit 30`, [u.gym_id, u.id, u.created_at, isCoach(u), isCoach(u) ? [] : Object.keys(fam)]);
    const seen = u.notices_seen_at ? new Date(u.notices_seen_at).getTime() : 0;
    const title = (n) => (n.user_id && String(n.user_id) !== String(u.id) && fam[String(n.user_id)] ? `${first(fam[String(n.user_id)])}: ${n.title}` : n.title);
    res.json({ notices: r.rows.map((n) => ({ id: String(n.id), kind: n.kind, title: title(n), body: n.body, at: n.created_at, unread: new Date(n.created_at).getTime() > seen })), unread: r.rows.filter((n) => new Date(n.created_at).getTime() > seen).length });
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
    const ppl = (await q(`select ${EMAIL("u")} as email, name from users u where id = any($1)`, [ids])).rows;
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
  // Someone's fees for Money, their Pay sheet and reminders: this month's dues, what's paid and being checked toward it, and their
  // running balance (every month still owed since their billing started). x is a users row with the gym's fields (the signed-in user works).
  async function feesOf(u, x, gym = u) {
    const today = await todayIn(gym), month = today.slice(0, 7);
    const plan = x.plan_id ? (await q("select * from plans where id=$1", [x.plan_id])).rows[0] : null;
    await withBreaks(gym.gym_id, [x], gym, tzOf(gym));
    const pv = (await privatesOf(gym.gym_id, [x.id], tzOf(gym), today))[x.id], led = (await feeLedger(gym.gym_id, [x.id]))[x.id];
    return { today, month, plan, pv, led, d: duesFor(x, plan, gym, pv, month), bal: balanceOf(x, plan, gym, pv, led, month) };
  }
  // What someone's status adds for the coach and them: a trial's end, a pause's months, and when billing starts if that's still to come.
  const statusOut = (x, month) => { const b = (x.breaks || []).find((y) => y.open && y.kind === "pause");
    return { trialEnds: x.plan_status === "trial" ? x.trial_ends || null : null, pause: b ? { from: b.from, until: b.until, idle: b.reason === "idle" } : null, billFrom: x.start && x.start > month ? x.start : null }; };
  // A student leaving: what they still owe stays on this month's Money list ("Left · owes R1 200"),
  // and the head coach hears about it, with any private lesson that's free again. Call before leaveGym.
  async function tellLeaving(u) {
    const { month, bal } = await feesOf(u, u), owed = bal.owedCents;
    const free = (await q("select c.starts_at from attendance a join classes c on c.id=a.class_id where a.user_id=$1 and c.gym_id=$2 and c.kind='private' and a.going and c.starts_at > now() order by c.starts_at limit 5", [u.id, u.gym_id])).rows;
    if (owed > 0) await q("insert into left_owing(gym_id,user_id,name,phone,email,month,owed_cents) values($1,$2,$3,$4,$5,$6,$7)", [u.gym_id, u.id, u.name, u.phone || "", u.email, month, owed]);
    // A card charge PayFast hasn't confirmed yet: when it comes in, it's recorded and comes off what they owe (see autoLeft).
    const open = (await q("select coalesce(sum(amount_cents),0)::int as c from autopay_charges where user_id=$1 and gym_id=$2 and status in ('charging','sent','unsure')", [u.id, u.gym_id])).rows[0].c;
    await tellCoach(u.gym_id, await headCoach(u.gym_id), "left", `${u.name} left ${u.gym_name}${owed > 0 ? ` owing ${fmtMoney(owed, u.currency)}` : ""}.${open ? ` A card payment of ${fmtMoney(open, u.currency)} is still on its way from PayFast. If it comes in, it's recorded and comes off what they owe.` : ""}${free.length ? ` Free again: ${free.map((c) => `the private on ${whenText(c.starts_at, tzOf(u))}`).join(", ")}.` : ""}`);
    return owed;
  }
  // Someone leaves a gym, for no gym or another one. Their bookings there are released, and what that gym kept about them
  // (coach notes, fee, plan, parent's name, payment reference) stays behind, so a new gym never sees it.
  async function leaveGym(st, gymId = null, role = "student") {
    if (st.gym_id) await releaseBookings(st.id, st.gym_id, st);
    await q("delete from plan_breaks where user_id=$1", [st.id]);
    await dropAutopay("a.user_id=$1", [st.id]); // their saved card stops paying that gym
    // A parent's phones that were booking for this login go back to the default: a kid still in a gym, if there is one (see AS_USER).
    if (!gymId) await q("update sessions set as_user=null where user_id=$1 and as_user=$1", [st.id]);
    // A kid's record that holds a parent's login with brothers or sisters on it keeps the parent's name: it's the account's name
    // (the parent signs in for the others). Anyone else's stays behind with the gym, like everything else.
    await q(`update users set gym_id=$2, role=$3, active=true, notes='', monthly_fee_cents=null, plan_id=null, plan_status='active', plan_started=null,
      parent_name=case when pass_hash is not null and exists (select 1 from users k where k.parent_id=users.id) then parent_name else '' end, pay_ref=null, bill_from=null, trial_ends=null, reminded_at=null, idle_kept_until=null,
      gym_joined_at=case when $2::bigint is null then null else now() end where id=$1`, [st.id, gymId, role]);
  }
  // Can this person take a place in this class? Not if the gym marked them inactive or their plan is paused or cancelled.
  // A plan's weekly limit counts bookings and waitlist places (someone waiting can be moved in later). Call inside the transaction.
  async function canBook(db, u, c) {
    if (u.active === false) fail(403, "Your gym has marked you as inactive. Talk to your coach to book classes.");
    if (u.role !== "student") return;
    if (c.kind === "private") { const pa = await privateAccess(u, db); if (pa) fail(403, pa.status ? pa.message : `${pa.message} Your coach can put you on it.`); }
    if (!u.plan_id) return;
    // Paused because they stopped coming: booking again is how they come back (see comeBack).
    if ((u.plan_status === "paused" && !(await idlePaused(u.id, db))) || u.plan_status === "cancelled") fail(403, `Your membership is ${u.plan_status}. Talk to your coach to book classes.`);
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
    res.json({ ok: true, ...(await rsvp(u, req.params.id, req.body?.going !== false)) });
  }));
  async function rsvp(u, id, want) {
    const db = await pool.connect(); let promoted = null, out, priv = null;
    try {
      await db.query("begin");
      await db.query("select id from users where id=$1 for update", [u.id]);
      const c = (await db.query("select * from classes where id=$1 and gym_id=$2 for update", [intOr(id, 0), u.gym_id])).rows[0];
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
      if (c.kind === "private" && (want ? out.going && !(mine && mine.going) : mine && mine.going)) priv = c;
      if (out.waitlisted) out.position = Number((await db.query("select count(*) from attendance where class_id=$1 and waitlisted and booked_at <= (select booked_at from attendance where class_id=$1 and user_id=$2)", [c.id, u.id])).rows[0].count);
      await db.query("commit");
    } catch (e) { await db.query("rollback").catch(() => {}); throw e; } finally { db.release(); }
    if (promoted) await tellPromoted(promoted.ids, promoted.c, u);
    if (want && (out.going || out.waitlisted) && u.plan_status === "paused") await comeBack(u.id, u.gym_id, "booked a class");
    // A private booked or cancelled: its coach (or the head coach) hears straight away, and the student gets a confirmation.
    if (priv) {
      const when = whenText(priv.starts_at, tzOf(u));
      await tellCoach(u.gym_id, await slotCoach(priv), want ? "booked" : "cancelled", want ? `${u.name} booked a private lesson: ${when}.` : `${u.name} cancelled their private lesson on ${when}. The slot is free again.`);
      if (want) mail.sendLater({ to: u.email, ...mail.templates.privateBooked(first(u.name), u.gym_name, when) });
    }
    return out;
  }
  // "Book my usual": this week's group classes like the ones they booked or came to a week before (same weekday, time and class),
  // each booked through the normal rules (spots and waitlist, their plan's weekly limit, pauses). For each class still to come in
  // the next 7 days, look 7 days back. A class they booked and then cancelled (or a coach took them off) is left alone.
  const USUAL = `select c.id, c.title, c.starts_at from classes c where c.gym_id=$1 and c.kind<>'private' and c.starts_at > now() and c.starts_at <= now() + interval '7 days'
      and not exists (select 1 from attendance m where m.class_id=c.id and m.user_id=$2)
      and exists (select 1 from attendance a join classes p on p.id=a.class_id where a.user_id=$2 and p.gym_id=$1 and p.kind<>'private' and (a.going or a.attended)
        and p.starts_at >= c.starts_at - interval '7 days 2 hours' and p.starts_at <= c.starts_at - interval '6 days 22 hours' and p.starts_at < now()
        and to_char(p.starts_at at time zone $3, 'ID HH24:MI') = to_char(c.starts_at at time zone $3, 'ID HH24:MI') and lower(p.title)=lower(c.title))
    order by c.starts_at`;
  const usualOf = async (u) => u.role === "student" && u.gym_id ? (await q(USUAL, [u.gym_id, u.id, tzOf(u)])).rows : [];
  api.post("/me/book-usual", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) fail(403, "Join a gym first.");
    const list = await usualOf(u), booked = [], waiting = [], failed = [];
    for (const c of list) {
      try { const r = await rsvp(u, c.id, true); (r.going ? booked : r.waitlisted ? waiting : failed).push({ id: String(c.id), title: c.title, startsAt: c.starts_at, position: r.position || null }); }
      catch (e) { if (!(e instanceof HttpError)) throw e; failed.push({ id: String(c.id), title: c.title, startsAt: c.starts_at, reason: e.message }); }
    }
    res.json({ booked, waiting, failed });
  }));
  // The coach a private is with (by the name on the slot), or the head coach.
  async function slotCoach(c) {
    const by = c.coach ? (await q("select id, name, email from users where gym_id=$1 and role='coach' and active and lower(name)=lower($2) limit 1", [c.gym_id, c.coach])).rows[0] : null;
    return by || (await headCoach(c.gym_id));
  }
  // News for a coach: an email, and a notice on their Home in the app.
  async function tellCoach(gymId, coach, kind, line) {
    if (!coach) return;
    const m = mail.templates.coachNews(kind, first(coach.name), line);
    await q("insert into notices(gym_id,user_id,kind,title,body) values($1,$2,$3,$4,$5)", [gymId, coach.id, kind, m.title, line]);
    if (coach.email) mail.sendLater({ to: coach.email, ...m });
  }
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
    if (u.plan_status === "paused") await comeBack(u.id, u.gym_id, "checked in to a class");
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

  // Attendance analysis. A visit = a check-in, or a booking for a class the coach didn't take the register for
  // (so gyms that never take attendance still get numbers, and a self check-in or a walk-in never undoes other people's bookings).
  const VISIT = (a, c) => `(${a}.attended or (${a}.going and ${c}.register_at is null))`;
  const DAY = 864e5;
  async function visitStats(gymId, tz) {
    const cls = (await q(`select c.id, c.title, c.kind, c.capacity, c.starts_at,
        extract(isodow from c.starts_at at time zone $2)::int as dow, to_char(c.starts_at at time zone $2,'HH24:MI') as hm,
        to_char(date_trunc('week', c.starts_at at time zone $2),'YYYY-MM-DD') as wk,
        coalesce(a.checked,0)::int as checked, coalesce(a.came,0)::int as came, coalesce(a.waiting,0)::int as waiting, c.register_at is not null as register
      from classes c left join (select class_id, count(*) filter (where attended) as checked, count(*) filter (where attended or going) as came, count(*) filter (where waitlisted) as waiting
          from attendance where class_id in (select id from classes where gym_id=$1 and starts_at > now() - interval '180 days') group by class_id) a on a.class_id=c.id
      where c.gym_id=$1 and c.starts_at > now() - interval '180 days' and c.starts_at + (c.duration_min || ' minutes')::interval < now()`, [gymId, tz])).rows;
    const byId = Object.fromEntries(cls.map((c) => [c.id, c]));
    const att = (await q(`select a.user_id, a.class_id, a.attended, a.going from attendance a join classes c on c.id=a.class_id
      where c.gym_id=$1 and c.starts_at > now() - interval '180 days' and c.starts_at + (c.duration_min || ' minutes')::interval < now() and (a.attended or a.going)`, [gymId])).rows;
    const visits = {};
    for (const a of att) { const c = byId[a.class_id]; if (!c) continue; if (a.attended || (a.going && !c.register)) (visits[a.user_id] = visits[a.user_id] || []).push({ at: new Date(c.starts_at).getTime(), wk: c.wk, kind: c.kind, classId: c.id }); }
    for (const c of cls) c.count = c.register ? c.checked : c.came;
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
  // Paused and cancelled members don't pay fees (see membershipOf: by month, it's their breaks that count).
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
  // A private already paid for (fee payments confirmed for its month cover the membership, the access fee and it) never uses a credit:
  // that money stays on it, so buying a pack later doesn't turn it into an overpayment.
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
    const now = Date.now(), batches = {}, cash = {};
    if (pays.length && uses.length) {
      // What each person has left over in each month once their membership (and access fee) is paid: privates are paid from that, in date order.
      const g = (await q("select monthly_fee_cents as gym_fee, access_mode, access_fee_cents, bill_start as gym_bill_start from gyms where id=$1", [gymId])).rows[0];
      const xs = Object.fromEntries((await withBreaks(gymId, (await q("select u.id, u.plan_status, u.monthly_fee_cents, u.created_at, u.bill_from, to_jsonb(p) as plan from users u left join plans p on p.id=u.plan_id where u.id = any($1)", [userIds])).rows, g, tz)).map((x) => [x.id, x]));
      const fees = (await q(`select user_id, paid_on, for_month, alloc, months, amount_cents from payments where gym_id=$1 and user_id = any($2) and status='confirmed' and ${FEES}`, [gymId, userIds])).rows;
      for (const f of fees) for (const [m, c] of Object.entries(sharesOf(f))) { const k = f.user_id + "|" + m; cash[k] = (cash[k] || 0) + c; }
      const charged = new Set(uses.filter((a) => a.charged).map((a) => a.user_id + "|" + a.day.slice(0, 7)));
      for (const k of Object.keys(cash)) { const x = xs[k.split("|")[0]]; if (!x) continue;
        cash[k] -= membershipOf(x, x.plan, g, k.split("|")[1]) + (!memberOf(x, x.plan, g) && charged.has(k) ? accessFee(g) : 0); }
    }
    const paidCash = (a, pr) => { const k = a.user_id + "|" + a.day.slice(0, 7); if (!a.charged || !(pr.cents > 0) || !(cash[k] >= pr.cents)) return false; cash[k] -= pr.cents; return true; };
    for (const p of pays) {
      const b = { from: p.paid_on, until: p.pack_months ? addMonths(p.paid_on, p.pack_months) : null, n: p.pack_lessons };
      (batches[p.user_id] = batches[p.user_id] || []).push(b);
      out[p.user_id].ledger.push({ day: p.paid_on, kind: "pack", lessons: p.pack_lessons, title: p.name, paymentId: String(p.id), expiresOn: b.until });
    }
    for (const a of uses) {
      const o = out[a.user_id], st = a.attended || new Date(a.starts_at).getTime() <= now ? "used" : "booked";
      if (a.charged) o.months.add(a.day.slice(0, 7)); if (st === "booked") o.booked++; else o.used++;
      const pr = priceOf(a), b = paidCash(a, pr) ? null : (batches[a.user_id] || []).filter((x) => x.n > 0 && x.from <= a.day && (!x.until || a.day < x.until)).sort((x, y) => (x.until || "9999") < (y.until || "9999") ? -1 : (x.until || "9999") > (y.until || "9999") ? 1 : 0)[0];
      o.prices[String(a.id)] = { ...pr, covered: !!b };
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
  // For a month (with breaks loaded, see withBreaks): nothing before their start month or in a break. Without a month: by their status now.
  const membershipOf = (x, plan, gym, m) => (m && x.breaks ? (x.start && m < x.start) || inBreak(x, m) : feeOff(x.plan_status) || x.plan_status === "trial") ? 0
    : x.monthly_fee_cents ?? (plan ? monthly(plan) : null) ?? gym.gym_fee ?? 0;
  const memberOf = (x, plan, gym) => (realPlan(plan) && !feeOff(x.plan_status)) || membershipOf(x, plan, gym) > 0;
  // The access fee only applies when the gym picked it ('fee'): 'none' charges just the private, 'membership' needs a plan to book.
  const accessFee = (gym) => (gym.access_mode || "fee") === "fee" ? gym.access_fee_cents || 0 : 0;
  function duesFor(x, plan, gym, priv, month) {
    const membershipCents = membershipOf(x, plan, gym, month), member = memberOf(x, plan, gym), fee = accessFee(gym);
    const accessCents = !member && fee > 0 && priv && priv.months.has(month) ? fee : 0;
    const privates = priv ? priv.owed.filter((o) => o.month === month && o.priceCents > 0).map((o) => ({ classId: o.classId, title: o.title, startsAt: o.startsAt, priceCents: o.priceCents, label: o.label || "" })) : [];
    const privatesCents = privates.reduce((t, o) => t + o.priceCents, 0);
    return { membershipCents, accessCents, privatesCents, privates, dueCents: membershipCents + accessCents + privatesCents };
  }
  // ---------- what's owed, month by month ----------
  // Months are "YYYY-MM". Someone is billed from their start month: the latest of the month the gym started keeping fees in the app,
  // the month they joined (by the gym's clock) and their own bill_from (members added in bulk start on their next due date).
  // Breaks (a pause, a trial, a cancelled plan) are free months; the months before and after them stay as they are.
  const ymOf = (d) => String(d || "").slice(0, 7);
  const mAdd = (m, n) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 7);
  const BACK = 24; // a running balance looks back at most two years
  const inBreak = (x, m) => (x.breaks || []).some((b) => b.from <= m && (!b.until || m <= b.until));
  // Adds start and breaks to each person (they need id, created_at and bill_from). gym needs gym_bill_start.
  async function withBreaks(gymId, xs, gym, tz) {
    const ids = xs.map((x) => x.id), by = {};
    if (ids.length) for (const b of (await q("select user_id, kind, to_char(from_month,'YYYY-MM') as f, to_char(until_month,'YYYY-MM') as t, ended_at is null as open, reason from plan_breaks where gym_id=$1 and user_id = any($2) order by from_month, id", [gymId, ids])).rows)
      (by[b.user_id] = by[b.user_id] || []).push({ kind: b.kind, from: b.f, until: b.t, open: b.open, reason: b.reason });
    for (const x of xs) { x.breaks = by[x.id] || []; x.start = [ymOf(gym.gym_bill_start), x.created_at ? ymOf(dayIn(x.created_at, tz)) : "", ymOf(x.bill_from)].filter(Boolean).sort().pop() || null; }
    return xs;
  }
  // Which months a fee payment pays, and how much toward each: {"2026-11": 85000}.
  function sharesOf(p) {
    if (p.alloc && typeof p.alloc === "object") return p.alloc;
    const n = Math.max(1, p.months || 1), s0 = ymOf(p.for_month || p.paid_on), o = {};
    for (let i = 0; i < n; i++) o[mAdd(s0, i)] = Math.round(p.amount_cents / n);
    return o;
  }
  // Fee payments (not packs) for these people, month by month: confirmed (paid) and waiting to be checked (pending).
  async function feeLedger(gymId, userIds, skipId) {
    const out = {}; for (const id of userIds) out[id] = { paid: {}, pending: {}, pendingCents: 0 };
    if (!userIds.length) return out;
    const r = await q(`select user_id, amount_cents, paid_on, months, for_month, alloc, status from payments where gym_id=$1 and user_id = any($2) and status in ('confirmed','pending') and ${FEES} and id<>$3`, [gymId, userIds, intOr(skipId, 0)]);
    for (const p of r.rows) { const o = out[p.user_id]; if (!o) continue; const k = p.status === "confirmed" ? o.paid : o.pending; if (p.status === "pending") o.pendingCents += p.amount_cents;
      for (const [m, c] of Object.entries(sharesOf(p))) k[m] = (k[m] || 0) + c; }
    return out;
  }
  // Someone's running balance up to the month `until`: each month still owed (from their start, or an older private they owe), and the total.
  // next: the first month after `until` with something to pay (what a fee paid now in advance would be for).
  function balanceOf(x, plan, gym, priv, led, until) {
    const lo = mAdd(until, 1 - BACK); let m = [x.start || until, ...(priv ? priv.owed.map((o) => o.month) : [])].sort()[0];
    if (m < lo) m = lo;
    const months = []; let owed = 0;
    for (; m <= until; m = mAdd(m, 1)) { const left = duesFor(x, plan, gym, priv, m).dueCents - ((led && led.paid[m]) || 0); if (left > 0) { months.push({ month: m, cents: left }); owed += left; } }
    let next = null; for (let i = 1; i <= 12 && !next; i++) { const n = mAdd(until, i), left = duesFor(x, plan, gym, priv, n).dueCents - ((led && led.paid[n]) || 0); if (left > 0) next = { month: n, cents: left }; }
    // creditCents: paid beyond what those months cost (more than the fee, or for a month a pause made free): "R850 paid ahead".
    let credit = 0; for (const [n, c] of Object.entries((led && led.paid) || {})) if (n >= (x.start || lo) && n >= lo) credit += Math.max(0, c - duesFor(x, plan, gym, priv, n).dueCents);
    return { owedCents: owed, months, next, creditCents: credit };
  }
  // A gym's money settings, for work done outside a coach's request (PayFast notifications, scheduled jobs).
  const gymCtx = async (gymId) => (await q(`select g.id as gym_id, g.monthly_fee_cents as gym_fee, g.currency, g.timezone, g.access_mode, g.access_fee_cents, g.private_price_cents as gym_private_cents,
    g.bill_start as gym_bill_start, g.pay, g.name as gym_name from gyms g where g.id=$1`, [gymId])).rows[0];
  // Which months a new fee payment pays. Decided once, when it's saved, and never moved by later payments: the month it was paid in
  // if that's still owed, then older months still owed (oldest first), then the months after (so a fee paid early, on payday
  // at the end of the month, counts for next month). What's left over goes on the last of them. On a year or term plan it starts
  // at the first of those months and covers what the amount buys (R8 500 on R8 500 a year: 12 months), or `months` if the coach set it.
  // opts.from: the month the coach says it's for. It starts there and fills the months still owed after it, in order (R1 700 "for
  // October" pays October and November), unless that month is paid already (then it all goes on it, as they said).
  // Someone added in bulk whose billing starts later, paying for a month before that (from the day they were added): they hadn't paid
  // it outside the app after all, so that month is billed and the payment counts there (not pushed into a month they don't owe yet).
  // opts.after: the months still owed from this one on, in order, never older ones (a saved card's charge pays the months it was for).
  // opts.dry: only work it out (nothing is saved), for the Record payment sheet.
  async function feeMonths(gym, userId, amount, paidOn, skipId, monthsSet, opts = {}) {
    const tz = tzOf(gym), today = await todayIn(gym), cur = today.slice(0, 7), M = ymOf(paidOn) || cur, from = isMonth(opts.from) ? opts.from : null, after = !from && isMonth(opts.after) ? opts.after : null;
    const x = userId ? (await q("select u.*, to_jsonb(p) as plan from users u left join plans p on p.id=u.plan_id where u.id=$1 and u.gym_id=$2", [userId, gym.gym_id])).rows[0] : null;
    if (!x) return { for_month: (from || M) + "-01", months: monthsSet || 1, alloc: null };
    await withBreaks(gym.gym_id, [x], gym, tz);
    const on = from || M, base = [ymOf(gym.gym_bill_start), ymOf(dayIn(x.created_at, tz))].filter(Boolean).sort().pop() || on;
    let billFrom = null;
    if (x.bill_from && on < ymOf(x.bill_from) && on >= base && on <= cur) { billFrom = on + "-01"; x.start = on; if (!opts.dry) await q("update users set bill_from=$2 where id=$1", [x.id, billFrom]); }
    const priv = (await privatesOf(gym.gym_id, [x.id], tz, today))[x.id], led = (await feeLedger(gym.gym_id, [x.id], skipId))[x.id];
    const left = (m) => Math.max(0, duesFor(x, x.plan, gym, priv, m).dueCents - (led.paid[m] || 0));
    const order = [], lo = [x.start || M, mAdd(cur, 1 - BACK)].sort().pop();
    if (from) { order.push(from); if (left(from) > 0) for (let i = 1; i <= BACK; i++) { const m = mAdd(from, i); if (left(m) > 0) order.push(m); } }
    else if (after) { for (let i = 0; i <= BACK; i++) { const m = mAdd(after, i); if (left(m) > 0) order.push(m); } }
    else {
      if (left(M) > 0) order.push(M);
      for (let m = lo; m < M; m = mAdd(m, 1)) if (left(m) > 0) order.push(m);
      for (let i = 1; i <= BACK; i++) { const m = mAdd(M, i); if (left(m) > 0) order.push(m); }
    }
    const t = x.monthly_fee_cents == null ? termOf(x.plan) : null, at = (order[0] || after || M) + "-01";
    if (monthsSet || t || !order.length || !(amount > 0)) return { for_month: at, months: monthsSet || (t ? coverMonths(Math.round((amount / t.priceCents) * t.months)) : 1), alloc: null, billFrom };
    const alloc = {}; let rest = amount, last = order[0];
    for (const m of order) { if (rest <= 0) break; const c = Math.min(rest, left(m)); if (c > 0) { alloc[m] = c; rest -= c; last = m; } }
    // What's left over: on the last of them, or for someone paused until they're back, on the pause (it moves on to the months after
    // it when they're back, see movePaid).
    const pz = !from && x.breaks.find((b) => b.open && b.kind === "pause" && !b.until), sink = pz && pz.from > last ? pz.from : last;
    if (rest > 0) alloc[sink] = (alloc[sink] || 0) + rest;
    const ks = Object.keys(alloc).sort();
    return ks.length === 1 ? { for_month: ks[0] + "-01", months: 1, alloc: null, billFrom } : { for_month: ks[0] + "-01", months: ks.length, alloc, billFrom };
  }
  const nameMonths = (ms) => { const n = ms.map((m) => new Date(m + "-15T12:00:00Z").toLocaleDateString("en-ZA", { month: "long", timeZone: "UTC" }));
    return (n.length > 1 ? `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}` : n[0] || "") + (ms.length ? " " + ms[ms.length - 1].slice(0, 4) : ""); };

  // ---------- membership status: pauses, trials, cancelling ----------
  // A pause or a cancelled plan starts next month: this month is still owed (they've trained in it), unless it's one of the first
  // few days of the month and nothing's been paid toward it yet. A pause runs to the end of next month for 1 month, the month after
  // for 2, or until they're back (0). A trial is free from this month.
  // Ending a break keeps the months it already freed, this one included, so coming back never bills a paused month. A pause or
  // cancel that hasn't started yet, or was set in the last week (a mistake, or plans that changed), just goes: undoing it costs nothing.
  // A trial that ends because they're staying (active) bills this month: their first payment pays it.
  // opts.now: the pause starts this month whatever the day (someone who stopped coming weeks ago), unless it's paid already.
  // opts.reason: kept on the pause ('idle': booking or checking in again ends it by itself).
  // opts.keep: end the break and keep the months it freed even if it was set this week (someone paused for not coming who's back:
  // they were told their fees were on hold, so they never owe for that month, however soon they answer).
  const TRIAL_DAYS = 14, PAUSE_GRACE = 5;
  async function setStatus(gym, st, status, opts = {}) {
    const today = await todayIn(gym), cur = today.slice(0, 7), was = st.plan_status, months = opts.months === undefined ? 1 : Math.min(12, Math.max(0, intOr(opts.months, 1)));
    const open = (await q("select id, kind, to_char(from_month,'YYYY-MM') as f, created_at > now() - interval '7 days' as recent from plan_breaks where user_id=$1 and gym_id=$2 and ended_at is null", [st.id, gym.gym_id])).rows;
    if (status === was && !(status === "paused" && opts.months !== undefined)) return;
    const paidNow = async () => ((await feeLedger(gym.gym_id, [st.id]))[st.id].paid[cur] || 0) > 0;
    for (const b of open) {
      if (status === "paused" && b.kind === "pause") { await q("update plan_breaks set until_month=$2 where id=$1", [b.id, months ? mAdd(cur, months) + "-01" : null]); await movePaid(gym, b.id); continue; }
      const until = b.kind === "trial" && status === "active" ? mAdd(cur, -1) : cur;
      if (b.f > until || (b.kind !== "trial" && b.recent && !opts.keep)) { await putBack(b.id); await q("delete from plan_breaks where id=$1", [b.id]); }
      else { await q("update plan_breaks set until_month=least(coalesce(until_month, $2::date), $2::date), ended_at=now() where id=$1", [b.id, until + "-01"]); await movePaid(gym, b.id); }
    }
    if ((status === "paused" && !open.some((b) => b.kind === "pause")) || status === "cancelled") {
      const from = (opts.now || +today.slice(8, 10) <= PAUSE_GRACE) && !(await paidNow()) ? cur : mAdd(cur, 1);
      const r = await q("insert into plan_breaks(gym_id,user_id,kind,from_month,until_month,reason) values($1,$2,$3,$4,$5,$6) returning id", [gym.gym_id, st.id, status === "paused" ? "pause" : "cancel", from + "-01", status === "paused" && months ? mAdd(cur, months) + "-01" : null, opts.reason || null]);
      if (status === "paused") await movePaid(gym, r.rows[0].id);
    }
    if (status === "trial") await q("insert into plan_breaks(gym_id,user_id,kind,from_month) values($1,$2,'trial',$3)", [gym.gym_id, st.id, cur + "-01"]);
    await q("update users set plan_status=$2, trial_ends=case when $2='trial' then $3::date + $4::int else trial_ends end where id=$1", [st.id, status, today, TRIAL_DAYS]);
    st.plan_status = status;
  }
  // Money paid ahead for months a pause makes free moves to the first months after the pause that are still owed, once, when the
  // pause is set, changed or ended (an open-ended one: when it ends). A year or term plan so runs on for as long as the pause.
  // What moved is kept on the pause, so changing or undoing it puts the money back first (unless the payment was edited since).
  async function putBack(breakId) {
    const b = (await q("select moved from plan_breaks where id=$1", [breakId])).rows[0];
    for (const m of ((b && b.moved) || []).slice().reverse())
      await q("update payments set for_month=$2, months=$3, alloc=$4 where id=$1 and alloc is not distinct from $5::jsonb", [m.id, m.was.for_month, m.was.months, m.was.alloc ? JSON.stringify(m.was.alloc) : null, JSON.stringify(m.now)]);
    if (b && b.moved) await q("update plan_breaks set moved=null where id=$1", [breakId]);
  }
  async function movePaid(gym, breakId) {
    await putBack(breakId);
    const b = (await q("select user_id, kind, to_char(from_month,'YYYY-MM') as f, to_char(until_month,'YYYY-MM') as t from plan_breaks where id=$1", [breakId])).rows[0];
    if (!b || b.kind !== "pause" || !b.t) return;
    const tz = tzOf(gym), today = await todayIn(gym);
    const x = (await q("select u.*, to_jsonb(p) as plan from users u left join plans p on p.id=u.plan_id where u.id=$1 and u.gym_id=$2", [b.user_id, gym.gym_id])).rows[0]; if (!x) return;
    await withBreaks(gym.gym_id, [x], gym, tz);
    const priv = (await privatesOf(gym.gym_id, [x.id], tz, today))[x.id], paid = (await feeLedger(gym.gym_id, [x.id]))[x.id].paid, due = (m) => duesFor(x, x.plan, gym, priv, m).dueCents;
    const ps = (await q(`select id, amount_cents, paid_on, months, for_month, alloc from payments where user_id=$1 and gym_id=$2 and status='confirmed' and ${FEES} order by paid_on, id`, [x.id, gym.gym_id])).rows, moved = [];
    for (const p of ps) {
      const sh = { ...sharesOf(p) }; let rest = 0, last = null;
      for (const m of Object.keys(sh)) if (m >= b.f && m <= b.t) { const mv = Math.min(sh[m], Math.max(0, (paid[m] || 0) - due(m))); if (mv > 0) { sh[m] -= mv; paid[m] -= mv; rest += mv; if (!sh[m]) delete sh[m]; } }
      if (!rest) continue;
      for (let i = 1; i <= 36 && rest > 0; i++) { const m = mAdd(b.t, i), c = Math.min(rest, Math.max(0, due(m) - (paid[m] || 0))); if (c > 0) { sh[m] = (sh[m] || 0) + c; paid[m] = (paid[m] || 0) + c; rest -= c; last = m; } }
      if (rest > 0) { const m = last || mAdd(b.t, 1); sh[m] = (sh[m] || 0) + rest; paid[m] = (paid[m] || 0) + rest; }
      const ks = Object.keys(sh).sort();
      await q("update payments set for_month=$2, months=$3, alloc=$4 where id=$1", [p.id, ks[0] + "-01", ks.length, JSON.stringify(sh)]);
      moved.push({ id: p.id, was: { for_month: p.for_month, months: p.months, alloc: p.alloc }, now: sh });
    }
    if (moved.length) await q("update plan_breaks set moved=$2 where id=$1", [breakId, JSON.stringify(moved)]);
  }
  // A confirmed fee payment: a proof sent for a plan puts them on it, and a first payment ends a trial (they're active from this month).
  // Call before working out which months it pays, so this month is owed by then.
  async function feeIn(gym, userId, planId) {
    const st = userId ? (await q("select * from users where id=$1 and gym_id=$2", [userId, gym.gym_id])).rows[0] : null; if (!st) return;
    if (planId && String(planId) !== String(st.plan_id) && (await q("select 1 from plans where id=$1 and gym_id=$2", [planId, gym.gym_id])).rows[0])
      await q("update users set plan_id=$2, plan_started=coalesce(plan_started, $3::date) where id=$1", [st.id, planId, await todayIn(gym)]);
    if (st.plan_status === "trial") await setStatus(gym, st, "active");
  }
  // The plans people land on when nobody picks one: kids on a plan called Kids or Junior (if there is one), everyone else on the plan
  // most members are on, or else the cheapest monthly plan.
  const KIDS_PLAN = /\b(kid|kids|junior|juniors|children|tots)\b/i;
  async function defaultPlans(gymId) {
    const ps = (await q(`select p.*, (select count(*) from users u where u.plan_id=p.id and u.role='student' and u.active and u.plan_status<>'cancelled') as n
      from plans p where p.gym_id=$1 and p.active order by p.price_cents, p.id`, [gymId])).rows.filter((p) => realPlan(p) && !PRIV_RATE.test(p.name));
    const kidsP = ps.filter((p) => KIDS_PLAN.test(p.name)), adults = ps.filter((p) => !KIDS_PLAN.test(p.name));
    const most = (list) => list.slice().sort((a, b) => Number(b.n) - Number(a.n))[0];
    const adult = adults.some((p) => Number(p.n) > 0) ? most(adults) : adults.find((p) => p.period === "month" && p.price_cents > 0) || adults[0] || null;
    const kid = kidsP.length ? (kidsP.some((p) => Number(p.n) > 0) ? most(kidsP) : kidsP[0]) : null;
    return { adultPlanId: adult ? String(adult.id) : null, kidsPlanId: kid ? String(kid.id) : adult ? String(adult.id) : null, ownKidsPlan: !!kid };
  }
  const dueDayOf = (pay) => Math.min(28, Math.max(1, intOr((pay || {}).dueDay, 1)));

  // Gyms on 'membership' only let students on one of the plans they ticked (and not paused or cancelled) book a private.
  // Pack lessons they haven't used always let them book: they've paid for them.
  // null: this student can book. Otherwise the plans that allow privates (the ones still offered, if any are), and what to tell them.
  // u needs role, gym_id, plan_id, plan_status, access_mode and private_plan_ids (the signed-in user has them).
  async function privateAccess(u, db = pool) {
    if (u.role !== "student" || u.access_mode !== "membership") return null;
    const ids = (u.private_plan_ids || []).map(String);
    const onIt = u.plan_id && ids.includes(String(u.plan_id));
    if (onIt && !feeOff(u.plan_status)) return null;
    if ((await privatesOf(u.gym_id, [u.id], tzOf(u), await todayIn(u)))[u.id].left > 0) return null;
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
  // The day (YYYY-MM-DD) a moment falls on in a time zone. One formatter per zone, kept: making one per call is slow (the Money list
  // calls this thousands of times). A zone that isn't real falls back to UTC, as before.
  const dayFmts = new Map();
  const dayIn = (d, tz) => {
    let f = dayFmts.get(tz);
    if (f === undefined) { try { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); } catch (e) { f = null; } if (dayFmts.size < 1000) dayFmts.set(tz, f); }
    const t = new Date(d); if (isNaN(t)) return "Invalid Date";
    return f ? f.format(t) : t.toISOString().slice(0, 10);
  };
  const packOut = (k) => ({ id: String(k.id), name: k.name, lessons: k.lessons, priceCents: k.price_cents, expiryMonths: k.expiry_months, active: k.active });
  async function packIn(gymId, id, activeOnly) {
    const k = (await q(`select * from packs where id=$1 and gym_id=$2${activeOnly ? " and active" : ""}`, [intOr(id, 0), gymId])).rows[0];
    if (!k) fail(404, "That private-lesson pack doesn't exist."); return k;
  }

  api.get("/coach/classes/:id", wrap(async (req, res) => {
    const u = needCoach(req), c = await ownClass(u, req.params.id);
    const r = await q(`select u.id,u.name,u.belt,u.stripes,u.parent_name,a.going,a.attended,a.waitlisted,a.booked_at,a.checked_in_at from attendance a join users u on u.id=a.user_id
      where a.class_id=$1 and (a.going or a.attended or a.waitlisted) order by a.waitlisted, a.booked_at, u.name`, [c.id]);
    const s = await summaries(u.gym_id, r.rows.map((x) => x.id));
    if (c.kind === "private") { const pv = await privatesOf(u.gym_id, r.rows.map((x) => x.id), tzOf(u), await todayIn(u));
      for (const x of r.rows) { s[x.id].privatesLeft = pv[x.id].left; const b = pv[x.id].prices[c.id]; if (isHead(u) && b) Object.assign(s[x.id], { priceCents: b.cents, priceLabel: b.label, pack: b.covered }); } }
    const att = r.rows.filter((x) => !x.waitlisted);
    // "Usually here": who came to a class on the same weekday and time in the 4 weeks before, so the coach can mark the regulars in one tap.
    const usual = c.kind === "private" ? [] : (await q(`select a.user_id from attendance a join classes k on k.id=a.class_id join users u on u.id=a.user_id
        where k.gym_id=$1 and k.id<>$2 and k.kind<>'private' and k.starts_at < $3 and k.starts_at >= $3::timestamptz - interval '28 days' and u.active and u.gym_id=$1
          and to_char(k.starts_at at time zone $4, 'D HH24:MI') = to_char($3::timestamptz at time zone $4, 'D HH24:MI') and ${VISIT("a", "k")}
        group by a.user_id`, [u.gym_id, c.id, c.starts_at, tzOf(u)])).rows.map((x) => String(x.user_id));
    res.json({ class: classOut({ ...c, going: att.filter((x) => x.going).length, waiting: r.rows.length - att.length }, true), usual,
      attendees: att.map((x) => ({ ...person(x, s[x.id]), kid: !!x.parent_name, going: x.going, attended: x.attended, bookedAt: x.booked_at, checkedInAt: x.checked_in_at, self: !!x.checked_in_at })),
      waitlist: r.rows.filter((x) => x.waitlisted).map((x) => ({ ...person(x, {}), bookedAt: x.booked_at })) });
  }));
  api.put("/coach/classes/:id/attendance", wrap(async (req, res) => {
    const u = needCoach(req), c = await ownClass(u, req.params.id);
    const ids = (Array.isArray(req.body?.userIds) ? req.body.userIds : [req.body?.userId]).map((x) => intOr(x, 0)).filter(Boolean).slice(0, 300);
    const st = await q("select id from users where id = any($1) and gym_id=$2", [ids, u.gym_id]);
    if (st.rows.length !== ids.length || !ids.length) fail(404, "That student isn't in your gym.");
    const was = (await q("select user_id, going from attendance where class_id=$1 and user_id = any($2) and (going or attended)", [c.id, ids])).rows, had = new Set(was.map((x) => String(x.user_id)));
    // going: true adds them as booked (a coach putting someone on a class or private), without touching a check-in they already have.
    const book = req.body?.going === true;
    // Ticking or unticking someone who booked is taking the register: from now on only the people ticked count as there.
    // Adding a walk-in doesn't, so the people who booked still count.
    if (!book && was.some((x) => x.going)) await q("update classes set register_at=coalesce(register_at, now()), register_by=$2 where id=$1", [c.id, u.id]);
    for (const sid of ids) await q(`insert into attendance(class_id,user_id,going,attended,booked_at) values($1,$2,true,$3,clock_timestamp())
             on conflict(class_id,user_id) do update set attended=case when $4 then attendance.attended or excluded.attended else excluded.attended end,
               going=attendance.going or excluded.attended or $4, waitlisted=false, updated_at=now()`, [c.id, sid, req.body?.attended !== false, book]);
    // Someone the coach adds to a private gets today's price for them, locked in like a booking.
    await lockPrice(pool, c, ids.filter((x) => !had.has(String(x))));
    // Someone paused for not coming who's on the mat again is back.
    if (req.body?.attended !== false || book) for (const r of (await q("select id from users where id = any($1) and gym_id=$2 and plan_status='paused'", [ids, u.gym_id])).rows)
      await comeBack(r.id, u.gym_id, book ? "was booked into a class" : "was checked in to a class");
    res.json({ ok: true, count: ids.length });
  }));

  async function rosterRows(u) {
    const r = await q(`select u.id,u.name,u.parent_name,${EMAIL("u")} as email,u.phone,(u.pass_hash is null and u.parent_id is null) as offline,u.parent_id,(select p.name from users p where p.id=u.parent_id) as parent_account,u.role,u.belt,u.stripes,u.active,u.monthly_fee_cents,u.notes,u.created_at,u.plan_id,u.plan_status,u.plan_started,u.rank_changed_at,u.bill_from,u.trial_ends,u.gym_joined_at,u.idle_kept_until
      from users u where u.gym_id=$1 order by u.role, u.name`, [u.gym_id]);
    // The parts that don't depend on each other load at once (Home waits for this).
    const ids = r.rows.map((x) => x.id), todayP = todayIn(u);
    const [plans, s, vs, priv, pay, led] = await Promise.all([plansOf(u.gym_id), summaries(u.gym_id, ids), visitStats(u.gym_id, tzOf(u)),
      todayP.then((d) => privatesOf(u.gym_id, ids, tzOf(u), d)), q("select user_id, max(paid_on) as last_paid from payments where gym_id=$1 and user_id is not null and status='confirmed' group by user_id", [u.gym_id]),
      feeLedger(u.gym_id, ids), withBreaks(u.gym_id, r.rows, u, tzOf(u))]);
    const pm = Object.fromEntries(plans.map((p) => [String(p.id), p])), { visits } = vs, today = await todayP, month = today.slice(0, 7);
    const paid = Object.fromEntries(pay.rows.map((x) => [x.user_id, x]));
    // Someone the coach added who then signed up through the gym's link instead of their own: likely the same person twice.
    const off = r.rows.filter((x) => x.offline && x.role === "student"), same = {};
    for (const a of r.rows.filter((x) => !x.offline && x.role === "student")) {
      // Brothers and sisters share a parent's number, so for kids only the same name counts.
      const o = off.find((x) => nameKey(x.name) === nameKey(a.name) || (!x.parent_name && !a.parent_name && phoneKey(a.phone).length >= 7 && phoneKey(x.phone) === phoneKey(a.phone)));
      if (o) { same[a.id] = same[a.id] || { id: String(o.id), name: o.name }; same[o.id] = same[o.id] || { id: String(a.id), name: a.name }; }
    }
    return { plans, vs, raw: r.rows, rows: r.rows.map((x) => {
      const plan = pm[String(x.plan_id)] || null, d = duesFor(x, plan, u, priv[x.id], month), bal = x.role === "student" ? balanceOf(x, plan, u, priv[x.id], led[x.id], month) : { owedCents: 0, months: [], next: null };
      return { ...person(x, s[x.id]), parentName: x.parent_name || "", parentAccount: x.parent_account || null, email: x.email || "", phone: x.phone || "", offline: !!x.offline, role: x.role, active: x.active, notes: x.notes, joined: x.created_at,
        privatesLeft: priv[x.id].left, head: String(x.id) === String(u.head_id),
        feeCents: x.role === "student" ? d.dueCents : 0, membershipCents: x.role === "student" ? d.membershipCents : 0, accessCents: d.accessCents, privatesCents: d.privatesCents, planId: plan ? String(plan.id) : null, planName: plan ? plan.name : null, planStatus: x.plan_status, planStarted: x.plan_started,
        paidThisMonthCents: led[x.id].paid[month] || 0, pendingThisMonthCents: led[x.id].pendingCents, lastPaid: paid[x.id]?.last_paid || null,
        owedCents: bal.owedCents, owedMonths: bal.months, nextMonth: bal.next, creditCents: bal.creditCents || 0, ...statusOut(x, month),
        visits: x.role === "student" ? studentStats(x, visits[x.id]) : null, sameAs: same[x.id] || null };
    }) };
  }
  // Fees, plans and payments are the head coach's: other coaches get the roster without them.
  const MONEY_KEYS = ["feeCents", "membershipCents", "accessCents", "privatesCents", "planId", "planName", "planStatus", "planStarted", "paidThisMonthCents", "pendingThisMonthCents", "lastPaid", "feeOverride", "payments",
    "owedCents", "owedMonths", "nextMonth", "creditCents", "trialEnds", "pause", "billFrom", "dueCents"];
  const noMoney = (o) => { const c = { ...o }; for (const k of MONEY_KEYS) delete c[k]; return c; };
  api.get("/coach/roster", wrap(async (req, res) => {
    const u = needCoach(req), seenP = isHead(u) ? seenSince(u.gym_id) : null; seenP && seenP.catch(() => {});
    const { plans, rows, raw } = await rosterRows(u);
    if (!isHead(u)) return res.json({ currency: u.currency, people: rows.map(noMoney) });
    const g = (await q("select pay, remind_log from gyms where id=$1", [u.gym_id])).rows[0], today = await todayIn(u), rl = g.remind_log;
    // For Home: the automatic reminders that went today, and the people who stopped coming.
    res.json({ gymFeeCents: u.gym_fee, accessFeeCents: accessFee(u), currency: u.currency, plans: plans.map(planOut), defaultPlans: await defaultPlans(u.gym_id), dueDay: dueDayOf(g.pay), today, people: rows,
      reminders: rl && rl.day === today ? { sent: rl.sent || 0, to: rl.to || [], noEmail: rl.noEmail || [], failed: rl.done === false ? [] : rl.failed || [] } : null, idle: idleOf(raw, rows, await seenP, today) });
  }));

  async function ownStudent(u, id) {
    const r = await q("select * from users where id=$1 and gym_id=$2", [intOr(id, 0), u.gym_id]);
    if (!r.rows[0]) fail(404, "That person isn't in your gym.");
    return r.rows[0];
  }
  api.post("/coach/students", once(async (req, res) => {
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
  // They're members already, who've paid this month outside the app: billing starts next month (the head coach can bill
  // this month too, in one tap: /coach/students/bill-from). Everyone goes on a plan: the head coach's pick (planId, and kidsPlanId
  // for kids; null for none), or the gym's usual plans (defaultPlans).
  api.post("/coach/students/bulk", once(async (req, res) => {
    const u = needCoach(req), b = req.body || {}, list = (Array.isArray(b.people) ? b.people : []).slice(0, 300);
    if (!list.length) fail(400, "No one to add.");
    if (!isHead(u) && (b.planId !== undefined || b.kidsPlanId !== undefined)) fail(403, "Only the head coach can set plans and fees.");
    const def = await defaultPlans(u.gym_id), pick = async (v, d) => { if (v === undefined) return d; if (!v) return null; const id = intOr(v, 0);
      if (!(await q("select 1 from plans where id=$1 and gym_id=$2", [id, u.gym_id])).rows[0]) fail(404, "That plan doesn't exist."); return String(id); };
    const adultPlan = await pick(b.planId, def.adultPlanId), kidsPlan = await pick(b.kidsPlanId, def.ownKidsPlan ? def.kidsPlanId : adultPlan);
    // Billing starts next month, whatever the due day (that's the month the next fee pays for). "Bill this month too" is only offered
    // when this month counts (it's not before the gym started keeping fees here).
    const g = (await q("select bill_start from gyms where id=$1", [u.gym_id])).rows[0], today = await todayIn(u), cur = today.slice(0, 7);
    const due = { next: mAdd(cur, 1) + "-01", prev: cur >= ymOf(g.bill_start) ? cur + "-01" : null };
    const { seenPh, seenEm, sameName, note, digits } = await whoIsIn(u.gym_id);
    let added = 0, skipped = 0; const ids = [];
    for (const p0 of list) {
      const name = clean(p0.name, 80), parentName = clean(p0.parentName, 80), phone = cleanPhone(p0.phone), email0 = clean(p0.email, 254).toLowerCase(), email = isEmail(email0) ? email0 : "";
      if (!name) { skipped++; continue; }
      // Brothers and sisters share a parent's number and email, so for kids those don't mean "already here".
      if ((!parentName && phone && seenPh.has(digits(phone))) || (!parentName && email && seenEm.has(email)) || sameName(name, phone, email)) { skipped++; continue; }
      // An email belongs to one person: a second kid of the same parent goes in without it (the parent's number still reaches them).
      let em = email; if (em && (seenEm.has(em) || (await q("select 1 from users where email=$1", [em])).rows[0])) { if (!parentName) { skipped++; continue; } em = ""; }
      const plan = parentName ? kidsPlan : adultPlan;
      const r = await q("insert into users(gym_id,role,name,email,pass_hash,phone,offline,parent_name,plan_id,plan_started,bill_from) values($1,'student',$2,$3,null,$4,true,$5,$6,$7,$8) returning id",
        [u.gym_id, name, em || null, phone, parentName, plan, plan ? today : null, due.next]);
      ids.push(String(r.rows[0].id));
      if (phone && !parentName) seenPh.add(digits(phone)); if (em) seenEm.add(em); note(name, phone, email); added++;
    }
    res.status(201).json({ added, skipped, ids, billFrom: due.next, billPrev: due.prev });
  }));
  // Bill people from another day (members added in bulk: "Bill November too"; null goes back to when they joined). Months before it aren't owed.
  api.post("/coach/students/bill-from", wrap(async (req, res) => {
    const u = needHead(req), b = req.body || {}, ids = (Array.isArray(b.userIds) ? b.userIds : []).map((x) => intOr(x, 0)).filter(Boolean).slice(0, 300);
    if (b.from !== null && !isDay(b.from)) fail(400, "Pick the day billing starts.");
    const r = await q("update users set bill_from=$1 where gym_id=$2 and role='student' and id = any($3)", [b.from, u.gym_id, ids]);
    res.json({ ok: true, updated: r.rowCount });
  }));
  // Link that signs this person up straight into their existing record (plan, payments, attendance kept).
  api.post("/coach/students/:id/claim-link", wrap(async (req, res) => {
    const u = needCoach(req), st = await ownStudent(u, req.params.id);
    if (st.pass_hash || st.parent_id) fail(400, "They already use the app.");
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
    if (o.pass_hash || o.parent_id || o.role !== "student") fail(400, "Only a student who isn't on the app can be merged.");
    if (!(a.pass_hash || a.parent_id) || a.role !== "student" || a.id === o.id) fail(400, "Pick the student's own account to merge into.");
    const db = await pool.connect();
    try {
      await db.query("begin");
      // The plan they keep brings its pauses and trial with it. The coach's record wins unless the student's account has a plan of its
      // own that's more than a trial they started themselves (they picked a plan when they signed up, before the coach confirmed a fee):
      // a paying member stays a paying member, with the months they owe.
      const fees = async (id) => !!(await db.query(`select 1 from payments where user_id=$1 and status='confirmed' and ${FEES} limit 1`, [id])).rows[0];
      const keepO = !a.plan_id || (a.plan_status === "trial" && !(await fees(a.id)) && (!!o.plan_id || (await fees(o.id))));
      await db.query("update payments set user_id=$2 where user_id=$1", [o.id, a.id]);
      await db.query("update payments set submitted_by=$2 where submitted_by=$1", [o.id, a.id]);
      await db.query("update attendance set user_id=$2 where user_id=$1 and class_id not in (select class_id from attendance where user_id=$2)", [o.id, a.id]);
      await db.query("update competitors set user_id=$2 where user_id=$1 and competition_id not in (select competition_id from competitors where user_id=$2)", [o.id, a.id]);
      await db.query("update notices set user_id=$2 where user_id=$1", [o.id, a.id]);
      if (keepO) { await db.query("delete from plan_breaks where user_id=$1", [a.id]); await db.query("update plan_breaks set user_id=$2 where user_id=$1", [o.id, a.id]); }
      const ref = !a.pay_ref && o.pay_ref ? o.pay_ref : null, rank = BELTS.indexOf(o.belt) * 10 + o.stripes > BELTS.indexOf(a.belt) * 10 + a.stripes;
      await db.query("update users set pay_ref=null, claim_token=null where id=$1", [o.id]);
      await db.query(`update users set plan_id=$2, plan_status=$3, plan_started=$4, monthly_fee_cents=$5, notes=$6, phone=$7, parent_name=$8, belt=$9, stripes=$10,
        pay_ref=coalesce(pay_ref,$11), created_at=least(created_at,$12), bill_from=coalesce(bill_from,$13), trial_ends=$14 where id=$1`,
        [a.id, keepO ? o.plan_id : a.plan_id, keepO ? o.plan_status : a.plan_status, keepO ? o.plan_started : a.plan_started, a.monthly_fee_cents ?? o.monthly_fee_cents,
          [a.notes, o.notes].filter(Boolean).join("\n"), a.phone || o.phone || "", a.parent_name || o.parent_name || "", rank ? o.belt : a.belt, rank ? o.stripes : a.stripes, ref, o.created_at, o.bill_from, keepO ? o.trial_ends : a.trial_ends]);
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
      return res.json({ ok: true, me: me(await reMe(u)) });
    }
    // A student with their own account keeps it, with no gym. Payments you recorded stay with the gym.
    if (st.pass_hash || st.parent_id) { await leaveGym(st); return res.json({ ok: true }); }
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
    const pa = st.parent_id ? (await q("select name, email from users where id=$1", [st.parent_id])).rows[0] : null;
    const out = { student: { ...person(st, s), parentName: st.parent_name || "", parentAccount: pa ? pa.name : null, email: st.email || (pa && pa.email) || "", phone: st.phone || "", offline: !st.pass_hash && !st.parent_id, role: st.role, active: st.active, feeCents: st.monthly_fee_cents ?? (plan ? monthly(plan) : null) ?? u.gym_fee, feeOverride: st.monthly_fee_cents,
        notes: st.notes, joined: st.created_at, planId: st.plan_id ? String(st.plan_id) : null, planStatus: st.plan_status, planStarted: st.plan_started, rankChangedAt: st.rank_changed_at,
        visits: studentStats(st, visits[st.id]), head: String(st.id) === String(u.head_id) },
      classes: recent.rows.map((x) => ({ title: x.title, startsAt: x.starts_at, kind: x.kind, attended: x.attended })),
      logs: logs.rows.map((x) => ({ ...x.data, id: x.id })), payments: pays.rows.map(payOut),
      privates: { ...privOut(pv), ledger: pv.ledger.slice(0, 30) } };
    if (isHead(u)) { const f = await feesOf(u, st); Object.assign(out.student, { accessCents: f.d.accessCents, privatesCents: f.d.privatesCents, dueCents: f.d.dueCents, owedCents: f.bal.owedCents, owedMonths: f.bal.months, ...statusOut(st, f.month) }); }
    else { out.student = noMoney(out.student); delete out.payments; }
    res.json(out);
  }));
  const PLAN_STATUS = ["active", "trial", "paused", "cancelled"];
  api.patch("/coach/students/:id", wrap(async (req, res) => {
    const u = needCoach(req), st = await ownStudent(u, req.params.id), b = req.body || {};
    if (!isHead(u) && ["feeCents", "planId", "planStatus", "planStarted", "pauseMonths"].some((k) => b[k] !== undefined)) fail(403, "Only the head coach can change plans and fees.");
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
    await q(`update users set belt=$1,stripes=$2,notes=$3,monthly_fee_cents=$4,active=$5,plan_id=$6,plan_started=$7,
      rank_changed_at=case when $8 then now() else rank_changed_at end where id=$9`, [belt, stripes, notes, fee, active, planId, planStarted, rankChanged, st.id]);
    // Pausing gets its months (pauseMonths: 1, 2, or 0 for until they're back); a trial gets its 14 days. See setStatus.
    if (st.role === "student" && (planStatus !== st.plan_status || (planStatus === "paused" && b.pauseMonths !== undefined))) await setStatus(u, st, planStatus, { months: b.pauseMonths });
    else if (planStatus !== st.plan_status) await q("update users set plan_status=$1 where id=$2", [planStatus, st.id]);
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
  // Which of the website's prices are memberships: paid each week, month, term or year. A joining fee, a drop-in, a trial,
  // a grading or a private lesson is a charge, not a plan, whatever period it says. That's read from the name only: a note like
  // "No joining fee" or "First trial class free" is about a membership, not a charge.
  const NOT_PLAN = /joining|registration|sign[\s-]?up|admin(istration)? fee|drop[\s-]?in|casual|single class|per class|once[\s-]?off|trial|grading|uniform/i;
  const planRates = (rates, have = new Set()) => { const seen = new Set(have);
    return (rates || []).filter((r) => { const k = String(r.name || "").toLowerCase(), ok = k && !seen.has(k) && ["month", "week", "term", "year"].includes(r.period) && !PRIV_RATE.test(`${r.name} ${r.note || ""}`) && !NOT_PLAN.test(r.name); if (ok) seen.add(k); return ok; }); };
  async function plansFromRates(gymId, rates) {
    const have = new Set((await plansOf(gymId)).map((p) => p.name.toLowerCase()));
    const list = planRates(rates, have);
    for (const r of list) {
      const cpw = /(\d)\s*(x|times|classes)\s*(a|per)\s*week/i.exec(r.name + " " + (r.note || ""));
      await q("insert into plans(gym_id,name,price_cents,period,classes_per_week) values($1,$2,$3,$4,$5)", [gymId, clean(r.name, 80), Math.round(r.price * 100), r.period, cpw ? Number(cpw[1]) : null]);
    }
    return list.length;
  }
  // Turn the prices imported from the gym's website into plans (skips names that already exist).
  api.post("/coach/plans/from-rates", wrap(async (req, res) => {
    const u = needHead(req);
    const g = (await q("select profile from gyms where id=$1", [u.gym_id])).rows[0];
    const added = await plansFromRates(u.gym_id, (g.profile && g.profile.rates) || []);
    res.status(201).json({ added, plans: (await plansOf(u.gym_id)).map(planOut) });
  }));

  // ---------- your membership (students) ----------
  api.get("/me/membership", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) return res.json({ membership: null });
    const plan = u.plan_id ? (await q("select * from plans where id=$1", [u.plan_id])).rows[0] : null;
    const wk = Number((await q(`select count(*) from attendance a join classes k on k.id=a.class_id where a.user_id=$1 and a.going and k.kind<>'private'
      and date_trunc('week', k.starts_at at time zone $2) = date_trunc('week', now() at time zone $2)`, [u.id, tzOf(u)])).rows[0].count);
    const mine = (await q(`select c.starts_at, c.kind, to_char(date_trunc('week', c.starts_at at time zone $3),'YYYY-MM-DD') as wk, a.attended,
        ${VISIT("a", "c")} as counts
      from attendance a join classes c on c.id=a.class_id where a.user_id=$1 and c.gym_id=$2 and c.starts_at > now() - interval '180 days'
        and c.starts_at + (c.duration_min || ' minutes')::interval < now() and (a.attended or a.going)`, [u.id, u.gym_id, tzOf(u)])).rows
      .filter((x) => x.counts).map((x) => ({ at: new Date(x.starts_at).getTime(), wk: x.wk, kind: x.kind }));
    const st = studentStats(u, mine);
    const thisMonth = (await todayIn(u)).slice(0, 7), month = mine.filter((v) => dayIn(v.at, tzOf(u)).slice(0, 7) === thisMonth).length;
    await withBreaks(u.gym_id, [u], u, tzOf(u));
    res.json({ membership: { plan: plan ? planOut(plan) : null, status: u.plan_status, started: u.plan_started, bookedThisWeek: wk, visitsThisMonth: month, streak: st.streak, perWeek: st.perWeek, total180: st.total180,
      ...statusOut(u, thisMonth), plans: await pickablePlans(u) } });
  }));
  // The plans a student can pick for themselves: the gym's active ones, for someone new (no plan yet, and joined in the last 14 days)
  // or still trying one out, who has never had a fee confirmed and owes nothing. Picking one starts a free trial, so anyone else
  // (a member already, or someone who owes fees) doesn't get the choice: their plan changes go through the coach.
  // owed: what they owe now, if it's already worked out.
  async function canPick(u, owed) {
    if (u.role !== "student" || !u.gym_id) return false;
    if (!(u.plan_status === "trial" || (!u.plan_id && Date.now() - new Date(u.gym_joined_at || u.created_at).getTime() < TRIAL_DAYS * 864e5))) return false;
    if ((await q(`select 1 from payments where user_id=$1 and gym_id=$2 and status='confirmed' and ${FEES} limit 1`, [u.id, u.gym_id])).rows[0]) return false;
    return (owed === undefined ? (await feesOf(u, u)).bal.owedCents : owed) === 0;
  }
  async function pickablePlans(u, owed) {
    if (!(await canPick(u, owed))) return [];
    return (await q("select * from plans where gym_id=$1 and active order by price_cents, name", [u.gym_id])).rows.filter((p) => realPlan(p) && !PRIV_RATE.test(p.name)).map(planOut);
  }
  // A new member picks their plan (when they join, or from their membership card). It starts as a trial: free for 14 days or until
  // the coach confirms their first payment, when it becomes active.
  api.post("/me/plan", wrap(async (req, res) => {
    const u = needUser(req); if (u.role !== "student" || !u.gym_id) fail(403, "Join a gym first.");
    const ps = await pickablePlans(u); if (!ps.length) fail(400, "You're already on a plan. Ask your coach to change it.");
    const p = ps.find((x) => x.id === String(req.body?.planId)); if (!p) fail(404, "That plan isn't on offer.");
    await q("update users set plan_id=$1, plan_started=$2 where id=$3", [p.id, await todayIn(u), u.id]);
    await setStatus(u, u, "trial");
    tellCoach(u.gym_id, await headCoach(u.gym_id), "joined", `${u.name} picked the ${p.name} plan. They're on a free trial until you confirm their first payment.`).catch(() => {});
    res.json({ ok: true, plan: p, me: me(await reMe(u)) });
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
    const head = isHead(u), collected = head ? Number((await q("select coalesce(sum(amount_cents),0) as s from payments where gym_id=$1 and status='confirmed' and paid_on >= date_trunc('month', now() at time zone $2)::date", [u.gym_id, tz])).rows[0].s) : 0;
    const unpaid = studs.filter((p) => p.owedCents > 0);
    const mix = plans.filter((p) => p.active).map((p) => { const m = studs.filter((s) => s.planId === String(p.id) && s.planStatus !== "cancelled"); return { id: String(p.id), name: p.name, members: m.length, monthlyCents: m.length * (monthly(p) || 0) }; });
    res.json({
      tz, currency: u.currency,
      kpis: { active: studs.length, visits28, prev28, perWeek: Math.round((visits28 / 4) * 10) / 10, perMember: studs.length ? Math.round((visits28 / 4 / studs.length) * 10) / 10 : 0,
        newMembers30: studs.filter((p) => now - new Date(p.joined).getTime() < 30 * DAY).length,
        retention: { base: old.length, retained: old.filter((p) => p.visits.d28 > 0).length } },
      weeks: weeks.map((w) => ({ wk: w.wk, visits: w.visits, people: w.people.size })),
      segments: seg, slots: slotList,
      ...(head ? { revenue: { collected, expected, unpaid: unpaid.map((p) => ({ id: p.id, name: p.name, dueCents: p.owedCents, months: p.owedMonths.map((o) => o.month) })) },
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
    if (decided && b.notify !== false) mail.sendLater({ to: await emailOf(st), ...mail.templates.compDecision(st.name, c.name, compWhen(c), status === "entered", v("coachNote", "coach_note", 500)) });
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
    const to = (await q(`select id, name, ${EMAIL("u")} as email from users u where id = any($1) and gym_id=$2`, [ids, u.gym_id])).rows;
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
    res.json({ ok: true, me: me(await reMe(u)) });
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
    res.json({ me: me(await reMe(u)) });
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
    res.json({ me: me(await reMe(u)) });
  }));
  api.post("/coach/codes/rotate", wrap(async (req, res) => {
    const u = needCoach(req), which = req.body?.which === "coach" ? "coach_code" : "student_code";
    await q(`update gyms set ${which}=$1 where id=$2`, [code(), u.gym_id]);
    res.json({ me: me(await reMe(u)) });
  }));

  // ---------- gym profile (imported from the gym's website or typed in) ----------
  api.get("/gym", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) return res.json({ gym: null });
    const r = await q("select id,name,profile,logo_v,currency,profile_updated_at from gyms where id=$1", [u.gym_id]);
    const g = r.rows[0];
    res.json({ gym: { id: String(g.id), name: g.name, currency: g.currency, profile: g.profile || {}, updatedAt: g.profile_updated_at, logo: g.logo_v ? `/api/gyms/${g.id}/logo?v=${g.logo_v}` : null } });
  }));
  // The first screen checks a gym code before sign-up ("Joining Lions BJJ"). Just the name; an unknown code is { gym: null }.
  // With a kid's own invite link (claim), also the kid's name, so the parent sees who they're signing up for.
  api.get("/gyms/by-code/:code", wrap(async (req, res) => {
    if (limited("code:" + clientIp(req), 30, 15 * 60e3)) fail(429, "Too many tries. Wait 15 minutes and try again.");
    const c = clean(req.params.code, 20).toUpperCase(), claim = clean(req.query.claim, 40);
    const g = c ? (await q("select id, name, (coach_code=$1) as coach from gyms where student_code=$1 or coach_code=$1", [c])).rows[0] : null;
    const kid = g && claim ? (await q("select name from users where claim_token=$1 and gym_id=$2 and pass_hash is null and parent_id is null and parent_name<>''", [claim, g.id])).rows[0] : null;
    res.json({ gym: g ? { id: String(g.id), name: g.name, coach: !!g.coach, ...(kid ? { kid: kid.name } : {}) } : null });
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
    const out = await assistant.run({ u, q, msgs, helpers: { ownStudent, readPaySettings, tellHead, head: isHead(u), bankChanged, todayIn, payRef, cleanPhone, isDay, isEmail, clean, intOr, plansOf, monthly, readClass, CLASS_COLS, classVals, BELTS, METHODS, tzOf, feeIn, feeMonths } });
    await q("update gyms set setup = setup || $1 where id=$2", [{ assistantUsed: true }, u.gym_id]);
    res.json(out);
  }));
  api.post("/coach/import", wrap(async (req, res) => {
    const u = needCoach(req);
    if (limited("imp:" + u.gym_id, 12, 60 * 60e3)) fail(429, "That's a lot of imports. Try again in an hour.");
    try { res.json(await importer.importSite(clean(req.body?.url, 500), { log: (m) => console.warn(m) })); }
    catch (e) { if (e instanceof importer.ImportError) fail(400, e.message); throw e; }
  }));
  // Save the gym's details. The weekly timetable is what the calendar is made from: rows keep their ids, a changed row moves its
  // future classes nobody has booked (booked ones wait for the coach: see /coach/timetable/apply), and new rows go on the calendar.
  // Two coaches can have Gym details open at once, so a save only changes what this coach changed: a row goes only when its id is in
  // removed (never because an older copy left it out), rows this coach didn't touch (the same as in ttBase, the copy they opened)
  // keep what's saved now, and rows added since stay. calendar: false (unticked on the import review) keeps the new rows of this save
  // off the calendar; rows already there keep going. plans: true (head coach) makes the website's membership prices into plans.
  api.put("/coach/gym/profile", wrap(async (req, res) => {
    const u = needCoach(req);
    const out = await applyProfile(u, req.body || {});
    res.json({ me: me(await reMe(u)), ...out });
  }));
  // Saving a gym's details from a website import (or typed in): the coach's own review above, and a gym claimed from a preview
  // (claimProspect), which passes the logo it already has (logo: { body, type }) instead of a logoUrl to download.
  async function applyProfile(u, b, { logo } = {}) {
    const site = b.profile && b.profile.brand && b.profile.brand.source === "site" && brand.isHex(b.profile.brand.accent) ? b.profile.brand.accent.toLowerCase() : null;
    const profile = importer.cleanProfile(b.profile);
    const name = profile.name || u.gym_name;
    let fee = u.gym_fee;
    if (!fee && isHead(u)) { const m = profile.rates.find((r) => r.period === "month" && !NOT_PLAN.test(r.name) && (!r.currency || r.currency === (u.currency || "ZAR"))); if (m) fee = Math.round(m.price * 100); }
    const was = ((await q("select profile from gyms where id=$1", [u.gym_id])).rows[0].profile || {}).timetable || [];
    profile.timetable = ttMerge(was, profile.timetable, b);
    await q("update gyms set name=$1, profile=$2, monthly_fee_cents=$3, profile_updated_at=now() where id=$4", [name, profile, fee, u.gym_id]);
    const tt = await ttChanged(u, was, profile.timetable);
    const classesAdded = await rollTimetable(pool, u.gym_id);
    const plansAdded = b.plans === true && isHead(u) ? await plansFromRates(u.gym_id, profile.rates) : 0;
    let logoNote = null;
    if (logo && logo.body) await q("update gyms set logo=$1, logo_type=$2, logo_v=$3 where id=$4", [logo.body, logo.type, sha(logo.body.toString("base64")).slice(0, 10), u.gym_id]);
    else if (b.logoUrl === null) await q("update gyms set logo=null, logo_type=null, logo_v=null where id=$1", [u.gym_id]);
    else if (typeof b.logoUrl === "string" && b.logoUrl) {
      let img = null; try { img = await importer.fetchImage(clean(b.logoUrl, 600)); } catch (e) { img = null; }
      if (img) await q("update gyms set logo=$1, logo_type=$2, logo_v=$3 where id=$4", [img.body, img.type, sha(img.body.toString("base64")).slice(0, 10), u.gym_id]);
      else logoNote = "Couldn't download that logo. Everything else is saved.";
    }
    // The colour read from the website becomes the app's colour, unless the coach picked one already.
    if (site) await q("update gyms set brand = brand || $1 where id=$2 and coalesce(brand->>'accent','')=''", [{ accent: site }, u.gym_id]);
    return { feeSet: !u.gym_fee && fee ? fee : 0, logoNote, classesAdded, plansAdded, moved: tt.moved, held: tt.held };
  }
  // ---------- the weekly timetable ----------
  const ttId = () => crypto.randomBytes(5).toString("hex");
  const TT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const ttDur = (r) => { if (!r.end) return 60; const [a, b] = r.start.split(":").map(Number), [c, d] = r.end.split(":").map(Number), m = c * 60 + d - (a * 60 + b); return m >= 15 ? m : 60; };
  const ttFull = (r) => [r.day, r.start, r.end, r.title, r.coach, r.level, r.type, r.cap, r.from, !!r.off].join("|");
  const lc = (x) => String(x || "").toLowerCase();
  // The timetable a save ends up with (see PUT /coach/gym/profile). A row sent without its id (a new import of the same site) that
  // matches one already saved keeps that row's id, so its classes stay as they are: the same day, time and name, or else the same
  // day and name at the nearest time (the website moved it: its classes move with it).
  function ttMerge(was, sent, b) {
    const wasById = new Map(was.filter((r) => r.id).map((r) => [r.id, r])), removed = new Set((Array.isArray(b.removed) ? b.removed : []).map((x) => String(x)));
    const base = Array.isArray(b.ttBase) ? new Map(importer.cleanProfile({ timetable: b.ttBase }).timetable.filter((r) => r.id).map((r) => [r.id, r])) : null;
    const sentIds = new Set(sent.map((r) => r.id).filter(Boolean)), free = was.filter((r) => r.id && !sentIds.has(r.id) && !removed.has(r.id));
    const take = (r, f) => { const i = free.findIndex(f); if (i < 0) return false; r.id = free[i].id; if (free[i].cap && !r.cap) r.cap = free[i].cap; if (free[i].from && !r.from) r.from = free[i].from; if (free[i].off) r.off = true; free.splice(i, 1); return true; };
    const mins = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
    for (const r of sent) if (!r.id) take(r, (h) => h.day === r.day && h.start === r.start && lc(h.title) === lc(r.title));
    for (const r of sent) if (!r.id && !sent.some((x) => x !== r && x.id && wasById.has(x.id) && x.day === r.day && lc(x.title) === lc(r.title))) {
      const near = free.filter((h) => h.day === r.day && lc(h.title) === lc(r.title)).sort((a, c) => Math.abs(mins(a.start) - mins(r.start)) - Math.abs(mins(c.start) - mins(r.start)))[0];
      if (near) take(r, (h) => h === near);
    }
    const out = [], ids = new Set(), fresh = new Set();
    for (const r of sent) {
      if (r.id && removed.has(r.id)) continue;
      // Untouched by this coach: what's saved now wins (another coach may have changed it, or taken it off, since).
      if (r.id && base && base.has(r.id) && ttFull(base.get(r.id)) === ttFull(r)) { const cur = wasById.get(r.id); if (cur && !ids.has(cur.id)) { out.push({ ...cur }); ids.add(cur.id); } continue; }
      const isNew = !r.id || !wasById.has(r.id);
      if (!r.id || ids.has(r.id)) r.id = ttId(); ids.add(r.id); if (isNew) fresh.add(r);
      out.push(r);
    }
    // Rows saved since this coach opened it (or left out of an older copy) stay.
    for (const r of was) if (r.id && !ids.has(r.id) && !removed.has(r.id)) { out.push({ ...r }); ids.add(r.id); }
    for (const r of out) { if (b.calendar === false && fresh.has(r)) r.off = true; else if (b.calendar === true) delete r.off; }
    return out.sort((a, c) => TT_DAYS.indexOf(a.day) - TT_DAYS.indexOf(c.day) || a.start.localeCompare(c.start)).slice(0, 120);
  }
  // Where a row's class in a week (its Monday) starts, in the gym's time zone.
  const ttStart = async (u, r, week) => (await q("select (($1::date + $2::int) + $3::time) at time zone $4 as at", [week, TT_DAYS.indexOf(r.day), r.start, tzOf(u)])).rows[0].at;
  const ttWhen = (r) => `${TTDL[TT_DAYS.indexOf(r.day)] || r.day}s at ${r.start}`;
  const TTDL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  // Future classes from a row that people have booked or are waiting for.
  const bookedOf = (gymId, slots) => q(`select c.*, (select count(*) from attendance a where a.class_id=c.id and (a.going or a.waitlisted)) as n from classes c
    where c.gym_id=$1 and c.slot_id = any($2) and c.starts_at > now()`, [gymId, slots]);
  // Timetable rows changed or removed: their future classes nobody has booked follow at once (or go, for a removed row).
  // Booked ones keep their time, so nobody's booking changes without being told: they're listed for the coach to move.
  // A class changed by hand for one week (a seminar, a substitute coach, another time) keeps that change: each part of it follows
  // the row only while it's still what the row said. For a removed row, such a class stays on as a one-off.
  async function ttChanged(u, was, now) {
    const key = (r) => [r.day, r.start, r.end, r.title, r.coach, r.level, r.type, r.cap].join("|"), byId = new Map(now.map((r) => [r.id, r]));
    const changed = was.filter((r) => r.id && (!byId.has(r.id) || key(byId.get(r.id)) !== key(r)));
    let moved = 0; const held = [];
    if (!changed.length) return { moved, held };
    const cs = (await bookedOf(u.gym_id, changed.map((r) => r.id))).rows;
    const titled = (r) => [lc(r.title), r.level ? lc(`${r.title} (${r.level})`) : null];
    for (const old of changed) {
      const r = byId.get(old.id), mine = cs.filter((c) => c.slot_id === old.id), timeSame = r && r.day === old.day && r.start === old.start;
      let n = 0, people = 0; const ids = [];
      for (const c of mine) {
        const booked = Number(c.n) > 0, oldAt = await ttStart(u, old, c.slot_week), onTime = new Date(oldAt).getTime() === new Date(c.starts_at).getTime();
        const ti = titled(old).indexOf(lc(c.title)), asRow = ti >= 0 && onTime;
        if (!r) {
          if (!asRow) await q("update classes set slot_id=null, slot_week=null where id=$1", [c.id]);
          else if (booked) { n++; people += Number(c.n); ids.push(String(c.id)); } else await q("delete from classes where id=$1", [c.id]);
          continue;
        }
        const same = (v, w) => String(v ?? "") === String(w ?? "");
        const title = ti < 0 ? c.title : ti === 1 && r.level ? `${r.title} (${r.level})` : r.title;
        const dur = c.duration_min === ttDur(old) ? ttDur(r) : c.duration_min;
        const coach = same(c.coach, old.coach) ? r.coach || "" : c.coach, level = same(c.level, old.level) ? r.level || "" : c.level, disc = same(c.discipline, old.type) ? r.type || "" : c.discipline;
        const cap = !booked && same(c.capacity, old.cap) ? r.cap || null : c.capacity;
        // The time follows only for a class still at the row's old time that nobody has booked.
        const follow = !timeSame && onTime, at = follow && !booked ? await ttStart(u, r, c.slot_week) : c.starts_at;
        if (new Date(at) <= new Date()) { await q("delete from classes where id=$1", [c.id]); continue; }
        await q(`update classes set title=$1, duration_min=$2, coach=$3, level=$4, discipline=$5, capacity=$6, starts_at=$7,
          moved_by=case when starts_at is distinct from $7 then $8 else moved_by end where id=$9`, [title, dur, coach, level, disc, cap, at, u.id, c.id]);
        if (follow && booked) { n++; people += Number(c.n); ids.push(String(c.id)); } else if (follow) moved++;
      }
      if (n) held.push({ slot: old.id, ids, title: (r || old).title, removed: !r, was: ttWhen(old), now: r ? ttWhen(r) : null, classes: n, bookings: people });
    }
    return { moved, held };
  }
  // The coach said "Move N bookings and tell them" (or, for a row taken off the timetable, "Cancel them and tell them"):
  // the booked classes from these rows go to the row's time (or are cancelled), and the people booked get an email and a notice.
  // classes: the ones the change held back (a class changed by hand for one week isn't in it, so it stays as it is).
  api.post("/coach/timetable/apply", wrap(async (req, res) => {
    const u = needCoach(req), slots = (Array.isArray(req.body?.slots) ? req.body.slots : []).map((x) => clean(x, 16)).filter(Boolean).slice(0, 120);
    if (!slots.length) fail(400, "Nothing to move.");
    const only = Array.isArray(req.body?.classes) ? new Set(req.body.classes.map(String)) : null;
    const rows = new Map((((await q("select profile from gyms where id=$1", [u.gym_id])).rows[0].profile || {}).timetable || []).map((r) => [r.id, r]));
    const cs = (await bookedOf(u.gym_id, slots)).rows.filter((c) => Number(c.n) > 0 && (!only || only.has(String(c.id))));
    let moved = 0, cancelled = 0, told = 0; const said = new Set();
    for (const c of cs) {
      const r = rows.get(c.slot_id), at = r ? await ttStart(u, r, c.slot_week) : null;
      if (r && new Date(at).getTime() === new Date(c.starts_at).getTime()) continue;
      const booked = (await q(`select u.id, ${EMAIL("u")} as email, u.name from attendance a join users u on u.id=a.user_id where a.class_id=$1 and (a.going or a.waitlisted)`, [c.id])).rows;
      const was = whenText(c.starts_at, tzOf(u));
      if (r && new Date(at) > new Date()) {
        await q("update classes set starts_at=$1, moved_by=$2 where id=$3", [at, u.id, c.id]);
        const now = whenText(at, tzOf(u));
        for (const p of booked) mail.sendLater({ to: p.email, ...mail.templates.moved(p.name, u.gym_name, c.title, was, now) });
        if (!said.has(c.slot_id)) { said.add(c.slot_id); await notify(u, c, booked, "moved", `Moved: ${c.title}`, `${c.title} is now on ${ttWhen(r)}. Bookings have moved with it.`); }
        moved++;
      } else {
        await q("delete from classes where id=$1", [c.id]);
        await q("insert into class_skips(gym_id,slot_id,week,starts_at,title) values($1,$2,$3,$4,$5)", [u.gym_id, c.slot_id, c.slot_week, c.starts_at, c.title]);
        for (const p of booked) mail.sendLater({ to: p.email, ...mail.templates.cancelled(p.name, u.gym_name, c.title, was) });
        if (!said.has(c.slot_id)) { said.add(c.slot_id); await notify(u, c, booked, "cancelled", `Cancelled: ${c.title}`, r ? `${c.title} on ${was} is cancelled.` : `${c.title} is off the timetable. Bookings have been cancelled.`); }
        cancelled++;
      }
      told += booked.length;
    }
    res.json({ moved, cancelled, told });
  }));
  // "Repeat: every week" on a new class: it becomes a row of the weekly timetable from that day on, and the calendar fills 8 weeks ahead.
  // The class asked for is always made, even on a day already gone (to take its register). A row already on the timetable at that
  // day and time with that name (or "name (level)", as the form suggests it) is used again, not doubled: a class of it the coach
  // deleted comes back. undo says what Undo takes back (POST /coach/timetable/slot/undo).
  api.post("/coach/timetable/slot", once(async (req, res) => {
    const u = needCoach(req), c = readClass(req.body || {});
    if (c.kind === "private") fail(400, "Private lesson slots repeat from + Private slots.");
    const t = (await q("select to_char($1::timestamptz at time zone $2, 'ID HH24:MI YYYY-MM-DD') as s, date_trunc('week', $1::timestamptz at time zone $2)::date::text as week", [c.startsAt, tzOf(u)])).rows[0];
    const [dow, start, day] = t.s.split(" "), week = t.week;
    const [h, m] = start.split(":").map(Number), e = h * 60 + m + c.durationMin;
    const db = await pool.connect(); let row, rowNew = false, undo;
    try {
      await db.query("begin");
      await db.query("select pg_advisory_xact_lock(4711003, $1::int)", [u.gym_id]);
      const tt = (((await db.query("select profile from gyms where id=$1 for update", [u.gym_id])).rows[0].profile || {}).timetable || []);
      row = tt.find((r) => r.id && r.day === TT_DAYS[Number(dow) - 1] && r.start === start && [lc(r.title), r.level ? lc(`${r.title} (${r.level})`) : null].includes(lc(c.title)));
      undo = { slot: null, rowNew: false, classId: null, skip: false };
      if (row) {
        undo.wasOff = !!row.off; undo.wasFrom = row.from || null;
        if (row.off || (row.from && row.from > day)) { delete row.off; if (row.from && row.from > day) row.from = day; }
      } else {
        row = importer.cleanProfile({ timetable: [{ id: ttId(), day: TT_DAYS[Number(dow) - 1], start, end: e < 24 * 60 ? `${String(Math.floor(e / 60)).padStart(2, "0")}:${String(e % 60).padStart(2, "0")}` : "",
          title: c.title, type: c.discipline, coach: c.coach, level: c.level, cap: c.capacity, from: day }] }).timetable[0];
        tt.push(row); rowNew = true;
      }
      undo.slot = row.id; undo.rowNew = rowNew;
      await db.query(`update gyms set profile = jsonb_set(coalesce(profile,'{}'::jsonb), '{timetable}', $1::jsonb), profile_updated_at=now() where id=$2`, [JSON.stringify(tt), u.gym_id]);
      // That day's class: taken off the "deleted" list, then the one already there (made from the row, or by hand) or a new one.
      undo.skip = (await db.query("delete from class_skips where gym_id=$1 and ((slot_id=$2 and week=$3) or (starts_at=$4 and lower(title)=lower($5)))", [u.gym_id, row.id, week, c.startsAt, c.title])).rowCount > 0;
      let have = (await db.query(`select id from classes where gym_id=$1 and kind<>'private' and ((slot_id=$2 and slot_week=$3) or (slot_id is null and starts_at=$4 and lower(title)=lower($5))) order by slot_id nulls last limit 1`,
        [u.gym_id, row.id, week, c.startsAt, c.title])).rows[0];
      if (have) await db.query("update classes set slot_id=$1, slot_week=$2 where id=$3 and slot_id is null", [row.id, week, have.id]);
      else { have = (await db.query(`insert into classes(${CLASS_COLS},slot_id,slot_week) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`, [...classVals(u, c), row.id, week])).rows[0]; undo.classId = String(have.id); }
      // The lesson plan and "show the plan" choice go on that class.
      if (c.plan.focus || c.plan.notes || c.plan.ids.length || !c.shared) await db.query("update classes set plan=$1, shared=$2 where id=$3", [c.plan, c.shared, have.id]);
      await db.query("commit");
    } catch (err) { await db.query("rollback").catch(() => {}); throw err; } finally { db.release(); }
    const added = await rollTimetable(pool, u.gym_id) + (undo.classId ? 1 : 0);
    res.status(201).json({ added, slot: row, rowNew, undo });
  }));
  // Undo for "Added" (Repeat: every week): a new row comes off the timetable with its classes nobody has booked yet; for a row that
  // was already there, the class just made goes again (and stays deleted if it was), and the row is as it was.
  api.post("/coach/timetable/slot/undo", wrap(async (req, res) => {
    const u = needCoach(req), b = req.body || {}, slot = clean(b.slot, 16);
    if (!slot) fail(400, "Nothing to undo.");
    const empty = "not exists (select 1 from attendance a where a.class_id=classes.id)";
    let removed = 0;
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("select pg_advisory_xact_lock(4711003, $1::int)", [u.gym_id]);
      const tt = (((await db.query("select profile from gyms where id=$1 for update", [u.gym_id])).rows[0].profile || {}).timetable || []), row = tt.find((r) => r.id === slot);
      if (b.rowNew === true) {
        const left = tt.filter((r) => r.id !== slot);
        await db.query(`update gyms set profile = jsonb_set(coalesce(profile,'{}'::jsonb), '{timetable}', $1::jsonb), profile_updated_at=now() where id=$2`, [JSON.stringify(left), u.gym_id]);
        removed = (await db.query(`delete from classes where gym_id=$1 and slot_id=$2 and ${empty}`, [u.gym_id, slot])).rowCount;
        // Anyone who booked one already keeps it, as a one-off class.
        await db.query("update classes set slot_id=null, slot_week=null where gym_id=$1 and slot_id=$2", [u.gym_id, slot]);
      } else {
        if (row && (b.wasOff === true || (b.wasFrom && isDay(b.wasFrom)))) {
          if (b.wasOff === true) row.off = true; if (b.wasFrom && isDay(b.wasFrom)) row.from = b.wasFrom;
          await db.query(`update gyms set profile = jsonb_set(coalesce(profile,'{}'::jsonb), '{timetable}', $1::jsonb), profile_updated_at=now() where id=$2`, [JSON.stringify(tt), u.gym_id]);
          if (b.wasOff === true) removed += (await db.query(`delete from classes where gym_id=$1 and slot_id=$2 and ${empty} and id is distinct from $3`, [u.gym_id, slot, intOr(b.classId, 0)])).rowCount;
        }
        const c = b.classId ? (await db.query(`delete from classes where id=$1 and gym_id=$2 and ${empty} returning *`, [intOr(b.classId, 0), u.gym_id])).rows[0] : null;
        if (c) { removed++; if (b.skip === true && c.slot_id) await db.query("insert into class_skips(gym_id,slot_id,week,starts_at,title) values($1,$2,$3,$4,$5)", [u.gym_id, c.slot_id, c.slot_week, c.starts_at, c.title]); }
      }
      await db.query("commit");
    } catch (err) { await db.query("rollback").catch(() => {}); throw err; } finally { db.release(); }
    res.json({ ok: true, removed });
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
      method: p.method || "", status: p.status || "confirmed", hasProof: !!p.has_proof, months: p.months || 1, planId: p.plan_id ? String(p.plan_id) : null,
      forMonths: (p.for_month || p.alloc) && !p.pack_lessons ? Object.keys(sharesOf(p)).sort() : null,
      packId: p.pack_id ? String(p.pack_id) : null, packLessons: p.pack_lessons || null, packName: p.pack_name || null,
      family: p.family_cents ? { of: String(p.split_of || p.id), totalCents: Number(p.family_cents) } : null,
      read: p.ai ? { amountCents: a.amountCents || 0, date: a.date || "", reference: a.reference || "", payer: a.payer || "", bank: a.bank || "", match: a.match || "", isPayment: a.method === "claude" ? a.isPayment !== false : true, duplicateOf: a.duplicateOf || null, otherRef: a.otherRef || null, reading: !!a.reading, error: a.error ? "Couldn't read it automatically." : "" } : null };
  }
  // family_cents: for a family payment split between brothers and sisters (see familySplit), on the payment and on each share: the whole amount.
  const PAY_COLS = `p.*, exists(select 1 from pop_files f where f.payment_id=p.id) as has_proof, (select name from packs k where k.id=p.pack_id) as pack_name,
    (select o.amount_cents + sum(x.amount_cents) from payments o join payments x on x.split_of=o.id where o.id=coalesce(p.split_of, p.id) group by o.id) as family_cents`;
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
  async function addProof({ u, gymId, userId, read, source, files, text, from, subject, note, method, pack, planId }) {
    let match = { userId: userId || null, how: userId ? "student" : "" };
    if (!userId && read) match = pop.matchStudent(read, text || "", await gymStudents(gymId));
    const amount = (read && read.amountCents) || 0, paidOn = (read && read.date) || (await todayIn(u || { timezone: null }));
    const reference = clean((read && read.reference) || "", 140);
    const dup = amount ? (await q(`select id from payments where gym_id=$1 and amount_cents=$2 and paid_on=$3 and status<>'rejected' and (($4::bigint is not null and user_id=$4) or ($5<>'' and reference=$5)) limit 1`,
      [gymId, amount, paidOn, match.userId, reference])).rows[0] : null;
    const ai = read ? { ...read, match: match.how, duplicateOf: dup ? String(dup.id) : null } : null;
    const r = await q(`insert into payments(gym_id,user_id,amount_cents,currency,paid_on,reference,note,source,email_from,email_subject,status,method,ai,submitted_by,pack_id,pack_lessons,pack_months,plan_id)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13,$14,$15,$16,$17) returning id`,
      [gymId, match.userId, amount, (u && u.currency) || "ZAR", paidOn, reference, clean(note, 500), source, from ? clean(from, 200) : null, subject ? clean(subject, 200) : null, method || "eft", ai, u ? u.id : null,
        pack ? pack.id : null, pack ? pack.lessons : null, pack ? pack.expiry_months : null, planId || null]);
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
    const u = needHead(req), g = (await q("select pay, pop_token, pop_notice, auto_remind from gyms where id=$1", [u.gym_id])).rows[0];
    let tok = g.pop_token;
    if (!tok) { tok = Array.from(crypto.randomBytes(10), (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join(""); await q("update gyms set pop_token=$1 where id=$2 and pop_token is null", [tok, u.gym_id]); tok = (await q("select pop_token from gyms where id=$1", [u.gym_id])).rows[0].pop_token; }
    res.json({ pay: g.pay || {}, autoRemind: g.auto_remind, popAddress: popAddress(tok), popReady: !!process.env.INBOUND_SECRET, popNotice: g.pop_notice || null, accessFeeCents: u.access_fee_cents || 0, accessMode: u.access_mode || "fee", privatePlanIds: (u.private_plan_ids || []).map(String), privateCents: u.gym_private_cents ?? null });
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
    const g = (await q("select pay, payfast from gyms where id=$1", [u.gym_id])).rows[0];
    const { today, month, plan, pv, led, d, bal } = await feesOf(u, u), sums = { paid: led.paid[month] || 0, pending: led.pending[month] || 0 };
    const recent = (await q(`select ${PAY_COLS} from payments p where p.user_id=$1 and p.gym_id=$2 and p.paid_on > $3::date - 200 order by p.paid_on desc, p.id desc limit 12`, [u.id, u.gym_id, today])).rows;
    const pa = await privateAccess(u);
    // Someone the gym's rule doesn't let book a private isn't offered packs they couldn't use.
    const packs = pa ? [] : (await q("select * from packs where gym_id=$1 and active order by lessons, price_cents", [u.gym_id])).rows.map(packOut);
    // On a year or term plan: what it really costs ("R8 500 for the year"), and when what they've paid runs out.
    const term = u.monthly_fee_cents == null && !feeOff(u.plan_status) ? termOf(plan) : null;
    if (term) { const last = (await q(`select amount_cents, paid_on, months, for_month, alloc from payments where user_id=$1 and gym_id=$2 and status='confirmed' and ${FEES}`, [u.id, u.gym_id])).rows
        .map((p) => Object.keys(sharesOf(p)).sort().pop()).sort().pop(), d = last ? mAdd(last, 1) + "-01" : null;
      term.renews = d && d > today ? d : null; }
    // A parent's Pay sheet: the family's total, and each kid's line with their own reference.
    const fm = familiesOf(await famRows(u.gym_id))[String(u.id)];
    let family = null;
    if (fm) { const kids = [];
      for (const id of fm) { const x = String(id) === String(u.id) ? u : (await q("select * from users where id=$1", [id])).rows[0], f = String(id) === String(u.id) ? { bal, led } : await feesOf(u, x, u);
        kids.push({ id: String(x.id), name: x.name, me: String(x.id) === String(u.id), owedCents: f.bal.owedCents, pending: f.led.pendingCents, months: f.bal.months.map((o) => o.month), reference: await payRef(x.id) }); }
      // A proof being checked counts for the whole family (one proof for them all, sent from one kid's sheet): it comes off each kid's
      // own line first, and what's more than that off their brothers' and sisters' lines, in order.
      let extra = 0; for (const k of kids) { const c = Math.min(k.owedCents, k.pending); k.owedCents -= c; extra += k.pending - c; delete k.pending; }
      for (const k of kids) { const c = Math.min(k.owedCents, extra); k.owedCents -= c; extra -= c; }
      family = { totalCents: kids.reduce((a, k) => a + k.owedCents, 0), kids }; }
    res.json({ pay: { family, dueCents: d.dueCents, privateAccess: pa, membershipCents: d.membershipCents, accessCents: d.accessCents, privatesCents: d.privatesCents, privates: d.privates, term,
      paidCents: Number(sums.paid), pendingCents: Number(sums.pending), currency: u.currency || "ZAR", privatesLeft: privOut(pv), packs,
      // the running balance: every month still owed ("R1 700 · Oct + Nov"), and everything sent that's still being checked
      owedCents: bal.owedCents, owedMonths: bal.months, creditCents: bal.creditCents, pendingAllCents: led.pendingCents, month, planStatus: u.plan_status, plan: plan ? planOut(plan) : null, plans: await pickablePlans(u, bal.owedCents), ...statusOut(u, month),
      reference: await payRef(u.id), bank: g.pay || {}, card: !!pfLive(pfOf(g)), autopay: await autopayOut(u, g, bal), payments: recent.map((p) => { const o = payOut(p); delete o.read; delete o.emailFrom; delete o.emailSubject; return o; }) } });
  }));
  api.post("/me/pay/proof", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id || u.role !== "student") fail(403, "Join a gym first.");
    if (limited("pop-u:" + u.id, 20, 24 * 3600e3)) fail(429, "That's a lot of uploads today. Ask your coach if something's wrong.");
    const b = req.body || {}, file = proofFile(b), pack = b.packId ? await packIn(u.gym_id, b.packId, true) : null;
    // "What's it for?" can be a plan, for a new member joining it: they're on it as a trial now, and for real once the coach confirms this.
    const plan = !pack && b.planId ? (await pickablePlans(u)).find((x) => x.id === String(b.planId)) || fail(404, "That plan isn't on offer.") : null;
    if (plan && String(u.plan_id) !== plan.id) { await q("update users set plan_id=$1, plan_started=$2 where id=$3", [plan.id, await todayIn(u), u.id]); u.plan_id = plan.id; }
    if (plan && u.plan_status !== "trial") await setStatus(u, u, "trial");
    const typed = intOr(b.amountCents, 0) || (pack ? pack.price_cents : 0) || (plan ? plan.priceCents : 0), on = isDay(b.paidOn) ? b.paidOn : "";
    const row = await addProof({ u, gymId: u.gym_id, userId: u.id, read: { amountCents: typed > 0 && typed < 1e8 ? typed : 0, date: on, reference: await payRef(u.id), reading: true }, source: "student", files: [file], note: b.note, method: "eft", pack, planId: plan ? plan.id : null });
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
  const isMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v || "");
  // Someone on a year or term plan: a payment covers amount ÷ plan price × the plan's months (R8 500 on R8 500 a year is 12 months).
  const PLAN_MONTHS = { year: 12, term: 3 };
  const termOf = (p) => (p && PLAN_MONTHS[p.period] && p.price_cents > 0 ? { name: p.name, priceCents: p.price_cents, months: PLAN_MONTHS[p.period], period: p.period } : null);
  // Which months a payment would pay if it were saved now (the Record payment sheet shows this as it's filled in). Nothing is saved.
  api.get("/coach/payments/months", wrap(async (req, res) => {
    const u = needHead(req), b = req.query || {}, amount = intOr(b.amountCents, 0), paidOn = isDay(b.paidOn) ? b.paidOn : await todayIn(u);
    const userId = b.userId ? (await ownStudent(u, b.userId)).id : null;
    if (!userId || !(amount > 0)) return res.json({ forMonths: [] });
    // A family payment: what goes to their brothers and sisters (as saving it would split it), unless the coach picked the month.
    const parts = !b.months && !isMonth(b.forMonth) && !b.packId ? await familySplit(u, userId, amount) : [], keep = amount - splitSum(parts);
    const fm = await feeMonths(u, userId, keep, paidOn, 0, b.months ? coverMonths(b.months) : 0, { from: b.forMonth, dry: true });
    res.json({ forMonths: keep > 0 ? Object.keys(sharesOf({ ...fm, amount_cents: keep, paid_on: paidOn })).sort() : [], keepCents: keep,
      split: await Promise.all(splitOut(parts).map(async (x) => ({ ...x, forMonths: Object.keys(sharesOf({ ...(await feeMonths(u, x.id, x.cents, paidOn, 0, 0, { dry: true })), amount_cents: x.cents, paid_on: paidOn })).sort() }))) });
  }));
  api.post("/coach/payments", once(async (req, res) => {
    const u = needHead(req), b = req.body || {};
    const amount = intOr(b.amountCents, NaN);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) fail(400, "Enter the amount paid.");
    const paidOn = isDay(b.paidOn) ? b.paidOn : fail(400, "Pick the date it was paid.");
    let userId = null;
    if (b.userId) userId = (await ownStudent(u, b.userId)).id;
    const method = METHODS.includes(b.method) ? b.method : "", pack = b.packId ? await packIn(u.gym_id, b.packId) : null;
    // Which months it pays, worked out now (feeMonths), from the month the coach picked (forMonth) if they did. A first payment ends a trial first.
    if (!pack && userId) await feeIn(u, userId);
    // More than they owe, for one of a family: the rest pays their brothers and sisters (unless the coach said which months it's for).
    const parts = !pack && userId && b.months === undefined && !isMonth(b.forMonth) ? await familySplit(u, userId, amount) : [], keep = amount - splitSum(parts);
    const fm = pack ? { for_month: null, months: 1, alloc: null } : await feeMonths(u, userId, keep, paidOn, 0, b.months === undefined ? 0 : coverMonths(b.months), { from: b.forMonth });
    const r = await q(`insert into payments(gym_id,user_id,amount_cents,currency,paid_on,reference,note,source,method,submitted_by,months,pack_id,pack_lessons,pack_months,for_month,alloc) values($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
      [u.gym_id, userId, keep, u.currency || "ZAR", paidOn, clean(b.reference, 140), clean(b.note, 500), method, u.id, fm.months, pack ? pack.id : null, pack ? pack.lessons : null, pack ? pack.expiry_months : null, fm.for_month, fm.alloc]);
    await saveSplit(u, r.rows[0], parts);
    res.status(201).json({ payment: payOut((await q(`select ${PAY_COLS} from payments p where p.id=$1`, [r.rows[0].id])).rows[0]), split: splitOut(parts) });
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
    // Which months it pays. Confirming a proof (or a payment that came in) works them out now, the first time it counts (feeMonths:
    // a year or term plan covers what the amount buys). After that they only change if the coach picks a month (forMonth) or the months,
    // or changes who paid, how much or when. A first confirmed payment ends a trial, and one sent for a plan puts them on it.
    let fm = { for_month: p.for_month, months: p.months, alloc: p.alloc };
    const nowFee = !pk[1] && status === "confirmed" && userId, first = nowFee && p.status !== "confirmed";
    if (first) await feeIn(u, userId, p.plan_id);
    // Confirming a family payment that's more than this one owes: the rest pays their brothers and sisters (see familySplit).
    const parts = first && !isMonth(b.forMonth) && b.months === undefined && !p.split_of ? await familySplit(u, userId, amount) : [], keep = amount - splitSum(parts);
    if (pk[1] || !userId) fm = { for_month: null, months: 1, alloc: null };
    else if (isMonth(b.forMonth)) fm = await feeMonths(u, userId, amount, paidOn, p.id, b.months !== undefined ? coverMonths(b.months) : 0, { from: b.forMonth, dry: status !== "confirmed" });
    else if (nowFee && (first || String(userId) !== String(p.user_id) || amount !== p.amount_cents || paidOn !== p.paid_on || b.months !== undefined))
      fm = await feeMonths(u, userId, keep, paidOn, p.id, b.months !== undefined ? coverMonths(b.months) : 0);
    else if (b.months !== undefined) fm = { for_month: p.for_month, months: coverMonths(b.months), alloc: null };
    const row = (await q("update payments set user_id=$1, amount_cents=$2, paid_on=$3, status=$4, method=$5, reference=$6, note=$7, months=$8, pack_id=$10, pack_lessons=$11, pack_months=$12, for_month=$13, alloc=$14 where id=$9 returning *",
      [userId, keep, paidOn, status, method, b.reference === undefined ? p.reference : clean(b.reference, 140), b.note === undefined ? p.note : clean(b.note, 500), fm.months, p.id, ...pk, fm.for_month, fm.alloc])).rows[0];
    await saveSplit(u, row, parts);
    res.json({ payment: payOut((await q(`select ${PAY_COLS} from payments p where p.id=$1`, [p.id])).rows[0]), split: splitOut(parts) });
  }));
  // Undo a family payment's split: the brothers' and sisters' shares go back on the payment it came from.
  api.post("/coach/payments/:id/unsplit", wrap(async (req, res) => {
    const u = needHead(req), p = (await q("select * from payments where id=coalesce((select split_of from payments where id=$1 and gym_id=$2), $1) and gym_id=$2", [intOr(req.params.id, 0), u.gym_id])).rows[0];
    if (!p) fail(404, "That payment doesn't exist.");
    const back = (await q("delete from payments where split_of=$1 and gym_id=$2 returning amount_cents", [p.id, u.gym_id])).rows.reduce((a, x) => a + x.amount_cents, 0);
    if (back) { const amount = p.amount_cents + back, fm = p.user_id && !p.pack_lessons ? await feeMonths(u, p.user_id, amount, p.paid_on, p.id) : { for_month: p.for_month, months: p.months, alloc: p.alloc };
      await q("update payments set amount_cents=$2, note=$3, for_month=$4, months=$5, alloc=$6 where id=$1", [p.id, amount, unNote(p.note), fm.for_month, fm.months, fm.alloc]); }
    res.json({ payment: payOut((await q(`select ${PAY_COLS} from payments p where p.id=$1`, [p.id])).rows[0]) });
  }));
  // Deleting a family payment takes its brothers' and sisters' shares with it. Deleting one share gives it back to the payment it came
  // from (that money did come in), which then pays its own person's months again.
  api.delete("/coach/payments/:id", wrap(async (req, res) => {
    const u = needHead(req);
    const r = await q("delete from payments where id=$1 and gym_id=$2 returning split_of, amount_cents", [intOr(req.params.id, 0), u.gym_id]);
    if (!r.rowCount) fail(404, "That payment doesn't exist.");
    const o = r.rows[0].split_of ? (await q("select * from payments where id=$1", [r.rows[0].split_of])).rows[0] : null;
    if (o) {
      const amount = o.amount_cents + r.rows[0].amount_cents, fm = o.user_id && !o.pack_lessons && o.status === "confirmed" ? await feeMonths(u, o.user_id, amount, o.paid_on, o.id) : { for_month: o.for_month, months: o.months, alloc: o.alloc };
      const left = (await q("select p.amount_cents as cents, u.name from payments p left join users u on u.id=p.user_id where p.split_of=$1 order by p.id", [o.id])).rows;
      const payer = (await q("select name from users where id=$1", [o.user_id])).rows[0] || { name: "" };
      const note = left.length ? noteWith(unNote(o.note), splitNote(amount + splitSum(left), { name: payer.name, cents: amount }, left, o.currency)) : unNote(o.note);
      await q("update payments set amount_cents=$2, note=$3, for_month=$4, months=$5, alloc=$6 where id=$1", [o.id, amount, note, fm.for_month, fm.months, fm.alloc]);
    }
    res.json({ ok: true, ...(o ? { backTo: String(o.id) } : {}) });
  }));

  // ---------- families: brothers and sisters ----------
  // Kids who share a parent: on the same parent's login, or added by the coach with the same parent's number (and a parent who's a
  // member, with the kids on their login). Each keeps their own fees and payment reference (parents may have saved them in their
  // banking app). They get one reminder between them, and money paid for one that's more than they owe pays the others.
  // xs: students (id, parent_id, parent_name, phone). Returns {id: [the family's ids, oldest record first]}, for families of 2 or more.
  function familiesOf(xs) {
    const up = {}, find = (a) => (up[a] && up[a] !== a ? (up[a] = find(up[a])) : a);
    const join = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (Number(a) < Number(b)) up[b] = a; else up[a] = b; } };
    const ids = new Set(xs.map((x) => String(x.id))), seen = {}, by = (k, id) => { if (seen[k]) join(id, seen[k]); else seen[k] = id; };
    for (const x of xs) {
      const id = String(x.id), ph = x.parent_name || x.parent_id ? phoneKey(x.phone) : "";
      if (x.parent_id) { by("p" + x.parent_id, id); if (ids.has(String(x.parent_id))) join(id, String(x.parent_id)); }
      if (ph.length >= 7) by("t" + ph, id);
    }
    const groups = {}, out = {};
    for (const id of ids) (groups[find(id)] = groups[find(id)] || []).push(id);
    for (const g of Object.values(groups)) if (g.length > 1) { g.sort((a, b) => Number(a) - Number(b)); for (const id of g) out[id] = g; }
    return out;
  }
  const famRows = async (gymId) => (await q("select id, name, parent_id, parent_name, phone from users where gym_id=$1 and role='student' and active", [gymId])).rows;
  // A fee payment for one of a family that's more than they owe pays the whole family's fees, oldest month first: everyone's months
  // still owed (the payer's and their brothers' and sisters', by month), then what's due next for each of them. So a payment from a
  // kid who's paid up pays a sister who owes before it pays his own next month. What's left over stays with the payer. Not for a
  // year or term plan (a big payment is what it costs). gym: the gym's money settings (a head coach's row works).
  // [{id, name, cents}] for each brother or sister it pays toward (the payer's own share is the rest).
  async function familySplit(gym, userId, amount) {
    const xs = await famRows(gym.gym_id), fam = familiesOf(xs)[String(userId)]; if (!fam || !(amount > 0)) return [];
    const bal = async (id) => { const x = (await q("select * from users where id=$1", [id])).rows[0], f = await feesOf(gym, x, gym); return { ...f.bal, term: x.monthly_fee_cents == null && !feeOff(x.plan_status) && termOf(f.plan) }; };
    const mine = await bal(userId); if (mine.term || amount <= mine.owedCents) return [];
    const me = String(userId), items = [], name = Object.fromEntries(xs.map((x) => [String(x.id), x.name]));
    for (const id of fam) { const b = id === me ? mine : await bal(id); for (const m of b.months) items.push({ id, month: m.month, cents: m.cents, next: 0 }); if (b.next) items.push({ id, month: b.next.month, cents: b.next.cents, next: 1 }); }
    // Months still owed before anything due next; then by month, the payer first, then oldest record first.
    items.sort((a, b) => a.next - b.next || (a.month < b.month ? -1 : a.month > b.month ? 1 : (b.id === me) - (a.id === me) || Number(a.id) - Number(b.id)));
    const got = {}; let rest = amount;
    for (const it of items) { if (rest <= 0) break; const c = Math.min(rest, it.cents); got[it.id] = (got[it.id] || 0) + c; rest -= c; }
    return Object.entries(got).filter(([id]) => id !== me).map(([id, cents]) => ({ id, name: name[id], cents }));
  }
  const splitSum = (parts) => parts.reduce((a, x) => a + x.cents, 0);
  const splitNote = (total, payer, parts, currency) => `Family payment of ${fmtMoney(total, currency)}: ${[payer, ...parts].filter((x) => x.cents > 0).map((x) => `${first(x.name)} ${fmtMoney(x.cents, currency)}`).join(", ")}.`;
  const noteWith = (note, add) => clean([note, add].filter(Boolean).join(" "), 500);
  const unNote = (note) => String(note || "").replace(/\s*Family payment of [^]*$/, "");
  // Saves the brothers' and sisters' shares (familySplit) of payment p (already saved with what was left for its own person) as
  // confirmed payments of their own, each paying its months (feeMonths), with a note.
  async function saveSplit(gym, p, parts) {
    if (!parts.length) return;
    const payer = (await q("select name from users where id=$1", [p.user_id])).rows[0] || { name: "" }, total = p.amount_cents + splitSum(parts);
    const note = splitNote(total, { name: payer.name, cents: p.amount_cents }, parts, p.currency);
    for (const x of parts) {
      const fm = await feeMonths(gym, x.id, x.cents, p.paid_on);
      await q(`insert into payments(gym_id,user_id,amount_cents,currency,paid_on,reference,note,source,method,status,submitted_by,months,for_month,alloc,split_of)
        values($1,$2,$3,$4,$5,$6,$7,'split',$8,'confirmed',$9,$10,$11,$12,$13)`, [p.gym_id, x.id, x.cents, p.currency || "ZAR", p.paid_on, p.reference || "", note, p.method || "", p.submitted_by, fm.months, fm.for_month, fm.alloc, p.id]);
    }
    await q("update payments set note=$2 where id=$1", [p.id, noteWith(unNote(p.note), note)]);
  }
  const splitOut = (parts) => parts.map((x) => ({ id: String(x.id), name: x.name, cents: x.cents }));

  // ---------- coach: money overview for a month ----------
  // Who owes what this month, what came in, and the last six months. Expected uses each student's current fee.
  // Each row has dues(month): what they owe that month (membership, access fee, privates with no credit).
  // until: the last month the running balance counts (this month unless said).
  async function moneyRows(u, month, until) {
    const plans = await plansOf(u.gym_id), pm = Object.fromEntries(plans.map((p) => [String(p.id), p]));
    const ppl = (await q(`select id, name, parent_name, parent_id, ${EMAIL("users")} as email, phone, pass_hash is null and parent_id is null as offline, claim_token, monthly_fee_cents, plan_id, plan_status, pay_ref, created_at, bill_from, trial_ends, reminded_at from users
      where gym_id=$1 and role='student' and active order by name`, [u.gym_id])).rows;
    const today = await todayIn(u), cur = today.slice(0, 7), priv = await privatesOf(u.gym_id, ppl.map((x) => x.id), tzOf(u), today), led = await feeLedger(u.gym_id, ppl.map((x) => x.id));
    await withBreaks(u.gym_id, ppl, u, tzOf(u));
    return ppl.map((x) => { const plan = pm[String(x.plan_id)] || null; const dues = (m) => duesFor(x, plan, u, priv[x.id], m);
      return { ...x, plan, dues, led: led[x.id], bal: balanceOf(x, plan, u, priv[x.id], led[x.id], until || cur), fee: dues(month).dueCents, term: x.monthly_fee_cents == null && !feeOff(x.plan_status) ? termOf(plan) : null }; });
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
    // Who pays by card automatically (while the gym takes saved cards), and whose card payment for this month needs a look: declined
    // (only while what it was for is still owed), or not confirmed by PayFast yet (cardCheck: the head coach says which, in one tap).
    const live = !!autoLive(pfLive(pfOf((await q("select payfast from gyms where id=$1", [u.gym_id])).rows[0])));
    const autos = new Set(live ? (await q("select user_id from autopay where gym_id=$1 and stopped_at is null", [u.gym_id])).rows.map((r) => String(r.user_id)) : []);
    const chs = Object.fromEntries((await q("select user_id, month, status, alloc from autopay_charges where gym_id=$1 and month=$2 and status in ('failed','unsure')", [u.gym_id, month])).rows.map((r) => [String(r.user_id), r]));
    const cardCheck = (await q("select c.id, c.amount_cents, c.month, u.name from autopay_charges c join users u on u.id=c.user_id where c.gym_id=$1 and c.status='unsure' order by c.id", [u.gym_id])).rows
      .map((r) => ({ id: String(r.id), name: r.name, cents: r.amount_cents, month: r.month }));
    const lastEver = Object.fromEntries((await q("select user_id, max(paid_on) as last from payments where gym_id=$1 and status='confirmed' and user_id is not null group by user_id", [u.gym_id])).rows.map((r) => [String(r.user_id), r.last]));
    // Joined before the next month starts, by the gym's own clock (not UTC: someone added at 00:30 on the 1st joined that month).
    const tz = tzOf(u); for (const x of rows) x.joinedDay = dayIn(x.created_at, tz);
    const joined = (x) => x.joinedDay, inMonth = rows.filter((x) => joined(x) < next), fam = familiesOf(inMonth);
    // family: brothers and sisters share it (the id of the family's oldest record), for one reminder between them.
    const students = inMonth.map((x) => { const s = { paid: x.led.paid[month], pending: x.led.pending[month] }, d = x.dues(month); return { id: String(x.id), name: x.name, parentName: x.parent_name || "", family: fam[String(x.id)] ? fam[String(x.id)][0] : null, email: x.email || "", phone: x.phone || "", offline: x.offline, plan: x.plan ? x.plan.name : null, term: x.term,
      feeCents: x.fee, membershipCents: d.membershipCents, accessCents: d.accessCents, privatesCents: d.privatesCents, privates: d.privates, planStatus: x.plan_status, paidCents: Number(s.paid || 0), pendingCents: Number(s.pending || 0), lastPaid: lastEver[String(x.id)] || null, reference: x.pay_ref, claimUrl: x.claimUrl || null,
      // the running balance up to this month (every month still owed), and what's being checked in all
      owedCents: x.bal.owedCents, owedMonths: x.bal.months, nextMonth: x.bal.next, creditCents: x.bal.creditCents, pendingAllCents: x.led.pendingCents, ...statusOut(x, today.slice(0, 7)),
      // the last fee reminder (by email, from the app or the daily job): nobody is emailed twice within 6 days
      remindedAt: x.reminded_at || null, remindedRecently: !!x.reminded_at && Date.now() - new Date(x.reminded_at).getTime() < RECENT_DAYS * DAY,
      autopay: autos.has(String(x.id)), ...autoFlags(chs[String(x.id)], x.bal) }; });
    const methods = (await q(`select coalesce(nullif(method,''),'other') as m, sum(amount_cents) as c, count(*) as n from payments where gym_id=$1 and status='confirmed' and paid_on >= $2 and paid_on < $3 group by 1 order by 2 desc`, [u.gym_id, start, next])).rows.map((r) => ({ method: r.m, cents: Number(r.c), n: Number(r.n) }));
    const total = (await q(`select coalesce(sum(amount_cents) filter (where status='confirmed'),0) as c, coalesce(sum(amount_cents) filter (where status='confirmed' and user_id is null),0) as unmatched,
      coalesce(sum(amount_cents) filter (where status='pending'),0) as pending from payments where gym_id=$1 and paid_on >= $2 and paid_on < $3`, [u.gym_id, start, next])).rows[0];
    // six months up to this one
    const hist = [], from6 = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 6, 1)).toISOString().slice(0, 10);
    const colBy = Object.fromEntries((await q("select to_char(paid_on,'YYYY-MM') as m, sum(amount_cents) as c from payments where gym_id=$1 and status='confirmed' and paid_on >= $2 and paid_on < $3 group by 1", [u.gym_id, from6, next])).rows.map((r) => [r.m, Number(r.c)]));
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1 - i, 1)), m = d.toISOString().slice(0, 7), nx = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
      hist.push({ month: m, collectedCents: colBy[m] || 0, expectedCents: rows.filter((x) => joined(x) < nx).reduce((a, x) => a + x.dues(m).dueCents, 0) });
    }
    const g = (await q("select pay, auto_remind from gyms where id=$1", [u.gym_id])).rows[0];
    // People who left that month still owing (they're not on the list above any more).
    const left = (await q("select name, phone, email, owed_cents, left_at from left_owing where gym_id=$1 and month=$2 order by left_at", [u.gym_id, month])).rows
      .map((x) => ({ name: x.name, phone: x.phone, email: x.email || "", owedCents: x.owed_cents, leftOn: dayIn(x.left_at, tzOf(u)) }));
    res.json({ month, today, currency: u.currency || "ZAR", accessFeeCents: accessFee(u), autoRemind: g.auto_remind, mailOn: mail.mailOn(), dueDay: Math.min(28, Math.max(1, intOr((g.pay || {}).dueDay, 1))), students, left, methods, history: hist, cardCheck,
      collectedCents: Number(total.c), unmatchedCents: Number(total.unmatched), pendingCents: Number(total.pending) });
  }));
  // One member's fee reminder email. running: their running balance (every month still owed, up to the month moneyRows counted to),
  // or else what's left of that one month.
  // { mail } to send, or { skip }: "off" (paused, on trial or cancelled, with nothing owed from before), "paid" or "noEmail". Never for R0.
  async function reminderOf(u, x, month, bank, running) {
    const r = await remindInfo(u, x, month, running); if (r.skip) return r;
    if (!x.email) return { skip: "noEmail" };
    // A kid's reminder goes to their parent: "Hi Thandi", about Lerato's fees.
    const hi = hiOf(x), kid = x.parent_name || x.parent_id ? first(x.name) : "";
    return { mail: { to: x.email, replyTo: u.email, ...mail.templates.feeReminder(hi, u.gym_name, fmtMoney(r.due, u.currency), r.what, r.ref, bank, x.offline ? await claimUrl(u, x) : null, r.parts, kid) } };
  }
  // What a reminder asks someone for: the amount (due), what it's for, the lines that make it up and their reference. Or { skip }.
  async function remindInfo(u, x, month, running) {
    const got = x.led.paid[month] || 0, owed = running ? x.bal.months : [{ month, cents: Math.max(0, (x.fee || 0) - got) }].filter((o) => o.cents > 0);
    const left = owed.reduce((a, o) => a + o.cents, 0);
    if (!left && (feeOff(x.plan_status) || x.plan_status === "trial") && !x.fee) return { skip: "off" };
    if (!(left > 0)) return { skip: "paid" };
    const label = new Date(month + "-01T12:00:00Z").toLocaleDateString("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" });
    // A year or term plan with nothing paid yet: ask for what it really costs (R8 500 for the year), not a monthly slice of it.
    const d = x.dues(month), t = !got && owed.length === 1 && owed[0].month === month && x.term, due = t ? left - d.membershipCents + t.priceCents : left;
    const several = owed.length > 1 || (owed[0] && owed[0].month !== month);
    const parts = t ? [`${t.name}: ${fmtMoney(t.priceCents, u.currency)} for ${t.months} months`, ...dueParts({ ...d, membershipCents: 0 }, u.currency)]
      : several ? owed.map((o) => `${nameMonths([o.month])}: ${fmtMoney(o.cents, u.currency)}`) : dueParts(d, u.currency);
    const what = t ? `the ${t.period} from ${label}` : several ? nameMonths(owed.map((o) => o.month)) : label;
    return { due, what, label, parts, ref: x.pay_ref || (await payRef(x.id)) };
  }
  // Who a reminder is for: one member, or brothers and sisters (xs, a family that owes). A family gets one email to their parent:
  // one total, a line per kid with what it's for, and each kid's own reference. { mail, xs: who it covers } or { skip }.
  const hiOf = (x) => (x.parent_name ? (x.parent_name === "Parent" ? "there" : first(x.parent_name)) : first(x.name));
  async function unitReminder(u, xs, month, bank, running) {
    const one = async (x, to) => { const r = await reminderOf(u, { ...x, email: x.email || to }, month, bank, running); return r.mail ? { ...r, xs: [x] } : r; };
    if (xs.length === 1) return one(xs[0]);
    const items = [], skips = [], to = xs.map((x) => x.email).find(Boolean);
    for (const x of xs) { const r = await remindInfo(u, x, month, running); if (r.skip) skips.push(r.skip); else items.push({ x, ...r }); }
    if (!items.length) return { skip: skips.includes("paid") ? "paid" : "off" };
    if (items.length === 1) return one(items[0].x, to);
    if (!to) return { skip: "noEmail" };
    const c = (v) => fmtMoney(v, u.currency), whats = [...new Set(items.map((i) => i.what))], off = items.find((i) => i.x.offline);
    const lines = items.map((i) => `${first(i.x.name)}: ${c(i.due)} for ${i.what}`);
    const m = mail.templates.familyReminder(hiOf(items[0].x), u.gym_name, c(items.reduce((a, i) => a + i.due, 0)), whats.length === 1 ? whats[0] : items[0].label, lines,
      items.map((i) => `${first(i.x.name)}: ${i.ref}`), bank, off ? await claimUrl(u, off.x) : null);
    return { mail: { to, replyTo: u.email, ...m }, xs: items.map((i) => i.x) };
  }
  // People to remind, with brothers and sisters together (see familiesOf).
  const remindUnits = (rows) => { const fam = familiesOf(rows), seen = new Set(), out = [];
    for (const x of rows) { const f = fam[String(x.id)]; if (!f) { out.push([x]); continue; } if (seen.has(f[0])) continue; seen.add(f[0]); out.push(rows.filter((y) => f.includes(String(y.id)))); }
    return out; };
  // Claims a reminder for each of them (nobody's reminded twice within 6 days), and works it out again for just the ones claimed.
  // { r, got: [{x, was}] } with got empty when they all had one in the last 6 days.
  async function claimUnit(u, r, month, bank, running) {
    const got = []; for (const x of r.xs) { const c = await claimRemind(x.id); if (c) got.push({ x, was: c.was }); }
    if (!got.length || got.length === r.xs.length) return { r, got };
    const again = await unitReminder(u, got.map((g) => g.x), month, bank, running);
    if (!again.mail) { for (const g of got) await q("update users set reminded_at=$2 where id=$1", [g.x.id, g.was]); return { r: again, got: [] }; }
    return { r: again, got };
  }
  const namesOf = (xs) => xs.map((x) => x.name).join(" and ");
  const bankOf = async (gymId) => { const pay = (await q("select pay from gyms where id=$1", [gymId])).rows[0].pay || {};
    return [pay.holder && `Account holder: ${pay.holder}`, pay.bank && `Bank: ${pay.bank}`, pay.account && `Account number: ${pay.account}`, pay.branch && `Branch code: ${pay.branch}`].filter(Boolean); };
  // Nobody gets two fee reminder emails within 6 days, by hand or automatically. Marks them reminded now, unless they were in the last
  // 6 days (then nothing: null). One at a time, so a double tap or two servers can't both send. was: when before (to put back if it fails).
  const RECENT_DAYS = 6;
  const claimRemind = async (id) => (await q(`with o as (select id, reminded_at from users where id=$1 for update)
    update users u set reminded_at=now() from o where u.id=o.id and (o.reminded_at is null or o.reminded_at < now() - interval '${RECENT_DAYS} days') returning o.reminded_at as was`, [id])).rows[0] || null;
  // Fee reminders by email (WhatsApp reminders are sent from the coach's phone). The first time, the app asks whether to send them
  // automatically from now on: the answer comes with it (auto: true or false) and isn't asked again.
  // recent: people left out because they had one in the last 6 days (the daily job, or a tap earlier today).
  api.post("/coach/money/remind", wrap(async (req, res) => {
    const u = needHead(req), b = req.body || {};
    if (!mail.mailOn()) fail(503, "Email isn't switched on yet. Use WhatsApp for reminders.");
    if (typeof b.auto === "boolean") await q("update gyms set auto_remind=$2 where id=$1", [u.gym_id, b.auto]);
    const today = await todayIn(u), month = /^\d{4}-\d{2}$/.test(b.month || "") ? b.month : today.slice(0, 7);
    const ids = (Array.isArray(b.userIds) ? b.userIds : []).map((x) => intOr(x, 0)).filter(Boolean).slice(0, 300);
    const all = await moneyRows(u, month), rows = all.filter((x) => ids.includes(Number(x.id))), bank = await bankOf(u.gym_id), fam = familiesOf(all);
    let sent = 0; const noEmail = [], paid = [], recent = [], checking = [], running = month === today.slice(0, 7);
    // A family where one of them just paid, or sent a proof that's being checked, may have paid for them all: not now.
    const held = await justPaid(u.gym_id, today, all);
    // Brothers and sisters get one email between them (sent counts emails, not people).
    for (const xs of remindUnits(rows)) {
      if (fam[String(xs[0].id)] && held.has(String(xs[0].id))) { checking.push(namesOf(xs)); continue; }
      const r0 = await unitReminder(u, xs, month, bank, running);
      if (r0.skip === "paid") paid.push(namesOf(xs)); else if (r0.skip === "noEmail") noEmail.push(namesOf(xs));
      if (!r0.mail) continue;
      if (limited("remind:" + u.gym_id, 300, 24 * 3600e3)) break;
      const { r, got } = await claimUnit(u, r0, month, bank, running);
      if (!got.length) { recent.push(namesOf(r0.xs)); continue; }
      mail.sendLater(r.mail); sent++;
    }
    res.json({ sent, noEmail, paid, recent, checking, autoRemind: (await q("select auto_remind from gyms where id=$1", [u.gym_id])).rows[0].auto_remind });
  }));
  // Money > Setup: automatic reminders on or off.
  api.put("/coach/money/auto", wrap(async (req, res) => {
    const u = needHead(req), on = !!(req.body && req.body.on);
    await q("update gyms set auto_remind=$2 where id=$1", [u.gym_id, on]);
    res.json({ autoRemind: on });
  }));

  // ---------- automatic fee reminders (a scheduled job) ----------
  // For gyms that said yes: on the due day and 7 days later (from 8am, gym time), an email to each member who still owes for the
  // months up to the one that fell due. With the 25th as the due day, the run on 2 December asks for November (and anything older),
  // never for December, which isn't due until the 25th.
  // Not to anyone paused, on trial or cancelled (or who left), anyone who paid or sent a proof in the last 6 days or has one being
  // checked, or anyone reminded in the last 6 days. Safe to run any number of times and on several servers at once: each gym's day
  // is claimed before anything is sent, and each member is claimed before their email goes.
  // The emails go one at a time, half a second apart (the mail service takes only a few a second). One that fails doesn't count as
  // a reminder: a run half an hour later tries those people again (3 tries a day), and Home says how many couldn't be sent.
  // opts.hour, opts.day: the hour and the day ("YYYY-MM-DD") to act as (tests). Returns how many reminders went.
  const REMIND_HOUR = 8, REMIND_TRIES = 3, MAIL_GAP = Math.max(0, intOr(process.env.MAIL_GAP_MS, 500));
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  async function autoRemind(opts = {}) {
    if (!mail.mailOn()) return 0;
    const gyms = (await q(`select id, pay, to_char(now() at time zone coalesce(timezone,'Africa/Johannesburg'),'YYYY-MM-DD') as day,
      extract(hour from now() at time zone coalesce(timezone,'Africa/Johannesburg'))::int as hour from gyms where auto_remind`)).rows;
    let n = 0;
    for (const g of gyms) {
      const day = opts.day || g.day, wk = new Date(Date.parse(day + "T12:00:00Z") - 7 * DAY).toISOString().slice(0, 10), due = dueDayOf(g.pay);
      // The month whose due day this run is for: today's on the due day, last week's on the run 7 days later.
      const dueMonth = +day.slice(8, 10) === due ? day.slice(0, 7) : +wk.slice(8, 10) === due ? wk.slice(0, 7) : null;
      if ((opts.hour ?? g.hour) < REMIND_HOUR || !dueMonth) continue;
      try { n += await remindGym(g.id, day, dueMonth); } catch (e) { console.warn("reminders:", g.id, e.message); }
    }
    return n;
  }
  // Who not to remind: anyone who paid or sent a proof in the last 6 days, or has one being checked. A family counts as one: a parent
  // who sent one proof for all their kids (from one kid's Pay sheet) isn't reminded about the others. rows: moneyRows. A Set of ids.
  async function justPaid(gymId, today, rows) {
    const ids = new Set((await q(`select distinct user_id from payments where gym_id=$1 and user_id is not null and ${FEES}
      and (status='pending' or (status='confirmed' and (created_at > now() - interval '${RECENT_DAYS} days' or paid_on > $2::date - ${RECENT_DAYS})))`, [gymId, today])).rows.map((r) => String(r.user_id)));
    for (const x of rows) if (x.led && x.led.pendingCents > 0) ids.add(String(x.id));
    const fam = familiesOf(rows);
    for (const x of rows) { const f = fam[String(x.id)]; if (f && f.some((id) => ids.has(id))) f.forEach((id) => ids.add(id)); }
    return ids;
  }
  // remind_log: {day, sent, to: [names emailed], noEmail: [names], failed: [names], tries, at, done}. A day is claimed once; it's
  // claimed again (a retry) only while some failed or a run stopped half way, half an hour on, up to 3 times.
  async function remindGym(gymId, today, dueMonth) {
    if (!(await q(`update gyms set remind_log=case when coalesce(remind_log->>'day','') <> $2
        then jsonb_build_object('day', $2::text, 'sent', 0, 'to', '[]'::jsonb, 'noEmail', '[]'::jsonb, 'failed', '[]'::jsonb, 'tries', 1, 'at', now(), 'done', false)
        else remind_log || jsonb_build_object('tries', coalesce((remind_log->>'tries')::int, 1) + 1, 'at', now(), 'done', false) end
      where id=$1 and auto_remind and (coalesce(remind_log->>'day','') <> $2 or ((jsonb_array_length(coalesce(remind_log->'failed', '[]'::jsonb)) > 0 or remind_log->>'done' = 'false')
        and coalesce((remind_log->>'tries')::int, 1) < ${REMIND_TRIES} and coalesce((remind_log->>'at')::timestamptz, '-infinity') < now() - interval '30 minutes')) returning id`, [gymId, today])).rowCount) return 0;
    const h = await headCoach(gymId), u = h && (await q(`select ${ME_COLS} from users u ${ME_JOIN} where u.id=$1`, [h.id])).rows[0]; if (!u) return 0;
    const bank = await bankOf(gymId);
    const sent = [], noEmail = [], failed = [], rows = await moneyRows(u, dueMonth, dueMonth), held = await justPaid(gymId, today, rows);
    // Card members: left alone if their card pays it all, or reminded about just the older months the card doesn't pay.
    const cards = await autoHeld(gymId, dueMonth);
    for (const x of rows) { const from = cards.get(String(x.id)); if (!from) continue;
      const old = x.bal.months.filter((o) => o.month < from);
      if (!old.length) held.add(String(x.id)); else x.bal = { ...x.bal, months: old, owedCents: old.reduce((a, o) => a + o.cents, 0) }; }
    const due = rows.filter((x) => x.plan_status === "active" && !held.has(String(x.id)));
    for (const xs of remindUnits(due)) { // brothers and sisters: one email between them
      const r0 = await unitReminder(u, xs, dueMonth, bank, true);
      if (r0.skip === "noEmail") noEmail.push(namesOf(xs));
      if (!r0.mail) continue;
      const { r, got } = await claimUnit(u, r0, dueMonth, bank, true); if (!got.length) continue;
      if (sent.length + failed.length) await nap(MAIL_GAP);
      try { await mail.send(r.mail); sent.push(namesOf(got.map((g) => g.x))); }
      catch (e) { console.warn("reminder:", e.message); failed.push(namesOf(got.map((g) => g.x))); for (const g of got) await q("update users set reminded_at=$2 where id=$1", [g.x.id, g.was]); }
    }
    await q(`update gyms set remind_log=remind_log || jsonb_build_object('sent', coalesce((remind_log->>'sent')::int, 0) + $3::int, 'to', coalesce(remind_log->'to', '[]'::jsonb) || $4::jsonb,
      'noEmail', $5::jsonb, 'failed', $6::jsonb, 'done', true) where id=$1 and remind_log->>'day' = $2`, [gymId, today, sent.length, JSON.stringify(sent.slice(0, 200)), JSON.stringify(noEmail.slice(0, 50)), JSON.stringify(failed.slice(0, 50))]);
    return sent.length;
  }

  // ---------- members who stopped coming ----------
  // Home's card for the head coach: students on an active plan with a fee, who joined over 60 days ago and haven't come to or booked
  // a class in the last 60 days (nor one still to come). Left off for 30 days after Keep. Shown only when the gym really uses bookings
  // or the register (at least 3 others came in that time) and they're at most half the paying members: otherwise "nobody trained"
  // only means nobody books in the app. rows: the roster's people.
  // seen: who came to or booked a class in the last 60 days (or one still to come). back: whose pause, trial or cancelled plan ended
  // in the last 60 days (they count as new: someone just welcomed back from an injury isn't asked about again the next day).
  // Started alongside the roster, so it adds no wait.
  const seenSince = async (gymId) => { const set = (r) => new Set(r.rows.map((x) => String(x.user_id)));
    const [a, b] = await Promise.all([q(`select distinct a.user_id from attendance a join classes c on c.id=a.class_id where c.gym_id=$1
      and c.starts_at > now() - interval '60 days' and (a.attended or a.going or a.waitlisted)`, [gymId]),
      q(`select distinct user_id from plan_breaks where gym_id=$1 and (ended_at > now() - interval '60 days' or until_month + interval '1 month' > now() - interval '60 days')`, [gymId])]);
    return { seen: set(a), back: set(b) }; };
  function idleOf(raw, rows, { seen, back }, today) {
    const info = Object.fromEntries(raw.map((x) => [String(x.id), { old: !back.has(String(x.id)) && Date.now() - new Date(x.gym_joined_at && x.gym_joined_at > x.created_at ? x.gym_joined_at : x.created_at).getTime() > 60 * DAY,
      kept: !!x.idle_kept_until && x.idle_kept_until > today }]));
    const paying = rows.filter((x) => x.role === "student" && x.active && x.planStatus === "active" && x.membershipCents > 0);
    const idle = paying.filter((x) => info[x.id] && info[x.id].old && !seen.has(x.id));
    if (rows.filter((x) => x.role === "student" && seen.has(x.id)).length < 3 || idle.length * 2 > paying.length) return [];
    return idle.filter((x) => !info[x.id].kept).map((x) => ({ id: x.id, name: x.name }));
  }
  const idlePaused = async (userId, db = pool) => !!(await db.query("select 1 from plan_breaks where user_id=$1 and kind='pause' and reason='idle' and ended_at is null", [userId])).rows[0];
  // Someone paused for not coming, claimed back to active (once: a double tap, or two bookings at once, gets them once). The row as it was.
  const claimBack = async (userId, gymId) => (await q(`update users set plan_status='active' where id=$1 and gym_id=$2 and plan_status='paused'
    and exists (select 1 from plan_breaks b where b.user_id=users.id and b.kind='pause' and b.reason='idle' and b.ended_at is null) returning *`, [userId, gymId])).rows[0];
  // [Pause their fees]: paused from this month until they're back (unless this month is paid), out of reminders and Expected.
  // They get a "we miss you" a few minutes later (tellMissed), so undo (right after) stops it. [Keep]: off the card for 30 days.
  // Each member is claimed (active to paused) before their pause is made, so a double tap pauses them once and they hear once.
  // noEmail: the people paused who have no email, so the coach can send the "we miss you" on WhatsApp.
  api.post("/coach/idle", wrap(async (req, res) => {
    const u = needHead(req), b = req.body || {}, ids = (Array.isArray(b.userIds) ? b.userIds : []).map((x) => intOr(x, 0)).filter(Boolean).slice(0, 300);
    const sts = (await q("select * from users where id = any($1) and gym_id=$2 and role='student'", [ids, u.gym_id])).rows;
    if (b.action === "keep") { await q("update users set idle_kept_until=$3::date + 30 where id = any($1) and gym_id=$2", [sts.map((x) => x.id), u.gym_id, await todayIn(u)]); return res.json({ kept: sts.length }); }
    let n = 0;
    if (b.action === "undo") { for (const st of sts) { const c = await claimBack(st.id, u.gym_id); if (c) { await setStatus(u, { ...c, plan_status: "paused" }, "active"); n++; } } return res.json({ resumed: n }); }
    if (b.action !== "pause") fail(400, "Pick pause, keep or undo.");
    const noEmail = [];
    for (const st of sts) {
      const c = (await q("update users set plan_status='paused' where id=$1 and gym_id=$2 and plan_status='active' returning *", [st.id, u.gym_id])).rows[0]; if (!c) continue;
      try { await setStatus(u, { ...c, plan_status: "active" }, "paused", { months: 0, now: true, reason: "idle" }); }
      catch (e) { await q("update users set plan_status='active' where id=$1", [c.id]); throw e; }
      n++; if (!(await emailOf(c))) noEmail.push({ id: String(c.id), name: c.name, parentName: c.parent_name || "", phone: c.phone || "" });
    }
    res.json({ paused: n, noEmail });
  }));
  // Someone paused for not coming books or checks in again: they're active again and the head coach hears. The pause is ended, not
  // undone, however soon they're back: the months it freed stay free (they were told their fees were on hold), and fees start again
  // next month. Their status is claimed first, so two bookings at once bring them back once.
  async function comeBack(userId, gymId, how) {
    const st = await claimBack(userId, gymId); if (!st) return;
    const g = await gymCtx(gymId), cur = (await todayIn(g)).slice(0, 7);
    const b = (await q("select to_char(from_month,'YYYY-MM') as f from plan_breaks where user_id=$1 and kind='pause' and reason='idle' and ended_at is null", [st.id])).rows[0];
    await setStatus(g, { ...st, plan_status: "paused" }, "active", { keep: true });
    const when = b && b.f <= cur ? `The months they were away stay free, and their fees start again from 1 ${nameMonths([mAdd(cur, 1)]).replace(/ \d{4}$/, "")}.` : "Their fees are back on.";
    await tellCoach(gymId, await headCoach(gymId), "resumed", `${st.name} ${how}, so they're active again. ${when}`);
  }
  // "We miss you" (a scheduled job): 10 minutes after the head coach paused people who stopped coming, a note in the app and an email
  // (people with no email get it from the coach on WhatsApp: the pause tells the coach who).
  // Each pause is claimed before its message goes, so it's sent once, from one server.
  async function tellMissed() {
    const rows = (await q(`update plan_breaks b set told_at=now() from users u join gyms g on g.id=u.gym_id
      where b.user_id=u.id and b.gym_id=u.gym_id and b.reason='idle' and b.told_at is null and b.ended_at is null and b.created_at < now() - interval '10 minutes'
      returning u.id, u.name, ${EMAIL("u")} as email, u.gym_id, g.name as gym_name`)).rows;
    let i = 0;
    for (const r of rows) {
      const m = mail.templates.missYou(first(r.name), r.gym_name);
      await q("insert into notices(gym_id,user_id,kind,title,body) values($1,$2,'missyou',$3,$4)", [r.gym_id, r.id, m.title, m.paras.slice(1).join(" ")]);
      // one at a time, a little apart, like the fee reminders (the mail service takes only a few a second)
      if (r.email) { if (i++) await nap(MAIL_GAP); await mail.send({ to: r.email, ...m }).catch((e) => console.warn("mail:", e.message)); }
    }
    return rows.length;
  }

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
    // Saved cards belong to the old account and need its passphrase: a new account, or no passphrase now, stops them (cancelled
    // there), and the members who saved them are told. They save their card again once it's back.
    const was = pfOf((await q("select payfast from gyms where id=$1", [u.gym_id])).rows[0]);
    if (was && (was.id !== id || (was.pass && !pass))) await dropAutopay("a.gym_id=$1", [u.gym_id], { keys: was, tell: true });
    await q("update gyms set payfast=$1 where id=$2", [{ merchantId: id, key: payfast.seal(key), pass: payfast.seal(pass), at: new Date().toISOString() }, u.gym_id]);
    tellHead(u.gym_id, "payfast", u.name, id);
    res.json({ ok: true });
  }));
  api.delete("/coach/payfast", wrap(async (req, res) => {
    const u = needHead(req), was = pfOf((await q("select payfast from gyms where id=$1", [u.gym_id])).rows[0]);
    if (was) await dropAutopay("a.gym_id=$1", [u.gym_id], { keys: was, tell: true });
    await q("update gyms set payfast=null where id=$1", [u.gym_id]); res.json({ ok: true });
  }));
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
      let auto = null; // a saved card: just saved, or one of its charges
      if (d.custom_str1 === "sub") { const P = payfast.platform(); pass = P.pass; sandbox = P.sandbox; merchant = P.id; gymId = intOr(d.custom_int1, 0); }
      else if (d.custom_str1 === "card" || /^auto-\d+$/.test(String(d.m_payment_id || ""))) {
        auto = await autoItnOf(d); if (!auto) throw new Error("unknown saved card");
        gymId = auto.gymId; const p = pfLive(pfOf((await q("select payfast from gyms where id=$1", [gymId])).rows[0])); if (!p) throw new Error("gym has no PayFast"); pass = p.pass; sandbox = p.sandbox; merchant = p.id;
      }
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
      } else if (auto) await autoIn(auto, d, sandbox, gross, merchant);
      else if (d.payment_status === "COMPLETE" && gross > 0) await cardIn({ gymId, uid: intOr(d.custom_int1, 0), gross, d, sandbox, packId: d.custom_int3 ? intOr(d.custom_int3, 0) : null });
    } catch (e) { console.warn("payfast itn:", e.message); }
  }));

  // A card payment PayFast confirmed, recorded as paid (like one the coach confirms). packId: the pack it was for, from the checkout.
  // auto: a charge on a saved card, for exactly what they owe: no family split, and no email to the head coach for each one (Money
  // shows them). Returns the payment saved, or null (not a member there, or recorded already).
  // after: an automatic charge pays the months it was for, from this one on (see feeMonths).
  async function cardIn({ gymId, uid, gross, d, sandbox, packId, auto, after, note: how }) {
    const ref = "PayFast " + clean(d.pf_payment_id, 40);
    const st = (await q("select u.id, u.name, g.timezone, g.currency from users u join gyms g on g.id=u.gym_id where u.id=$1 and u.gym_id=$2", [uid, gymId])).rows[0];
    const asked = packId && !auto ? (await q("select * from packs where id=$1 and gym_id=$2", [packId, gymId])).rows[0] : null;
    // A pack's lessons only come with its full price. The checkout form is in the student's hands, so a smaller amount
    // for a pack is kept as an ordinary payment, with no lessons, and the head coach is told.
    const pack = asked && gross >= asked.price_cents ? asked : null, short = asked && !pack ? { name: asked.name, price: fmtMoney(asked.price_cents, st && st.currency) } : null;
    const fee = d.amount_fee ? ` (PayFast fee R${Math.abs(Number(d.amount_fee)).toFixed(2)})` : "";
    const note = auto ? `Paid automatically from a saved card via PayFast${fee}${how || ""}` : `Card or Instant EFT via PayFast${fee}${short ? `. Less than ${short.name} costs (${short.price}), so no lessons were added.` : ""}`;
    // A payment through PayFast's test account moved no real money: kept as 'test', which no total counts (and gives no lessons).
    // A card payment for fees: a first one ends a trial, and it pays the months it's for (worked out now, like one the coach records).
    const gc = st && !pack && !sandbox ? await gymCtx(gymId) : null;
    if (gc) await feeIn(gc, uid);
    // A family's payment from one kid's Pay sheet: what's more than they owe pays their brothers and sisters (see familySplit).
    const dup = !!(await q("select 1 from payments where gym_id=$1 and source='payfast' and reference=$2", [gymId, ref])).rows[0];
    const parts = gc && !dup && !auto ? await familySplit(gc, uid, gross) : [], keep = gross - splitSum(parts);
    const fm = gc ? await feeMonths(gc, uid, keep, await todayIn(gc), 0, 0, { after: auto && after }) : { for_month: null, months: 1, alloc: null };
    const r = st ? await q(`insert into payments(gym_id,user_id,amount_cents,paid_on,reference,note,source,method,status,pack_id,pack_lessons,pack_months,months,for_month,alloc) values($1,$2,$3,(now() at time zone $4)::date,$5,$6,'payfast','payfast',$7,$8,$9,$10,$11,$12,$13) on conflict do nothing returning *`,
      [gymId, uid, keep, st.timezone || "Africa/Johannesburg", ref, note, sandbox ? "test" : "confirmed",
        pack ? pack.id : null, pack ? pack.lessons : null, pack ? pack.expiry_months : null, fm.months, fm.for_month, fm.alloc]) : null;
    if (r && r.rows[0] && gc) await saveSplit(gc, r.rows[0], parts);
    if (r && r.rows[0] && !sandbox && !auto) toHead(gymId, (name) => mail.templates.cardPaid(name, st.name, fmtMoney(gross, st.currency), pack ? pack.name : "", short));
    return (r && r.rows[0]) || null;
  }

  // ---------- card autopay: a member's saved card, charged what they owe on each due day ----------
  // Hidden (the server refuses, the app shows nothing) unless JitsFlow and the gym are both on live PayFast and the gym set a passphrase,
  // which PayFast needs for saved cards. There's no setting: it appears by itself once that's true. (PAYFAST_AUTOPAY_TEST=1: on the sandbox, for testing.)
  // The card is saved once (a PayFast tokenization checkout for R0.00, on the gym's own account). Each due day a scheduled job charges
  // exactly what's owed then, with JitsFlow's share split off by PayFast as on any card payment. PayFast's notification records it as paid.
  const autoLive = (p) => (p && p.pass && (payfast.autopayTest() || (!payfast.platform().sandbox && !p.sandbox)) ? p : null);
  const AUTO_HOUR = 7, AUTO_UNDO_MIN = 10;
  const ordinal = (n) => n + ([11, 12, 13].includes(n % 100) ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
  const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0] || "");
  // The month a charge on `day` is for: this month from its due day on, last month before it.
  const autoMonth = (day, pay) => (+day.slice(8, 10) >= dueDayOf(pay) ? day.slice(0, 7) : mAdd(day.slice(0, 7), -1));
  // Who a card pays for, in its emails: a kid by name (their record has the parent's name on it), an adult member is "you".
  const whoFor = (x) => (x.parent_name ? first(x.name) : "you");
  // Who gets the card emails: the login that saved it (for a family, the parent: their name is on the kid's record they sign in with).
  const payerOf = async (userId, payerId) => (await q(`select coalesce(nullif(u.parent_name,''), u.name) as name, ${EMAIL("u")} as email from users u where u.id=$1`, [payerId || userId])).rows[0] || {};
  // Takes saved cards off (where: on autopay a) and cancels each with PayFast once nothing uses it. opts.keys: the account to cancel
  // with (the gym's now if not given). opts.tell: email the people who saved them (the gym changed its PayFast account).
  async function dropAutopay(where, args, opts = {}) {
    const rows = (await q(`delete from autopay a where ${where} returning a.*`, args)).rows, seen = new Set();
    for (const r of rows) {
      if (seen.has(r.token_hash)) continue; seen.add(r.token_hash);
      if ((await q("select 1 from autopay where token_hash=$1", [r.token_hash])).rows[0]) continue;
      const m = opts.keys || pfOf((await q("select payfast from gyms where id=$1", [r.gym_id])).rows[0]);
      if (m && m.id === r.merchant_id) payfast.cancelToken(m, payfast.open(r.token)).catch(() => {});
      if (opts.tell) { const p = await payerOf(r.user_id, r.payer_id), g = (await q("select name from gyms where id=$1", [r.gym_id])).rows[0];
        if (p.email && g) mail.sendLater({ to: p.email, ...mail.templates.autopayEnded(first(p.name), g.name) }); }
    }
    return rows;
  }
  // The months a charge was for (oldest first): what it was worked out from when it was claimed.
  const chargeMonths = (c) => (c.alloc && Object.keys(c.alloc).length ? Object.keys(c.alloc).sort() : [c.month]);
  // A declined or unconfirmed charge matters only while a month it was for is still owed (bal: balanceOf). Paid another way since: nothing.
  const chargeOpen = (c, bal) => !!c && (!["failed", "unsure"].includes(c.status) || chargeMonths(c).some((m) => bal.months.some((o) => o.month === m)));
  // For a Money row: autopayFailed (declined, still owed), autopayUnsure (PayFast hasn't confirmed it: the head coach checks).
  const autoFlags = (c, bal) => ({ autopayFailed: !!c && c.status === "failed" && chargeOpen(c, bal), autopayUnsure: !!c && c.status === "unsure" });
  // For a member's Pay sheet and Me: null when it isn't offered (hidden). on: their card pays; names: who it pays for; from: the first
  // month it pays (older months owed are theirs to pay). A card that's still saved can always be stopped, even while it's hidden.
  async function autopayOut(u, g, bal) {
    if (u.role !== "student") return null;
    const a = (await q("select * from autopay where user_id=$1 and gym_id=$2 and stopped_at is null", [u.id, u.gym_id])).rows[0];
    if (!a && !autoLive(pfLive(pfOf(g)))) return null;
    const names = a ? (await q("select u.name from autopay a join users u on u.id=a.user_id where a.token_hash=$1 and a.gym_id=$2 and a.stopped_at is null order by u.id", [a.token_hash, u.gym_id])).rows.map((r) => first(r.name)) : [];
    const last = (await q("select month, amount_cents, status, alloc from autopay_charges where user_id=$1 and gym_id=$2 order by id desc limit 1", [u.id, u.gym_id])).rows[0];
    return { on: !!a, names, dueDay: dueDayOf(g.pay), from: a ? a.from_month : null, last: a && last && (!bal || chargeOpen(last, bal)) ? { month: last.month, cents: last.amount_cents, status: last.status } : null };
  }
  // "Save my card and pay automatically": PayFast's checkout saves the card (nothing is charged now). It pays for the person signed
  // in and, for a parent, each of their kids at the gym.
  api.post("/me/autopay", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id || u.role !== "student") fail(403, "Join a gym first.");
    const g = (await q("select name, payfast from gyms where id=$1", [u.gym_id])).rows[0], p = autoLive(pfLive(pfOf(g)));
    if (!p) fail(400, "Your gym doesn't take automatic card payments yet.");
    const payer = u.login || u, [fn, ...ln] = String(payer.name || "").trim().split(/\s+/);
    res.json(payfast.checkout({ merchant_id: p.id, merchant_key: p.key, return_url: mail.appUrl() + "/app/?autopay=on", cancel_url: mail.appUrl() + "/app/", notify_url: notifyUrl(),
      name_first: clean(fn, 100), name_last: clean(ln.join(" "), 100), email_address: payer.email || "", m_payment_id: `card-${payer.id}-${Date.now()}`, amount: "0.00",
      item_name: clean(`${g.name} fees, paid automatically`, 100), item_description: clean(u.name, 255), custom_int1: String(payer.id), custom_int2: String(u.gym_id), custom_int3: String(u.id),
      custom_str1: "card", subscription_type: "2" }, { pass: p.pass, sandbox: p.sandbox }));
  }));
  // Stop, in one tap, for everyone the card pays for. Undo works for 10 minutes; then the job cancels the card with PayFast.
  api.delete("/me/autopay", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) fail(403, "Join a gym first.");
    const a = (await q("select token_hash from autopay where user_id=$1 and gym_id=$2", [u.id, u.gym_id])).rows[0];
    const r = a ? await q("update autopay set stopped_at=now() where token_hash=$1 and gym_id=$2 and stopped_at is null", [a.token_hash, u.gym_id]) : { rowCount: 0 };
    res.json({ stopped: r.rowCount });
  }));
  api.post("/me/autopay/undo", wrap(async (req, res) => {
    const u = needUser(req); if (!u.gym_id) fail(403, "Join a gym first.");
    const a = (await q("select token_hash from autopay where user_id=$1 and gym_id=$2", [u.id, u.gym_id])).rows[0];
    const r = a ? await q(`update autopay set stopped_at=null where token_hash=$1 and gym_id=$2 and stopped_at > now() - interval '${AUTO_UNDO_MIN} minutes'`, [a.token_hash, u.gym_id]) : { rowCount: 0 };
    if (!r.rowCount) fail(409, "Too late to undo. Save your card again on the Pay sheet.");
    res.json({ on: true });
  }));
  // Which saved-card notification this is: one of its charges (our m_payment_id, or else the card's open charge) or the card just saved.
  async function autoItnOf(d) {
    const id = intOr((/^auto-(\d+)$/.exec(String(d.m_payment_id || "")) || [])[1], 0), th = d.token ? sha(String(d.token)) : null;
    let c = id ? (await q("select * from autopay_charges where id=$1", [id])).rows[0] : null;
    if (!c && th && Number(d.amount_gross || 0) > 0) c = (await q(`select c.* from autopay_charges c join autopay a on a.user_id=c.user_id and a.gym_id=c.gym_id
      where a.token_hash=$1 and c.status in ('charging','sent','unsure') order by c.id desc limit 1`, [th])).rows[0];
    if (c) return { charge: c, gymId: c.gym_id };
    return d.custom_str1 === "card" && !(Number(d.amount_gross || 0) > 0) ? { gymId: intOr(d.custom_int2, 0) } : null;
  }
  // A checked notification for a saved card.
  const CHECKED = "checked in PayFast by the head coach";
  async function autoIn(a, d, sandbox, gross, merchant) {
    if (!a.charge) {
      if (d.payment_status === "CANCELLED" && d.token) { await q("delete from autopay where token_hash=$1 and gym_id=$2", [sha(String(d.token)), a.gymId]); return; } // cancelled in PayFast
      if (d.payment_status === "COMPLETE" && d.token) await autopaySaved(a.gymId, intOr(d.custom_int1, 0), String(d.token), String(merchant));
      return;
    }
    const c = a.charge, ref = clean(d.pf_payment_id, 40);
    if (d.payment_status !== "COMPLETE" || !(gross > 0)) return autoFailed(c.id, "the bank declined it");
    // The head coach said it went through (Money) before this came: it's recorded already. PayFast's reference goes on it, and the receipt goes now.
    if (c.status === "paid") {
      if (!(await q("update autopay_charges set error='', updated_at=now() where id=$1 and status='paid' and error=$2 returning id", [c.id, CHECKED])).rowCount) return;
      if (c.payment_id) await q("update payments set reference=$2 where id=$1 and reference like 'PayFast auto-%'", [c.payment_id, "PayFast " + ref]).catch(() => {});
      return autoReceipt(c, gross, ref);
    }
    // Not confirmed in a day, and since then the head coach recorded a payment for them by hand (likely this one, as the email asked
    // before): not recorded twice. The head coach is told, in case it was a different payment.
    if (c.status === "unsure") {
      const m = (await q(`select id, paid_on from payments where gym_id=$1 and user_id=$2 and source='manual' and status='confirmed' and ${FEES} and created_at > $3 order by id limit 1`, [c.gym_id, c.user_id, c.created_at])).rows[0];
      if (m && (await q("update autopay_charges set status='paid', payment_id=$2, error='recorded by hand', updated_at=now() where id=$1 and status='unsure' returning id", [c.id, m.id])).rowCount) {
        const x = (await q("select u.name, g.currency, g.timezone from users u join gyms g on g.id=$2 where u.id=$1", [c.user_id, c.gym_id])).rows[0];
        if (x) toHead(c.gym_id, (name) => mail.templates.autopayByHand(name, x.name, fmtMoney(gross, x.currency), new Date(m.paid_on).toLocaleDateString("en-ZA", { day: "numeric", month: "long", timeZone: "UTC" })));
        return;
      }
    }
    // Claimed, so a notification sent twice records it once. A charge marked failed or unsure that PayFast confirms after all still counts.
    const pay = await autoRecord(c, gross, d, sandbox, ["charging", "sent", "unsure", "failed"]);
    if (pay) await autoReceipt(c, gross, ref);
  }
  // Records a charge PayFast took (or the head coach says it did), once: claimed from one of the statuses in `from`. It pays the
  // months it was charged for (not older ones). Someone who's left the gym since: see autoLeft. The payment saved, or null.
  async function autoRecord(c, gross, d, sandbox, from, how = "") {
    const inGym = !!(await q("select 1 from users where id=$1 and gym_id=$2", [c.user_id, c.gym_id])).rows[0];
    if (!(await q("update autopay_charges set status=$2, error=$3, updated_at=now() where id=$1 and status = any($4) returning id", [c.id, inGym ? "paid" : "left", how, from])).rowCount) return null;
    const pay = inGym ? await cardIn({ gymId: c.gym_id, uid: c.user_id, gross, d, sandbox, auto: true, after: chargeMonths(c)[0], note: how ? ` (${how})` : "" }) : await autoLeft(c, gross, d, sandbox);
    if (pay) await q("update autopay_charges set payment_id=$2 where id=$1", [c.id, pay.id]);
    return pay;
  }
  async function autoReceipt(c, gross, ref) {
    const x = (await q("select u.name, u.parent_name, a.payer_id, g.name as gym_name, g.currency from users u join gyms g on g.id=$2 left join autopay a on a.user_id=u.id where u.id=$1", [c.user_id, c.gym_id])).rows[0];
    const p = x ? await payerOf(c.user_id, x.payer_id) : {};
    if (p.email) mail.sendLater({ to: p.email, ...mail.templates.autopayPaid(first(p.name), x.gym_name, whoFor(x), fmtMoney(gross, x.currency), ref) });
  }
  // A charge PayFast confirmed after the member left the gym: the gym has the money, so it's recorded against them for the months
  // it was for, it comes off what they left owing, and the head coach is told once (to refund it in PayFast, or keep it).
  async function autoLeft(c, gross, d, sandbox) {
    const g = await gymCtx(c.gym_id); if (!g) return null;
    const ms = chargeMonths(c), alloc = c.alloc && ms.length > 1 && Object.values(c.alloc).reduce((a, x) => a + x, 0) === gross ? c.alloc : null;
    const r = (await q(`insert into payments(gym_id,user_id,amount_cents,currency,paid_on,reference,note,source,method,status,months,for_month,alloc) values($1,$2,$3,$4,(now() at time zone $5)::date,$6,$7,'payfast','payfast',$8,$9,$10,$11)
      on conflict do nothing returning *`, [c.gym_id, c.user_id, gross, g.currency || "ZAR", tzOf(g), "PayFast " + clean(d.pf_payment_id, 40), "Paid automatically from a saved card via PayFast, after they left the gym",
      sandbox ? "test" : "confirmed", alloc ? ms.length : 1, ms[0] + "-01", alloc])).rows[0];
    if (!r || sandbox) return r || null;
    const lo = (await q("update left_owing set owed_cents=greatest(0, owed_cents-$3) where id=(select id from left_owing where gym_id=$1 and user_id=$2 order by left_at desc limit 1) returning *", [c.gym_id, c.user_id, gross])).rows[0];
    if (lo && lo.owed_cents <= 0) await q("delete from left_owing where id=$1", [lo.id]);
    const who = ((await q("select name from users where id=$1", [c.user_id])).rows[0] || {}).name || (lo && lo.name) || "A member";
    toHead(c.gym_id, (name) => mail.templates.autopayAfterLeft(name, who, fmtMoney(gross, g.currency), lo && lo.owed_cents > 0 ? fmtMoney(lo.owed_cents, g.currency) : ""));
    return r;
  }
  // The head coach checked PayFast for a charge it never confirmed (Money shows it): it went through (recorded as paid, as PayFast's
  // notice would; if that notice comes later, it changes nothing), or it didn't (the member is asked to pay another way, and fee
  // reminders count them again). Undo works for 10 minutes after "it went through".
  api.post("/coach/money/card/:id", wrap(async (req, res) => {
    const u = needHead(req), went = !!(req.body && req.body.went);
    const c = (await q("select * from autopay_charges where id=$1 and gym_id=$2", [intOr(req.params.id, 0), u.gym_id])).rows[0];
    if (!c) fail(404, "That card payment doesn't exist.");
    if (c.status !== "unsure") fail(409, c.status === "paid" || c.status === "left" ? "PayFast has confirmed it since. It's recorded." : "PayFast has said since that it didn't go through.");
    if (!went) { await autoFailed(c.id, "not charged (" + CHECKED + ")", false); return res.json({ status: "failed" }); }
    const p = pfOf((await q("select payfast from gyms where id=$1", [u.gym_id])).rows[0]);
    const pay = await autoRecord(c, c.amount_cents, { pf_payment_id: "auto-" + c.id }, !!(p && p.sandbox), ["unsure"], CHECKED);
    res.json({ status: "paid", paymentId: pay ? String(pay.id) : null });
  }));
  api.post("/coach/money/card/:id/undo", wrap(async (req, res) => {
    const u = needHead(req);
    const c = (await q(`with o as (select id, payment_id from autopay_charges where id=$1 and gym_id=$2 and status='paid' and error=$3 and updated_at > now() - interval '${AUTO_UNDO_MIN} minutes' for update)
      update autopay_charges c set status='unsure', payment_id=null, error='', updated_at=now() from o where c.id=o.id returning o.payment_id as pid`, [intOr(req.params.id, 0), u.gym_id, CHECKED])).rows[0];
    if (!c) fail(409, "Too late to undo. Change the payment in Money › Payments.");
    if (c.pid) await q("delete from payments where id=$1 and gym_id=$2", [c.pid, u.gym_id]);
    res.json({ status: "unsure" });
  }));
  // A card saved: it pays for the login that saved it and their kids at the gym, from this month. Saving again (a new card) replaces
  // the old one, which is cancelled. What's owed for a month whose due day has come is charged straight away.
  async function autopaySaved(gymId, payerId, token, merchantId) {
    const g = await gymCtx(gymId); if (!g) return;
    const today = await todayIn(g), th = sha(token), ppl = (await q("select id, name, parent_name from users where gym_id=$1 and role='student' and active and (id=$2 or parent_id=$2) order by id", [gymId, payerId])).rows;
    if (!ppl.length) return;
    const old = (await q("select user_id, token, token_hash, merchant_id, stopped_at from autopay where user_id = any($1)", [ppl.map((x) => x.id)])).rows;
    if (ppl.every((x) => old.some((o) => String(o.user_id) === String(x.id) && o.token_hash === th && !o.stopped_at))) return; // the same notification again
    const gone = old.filter((o) => o.token_hash !== th);
    for (const x of ppl) await q(`insert into autopay(user_id,gym_id,payer_id,token,token_hash,merchant_id,from_month) values($1,$2,$3,$4,$5,$6,$7)
      on conflict (user_id) do update set gym_id=excluded.gym_id, payer_id=excluded.payer_id, token=excluded.token, token_hash=excluded.token_hash, merchant_id=excluded.merchant_id,
        from_month=case when autopay.gym_id=excluded.gym_id and autopay.stopped_at is null then least(autopay.from_month, excluded.from_month) else excluded.from_month end, stopped_at=null`,
      [x.id, gymId, payerId, payfast.seal(token), th, merchantId, today.slice(0, 7)]);
    // The card it replaces: cancelled with PayFast once nothing uses it.
    const m = pfOf((await q("select payfast from gyms where id=$1", [gymId])).rows[0]);
    const done = new Set();
    for (const o of gone) { if (done.has(o.token_hash)) continue; done.add(o.token_hash);
      if (m && m.id === o.merchant_id && !(await q("select 1 from autopay where token_hash=$1", [o.token_hash])).rows[0]) payfast.cancelToken(m, payfast.open(o.token)).catch(() => {}); }
    const p = await payerOf(payerId);
    if (p.email) mail.sendLater({ to: p.email, ...mail.templates.autopayOn(first(p.name), g.gym_name, andList(ppl.map(whoFor)), "the " + ordinal(dueDayOf(g.pay))) });
    const live = autoLive(pfLive(m)); if (!live) return;
    const month = autoMonth(today, g.pay);
    for (const x of ppl) { try { await chargeOne(g, live, x.id, month); } catch (e) { console.warn("autopay:", e.message); } }
  }
  // Charges one member's saved card what they owe up to `month` (the month whose due day has come), counting only months from when
  // their card was saved (older months stay for them to pay as before). Nothing if they're not active (paused, trial, cancelled),
  // left the gym or were marked inactive, a proof of theirs or of a brother's or sister's is being checked (one proof from a parent
  // may be for them all: the next day's run looks again), it's under R5, or this month was tried already. A card that isn't theirs
  // or their parent's any more (a kid taken off a parent's login) stops paying for them. The month is claimed, with the months and
  // amounts it's for, before PayFast is asked, so it's charged once, from one server. 1 if PayFast took it.
  async function chargeOne(gc, p, userId, month) {
    const a = (await q("select * from autopay where user_id=$1 and gym_id=$2 and stopped_at is null", [userId, gc.gym_id])).rows[0];
    if (!a || a.merchant_id !== String(p.id) || month < a.from_month) return 0;
    if ((await q("select 1 from autopay_charges where user_id=$1 and month=$2", [userId, month])).rows[0]) return 0;
    const x = (await q("select * from users where id=$1 and gym_id=$2 and role='student' and active", [userId, gc.gym_id])).rows[0];
    if (!x) return 0;
    if (a.payer_id && String(a.payer_id) !== String(x.id) && String(x.parent_id || "") !== String(a.payer_id)) { await dropAutopay("a.user_id=$1 and a.payer_id=$2", [x.id, a.payer_id]); return 0; }
    if (x.plan_status !== "active") return 0;
    const tz = tzOf(gc), today = await todayIn(gc), plan = x.plan_id ? (await q("select * from plans where id=$1", [x.plan_id])).rows[0] : null;
    await withBreaks(gc.gym_id, [x], gc, tz);
    const fam = familiesOf(await famRows(gc.gym_id))[String(x.id)] || [String(x.id)], leds = await feeLedger(gc.gym_id, fam);
    if (Object.values(leds).some((l) => l.pendingCents > 0)) return 0;
    const pv = (await privatesOf(gc.gym_id, [x.id], tz, today))[x.id], led = leds[String(x.id)];
    const ms = balanceOf(x, plan, gc, pv, led, month).months.filter((o) => o.month >= a.from_month), cents = ms.reduce((t, o) => t + o.cents, 0);
    if (cents < 500) return 0;
    const c = (await q("insert into autopay_charges(gym_id,user_id,month,amount_cents,alloc) values($1,$2,$3,$4,$5) on conflict do nothing returning *",
      [gc.gym_id, x.id, month, cents, Object.fromEntries(ms.map((o) => [o.month, o.cents]))])).rows[0];
    if (!c) return 0;
    const P = payfast.platform(), split = String(p.id) !== String(P.id) ? { merchant_id: Number(P.id), percentage: payfast.FEE_PCT() } : null;
    let r;
    // No answer (a timeout): the card may or may not have been charged, so it's never tried again. PayFast's notification records
    // it if it went through; after a day without one, the head coach is asked to check.
    try { r = await payfast.chargeToken(p, payfast.open(a.token), { cents, item: `${gc.gym_name} fees`, mPaymentId: `auto-${c.id}`, split }); }
    catch (e) { await q("update autopay_charges set error=$2, updated_at=now() where id=$1", [c.id, clean(e.message, 200)]); return 0; }
    if (r.ok) { await q("update autopay_charges set status='sent', updated_at=now() where id=$1 and status='charging'", [c.id]); return 1; }
    await autoFailed(c.id, r.reason); return 0;
  }
  // coach: false when the head coach said so themselves (Money), so they aren't emailed about it.
  async function autoFailed(id, why, coach = true) {
    const c = (await q("update autopay_charges set status='failed', error=$2, updated_at=now() where id=$1 and status in ('charging','sent','unsure') returning *", [id, clean(why, 200)])).rows[0];
    if (c) await autoTell(c, "failed", coach);
  }
  // Tells about a charge once. failed: the member (their card stays saved for next month) and the head coach (told_at claims it).
  // unsure: the head coach only, to check PayFast (the member may well have paid, so they're told nothing). The job's move to
  // unsure claims that one, so a charge that turns out declined after all is still told to the member.
  async function autoTell(c, kind, coach = true) {
    if (kind === "failed" && !(await q("update autopay_charges set told_at=now() where id=$1 and told_at is null", [c.id])).rowCount) return;
    const x = (await q("select u.name, u.parent_name, a.payer_id, g.name as gym_name, g.currency from users u join gyms g on g.id=$2 left join autopay a on a.user_id=u.id where u.id=$1", [c.user_id, c.gym_id])).rows[0]; if (!x) return;
    const amount = fmtMoney(c.amount_cents, x.currency), why = /declin|insufficient|expired|fund|limit/i.test(c.error) ? c.error : "";
    if (kind === "failed") { const p = await payerOf(c.user_id, x.payer_id); if (p.email) mail.sendLater({ to: p.email, ...mail.templates.autopayFailed(first(p.name), x.gym_name, whoFor(x), amount, why) }); }
    if (coach) toHead(c.gym_id, (name) => (kind === "failed" ? mail.templates.autopayFailedCoach(name, x.name, amount, why) : mail.templates.autopayUnsure(name, x.name, amount)));
  }
  // Card members fee reminders treat apart: their card pays from from_month, unless this month's charge was declined. One PayFast
  // hasn't confirmed stays with the card until the head coach says it didn't go through (they may well have paid). Older months
  // aren't the card's: remindGym reminds about just those. A Map of id to from_month.
  async function autoHeld(gymId, month) {
    if (!autoLive(pfLive(pfOf((await q("select payfast from gyms where id=$1", [gymId])).rows[0])))) return new Map();
    return new Map((await q(`select a.user_id, a.from_month from autopay a where a.gym_id=$1 and a.stopped_at is null and a.from_month <= $2
      and not exists (select 1 from autopay_charges c where c.user_id=a.user_id and c.month=$2 and c.status='failed')`, [gymId, month])).rows.map((r) => [String(r.user_id), r.from_month]));
  }
  // The scheduled job (every 15 minutes; each gym once a day, from 7am gym time, before the fee reminders). Safe on several servers
  // at once: each gym's day is claimed, and each member's month is claimed before their card is charged. opts.hour, opts.day: tests.
  // Also: cards stopped more than 10 minutes ago are cancelled with PayFast, and charges PayFast hasn't confirmed in a day go to the head coach.
  async function autopay(opts = {}) {
    await dropAutopay(`a.stopped_at < now() - interval '${AUTO_UNDO_MIN} minutes'`, []);
    for (const c of (await q("update autopay_charges set status='unsure', updated_at=now() where status in ('charging','sent') and created_at < now() - interval '1 day' returning *")).rows) await autoTell(c, "unsure");
    const gyms = (await q(`select g.id, g.pay, g.payfast, to_char(now() at time zone coalesce(g.timezone,'Africa/Johannesburg'),'YYYY-MM-DD') as day,
      extract(hour from now() at time zone coalesce(g.timezone,'Africa/Johannesburg'))::int as hour from gyms g where exists (select 1 from autopay a where a.gym_id=g.id and a.stopped_at is null)`)).rows;
    let n = 0;
    for (const g of gyms) {
      const p = autoLive(pfLive(pfOf(g))), day = opts.day || g.day; if (!p || (opts.hour ?? g.hour) < AUTO_HOUR) continue;
      if (!(await q("update gyms set autopay_day=$2 where id=$1 and autopay_day is distinct from $2", [g.id, day])).rowCount) continue;
      const gc = await gymCtx(g.id), month = autoMonth(day, g.pay);
      const ids = (await q("select a.user_id from autopay a where a.gym_id=$1 and a.stopped_at is null and not exists (select 1 from autopay_charges c where c.user_id=a.user_id and c.month=$2) order by a.user_id", [g.id, month])).rows;
      for (const r of ids) { try { n += await chargeOne(gc, p, r.user_id, month); } catch (e) { console.warn("autopay:", g.id, e.message); } }
    }
    return n;
  }

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

  // ---------- outreach: previews of gyms made from their websites, emailed to their owners (platform admins) ----------
  // A gym claimed from its preview page. takeProspect marks it claimed first (one claim per token, even two at once); the gym is
  // then made by the caller and filled in by claimProspect through applyProfile, the same save a coach's own website import uses.
  async function takeProspect(token) {
    const t = clean(token, 64);
    const r = outreach.TOKEN_RE.test(t) ? await q(`update prospects set status='claimed', claimed_at=now() where token=$1 and claimed_at is null and status<>'optedout'
      and import_state<>'running' and name<>'' returning *`, [t]) : { rows: [] };
    if (r.rows[0]) return r.rows[0];
    const x = outreach.TOKEN_RE.test(t) ? (await q("select claimed_at, status from prospects where token=$1", [t])).rows[0] : null;
    if (x && x.claimed_at) fail(409, "This gym has been claimed already. If it's yours, sign in.");
    fail(404, "That preview link isn't valid any more. Start your gym from scratch instead: it only takes a minute.");
  }
  const untakeProspect = (p) => q("update prospects set status=$2, claimed_at=null where id=$1 and claimed_gym_id is null", [p.id, p.sent_at ? "sent" : "draft"]);
  async function claimProspect(u, p) {
    await q("update prospects set claimed_gym_id=$2 where id=$1", [p.id, u.gym_id]);
    try {
      const profile = { ...(p.profile || {}), ...(p.accent ? { brand: { accent: p.accent, source: "site" } } : {}) };
      await applyProfile(u, { profile, plans: true }, { logo: p.logo ? { body: p.logo, type: p.logo_type } : null });
    } catch (e) { console.error("claim:", e.message); }
    for (const a of outreach.adminEmails()) mail.sendLater({ to: a, ...mail.templates.prospectClaimed(u.gym_name || outreach.nameOf(p), u.name, u.email, p.domain) });
  }
  // The claim screen's first look at a preview: the gym's name, logo and colour, and what's ready.
  api.get("/prospects/:token", wrap(async (req, res) => {
    if (limited("pro:" + clientIp(req), 30, 15 * 60e3)) fail(429, "Too many tries. Wait 15 minutes and try again.");
    const t = clean(req.params.token, 64), p = outreach.TOKEN_RE.test(t) ? (await q(`select ${outreach.LIST_COLS}, profile from prospects where token=$1`, [t])).rows[0] : null;
    if (!p || p.status === "optedout" || p.import_state === "running" || !p.name) fail(404, "That preview link isn't valid any more.");
    if (p.claimed_at) return res.json({ gym: { name: outreach.nameOf(p), claimed: true } });
    const pr = p.profile || {};
    res.json({ gym: { name: outreach.nameOf(p), logo: p.has_logo ? `/try/${p.token}/logo` : null, accent: p.accent || null, classes: (pr.timetable || []).length, coaches: (pr.coaches || []).length, prices: (pr.rates || []).length } });
  }));
  // Signed in with no gym of their own, they claim it straight away and become its head coach.
  api.post("/me/claim-gym", wrap(async (req, res) => {
    const u = needUser(req), lg = loginOf(u);
    if (lg.gym_id || u.gym_id) fail(409, `You're already in ${u.gym_name || "a gym"}. To claim this gym, sign out and start it with another email.`);
    const pro = await takeProspect(req.body?.token);
    let gymId;
    try {
      const g = await q("insert into gyms(name,student_code,coach_code,timezone,bill_start) values($1,$2,$3,$4,date_trunc('month', now() at time zone $4)::date) returning id",
        [clean(outreach.nameOf(pro), 100), code(), code(), (await validTz(req.body?.timezone)) || "Africa/Johannesburg"]);
      gymId = g.rows[0].id;
      await q("update users set gym_id=$1, role='coach', active=true, gym_joined_at=now() where id=$2", [gymId, lg.id]);
      await q("update gyms set head_coach_id=$1 where id=$2", [lg.id, gymId]);
    } catch (e) { if (gymId) await q("delete from gyms where id=$1", [gymId]).catch(() => {}); await untakeProspect(pro); throw e; }
    await claimProspect(await loadMe(lg.id), pro);
    res.status(201).json({ me: me(await loginMe(lg.id)), claimed: true });
  }));

  const outQueue = outreach.makeQueue(q, (m) => console.warn(m));
  // Imports a restart cut short start again.
  q("select id from prospects where import_state='running' order by id").then((r) => r.rows.forEach((x) => outQueue.add(x.id))).catch(() => {});
  const proRow = async (id) => (await q(`select ${outreach.LIST_COLS} from prospects where id=$1`, [intOr(id, 0)])).rows[0] || fail(404, "Not found.");
  const proFull = async (id) => (await q("select * from prospects where id=$1", [intOr(id, 0)])).rows[0] || fail(404, "Not found.");
  const proOut = async (r) => outreach.prospectOut(r, { base: "", blocked: r.status !== "optedout" && (await outreach.blocked(q, r.domain, r.owner_email)) });
  const adminOf = (u) => { const lg = loginOf(u); return { name: lg.name, email: lg.email }; };
  api.get("/admin/prospects", wrap(async (req, res) => {
    needAdmin(req);
    const rows = (await q(`select ${outreach.LIST_COLS} from prospects order by created_at desc, id desc limit 300`)).rows;
    res.json({ prospects: await Promise.all(rows.map(proOut)), mail: mail.mailOn(), followupDays: outreach.FOLLOWUP_DAYS });
  }));
  // Paste websites (one per line, optionally with the owner's name and email): each becomes a preview, read one at a time.
  api.post("/admin/prospects", once(async (req, res) => {
    const u = needAdmin(req), lines = outreach.parseLines(clean(req.body?.text, 20000)).slice(0, 25);
    if (!lines.length) fail(400, "Paste at least one website.");
    const added = [], skipped = [];
    for (const l of lines) {
      const tries = importer.siteCandidates(l.url), site = tries[0], domain = site ? outreach.domainOf(site) : "";
      if (!site || !domain) { skipped.push({ line: l.line, why: "That doesn't look like a website." }); continue; }
      const email = isEmail(l.email) ? l.email : null;
      if (await outreach.blocked(q, domain, email)) { skipped.push({ line: l.line, why: `${domain} asked not to be contacted.` }); continue; }
      if ((await q("select 1 from prospects where domain=$1 and status<>'optedout'", [domain])).rows[0]) { skipped.push({ line: l.line, why: `${domain} is on the list already.` }); continue; }
      if (limited("out-imp:" + u.id, 60, 60 * 60e3)) { skipped.push({ line: l.line, why: "That's a lot of imports for one hour. Try the rest later." }); continue; }
      const r = await q("insert into prospects(token,website,domain,owner_name,owner_email,created_by) values($1,$2,$3,$4,$5,$6) returning id", [outreach.newToken(), site, domain, clean(l.name, 80), email, u.id]);
      added.push(String(r.rows[0].id)); outQueue.add(r.rows[0].id);
    }
    res.status(201).json({ added, skipped });
  }));
  api.get("/admin/prospects/:id", wrap(async (req, res) => {
    const u = needAdmin(req), r = await proRow(req.params.id), full = await proFull(req.params.id);
    const email = r.status === "optedout" || !r.name ? null : outreach.renderEmail(full, { admin: adminOf(u), base: mail.appUrl() });
    const fu = email && r.status === "sent" && !r.followup_sent_at ? outreach.renderEmail(full, { admin: adminOf(u), base: mail.appUrl(), followup: true }) : null;
    res.json({ prospect: await proOut(r), email, followup: fu, from: `${adminOf(u).name} from JitsFlow`, replyTo: adminOf(u).email });
  }));
  // The email as the owner would see it, for the admin to look at in a browser tab.
  api.get("/admin/prospects/:id/email", wrap(async (req, res) => {
    const u = needAdmin(req), p = await proFull(req.params.id);
    if (p.status === "optedout" || !p.name) fail(404, "Nothing to show.");
    res.type("html").send(outreach.renderEmail(p, { admin: adminOf(u), base: mail.appUrl(), followup: req.query.followup === "1" }).html);
  }));
  api.patch("/admin/prospects/:id", wrap(async (req, res) => {
    needAdmin(req); const b = req.body || {}, p = await proRow(req.params.id);
    if (p.status === "optedout") fail(409, "This gym opted out.");
    const email = b.ownerEmail !== undefined ? clean(b.ownerEmail, 254).toLowerCase() : p.owner_email || "";
    if (email && !isEmail(email)) fail(400, "That email address doesn't look right.");
    const subject = b.subject !== undefined ? clean(b.subject, 150) : p.subject;
    await q("update prospects set owner_name=$2, owner_email=$3, personal_line=$4, subject=$5 where id=$1", [p.id, b.ownerName !== undefined ? clean(b.ownerName, 80) : p.owner_name,
      email || null, b.personalLine !== undefined ? clean(String(b.personalLine).replace(/\s+/g, " "), 300) : p.personal_line, subject || outreach.defaultSubject(await proFull(p.id))]);
    res.json({ prospect: await proOut(await proRow(p.id)) });
  }));
  // Send (or the one follow-up). Each is claimed in the database before it goes, so a double tap or two admins at once send it once.
  const sendOne = (followup) => once(async (req, res) => {
    const u = needAdmin(req), p = await proFull(req.params.id), a = adminOf(u);
    if (p.status === "claimed") fail(409, "This gym has claimed its page already.");
    if (p.status === "optedout") fail(409, "This gym opted out. It won't be contacted.");
    if (p.import_state === "running" || !p.name) fail(409, "Still reading their website. Try again in a minute.");
    if (!p.owner_email || !isEmail(p.owner_email)) fail(400, "Add the owner's email first.");
    if (await outreach.blocked(q, p.domain, p.owner_email)) fail(409, "This gym asked not to be contacted.");
    if (!mail.mailOn()) fail(503, "Email isn't switched on. Copy the email and send it yourself.");
    const took = followup
      ? await q(`update prospects set followup_sent_at=now() where id=$1 and status='sent' and followup_sent_at is null and sent_at <= now() - ($2 || ' days')::interval returning *`, [p.id, String(outreach.FOLLOWUP_DAYS)])
      : await q("update prospects set status='sent', sent_at=now(), sent_to=owner_email, sent_by=$2 where id=$1 and sent_at is null and status='draft' returning *", [p.id, u.id]);
    if (!took.rows[0]) fail(409, followup ? (p.followup_sent_at ? "The follow-up has gone already. One is enough." : p.status !== "sent" ? "Send the first email before a follow-up." : `A follow-up can go ${outreach.FOLLOWUP_DAYS} days after the first email.`) : "This email has gone already. A follow-up can go after " + outreach.FOLLOWUP_DAYS + " days.");
    const row = took.rows[0], e = outreach.renderEmail(row, { admin: a, base: mail.appUrl(), followup }), out = outreach.optoutUrl(row, mail.appUrl());
    try {
      await mail.sendRaw({ fromName: `${a.name} from JitsFlow`, to: followup ? row.sent_to || row.owner_email : row.owner_email, replyTo: a.email, subject: e.subject, html: e.html, text: e.text,
        headers: { "List-Unsubscribe": `<${out}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    } catch (err) {
      console.warn("outreach send:", err.message);
      await q(followup ? "update prospects set followup_sent_at=null where id=$1" : "update prospects set status='draft', sent_at=null, sent_to=null, sent_by=null where id=$1", [row.id]);
      fail(502, "Couldn't send it just now. Try again in a minute.");
    }
    res.json({ prospect: await proOut(await proRow(row.id)) });
  });
  api.post("/admin/prospects/:id/send", sendOne(false));
  api.post("/admin/prospects/:id/followup", sendOne(true));
  api.post("/admin/prospects/:id/reimport", wrap(async (req, res) => {
    const u = needAdmin(req), p = await proRow(req.params.id);
    if (p.status === "optedout" || p.status === "claimed") fail(409, p.status === "claimed" ? "This gym has claimed its page already." : "This gym opted out.");
    if (p.import_state === "running") return res.json({ prospect: await proOut(p) });
    if (limited("out-imp:" + u.id, 60, 60 * 60e3)) fail(429, "That's a lot of imports for one hour. Try again later.");
    await q("update prospects set import_state='running', import_error=null where id=$1", [p.id]); outQueue.add(p.id);
    res.json({ prospect: await proOut(await proRow(p.id)) });
  }));
  api.delete("/admin/prospects/:id", wrap(async (req, res) => {
    needAdmin(req); const p = await proRow(req.params.id);
    await q("delete from prospects where id=$1", [p.id]);
    res.json({ ok: true });
  }));

  api.use((req, res) => res.status(404).json({ error: "Not found." }));
  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    // signedOut: nobody is signed in on this request (as opposed to a wrong password), so the app asks them to sign in again.
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.status === 401 && !req.user ? { signedOut: true } : {}) });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "That's too much data in one go." });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Bad request." });
    console.error("API error:", err);
    res.status(500).json({ error: "Something went wrong on the server. Try again." });
  });
  // Scheduled jobs (server.js runs them every 15 minutes; each is safe to run twice or on several servers).
  // Card autopay goes first, so on a due day members whose card pays aren't reminded too.
  api.jobs = { autoRemind, tellMissed, autopay, run: async () => { await tellMissed(); await autopay().catch((e) => console.warn("autopay:", e.message)); await autoRemind(); } };
  return api;
}

module.exports = { makeApi };
