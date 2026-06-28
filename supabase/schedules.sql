-- ============================================================
-- 7-Eleven HR System — ตารางเวร (Roster / Schedules)
-- รันบน Supabase: Dashboard > SQL Editor > New query > Run
-- ปลอดภัยที่จะรันซ้ำ (if not exists / on conflict)
-- ============================================================

-- ---------- ตารางเวร: 1 คน 1 วัน 1 แถว ----------
create table if not exists public.schedules (
  id          bigint generated always as identity primary key,
  emp_id      text not null references public.employees(emp_id) on delete cascade,
  work_date   date not null,
  shift_id    text references public.shifts(shift_id),
  branch_id   text references public.branches(branch_id),   -- สาขาที่ให้ไปทำวันนั้น (ต่างจากสาขาประจำ = ไปแทน)
  is_cover    boolean not null default false,               -- true = ไปช่วย/แทนอีกสาขา
  note        text,                                         -- เหตุผล เช่น "แทนสมชายลาป่วย"
  created_at  timestamptz not null default now(),
  unique (emp_id, work_date)
);

create index if not exists idx_schedules_date      on public.schedules (work_date);
create index if not exists idx_schedules_emp_date  on public.schedules (emp_id, work_date);
create index if not exists idx_schedules_branch    on public.schedules (branch_id);

-- ---------- เปิด RLS + อนุญาตชั่วคราว (ให้เข้ากับนโยบายเดิมที่เปิดกว้างไว้ก่อน) ----------
-- หมายเหตุ: Phase 4 ค่อยรัดกุม RLS ทั้งระบบพร้อมกัน
alter table public.schedules enable row level security;

drop policy if exists "schedules_all" on public.schedules;
create policy "schedules_all" on public.schedules
  for all using (true) with check (true);

-- ============================================================
-- ตัวอย่างตารางเวร (สัปดาห์ทดสอบ) — แก้/ลบได้
-- 003 ปกติอยู่ B002 แต่ถูกจัดไปแทนที่ B001 วันที่ 27 (is_cover = true)
-- ============================================================
insert into public.schedules (emp_id, work_date, shift_id, branch_id, is_cover, note) values
  ('001', current_date, 'M', 'B001', false, null),
  ('002', current_date, 'A', 'B001', false, null),
  ('003', current_date, 'N', 'B001', true,  'ไปแทนที่สาขาสยามสแควร์ (คนขาด)')
on conflict (emp_id, work_date) do update
  set shift_id = excluded.shift_id, branch_id = excluded.branch_id,
      is_cover = excluded.is_cover, note = excluded.note;

-- ============================================================
-- เสร็จแล้ว
-- ============================================================
