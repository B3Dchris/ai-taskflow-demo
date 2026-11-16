// Visitors to the public website, counted on the server without cookies (so no consent banner is needed for it).
// A visitor is one browser on one day: sha256(today's secret + address + browser), cut short. The secret is random, made each
// UTC day and deleted after it, so a visitor can't be followed from one day to the next and the hash can't be traced back.
// Raw addresses and browser strings are never stored. Hits are counted in memory and written in one batch about once a minute.
// Two counts: every page the server sends (views, pages, app), and the pages that then actually opened in a browser (seen, js,
// js_app): a tiny signal the page sends itself (BEACON in server.js) once someone is looking at it. Email security scanners, ad
// checkers and scrapers that pretend to be Chrome download pages but never send it, so the dashboard counts people by "seen".
"use strict";
const crypto = require("crypto");

// Robots, link previews, uptime checks and scripts: not people.
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|pagespeed|curl|wget|python|monitor|uptime|pingdom|http[-_ ]?client|okhttp|axios|node-fetch|undici|go-http|java\/|libwww|scrapy|facebookexternalhit|whatsapp|telegram|discord|skype|embedly|validator|feedfetcher|mediapartners|apis-google|semrush|ahrefs|bingpreview|phantom|selenium|puppeteer|playwright/i;
const isBot = (ua) => !ua || ua.length < 12 || BOT.test(ua);
const CLICK_IDS = ["gclid", "gbraid", "wbraid"]; // Google Ads click ids on the landing address
const KEEP_MONTHS = 13;

const str = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
const hostOf = (v) => { try { return new URL(String(v)).hostname.toLowerCase().replace(/^www\./, "").slice(0, 100); } catch (e) { return ""; } };
const cleanHost = (v) => { const h = str(v, 100).toLowerCase().replace(/^www\./, ""); return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(h) ? h : ""; };
// An ad click id, whole or not at all (a cut one is no use for matching it to the click in Google Ads).
const cleanId = (v) => { const s = String(v == null ? "" : v).trim(); return s.length <= 150 && /^[\w.~-]+$/.test(s) ? s : ""; };
const cleanTag = (v) => str(v, 80).toLowerCase();

// Where a visit or a sign-up came from, from the landing address and the referring site. A Google Ads click id wins over
// everything (it's a paid click even when the ad sent no utm tags); then utm tags; then the referring site's host.
const NAMES = [
  [/(^|\.)google\.[a-z.]+$|googlequicksearchbox/, "Google search"], [/(^|\.)bing\.com$/, "Bing"], [/duckduckgo\.com$/, "DuckDuckGo"], [/(^|\.)yahoo\.com$/, "Yahoo"],
  [/(^|\.)facebook\.com$|^fb\.me$|^fb\.com$/, "Facebook"], [/(^|\.)instagram\.com$/, "Instagram"], [/^t\.co$|(^|\.)twitter\.com$|^x\.com$/, "X (Twitter)"],
  [/(^|\.)youtube\.com$|^youtu\.be$/, "YouTube"], [/whatsapp\.com$|^wa\.me$/, "WhatsApp"], [/(^|\.)linkedin\.com$|^lnkd\.in$/, "LinkedIn"], [/(^|\.)reddit\.com$/, "Reddit"],
  [/(^|\.)tiktok\.com$/, "TikTok"], [/chatgpt\.com$|openai\.com$/, "ChatGPT"], [/perplexity\.ai$/, "Perplexity"],
];
const PAID = /^(cpc|ppc|paid|paidsearch|paid[-_ ]?social|cpm|display|ads?)$/;
const UTM_NAMES = { google: "Google", fb: "Facebook", facebook: "Facebook", ig: "Instagram", instagram: "Instagram", whatsapp: "WhatsApp", wa: "WhatsApp", newsletter: "Newsletter", email: "Email",
  youtube: "YouTube", yt: "YouTube", tiktok: "TikTok", linkedin: "LinkedIn", twitter: "X (Twitter)", x: "X (Twitter)", bing: "Bing" };
function channel(x) {
  x = x || {};
  if (x.click) return { name: "Google Ads", paid: true };
  const s = cleanTag(x.utm_source), m = cleanTag(x.utm_medium);
  if (s) {
    const paid = PAID.test(m);
    if (paid && /^(google|adwords|gads)/.test(s)) return { name: "Google Ads", paid: true };
    const n = UTM_NAMES[s] || s.charAt(0).toUpperCase() + s.slice(1);
    return paid ? { name: n + " ads", paid: true } : { name: n };
  }
  const h = cleanHost(x.ref);
  if (h) { const k = NAMES.find(([re]) => re.test(h)); return { name: k ? k[1] : h }; }
  if (x.via === "outreach") return { name: "Outreach email" };
  if (x.via === "code" || x.via === "invite") return { name: "Gym code or invite link" };
  return { name: "Direct" };
}

