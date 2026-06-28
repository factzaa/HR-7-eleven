-- ============================================================
-- 7-Eleven HR — บันทึกการรับทราบ/ยอมรับระเบียบการทำงาน
-- รันบน Supabase: SQL Editor > วาง > Run (รันซ้ำได้)
-- ============================================================

create table if not exists public.rule_acks (
  id          bigint generated always as identity primary key,
  emp_id      text not null references public.employees(emp_id) on delete cascade,
  version     text not null,                 -- เวอร์ชันระเบียบที่ยอมรับ เช่น '2026-06-28'
  accepted_at timestamptz not null default now()
);
create index if not exists idx_ruleacks_emp on public.rule_acks (emp_id);

alter table public.rule_acks enable row level security;
drop policy if exists rule_acks_all on public.rule_acks;
create policy rule_acks_all on public.rule_acks
  for all to anon, authenticated using (true) with check (true);

select 'rules_ack.sql done' as result;
