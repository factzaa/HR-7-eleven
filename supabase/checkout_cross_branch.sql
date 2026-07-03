-- ============================================================
-- กดออกงานข้ามสาขา (ฉุกเฉิน: เข้าสาขา A ออกสาขา B) — บันทึกสาขาที่กดออก + เหตุผล
-- รันบน Supabase: SQL Editor > วาง > Run (รันซ้ำได้)
-- ============================================================

alter table public.attendance add column if not exists checkout_branch_id text;  -- สาขาที่กดออกจริง (ถ้าต่างจากสาขาที่เข้างาน = ข้ามสาขา)
alter table public.attendance add column if not exists checkout_note      text;  -- เหตุผลการกดออกข้ามสาขา

select 'checkout_cross_branch.sql done' as result;
