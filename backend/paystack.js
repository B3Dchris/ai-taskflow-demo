// Paystack: members paying their gym by card, Apple Pay, Capitec Pay or EFT (Paystack's checkout shows what it offers).
// Each gym gets a Paystack subaccount (its bank account, given in the app: the gym needs no Paystack account of its own). Paystack
// pays the gym's share of each payment straight into that account; JitsFlow's platform fee (payfast.FEE_PCT, a flat amount per
// payment: transaction_charge) stays in JitsFlow's Paystack balance. JitsFlow never holds the gym's money.
// Off unless PAYSTACK_SECRET_KEY is set (sk_test_… test mode, sk_live_… live). JitsFlow's own gym plan stays on Payfast (payfast.js).
// Follows Paystack's public API docs (paystack.com/docs/api). Amounts are in cents (ZAR's subunit).
"use strict";
const crypto = require("crypto");
const { FEE_PCT } = require("./payfast");

const secret = () => String(process.env.PAYSTACK_SECRET_KEY || "").trim();
const on = () => /^sk_(test|live)_\w+$/.test(secret());
const live = () => on() && /^sk_live_/.test(secret());
const testMode = () => on() && !live();
// Member card payments go through Paystack whenever it's switched on (JF_MEMBER_PAYMENTS=payfast keeps the gyms' own PayFast instead).
const memberCards = () => (on() && String(process.env.JF_MEMBER_PAYMENTS || "paystack").toLowerCase() !== "payfast" ? "paystack" : "payfast");
// Who pays Paystack's processing fee: the gym's subaccount (as with Payfast, the default) or JitsFlow's main account.
const bearer = () => (String(process.env.PAYSTACK_FEE_BEARER || "").toLowerCase() === "account" ? "account" : "subaccount");
// The public pages say member card payments are live (not "coming soon") once JitsFlow is on a live key, or JF_PAYSTACK_LIVE=1.
const publicLive = () => process.env.JF_PAYSTACK_LIVE === "1" || live();
const base = () => (process.env.PAYSTACK_API_URL || "https://api.paystack.co").replace(/\/+$/, "");
// JitsFlow's fee on a payment, in cents (flat: Paystack's transaction_charge). Never more than the payment.
const feeOf = (cents) => Math.min(Math.round(cents), Math.max(0, Math.round((Math.round(cents) * FEE_PCT()) / 100)));
// Where the team checks a gym's bank account before marking it verified.
const DASHBOARD = "https://dashboard.paystack.com/#/subaccounts";
// The addresses Paystack sends webhooks from (its docs). Only logged when another sends one: the signature is what counts.
const IPS = new Set(["52.31.139.75", "52.49.173.169", "52.214.14.220"]);

// Paystack said no (status: its HTTP status, 0 for no answer). unsure: there was no answer (timeout, network), so a charge may or
// may not have gone through. message: Paystack's own words, fine to show a head coach (never holds the secret key).
class PaystackError extends Error { constructor(message, status, unsure) { super(message); this.status = status; this.unsure = !!unsure; } }

