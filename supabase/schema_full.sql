-- ============================================================================
-- 7-Eleven HR System — CONSOLIDATED / FULL SCHEMA (schema_full.sql)
-- ============================================================================
-- This file is a SINGLE, IDEMPOTENT bootstrap that recreates a FRESH database
-- with the full, current shape of the system. It was produced by MERGING all
-- the scattered migration files under supabase/ (schema.sql + ~30 follow-up
-- migrations) into one ordered script.
--
-- HOW TO USE:
--   Supabase Dashboard > SQL Editor > New query > paste this whole file > Run.
--   Safe to re-run: everything uses "create table if not exists",
--   "create index if not exists", "create or replace function", and
--   "alter table ... add column if not exists ..." for late-added columns.
--   Objects are declared in dependency order (referenced tables/functions first).
--
-- WHAT THIS FILE IS NOT:
--   * It does NOT seed sample data (see seed.sql) and does NOT apply one-off
--     data fixes (clear_ot_two_0703.sql, rename_lakij.sql, fix_branch_radius.sql,
--     delete_sample_data.sql, recompute_ot.sql, etc.). Those are operational and
--     intentionally excluded.
--   * The dead hr_dashboard() RPC from functions.sql is intentionally OMITTED.
--
-- SECURITY / RLS:
--   RLS is enabled on every table but the policies are currently OPEN /
--   "trust-client": they allow anon + authenticated to do everything
--   (using(true) with check(true)). This matches policies.sql — the app is a
--   frontend-only design that talks to Supabase with the anon key and has no
--   per-user Auth yet. The ONE exception is app_config (HR password store),
--   which has NO policy at all and is only reachable via the SECURITY DEFINER
--   function hr_check_password().
--   To HARDEN this (real Auth + per-row rules) see supabase/rls_template.sql.
--
-- MERGED FROM: schema.sql, app_settings.sql, shift_codes.sql, handover_v3.sql,
--   shift_no_ot.sql, schedules.sql, schedules_multi.sql, shift_leads.sql,
--   handover.sql, task_system.sql, task_shift.sql, handover_v2.sql,
--   score_system.sql, discipline_rules.sql, leave_rules.sql, profile.sql,
--   rules_ack.sql, push_notifications.sql, push_branch.sql, special_tasks.sql,
--   announcements.sql, activity_log.sql, qa_expiry.sql, auto_checkout.sql,
--   checkout_cross_branch.sql, training_day.sql, branches_rls.sql, policies.sql,
--   storage_policies.sql, functions.sql, change_emp_id.sql,
--   fix_attendance_shift_late.sql (calc_late_min dependency only).
-- ============================================================================


-- ############################################################################
-- SECTION 1: BASE / REFERENCE TABLES (no FK dependencies)
-- ############################################################################

-- ===== TABLE: shifts (กะการทำงาน) =====
create table if not exists public.shifts (
  shift_id    text primary key,                 -- 'M','A','N','D'
  name        text not null,                    -- 'เช้า','บ่าย','ดึก'
  start_time  time not null,                    -- เวลาเข้ากะ (คำนวณสาย)
  end_time    time not null,                    -- เวลาออกกะ (คำนวณ OT)
  grace_min   int  not null default 5           -- ผ่อนผันก่อนนับสาย (นาที)
);
-- late-added columns:
alter table public.shifts add column if not exists code       text;                          -- โค้ดย่อกะสำหรับคีย์ตาราง (shift_codes.sql)
alter table public.shifts add column if not exists active     boolean not null default true;  -- (shift_codes.sql)
alter table public.shifts add column if not exists main_shift text;                          -- ผลัดหลักที่กะนี้สังกัด (handover_v3.sql)
alter table public.shifts add column if not exists no_ot      boolean not null default false; -- กะที่ไม่คิด OT (shift_no_ot.sql)
-- โค้ดกะห้ามซ้ำ (เทียบแบบไม่สนตัวพิมพ์)
create unique index if not exists uq_shifts_code on public.shifts (lower(code)) where code is not null;

-- ===== TABLE: branches (สาขา) =====
create table if not exists public.branches (
  branch_id   text primary key,
  name        text not null,
  lat         double precision not null,
  lng         double precision not null,
  radius_m    int not null default 80           -- รัศมี geofence (เมตร)
);

-- ===== TABLE: holidays (วันหยุดบริษัท) =====
create table if not exists public.holidays (
  date    date primary key,
  name    text not null,
  type    text,
  active  boolean not null default true
);

-- ===== TABLE: app_config (ตั้งค่าระบบ / รหัส HR — RLS locked) =====
create table if not exists public.app_config (
  key   text primary key,
  value text
);

