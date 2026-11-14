// The site's Content-Security-Policy (server.js for every page and file, outreach.js for the pages it writes).
"use strict";
const crypto = require("crypto");

// The security policy. Scripts run only from this site (and Google's tag manager): no inline script runs unless the page
// names it, by its hash (every page here is a file loaded at startup: see scriptHashes) or by a nonce made for that one
// response (pages the server writes, like /try/<token>). Inline styles stay allowed.
const cspFor = (scripts = "") => [
  "default-src 'self'",
  `script-src 'self'${scripts ? " " + scripts : ""} https://www.googletagmanager.com`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://i.ytimg.com https://*.google-analytics.com https://www.googletagmanager.com",
  "media-src 'self' blob:",
  "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
  "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self' https://www.payfast.co.za https://sandbox.payfast.co.za",
  "frame-ancestors 'self'",
].join("; ");
// The hashes of a page's inline scripts, for its policy: 'sha256-…' each. (A browser hashes the script's text as parsed, with
// line endings as \n.) Data blocks (JSON-LD) don't run, so they don't need one.
function scriptHashes(html) {
  const out = new Set();
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const at = m[1]; if (/\bsrc\s*=/i.test(at)) continue;
    const type = (at.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (type && !/^(text\/javascript|application\/javascript|module)$/i.test(type)) continue;
    out.add(`'sha256-${crypto.createHash("sha256").update(m[2].replace(/\r\n?/g, "\n"), "utf8").digest("base64")}'`);
  }
  return [...out].join(" ");
}

// A nonce for one response's inline scripts: <script nonce="…">, with cspFor(`'nonce-…'`).
const nonce = () => crypto.randomBytes(16).toString("base64");

module.exports = { cspFor, scriptHashes, nonce };
