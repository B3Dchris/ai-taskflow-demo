// JitsFlow web server: the website in web/ plus the accounts API under /api (when DATABASE_URL is set).
"use strict";
const express = require("express");
const { makePool, migrate, purgeRejected } = require("./backend/db");
const { makeApi } = require("./backend/api");
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
    if (ext === ".html" && GA_TAG) body = Buffer.from(body.toString("utf8").replace("</head>", GA_TAG + "\n</head>"));
    files.set(rel, { body, gz: COMPRESS.has(ext) ? zlib.gzipSync(body, { level: 9 }) : null, ext,
      type: TYPES[ext] || "application/octet-stream" });
  }
})(ROOT);

function cacheFor(rel) {
  if (rel.endsWith("/index.html") || rel === "/sw.js" || rel === "/manifest.webmanifest") return "no-cache";
  if (rel.startsWith("/img/") || rel.startsWith("/og/")) return "public, max-age=86400";
  if (rel.startsWith("/icons/")) return "public, max-age=604800";
  return "public, max-age=3600";
}

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
  const gzip = f.gz && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  const body = gzip ? f.gz : f.body;
  const headers = { "Content-Type": f.type, "Content-Length": body.length, "Cache-Control": cacheFor(rel), Vary: "Accept-Encoding", ...SECURITY };
  if (gzip) headers["Content-Encoding"] = "gzip";
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
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
    app.use("/api", makeApi(pool, { secureCookies: process.env.NODE_ENV === "production" }));
    console.log("Accounts API on (database connected)");
  } else {
    app.use("/api", (req, res) => res.status(503).set("Cache-Control", "no-store").json({ error: "Accounts aren't switched on for this site yet." }));
    console.log("Accounts API off (no DATABASE_URL)");
  }
  app.use(serveStatic);
  app.listen(PORT, "0.0.0.0", () => console.log(`JitsFlow listening on port ${PORT} (${files.size} files)`));
}
main().catch((e) => { console.error("Startup failed:", e); process.exit(1); });
