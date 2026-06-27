-- ============================================================
-- 7-Eleven HR System — Supabase Schema
-- รันไฟล์นี้ใน Supabase: Dashboard > SQL Editor > New query > Run
-- ปลอดภัยที่จะรันซ้ำ (ใช้ if not exists / drop trigger ก่อนสร้าง)
-- ============================================================

-- ---------- กะการทำงาน ----------
create table if not exists public.shifts (
  shift_id    text primary key,                 -- 'M','A','N'
  name        text not null,                    -- 'เช้า','บ่าย','ดึก'
  start_time  time not null,                    -- เวลาเข้ากะ (คำนวณสาย)
  end_time    time not null,                    -- เวลาออกกะ (คำนวณ OT)
  grace_min   int  not null default 5           -- ผ่อนผันก่อนนับสาย (นาที)
);

-- ---------- สาขา ----------
create table if not exists public.branches (
  branch_id   text primary key,
  name        text not null,
  lat         double precision not null,
  lng         double precision not null,
  radius_m    int not null default 80           -- รัศมี geofence (เมตร)
);

-- ---------- พนักงาน ----------
create table if not exists public.employees (
  emp_id          text primary key,
  name            text not null,
  nickname        text,
  start_date      date,
  default_shift   text references public.shifts(shift_id),
  branch_id       text references public.branches(branch_id),
  weekly_off      text,                          -- 'Sun' หรือ 'Sat,Sun'
  phone           text,
  line_user_id    text,
  address         text,
  emergency_name  text,
  emergency_phone text,
  -- ข้อมูลอ่อนไหว (PDPA) — ควรจำกัดสิทธิ์เข้าถึง
  bank_name       text,
  bank_account    text,
  id_card         text,
  -- รูป + ใบหน้า
  photo_url       text,                          -- ชี้ไป Storage bucket employee-photos
  face_descriptor jsonb,                         -- เวกเตอร์ใบหน้า 128 มิติ
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------- การลงเวลา ----------
create table if not exists public.attendance (
  id          bigint generated always as identity primary key,
  emp_id      text not null references public.employees(emp_id),
  work_date   date not null,
  shift_id    text references public.shifts(shift_id),
  branch_id   text references public.branches(branch_id),
  check_in    timestamptz,
  check_out   timestamptz,
  late_min    int not null default 0,
  ot_hours    numeric(4,2) not null default 0,
  photo_url   text,                              -- รูปตอนเช็กอิน (หลักฐาน)
  gps_lat     double precision,
  gps_lng     double precision,
  gps_accuracy double precision,
  face_match  boolean,                           -- ผลเทียบใบหน้า (null = ไม่ได้เทียบ)
  status      text not null default 'OPEN',      -- OPEN / CLOSED
  created_at  timestamptz not null default now(),
  unique (emp_id, work_date)                     -- 1 คน 1 วัน 1 แถว
);

-- ---------- ใบเตือน ----------
create table if not exists public.warnings (
  warning_id   text primary key,                 -- 'W-2026-0001'
  emp_id       text not null references public.employees(emp_id),
  issue_date   date not null default current_date,
  level        int,
  level_name   text,
  cycle_start  date,
  cycle_end    date,
  late_count   int,
  late_total   int,
  absent_count int,
  reason       text,
  issued_by    text default 'HR',
  created_at   timestamptz not null default now()
);

-- ---------- การลา ----------
create table if not exists public.leaves (
  leave_id    bigint generated always as identity primary key,
  emp_id      text not null references public.employees(emp_id),
  start_date  date not null,
  end_date    date,
  type        text,                              -- ลากิจ/ลาป่วย/พักร้อน
  reason      text,
  status      text not null default 'approved',
  created_at  timestamptz not null default now()
);

-- ---------- วันหยุดบริษัท ----------
create table if not exists public.holidays (
  date    date primary key,
  name    text not null,
  type    text,
  active  boolean not null default true
);

-- ---------- ตั้งค่าระบบ (รหัส HR ฯลฯ) ----------
create table if not exists public.app_config (
  key   text primary key,
  value text
);

-- ============================================================
-- Index เพื่อให้รายงานเร็ว
-- ============================================================
create index if not exists idx_attendance_work_date  on public.attendance (work_date);
create index if not exists idx_attendance_emp_date    on public.attendance (emp_id, work_date);
create index if not exists idx_warnings_emp           on public.warnings (emp_id);
create index if not exists idx_leaves_emp             on public.leaves (emp_id);
create index if not exists idx_employees_branch       on public.employees (branch_id);

-- ============================================================
-- Trigger อัปเดต updated_at ของ employees อัตโนมัติ
-- ============================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists trg_employees_touch on public.employees;
create trigger trg_employees_touch
  before update on public.employees
  for each row execute function public.touch_updated_at();

-- ============================================================
-- เสร็จแล้ว — ต่อไปรัน seed.sql เพื่อใส่ข้อมูลตัวอย่าง
-- ============================================================
