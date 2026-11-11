// The JitsFlow beta ("founding gyms"): gyms that test new things with their members get features built for them and pay less.
// gyms.beta: {status: applied|accepted|declined|left, appliedAt, note, acceptedAt, feeCents, feeUntil, afterCents, features, adminNote}.
// While accepted, the gym's monthly price is feeCents until feeUntil (a day, or null: for as long as they're in the beta), then afterCents.
"use strict";

const FREE_MONTHS = 6; // the default deal when the team taps Accept: free for 6 months...
const AFTER_CENTS = 4900; // ...then R49 a month for as long as they stay in the beta
const STATUSES = ["applied", "accepted", "declined", "left"];

const rand = (c) => "R" + (c % 100 ? (c / 100).toFixed(2) : String(Math.round(c / 100)));
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "") && !isNaN(new Date(v + "T00:00:00Z"));
// The same day n months on (the last day of a shorter month).
function addMonths(day, n) {
  const [y, m, d] = day.split("-").map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1));
  t.setUTCDate(Math.min(d, new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()));
  return t.toISOString().slice(0, 10);
}
const longDay = (day) => { try { return new Date(day + "T12:00:00Z").toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }); } catch (e) { return day; } };
const active = (b) => !!b && b.status === "accepted";

// The default deal, for the email and the apply card: "free for your first 6 months in the beta, then R49/month instead of R99".
const dealLine = (priceCents) => `free for your first ${FREE_MONTHS} months in the beta, then ${rand(AFTER_CENTS)}/month instead of ${rand(priceCents)}`;
// Accepting: the default deal unless the team picked another fee or end date.
function acceptDeal(today, { feeCents, feeUntil, afterCents } = {}) {
  const custom = feeCents !== undefined && feeCents !== null && feeCents !== "";
  if (!custom) return { feeCents: 0, feeUntil: addMonths(today, FREE_MONTHS), afterCents: AFTER_CENTS };
  const fee = Math.max(0, Math.min(1e6, Math.round(Number(feeCents) || 0)));
  const until = isDay(feeUntil) ? feeUntil : null;
  const after = until && afterCents !== undefined && afterCents !== null && afterCents !== "" ? Math.max(0, Math.min(1e6, Math.round(Number(afterCents) || 0))) : null;
  return { feeCents: fee, feeUntil: until, afterCents: after };
}
// The gym's monthly price today: null when it isn't in the beta (the normal price applies).
function priceFor(b, today, normalCents) {
  if (!active(b)) return null;
  if (b.feeUntil && today >= b.feeUntil) return b.afterCents === null || b.afterCents === undefined ? normalCents : b.afterCents;
  return Math.max(0, Number(b.feeCents) || 0);
}
// What the gym sees: "Beta: free until 11 May 2027, then R49/month (instead of R99)".
function feeLine(b, today, normalCents) {
  if (!active(b)) return "";
  const now = priceFor(b, today, normalCents), then = b.afterCents === null || b.afterCents === undefined ? normalCents : b.afterCents;
  const was = ` (instead of ${rand(normalCents)})`;
  if (b.feeUntil && today < b.feeUntil) return now === 0 ? `Beta: free until ${longDay(b.feeUntil)}, then ${rand(then)}/month${then < normalCents ? was : ""}` : `Beta price ${rand(now)}/month until ${longDay(b.feeUntil)}, then ${rand(then)}/month`;
  return now === 0 ? "Beta: free while you're in the beta" : `Beta price ${rand(now)}/month${now < normalCents ? was : ""}`;
}
// Feature flags the team switches on for a gym: short words ("kiosk", "grading-sheets"), at most 20.
const readFeatures = (v) => [...new Set((Array.isArray(v) ? v : String(v || "").split(/[\n,]+/)).map((x) => String(x).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)).filter(Boolean))].slice(0, 20);
// The beta as the gym's head coach sees it.
function forGym(b, today, normalCents) {
  if (!b || !STATUSES.includes(b.status)) return { status: null };
  const out = { status: b.status, appliedAt: b.appliedAt || null, note: b.note || "" };
  if (active(b)) Object.assign(out, { acceptedAt: b.acceptedAt || null, feeCents: b.feeCents || 0, feeUntil: b.feeUntil || null, afterCents: b.afterCents ?? null,
    priceCents: priceFor(b, today, normalCents), line: feeLine(b, today, normalCents), features: b.features || [] });
  return out;
}

module.exports = { FREE_MONTHS, AFTER_CENTS, STATUSES, addMonths, dealLine, acceptDeal, priceFor, feeLine, readFeatures, forGym, active, longDay, rand };
