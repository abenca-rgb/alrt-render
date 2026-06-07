create extension if not exists pgcrypto;

create table if not exists public.alerts (
  id bigserial primary key,
  alert_id text not null unique,
  ref_id text not null unique,
  symbol text not null,
  direction text not null check (direction in ('LONG', 'SHORT')),
  timeframe text,
  setup_type text,
  entry_price numeric,
  tp_price numeric,
  sl_price numeric,
  rr numeric,
  risk_score numeric,
  quality_score integer check (quality_score is null or (quality_score >= 0 and quality_score <= 100)),
  quality_grade text,
  why_text text,
  signal_time_utc timestamptz not null,
  session_name text,
  market_regime text,
  pine_version text,
  backend_version text,
  is_free_shared boolean not null default false,
  raw_payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.outcomes (
  id bigserial primary key,
  alert_id text not null references public.alerts(alert_id) on delete cascade,
  ref_id text not null,
  outcome_type text not null check (
    outcome_type in (
      'TP',
      'SL',
      'TIME_EXIT_PROFIT',
      'TIME_EXIT_LOSS',
      'EXPIRED',
      'MANUAL_CLOSE'
    )
  ),
  outcome_time_utc timestamptz not null,
  pnl_percent numeric,
  duration_minutes integer,
  exit_price numeric,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  unique(alert_id)
);

create table if not exists public.alert_rejections (
  id bigserial primary key,
  symbol text,
  direction text check (direction is null or direction in ('LONG', 'SHORT')),
  setup_type text,
  reason text not null,
  quality_score integer,
  quality_grade text,
  raw_payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.daily_summaries (
  id bigserial primary key,
  date_key date not null unique,
  alerts_count integer not null default 0,
  tp_count integer not null default 0,
  sl_count integer not null default 0,
  expired_count integer not null default 0,
  time_exit_profit_count integer not null default 0,
  time_exit_loss_count integer not null default 0,
  open_count integer not null default 0,
  rejected_count integer not null default 0,
  winrate numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists alerts_symbol_idx on public.alerts(symbol);
create index if not exists alerts_signal_time_idx on public.alerts(signal_time_utc);
create index if not exists alerts_setup_type_idx on public.alerts(setup_type);
create index if not exists alerts_session_name_idx on public.alerts(session_name);
create index if not exists alerts_timeframe_idx on public.alerts(timeframe);
create index if not exists alerts_quality_score_idx on public.alerts(quality_score);

create index if not exists outcomes_type_idx on public.outcomes(outcome_type);
create index if not exists outcomes_time_idx on public.outcomes(outcome_time_utc);
create index if not exists outcomes_ref_idx on public.outcomes(ref_id);

create index if not exists alert_rejections_created_idx on public.alert_rejections(created_at);
create index if not exists alert_rejections_reason_idx on public.alert_rejections(reason);

create or replace view public.alert_performance as
select
  a.alert_id,
  a.ref_id,
  a.symbol,
  a.direction,
  a.timeframe,
  a.setup_type,
  a.session_name,
  a.market_regime,
  a.quality_score,
  a.quality_grade,
  a.signal_time_utc,
  o.outcome_type,
  o.outcome_time_utc,
  o.pnl_percent,
  o.duration_minutes,
  case when o.outcome_type in ('TP', 'TIME_EXIT_PROFIT') then 1 else 0 end as is_win,
  case when o.outcome_type in ('SL', 'TIME_EXIT_LOSS') then 1 else 0 end as is_loss
from public.alerts a
left join public.outcomes o on o.alert_id = a.alert_id;