-- ===== TABLE: app_settings (ค่าตั้งทั่วไป key/value — anon rw) =====
create table if not exists public.app_settings (
  key   text primary key,
  value text
);
insert into public.app_settings (key, value) values
  ('checkout_grace_min', '15'),          -- ผ่อนผันก่อนเตือน "ลืมกดออก" (app_settings.sql)
  ('checkout_autoclose_min', '60')       -- ปิดงานอัตโนมัติหลังเลิกกะ กี่นาที (auto_checkout.sql)
on conflict (key) do nothing;


-- ############################################################################
-- SECTION 2: EMPLOYEES (depends on shifts, branches)
-- ############################################################################

-- ===== TABLE: employees (พนักงาน) =====
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
-- late-added document link columns (profile.sql):
alter table public.employees add column if not exists idcard_url   text;   -- สำเนาบัตรประชาชน
alter table public.employees add column if not exists bankbook_url text;   -- หน้าสมุดบัญชี
alter table public.employees add column if not exists house_url    text;   -- ทะเบียนบ้าน
alter table public.employees add column if not exists edu_url      text;   -- วุฒิการศึกษา

create index if not exists idx_employees_branch on public.employees (branch_id);


-- ############################################################################
-- SECTION 3: ATTENDANCE & CORE HR (depend on employees / shifts / branches)
-- ############################################################################

-- ===== TABLE: attendance (การลงเวลา) =====
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
  status      text not null default 'OPEN',      -- OPEN / CLOSED / TRAINING
  created_at  timestamptz not null default now(),
  unique (emp_id, work_date)                     -- 1 คน 1 วัน 1 แถว
);
-- late-added columns:
alter table public.attendance add column if not exists auto_closed        boolean not null default false; -- ระบบปิดงานให้ (ลืมกดออก) → OT=0 (auto_checkout.sql)
alter table public.attendance add column if not exists extend_until       timestamptz;                    -- ประกาศ "ควบกะต่อ" ถึงเวลานี้ (auto_checkout.sql)
alter table public.attendance add column if not exists checkout_branch_id text;                           -- สาขาที่กดออกจริง (checkout_cross_branch.sql)
alter table public.attendance add column if not exists checkout_note      text;                           -- เหตุผลกดออกข้ามสาขา (checkout_cross_branch.sql)
alter table public.attendance add column if not exists duty_note          text;                           -- เหตุผล/หัวข้ออบรม (training_day.sql)

create index if not exists idx_attendance_work_date on public.attendance (work_date);
create index if not exists idx_attendance_emp_date  on public.attendance (emp_id, work_date);

-- ===== TABLE: warnings (ใบเตือน) =====
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
create index if not exists idx_warnings_emp on public.warnings (emp_id);

-- ===== TABLE: leaves (การลา) =====
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
-- late-added columns (leave_rules.sql):
alter table public.leaves add column if not exists hr_note text;   -- เหตุผลที่ HR ปฏิเสธ (พนักงานเห็น)
alter table public.leaves add column if not exists doc_url text;   -- ลิงก์เอกสารแนบ (ใบรับรองแพทย์ ฯลฯ)
create index if not exists idx_leaves_emp on public.leaves (emp_id);

-- ===== TABLE: leave_types (เงื่อนไขการลา) =====
create table if not exists public.leave_types (
  type            text primary key,               -- ชื่อประเภท เช่น ลาป่วย
  advance_days    int  not null default 0,         -- ต้องลาล่วงหน้าอย่างน้อยกี่วัน
  quota_per_year  int,                             -- โควตาวัน (null = ไม่จำกัด)
  allow_backdate  boolean not null default false,  -- ลาย้อนหลังได้
  require_doc     boolean not null default false,  -- ต้องแนบเอกสาร
  active          boolean not null default true,
  sort            int not null default 0
);
-- เผื่อรันบนตารางเดิม (leave_rules.sql):
alter table public.leave_types add column if not exists require_doc boolean not null default false;
insert into public.leave_types (type, advance_days, quota_per_year, allow_backdate, require_doc, sort) values
  ('ลาป่วย',              0, null, true,  true,  1),
  ('แจ้งขอหยุดฉุกเฉิน',   0, null, false, false, 2),
  ('แจ้งขอหยุด',          0, null, false, false, 4)
on conflict (type) do nothing;

-- ===== TABLE: schedules (ตารางเวร / Roster) =====
create table if not exists public.schedules (
  id          bigint generated always as identity primary key,
  emp_id      text not null references public.employees(emp_id) on delete cascade,
  work_date   date not null,
  shift_id    text references public.shifts(shift_id),
  branch_id   text references public.branches(branch_id),   -- สาขาที่ให้ไปทำวันนั้น
  is_cover    boolean not null default false,               -- true = ไปช่วย/แทนอีกสาขา
  note        text,
  created_at  timestamptz not null default now()
  -- NOTE: original unique(emp_id, work_date) was DROPPED by schedules_multi.sql
  --       to allow multiple shifts per day. See unique index below.
);
-- schedules_multi.sql: final uniqueness is (emp_id, work_date, shift_id)
alter table public.schedules drop constraint if exists schedules_emp_id_work_date_key;
create unique index if not exists schedules_emp_date_shift on public.schedules (emp_id, work_date, shift_id);
create index if not exists idx_schedules_date     on public.schedules (work_date);
create index if not exists idx_schedules_emp_date on public.schedules (emp_id, work_date);
create index if not exists idx_schedules_branch   on public.schedules (branch_id);

