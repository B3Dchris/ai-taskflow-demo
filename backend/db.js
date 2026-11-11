// JitsFlow database: connection pool and schema (created on startup, safe to run repeatedly).
"use strict";
const { Pool, types } = require("pg");
// Plain dates (paid_on, session dates) stay "YYYY-MM-DD" strings, so no timezone can shift them a day.
types.setTypeParser(1082, (v) => v);

const SCHEMA = `
create table if not exists gyms(
  id bigserial primary key,
  name text not null,
  student_code text unique not null,
  coach_code text unique not null,
  monthly_fee_cents int not null default 0,
  currency text not null default 'ZAR',
  created_at timestamptz not null default now()
);
create table if not exists users(
  id bigserial primary key,
  gym_id bigint references gyms(id) on delete set null,
  role text not null check (role in ('coach','student')),
  name text not null,
  email text unique not null,
  pass_hash text not null,
  belt text not null default 'white',
  stripes int not null default 0,
  monthly_fee_cents int,
  notes text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen timestamptz
);
create table if not exists sessions(
  token_hash text primary key,
  user_id bigint not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists progress(
  user_id bigint primary key references users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists training_logs(
  user_id bigint not null references users(id) on delete cascade,
  id text not null,
  date date,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key(user_id, id)
);
create table if not exists classes(
  id bigserial primary key,
  gym_id bigint not null references gyms(id) on delete cascade,
  title text not null,
  starts_at timestamptz not null,
  duration_min int not null default 60,
  plan jsonb not null default '{}',
  shared boolean not null default true,
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists classes_gym_time on classes(gym_id, starts_at);
create table if not exists attendance(
  class_id bigint not null references classes(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  going boolean not null default true,
  attended boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key(class_id, user_id)
);
create table if not exists payments(
  id bigserial primary key,
  gym_id bigint not null references gyms(id) on delete cascade,
  user_id bigint references users(id) on delete set null,
  amount_cents int not null,
  currency text not null default 'ZAR',
  paid_on date not null,
  reference text not null default '',
  note text not null default '',
  source text not null default 'manual',
  email_from text,
  email_subject text,
  created_at timestamptz not null default now()
);
create index if not exists payments_gym_date on payments(gym_id, paid_on);
alter table gyms add column if not exists profile jsonb not null default '{}';
alter table gyms add column if not exists logo bytea;
alter table gyms add column if not exists logo_type text;
alter table gyms add column if not exists logo_v text;
alter table gyms add column if not exists profile_updated_at timestamptz;
alter table classes add column if not exists kind text not null default 'class';
alter table classes add column if not exists capacity int;
alter table classes add column if not exists price_cents int;
alter table classes add column if not exists coach text not null default '';
alter table classes add column if not exists level text not null default '';
alter table attendance add column if not exists waitlisted boolean not null default false;
alter table attendance add column if not exists booked_at timestamptz not null default now();
alter table attendance add column if not exists checked_in_at timestamptz;
alter table gyms add column if not exists show_attendees boolean not null default true;
alter table gyms add column if not exists timezone text not null default 'Africa/Johannesburg';
create table if not exists plans(
  id bigserial primary key,
  gym_id bigint not null references gyms(id) on delete cascade,
  name text not null,
  price_cents int not null default 0,
  period text not null default 'month',
  classes_per_week int,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table users add column if not exists plan_id bigint references plans(id) on delete set null;
alter table users add column if not exists plan_status text not null default 'active';
alter table users add column if not exists plan_started date;
alter table users add column if not exists rank_changed_at timestamptz;
create index if not exists attendance_user on attendance(user_id);
create index if not exists attendance_waiting on attendance(class_id, booked_at) where waitlisted;
alter table users add column if not exists phone text not null default '';
alter table gyms add column if not exists students_invite boolean not null default true;
create table if not exists competitions(
  id bigserial primary key,
  gym_id bigint not null references gyms(id) on delete cascade,
  name text not null,
  starts_on date not null,
  ends_on date,
  venue text not null default '',
  city text not null default '',
  organiser text not null default '',
  url text not null default '',
  register_by date,
  fee text not null default '',
  style text not null default '',
  divisions jsonb not null default '[]',
  details text not null default '',
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists competitions_gym on competitions(gym_id, starts_on);
create table if not exists competitors(
  competition_id bigint not null references competitions(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  status text not null default 'requested',
  division text not null default '',
  weight text not null default '',
  note text not null default '',
  coach_note text not null default '',
  paid boolean not null default false,
  result text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(competition_id, user_id)
);
-- payments: how students pay (bank details), personal references, proof-of-payment files waiting for a coach
alter table gyms add column if not exists wa_phone text not null default '';
alter table gyms add column if not exists import_job jsonb;
alter table gyms add column if not exists brand jsonb not null default '{}';
alter table gyms add column if not exists setup jsonb not null default '{}';
-- students a coach adds who aren't on the app yet: no email or password needed; they can claim the record later
alter table users alter column email drop not null;
alter table users alter column pass_hash drop not null;
alter table users add column if not exists offline boolean not null default false;
alter table users add column if not exists parent_name text not null default '';
alter table classes add column if not exists discipline text not null default '';
alter table gyms add column if not exists billing jsonb not null default '{}';
alter table gyms add column if not exists payfast jsonb;
alter table users add column if not exists claim_token text;
create unique index if not exists users_claim_token on users(claim_token) where claim_token is not null;
alter table users add column if not exists notices_seen_at timestamptz;
-- notices students see in the app: class cancelled or moved (gym-wide when user_id is null)
create table if not exists notices(
  id bigserial primary key,
  gym_id bigint not null references gyms(id) on delete cascade,
  user_id bigint references users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists notices_gym on notices(gym_id, created_at desc);
alter table gyms add column if not exists pay jsonb not null default '{}';
alter table gyms add column if not exists pop_token text;
alter table gyms add column if not exists pop_notice jsonb;
create unique index if not exists gyms_pop_token on gyms(pop_token) where pop_token is not null;
alter table users add column if not exists pay_ref text;
create unique index if not exists users_pay_ref on users(pay_ref) where pay_ref is not null;
alter table payments add column if not exists method text not null default '';
alter table payments add column if not exists status text not null default 'confirmed';
alter table payments add column if not exists ai jsonb;
alter table payments add column if not exists submitted_by bigint;
create index if not exists payments_gym_status on payments(gym_id, status);
-- how many months a payment covers (an annual fee covers 12), counted toward each of them
alter table payments add column if not exists months int not null default 1;
create table if not exists pop_files(
  id bigserial primary key,
  payment_id bigint not null references payments(id) on delete cascade,
  name text not null default '',
  type text not null,
  data bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists pop_files_payment on pop_files(payment_id);
-- when someone joined the gym they're in now, if they moved there with a code (null: they signed up into it). Coaches only see training logged since then.
alter table users add column if not exists gym_joined_at timestamptz;
create table if not exists password_resets(
  token_hash text primary key,
  user_id bigint not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
-- one head coach per gym: the only coach who sees money (fees, payments, bank details, PayFast, plans, billing) and gets payment emails
alter table gyms add column if not exists head_coach_id bigint references users(id) on delete set null;
-- private-lesson packs ("10 private lessons" for R4500). A confirmed payment for a pack gives that many credits;
-- the lessons and expiry are copied onto the payment, so changing the pack later doesn't change what someone bought.
create table if not exists packs(
  id bigserial primary key,
  gym_id bigint not null references gyms(id) on delete cascade,
  name text not null,
  lessons int not null,
  price_cents int not null default 0,
  expiry_months int,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists packs_gym on packs(gym_id);
alter table payments add column if not exists pack_id bigint references packs(id) on delete set null;
alter table payments add column if not exists pack_lessons int;
alter table payments add column if not exists pack_months int;
-- clients who only take private lessons pay this each month they book one (0 = off)
alter table gyms add column if not exists access_fee_cents int not null default 0;
-- privates from this time on are charged (owed at their price with no lesson left, and counted for the access fee). Gyms that
-- were there before get the time this column was added, so privates already paid for outside the app aren't owed; new gyms, when they start.
alter table gyms add column if not exists privates_from timestamptz not null default now();
-- private-lesson price tiers: a plan's price for a private (null: the slot's price), and the gym's price for clients
-- without a membership (null: the slot's price). What a booking costs is locked in on its attendance row when it's booked,
-- so changing prices later never changes privates already booked. price_from: plan, nonmember or slot (slot prices follow the slot).
alter table plans add column if not exists private_price_cents int;
alter table gyms add column if not exists private_price_cents int;
alter table attendance add column if not exists price_cents int;
alter table attendance add column if not exists price_from text;
alter table attendance add column if not exists price_label text;
-- what clients who only take privates need: 'none' (just the private's price), 'fee' (the access fee above, in months they have a private;
-- 0 charges nothing) or 'membership' (they can't book a private without an active plan from private_plan_ids). Gyms that were there keep 'fee'.
alter table gyms add column if not exists access_mode text not null default 'fee';
alter table gyms add column if not exists private_plan_ids bigint[] not null default '{}';
-- a coach took the register for this class (ticked or unticked someone who'd booked): from then on a booking only counts as a visit
-- if they ticked it. Self check-ins and walk-ins a coach adds don't take the register, so they never undo other people's bookings.
alter table classes add column if not exists register_at timestamptz;
alter table classes add column if not exists register_by bigint references users(id) on delete set null;
-- someone who left the gym still owing: kept for that month's Money list ("Left · owes R1 200")
create table if not exists left_owing(
  id bigserial primary key,
  gym_id bigint not null references gyms(id) on delete cascade,
  user_id bigint references users(id) on delete set null,
  name text not null,
  phone text not null default '',
  email text,
  month text not null,
  owed_cents int not null,
  left_at timestamptz not null default now()
);
create index if not exists left_owing_gym on left_owing(gym_id, month);
-- who last moved a class to another time: a coach saving an edit made before that is told who moved it
alter table classes add column if not exists moved_by bigint references users(id) on delete set null;
-- which months a fee payment pays for, decided once when it's saved (so a fee paid early on the 28th counts for next month,
-- and later payments never move it). for_month is the first month; alloc splits it over several months ({"2026-10": 85000, ...}).
-- Neither set (payments from before this, and packs): the month it was paid in, for months months.
alter table payments add column if not exists for_month date;
alter table payments add column if not exists alloc jsonb;
-- a proof sent "for" a plan (a new member joining it): confirming it puts them on the plan
alter table payments add column if not exists plan_id bigint references plans(id) on delete set null;
-- months before this never count toward what someone owes: members added in bulk start on their next due date
alter table users add column if not exists bill_from date;
alter table users add column if not exists trial_ends date;
-- free stretches of someone's membership, in whole months: a pause, a trial, or a cancelled plan. from_month to until_month
-- (the first days of those months; no until_month: open-ended). Months before and after stay owed, so pausing never wipes a debt
-- and coming back never bills the paused months. ended_at: when it was ended (by hand or when it ran out).
create table if not exists plan_breaks(
  id bigserial primary key,
  gym_id bigint not null references gyms(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  kind text not null check (kind in ('pause','trial','cancel')),
  from_month date not null,
  until_month date,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists plan_breaks_user on plan_breaks(user_id);
-- money paid ahead for months a pause then made free, moved to the months after it ([{id, was, now}]: each payment's months before and after),
-- so it can be put back if the pause is undone
alter table plan_breaks add column if not exists moved jsonb;
-- the month a gym started keeping its fees in the app: months before it never show as owed
alter table gyms add column if not exists bill_start date;
-- The weekly timetable (gyms.profile.timetable, each row with an id) keeps about 8 weeks of classes on the calendar by itself.
-- A class made from a row keeps the row's id and the Monday of its week, so one row never makes two classes in a week,
-- even after that class is moved. timetable_rolled: the day the calendar was last filled (once a day per gym).
alter table classes add column if not exists slot_id text;
alter table classes add column if not exists slot_week date;
create unique index if not exists classes_slot_week on classes(gym_id, slot_id, slot_week) where slot_id is not null;
alter table gyms add column if not exists timetable_rolled date;
-- A class from the timetable a coach deleted (a public holiday, a seminar): it isn't put back.
create table if not exists class_skips(
  id bigserial primary key,
  gym_id bigint not null references gyms(id) on delete cascade,
  slot_id text,
  week date,
  starts_at timestamptz not null,
  title text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists class_skips_gym on class_skips(gym_id, starts_at);
-- Fee reminders by email: null until the head coach is asked once (the first time they email reminders), then on (true) or off.
alter table gyms add column if not exists auto_remind boolean;
-- The last day the automatic reminders ran for a gym and what they did ({day, sent, noEmail}): it's claimed first, so one run a day, on one server.
alter table gyms add column if not exists remind_log jsonb;
-- When someone was last sent a fee reminder (by the coach or automatically): nobody is reminded twice within 6 days.
alter table users add column if not exists reminded_at timestamptz;
-- "Keep" on Home's "haven't trained in 60 days" card: they're left off that card until this day.
alter table users add column if not exists idle_kept_until date;
-- Why a pause was made: 'idle' when the head coach paused people who stopped coming (booking or checking in again ends it by itself).
-- told_at: when they were sent the "we miss you" message (a few minutes later, so Undo can still stop it).
alter table plan_breaks add column if not exists reason text;
alter table plan_breaks add column if not exists told_at timestamptz;
-- Families: one parent login, several kids. A kid's record linked to the account that signs in for them (parent_id: that login).
-- The kid has no email or password of their own. Linking a second kid to a parent never needs a second email.
alter table users add column if not exists parent_id bigint references users(id) on delete set null;
create index if not exists users_parent on users(parent_id) where parent_id is not null;
-- Who a parent's session is booking for ("Booking for: Lerato"): one of their kids, or null for the login itself.
alter table sessions add column if not exists as_user bigint references users(id) on delete set null;
-- A family payment confirmed for one kid that was more than that kid owed: the rest went to their brothers and sisters,
-- as payments of their own (split_of: the payment it came from). Deleting that payment, or Undo, takes them away again.
alter table payments add column if not exists split_of bigint references payments(id) on delete cascade;
create index if not exists payments_split on payments(split_of) where split_of is not null;
-- Card autopay: a member's card saved with PayFast (on the gym's own account), charged what they owe on each due day.
-- One row per member it pays for (a parent's card can pay for each of their kids). token: sealed, like the gym's keys; token_hash finds
-- it from a PayFast notification. from_month: months from this one are paid automatically (older ones stay for the member to pay).
-- stopped_at: the member tapped Stop. Undo works for a few minutes; then the card is cancelled with PayFast and the row goes.
create table if not exists autopay(
  user_id bigint primary key references users(id) on delete cascade,
  gym_id bigint not null references gyms(id) on delete cascade,
  payer_id bigint references users(id) on delete cascade,
  token text not null,
  token_hash text not null,
  merchant_id text not null,
  from_month text not null,
  stopped_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists autopay_token on autopay(token_hash);
create index if not exists autopay_gym on autopay(gym_id);
-- Each automatic charge, one per member per month (claimed before PayFast is asked, so two servers never charge twice).
-- status: charging (asking PayFast), sent (PayFast took it; its notification records the payment), paid, failed (the card was
-- declined: the member and the head coach are told once, told_at), unsure (no answer from PayFast in a day: the head coach is told).
create table if not exists autopay_charges(
  id bigserial primary key,
  gym_id bigint not null references gyms(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  month text not null,
  amount_cents int not null,
  status text not null default 'charging',
  error text not null default '',
  payment_id bigint references payments(id) on delete set null,
  told_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, month)
);
create index if not exists autopay_charges_open on autopay_charges(status) where status in ('charging','sent');
-- alloc: the months a charge is for and how much of each ({"2026-10": 85000, "2026-11": 85000}), so it pays those, not older ones.
-- More statuses: left (PayFast confirmed it after the member left: recorded, and the head coach told).
alter table autopay_charges add column if not exists alloc jsonb;
-- the last day the autopay job ran for a gym (once a day each)
alter table gyms add column if not exists autopay_day text;
-- Outreach: a private preview of a gym on JitsFlow, made from its public website, and the email to its owner (platform admins only).
-- token: the preview's address (/try/<token>), unguessable. logo: stored like gyms.logo. accent: the website's colour (null: none found).
create table if not exists prospects(
  id bigserial primary key,
  token text unique not null,
  website text not null,
  domain text not null,
  name text not null default '',
  profile jsonb not null default '{}',
  logo bytea,
  logo_type text,
  accent text,
  method text,
  owner_name text not null default '',
  owner_email text,
  personal_line text not null default '',
  subject text not null default '',
  status text not null default 'draft' check (status in ('draft','sent','claimed','optedout')),
  import_state text not null default 'running' check (import_state in ('running','done','failed')),
  import_error text,
  imported_at timestamptz,
  views int not null default 0,
  last_viewed_at timestamptz,
  sent_at timestamptz,
  sent_to text,
  sent_by bigint references users(id) on delete set null,
  followup_sent_at timestamptz,
  claimed_at timestamptz,
  claimed_gym_id bigint references gyms(id) on delete set null,
  opted_out_at timestamptz,
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists prospects_domain on prospects(domain);
-- Never contact these again: a website's domain ("not my gym", or opted out) and an owner's email address (opted out).
create table if not exists outreach_dnc(
  kind text not null check (kind in ('domain','email')),
  value text not null,
  created_at timestamptz not null default now(),
  primary key(kind, value)
);
-- Pre-built gyms: outreach makes the gym from its website before anyone owns it. claim (not null = unclaimed): {prospectId, builtAt,
-- builtBy}. An unclaimed gym has no head coach, its codes don't work, no jobs run for it, and only its preview link shows it (read only).
-- prospects.gym_id: the gym built for that prospect (it stays after the claim). token_hash: what the preview link is looked up by.
alter table gyms add column if not exists claim jsonb;
alter table gyms add column if not exists claimed_at timestamptz;
alter table prospects add column if not exists gym_id bigint references gyms(id) on delete set null;
alter table prospects add column if not exists claimed_by bigint references users(id) on delete set null;
alter table prospects add column if not exists token_hash text generated always as (encode(sha256(decode(token, 'escape')), 'hex')) stored;
create unique index if not exists prospects_token_hash on prospects(token_hash);
-- The beta ("founding gyms"): {status: applied|accepted|declined|left, appliedAt, note, acceptedAt, feeCents, feeUntil, afterCents,
-- features: [flags], adminNote}. Feedback from beta gyms (text and an optional screenshot) for the JitsFlow team.
alter table gyms add column if not exists beta jsonb;
create table if not exists beta_feedback(
  id bigserial primary key,
  gym_id bigint not null references gyms(id) on delete cascade,
  user_id bigint references users(id) on delete set null,
  text text not null default '',
  shot bytea,
  shot_type text,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
-- Website visitors, counted on the server without cookies (backend/visits.js): page views per page per day, and one row per visitor
-- per day (vhash: a hash of the address and browser with that day's secret, which is deleted once the day is over). 13 months kept.
create table if not exists site_daily(
  day date not null,
  path text not null,
  views int not null default 0,
  primary key(day, path)
);
create table if not exists site_visitors(
  day date not null,
  vhash text not null,
  first_path text not null default '',
  ref text not null default '',
  utm_source text not null default '',
  utm_medium text not null default '',
  utm_campaign text not null default '',
  click text not null default '',
  click_id text not null default '',
  country text not null default '',
  pages int not null default 0,
  app int not null default 0,
  primary key(day, vhash)
);
create table if not exists site_salt(day date primary key, salt text not null);
-- Where someone came from before signing up (the app sends it; see backend/visits.js signupSource), and when they made their login.
alter table users add column if not exists signup_source jsonb;
alter table users add column if not exists signed_up_at timestamptz;
`;

