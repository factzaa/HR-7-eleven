-- ============================================================
-- job_desc_cfg.sql — ตั้งค่าเวลาและตารางรถส่งของ รายสาขา      ★ 26 พ.ย. 69
--
-- ใช้คู่กับเมนู "หน้าที่ตามตำแหน่ง" ในแอป
--   · job_desc_band     = เวลาของแต่ละช่วงในกะ ถ้าสาขาไหนไม่ตรงกับค่าที่คำนวณให้
--   · job_desc_delivery = ตารางรถส่งของ ลงวันไหน ผลัดไหน เวลาเท่าไร แยกรายสาขา
--
-- ไฟล์นี้ไม่มีเนื้อหาจากคู่มือ CP ALL — เก็บใน repo ได้ตามปกติ
--
-- ปลอดภัยแค่ไหน:
--   · สร้างตารางใหม่ 2 ตาราง ไม่แตะข้อมูลเดิม ไม่ลบอะไร
--   · ยังไม่รันไฟล์นี้ เมนูก็ใช้งานได้ปกติ — เวลาจะคำนวณจากตาราง shifts ให้เอง
--     และรายการรถส่งของจะขึ้นรวมอยู่ในรายการหน้าที่เหมือนเดิม
--   · สิทธิ์เขียนใช้แพตเทิร์นเดียวกับตารางตั้งค่าอื่นในระบบ (app_settings,
--     discipline_rules ฯลฯ) คือ anon เขียนได้ และคุมสิทธิ์จริงที่หน้าแอป
--     — ยังไม่ได้แข็งกว่าของเดิม แต่ก็ไม่ได้อ่อนลง
--
-- รันทีเดียวจบใน Supabase → SQL Editor · ย้อนกลับได้ที่บล็อก [5] ท้ายไฟล์
-- ============================================================

-- ---------- [1] เวลาของแต่ละช่วงในกะ ----------
-- branch_id = '' หมายถึงใช้กับทุกสาขา (ค่ากลาง)
-- band: 0 ก่อนเข้างาน · 1 ต้นผลัด · 2 ระหว่างผลัด · 3 กลางผลัด · 4 ก่อนหมดกะ · 5 หลังปิดผลัด
-- ไม่มีแถว = แอปคำนวณจากเวลากะในตาราง shifts ให้เอง
create table if not exists public.job_desc_band (
  branch_id  text not null default '',
  shift      text not null,                -- m / a / n / mng
  band       int  not null,
  at_time    text not null,                -- 'HH:MM'
  updated_at timestamptz default now(),
  updated_by text default '',
  primary key (branch_id, shift, band)
);

-- ---------- [2] ตารางรถส่งของ ----------
create table if not exists public.job_desc_delivery (
  id         bigserial primary key,
  branch_id  text not null,
  vendor     text not null,                -- ตรงกับคอลัมน์ vendor ใน job_desc
  days       text not null default '',     -- '1,3,5'  (จ=1 … อา=7) ว่าง = ยังไม่ได้ตั้ง
  shift      text not null default '',     -- m / a / n
  at_time    text not null default '',     -- 'HH:MM'
  note       text not null default '',
  sort       int  not null default 0,
  active     boolean not null default true,
  updated_at timestamptz default now(),
  updated_by text default '',
  unique (branch_id, vendor)
);
create index if not exists job_desc_delivery_br_idx on public.job_desc_delivery(branch_id, sort);

-- ---------- [3] ใส่รายชื่อรถให้ครบทุกสาขา (ยังไม่ระบุวัน/เวลา รอ ผจก. กรอก) ----------
-- อ่านชื่อรถจากคอลัมน์ vendor ในตาราง job_desc ที่ติดตั้งไว้แล้ว
-- (ไม่ได้เขียนรายชื่อไว้ในไฟล์นี้ เพราะไฟล์นี้อยู่ใน repo ที่เป็น public
--  ส่วนเนื้อหาคู่มือเป็นลิขสิทธิ์ CP ALL — เก็บในฐานข้อมูลอย่างเดียว)
-- ยังไม่ได้รัน job_desc.sql ก็ข้ามส่วนนี้ไปเฉย ๆ ไม่ error
do $$
begin
  if to_regclass('public.job_desc') is null then
    raise notice 'ยังไม่มีตาราง job_desc — ข้ามการใส่รายชื่อรถ รัน job_desc.sql แล้วค่อยรันไฟล์นี้ซ้ำได้';
    return;
  end if;
  insert into public.job_desc_delivery (branch_id, vendor, sort)
  select br.branch_id, v.vendor, v.sort
    from public.branches br
    cross join (
      select vendor, min(sort) as sort
        from public.job_desc
       where coalesce(vendor,'') <> ''
       group by vendor
    ) v
  on conflict (branch_id, vendor) do nothing;
end $$;

-- ---------- [4] สิทธิ์ ----------
alter table public.job_desc_band     enable row level security;
alter table public.job_desc_delivery enable row level security;
drop policy if exists job_desc_band_all     on public.job_desc_band;
drop policy if exists job_desc_delivery_all on public.job_desc_delivery;
create policy job_desc_band_all     on public.job_desc_band
  for all to anon, authenticated using (true) with check (true);
create policy job_desc_delivery_all on public.job_desc_delivery
  for all to anon, authenticated using (true) with check (true);

-- ---------- ตรวจผลหลังรัน ----------
select branch_id, count(*) as รถส่งของ from public.job_desc_delivery group by 1 order by 1;

-- ============================================================
-- [5] ย้อนกลับ — เอาออกทั้งหมด (คัดลอกเฉพาะส่วนนี้ไปรัน)
-- ============================================================
-- drop table if exists public.job_desc_delivery;
-- drop table if exists public.job_desc_band;
-- ============================================================