-- ===== TABLE: shift_leads (หัวหน้าผลัด/คนคุมกะ) =====
create table if not exists public.shift_leads (
  work_date   date not null,
  branch_id   text references public.branches(branch_id),
  shift_id    text references public.shifts(shift_id),
  emp_id      text references public.employees(emp_id),
  emp_name    text,
  created_at  timestamptz not null default now(),
  unique (work_date, branch_id, shift_id)         -- onConflict target used by app
);
create index if not exists idx_shift_leads_lookup on public.shift_leads (work_date, branch_id, shift_id);

-- ===== TABLE: rule_acks (รับทราบ/ยอมรับระเบียบ) =====
create table if not exists public.rule_acks (
  id          bigint generated always as identity primary key,
  emp_id      text not null references public.employees(emp_id) on delete cascade,
  version     text not null,                      -- เวอร์ชันระเบียบ เช่น '2026-06-28'
  accepted_at timestamptz not null default now()
);
create index if not exists idx_ruleacks_emp on public.rule_acks (emp_id);

-- ===== TABLE: profile_submissions (ข้อมูลพนักงานส่งมา รอตรวจ) =====
create table if not exists public.profile_submissions (
  id              bigint generated always as identity primary key,
  emp_id          text references public.employees(emp_id) on delete cascade,
  name            text,
  nickname        text,
  phone           text,
  address         text,
  emergency_name  text,
  emergency_phone text,
  bank_name       text,
  bank_account    text,
  id_card         text,
  photo_url       text,
  idcard_url      text,
  bankbook_url    text,
  house_url       text,
  edu_url         text,
  status          text not null default 'pending',   -- pending / approved / rejected
  note            text,
  submitted_at    timestamptz not null default now()
);
create index if not exists idx_psub_status on public.profile_submissions (status);
create index if not exists idx_psub_emp    on public.profile_submissions (emp_id);


-- ############################################################################
-- SECTION 4: SHIFT HANDOVER & TASK SYSTEM
-- ############################################################################

-- ===== TABLE: handovers (ส่ง/รับผลัด) =====
create table if not exists public.handovers (
  id           bigint generated always as identity primary key,
  branch_id    text,
  shift_id     text,
  work_date    date not null,
  from_emp_id  text,
  from_name    text,
  to_emp_id    text,
  to_name      text,
  status       text not null default 'sent',      -- sent / received / rejected / no_handover
  checklist    jsonb,
  done_count   int,
  total_count  int,
  pending_work text,
  issues       text,
  photo_url    text,
  receiver_note text,
  created_at   timestamptz not null default now(),
  received_at  timestamptz
);
create index if not exists idx_handover_branch on public.handovers (branch_id);
create index if not exists idx_handover_date   on public.handovers (work_date desc);
create index if not exists idx_handover_status on public.handovers (status);

-- ===== TABLE: task_defs (นิยามรายการงานในกะ) =====
create table if not exists public.task_defs (
  id            bigint generated always as identity primary key,
  title         text not null,
  require_photo boolean not null default false,
  active        boolean not null default true,
  sort          int not null default 0
);
-- late-added columns:
alter table public.task_defs add column if not exists shift_id   text;                 -- กะที่ต้องทำงานนี้ (task_shift.sql)
alter table public.task_defs add column if not exists min_photos int not null default 0; -- รูปขั้นต่ำต่องาน (handover_v2.sql)
insert into public.task_defs (title, require_photo, sort)
select * from (values
  ('พื้น/ทางเดินสะอาด',        false, 10),
  ('เคาน์เตอร์/ชั้นวางสะอาด',  false, 20),
  ('ห้องน้ำสะอาด',             true,  30),
  ('เติมสินค้าหน้าชั้นเต็ม',    true,  40),
  ('เติมตู้แช่/เครื่องดื่ม',     false, 50),
  ('จัดเรียงหน้าร้าน',          true,  60),
  ('อุปกรณ์/รถเข็นเข้าที่',      false, 70),
  ('พื้นที่หลังร้านเรียบร้อย',   false, 80)
) as v(title,require_photo,sort)
where not exists (select 1 from public.task_defs);

-- ===== TABLE: task_assignments (งานที่มอบหมายรายบุคคล) =====
create table if not exists public.task_assignments (
  id            bigint generated always as identity primary key,
  work_date     date not null,
  emp_id        text not null,
  emp_name      text,
  branch_id     text,
  task_def_id   bigint,
  title         text not null,             -- snapshot ชื่องาน
  require_photo boolean not null default false,
  status        text not null default 'todo',   -- todo / submitted / approved / sent_back
  photo_url     text,
  emp_note      text,
  reviewer      text,
  review_note   text,
  submitted_at  timestamptz,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);
