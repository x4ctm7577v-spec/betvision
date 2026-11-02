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

-- Récord público de recomendaciones (nunca se borran)
create table if not exists picks (
  id bigint generated always as identity primary key,
  game_id text, sport_key text, league text, start_time timestamptz,
  team text, opponent text, kind text default 'valor',
  prob numeric, odds numeric, book text, ev numeric, closing_prob numeric,
  status text default 'open', profit numeric,
  created_at timestamptz default now(),
  unique (game_id, team, kind)
);
create table if not exists parlays (
  id bigint generated always as identity primary key,
  day text, kind text, legs jsonb, prob numeric, odds numeric,
  status text default 'open', profit numeric,
  created_at timestamptz default now(),
  unique (day, kind)
);
alter table picks enable row level security;
alter table parlays enable row level security;

-- Prueba gratis de 7 días sin tarjeta
alter table profiles add column if not exists trial_ends timestamptz;


-- Líneas de apertura (para medir cómo se mueve la cuota)
create table if not exists lines (
  game_id text primary key,
  data jsonb not null,
  first_seen timestamptz not null default now()
);
alter table lines enable row level security;


-- Lista de espera (página /espera)
create table if not exists waitlist (
  id bigserial primary key,
  contact text unique not null,
  kind text not null default 'email',
  lang text default 'es',
  source text,
  created_at timestamptz not null default now()
);
alter table waitlist enable row level security;


-- ===== App de iPhone (App Store) =====
-- Suscripción comprada con Apple (la avisa RevenueCat)
alter table profiles add column if not exists iap_status text;
alter table profiles add column if not exists iap_expires timestamptz;
-- Teléfonos que aceptaron avisos
create table if not exists push_tokens (
  token text primary key,
  user_id uuid references auth.users on delete cascade,
  lang text default 'es',
  updated_at timestamptz not null default now()
);
alter table push_tokens enable row level security;
-- Para no mandar el mismo aviso dos veces el mismo día
create table if not exists push_log (
  day text not null,
  kind text not null,
  sent_at timestamptz not null default now(),
  primary key (day, kind)
);
alter table push_log enable row level security;
