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
`;

function makePool() {
  if (!process.env.DATABASE_URL) return null;
  const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false;
  return new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 10, idleTimeoutMillis: 30000 });
}

async function migrate(pool) {
  await pool.query(SCHEMA);
  await pool.query("delete from sessions where expires_at < now()");
}

module.exports = { makePool, migrate };