-- late-added columns:
alter table public.task_assignments add column if not exists shift_id        text;                   -- (task_shift.sql)
alter table public.task_assignments add column if not exists photos          jsonb;                  -- หลายรูป (handover_v2.sql)
alter table public.task_assignments add column if not exists sent_back_count int not null default 0; -- (handover_v2.sql)
create index if not exists idx_task_emp_date on public.task_assignments (emp_id, work_date);
create index if not exists idx_task_branch   on public.task_assignments (branch_id, work_date);
create index if not exists idx_task_status   on public.task_assignments (status);

-- ===== TABLE: special_tasks (งานพิเศษจาก HR) =====
create table if not exists public.special_tasks (
  id          bigint generated always as identity primary key,
  title       text not null,
  detail      text,
  deadline    timestamptz,
  hr_photos   jsonb  not null default '[]',
  hr_note     text,
  created_by  text,
  created_at  timestamptz not null default now(),
  active      boolean not null default true
);

-- ===== TABLE: special_task_assignees (ผู้รับผิดชอบงานพิเศษ) =====
create table if not exists public.special_task_assignees (
  id            bigint generated always as identity primary key,
  task_id       bigint not null references public.special_tasks(id) on delete cascade,
  emp_id        text not null,
  branch_id     text,
  status        text not null default 'todo',       -- todo | submitted | approved | sent_back
  photos        jsonb  not null default '[]',
  emp_note      text,
  submitted_at  timestamptz,
  reviewer      text,
  review_note   text,
  reviewed_at   timestamptz,
  assigned_notified boolean not null default false,
  deadline_notified boolean not null default false,
  submit_notified   boolean not null default false,
  unique (task_id, emp_id)
);
create index if not exists idx_sta_emp  on public.special_task_assignees (emp_id, status);
create index if not exists idx_sta_task on public.special_task_assignees (task_id);


-- ############################################################################
-- SECTION 5: DISCIPLINE / SCORE / RULES
-- ############################################################################

-- ===== TABLE: discipline_rules (เกณฑ์ใบเตือน/วินัย) =====
create table if not exists public.discipline_rules (
  level       int  primary key,     -- 1..4 (มาก = รุนแรงสุด)
  level_name  text not null,
  level_color text not null,
  late_min    int,                  -- มาสายกี่ "ครั้ง" ขึ้นไป
  absent_min  int,                  -- ขาดงานกี่ "วัน" ขึ้นไป
  enabled     boolean not null default true
);
insert into public.discipline_rules (level, level_name, level_color, late_min, absent_min, enabled) values
  (1, 'ตักเตือนด้วยวาจา',        '#ca8a04', 3,  null, true),
  (2, 'ตักเตือนลายลักษณ์อักษร', '#d97706', 5,  1,    true),
  (3, 'ใบเตือนระดับ 1',          '#ea580c', 7,  2,    true),
  (4, 'ใบเตือนระดับ 2',          '#b91c1c', 10, 3,    true)
on conflict (level) do nothing;

-- ===== TABLE: score_config (คะแนนเริ่มเดือน — แถวเดียว id=1) =====
create table if not exists public.score_config (
  id          int  primary key default 1,
  start_score int  not null default 100
);
insert into public.score_config (id, start_score) values (1, 100)
on conflict (id) do nothing;

-- ===== TABLE: score_rules (กฎการตัดคะแนน) =====
create table if not exists public.score_rules (
  rule_key   text primary key,
  label      text not null,
  kind       text not null,            -- auto_late_1_10 / auto_late_11_30 / auto_late_30plus / auto_absent_no_notify / manual
  points     int  not null,            -- ค่าลบ
  range_min  int,
  enabled    boolean not null default true,
  sort       int not null default 0
);
insert into public.score_rules (rule_key, label, kind, points, range_min, enabled, sort) values
  ('late_1_10',        'มาสาย 1–10 นาที',                              'auto_late_1_10',       -3,  null, true, 10),
  ('late_11_30',       'มาสาย 11–30 นาที',                             'auto_late_11_30',      -5,  null, true, 20),
  ('late_30plus',      'มาสายเกิน 30 นาที',                            'auto_late_30plus',     -10, null, true, 30),
  ('absent_no_notify', 'ไม่มาและไม่แจ้ง',                              'auto_absent_no_notify',-30, null, true, 40),
  ('absent_notify_lt2h','ไม่มาโดยแจ้งกะทันหันน้อยกว่า 2 ชม.',          'manual',               -15, null, true, 50),
  ('no_handover',      'ไม่ส่งมอบผลัด',                                'manual',               -10, null, true, 60),
  ('shirk_work',       'เกี่ยงงาน/ไม่ทำงานที่มอบหมาย',                 'manual',               -10, -20,  true, 70),
  ('conflict',         'ทะเลาะกับเพื่อนร่วมงาน/พูดจาไม่เหมาะสม',       'manual',               -15, null, true, 80)
