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
`;

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
  await purgeRejected(pool);
  // One-off tidy-up: empty test gyms left by deploy checks (named "… (delete me)", nobody in them).
  await pool.query("delete from gyms g where g.name like '%(delete me)' and not exists (select 1 from users u where u.gym_id=g.id)");
}

module.exports = { makePool, migrate, purgeRejected, LONGEST };