// Every class a timetable row makes in the next 8 weeks (today and 55 days on, in the gym's time zone), for one gym.
// Rows marked off (the coach unticked "put on the calendar") and days before a row's "from" day are left out;
// two identical rows count once.
const OCC = `o as (
  select distinct on (d.day, r->>'start', lower(r->>'title')) g.id as gym_id, r->>'id' as slot, d.day, date_trunc('week', d.day)::date as week,
    (d.day + (r->>'start')::time) at time zone g.timezone as starts_at, coalesce(nullif(r->>'title',''), 'Class') as title,
    case when coalesce(r->>'end','') !~ '^\\d{2}:\\d{2}$' then 60 when (r->>'end')::time - (r->>'start')::time >= interval '15 minutes'
      then (extract(epoch from (r->>'end')::time - (r->>'start')::time) / 60)::int else 60 end as dur,
    coalesce(r->>'coach','') as coach, coalesce(r->>'level','') as level, coalesce(r->>'type','') as discipline,
    case when coalesce(r->>'cap','') ~ '^\\d{1,3}$' then least(500, greatest(1, (r->>'cap')::int)) end as cap
  from gyms g cross join lateral jsonb_array_elements(case when jsonb_typeof(g.profile->'timetable')='array' then g.profile->'timetable' else '[]'::jsonb end) r
  cross join lateral (select x::date as day from generate_series((now() at time zone g.timezone)::date, (now() at time zone g.timezone)::date + 55, interval '1 day') x) d
  where g.id=$1 and coalesce(r->>'id','') <> '' and coalesce(r->>'start','') ~ '^\\d{2}:\\d{2}$' and coalesce(r->>'off','') <> 'true'
    and extract(isodow from d.day) = array_position(array['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], r->>'day')
    and case when coalesce(r->>'from','') ~ '^\\d{4}-\\d{2}-\\d{2}$' then d.day >= (r->>'from')::date else true end
  order by d.day, r->>'start', lower(r->>'title'), r->>'id')`;