on conflict (rule_key) do nothing;

-- ===== TABLE: score_bands (แถบผลลัพธ์ปลายเดือน) =====
create table if not exists public.score_bands (
  id            bigint generated always as identity primary key,
  min_score     int not null,
  max_score     int not null,
  label         text not null,
  bonus_amount  int,
  warn_level    int,
  warn_name     text,
  color         text not null default '#475569',
  sort          int not null default 0
);
insert into public.score_bands (min_score, max_score, label, bonus_amount, warn_level, warn_name, color, sort)
select * from (values
  (90, 100, 'ได้โบนัสวินัย / สิทธิเลือกกะก่อน',              1500, null, null,                 '#16a34a', 10),
  (80, 89,  'ปกติ',                                          500,  null, null,                 '#0ea5e9', 20),
  (70, 79,  'คุยปรับพฤติกรรม',                               0,    null, null,                 '#ca8a04', 30),
  (60, 69,  'ใบเตือนครั้งที่ 1',                              0,    3,    'ใบเตือนครั้งที่ 1',  '#ea580c', 40),
  (0,  59,  'ใบเตือนครั้งที่ 2 / พิจารณาตามขั้นตอน',          0,    4,    'ใบเตือนครั้งที่ 2',  '#b91c1c', 50)
) as v(min_score,max_score,label,bonus_amount,warn_level,warn_name,color,sort)
where not exists (select 1 from public.score_bands);

-- ===== TABLE: score_events (เหตุการณ์ตัดคะแนนที่ HR เพิ่มเอง) =====
create table if not exists public.score_events (
  id          bigint generated always as identity primary key,
  emp_id      text not null,
  event_date  date not null,
  rule_key    text,
  label       text,
  points      int not null,
  note        text,
  created_by  text default 'HR',
  created_at  timestamptz not null default now()
);
create index if not exists idx_score_events_emp  on public.score_events (emp_id);
create index if not exists idx_score_events_date on public.score_events (event_date);


-- ############################################################################
-- SECTION 6: QA / EXPIRY TRACKING
-- ############################################################################

-- ===== TABLE: qa_folders (โฟลเดอร์ตรวจสินค้าใกล้หมดอายุ) =====
create table if not exists public.qa_folders (
  id           bigint generated always as identity primary key,
  title        text not null,
  target_month text,                             -- 'YYYY-MM'
  note         text,
  created_by   text,
  created_at   timestamptz not null default now(),
  active       boolean not null default true
);

-- ===== TABLE: qa_folder_assignees (ผู้รับผิดชอบโฟลเดอร์) =====
create table if not exists public.qa_folder_assignees (
  id                bigint generated always as identity primary key,
  folder_id         bigint not null references public.qa_folders(id) on delete cascade,
  emp_id            text not null,
  branch_id         text,
  assigned_notified boolean not null default false,
  unique (folder_id, emp_id)
);
create index if not exists idx_qa_fa_emp on public.qa_folder_assignees (emp_id);

