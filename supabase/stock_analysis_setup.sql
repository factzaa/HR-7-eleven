-- ============================================================
-- ระบบวิเคราะห์ Audit สินค้า + สินค้าตัดจ่าย  (เฟส 1)        21 ต.ค. 69
--
-- รองรับ 2 รายงานจาก CP ALL
--   1) RLR8803  "รายงาน Audit ราย SKU"            (xlsx/csv · ราคาขายรวมภาษี)
--   2) RT040037 "รายละเอียดค่าใช้จ่าย"            (PDF · ต้นทุน ไม่รวมภาษี)
--
-- หลักการสำคัญ
--   · 1 สาขา + 1 ประเภทรายงาน + 1 เดือน = 1 ใบอัปโหลด (อัปซ้ำ = ทับของเดิม)
--   · ไฟล์ Audit ไม่มีเดือนอยู่ในตัวไฟล์ → ต้องเลือกเดือนตอนอัปโหลด
--   · รายงานเก็บเฉพาะ SKU ที่คลาดเคลื่อน/ตัดจ่าย ไม่ใช่สต็อกทั้งร้าน
--   · สรุปทุกอย่างคำนวณด้วย RPC ฝั่งฐานข้อมูล — เลี่ยงเพดาน 1000 แถวของ PostgREST
--
-- ★ ระบบนี้บอกได้ว่า "หายเท่าไร ที่ไหน กลุ่มไหน แนวโน้มอย่างไร"
--   บอกไม่ได้ว่า "ใครเอาไป" — ผลวิเคราะห์เป็นจุดให้ไปตรวจ ไม่ใช่ข้อกล่าวหา
--
-- รันซ้ำได้ปลอดภัย ไม่ทำลายข้อมูลเดิม
-- ============================================================

-- ---------- 1) ใบอัปโหลด ----------
create table if not exists public.stock_uploads (
  id           uuid primary key default gen_random_uuid(),
  branch_id    text not null,
  branch_name  text,
  kind         text not null,                 -- audit | writeoff
  period_ym    text not null,                 -- YYYY-MM (ค.ศ.) เดือนของข้อมูล
  report_code  text,                          -- RLR8803 | RT040037
  filename     text,
  row_count    int  not null default 0,
  totals       jsonb not null default '{}'::jsonb,   -- สรุปที่คำนวณตอนนำเข้า
  note         text,
  uploaded_at  timestamptz not null default now(),
  uploaded_by  text,
  constraint stock_uploads_kind_ck check (kind in ('audit','writeoff'))
);

create unique index if not exists stock_uploads_uniq
  on public.stock_uploads (branch_id, kind, period_ym);
create index if not exists stock_uploads_period_idx
  on public.stock_uploads (period_ym desc, kind);

-- ---------- 2) รายการ Audit ราย SKU ----------
create table if not exists public.stock_audit_items (
  id          bigserial primary key,
  upload_id   uuid not null references public.stock_uploads(id) on delete cascade,
  branch_id   text not null,
  period_ym   text not null,
  pma         text,
  sku         text not null,
  name        text,
  qty         numeric not null default 0,     -- จำนวน(หน่วย) ติดลบ = ขาด
  amount      numeric not null default 0,     -- จำนวน(บาทรวมภาษี) ติดลบ = ขาด
  cost_qty    numeric not null default 0,     -- ต้นทุนสูญเสีย จำนวน(หน่วย)
  cost_amount numeric not null default 0      -- ต้นทุนสูญเสีย จำนวน(บาท)
);

create index if not exists stock_audit_bp_idx  on public.stock_audit_items (branch_id, period_ym);
create index if not exists stock_audit_sku_idx on public.stock_audit_items (branch_id, sku);
create index if not exists stock_audit_pma_idx on public.stock_audit_items (branch_id, pma, period_ym);

