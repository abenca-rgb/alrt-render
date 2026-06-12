create table if not exists public.guardrail_blocks (
  id bigserial primary key,
  alert_id text not null,
  candidate_key text,
  symbol text,
  direction text check (direction is null or direction in ('LONG', 'SHORT')),
  setup_type text,
  setup_group text,
  blocked_by text not null,
  matched_previous_alert_id text,
  matched_previous_ref_id text,
  minutes_since_previous_alert integer,
  timestamp_utc timestamptz not null,
  guardrail_version text not null,
  mode text not null,
  window_minutes integer not null,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  unique(alert_id, blocked_by, guardrail_version)
);

create index if not exists guardrail_blocks_timestamp_idx
  on public.guardrail_blocks(timestamp_utc);

create index if not exists guardrail_blocks_rule_idx
  on public.guardrail_blocks(blocked_by, guardrail_version);

create index if not exists guardrail_blocks_symbol_direction_idx
  on public.guardrail_blocks(symbol, direction);

create index if not exists guardrail_blocks_previous_alert_idx
  on public.guardrail_blocks(matched_previous_alert_id);

create table if not exists public.guardrail_reports (
  id bigserial primary key,
  report_key text not null unique,
  guardrail_name text not null,
  guardrail_version text not null,
  period_type text not null,
  period_start_utc timestamptz,
  period_end_utc timestamptz,
  total_alerts integer not null default 0,
  blocked_alerts integer not null default 0,
  blocked_pct numeric,
  symbols_affected jsonb not null default '{}'::jsonb,
  directions_affected jsonb not null default '{}'::jsonb,
  wins_missed integer not null default 0,
  losses_avoided integer not null default 0,
  net_value integer not null default 0,
  paid_volume_impact_pct numeric,
  free_selection_impact jsonb not null default '{}'::jsonb,
  generated_at_utc timestamptz not null default now(),
  summary jsonb not null default '{}'::jsonb
);

create index if not exists guardrail_reports_rule_idx
  on public.guardrail_reports(guardrail_name, guardrail_version, period_type, generated_at_utc);

create or replace view public.guardrail_cluster_60m_live_report as
select
  date_trunc('day', gb.timestamp_utc)::date as day,
  gb.blocked_by,
  gb.guardrail_version,
  count(*)::integer as alerts_blocked,
  count(distinct gb.symbol)::integer as symbols_affected,
  jsonb_object_agg(gb.symbol, symbol_counts.blocked_count) filter (where symbol_counts.symbol is not null) as blocked_by_symbol,
  sum(case when a.is_free_shared then 1 else 0 end)::integer as matched_previous_free_shared,
  sum(case when o.outcome_type in ('TP', 'TIME_EXIT_PROFIT') then 1 else 0 end)::integer as matched_previous_wins,
  sum(case when o.outcome_type in ('SL', 'TIME_EXIT_LOSS') then 1 else 0 end)::integer as matched_previous_losses
from public.guardrail_blocks gb
left join public.alerts a
  on a.alert_id = gb.matched_previous_alert_id
left join public.outcomes o
  on o.alert_id = gb.matched_previous_alert_id
left join (
  select
    date_trunc('day', timestamp_utc)::date as day,
    blocked_by,
    guardrail_version,
    symbol,
    count(*)::integer as blocked_count
  from public.guardrail_blocks
  group by 1, 2, 3, 4
) symbol_counts
  on symbol_counts.day = date_trunc('day', gb.timestamp_utc)::date
  and symbol_counts.blocked_by = gb.blocked_by
  and symbol_counts.guardrail_version = gb.guardrail_version
  and symbol_counts.symbol = gb.symbol
group by 1, 2, 3;