// One call to Paystack's API. Returns its data. Throws PaystackError.
async function api(method, path, body, { timeout = 20000 } = {}) {
  if (!on()) throw new PaystackError("Card payments aren't switched on.", 0, false);
  let r;
  try {
    r = await fetch(base() + path, { method, headers: { authorization: "Bearer " + secret(), ...(body ? { "content-type": "application/json" } : {}), accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
  } catch (e) { throw new PaystackError("Paystack didn't answer. Try again in a minute.", 0, true); }
  let json = null; try { json = await r.json(); } catch (e) {}
  if (r.status >= 500) throw new PaystackError("Paystack is having trouble right now. Try again in a minute.", r.status, true);
  if (r.status >= 300 || !json || json.status !== true) {
    const msg = String((json && json.message) || `Paystack said no (${r.status})`).replace(/sk_(test|live)_\w+/g, "[key]").slice(0, 200);
    throw new PaystackError(r.status === 401 ? "JitsFlow's Paystack key isn't right. The JitsFlow team has been told." : msg, r.status, false);
  }
  return json.data;
}

// South African banks Paystack pays out to: [{name, code}], by name. Kept for a day.
let bankCache = { at: 0, list: null };
async function banks() {
  if (bankCache.list && Date.now() - bankCache.at < 864e5) return bankCache.list;
  const data = await api("GET", "/bank?country=south%20africa&currency=ZAR&perPage=200");
  const seen = new Set(), list = [];
  for (const b of Array.isArray(data) ? data : []) {
    const code = String(b.code || "").trim(), name = String(b.name || "").trim();
    if (!code || !name || b.active === false || b.is_deleted === true || seen.has(code)) continue;
    // South Africa only for now: skip any bank Paystack lists for another country or currency.
    if ((b.country && String(b.country).toLowerCase() !== "south africa") || (b.currency && String(b.currency).toUpperCase() !== "ZAR")) continue;
    seen.add(code); list.push({ name: name.slice(0, 80), code: code.slice(0, 20) });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) throw new PaystackError("Paystack has no South African banks for JitsFlow's account. The JitsFlow team has been told.", 200, false);
  bankCache = { at: Date.now(), list };
  return list;
}
const forgetBanks = () => { bankCache = { at: 0, list: null }; };
// The banks most South African gyms use, most popular first: the only ones the app offers for now (the full list still checks a saved
// account). Matched by name, so Paystack's own codes are used. If none match (Paystack renamed them), the full list is offered instead.
const POPULAR = [/^capitec/i, /first national|^fnb\b/i, /^absa/i, /^standard bank/i, /^nedbank/i, /^tyme/i, /^discovery/i, /^african bank/i, /^investec/i];
async function popularBanks() {
  const all = await banks(), out = [];
  for (const re of POPULAR) { const b = all.find((x) => re.test(x.name) && !out.includes(x)); if (b) out.push(b); }
  return out.length ? out : all;
}

// A gym's subaccount: its bank account for payouts. percentage_charge 0: JitsFlow's fee is a flat transaction_charge on each payment.
// Returns the subaccount code.
async function createSubaccount({ business, bankCode, account, contact, email, description }) {
  const d = await api("POST", "/subaccount", { business_name: business, settlement_bank: bankCode, account_number: account, percentage_charge: 0,
    description: description || "", primary_contact_name: contact || "", primary_contact_email: email || "", settlement_schedule: "auto" });
  const code = d && d.subaccount_code; if (!code) throw new PaystackError("Paystack didn't send the account back. Try again.", 200, false);
  return String(code);
}
// New bank details on a gym's subaccount. (Paystack holds the first payout after a change until it's verified on its dashboard.)
async function updateSubaccount(code, { business, bankCode, account, contact, email, description }) {
  await api("PUT", "/subaccount/" + encodeURIComponent(code), { business_name: business, settlement_bank: bankCode, account_number: account, percentage_charge: 0,
    description: description || "", primary_contact_name: contact || "", primary_contact_email: email || "", settlement_schedule: "auto" });
  return code;
}

// A checkout: the member goes to authorization_url. channels: only when saving a card (a card is the only reusable method).
async function initialize({ email, cents, reference, callbackUrl, subaccount, feeCents, metadata, channels }) {
  const d = await api("POST", "/transaction/initialize", { email, amount: Math.round(cents), currency: "ZAR", reference, callback_url: callbackUrl,
    subaccount, transaction_charge: Math.round(feeCents), bearer: bearer(), metadata: metadata || {}, ...(channels ? { channels } : {}) });
  // The member is sent there: only ever an https page (or, in tests, the local stand-in for Paystack).
  const url = String((d && d.authorization_url) || "");
  if (!/^https:\/\/[^\s"'<>]+$/.test(url) && !(process.env.PAYSTACK_API_URL && /^http:\/\/(127\.0\.0\.1|localhost)[:/][^\s"'<>]*$/.test(url))) throw new PaystackError("Paystack didn't open a checkout. Try again.", 200, false);
  return { url, accessCode: String(d.access_code || ""), reference: String(d.reference || reference) };
}
// What Paystack says happened to a payment (always asked before anything is credited).
const verify = (reference) => api("GET", "/transaction/verify/" + encodeURIComponent(reference), null, { timeout: 15000 });
// Charges a saved card (a reusable authorization). Returns Paystack's data (status: success, failed, or pending/send_otp…).
const chargeAuthorization = ({ authorization, email, cents, reference, subaccount, feeCents, metadata }) => api("POST", "/transaction/charge_authorization", {
  authorization_code: authorization, email, amount: Math.round(cents), currency: "ZAR", reference, subaccount, transaction_charge: Math.round(feeCents), bearer: bearer(), metadata: metadata || {} });
// A refund (cents: part of it; left out: all of it).
const refund = ({ reference, cents }) => api("POST", "/refund", { transaction: reference, ...(cents ? { amount: Math.round(cents) } : {}) });

// A webhook is Paystack's when x-paystack-signature is the HMAC-SHA512 of the raw body with the secret key.
function signatureOk(raw, sig) {
  if (!on() || !Buffer.isBuffer(raw) || typeof sig !== "string" || !/^[a-f0-9]{128}$/i.test(sig)) return false;
  const want = crypto.createHmac("sha512", secret()).update(raw).digest();
  return crypto.timingSafeEqual(want, Buffer.from(sig, "hex"));
}
// The subaccount code a verify answer names (an object, or a code), "" for none.
const subOf = (d) => String((d && d.subaccount && (typeof d.subaccount === "object" ? d.subaccount.subaccount_code : d.subaccount)) || "");
// A unique reference for a checkout or charge (Paystack refuses one it has seen).
const newRef = (kind) => `jf${kind}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
// "•••• 1234": the end of a number, never the rest.
const last4 = (v) => String(v || "").replace(/\D/g, "").slice(-4);

module.exports = { popularBanks, on, live, testMode, memberCards, bearer, publicLive, base, feeOf, DASHBOARD, IPS, PaystackError, api, banks, forgetBanks, createSubaccount, updateSubaccount,
  initialize, verify, chargeAuthorization, refund, signatureOk, subOf, newRef, last4 };