-- ---------- 3) รายการสินค้าตัดจ่าย ----------
create table if not exists public.stock_writeoff_items (
  id          bigserial primary key,
  upload_id   uuid not null references public.stock_uploads(id) on delete cascade,
  branch_id   text not null,
  period_ym   text not null,
  section     text,                           -- เสื่อมคุณภาพ-สาขา | เสื่อมคุณภาพ-คลัง | วัสดุสิ้นเปลือง | ชดเชยคืน
  pma         text,
  sku         text not null,
  name        text,
  pack_size   text,
  qty         numeric not null default 0,
  unit_price  numeric not null default 0,
  amount      numeric not null default 0      -- ต้นทุน ไม่รวมภาษี
);

create index if not exists stock_wo_bp_idx  on public.stock_writeoff_items (branch_id, period_ym);
create index if not exists stock_wo_sku_idx on public.stock_writeoff_items (branch_id, sku);
create index if not exists stock_wo_pma_idx on public.stock_writeoff_items (branch_id, pma, period_ym);

-- ---------- 3.5) คู่ "คีย์ผิดตัว" ที่ตรวจพบตอนนำเข้า ----------
--
-- ★ ทำไมต้องมีตารางนี้
--   ประมาณ 1 ใน 3 ของยอด "ขาด" ในรายงาน Audit ไม่ใช่ของหาย แต่เป็นสินค้าตัวหนึ่งขาด
--   และอีกตัวหนึ่งในกลุ่มเดียวกันเกินด้วยจำนวนที่หักกันลงตัว แยกได้ 2 สาเหตุ
--     pair_kind = 'unit'    อัตราเข้าหน่วยบรรจุ (x2..x48) ชื่อเดียวกันต่างหน่วย
--                           → รับของ/คีย์ผิดหน่วย เช่น "ยกลัง12" ขาด 1 แต่ขวดเดี่ยวเกิน 12
--     pair_kind = 'variant' อัตรา x1 จำนวนเท่ากัน ชื่อต่างกันแค่สี/เบอร์/กลิ่น
--                           → ขายผิดตัวที่แคชเชียร์ (ไม่เสียเงิน แต่ยอดขายรายตัวผิด → สั่งของผิด)
--   คำนวณฝั่งเบราว์เซอร์ตอนนำเข้า (ตอนที่มีข้อมูลครบทั้งเดือนอยู่ในมือ) แล้วเก็บผลไว้ที่นี่
--   เป็นเลขคณิตล้วน ไม่มี AI — ทุกบรรทัดตรวจย้อนกลับไปที่ตัวเลขในรายงานได้
create table if not exists public.stock_swap_pairs (
  id          bigserial primary key,
  upload_id   uuid not null references public.stock_uploads(id) on delete cascade,
  branch_id   text not null,
  period_ym   text not null,
  pma         text,
  pair_kind   text not null default 'variant',   -- unit | variant
  short_sku   text, short_name text, short_qty numeric, short_amt numeric,
  over_sku    text, over_name  text, over_qty  numeric, over_amt  numeric,
  ratio       numeric,                            -- อัตราจำนวน (เช่น 12 = ลังละ 12)
  similarity  numeric,                            -- ความคล้ายของชื่อ 0–1
  net_amt     numeric                             -- short_amt + over_amt (ใกล้ 0 = หักกันลงตัว)
);

create index if not exists stock_swap_bp_idx on public.stock_swap_pairs (branch_id, period_ym);

-- ---------- 4) ชื่อกลุ่มสินค้า PMA + ประเภทความเสี่ยง ----------
create table if not exists public.pma_groups (
  code      text primary key,                 -- 2 หลักแรกของรหัสสินค้า
  name      text not null,
  risk_type text not null default 'other',
  sort_ord  int  not null default 100
);

comment on column public.pma_groups.risk_type is
  'theft  = ชิ้นเล็กหยิบง่าย (ลูกค้า/พนักงาน) · control = ของควบคุมมูลค่าสูง · '
  'consume = วัสดุสิ้นเปลือง คุมด้วยขั้นตอน · fresh = ของสดหมดอายุ คุมด้วยการสั่ง/FIFO · '
  'drink = เครื่องดื่ม · home = ของใช้ในบ้าน · other';

