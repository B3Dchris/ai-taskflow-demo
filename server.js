// JitsFlow web server: the website in web/ plus the accounts API under /api (when DATABASE_URL is set).
"use strict";
const express = require("express");
const { makePool, migrate, purgeRejected, tick, rollAll } = require("./backend/db");
const { makeApi, clientIp } = require("./backend/api");
const visits = require("./backend/visits");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "web");
const PORT = Number(process.env.PORT) || 10000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};
const COMPRESS = new Set([".html", ".js", ".json", ".webmanifest", ".css", ".svg", ".txt", ".xml"]);
// Google Analytics 4: only when GA_ID looks like a real measurement ID. analytics.js waits for the visitor's consent.
const GA_ID = /^G-[A-Z0-9]{4,16}$/.test(process.env.GA_ID || "") ? process.env.GA_ID : null;
// The file's hash goes in the address, so Cloudflare and browsers fetch a new copy whenever it changes.
const GA_VER = (() => { try { return require("crypto").createHash("sha256").update(fs.readFileSync(path.join(ROOT, "analytics.js"))).digest("hex").slice(0, 8); } catch (e) { return "1"; } })();
const GA_TAG = GA_ID ? `<script>window.JF_GA="${GA_ID}"</script><script src="/analytics.js?v=${GA_VER}" defer></script>` : "";
// Where a visitor first came from (utm tags, a Google Ads click id, or the site that linked here), kept in this browser for 30 days
// and sent with their sign-up only (see signupSource in backend/visits.js). No cookie, nothing sent anywhere else, so no consent needed.
// A later visit with a campaign tag or ad click replaces one that only had a referring site.
const SRC_TAG = `<script>(function(){try{var K="jf.src",L=location,q=new URLSearchParams(L.search),o={},r="",n=0;
try{r=document.referrer?new URL(document.referrer).hostname.replace(/^www\\./,""):""}catch(e){}if(r===L.hostname.replace(/^www\\./,""))r="";
["utm_source","utm_medium","utm_campaign","gclid","gbraid","wbraid"].forEach(function(k){var v=q.get(k);if(v){o[k]=v.slice(0,150);n++}});
if(r)o.ref=r.slice(0,100);if(!n&&!r)return;var s=null;try{s=JSON.parse(localStorage.getItem(K)||"null")}catch(e){}
if(s&&Date.now()-s.t<30*864e5&&(!n||s.utm_source||s.gclid||s.gbraid||s.wbraid))return;
o.land=L.pathname.slice(0,120);o.t=Date.now();localStorage.setItem(K,JSON.stringify(o))}catch(e){}})();</script>`;

const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://i.ytimg.com https://*.google-analytics.com https://www.googletagmanager.com",
    "media-src 'self' blob:",
    "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
    "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'self'",
    "form-action 'self' https://www.payfast.co.za https://sandbox.payfast.co.za",
    "frame-ancestors 'self'",
  ].join("; "),
};

// Load every file once at startup (the whole site is under 1 MB), with a gzip copy for text.
const files = new Map();
(function load(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { load(full); continue; }
    const rel = "/" + path.relative(ROOT, full).split(path.sep).join("/");
    const ext = path.extname(name).toLowerCase();
    let body = fs.readFileSync(full);
    if (ext === ".html") body = Buffer.from(body.toString("utf8").replace("</head>", SRC_TAG + GA_TAG + "\n</head>"));
    files.set(rel, { body, gz: COMPRESS.has(ext) ? zlib.gzipSync(body, { level: 9 }) : null, ext,
      type: TYPES[ext] || "application/octet-stream" });
  }
})(ROOT);

// The app's build id (build.py puts it in the page). /api/status reports it, so an app left open can tell it's out of date.
const BUILD = ((files.get("/app/index.html") || {}).body || "").toString().match(/window\.JF_BUILD="(\w+)"/)?.[1] || null;

// API answers go gzipped when the browser takes it: a big gym's roster is 400 KB as JSON and about 25 KB gzipped, which matters on 3G.
function gzipJson(req, res, next) {
  if (!/\bgzip\b/.test(req.headers["accept-encoding"] || "")) return next();
  const json = res.json.bind(res);
  res.json = (obj) => {
    const body = Buffer.from(JSON.stringify(obj === undefined ? null : obj));
    if (body.length < 1400) return json(obj);
    zlib.gzip(body, { level: 6 }, (err, gz) => {
      if (err || res.headersSent) return err ? json(obj) : undefined;
      res.set({ "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip", "Content-Length": gz.length, Vary: "Accept-Encoding" });
      res.end(gz);
    });
    return res;
  };
  next();
}

function cacheFor(rel) {
  if (rel.endsWith("/index.html") || rel === "/sw.js" || rel === "/manifest.webmanifest") return "no-cache";
  if (rel.startsWith("/img/") || rel.startsWith("/og/") || rel.startsWith("/video/")) return "public, max-age=86400";
  if (rel.startsWith("/icons/")) return "public, max-age=604800";
  return "public, max-age=3600";
}

// Website visitors, counted here without cookies (backend/visits.js); on when there's a database.
let counter = null;

