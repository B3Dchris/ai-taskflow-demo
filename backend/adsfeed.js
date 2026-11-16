// Google Ads conversions, as a file Google Ads fetches by itself every day (Goals › Uploads › Schedules, source HTTPS):
// one row per sign-up that came from a Google Ads click (the click id kept with the sign-up: see signupSource in visits.js),
// for the 90 days Google Ads accepts. Only the click id, which conversion and when: no name, email or anything else.
// Google Ads ignores rows it already has, so the same rows can be sent every day.
// The file needs a username and password (HTTP Basic, which is what Google Ads sends) or a signed-in JitsFlow admin.
// The password is random, kept sealed in the database (app_secrets), shown on the team's dashboard and can be replaced there.
"use strict";
const crypto = require("crypto");
const payfast = require("./payfast"); // seal/open

const USER = "jitsflow";
const NAMES = { gym: "JitsFlow gym sign-up", member: "JitsFlow member sign-up" };
const DAYS = 90;
const TZ = "Africa/Johannesburg"; // no daylight saving: always +02:00

async function password(q, { fresh = false } = {}) {
  if (!fresh) {
    const r = (await q("select value from app_secrets where name='ads_feed'")).rows[0];
    if (r) { const o = payfast.unseal(r.value); if (o.ok && o.text) return o.text; }
  }
  const pw = crypto.randomBytes(18).toString("base64url");
  await q(`insert into app_secrets(name, value) values('ads_feed', $1) on conflict (name) do update set value=excluded.value, updated_at=now()`, [payfast.seal(pw)]);
  return pw;
}

// Does this request carry the feed's username and password?
async function allowed(q, req) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(String(req.headers.authorization || ""));
  if (!m) return false;
  const s = Buffer.from(m[1], "base64").toString("utf8"), i = s.indexOf(":");
  if (i < 0 || s.slice(0, i) !== USER) return false;
  const r = (await q("select value from app_secrets where name='ads_feed'")).rows[0];
  const o = r ? payfast.unseal(r.value) : null;
  if (!o || !o.ok || !o.text) return false;
  const a = crypto.createHash("sha256").update(s.slice(i + 1)).digest(), b = crypto.createHash("sha256").update(o.text).digest();
  return crypto.timingSafeEqual(a, b);
}

// The sign-ups to report: people who signed up themselves (not kids added by a parent) after a Google Ads click (gclid).
async function rows(q) {
  return (await q(`select u.signup_source->>'click_id' as gclid, case when u.role='coach' then 'gym' else 'member' end as kind,
      to_char(u.signed_up_at at time zone '${TZ}', 'YYYY-MM-DD HH24:MI:SS') as at
    from users u where u.pass_hash is not null and u.parent_id is null and u.signed_up_at > now() - interval '${DAYS} days'
      and u.signup_source->>'click' = 'gclid' and coalesce(u.signup_source->>'click_id', '') <> ''
    order by u.signed_up_at, u.id`)).rows.filter((r) => /^[\w.~-]{1,150}$/.test(r.gclid));
}

// Google's file for click conversions: a time zone line, then the columns. A blank value uses the conversion's own value.
function csv(list) {
  const lines = [`Parameters:TimeZone=${TZ}`, "Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency"];
  for (const r of list) lines.push(`${r.gclid},${NAMES[r.kind]},${r.at},,ZAR`);
  return lines.join("\r\n") + "\r\n";
}

async function summary(q) {
  const list = await rows(q);
  return { user: USER, names: NAMES, days: DAYS, gym: list.filter((r) => r.kind === "gym").length, member: list.filter((r) => r.kind === "member").length };
}

module.exports = { USER, NAMES, DAYS, password, allowed, rows, csv, summary };
