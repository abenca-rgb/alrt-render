alter table public.summary_dispatches
  add column if not exists dispatch_scope text not null default 'default';

drop index if exists public.summary_dispatches_period_idx;

alter table public.summary_dispatches
  drop constraint if exists summary_dispatches_period_type_period_key_key;

create unique index if not exists summary_dispatches_unique_scope_idx
  on public.summary_dispatches(period_type, period_key, dispatch_scope);

create index if not exists summary_dispatches_period_scope_idx
  on public.summary_dispatches(period_type, period_key, dispatch_scope);

create or replace function public.claim_summary_dispatch(
  p_period_type text,
  p_period_key text,
  p_force boolean default false,
  p_dispatch_scope text default 'default'
)
returns jsonb
language plpgsql
security definer
as $$
declare
  row_data public.summary_dispatches%rowtype;
  final_scope text := coalesce(nullif(p_dispatch_scope, ''), 'default');
begin
  insert into public.summary_dispatches (period_type, period_key, dispatch_scope, status)
  values (p_period_type, p_period_key, final_scope, 'unsent')
  on conflict (period_type, period_key, dispatch_scope) do nothing;

  select *
  into row_data
  from public.summary_dispatches
  where period_type = p_period_type
    and period_key = p_period_key
    and dispatch_scope = final_scope
  for update;

  if row_data.status = 'sent' and not p_force then
    return jsonb_build_object(
      'claimed', false,
      'alreadySent', true,
      'status', row_data.status,
      'dispatchScope', row_data.dispatch_scope,
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
    and period_key = p_period_key
    and dispatch_scope = final_scope;

  return jsonb_build_object(
    'claimed', true,
    'alreadySent', false,
    'status', 'sending',
    'dispatchScope', final_scope
  );
end;
$$;

create or replace function public.complete_summary_dispatch(
  p_period_type text,
  p_period_key text,
  p_status text,
  p_summary_text text default null,
  p_stats jsonb default '{}'::jsonb,
  p_error text default null,
  p_dispatch_scope text default 'default'
)
returns jsonb
language plpgsql
security definer
as $$
declare
  final_scope text := coalesce(nullif(p_dispatch_scope, ''), 'default');
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
    and period_key = p_period_key
    and dispatch_scope = final_scope;

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

  return jsonb_build_object('ok', true, 'status', p_status, 'dispatchScope', final_scope);
end;
$$;

create or replace view public.summary_dispatch_status as
select
  period_type,
  period_key,
  dispatch_scope,
  status,
  attempt_count,
  force_count,
  sent_at_utc,
  last_error,
  updated_at_utc
from public.summary_dispatches;
