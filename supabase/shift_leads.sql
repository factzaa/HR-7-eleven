-- ============================================================
-- 7-Eleven HR System — ตาราง shift_leads (หัวหน้าผลัด/คนคุมกะ)
-- แก้บั๊ก: โค้ดใน shared/supabase.js + hr-api.js เรียกตารางนี้ 7 จุด
-- (leaderLogin, leaderInfo, leaderConfirm, getShiftBoard, getPrevShiftReview...)
-- แต่ก่อนหน้านี้ไม่มี CREATE TABLE + ไม่มี RLS policy เลย
-- => ระบบหัวหน้าผลัด / ส่ง-รับผลัด / ตรวจงานกะก่อน จะใช้ไม่ได้จนกว่าจะรันไฟล์นี้
-- รันใน Supabase: SQL Editor > New query > วาง > Run  (ปลอดภัยที่จะรันซ้ำ)
-- ============================================================

create table if not exists public.shift_leads (
  work_date   date not null,
  branch_id   text references public.branches(branch_id),
  shift_id    text references public.shifts(shift_id),
  emp_id      text references public.employees(emp_id),
  emp_name    text,
  created_at  timestamptz not null default now(),
  -- onConflict: 'work_date,branch_id,shift_id' ในโค้ดต้องมี unique constraint ชุดนี้
  unique (work_date, branch_id, shift_id)
);

create index if not exists idx_shift_leads_lookup
  on public.shift_leads (work_date, branch_id, shift_id);

-- ---------- RLS ----------
alter table public.shift_leads enable row level security;

drop policy if exists anon_rw_shift_leads on public.shift_leads;
create policy anon_rw_shift_leads on public.shift_leads
  for all to anon, authenticated
  using (true) with check (true);

-- ============================================================
-- เสร็จแล้ว: ฟีเจอร์หัวหน้าผลัด/ส่ง-รับผลัดจะทำงานได้
-- ============================================================