insert into public.pma_groups (code, name, risk_type) values
  ('01','แซนด์วิช/เบเกอรี่พร้อมทาน','fresh'),
  ('02','ไข่/ของสดพร้อมทาน','fresh'),
  ('03','ขนมหวาน/ผลไม้','fresh'),
  ('05','แก้ว/ถ้วย/อุปกรณ์ชงเครื่องดื่ม','consume'),
  ('06','ซอส/เครื่องปรุงแบ่งซอง','consume'),
  ('07','แซนด์วิช (สาขาอุ่น)','fresh'),
  ('08','เบอร์เกอร์','fresh'),
  ('10','เบียร์','control'),
  ('11','สุรา','control'),
  ('12','บุหรี่ (นำเข้า)','control'),
  ('14','ยาสามัญ/สมุนไพร','theft'),
  ('16','สลัด','fresh'),
  ('19','อาหารกล่อง/ข้าว/ซูชิ','fresh'),
  ('20','อาหารแช่แข็ง/ข้าวต้ม','fresh'),
  ('21','ไส้กรอก/ของว่างอุ่น','fresh'),
  ('22','อาหารกล่องอีซี่โก','fresh'),
  ('23','ฟุตลอง/สโมกกี้','fresh'),
  ('24','ติ่มซำ/เปา','fresh'),
  ('28','ของแถม/ชุดโปรโมชัน','other'),
  ('29','นม UHT/ถั่วเหลือง','drink'),
  ('30','นมพาสเจอร์ไรส์/โยเกิร์ต','fresh'),
  ('31','น้ำผลไม้/นมเปรี้ยวพร้อมดื่ม','drink'),
  ('32','เครื่องปรุง/ของแห้งใช้ในครัว','home'),
  ('33','บะหมี่/โจ๊กซอง','home'),
  ('34','กาแฟ/เครื่องดื่มผง/ซีเรียล','drink'),
  ('35','กาชาปอง/ของเล่นตู้','theft'),
  ('37','แสตมป์/บริการ','control'),
  ('38','ชา/น้ำผลไม้/น้ำดื่มขวด','drink'),
  ('40','ลูกอม/ช็อกโกแลต/หมากฝรั่ง','theft'),
  ('41','ขนมถุง','theft'),
  ('42','น้ำอัดลม/โซดา','drink'),
  ('44','ไอศกรีม','fresh'),
  ('45','น้ำแข็ง','consume'),
  ('46','กล่อง/ซองพัสดุ','consume'),
  ('49','เครื่องดื่มชูกำลัง','drink'),
  ('50','เครื่องสำอาง/ของใช้ส่วนตัว','theft'),
  ('51','เสื้อกันฝน/ของใช้เบ็ดเตล็ด','other'),
  ('52','เครื่องเขียน/ของเล่น','theft'),
  ('53','ยา/เวชภัณฑ์','theft'),
  ('54','กระดาษทิชชู/ผ้าอนามัย','home'),
  ('55','ผงซักฟอก/น้ำยาทำความสะอาด','home'),
  ('56','ถ่าน/หลอดไฟ/อุปกรณ์ไฟฟ้า','theft'),
  ('58','ซิม/บัตรเติมเงิน','control'),
  ('60','พาย/ขนมอบ','fresh'),
  ('61','ขนมปังแถว','fresh'),
  ('63','ข้าวตัง/ของฝาก','theft'),
  ('68','ดอกไม้/ของขวัญ','other'),
  ('72','บุหรี่ (ในประเทศ)','control'),
  ('80','เค้ก/ขนมปังบรรจุถุง','fresh'),
  ('82','ไข่ไก่สด','fresh'),
  ('85','สาหร่าย/เส้นแก้ว','home'),
  ('89','ครีม/เซรั่มบำรุงผิว','theft'),
  ('90','ของที่ระลึก/กระเป๋า','theft'),
  ('94','ถุงบรรจุสินค้า','consume'),
  ('95','วัสดุอุปกรณ์ร้าน','consume'),
  ('97','ชุดพนักงาน','consume')