// Timetable rows from before rows had ids get one.
const TT_IDS = `update gyms g set profile = jsonb_set(g.profile, '{timetable}', (select jsonb_agg(case when coalesce(r->>'id','') <> '' then r
    else r || jsonb_build_object('id', substr(md5(random()::text || g.id::text || n::text), 1, 10)) end order by n) from jsonb_array_elements(g.profile->'timetable') with ordinality t(r, n)))
  where jsonb_typeof(g.profile->'timetable')='array' and exists (select 1 from jsonb_array_elements(g.profile->'timetable') r where coalesce(r->>'id','') = '')`;

// A class is the row's class when its name is the row's name, or the name with its level as the class form suggests it ("Kids BJJ (Beginners)").
const SAME = (t) => `lower(${t}) in (lower(o.title), lower(o.title || ' (' || o.level || ')'))`;
// Fill one gym's calendar from its timetable: classes already there at a row's time (added by hand before) are linked to the row,
// then each row gets its class in each of the next 8 weeks, unless that week has one from the row already or the coach deleted it.
// Safe to run any number of times and on several servers at once (a lock per gym, and one class per row per week in the database).
// Returns how many classes it added.
async function rollTimetable(pool, gymId) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(4711003, $1::int)", [gymId]);
    await db.query(`with ${OCC}, p as (select distinct on (o.slot, o.week) o.slot, o.week, c.id from o
        join classes c on c.gym_id=o.gym_id and c.starts_at=o.starts_at and ${SAME("c.title")} and c.slot_id is null and c.kind<>'private'
        where not exists (select 1 from classes x where x.gym_id=o.gym_id and x.slot_id=o.slot and x.slot_week=o.week) order by o.slot, o.week, c.id)
      update classes c set slot_id=p.slot, slot_week=p.week from p where c.id=p.id`, [gymId]);
    const r = await db.query(`with ${OCC} insert into classes(gym_id,title,starts_at,duration_min,coach,level,discipline,capacity,slot_id,slot_week)
      select o.gym_id, o.title, o.starts_at, o.dur, o.coach, o.level, o.discipline, o.cap, o.slot, o.week from o where o.starts_at > now()
        and not exists (select 1 from classes x where x.gym_id=o.gym_id and ((x.slot_id=o.slot and x.slot_week=o.week) or (x.starts_at=o.starts_at and ${SAME("x.title")})))
        and not exists (select 1 from class_skips s where s.gym_id=o.gym_id and ((s.slot_id=o.slot and s.week=o.week) or (s.starts_at=o.starts_at and ${SAME("s.title")})))
      on conflict do nothing`, [gymId]);
    await db.query("update gyms set timetable_rolled=current_date where id=$1", [gymId]);
    await db.query("commit");
    return r.rowCount;
  } catch (e) { await db.query("rollback").catch(() => {}); throw e; } finally { db.release(); }
}
// Every gym whose calendar wasn't filled today. Runs at startup and every hour, so each gym is done about once a day.
async function rollAll(pool) {
  await pool.query(TT_IDS);
  await pool.query("delete from class_skips where starts_at < now() - interval '14 days'");
  // Unclaimed gyms (outreach previews) aren't rolled here: their preview rolls its own calendar when it's opened.
  const gyms = (await pool.query(`select id from gyms where claim is null and timetable_rolled is distinct from current_date and jsonb_typeof(profile->'timetable')='array'
    and jsonb_array_length(profile->'timetable') > 0`)).rows;
  let added = 0;
  for (const g of gyms) { try { added += await rollTimetable(pool, g.id); } catch (e) { console.warn("timetable:", g.id, e.message); } }
  return added;
}