// What the app sends with a sign-up (first visit with a source, saved in the browser): checked and cut to size.
// via: how they signed up, set by the server (outreach: a gym claimed from its preview page; code/invite: joined a gym).
function signupSource(b, via) {
  const o = {};
  if (b && typeof b === "object" && !Array.isArray(b)) {
    for (const k of ["utm_source", "utm_medium", "utm_campaign"]) { const v = cleanTag(b[k]); if (v) o[k] = v; }
    const ref = cleanHost(b.ref); if (ref && ref !== "jitsflow.com") o.ref = ref;
    for (const k of CLICK_IDS) { const v = cleanId(b[k]); if (v) { o.click = k; o.click_id = v; break; } }
    const land = str(b.land, 120); if (/^\/[\w\-./%]*$/.test(land)) o.land = land;
    const t = Number(b.t); if (Number.isFinite(t) && t > 1.6e12 && t <= Date.now() + 864e5) o.first_at = new Date(t).toISOString();
  }
  if (via) o.via = via;
  return Object.keys(o).length ? o : null;
}

// The counter. pool: the database; clientIp(req): the visitor's address (see api.js). flushMs: how often to write.
function makeCounter(pool, { clientIp, flushMs = 60e3, ownHost = "" } = {}) {
  let views = new Map(), visitors = new Map(), waiting = [];
  let salt = null, saltDay = null, saltLoading = null, lastPurge = null, timer = null;
  const today = () => new Date().toISOString().slice(0, 10);
  const own = String(ownHost || "").toLowerCase().replace(/^www\./, "");

  async function loadSalt(day) {
    await pool.query("insert into site_salt(day, salt) values($1, $2) on conflict (day) do nothing", [day, crypto.randomBytes(32).toString("hex")]);
    const r = await pool.query("select salt from site_salt where day=$1", [day]);
    return r.rows[0].salt;
  }
  function needSalt(day) {
    if (saltDay === day && salt) return true;
    if (!saltLoading) {
      saltLoading = loadSalt(day).then((s) => { salt = s; saltDay = day; }, (e) => { console.warn("visits: secret:", e.message); salt = crypto.randomBytes(32).toString("hex"); saltDay = day; })
        .then(() => { saltLoading = null; const w = waiting; waiting = []; for (const h of w) count(h); });
    }
    return false;
  }

  function count(h) {
    if (!needSalt(h.day)) { if (waiting.length < 5000) waiting.push(h); return; }
    const vhash = crypto.createHash("sha256").update(salt + "\n" + h.ip + "\n" + h.ua).digest("hex").slice(0, 20);
    const k = h.day + "\t" + (h.app ? "/app/" : h.path), pv = views.get(k) || { v: 0, s: 0 };
    if (!views.has(k)) { if (views.size >= 20000) return; views.set(k, pv); }
    if (h.seen) pv.s++; else pv.v++;
    const vk = h.day + "\t" + vhash; let v = visitors.get(vk);
    if (!v) { if (visitors.size >= 100000) return; v = { day: h.day, vhash, first: h.path, ref: h.ref, s: h.s, m: h.m, c: h.c, click: h.click, cid: h.cid, country: h.country, pages: 0, app: 0, js: 0, js_app: 0 }; visitors.set(vk, v); }
    else if (!v.ref && !v.s && !v.click && h.ref) v.ref = h.ref; // the browser's own referrer, when the server's copy had none
    if (h.seen) { if (h.app) v.js_app++; else v.js++; } else if (h.app) v.app++; else v.pages++;
  }

  // One hit: the page's path, its address's query (utm tags, ad click ids) and the referring address.
  function hit(req, ua, path, app, search, referer, seen) {
    const qp = new URLSearchParams(search);
    let ref = hostOf(referer);
    if (ref && (ref === own || ref === "jitsflow.com" || ref === String(req.headers.host || "").toLowerCase().split(":")[0].replace(/^www\./, ""))) ref = "";
    let click = "", cid = "";
    for (const k of CLICK_IDS) { const v = cleanId(qp.get(k)); if (v) { click = k; cid = v; break; } }
    const cc = String(req.headers["cf-ipcountry"] || "").toUpperCase();
    count({ day: today(), path: str(path, 200), app: !!app, ip: clientIp(req), ua: ua.slice(0, 400), ref, seen: !!seen,
      s: cleanTag(qp.get("utm_source")), m: cleanTag(qp.get("utm_medium")), c: cleanTag(qp.get("utm_campaign")), click, cid,
      country: /^[A-Z]{2}$/.test(cc) && cc !== "XX" && cc !== "T1" ? cc : "" });
  }

  // A page was served (200, HTML). app: the app's page (counted as an app open, not a website visit).
  function record(req, path, app) {
    try {
      if (req.method !== "GET") return;
      const ua = String(req.headers["user-agent"] || "");
      if (isBot(ua)) return;
      const purpose = String(req.headers["sec-purpose"] || req.headers.purpose || req.headers["x-purpose"] || req.headers["x-moz"] || "");
      if (/prefetch|prerender|preview/i.test(purpose)) return;
      // Only pages opened in a browser tab: not the service worker saving the pages for offline use (dest "empty").
      const dest = String(req.headers["sec-fetch-dest"] || "");
      if (dest && dest !== "document") return;
      hit(req, ua, path, app, new URL(req.url, "http://x").search, req.headers.referer || req.headers.referrer || "", false);
    } catch (e) { /* counting never breaks a page */ }
  }

  // The page itself said it opened in a browser (POST /hit, sent by BEACON in server.js). b: { p: path, q: query, r: referrer }.
  // pageOf(path): the page's name as record() counts it ("/coaches/", "/app/"), or null for anything that isn't one of our pages.
  function seen(req, b, pageOf) {
    try {
      const ua = String(req.headers["user-agent"] || "");
      if (isBot(ua) || !b || typeof b !== "object") return false;
      const path = pageOf(str(b.p, 200));
      if (!path) return false;
      const q = str(b.q, 600);
      hit(req, ua, path, path === "/app/", q.startsWith("?") ? q : "", str(b.r, 400), true);
      return true;
    } catch (e) { return false; }
  }

  async function flush() {
    const vw = views, vs = visitors; views = new Map(); visitors = new Map();
    try {
      if (vw.size) {
        const d = [], p = [], n = [], sn = []; for (const [k, c] of vw) { const [day, path] = k.split("\t"); d.push(day); p.push(path); n.push(c.v); sn.push(c.s); }
        await pool.query(`insert into site_daily(day, path, views, seen) select * from unnest($1::date[], $2::text[], $3::int[], $4::int[])
          on conflict (day, path) do update set views = site_daily.views + excluded.views, seen = site_daily.seen + excluded.seen`, [d, p, n, sn]);
      }
      if (vs.size) {
        const cols = [[], [], [], [], [], [], [], [], [], [], [], [], [], []];
        for (const v of vs.values()) [v.day, v.vhash, v.first, v.ref, v.s, v.m, v.c, v.click, v.cid, v.country, v.pages, v.app, v.js, v.js_app].forEach((x, i) => cols[i].push(x));
        // A visitor first counted by the page being sent (with no referrer or tags) can get them from its signal, which
        // reads the browser's own referrer: blanks are filled, nothing already there is changed.
        await pool.query(`insert into site_visitors(day, vhash, first_path, ref, utm_source, utm_medium, utm_campaign, click, click_id, country, pages, app, js, js_app)
          select * from unnest($1::date[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::int[], $12::int[], $13::int[], $14::int[])
          on conflict (day, vhash) do update set pages = site_visitors.pages + excluded.pages, app = site_visitors.app + excluded.app,
            js = site_visitors.js + excluded.js, js_app = site_visitors.js_app + excluded.js_app,
            ref = case when site_visitors.ref = '' and site_visitors.utm_source = '' and site_visitors.click = '' then excluded.ref else site_visitors.ref end`, cols);
      }
    } catch (e) {
      console.warn("visits: flush:", e.message);
      // Keep them for the next try (merged with anything counted since), unless the database has been away a long time.
      for (const [k, c] of vw) { const w = views.get(k); if (w) { w.v += c.v; w.s += c.s; } else if (views.size < 20000) views.set(k, c); }
      for (const [k, v] of vs) { const w = visitors.get(k); if (w) { w.pages += v.pages; w.app += v.app; w.js += v.js; w.js_app += v.js_app; } else if (visitors.size < 100000) visitors.set(k, v); }
    }
    // Once a day: the days' secrets go once the day is over, and counts older than 13 months are deleted.
    const t = today();
    if (lastPurge !== t) {
      lastPurge = t;
      await pool.query("delete from site_salt where day < $1", [t]).catch(() => {});
      await pool.query(`delete from site_daily where day < (now() - interval '${KEEP_MONTHS} months')::date`).catch(() => {});
      await pool.query(`delete from site_visitors where day < (now() - interval '${KEEP_MONTHS} months')::date`).catch(() => {});
    }
  }

  let flushing = null;
  const flushNow = () => (flushing = (flushing || Promise.resolve()).then(flush, flush));
  function start() { if (!timer) { timer = setInterval(flushNow, flushMs); timer.unref(); } needSalt(today()); return api; }
  async function stop() { if (timer) clearInterval(timer); timer = null; if (saltLoading) await saltLoading; await flushNow(); }
  const api = { record, seen, flush: flushNow, start, stop, pending: () => ({ views: views.size, visitors: visitors.size, waiting: waiting.length }) };
  return api;
}

module.exports = { makeCounter, isBot, channel, signupSource, CLICK_IDS, KEEP_MONTHS };
