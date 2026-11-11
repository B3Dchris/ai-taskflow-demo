// The JitsFlow team's dashboard (GET /api/admin/overview): visitors, sign-ups, people using the app, gyms and outreach, in a
// handful of grouped queries. Days are UTC days, the same days the visitor counter uses (backend/visits.js).
"use strict";
const { channel } = require("./visits");

const RANGES = [7, 30, 90];
// A website visitor: opened a public page, or arrived straight in the app from another site, an ad or a campaign link
// (someone just opening the app they use every day isn't one: they're counted as app opens).
const VIS = "(pages>0 or ref<>'' or utm_source<>'' or click<>'')";
const n = (v) => Number(v || 0);
const iso = (d) => (d ? new Date(d).toISOString() : null);

// Rows grouped by where they came from, merged into named sources ("Google search", "Google Ads"…), biggest first.
function bySource(rows, keyOf = () => "n") {
  const m = new Map();
  for (const r of rows) {
    const c = channel({ utm_source: r.utm_source, utm_medium: r.utm_medium, ref: r.ref, click: r.click, via: r.via });
    const e = m.get(c.name) || { name: c.name, paid: !!c.paid, n: 0 };
    const k = keyOf(r); e[k] = n(e[k]) + n(r.n); if (k !== "n") e.n += n(r.n);
    m.set(c.name, e);
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

async function overview(q, { days = 30, bill } = {}) {
  days = RANGES.includes(Number(days)) ? Number(days) : 30;
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.parse(today + "T00:00:00Z") - (days - 1) * 864e5).toISOString().slice(0, 10);
  const since = "($1::date)::timestamp at time zone 'UTC'"; // the first day's start, as a time
  const day = (col) => `to_char((${col} at time zone 'UTC')::date, 'YYYY-MM-DD')`;
  const P = [start];
  const [tot, signDays, gymDays, visDays, viewDays, pages, vSrc, camps, countries, sSrc, gyms, recent, out, first, last7] = await Promise.all([
    // Gyms outreach built that nobody has claimed aren't gyms yet: they're in the outreach funnel ("Built, not claimed").
    q(`select (select count(*) from gyms where claim is null) as gyms,
        (select count(distinct gym_id) from users where gym_id is not null and last_seen > now() - interval '7 days') as gyms_active,
        count(*) filter (where role='coach' and gym_id is not null and active) as coaches,
        count(*) filter (where role='student' and gym_id is not null and active) as members,
        count(*) filter (where role='student' and gym_id is not null and active and (pass_hash is not null or parent_id is not null)) as members_on_app,
        count(*) filter (where gym_id is null and pass_hash is not null and not exists (select 1 from users k where k.parent_id=users.id)) as self_study,
        count(*) filter (where parent_id is not null) as kids,
        count(*) filter (where pass_hash is not null) as logins,
        count(*) filter (where pass_hash is not null and last_seen > now() - interval '1 day') as active1,
        count(*) filter (where pass_hash is not null and last_seen > now() - interval '7 days') as active7,
        count(*) filter (where pass_hash is not null and last_seen > now() - interval '30 days') as active30,
        count(*) filter (where pass_hash is not null and (signed_up_at at time zone 'UTC')::date = (now() at time zone 'UTC')::date) as new1,
        count(*) filter (where pass_hash is not null and signed_up_at > now() - interval '7 days') as new7,
        count(*) filter (where pass_hash is not null and signed_up_at > now() - interval '30 days') as new30
      from users`),
    q(`select ${day("signed_up_at")} as d, count(*) filter (where role='coach') as coaches, count(*) filter (where role<>'coach') as students
      from users where pass_hash is not null and signed_up_at >= ${since} group by 1`, P),
    q(`select ${day("coalesce(claimed_at, created_at)")} as d, count(*) as n from gyms where claim is null and coalesce(claimed_at, created_at) >= ${since} group by 1`, P),
    q(`select to_char(day, 'YYYY-MM-DD') as d, count(*) filter (where ${VIS}) as visitors, count(*) filter (where app>0) as app_people
      from site_visitors where day >= $1::date group by day`, P),
    q(`select to_char(day, 'YYYY-MM-DD') as d, sum(views) filter (where path<>'/app/') as views, sum(views) filter (where path='/app/') as app_opens
      from site_daily where day >= $1::date group by day`, P),
    q(`select path, sum(views) as n from site_daily where day >= $1::date and path<>'/app/' group by path order by n desc, path limit 12`, P),
    q(`select ref, utm_source, utm_medium, click<>'' as click, count(*) as n from site_visitors where day >= $1::date and ${VIS} group by 1,2,3,4`, P),
    q(`select utm_campaign as name, count(*) as n, bool_or(click<>'') as ads from site_visitors where day >= $1::date and utm_campaign<>'' group by 1 order by n desc limit 8`, P),
    q(`select country, count(*) as n from site_visitors where day >= $1::date and ${VIS} group by 1 order by n desc limit 12`, P),
    q(`select signup_source->>'ref' as ref, signup_source->>'utm_source' as utm_source, signup_source->>'utm_medium' as utm_medium,
        coalesce(signup_source ? 'click', false) as click, signup_source->>'via' as via, role, count(*) as n
      from users where pass_hash is not null and signed_up_at >= ${since} group by 1,2,3,4,5,6`, P),
    q(`select g.id, g.name, g.created_at, g.claimed_at, g.billing, g.beta, g.currency, h.name as head_name, h.email as head_email,
        (select p.id from prospects p where p.gym_id=g.id limit 1) as prospect_id,
        coalesce(m.members,0) as members, coalesce(m.on_app,0) as on_app, coalesce(m.active7,0) as active7, coalesce(m.coaches,0) as coaches, m.last_seen,
        coalesce(c.n,0) as classes7, coalesce(b.n,0) as bookings7, coalesce(p.n,0) as pay_n, coalesce(p.cents,0) as pay_cents
      from gyms g
      left join users h on h.id=g.head_coach_id
      left join (select gym_id, count(*) filter (where role='student' and active) as members,
          count(*) filter (where role='student' and active and (pass_hash is not null or parent_id is not null)) as on_app,
          count(*) filter (where role='student' and active and last_seen > now() - interval '7 days') as active7,
          count(*) filter (where role='coach' and active) as coaches, max(last_seen) as last_seen
        from users where gym_id is not null group by gym_id) m on m.gym_id=g.id
      left join (select gym_id, count(*) as n from classes where starts_at >= now() and starts_at < now() + interval '7 days' group by gym_id) c on c.gym_id=g.id
      left join (select k.gym_id, count(*) as n from attendance a join classes k on k.id=a.class_id where a.going and a.booked_at > now() - interval '7 days' group by k.gym_id) b on b.gym_id=g.id
      left join (select gym_id, count(*) as n, sum(amount_cents) as cents from payments where status='confirmed' and paid_on >= date_trunc('month', now())::date group by gym_id) p on p.gym_id=g.id
      where g.claim is null order by members desc, g.id`),
    q(`select u.id, u.name, u.email, u.role, u.signed_up_at, u.signup_source, g.name as gym_name, u.parent_id is not null as kid,
        exists (select 1 from users k where k.parent_id=u.id) as parent
      from users u left join gyms g on g.id=u.gym_id where u.pass_hash is not null and u.signed_up_at is not null order by u.signed_up_at desc, u.id desc limit 50`),
    q(`select count(*) as added, count(*) filter (where sent_at is not null) as sent, count(*) filter (where views>0 and sent_at is not null) as opened,
        count(*) filter (where status='claimed') as claimed, count(*) filter (where status='optedout') as optedout,
        count(*) filter (where status<>'claimed' and status<>'optedout' and exists (select 1 from gyms g where g.id=prospects.gym_id and g.claim is not null)) as built from prospects`).catch(() => ({ rows: [{}] })),
    q(`select to_char(min(day), 'YYYY-MM-DD') as d from site_daily`),
    // Visitors today and over the last 7 days (each person counted once a day), whatever the range.
    q(`select count(*) filter (where day=(now() at time zone 'UTC')::date) as today, count(*) as week
      from site_visitors where ${VIS} and day > (now() at time zone 'UTC')::date - 7`),
  ]);

  const T = tot.rows[0], byDay = (rows) => Object.fromEntries(rows.map((r) => [r.d, r]));
  const S = byDay(signDays.rows), G = byDay(gymDays.rows), V = byDay(visDays.rows), W = byDay(viewDays.rows);
  const series = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.parse(start + "T00:00:00Z") + i * 864e5).toISOString().slice(0, 10);
    series.push({ day: d, visitors: n((V[d] || {}).visitors), views: n((W[d] || {}).views), appOpens: n((W[d] || {}).app_opens), appPeople: n((V[d] || {}).app_people),
      students: n((S[d] || {}).students), coaches: n((S[d] || {}).coaches), gyms: n((G[d] || {}).n) });
  }
  const o = out.rows[0] || {};
  return {
    days, from: start, to: today, countingSince: first.rows[0].d || null,
    visitors: { today: n(last7.rows[0].today), week: n(last7.rows[0].week) },
    totals: { gyms: n(T.gyms), gymsActive: n(T.gyms_active), coaches: n(T.coaches), members: n(T.members), membersOnApp: n(T.members_on_app), selfStudy: n(T.self_study),
      kids: n(T.kids), logins: n(T.logins), active1: n(T.active1), active7: n(T.active7), active30: n(T.active30), new1: n(T.new1), new7: n(T.new7), new30: n(T.new30) },
    series,
    pages: pages.rows.map((r) => ({ path: r.path, n: n(r.n) })),
    sources: bySource(vSrc.rows),
    campaigns: camps.rows.map((r) => ({ name: r.name, n: n(r.n), ads: !!r.ads })),
    countries: countries.rows.map((r) => ({ code: r.country || "", n: n(r.n) })),
    signupSources: bySource(sSrc.rows, (r) => (r.role === "coach" ? "coaches" : "students")),
    gyms: gyms.rows.map((g) => ({ id: String(g.id), name: g.name, createdAt: iso(g.claimed_at || g.created_at), outreach: !!g.prospect_id, beta: g.beta && g.beta.status ? g.beta.status : null, head: g.head_name ? { name: g.head_name, email: g.head_email } : null,
      members: n(g.members), onApp: n(g.on_app), active7: n(g.active7), coaches: n(g.coaches), lastSeen: iso(g.last_seen), classes7: n(g.classes7), bookings7: n(g.bookings7),
      payments: { n: n(g.pay_n), cents: n(g.pay_cents), currency: g.currency || "ZAR" }, billing: bill ? bill(g) : null })),
    recent: recent.rows.map((u) => ({ id: String(u.id), name: u.name, email: u.email, role: u.role, kid: !!u.kid, parent: !!u.parent, gym: u.gym_name || null,
      at: iso(u.signed_up_at), source: channel(u.signup_source || {}), campaign: (u.signup_source || {}).utm_campaign || null })),
    outreach: { added: n(o.added), built: n(o.built), sent: n(o.sent), opened: n(o.opened), claimed: n(o.claimed), optedOut: n(o.optedout) },
  };
}

module.exports = { overview, bySource, RANGES };