// Gyms without an active head coach (gyms from before head coaches, or the head left): the longest-standing active coach takes it.
// When a coach joined is gym_joined_at if they moved in with a code, or when their account was made if they signed up into the gym
// (the coach who started it is made just after the gym). A coach whose account is older than the gym and has no gym_joined_at
// moved in with a code before that was kept, at a time we don't know: they come after everyone whose joining time we know.
const LONGEST = (g) => `(select u.id from users u join gyms gg on gg.id=u.gym_id where u.gym_id=${g} and u.role='coach' and u.active and u.pass_hash is not null
  order by coalesce(u.gym_joined_at, case when u.created_at >= gg.created_at then u.created_at end) nulls last, u.created_at, u.id limit 1)`;
const HEAD_FIX = `update gyms g set head_coach_id=${LONGEST("g.id")} where not exists (select 1 from users h where h.id=g.head_coach_id and h.gym_id=g.id and h.role='coach' and h.active)
  and ${LONGEST("g.id")} is not null`;

// Proofs a coach marked "not a payment" leave the coach's list after 30 days. Delete them then (their files go with them).
const purgeRejected = (pool) => pool.query("delete from payments where status='rejected' and created_at < now() - interval '30 days'");

// Pauses that have run out end on their own: the member is active again and the head coach (and they) get a note on Home.
// Safe to run any number of times, on any number of servers at once: one statement ends each pause once, and only the
// server that ended it writes the notes. Runs at startup and every hour.
async function tick(pool) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    if ((await db.query("select pg_try_advisory_xact_lock(4711001) as ok")).rows[0].ok) {
      await db.query(`with done as (
          update plan_breaks b set ended_at=now() from users u join gyms g on g.id=u.gym_id
          where b.user_id=u.id and b.gym_id=u.gym_id and b.kind='pause' and b.ended_at is null and b.until_month is not null
            and b.until_month < date_trunc('month', now() at time zone g.timezone)::date
          returning b.user_id, b.gym_id, b.until_month),
        back as (update users u set plan_status='active' from done where u.id=done.user_id and u.plan_status='paused'
          returning u.id, u.name, u.gym_id, to_char(done.until_month + interval '1 month', 'FMDD FMMonth') as from_day),
        coach as (insert into notices(gym_id,user_id,kind,title,body) select b.gym_id, g.head_coach_id, 'resumed', 'Back from a pause',
            split_part(b.name,' ',1) || '''s pause ended, so they''re active again. Their fees start again from ' || b.from_day || '.'
          from back b join gyms g on g.id=b.gym_id where g.head_coach_id is not null)
        insert into notices(gym_id,user_id,kind,title,body) select gym_id, id, 'resumed', 'Welcome back', 'Your pause is over and your membership is active again. You can book classes.' from back`);
    }
    await db.query("commit");
  } catch (e) { await db.query("rollback").catch(() => {}); throw e; } finally { db.release(); }
}

