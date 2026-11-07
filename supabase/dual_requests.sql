-- ============================================================
-- ตารางคำขอควบกะ (พนักงานขอ → HR อนุมัติ)                7 พ.ย. 69
--
-- ★ ผมขอโทษ — ผมบอกให้คุณรัน "supabase/dual-requests-2569-09-21.sql" มาหลายรอบ
--   แต่ไฟล์นั้น "ไม่เคยมีอยู่ใน repo" โค้ดฝั่งหน้าเว็บเขียนไว้ตั้งแต่ 21 ก.ย.
--   แต่ไฟล์สร้างตารางไม่เคยถูกคอมมิตขึ้นมา ผมไปอ่านชื่อไฟล์จากข้อความ error ในโค้ด
--   แล้วเชื่อว่ามีจริงโดยไม่ได้เปิดดู คุณจึงรันไม่ได้มาตลอด
--   ไฟล์นี้คือตัวจริง สร้างขึ้นใหม่จากการไล่อ่านว่าโค้ดใช้คอลัมน์อะไรบ้าง
--
-- นี่คือสาเหตุที่แบนเนอร์ "ควบกะ" ยังเตือนค้างอยู่ — ไม่ใช่เพราะคุณไม่ได้รัน
--
-- ตารางนี้ใช้ทำอะไร
--   พนักงานที่ลงเวลาเข้างานอยู่ กดขอควบกะต่อจากกะปัจจุบันได้
--   ระหว่างรออนุมัติ = ยังไม่นับควบ (คิดเป็น OT ตามปกติ)
--   HR อนุมัติ → ระบบเพิ่มเวรกะที่สองให้ แล้วคิด OT ใหม่จากเวลาเลิกกะที่สอง
--   HR ยกเลิกอนุมัติ → ลบเวรที่ระบบสร้าง (เฉพาะที่ระบบสร้างเอง) และคืนค่า OT เดิม
--
-- รันบน Supabase: SQL Editor > วาง > Run (รันซ้ำได้ ไม่ลบข้อมูล)
-- ============================================================

create table if not exists public.dual_requests (
  id               bigint generated always as identity primary key,
  emp_id           text not null,
  emp_name         text,
  branch_id        text,
  work_date        date not null,
  base_shift       text,                              -- กะเดิมที่ทำอยู่
  extra_shift      text not null,                     -- กะที่ขอควบต่อ
  status           text not null default 'pending',   -- pending | approved | rejected | revoked
  requested_by     text,
  requested_at     timestamptz not null default now(),
  decided_by       text,                              -- ชื่อ HR ที่ตัดสิน
  decided_at       timestamptz,
  decide_note      text,
  schedule_id      bigint,                            -- เวรกะที่สองที่ผูกไว้
  schedule_created boolean not null default false,    -- ระบบสร้างเวรนั้นเองไหม (ถ้าใช่ ตอนยกเลิกถึงจะลบ)
  ot_before        numeric,                           -- OT ก่อนอนุมัติ (ไว้คืนค่าตอนยกเลิก)
  ot_after         numeric                            -- OT หลังอนุมัติ
);

-- เผื่อเคยสร้างตารางนี้ไว้เองแบบไม่ครบ — เติมคอลัมน์ที่ขาดให้
alter table public.dual_requests add column if not exists emp_name         text;
alter table public.dual_requests add column if not exists branch_id        text;
alter table public.dual_requests add column if not exists base_shift       text;
alter table public.dual_requests add column if not exists requested_by     text;
alter table public.dual_requests add column if not exists requested_at     timestamptz not null default now();
alter table public.dual_requests add column if not exists decided_by       text;
alter table public.dual_requests add column if not exists decided_at       timestamptz;
alter table public.dual_requests add column if not exists decide_note      text;
alter table public.dual_requests add column if not exists schedule_id      bigint;
alter table public.dual_requests add column if not exists schedule_created boolean not null default false;
alter table public.dual_requests add column if not exists ot_before        numeric;
alter table public.dual_requests add column if not exists ot_after         numeric;

-- ดัชนีตามที่โค้ดค้นจริง
create index if not exists idx_dualreq_emp    on public.dual_requests (emp_id, work_date);
create index if not exists idx_dualreq_status on public.dual_requests (status);
create index if not exists idx_dualreq_req_at on public.dual_requests (requested_at desc);

alter table public.dual_requests enable row level security;
drop policy if exists dual_requests_all on public.dual_requests;
create policy dual_requests_all on public.dual_requests
  for all to anon, authenticated using (true) with check (true);


-- ============================================================
-- ตรวจหลังรัน
-- ============================================================

select 'dual_requests.sql done' as result,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='dual_requests') as จำนวนคอลัมน์,
       (select count(*) from public.dual_requests) as คำขอที่มีอยู่;
