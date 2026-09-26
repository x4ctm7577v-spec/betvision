-- BetVision: pega todo esto en Supabase > SQL Editor y toca Run

create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  stripe_customer_id text,
  sub_status text default 'none',
  period_end timestamptz,
  had_trial boolean default false,
  bankroll numeric default 0,
  created_at timestamptz default now()
);

create table if not exists bets (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users on delete cascade,
  game_id text, sport_key text, league text, start_time timestamptz,
  team text, opponent text,
  odds_taken numeric, stake numeric, prob_taken numeric,
  closing_prob numeric, closing_odds numeric,
  status text default 'open', profit numeric,
  created_at timestamptz default now()
);

create index if not exists bets_user_idx on bets(user_id);
create index if not exists bets_status_idx on bets(status);

-- Solo el servidor (con la clave service_role) puede leer y escribir estas tablas.
alter table profiles enable row level security;
alter table bets enable row level security;

-- Agregado para casas recomendadas y afiliados
alter table profiles add column if not exists state text;
alter table profiles add column if not exists book text;
create table if not exists clicks (
  id bigint generated always as identity primary key,
  book text, kind text, user_id uuid, created_at timestamptz default now()
);
alter table clicks enable row level security;