on conflict (code) do update set
  name = excluded.name,
  risk_type = excluded.risk_type;

-- ---------- 5) โปรไฟล์สาขา (ผจก. ตั้งค่าเองได้) ----------
create table if not exists public.branch_profiles (
  branch_id        text primary key,
  customer_groups  text[] not null default '{}',   -- นักเรียน/นักศึกษา, คนทำงาน, ครอบครัว, แรงงาน, นักท่องเที่ยว, ผู้สูงอายุ
  surroundings     text[] not null default '{}',   -- โรงเรียน, ตลาด, โรงงาน, หอพัก, ปั๊มน้ำมัน, โรงพยาบาล, สถานที่ท่องเที่ยว, ชุมชน
  peak_hours       text[] not null default '{}',   -- เช้า, กลางวัน, เย็น, กลางคืน
  has_allcafe      boolean not null default true,
  has_delivery     boolean not null default false,
  staff_count      int,
  camera_count     int,
  blind_spots      text,                           -- จุดที่กล้องมองไม่เห็น (ผจก. กรอกเอง)
  note             text,
  updated_at       timestamptz not null default now(),
  updated_by       text
);

-- ============================================================
-- RPC สำหรับหน้าสรุป (คำนวณฝั่งฐานข้อมูล)
-- ============================================================

-- 6.1 สรุป Audit รายเดือน
-- ★ 22 ต.ค. 69 — เพิ่ม p_from/p_to ให้ 3 ฟังก์ชันแนวโน้ม เดิมไม่รับช่วงเดือน
--   ทำให้ตัวกรอง "ช่วงเดือน" บนหน้าเว็บไม่มีผลกับตาราง/กราฟแนวโน้มเลย
--   เปลี่ยนจำนวนอาร์กิวเมนต์ → create or replace จะกลายเป็นฟังก์ชันตัวใหม่ซ้อนของเดิม ต้อง drop ตัวเก่าทิ้งก่อน
drop function if exists public.stock_audit_trend(text, int);
drop function if exists public.stock_writeoff_trend(text, int);
drop function if exists public.stock_swap_trend(text, int);

create or replace function public.stock_audit_trend(
  p_branch text default null, p_from text default null, p_to text default null, p_limit int default 24)
returns table (
  period_ym text, sku_n bigint, short_n bigint, over_n bigint,
  short_amt numeric, over_amt numeric, net_amt numeric, abs_amt numeric, cost_amt numeric
) language sql stable as $$
  select i.period_ym,
         count(*)                                           as sku_n,
         count(*) filter (where i.amount < 0)                as short_n,
         count(*) filter (where i.amount > 0)                as over_n,
         coalesce(sum(i.amount) filter (where i.amount < 0),0) as short_amt,
         coalesce(sum(i.amount) filter (where i.amount > 0),0) as over_amt,
         coalesce(sum(i.amount),0)                            as net_amt,
         coalesce(sum(abs(i.amount)),0)                       as abs_amt,
         coalesce(sum(i.cost_amount),0)                       as cost_amt
    from public.stock_audit_items i
   where (p_branch is null or i.branch_id = p_branch)
     and (p_from   is null or i.period_ym >= p_from)
     and (p_to     is null or i.period_ym <= p_to)
   group by i.period_ym
   order by i.period_ym desc
   limit greatest(p_limit, 1);
$$;

-- 6.2 SKU ที่ขาดซ้ำหลายเดือน (เรื้อรัง)
create or replace function public.stock_audit_chronic(
  p_branch text default null, p_from text default null, p_to text default null,
  p_min_months int default 2, p_limit int default 200)