-- ===== TABLE: qa_items (สินค้าที่บันทึกในโฟลเดอร์) =====
create table if not exists public.qa_items (
  id           bigint generated always as identity primary key,
  folder_id    bigint not null references public.qa_folders(id) on delete cascade,
  barcode      text,
  name         text not null,
  size         text,
  qty          int not null default 1,
  expiry_date  date not null,
  zone         text,
  photos       jsonb  not null default '[]',
  status       text   not null default 'on_shelf',  -- on_shelf | sold | removed
  branch_id    text,
  emp_id       text,
  emp_name     text,
  notified_30  boolean not null default false,
  notified_14  boolean not null default false,
  notified_7   boolean not null default false,
  notified_3   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_qa_items_folder on public.qa_items (folder_id);
create index if not exists idx_qa_items_expiry on public.qa_items (expiry_date, status);

-- ===== TABLE: qa_products (จำสินค้า: barcode -> ชื่อ/ขนาด) =====
create table if not exists public.qa_products (
  barcode    text primary key,
  name       text not null,
  size       text,
  updated_at timestamptz not null default now()
);


-- ############################################################################
-- SECTION 7: CHECKOUT CORRECTIONS / NOTIFICATIONS / ANNOUNCE / AUDIT
-- ############################################################################

-- ===== TABLE: checkout_corrections (คำขอแก้ไขเวลาออก) =====
create table if not exists public.checkout_corrections (
  id             bigint generated always as identity primary key,
  emp_id         text not null,
  emp_name       text,
  work_date      date not null,
  branch_id      text,
  shift_id       text,
  system_checkout  timestamptz,
  actual_checkout  timestamptz not null,
  reason         text,
  status         text not null default 'pending',   -- pending | approved | rejected
  reviewer       text,
  review_note    text,
  reviewed_at    timestamptz,
  notified       boolean not null default false,
  created_at     timestamptz not null default now()
);
create index if not exists idx_cocorr_status on public.checkout_corrections (status);
create index if not exists idx_cocorr_emp    on public.checkout_corrections (emp_id, work_date);

-- ===== TABLE: push_subscriptions (Web Push devices) =====
create table if not exists public.push_subscriptions (
  id         bigint generated always as identity primary key,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  label      text,
  created_at timestamptz not null default now()
);
-- late-added columns:
alter table public.push_subscriptions add column if not exists branch_id text;   -- แยกแจ้งเตือนตามสาขา (push_branch.sql)
alter table public.push_subscriptions add column if not exists emp_id    text;    -- เครื่องพนักงาน (special_tasks.sql)
create index if not exists idx_push_subs_emp on public.push_subscriptions (emp_id);

-- ===== TABLE: notify_sent (ledger กันส่งซ้ำ) =====
create table if not exists public.notify_sent (
  event_key  text primary key,
  sent_at    timestamptz not null default now()
);
create index if not exists idx_notify_sent_at on public.notify_sent (sent_at);

-- ===== TABLE: announcements (ประกาศจาก HR) =====
create table if not exists public.announcements (
  id          bigint generated always as identity primary key,
  message     text not null,
  level       text not null default 'info',      -- info / warn / urgent
  created_by  text default 'HR',
  created_at  timestamptz not null default now(),
  active      boolean not null default true,
  expire_date date
);
create index if not exists idx_announce_active on public.announcements (active, expire_date);

-- ===== TABLE: activity_log (audit log) =====
create table if not exists public.activity_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  actor   text,
  action  text not null,
  emp_id  text,
  detail  text
);
create index if not exists idx_activity_at on public.activity_log (at desc);


-- ############################################################################
-- SECTION 8: TRIGGERS
-- ############################################################################

-- keep employees.updated_at fresh
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


-- ############################################################################
-- SECTION 9: RPC FUNCTIONS (used by the app)
-- ############################################################################

-- ----- hr_check_password: verify HR password without exposing it -----
-- app_config is RLS-locked from anon; this SECURITY DEFINER fn is the only path.
create or replace function public.hr_check_password(p_password text)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_config
    where key = 'hr_password' and value = p_password
  );
$$;

-- ----- calc_late_min: minutes late vs shift start + grace (Asia/Bangkok) -----
create or replace function public.calc_late_min(p_shift_id text, p_check_in timestamptz)
returns int
language plpgsql stable
as $$
declare
  v_start time;
  v_grace int;
  v_late  int;
begin
  select start_time, grace_min into v_start, v_grace
  from public.shifts where shift_id = p_shift_id;
  if v_start is null then return 0; end if;

  v_late := extract(epoch from (
    (p_check_in at time zone 'Asia/Bangkok')::time - v_start
  )) / 60;

  v_late := v_late - coalesce(v_grace, 0);
  if v_late < 0 then v_late := 0; end if;
  return v_late;
end;
$$;

-- ----- change_emp_id: safely re-key an employee across all referencing tables -----
create or replace function public.change_emp_id(p_old text, p_new text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  p_new := trim(coalesce(p_new, ''));
  p_old := trim(coalesce(p_old, ''));
  if p_new = '' then return json_build_object('ok', false, 'error', 'กรุณากรอกรหัสใหม่'); end if;
  if p_old = p_new then return json_build_object('ok', false, 'error', 'รหัสเดิมกับรหัสใหม่เหมือนกัน'); end if;
  if not exists (select 1 from public.employees where emp_id = p_old) then
    return json_build_object('ok', false, 'error', 'ไม่พบรหัสพนักงานเดิม'); end if;
  if exists (select 1 from public.employees where emp_id = p_new) then
    return json_build_object('ok', false, 'error', 'รหัส ' || p_new || ' มีพนักงานใช้อยู่แล้ว'); end if;

  -- 1) copy the employee row under the new id (all columns)
  insert into public.employees
    (emp_id, name, nickname, start_date, default_shift, branch_id, weekly_off, phone, line_user_id, address,
     emergency_name, emergency_phone, bank_name, bank_account, id_card, photo_url, face_descriptor, active,
     created_at, updated_at, idcard_url, bankbook_url, house_url, edu_url)
  select p_new, name, nickname, start_date, default_shift, branch_id, weekly_off, phone, line_user_id, address,
     emergency_name, emergency_phone, bank_name, bank_account, id_card, photo_url, face_descriptor, active,
     created_at, now(), idcard_url, bankbook_url, house_url, edu_url
  from public.employees where emp_id = p_old;

  -- 2) repoint every referencing table old -> new (only if the table exists)
  if to_regclass('public.attendance')          is not null then update public.attendance          set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.schedules')           is not null then update public.schedules           set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.leaves')              is not null then update public.leaves              set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.warnings')            is not null then update public.warnings            set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.profile_submissions') is not null then update public.profile_submissions set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.rule_acks')           is not null then update public.rule_acks           set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.shift_leads')         is not null then update public.shift_leads         set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.activity_log')        is not null then update public.activity_log        set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.score_events')        is not null then update public.score_events        set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.task_assignments')    is not null then update public.task_assignments    set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.handovers')           is not null then
    update public.handovers set from_emp_id = p_new where from_emp_id = p_old;
    update public.handovers set to_emp_id   = p_new where to_emp_id   = p_old;
  end if;

  -- 3) delete the old employee row (nothing references it anymore)
  delete from public.employees where emp_id = p_old;

  return json_build_object('ok', true, 'old_id', p_old, 'new_id', p_new);