function makePool() {
  if (!process.env.DATABASE_URL) return null;
  const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false;
  return new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: Number(process.env.DB_POOL_MAX) || 20, idleTimeoutMillis: 30000 });
}

async function migrate(pool) {
  await pool.query(SCHEMA);
  // One row per PayFast payment, even if the same notification arrives twice at once. Older duplicates would block it: warn, don't stop.
  await pool.query("create unique index if not exists payments_payfast_ref on payments(gym_id, reference) where source='payfast'").catch((e) => console.warn("payments_payfast_ref:", e.message));
  await pool.query(HEAD_FIX);
  await pool.query("delete from sessions where expires_at < now()");
  await pool.query("delete from password_resets where expires_at < now()");
  // Logins made before sign-up times were kept: when the record was made.
  await pool.query("update users set signed_up_at=created_at where signed_up_at is null and pass_hash is not null");
  await purgeRejected(pool);
  // Gyms from before running balances start owing from the month this went live, whatever they recorded before: until now Money only
  // looked at the current month, so fees paid in cash and never recorded must not turn into months of arrears. Older months still
  // show when paging back. New gyms start the month they're made.
  await pool.query("update gyms g set bill_start = date_trunc('month', now() at time zone coalesce(g.timezone, 'Africa/Johannesburg'))::date where bill_start is null");
  await pool.query("alter table gyms alter column bill_start set default date_trunc('month', now() at time zone 'Africa/Johannesburg')::date");
  // Members paused, on trial or cancelled before breaks had dates: free from the month they started, as they were.
  // A trial from then runs 14 days from when its plan started (so an old one shows as ended on Home straight away).
  await pool.query(`insert into plan_breaks(gym_id,user_id,kind,from_month) select u.gym_id, u.id, case u.plan_status when 'paused' then 'pause' when 'trial' then 'trial' else 'cancel' end,
      date_trunc('month', least(coalesce(u.plan_started, u.created_at::date), u.created_at::date))::date
    from users u where u.gym_id is not null and u.plan_status in ('paused','trial','cancelled')
      and not exists (select 1 from plan_breaks b where b.user_id=u.id and b.ended_at is null)`);
  await pool.query("update users set trial_ends = coalesce(plan_started, created_at::date) + 14 where plan_status='trial' and trial_ends is null");
  await tick(pool);
  await pool.query(TT_IDS);
  // One-off tidy-up: empty test gyms left by deploy checks (named "… (delete me)", nobody in them).
  await pool.query("delete from gyms g where g.name like '%(delete me)' and not exists (select 1 from users u where u.gym_id=g.id)");
}

module.exports = { makePool, migrate, purgeRejected, tick, rollTimetable, rollAll, LONGEST };
