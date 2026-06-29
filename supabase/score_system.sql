-- ============================================================
-- 7-Eleven HR — ระบบคะแนนวินัยรายเดือน (Discipline Points)
-- เริ่มทุกคนที่ 100 คะแนน/เดือน (รอบ 21–20) แล้วหักตามพฤติกรรม
-- ทุกค่าตั้งได้จากหน้า HR · รันบน Supabase: SQL Editor > วาง > Run
-- ============================================================

-- 1) ค่าตั้งต้น (คะแนนเริ่มเดือน) — แถวเดียว id=1
create table if not exists public.score_config (
  id          int  primary key default 1,
  start_score int  not null default 100
);
insert into public.score_config (id, start_score) values (1, 100)
on conflict (id) do nothing;

-- 2) กฎการตัดคะแนน (auto = ระบบหักเอง, manual = HR กดเพิ่ม)
--    kind: auto_late_1_10 / auto_late_11_30 / auto_late_30plus / auto_absent_no_notify / manual
create table if not exists public.score_rules (
  rule_key   text primary key,
  label      text not null,
  kind       text not null,           -- ดูคำอธิบายด้านบน
  points     int  not null,           -- คะแนนที่หัก (เป็นค่าลบ เช่น -3) · ถ้าเป็นช่วงคือค่าเริ่มต้น
  range_min  int,                     -- ช่วงคะแนน (ค่าลบมากสุด) สำหรับเหตุที่ตัดได้หลายระดับ เช่น เกี่ยงงาน -10..-20
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

-- 3) แถบผลลัพธ์ปลายเดือน (โบนัส + ระดับใบเตือนอัตโนมัติ)
create table if not exists public.score_bands (
  id            bigint generated always as identity primary key,
  min_score     int not null,
  max_score     int not null,
  label         text not null,        -- ผลที่ได้
  bonus_amount  int,                  -- โบนัสความรับผิดชอบ (บาท) · ว่าง/0 = ไม่มี
  warn_level    int,                  -- ระดับใบเตือนที่จะออกอัตโนมัติ (ว่าง = ไม่ออก)
  warn_name     text,                 -- ชื่อใบเตือน เช่น 'ใบเตือนครั้งที่ 1'
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

-- 4) เหตุการณ์ตัดคะแนนที่ HR เพิ่มเอง (auto ไม่ต้องเก็บ — คำนวณจาก attendance)
create table if not exists public.score_events (
  id          bigint generated always as identity primary key,
  emp_id      text not null,
  event_date  date not null,
  rule_key    text,                   -- อ้างถึง score_rules (อาจเป็น null ถ้าลบกฎทิ้ง)
  label       text,                   -- ป้ายชื่อเหตุ ณ เวลาบันทึก (กันกฎถูกแก้ภายหลัง)
  points      int not null,           -- คะแนนที่หักจริง (ค่าลบ)
  note        text,
  created_by  text default 'HR',
  created_at  timestamptz not null default now()
);
create index if not exists idx_score_events_emp  on public.score_events (emp_id);
create index if not exists idx_score_events_date on public.score_events (event_date);

-- RLS เปิดให้ anon (เหมือนตารางอื่นในระบบนี้)
alter table public.score_config enable row level security;
alter table public.score_rules  enable row level security;
alter table public.score_bands  enable row level security;
alter table public.score_events enable row level security;
drop policy if exists score_config_all on public.score_config;
drop policy if exists score_rules_all  on public.score_rules;
drop policy if exists score_bands_all  on public.score_bands;
drop policy if exists score_events_all on public.score_events;
create policy score_config_all on public.score_config for all to anon, authenticated using (true) with check (true);
create policy score_rules_all  on public.score_rules  for all to anon, authenticated using (true) with check (true);
create policy score_bands_all  on public.score_bands  for all to anon, authenticated using (true) with check (true);
create policy score_events_all on public.score_events for all to anon, authenticated using (true) with check (true);

select 'score_system.sql done' as result;
