create table if not exists public.summary_dispatches (
  id bigserial primary key,
  period_type text not null check (period_type in ('daily', 'weekly')),
  period_key text not null,
  status text not null default 'unsent' check (status in ('unsent', 'sending', 'sent', 'failed')),
  summary_text text,
  stats jsonb not null default '{}'::jsonb,
  force_count integer not null default 0,
  attempt_count integer not null default 0,
  last_error text,
  sent_at_utc timestamptz,
  created_at_utc timestamptz not null default now(),
  updated_at_utc timestamptz not null default now(),
  unique(period_type, period_key)
);

create index if not exists summary_dispatches_period_idx
  on public.summary_dispatches(period_type, period_key);

create index if not exists summary_dispatches_status_idx
  on public.summary_dispatches(status);

alter table public.daily_summaries
  add column if not exists sent_status text not null default 'unsent',
  add column if not exists sent_at_utc timestamptz,
  add column if not exists summary_text text,
  add column if not exists stats jsonb not null default '{}'::jsonb;

create or replace function public.claim_summary_dispatch(
  p_period_type text,
  p_period_key text,
  p_force boolean default false
)
returns jsonb
language plpgsql
security definer
as $$
declare
  row_data public.summary_dispatches%rowtype;
begin
  insert into public.summary_dispatches (period_type, period_key, status)
  values (p_period_type, p_period_key, 'unsent')
  on conflict (period_type, period_key) do nothing;

  select *
  into row_data
  from public.summary_dispatches
  where period_type = p_period_type
    and period_key = p_period_key
  for update;

  if row_data.status = 'sent' and not p_force then
    return jsonb_build_object(
      'claimed', false,
      'alreadySent', true,
      'status', row_data.status,
      'sentAtUtc', row_data.sent_at_utc
    );
  end if;

  update public.summary_dispatches
  set
    status = 'sending',
    attempt_count = attempt_count + 1,
    force_count = force_count + case when p_force then 1 else 0 end,
    last_error = null,
    updated_at_utc = now()
  where period_type = p_period_type
    and period_key = p_period_key;

  return jsonb_build_object(
    'claimed', true,
    'alreadySent', false,
    'status', 'sending'
  );
end;
$$;

create or replace function public.complete_summary_dispatch(
  p_period_type text,
  p_period_key text,
  p_status text,
  p_summary_text text default null,
  p_stats jsonb default '{}'::jsonb,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
as $$
begin
  update public.summary_dispatches
  set
    status = p_status,
    summary_text = coalesce(p_summary_text, summary_text),
    stats = coalesce(p_stats, stats),
    last_error = p_error,
    sent_at_utc = case when p_status = 'sent' then now() else sent_at_utc end,
    updated_at_utc = now()
  where period_type = p_period_type
    and period_key = p_period_key;

  if p_period_type = 'daily' then
    insert into public.daily_summaries (date_key)
    values (p_period_key::date)
    on conflict (date_key) do nothing;

    update public.daily_summaries
    set
      sent_status = p_status,
      sent_at_utc = case when p_status = 'sent' then now() else sent_at_utc end,
      summary_text = coalesce(p_summary_text, summary_text),
      stats = coalesce(p_stats, stats),
      updated_at = now()
    where date_key = p_period_key::date;
  end if;

  return jsonb_build_object('ok', true, 'status', p_status);
end;
$$;

create or replace view public.summary_dispatch_status as
select
  period_type,
  period_key,
  status,
  attempt_count,
  force_count,
  sent_at_utc,
  last_error,
  updated_at_utc
from public.summary_dispatches;
