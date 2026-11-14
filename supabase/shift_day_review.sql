-- ============================================================
-- 7-Eleven HR — ตรวจงานรายคนต่อวัน + คะแนนและคอมเมนต์จากส่วนกลาง
--   ใช้กับแท็บ "งานรายคน" ในหน้ารับส่งผลัด (ฝั่ง HR)
--   • ให้คะแนน + คอมเมนต์ได้ 2 ระดับ: ต่องาน (task_assignments) และสรุปรายคนต่อวัน (ตารางใหม่)
--   • คะแนนสรุปรายวันต่ำกว่าเกณฑ์ → หักคะแนนวินัยอัตโนมัติ (score_events)
--   • พนักงานต้องกดรับทราบคอมเมนต์ในแอปรับส่งผลัด
-- รันบน Supabase: SQL Editor > วาง > Run   (รันหลัง task_system.sql และ score_system.sql)
-- ============================================================

-- ---------- 1) คะแนน/คอมเมนต์ "ต่องาน" — เก็บไว้ที่แถวงานเดิม ----------
alter table public.task_assignments add column if not exists hq_score   int;          -- 1–5 (ว่าง = ยังไม่ให้คะแนน)
alter table public.task_assignments add column if not exists hq_comment text;         -- คอมเมนต์จากส่วนกลางถึงงานชิ้นนี้
alter table public.task_assignments add column if not exists hq_by      text;         -- ผู้ให้คะแนน
alter table public.task_assignments add column if not exists hq_at      timestamptz;  -- เวลาที่ให้คะแนน

create index if not exists idx_task_hq on public.task_assignments (work_date, emp_id) where hq_at is not null;


-- ---------- 2) คะแนน/คอมเมนต์ "สรุปรายคนต่อวัน" ----------
--   1 แถว = พนักงาน 1 คน · 1 วัน · 1 กะ  (ควบกะ = คนละแถว ให้คะแนนแยกกันได้)
create table if not exists public.shift_day_reviews (
  id            bigint generated always as identity primary key,
  work_date     date not null,
  emp_id        text not null,
  emp_name      text,
  branch_id     text,
  shift_id      text not null default '',

  score         int,                  -- คะแนนสรุปของวันนั้น 1–5
  comment       text,                 -- คอมเมนต์ถึงพนักงาน (พนักงานเห็น)

  -- สแนปช็อตตัวเลขตอนให้คะแนน — ไว้ย้อนดูว่าตัดสินจากอะไร (ข้อมูลจริงอาจถูกแก้ภายหลัง)
  tasks_total   int not null default 0,
  tasks_graded  int not null default 0,
  tasks_open    int not null default 0,
  tasks_back    int not null default 0,
  avg_task      numeric(3,2),         -- ค่าเฉลี่ยคะแนนต่องานที่ให้ไว้

  -- การหักคะแนนวินัย (ผูกกับ score_events)
  deduct        int not null default 0,   -- คะแนนวินัยที่หัก (เก็บเป็นเลขบวก 0 = ไม่หัก)
  score_event_id bigint,                  -- แถวใน score_events ที่สร้างให้ (ว่าง = ไม่ได้หัก)

  reviewer      text,
  reviewed_at   timestamptz,
  updated_at    timestamptz not null default now(),

  -- พนักงานกดรับทราบ
  ack_at        timestamptz,
  ack_note      text,
  ack_device    text,

  created_at    timestamptz not null default now()
);

create unique index if not exists uq_sdr_emp_day_shift
  on public.shift_day_reviews (emp_id, work_date, shift_id);
create index if not exists idx_sdr_date   on public.shift_day_reviews (work_date desc);
create index if not exists idx_sdr_branch on public.shift_day_reviews (branch_id, work_date desc);
-- คิว "รอพนักงานรับทราบ" — ฝั่งแอปพนักงานยิงด้วยเงื่อนไขนี้ทุกครั้งที่เปิดหน้า
create index if not exists idx_sdr_pending on public.shift_day_reviews (emp_id) where ack_at is null;

alter table public.shift_day_reviews enable row level security;
drop policy if exists sdr_all on public.shift_day_reviews;
create policy sdr_all on public.shift_day_reviews for all to anon, authenticated using (true) with check (true);


-- ---------- 3) กฎตัดคะแนนวินัยสำหรับคะแนนงานในกะต่ำ ----------
--   kind = 'manual' เพราะส่วนกลางเป็นคนกด ไม่ใช่ระบบคำนวณจาก attendance
insert into public.score_rules (rule_key, label, kind, points, range_min, enabled, sort) values
  ('hq_day_low', 'งานในกะไม่ได้มาตรฐาน (ส่วนกลางตรวจและให้คะแนน)', 'manual', -5, -15, true, 90)
on conflict (rule_key) do nothing;


-- ---------- 4) ค่าตั้งของการให้คะแนน ----------
--   hq_grade_auto      '1' = คะแนนสรุปรายวันต่ำกว่าเกณฑ์ ให้ระบบเสนอหักคะแนนวินัยให้เลย
--   hq_grade_threshold คะแนนที่ถือว่า "ต่ำกว่าเกณฑ์" (หักเมื่อคะแนน <= ค่านี้)
--   hq_grade_points    จำนวนคะแนนวินัยที่หัก (เลขบวก)
insert into public.app_settings (key, value) values
  ('hq_grade_auto',      '1'),
  ('hq_grade_threshold', '2'),
  ('hq_grade_points',    '5')
on conflict (key) do nothing;


-- ---------- 5) ตรวจผลลัพธ์ ----------
select 'shift_day_review.sql done' as result;
select key, value from public.app_settings where key like 'hq_grade%' order by key;
select rule_key, label, points, range_min, enabled from public.score_rules where rule_key = 'hq_day_low';
