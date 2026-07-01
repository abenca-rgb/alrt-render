alter table public.alert_candidates
  add column if not exists shadow_v21_score integer,
  add column if not exists shadow_v21_grade text,
  add column if not exists shadow_v21_decision text,
  add column if not exists shadow_v21_block_reason text,
  add column if not exists shadow_v21_scored_at_utc timestamptz;

create index if not exists alert_candidates_shadow_v21_grade_idx
  on public.alert_candidates(shadow_v21_grade);

create index if not exists alert_candidates_shadow_v21_decision_idx
  on public.alert_candidates(shadow_v21_decision);
