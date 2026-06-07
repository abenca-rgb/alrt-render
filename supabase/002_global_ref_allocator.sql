alter table public.alerts drop constraint if exists alerts_ref_id_key;

create index if not exists alerts_ref_id_idx on public.alerts(ref_id);

create table if not exists public.ref_counters (
  name text primary key,
  current_value bigint not null,
  updated_at timestamptz not null default now()
);

insert into public.ref_counters (name, current_value)
values ('global_alert_ref', 100274)
on conflict (name) do update
set
  current_value = greatest(public.ref_counters.current_value, excluded.current_value),
  updated_at = now();

create or replace function public.next_alert_ref(floor_value bigint default 100127)
returns bigint
language plpgsql
security definer
as $$
declare
  allocated bigint;
begin
  insert into public.ref_counters (name, current_value)
  values ('global_alert_ref', greatest(floor_value, 100127))
  on conflict (name) do update
  set
    current_value = greatest(public.ref_counters.current_value, excluded.current_value),
    updated_at = now();

  update public.ref_counters
  set
    current_value = greatest(current_value, floor_value, 100127) + 1,
    updated_at = now()
  where name = 'global_alert_ref'
  returning current_value into allocated;

  return allocated;
end;
$$;