function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", ...SECURITY });
    return res.end();
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://x").pathname); }
  catch (e) { res.writeHead(400, SECURITY); return res.end("Bad request"); }

  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(req.method === "HEAD" ? undefined : "ok");
  }

  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/app") { res.writeHead(301, { Location: "/app/", ...SECURITY }); return res.end(); }
  // Short addresses for the gyms page (easy to say out loud or put on a flyer).
  if (/^\/(gyms?|for-gyms|coaches)$/.test(pathname) || pathname === "/gyms/") { res.writeHead(301, { Location: "/coaches/", ...SECURITY }); return res.end(); }
  // Content pages live at /techniques/kimura/ ; send /techniques/kimura there so each page has one address.
  if (!pathname.endsWith("/") && !path.extname(pathname) && files.has(pathname + "/index.html")) {
    const q = req.url.indexOf("?");
    res.writeHead(301, { Location: pathname + "/" + (q >= 0 ? req.url.slice(q) : ""), ...SECURITY });
    return res.end();
  }
  if (pathname.endsWith("/") && files.has(pathname + "index.html")) pathname += "index.html";
  // Unknown paths: anything under /app/ opens the app; anything else is a real 404 (so search engines don't index junk).
  const rel = files.has(pathname) ? pathname : pathname.startsWith("/app/") && !path.extname(pathname) ? "/app/index.html" : null;
  if (!rel) {
    const nf = files.get("/404.html");
    if (nf && !path.extname(pathname)) { res.writeHead(404, { "Content-Type": nf.type, "Cache-Control": "no-cache", ...SECURITY }); return res.end(req.method === "HEAD" ? undefined : nf.body); }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY });
    return res.end("Not found");
  }

  const f = files.get(rel);
  // Videos: Safari only plays a clip if the server answers byte-range requests.
  if (f.ext === ".mp4") {
    const size = f.body.length, m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    const base = { "Content-Type": f.type, "Accept-Ranges": "bytes", "Cache-Control": cacheFor(rel), ...SECURITY };
    if (!m) { res.writeHead(200, { ...base, "Content-Length": size }); return res.end(req.method === "HEAD" ? undefined : f.body); }
    let start = m[1] === "" ? size - Number(m[2]) : Number(m[1]), end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (!(start >= 0 && start <= end && end < size)) { res.writeHead(416, { ...base, "Content-Range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    return res.end(req.method === "HEAD" ? undefined : f.body.subarray(start, end + 1));
  }
  const gzip = f.gz && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  const body = gzip ? f.gz : f.body;
  const headers = { "Content-Type": f.type, "Content-Length": body.length, "Cache-Control": cacheFor(rel), Vary: "Accept-Encoding", ...SECURITY };
  if (gzip) headers["Content-Encoding"] = "gzip";
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
  // A page (not a file it loads): the app's page counts as an app open, any other as a website visit.
  if (counter && f.ext === ".html" && req.method === "GET") counter.record(req, rel === "/app/index.html" ? "/app/" : rel.replace(/index\.html$/, ""), rel === "/app/index.html");
}

async function main() {
  const app = express();
  app.disable("x-powered-by");
  // Render puts one proxy in front of the app; trust exactly that hop for the visitor's address (TRUST_PROXY=0 when nothing is in front).
  app.set("trust proxy", process.env.TRUST_PROXY !== undefined ? Number(process.env.TRUST_PROXY) : 1);
  app.use((req, res, next) => { res.set(SECURITY); next(); });
  const pool = makePool();
  if (pool) {
    await migrate(pool);
    setInterval(() => purgeRejected(pool).catch((e) => console.warn("purge:", e.message)), 864e5).unref(); // daily, between restarts
    // Hourly: pauses that ran out end by themselves (safe on several servers at once; see tick in backend/db.js).
    setInterval(() => tick(pool).catch((e) => console.warn("tick:", e.message)), 3600e3).unref();
    // The weekly timetable keeps about 8 weeks of classes on the calendar: each gym once a day (checked hourly, and now).
    const roll = () => rollAll(pool).catch((e) => console.warn("timetable:", e.message));
    roll(); setInterval(roll, 3600e3).unref();
    const api = makeApi(pool, { secureCookies: process.env.NODE_ENV === "production", build: BUILD });
    app.use("/api", gzipJson, api);
    // Private previews of gyms on JitsFlow, for their owners (made by platform admins: see backend/outreach.js).
    app.use("/try", require("./backend/outreach").makePublic(pool));
    // Every 15 minutes: automatic fee reminders (on each gym's due day and 7 days later) and "we miss you" notes. Safe on several servers.
    const jobs = () => api.jobs.run().catch((e) => console.warn("jobs:", e.message));
    jobs(); setInterval(jobs, 15 * 60e3).unref();
    counter = visits.makeCounter(pool, { clientIp, flushMs: Number(process.env.PAGEVIEW_FLUSH_MS) || 60e3, ownHost: (() => { try { return new URL(process.env.APP_URL || "https://www.jitsflow.com").hostname; } catch (e) { return ""; } })() }).start();
    // Render stops the server with SIGTERM on each deploy: write the last minute's counts first.
    let stopping = false;
    for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { if (stopping) return; stopping = true;
      Promise.race([counter.stop(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {}).then(() => process.exit(0)); });
    console.log("Accounts API on (database connected)");
  } else {
    app.use("/api", (req, res) => res.status(503).set("Cache-Control", "no-store").json({ error: "Accounts aren't switched on for this site yet." }));
    console.log("Accounts API off (no DATABASE_URL)");
  }
  app.use(serveStatic);
  app.listen(PORT, "0.0.0.0", () => console.log(`JitsFlow listening on port ${PORT} (${files.size} files)`));
}
main().catch((e) => { console.error("Startup failed:", e); process.exit(1); });