exception when others then
  return json_build_object('ok', false, 'error', SQLERRM);
end
$$;

grant execute on function public.change_emp_id(text, text) to anon, authenticated;


-- ############################################################################
-- SECTION 10: ROW LEVEL SECURITY (OPEN / trust-client — see rls_template.sql)
-- ############################################################################
-- Every table below has RLS ENABLED. All policies allow anon+authenticated full
-- access (using(true) with check(true)) EXCEPT app_config, which has NO policy
-- (locked) and is only read via hr_check_password(). This mirrors policies.sql.

-- Enable RLS on all tables
alter table public.shifts                  enable row level security;
alter table public.branches                enable row level security;
alter table public.holidays                enable row level security;
alter table public.app_config              enable row level security;
alter table public.app_settings            enable row level security;
alter table public.employees               enable row level security;
alter table public.attendance              enable row level security;
alter table public.warnings                enable row level security;
alter table public.leaves                  enable row level security;
alter table public.leave_types             enable row level security;
alter table public.schedules               enable row level security;
alter table public.shift_leads             enable row level security;
alter table public.rule_acks               enable row level security;
alter table public.profile_submissions     enable row level security;
alter table public.handovers               enable row level security;
alter table public.task_defs               enable row level security;
alter table public.task_assignments        enable row level security;
alter table public.special_tasks           enable row level security;
alter table public.special_task_assignees  enable row level security;
alter table public.discipline_rules        enable row level security;
alter table public.score_config            enable row level security;
alter table public.score_rules             enable row level security;
alter table public.score_bands             enable row level security;
alter table public.score_events            enable row level security;
alter table public.qa_folders              enable row level security;
alter table public.qa_folder_assignees     enable row level security;
alter table public.qa_items                enable row level security;
alter table public.qa_products             enable row level security;
alter table public.checkout_corrections    enable row level security;
alter table public.push_subscriptions      enable row level security;
alter table public.notify_sent             enable row level security;
alter table public.announcements           enable row level security;
alter table public.activity_log            enable row level security;

-- Reference data: shifts & branches are read+write from the HR page (per
-- shift_codes.sql / branches_rls.sql, which superseded the read-only policies).
drop policy if exists anon_read_shifts   on public.shifts;
drop policy if exists anon_rw_shifts     on public.shifts;
create policy anon_rw_shifts on public.shifts for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_read_branches on public.branches;
drop policy if exists anon_rw_branches   on public.branches;
create policy anon_rw_branches on public.branches for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_rw_holidays on public.holidays;
create policy anon_rw_holidays on public.holidays for all to anon, authenticated using (true) with check (true);

-- app_config: intentionally NO policy (locked). Access only via hr_check_password().

drop policy if exists app_settings_all on public.app_settings;
create policy app_settings_all on public.app_settings for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_rw_employees on public.employees;
create policy anon_rw_employees on public.employees for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_rw_attendance on public.attendance;
create policy anon_rw_attendance on public.attendance for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_rw_warnings on public.warnings;
create policy anon_rw_warnings on public.warnings for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_rw_leaves on public.leaves;
create policy anon_rw_leaves on public.leaves for all to anon, authenticated using (true) with check (true);

drop policy if exists leave_types_all on public.leave_types;
create policy leave_types_all on public.leave_types for all to anon, authenticated using (true) with check (true);

drop policy if exists schedules_all on public.schedules;
create policy schedules_all on public.schedules for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_rw_shift_leads on public.shift_leads;
create policy anon_rw_shift_leads on public.shift_leads for all to anon, authenticated using (true) with check (true);

drop policy if exists rule_acks_all on public.rule_acks;
create policy rule_acks_all on public.rule_acks for all to anon, authenticated using (true) with check (true);

drop policy if exists psub_all on public.profile_submissions;
create policy psub_all on public.profile_submissions for all to anon, authenticated using (true) with check (true);

drop policy if exists handovers_all on public.handovers;
create policy handovers_all on public.handovers for all to anon, authenticated using (true) with check (true);

drop policy if exists task_defs_all on public.task_defs;
create policy task_defs_all on public.task_defs for all to anon, authenticated using (true) with check (true);