returns table (
  sku text, name text, pma text, pma_name text, risk_type text,
  months_short int, months_total int, short_amt numeric, short_qty numeric,
  avg_amt numeric, last_period text, wo_amt numeric
) language sql stable as $$
  with scope as (
    select i.* from public.stock_audit_items i
     where (p_branch is null or i.branch_id = p_branch)
       and (p_from   is null or i.period_ym >= p_from)
       and (p_to     is null or i.period_ym <= p_to)
  ), mons as (
    select count(distinct period_ym)::int as n from scope
  ), agg as (
    select s.sku,
           max(s.name) as name,
           max(s.pma)  as pma,
           count(distinct s.period_ym) filter (where s.amount < 0)::int as months_short,
           coalesce(sum(s.amount) filter (where s.amount < 0),0) as short_amt,
           coalesce(sum(s.qty)    filter (where s.amount < 0),0) as short_qty,
           max(s.period_ym) filter (where s.amount < 0)          as last_period
      from scope s
     group by s.sku
  ), wo as (
    select w.sku, coalesce(sum(w.amount),0) as wo_amt
      from public.stock_writeoff_items w
     where (p_branch is null or w.branch_id = p_branch)
       and (p_from   is null or w.period_ym >= p_from)
       and (p_to     is null or w.period_ym <= p_to)
       and coalesce(w.section,'') <> 'ชดเชยคืน'
     group by w.sku
  )
  select a.sku, a.name, a.pma,
         coalesce(g.name,'(ไม่ทราบกลุ่ม)') as pma_name,
         coalesce(g.risk_type,'other')     as risk_type,
         a.months_short, (select n from mons) as months_total,
         a.short_amt, a.short_qty,
         round(a.short_amt / greatest(a.months_short,1), 2) as avg_amt,
         a.last_period,
         coalesce(w.wo_amt,0) as wo_amt
    from agg a
    left join public.pma_groups g on g.code = a.pma
    left join wo w on w.sku = a.sku
   where a.months_short >= greatest(p_min_months,1)
   order by a.short_amt asc
   limit greatest(p_limit,1);
$$;

-- 6.3 สรุป Audit รายกลุ่ม PMA (แนวโน้มรายเดือน)
create or replace function public.stock_audit_pma(
  p_branch text default null, p_from text default null, p_to text default null)
returns table (
  pma text, pma_name text, risk_type text, period_ym text,
  sku_n bigint, short_amt numeric, over_amt numeric, net_amt numeric
) language sql stable as $$
  select i.pma,
         coalesce(g.name,'(ไม่ทราบกลุ่ม)') as pma_name,
         coalesce(g.risk_type,'other')     as risk_type,
         i.period_ym,
         count(*) as sku_n,
         coalesce(sum(i.amount) filter (where i.amount < 0),0) as short_amt,
         coalesce(sum(i.amount) filter (where i.amount > 0),0) as over_amt,
         coalesce(sum(i.amount),0) as net_amt
    from public.stock_audit_items i
    left join public.pma_groups g on g.code = i.pma
   where (p_branch is null or i.branch_id = p_branch)
     and (p_from   is null or i.period_ym >= p_from)
     and (p_to     is null or i.period_ym <= p_to)
   group by i.pma, g.name, g.risk_type, i.period_ym;
$$;

-- 6.4 สรุปสินค้าตัดจ่ายรายเดือน แยกหมวด
create or replace function public.stock_writeoff_trend(
  p_branch text default null, p_from text default null, p_to text default null, p_limit int default 24)
returns table (
  period_ym text, row_n bigint,
  amt_branch numeric, amt_dc numeric, amt_consume numeric, amt_credit numeric, amt_net numeric
) language sql stable as $$
  select w.period_ym,
         count(*) as row_n,
         coalesce(sum(w.amount) filter (where w.section = 'เสื่อมคุณภาพ-สาขา'),0) as amt_branch,
         coalesce(sum(w.amount) filter (where w.section = 'เสื่อมคุณภาพ-คลัง'),0) as amt_dc,
         coalesce(sum(w.amount) filter (where w.section = 'วัสดุสิ้นเปลือง'),0)   as amt_consume,
         coalesce(sum(w.amount) filter (where w.section = 'ชดเชยคืน'),0)          as amt_credit,
         coalesce(sum(w.amount),0) as amt_net
    from public.stock_writeoff_items w
   where (p_branch is null or w.branch_id = p_branch)
     and (p_from   is null or w.period_ym >= p_from)
     and (p_to     is null or w.period_ym <= p_to)
   group by w.period_ym
   order by w.period_ym desc
   limit greatest(p_limit,1);
