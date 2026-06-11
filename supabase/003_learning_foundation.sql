create table if not exists public.alert_candidates (
  id bigserial primary key,
  candidate_key text not null unique,
  alert_id text,
  ref_id text,
  symbol text,
  direction text check (direction is null or direction in ('LONG', 'SHORT')),
  timeframe text,
  entry_price numeric,
  tp1_price numeric,
  tp2_price numeric,
  tp3_price numeric,
  sl_price numeric,
  rr numeric,
  rsi numeric,
  trend_strength numeric,
  atr_pct numeric,
  volatility_pct numeric,
  session_name text,
  market_regime text,
  setup_type text,
  setup_score numeric,
  strength text,
  pine_version text,
  render_version text,
  event_type text,
  event_time_utc timestamptz,
  decision text not null default 'PENDING' check (
    decision in ('PENDING', 'ACCEPTED', 'REJECTED', 'IGNORED', 'CLOSED')
  ),
  decision_reason text,
  quality_score integer check (quality_score is null or (quality_score >= 0 and quality_score <= 100)),
  quality_grade text,
  posted_to_paid boolean not null default false,
  posted_to_free boolean not null default false,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.outcomes
  add column if not exists candidate_key text,
  add column if not exists symbol text,
  add column if not exists direction text,
  add column if not exists move_pct numeric,
  add column if not exists r_multiple numeric,
  add column if not exists closed_at_utc timestamptz,
  add column if not exists matched_by text;

create table if not exists public.optimizer_reports (
  id bigserial primary key,
  period_start date,
  period_end date,
  scope text,
  metric_group text,
  recommendation text,
  confidence text check (confidence is null or confidence in ('LOW', 'MEDIUM', 'HIGH')),
  supporting_stats jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.daily_stats (
  id bigserial primary key,
  day date not null,
  symbol text,
  session_name text,
  market_regime text,
  setup_type text,
  score_bucket text,
  alerts integer not null default 0,
  posted_paid integer not null default 0,
  posted_free integer not null default 0,
  rejected integer not null default 0,
  tp integer not null default 0,
  sl integer not null default 0,
  time_exit_profit integer not null default 0,
  time_exit_loss integer not null default 0,
  expired integer not null default 0,
  winrate numeric,
  expectancy_r numeric,
  supporting_stats jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(day, symbol, session_name, market_regime, setup_type, score_bucket)
);

create index if not exists alert_candidates_symbol_idx on public.alert_candidates(symbol);
create index if not exists alert_candidates_decision_idx on public.alert_candidates(decision);
create index if not exists alert_candidates_created_idx on public.alert_candidates(created_at);
create index if not exists alert_candidates_event_time_idx on public.alert_candidates(event_time_utc);
create index if not exists alert_candidates_setup_idx on public.alert_candidates(setup_type);
create index if not exists alert_candidates_session_idx on public.alert_candidates(session_name);
create index if not exists alert_candidates_regime_idx on public.alert_candidates(market_regime);
create index if not exists alert_candidates_quality_idx on public.alert_candidates(quality_score);

create index if not exists outcomes_candidate_key_idx on public.outcomes(candidate_key);
create index if not exists outcomes_symbol_idx on public.outcomes(symbol);
create index if not exists outcomes_closed_at_idx on public.outcomes(closed_at_utc);
create index if not exists daily_stats_day_idx on public.daily_stats(day);
create index if not exists daily_stats_symbol_idx on public.daily_stats(symbol);
create index if not exists daily_stats_setup_idx on public.daily_stats(setup_type);

create or replace view public.candidate_performance as
select
  c.candidate_key,
  c.alert_id,
  c.ref_id,
  c.symbol,
  c.direction,
  c.timeframe,
  c.setup_type,
  c.session_name,
  c.market_regime,
  c.quality_score,
  c.quality_grade,
  c.decision,
  c.decision_reason,
  c.posted_to_paid,
  c.posted_to_free,
  c.event_time_utc,
  o.outcome_type,
  coalesce(o.closed_at_utc, o.outcome_time_utc) as closed_at_utc,
  coalesce(o.move_pct, o.pnl_percent) as move_pct,
  o.r_multiple,
  case when o.outcome_type in ('TP', 'TIME_EXIT_PROFIT') then 1 else 0 end as is_win,
  case when o.outcome_type in ('SL', 'TIME_EXIT_LOSS') then 1 else 0 end as is_loss
from public.alert_candidates c
left join public.outcomes o
  on o.candidate_key = c.candidate_key
  or (o.alert_id = c.alert_id and c.alert_id is not null);
