// PayFast: gyms' JitsFlow subscription (into JitsFlow's account), and students paying their gym by card or Instant EFT
// (into the gym's own account, with JitsFlow's fee split off by PayFast). Follows developers.payfast.co.za.
"use strict";
const crypto = require("crypto");
const dns = require("dns").promises;

// Plans. Change with environment variables, never in code paths that handle money.
const PRICE_CENTS = () => Number(process.env.JF_PRICE_CENTS) || 9900; // R99 a month
const FEE_PCT = () => Number(process.env.JF_FEE_PCT) || 2; // JitsFlow's share of each student payment
const TRIAL_MONTHS = () => Number(process.env.JF_TRIAL_MONTHS) || 3;

// JitsFlow's own PayFast account. Without one set, PayFast's public sandbox test merchant is used.
const TEST = { id: "10000100", key: "46f0cd694581a", pass: "jt7NOE43FZPn" };
function platform() {
  const id = process.env.PAYFAST_MERCHANT_ID || "";
  const sandbox = !id || process.env.PAYFAST_SANDBOX === "1";
  return id ? { id, key: process.env.PAYFAST_MERCHANT_KEY || "", pass: process.env.PAYFAST_PASSPHRASE || "", sandbox } : { ...TEST, sandbox: true };
}
const host = (sandbox) => (sandbox ? "sandbox.payfast.co.za" : "www.payfast.co.za");

// The signature uses the fields in PayFast's documented order, skipping empty ones.
const ORDER = ["merchant_id", "merchant_key", "return_url", "cancel_url", "notify_url", "name_first", "name_last", "email_address", "cell_number",
  "m_payment_id", "amount", "item_name", "item_description", "custom_int1", "custom_int2", "custom_int3", "custom_int4", "custom_int5",
  "custom_str1", "custom_str2", "custom_str3", "custom_str4", "custom_str5", "email_confirmation", "confirmation_address", "payment_method",
  "subscription_type", "billing_date", "recurring_amount", "frequency", "cycles", "subscription_notify_email", "subscription_notify_webhook", "subscription_notify_buyer"];
const enc = (v) => encodeURIComponent(String(v).trim()).replace(/%20/g, "+");
function paramString(pairs, pass) {
  let s = pairs.filter(([, v]) => v !== "" && v !== undefined && v !== null).map(([k, v]) => `${k}=${enc(v)}`).join("&");
  if (pass) s += `&passphrase=${enc(pass)}`;
  return s;
}
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
function sign(fields, pass) { return md5(paramString(ORDER.filter((k) => k in fields).map((k) => [k, fields[k]]), pass)); }

// What the browser posts to PayFast. "setup" (the split) isn't part of the signature.
function checkout(fields, { pass, sandbox, split } = {}) {
  const f = {}; for (const k of ORDER) if (fields[k] !== undefined && fields[k] !== "") f[k] = String(fields[k]);
  f.signature = sign(f, pass);
  if (split) f.setup = JSON.stringify({ split_payment: split });
  return { action: `https://${host(sandbox)}/eng/process`, fields: f };
}

// ---- payment notifications (ITN) ----
// The posted fields, in the order PayFast sent them.
function parseItn(raw) { return [...new URLSearchParams(String(raw || "")).entries()]; }
function itnSignatureOk(pairs, pass) {
  const got = (pairs.find(([k]) => k === "signature") || [])[1] || "";
  const upTo = []; for (const [k, v] of pairs) { if (k === "signature") break; upTo.push([k, v]); }
  // Unlike a checkout, a notification's signature covers every field PayFast sent, empty ones included.
  let str = upTo.map(([k, v]) => `${k}=${enc(v)}`).join("&"); if (pass) str += `&passphrase=${enc(pass)}`;
  return !!got && got === md5(str);
}
let ipCache = { at: 0, ips: new Set() };
async function payfastIps() {
  if (Date.now() - ipCache.at < 10 * 60e3 && ipCache.ips.size) return ipCache.ips;
  const ips = new Set();
  for (const h of ["www.payfast.co.za", "sandbox.payfast.co.za", "w1w.payfast.co.za", "w2w.payfast.co.za"]) { try { (await dns.resolve4(h)).forEach((x) => ips.add(x)); } catch (e) {} }
  ipCache = { at: Date.now(), ips }; return ips;
}
// PayFast confirms the notification is real: the strongest of the four checks.
async function confirmWithPayfast(pairs, sandbox) {
  const body = pairs.filter(([k]) => k !== "signature").map(([k, v]) => `${k}=${enc(v)}`).join("&");
  const r = await fetch(process.env.PAYFAST_VALIDATE_URL || `https://${host(sandbox)}/eng/query/validate`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15000) });
  return (await r.text()).trim() === "VALID";
}

// ---- gyms' own PayFast keys, encrypted at rest ----
const keyBytes = () => crypto.createHash("sha256").update("jf-payfast:" + (process.env.JF_SECRET || process.env.DATABASE_URL || "dev")).digest();
function seal(text) { if (!text) return ""; const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", keyBytes(), iv); const out = Buffer.concat([c.update(String(text), "utf8"), c.final()]); return [iv, c.getAuthTag(), out].map((b) => b.toString("base64")).join("."); }
function open(blob) { if (!blob) return ""; try { const [iv, tag, data] = blob.split(".").map((x) => Buffer.from(x, "base64")); const d = crypto.createDecipheriv("aes-256-gcm", keyBytes(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(data), d.final()]).toString("utf8"); } catch (e) { return ""; } }

const money = (cents) => (Math.round(cents) / 100).toFixed(2);
module.exports = { PRICE_CENTS, FEE_PCT, TRIAL_MONTHS, TEST, platform, host, sign, paramString, checkout, parseItn, itnSignatureOk, payfastIps, confirmWithPayfast, seal, open, money, ORDER };
