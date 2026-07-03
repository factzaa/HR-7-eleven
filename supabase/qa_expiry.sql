-- ============================================================
-- 7-Eleven HR — QA สินค้า (ตรวจนับสินค้าใกล้หมดอายุล่วงหน้า)
-- โฟลเดอร์ตามเดือน → บันทึกสินค้าหลายรายการ → แจ้งเตือนก่อนหมดอายุ 30/14/7/3 วัน
-- รันบน Supabase: SQL Editor > วาง > Run (รันซ้ำได้)
-- ============================================================

-- โฟลเดอร์ (หัวข้อ เช่น "หมดอายุเดือน 8") สร้างโดย HR มอบหมายให้พนักงานหลายคน
create table if not exists public.qa_folders (
  id           bigint generated always as identity primary key,
  title        text not null,                 -- ชื่อหัวข้อ/โฟลเดอร์
  target_month text,                           -- เดือนเป้าหมาย 'YYYY-MM' (ไว้แสดง/จัดกลุ่ม)
  note         text,                           -- คำสั่ง/หมายเหตุจาก HR
  created_by   text,
  created_at   timestamptz not null default now(),
  active       boolean not null default true
);

-- ผู้รับผิดชอบโฟลเดอร์ (เห็นโฟลเดอร์ + รับแจ้งเตือน)
create table if not exists public.qa_folder_assignees (
  id                bigint generated always as identity primary key,
  folder_id         bigint not null references public.qa_folders(id) on delete cascade,
  emp_id            text not null,
  branch_id         text,
  assigned_notified boolean not null default false,
  unique (folder_id, emp_id)
);
create index if not exists idx_qa_fa_emp on public.qa_folder_assignees (emp_id);

-- สินค้าที่บันทึกในแต่ละโฟลเดอร์
create table if not exists public.qa_items (
  id           bigint generated always as identity primary key,
  folder_id    bigint not null references public.qa_folders(id) on delete cascade,
  barcode      text,                           -- บาร์โค้ด/รหัสสินค้า
  name         text not null,                  -- ชื่อสินค้า
  size         text,                           -- ขนาด
  qty          int not null default 1,         -- จำนวนกี่ชิ้น
  expiry_date  date not null,                  -- วันหมดอายุ
  zone         text,                           -- โซน/ชั้นวาง
  photos       jsonb  not null default '[]',   -- รูปสินค้า (สแตมป์แล้ว)
  status       text   not null default 'on_shelf', -- on_shelf | sold | removed
  branch_id    text,
  emp_id       text,                           -- ผู้บันทึก
  emp_name     text,
  notified_30  boolean not null default false, -- flag กันแจ้งซ้ำแต่ละชั้น
  notified_14  boolean not null default false,
  notified_7   boolean not null default false,
  notified_3   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_qa_items_folder on public.qa_items (folder_id);
create index if not exists idx_qa_items_expiry on public.qa_items (expiry_date, status);

-- ระบบ "จำสินค้า": บาร์โค้ด → ชื่อ/ขนาด (ใช้ร่วมทุกสาขา เติมอัตโนมัติเมื่อสแกนซ้ำ)
create table if not exists public.qa_products (
  barcode    text primary key,
  name       text not null,
  size       text,
  updated_at timestamptz not null default now()
);

alter table public.qa_folders          enable row level security;
alter table public.qa_folder_assignees enable row level security;
alter table public.qa_items            enable row level security;
alter table public.qa_products         enable row level security;
drop policy if exists qa_folders_all          on public.qa_folders;
drop policy if exists qa_folder_assignees_all on public.qa_folder_assignees;
drop policy if exists qa_items_all            on public.qa_items;
drop policy if exists qa_products_all         on public.qa_products;
create policy qa_folders_all          on public.qa_folders          for all to anon, authenticated using (true) with check (true);
create policy qa_folder_assignees_all on public.qa_folder_assignees for all to anon, authenticated using (true) with check (true);
create policy qa_items_all            on public.qa_items            for all to anon, authenticated using (true) with check (true);
create policy qa_products_all         on public.qa_products         for all to anon, authenticated using (true) with check (true);

select 'qa_expiry.sql done' as result;
