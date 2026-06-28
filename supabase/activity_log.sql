-- ============================================================
-- 7-Eleven HR — บันทึกกิจกรรม/ประวัติการดำเนินการ (audit log)
-- เก็บเหตุการณ์สำคัญ เช่น HR อนุมัติ/ปฏิเสธ ออก/แก้/ลบใบเตือน ฯลฯ
-- รันบน Supabase: SQL Editor > วาง > Run
-- ============================================================

create table if not exists public.activity_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  actor   text,            -- ผู้ทำรายการ เช่น 'HR' หรือ รหัสพนักงาน
  action  text not null,   -- ประเภทการกระทำ เช่น 'อนุมัติข้อมูล'
  emp_id  text,            -- พนักงานที่เกี่ยวข้อง (ถ้ามี)
  detail  text             -- รายละเอียดเพิ่มเติม
);
create index if not exists idx_activity_at on public.activity_log (at desc);

alter table public.activity_log enable row level security;
drop policy if exists activity_log_all on public.activity_log;
create policy activity_log_all on public.activity_log
  for all to anon, authenticated using (true) with check (true);

select 'activity_log.sql done' as result;
