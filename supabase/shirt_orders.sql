-- ============================================================
-- ระบบเบิกซื้อเสื้อพนักงาน (Uniform Shirt Requisition)   25 ก.ย. 69
--
-- ขั้นตอน
--   พนง. หน้าแรก → ใส่รหัส + PIN → เลือกเสื้อ/ไซส์/จำนวน → ยืนยัน (pending)
--   → ผจก. เห็นในแท็บ "เบิกซื้อเสื้อ" (ป้ายแดง)
--   → กดนำจ่าย: ยืนยันไซส์ + แนบรูปหลักฐาน + พนง. เซ็นรับบนจอ  (delivered)
--   → หักจากเงินเดือน "รอบที่วันนำจ่ายตกอยู่" ครั้งเดียวเต็มจำนวน
--
-- กติกาสำคัญ
--   · ราคาถูกตรึงไว้ ณ วันนำจ่าย (unit_price) — ขึ้นราคาทีหลังไม่ย้อนกระทบใบเก่า
--   · ไม่มีรูป + ไม่มีลายเซ็น = นำจ่ายไม่ได้ → ไม่มีทางหักเงินโดยไม่มีหลักฐาน
--   · พนักงานใหม่: ระบบสร้างใบเสื้อพนักงาน 1 ตัวให้อัตโนมัติ (ไซส์ว่าง)
--     ผจก. ระบุไซส์ให้เองตอนนำจ่าย หรือติ๊ก "มีเสื้อเดิมแล้ว" เพื่อปฏิเสธ (ไม่หักเงิน)
--   · เสื้อ Delivery เห็นเฉพาะคนที่ติ๊ก is_rider ไว้ (ปิดได้ในตั้งค่า)
--
-- รันซ้ำได้ปลอดภัย ไม่ทำลายข้อมูลเดิม
-- ============================================================

-- ---------- 1) ตั้งค่า (แถวเดียว id=1) ----------
create table if not exists public.shirt_config (
  id                   int primary key default 1,
  enabled              boolean not null default true,
  price_staff          numeric not null default 150,     -- ราคาเสื้อพนักงาน/ตัว
  price_delivery       numeric not null default 300,     -- ราคาเสื้อ Delivery/ตัว
  sizes                text    not null default 'S,M,L,XL,2XL,3XL',  -- คั่นด้วย , แก้ได้ในหน้าตั้งค่า
  max_qty_per_order    int     not null default 3,       -- สั่งได้สูงสุดกี่ตัวต่อใบ
  delivery_rider_only  boolean not null default true,    -- เสื้อ Delivery เฉพาะไรเดอร์
  auto_new_hire        boolean not null default true,    -- สร้างใบให้พนักงานใหม่อัตโนมัติ
  auto_new_hire_qty    int     not null default 1,       -- กี่ตัว
  allow_cancel         boolean not null default true,    -- พนง. ยกเลิกเองได้ก่อนนำจ่าย
  updated_at           timestamptz not null default now(),
  updated_by           text
);
insert into public.shirt_config (id) values (1) on conflict (id) do nothing;

-- ตั้งราคาตามที่ตกลง (เฉพาะแถวที่ยังเป็นค่าเริ่มต้นเดิม — ถ้าเคยตั้งเองแล้วไม่ทับ)
update public.shirt_config set price_staff = 150 where id = 1 and price_staff = 150;
update public.shirt_config set price_delivery = 300 where id = 1 and price_delivery = 300;

-- ---------- 2) ใบเบิก ----------
create table if not exists public.shirt_orders (
  id            uuid primary key default gen_random_uuid(),
  order_no      text unique,                       -- SH-2569-0001
  emp_id        text not null,
  emp_name      text,
  branch_id     text,
  branch_name   text,

  item_type     text not null default 'staff',     -- staff | delivery
  size          text,                              -- ว่างได้เฉพาะใบอัตโนมัติของพนักงานใหม่
  qty           int  not null default 1,

  unit_price    numeric,                           -- ★ ตรึง ณ วันนำจ่าย
  amount        numeric,                           -- unit_price * qty

  status        text not null default 'pending',   -- pending | delivered | rejected | cancelled
  source        text not null default 'self',      -- self | auto_new_hire
  note          text,

  -- นำจ่าย
  delivered_at  timestamptz,
  delivered_by  text,
  photo_urls    text[],                            -- หลักฐานการนำจ่าย (อย่างน้อย 1 รูป)
  sign_url      text,                              -- ลายเซ็นรับของพนักงาน
  sign_name     text,                              -- ชื่อที่พิมพ์กำกับใต้ลายเซ็น

  -- ปฏิเสธ
  rejected_at   timestamptz,
  rejected_by   text,
  reject_reason text,

  -- หักเงินเดือน
  cycle_month   text,                              -- YYYY-MM รอบที่หัก (ตั้งตอนนำจ่าย)
  deducted      boolean not null default false,
  deducted_at   timestamptz,
  payroll_ref   uuid,

  created_at    timestamptz not null default now(),
  created_by    text
);

create index if not exists shirt_orders_emp_idx    on public.shirt_orders (emp_id, created_at desc);
create index if not exists shirt_orders_pend_idx   on public.shirt_orders (status, branch_id);
create index if not exists shirt_orders_cycle_idx  on public.shirt_orders (cycle_month, deducted, status);

-- ---------- 3) เลขที่ใบอัตโนมัติ SH-2569-0001 ----------
create sequence if not exists public.shirt_order_seq;

create or replace function public.shirt_order_no() returns trigger
language plpgsql as $$
declare y int;
begin
  if new.order_no is null or new.order_no = '' then
    y := extract(year from (now() at time zone 'Asia/Bangkok'))::int + 543;
    new.order_no := 'SH-' || y || '-' || lpad(nextval('public.shirt_order_seq')::text, 4, '0');
  end if;
  return new;
end $$;

drop trigger if exists shirt_orders_no_trg on public.shirt_orders;
create trigger shirt_orders_no_trg before insert on public.shirt_orders
  for each row execute function public.shirt_order_no();

-- ---------- 4) RLS (เหมือนตารางอื่นในระบบ — คุมสิทธิ์จริงที่ชั้น API) ----------
alter table public.shirt_config enable row level security;
alter table public.shirt_orders enable row level security;

drop policy if exists anon_rw_shirt_config on public.shirt_config;
create policy anon_rw_shirt_config on public.shirt_config for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_rw_shirt_orders on public.shirt_orders;
create policy anon_rw_shirt_orders on public.shirt_orders for all to anon, authenticated using (true) with check (true);

-- ---------- ตรวจผล ----------
-- select * from public.shirt_config;
-- select status, count(*), sum(amount) from public.shirt_orders group by 1;
