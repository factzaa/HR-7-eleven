-- ============================================================
-- 7-Eleven HR — งานพิเศษ "ดูแลเชลฟ์ประจำเดือน" (Shelf Care)
-- โมเดล: ทะเบียนเชลฟ์ + มอบหมายรายเดือน + เช็กลิสต์รายวัน(มีรูป)
-- เชื่อมกับระบบ QA เดิม (บันทึกเก็บออก/เฝ้าระวังผ่านหน้า QA)
-- RLS แบบ trust-client (เปิดกว้าง) ให้สอดคล้องกับตารางอื่นในระบบ
-- ============================================================

-- ทะเบียนเชลฟ์ (ต่อสาขา) — checklist = หัวข้อเช็กลิสต์รายวัน (HR ตั้งต่อเชลฟ์)
create table if not exists shelves (
  id          bigserial primary key,
  shelf_code  text not null,
  name        text not null,
  branch_id   text references branches(branch_id) on delete cascade,
  checklist   jsonb not null default '["ทำความสะอาดเชลฟ์เรียบร้อย","จัดเรียงสินค้าหน้าตรง เต็มชั้น","FIFO — สินค้าตรงป้ายราคา","ตรวจวันหมดอายุครบทุกแถว"]'::jsonb,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (branch_id, shelf_code)
);
create index if not exists idx_shelves_branch on shelves(branch_id);
-- (เผื่อรันซ้ำบนตารางเดิม)
alter table shelves add column if not exists checklist jsonb not null default '["ทำความสะอาดเชลฟ์เรียบร้อย","จัดเรียงสินค้าหน้าตรง เต็มชั้น","FIFO — สินค้าตรงป้ายราคา","ตรวจวันหมดอายุครบทุกแถว"]'::jsonb;

-- มอบหมายรายเดือน (1 เชลฟ์ มอบได้หลายคน/เดือน) — month = 'YYYY-MM'
create table if not exists shelf_assignments (
  id          bigserial primary key,
  shelf_id    bigint not null references shelves(id) on delete cascade,
  emp_id      text not null,
  branch_id   text,
  month       text not null,
  detail      text,
  created_by  text,
  created_at  timestamptz not null default now(),
  unique (shelf_id, emp_id, month)
);
create index if not exists idx_shelf_asg_emp   on shelf_assignments(emp_id, month);
create index if not exists idx_shelf_asg_month on shelf_assignments(month);

-- เช็กลิสต์รายวัน (1 แถว/เชลฟ์/พนักงาน/วัน) — items = [{label, done}] ตามหัวข้อของเชลฟ์ + แนบรูป
create table if not exists shelf_checks (
  id              bigserial primary key,
  shelf_id        bigint not null references shelves(id) on delete cascade,
  emp_id          text not null,
  branch_id       text,
  check_date      date not null,
  items           jsonb not null default '[]'::jsonb,  -- [{"label":"...","done":true}]
  note            text,
  photos          jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (shelf_id, emp_id, check_date)
);
create index if not exists idx_shelf_checks_emp on shelf_checks(emp_id, check_date);

-- ---------- RLS (เปิดกว้าง ตาม trust-client model เดิม) ----------
alter table shelves           enable row level security;
alter table shelf_assignments enable row level security;
alter table shelf_checks      enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename='shelves' and policyname='shelves_all') then
    create policy shelves_all on shelves for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='shelf_assignments' and policyname='shelf_asg_all') then
    create policy shelf_asg_all on shelf_assignments for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='shelf_checks' and policyname='shelf_checks_all') then
    create policy shelf_checks_all on shelf_checks for all using (true) with check (true);
  end if;
end $$;
