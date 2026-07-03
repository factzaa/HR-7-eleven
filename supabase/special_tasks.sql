-- ============================================================
-- 7-Eleven HR — งานพิเศษ (มอบหมายรายบุคคลจาก HR → แสดงในหน้า "งานของฉัน" เมนูรับส่งผลัด)
-- รันบน Supabase: SQL Editor > วาง > Run (รันซ้ำได้)
-- ============================================================

-- งานพิเศษ 1 ใบ (สร้างโดย HR) มอบหมายให้พนักงานได้หลายคน
create table if not exists public.special_tasks (
  id          bigint generated always as identity primary key,
  title       text not null,                 -- ชื่องาน
  detail      text,                          -- รายละเอียดงาน
  deadline    timestamptz,                   -- กำหนดเดดไลน์ (null = ไม่กำหนด)
  hr_photos   jsonb  not null default '[]',  -- รูปตัวอย่าง/อ้างอิงจาก HR (หลายรูป)
  hr_note     text,                          -- หมายเหตุจาก HR ถึงพนักงาน
  created_by  text,                          -- ผู้สร้าง (HR)
  created_at  timestamptz not null default now(),
  active      boolean not null default true
);

-- ผู้รับผิดชอบแต่ละคน (สถานะ/หลักฐาน/การตรวจ แยกรายคน)
create table if not exists public.special_task_assignees (
  id            bigint generated always as identity primary key,
  task_id       bigint not null references public.special_tasks(id) on delete cascade,
  emp_id        text not null,
  branch_id     text,                                 -- สาขาประจำ ณ ตอนมอบหมาย (ใช้กรอง/แจ้ง HR)
  status        text not null default 'todo',         -- todo | submitted | approved | sent_back
  photos        jsonb  not null default '[]',         -- รูปหลักฐานจากพนักงาน (สแตมป์ชื่อ/เวลา/สาขาแล้ว)
  emp_note      text,                                 -- หมายเหตุจากพนักงานตอนส่ง
  submitted_at  timestamptz,
  reviewer      text,                                 -- ผู้ตรวจ (HR)
  review_note   text,                                 -- เหตุผลตีกลับ / บันทึกการตรวจ
  reviewed_at   timestamptz,
  assigned_notified boolean not null default false,   -- แจ้งพนักงาน "งานใหม่" แล้วหรือยัง
  deadline_notified boolean not null default false,   -- เตือน "ใกล้ถึงเดดไลน์" แล้วหรือยัง
  submit_notified   boolean not null default false,   -- แจ้ง HR "พนักงานส่งงาน" แล้วหรือยัง
  unique (task_id, emp_id)
);
create index if not exists idx_sta_emp  on public.special_task_assignees (emp_id, status);
create index if not exists idx_sta_task on public.special_task_assignees (task_id);

alter table public.special_tasks           enable row level security;
alter table public.special_task_assignees  enable row level security;
drop policy if exists special_tasks_all          on public.special_tasks;
drop policy if exists special_task_assignees_all on public.special_task_assignees;
create policy special_tasks_all          on public.special_tasks          for all to anon, authenticated using (true) with check (true);
create policy special_task_assignees_all on public.special_task_assignees for all to anon, authenticated using (true) with check (true);

-- ให้พนักงาน subscribe แจ้งเตือนงานพิเศษได้ (แยกจากเครื่อง HR)
-- HR device = emp_id ว่าง (null) · เครื่องพนักงาน = emp_id ของคน ๆ นั้น
alter table public.push_subscriptions add column if not exists emp_id text;
create index if not exists idx_push_subs_emp on public.push_subscriptions (emp_id);

select 'special_tasks.sql done' as result;