$$;

-- 6.5 SKU ตัดจ่ายสูงสุด
create or replace function public.stock_writeoff_top(
  p_branch text default null, p_from text default null, p_to text default null,
  p_section text default null, p_limit int default 50)
returns table (
  sku text, name text, pma text, pma_name text, risk_type text,
  months_n int, qty numeric, amount numeric, last_period text
) language sql stable as $$
  select w.sku, max(w.name) as name, max(w.pma) as pma,
         coalesce(max(g.name),'(ไม่ทราบกลุ่ม)') as pma_name,
         coalesce(max(g.risk_type),'other')     as risk_type,
         count(distinct w.period_ym)::int as months_n,
         coalesce(sum(w.qty),0)    as qty,
         coalesce(sum(w.amount),0) as amount,
         max(w.period_ym) as last_period
    from public.stock_writeoff_items w
    left join public.pma_groups g on g.code = w.pma
   where (p_branch  is null or w.branch_id = p_branch)
     and (p_from    is null or w.period_ym >= p_from)
     and (p_to      is null or w.period_ym <= p_to)
     and (p_section is null or w.section   = p_section)
     and coalesce(w.section,'') <> 'ชดเชยคืน'
   group by w.sku
   order by sum(w.amount) desc
   limit greatest(p_limit,1);
$$;

-- 6.6 สรุปตามประเภทความเสี่ยง (ใช้ตั้งสมมุติฐานในเฟส 2)
create or replace function public.stock_risk_summary(
  p_branch text default null, p_from text default null, p_to text default null)
returns table (
  risk_type text, sku_n bigint, short_amt numeric, over_amt numeric, wo_amt numeric
) language sql stable as $$
  with a as (
    select coalesce(g.risk_type,'other') as rt,
           count(distinct i.sku) as sku_n,
           coalesce(sum(i.amount) filter (where i.amount < 0),0) as short_amt,
           coalesce(sum(i.amount) filter (where i.amount > 0),0) as over_amt
      from public.stock_audit_items i
      left join public.pma_groups g on g.code = i.pma
     where (p_branch is null or i.branch_id = p_branch)
       and (p_from   is null or i.period_ym >= p_from)
       and (p_to     is null or i.period_ym <= p_to)
     group by 1
  ), w as (
    select coalesce(g.risk_type,'other') as rt,
           coalesce(sum(x.amount),0) as wo_amt
      from public.stock_writeoff_items x
      left join public.pma_groups g on g.code = x.pma
     where (p_branch is null or x.branch_id = p_branch)
       and (p_from   is null or x.period_ym >= p_from)
       and (p_to     is null or x.period_ym <= p_to)
       and coalesce(x.section,'') <> 'ชดเชยคืน'
     group by 1
  )
  select coalesce(a.rt, w.rt) as risk_type,
         coalesce(a.sku_n,0), coalesce(a.short_amt,0),
         coalesce(a.over_amt,0), coalesce(w.wo_amt,0)
    from a full outer join w on w.rt = a.rt
   order by coalesce(a.short_amt,0) asc;
$$;

-- 6.7 คู่คีย์ผิดตัว — สรุปรายเดือน (ใช้หักออกจากยอด "ขาด" เพื่อให้เห็นของหายจริง)
create or replace function public.stock_swap_trend(
  p_branch text default null, p_from text default null, p_to text default null, p_limit int default 24)
returns table (
  period_ym text, pair_n bigint, unit_n bigint, variant_n bigint,
  explained_amt numeric, residual_amt numeric
) language sql stable as $$
  select s.period_ym,
         count(*) as pair_n,
         count(*) filter (where s.pair_kind = 'unit')    as unit_n,
         count(*) filter (where s.pair_kind = 'variant') as variant_n,
         coalesce(sum(abs(s.short_amt)),0) as explained_amt,
         coalesce(sum(s.net_amt),0)        as residual_amt
    from public.stock_swap_pairs s
   where (p_branch is null or s.branch_id = p_branch)
     and (p_from   is null or s.period_ym >= p_from)
     and (p_to     is null or s.period_ym <= p_to)
   group by s.period_ym
   order by s.period_ym desc
   limit greatest(p_limit,1);
