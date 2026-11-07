// JitsFlow web server: serves the prebuilt app in web/ on Render (no dependencies).
"use strict";
const http = require("http");
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
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};
const COMPRESS = new Set([".html", ".js", ".json", ".webmanifest", ".css", ".svg", ".txt"]);

const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://i.ytimg.com",
    "media-src 'self' blob:",
    "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
    "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
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
    const body = fs.readFileSync(full);
    files.set(rel, { body, gz: COMPRESS.has(ext) ? zlib.gzipSync(body, { level: 9 }) : null, ext,
      type: TYPES[ext] || "application/octet-stream" });
  }
})(ROOT);

function cacheFor(rel) {
  if (rel === "/index.html" || rel === "/sw.js" || rel === "/manifest.webmanifest") return "no-cache";
  if (rel.startsWith("/icons/")) return "public, max-age=604800";
  return "public, max-age=3600";
}

const server = http.createServer((req, res) => {
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
  // Unknown paths fall back to the app (it handles its own #today, #learn... views).
  const rel = files.has(pathname) ? pathname : (path.extname(pathname) ? null : "/index.html");
  if (!rel) {
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
});

server.listen(PORT, "0.0.0.0", () => console.log(`JitsFlow listening on port ${PORT} (${files.size} files)`));