drop policy if exists task_assign_all on public.task_assignments;
create policy task_assign_all on public.task_assignments for all to anon, authenticated using (true) with check (true);

drop policy if exists special_tasks_all on public.special_tasks;
create policy special_tasks_all on public.special_tasks for all to anon, authenticated using (true) with check (true);

drop policy if exists special_task_assignees_all on public.special_task_assignees;
create policy special_task_assignees_all on public.special_task_assignees for all to anon, authenticated using (true) with check (true);

drop policy if exists discipline_rules_all on public.discipline_rules;
create policy discipline_rules_all on public.discipline_rules for all to anon, authenticated using (true) with check (true);

drop policy if exists score_config_all on public.score_config;
create policy score_config_all on public.score_config for all to anon, authenticated using (true) with check (true);

drop policy if exists score_rules_all on public.score_rules;
create policy score_rules_all on public.score_rules for all to anon, authenticated using (true) with check (true);

drop policy if exists score_bands_all on public.score_bands;
create policy score_bands_all on public.score_bands for all to anon, authenticated using (true) with check (true);

drop policy if exists score_events_all on public.score_events;
create policy score_events_all on public.score_events for all to anon, authenticated using (true) with check (true);

drop policy if exists qa_folders_all on public.qa_folders;
create policy qa_folders_all on public.qa_folders for all to anon, authenticated using (true) with check (true);

drop policy if exists qa_folder_assignees_all on public.qa_folder_assignees;
create policy qa_folder_assignees_all on public.qa_folder_assignees for all to anon, authenticated using (true) with check (true);

drop policy if exists qa_items_all on public.qa_items;
create policy qa_items_all on public.qa_items for all to anon, authenticated using (true) with check (true);

drop policy if exists qa_products_all on public.qa_products;
create policy qa_products_all on public.qa_products for all to anon, authenticated using (true) with check (true);

drop policy if exists checkout_corrections_all on public.checkout_corrections;
create policy checkout_corrections_all on public.checkout_corrections for all to anon, authenticated using (true) with check (true);

drop policy if exists push_subs_all on public.push_subscriptions;
create policy push_subs_all on public.push_subscriptions for all to anon, authenticated using (true) with check (true);

drop policy if exists notify_sent_all on public.notify_sent;
create policy notify_sent_all on public.notify_sent for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_rw_announcements on public.announcements;
create policy anon_rw_announcements on public.announcements for all to anon, authenticated using (true) with check (true);

drop policy if exists activity_log_all on public.activity_log;
create policy activity_log_all on public.activity_log for all to anon, authenticated using (true) with check (true);


-- ############################################################################
-- SECTION 11: STORAGE (buckets + open policies — see storage_policies.sql / profile.sql)
-- ############################################################################
-- Buckets attendance-photos & employee-photos are normally created in the
-- Supabase dashboard; created here for a fresh-DB bootstrap. employee-docs is
-- created by profile.sql.
insert into storage.buckets (id, name, public) values
  ('attendance-photos', 'attendance-photos', true),
  ('employee-photos',   'employee-photos',   true),
  ('employee-docs',     'employee-docs',     true)
on conflict (id) do nothing;

-- attendance-photos
drop policy if exists "anon_insert_attendance_photos" on storage.objects;
create policy "anon_insert_attendance_photos" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'attendance-photos');
drop policy if exists "anon_update_attendance_photos" on storage.objects;
create policy "anon_update_attendance_photos" on storage.objects
  for update to anon, authenticated using (bucket_id = 'attendance-photos') with check (bucket_id = 'attendance-photos');
drop policy if exists "anon_read_attendance_photos" on storage.objects;
create policy "anon_read_attendance_photos" on storage.objects
  for select to anon, authenticated using (bucket_id = 'attendance-photos');

-- employee-photos
drop policy if exists "anon_insert_employee_photos" on storage.objects;
create policy "anon_insert_employee_photos" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'employee-photos');
drop policy if exists "anon_update_employee_photos" on storage.objects;
create policy "anon_update_employee_photos" on storage.objects
  for update to anon, authenticated using (bucket_id = 'employee-photos') with check (bucket_id = 'employee-photos');
drop policy if exists "anon_read_employee_photos" on storage.objects;
create policy "anon_read_employee_photos" on storage.objects
  for select to anon, authenticated using (bucket_id = 'employee-photos');

-- employee-docs (profile.sql)
drop policy if exists "employee_docs_rw" on storage.objects;
create policy "employee_docs_rw" on storage.objects
  for all to anon, authenticated
  using (bucket_id = 'employee-docs') with check (bucket_id = 'employee-docs');

-- ============================================================================
-- END OF CONSOLIDATED SCHEMA
-- Next steps: run seed.sql for sample data, and set app_config 'hr_password'
-- (insert into public.app_config(key,value) values('hr_password','...')).
-- ============================================================================