$$;

-- 6.8 คู่คีย์ผิดตัว — รายคู่
create or replace function public.stock_swap_list(
  p_branch text default null, p_from text default null, p_to text default null,
  p_kind text default null, p_limit int default 300)
returns table (
  period_ym text, pma text, pma_name text, pair_kind text,
  short_sku text, short_name text, short_qty numeric, short_amt numeric,
  over_sku text, over_name text, over_qty numeric, over_amt numeric,
  ratio numeric, similarity numeric, net_amt numeric
) language sql stable as $$
  select s.period_ym, s.pma, coalesce(g.name,'(ไม่ทราบกลุ่ม)'), s.pair_kind,
         s.short_sku, s.short_name, s.short_qty, s.short_amt,
         s.over_sku,  s.over_name,  s.over_qty,  s.over_amt,
         s.ratio, s.similarity, s.net_amt
    from public.stock_swap_pairs s
    left join public.pma_groups g on g.code = s.pma
   where (p_branch is null or s.branch_id = p_branch)
     and (p_from   is null or s.period_ym >= p_from)
     and (p_to     is null or s.period_ym <= p_to)
     and (p_kind   is null or s.pair_kind = p_kind)
   order by abs(s.short_amt) desc
   limit greatest(p_limit,1);
$$;

-- 6.9 เจาะรายการสินค้าในกลุ่ม PMA (กดจากตารางอันดับกลุ่มแล้วดูว่าเป็นสินค้าตัวไหน)
--     by_month = {"2026-09": -1845.00, ...} เอาไว้วาดคอลัมน์รายเดือนและกราฟแท่ง
create or replace function public.stock_pma_items(
  p_branch text default null, p_from text default null, p_to text default null,
  p_pma text default null, p_limit int default 300)
returns table (
  sku text, name text, pma text, pma_name text, risk_type text,
  months_n int, months_short int,
  short_amt numeric, short_qty numeric, over_amt numeric, over_qty numeric,
  net_amt numeric, wo_amt numeric, last_period text, by_month jsonb
) language sql stable as $$
  with scope as (
    select i.* from public.stock_audit_items i
     where (p_branch is null or i.branch_id = p_branch)
       and (p_from   is null or i.period_ym >= p_from)
       and (p_to     is null or i.period_ym <= p_to)
       and (p_pma    is null or i.pma = p_pma)
  ), agg as (          -- รวมหลายสาขาให้เป็นค่าเดียวต่อ (สินค้า, เดือน) ก่อน ไม่งั้น jsonb ซ้ำคีย์
    select sku, period_ym, sum(amount) as amt, sum(qty) as q,
           max(name) as nm, max(pma) as pm
      from scope group by sku, period_ym
  ), wo as (
    select w.sku, sum(w.amount) as amt
      from public.stock_writeoff_items w
     where (p_branch is null or w.branch_id = p_branch)
       and (p_from   is null or w.period_ym >= p_from)
       and (p_to     is null or w.period_ym <= p_to)
       and (p_pma    is null or w.pma = p_pma)
       and coalesce(w.section,'') <> 'ชดเชยคืน'
     group by w.sku
  )
  select a.sku, max(a.nm) as name, max(a.pm) as pma,
         coalesce(max(g.name),'(ไม่ทราบกลุ่ม)') as pma_name,
         coalesce(max(g.risk_type),'other')     as risk_type,
         count(*)::int                                   as months_n,
         count(*) filter (where a.amt < 0)::int          as months_short,
         coalesce(sum(a.amt) filter (where a.amt < 0),0) as short_amt,
         coalesce(sum(a.q)   filter (where a.amt < 0),0) as short_qty,
         coalesce(sum(a.amt) filter (where a.amt > 0),0) as over_amt,
         coalesce(sum(a.q)   filter (where a.amt > 0),0) as over_qty,
         coalesce(sum(a.amt),0)                          as net_amt,
         coalesce(max(w.amt),0)                          as wo_amt,
         max(a.period_ym) filter (where a.amt < 0)       as last_period,
         jsonb_object_agg(a.period_ym, a.amt)            as by_month
    from agg a
    left join public.pma_groups g on g.code = a.pm
    left join wo w on w.sku = a.sku
   group by a.sku
   order by coalesce(sum(a.amt) filter (where a.amt < 0),0) asc
   limit greatest(p_limit,1);
