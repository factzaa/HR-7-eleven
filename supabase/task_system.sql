-- ============================================================
-- 7-Eleven HR — ระบบงานในกะ (Shift Tasks)
-- รายการงานตั้งค่าได้ + มอบหมายรายบุคคล + ส่งงาน(แนบรูป) + ตรวจ/ตีงานกลับ
-- รันบน Supabase: SQL Editor > วาง > Run
-- ============================================================

-- 1) นิยามรายการงาน (HR ตั้งค่าได้: เพิ่ม/ลบ/แก้)
create table if not exists public.task_defs (
  id           bigint generated always as identity primary key,
  title        text not null,
  require_photo boolean not null default false,  -- งานนี้ต้องถ่ายรูปส่งไหม
  active       boolean not null default true,
  sort         int not null default 0
);
-- ค่าเริ่มต้น (อิงเช็กลิสต์เดิม) — เพิ่มเฉพาะถ้ายังไม่มีงานเลย
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

-- 2) งานที่มอบหมาย (1 แถว = 1 งานของ 1 คน ใน 1 วัน)
--    status: todo (มอบหมายแล้ว) / submitted (ส่งแล้ว รอตรวจ) / approved (ผ่าน) / sent_back (ตีกลับให้แก้)
create table if not exists public.task_assignments (
  id           bigint generated always as identity primary key,
  work_date    date not null,
  emp_id       text not null,
  emp_name     text,
  branch_id    text,
  task_def_id  bigint,
  title        text not null,             -- snapshot ชื่องาน ณ เวลามอบหมาย
  require_photo boolean not null default false,
  status       text not null default 'todo',
  photo_url    text,
  emp_note     text,                      -- หมายเหตุจากพนักงานตอนส่ง
  reviewer     text,                      -- ผู้ตรวจ (ชื่อ/HR)
  review_note  text,                      -- เหตุผลตอนตีกลับ
  submitted_at timestamptz,
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_task_emp_date on public.task_assignments (emp_id, work_date);
create index if not exists idx_task_branch    on public.task_assignments (branch_id, work_date);
create index if not exists idx_task_status    on public.task_assignments (status);

alter table public.task_defs        enable row level security;
alter table public.task_assignments enable row level security;
drop policy if exists task_defs_all on public.task_defs;
drop policy if exists task_assign_all on public.task_assignments;
create policy task_defs_all   on public.task_defs        for all to anon, authenticated using (true) with check (true);
create policy task_assign_all on public.task_assignments for all to anon, authenticated using (true) with check (true);

select 'task_system.sql done' as result;