$$;

-- 6.10 เทียบ 2 เดือนระดับรายสินค้า — ตอบว่า "เดือนนี้แย่ลงเพราะตัวไหน"
--      diff = ยอดเดือน b ลบยอดเดือน a (ติดลบ = แย่ลง) เรียงตามขนาดการเปลี่ยนแปลง
create or replace function public.stock_month_diff(
  p_branch text default null, p_a text default null, p_b text default null,
  p_limit int default 150)
returns table (
  sku text, name text, pma text, pma_name text, risk_type text,
  amt_a numeric, amt_b numeric, diff numeric, qty_a numeric, qty_b numeric
) language sql stable as $$
  with s as (
    select i.sku, max(i.name) as nm, max(i.pma) as pm,
           coalesce(sum(i.amount) filter (where i.period_ym = p_a),0) as a_amt,
           coalesce(sum(i.amount) filter (where i.period_ym = p_b),0) as b_amt,
           coalesce(sum(i.qty)    filter (where i.period_ym = p_a),0) as a_qty,
           coalesce(sum(i.qty)    filter (where i.period_ym = p_b),0) as b_qty
      from public.stock_audit_items i
     where (p_branch is null or i.branch_id = p_branch)
       and i.period_ym in (p_a, p_b)
     group by i.sku
  )
  select s.sku, s.nm, s.pm,
         coalesce(g.name,'(ไม่ทราบกลุ่ม)'), coalesce(g.risk_type,'other'),
         s.a_amt, s.b_amt, (s.b_amt - s.a_amt), s.a_qty, s.b_qty
    from s left join public.pma_groups g on g.code = s.pm
   where s.a_amt <> 0 or s.b_amt <> 0
   order by abs(s.b_amt - s.a_amt) desc
   limit greatest(p_limit,1);
$$;

-- ---------- 7) RLS (เหมือนตารางอื่นในระบบ — คุมสิทธิ์จริงที่ชั้น API) ----------
alter table public.stock_uploads        enable row level security;
alter table public.stock_audit_items    enable row level security;
alter table public.stock_writeoff_items enable row level security;
alter table public.stock_swap_pairs      enable row level security;
alter table public.pma_groups           enable row level security;
alter table public.branch_profiles      enable row level security;

drop policy if exists anon_rw_stock_uploads on public.stock_uploads;
create policy anon_rw_stock_uploads on public.stock_uploads
  for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_rw_stock_audit_items on public.stock_audit_items;
create policy anon_rw_stock_audit_items on public.stock_audit_items
  for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_rw_stock_writeoff_items on public.stock_writeoff_items;
create policy anon_rw_stock_writeoff_items on public.stock_writeoff_items
  for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_rw_stock_swap_pairs on public.stock_swap_pairs;
create policy anon_rw_stock_swap_pairs on public.stock_swap_pairs
  for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_rw_pma_groups on public.pma_groups;
create policy anon_rw_pma_groups on public.pma_groups
  for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_rw_branch_profiles on public.branch_profiles;
create policy anon_rw_branch_profiles on public.branch_profiles
  for all to anon, authenticated using (true) with check (true);

-- ---------- ตรวจผล ----------
-- select code, name, risk_type from public.pma_groups order by code;
-- select * from public.stock_audit_trend('08747');
-- select * from public.stock_audit_chronic('08747', null, null, 4, 20);
-- select * from public.stock_writeoff_trend('08747');
-- select * from public.stock_risk_summary('08747');
