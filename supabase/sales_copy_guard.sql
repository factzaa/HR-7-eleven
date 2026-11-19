-- ============================================================
-- 7-Eleven HR — กัน "ฟอร์มยอดขายที่ก๊อปมาแล้วลืมแก้ตัวเลข"
-- สร้าง 19 พ.ย. 69
-- รันบน Supabase: SQL Editor > วาง > Run   (รันซ้ำได้ ไม่กระทบข้อมูลเดิม)
--
-- ปัญหาที่แก้
--   ฟอร์มที่ส่งในกลุ่มไลน์มีทุกผลัดอยู่ในข้อความเดียว คนส่งก๊อปข้อความเดิมมาแล้ว
--   เติมเฉพาะผลัดตัวเอง ผลัดที่ลืมแก้จึงติดเลขของวันก่อนมาด้วย แล้วถูกเขียนลงระบบ
--   ที่เจอจริง: บางวันก๊อปมาทั้งใบ 4 บล็อกไม่ได้แก้สักตัว · บางวันแก้บ่าย/ดึกแล้ว
--              แต่เหลือเช้าติดเลขของเมื่อวาน · บางใบก๊อปมาจากฟอร์มเมื่อ 1-2 เดือนก่อน
--
-- กฎที่ใช้
--   ถ้าแถวที่กำลังจะเขียน มี ยอดขายรวม + เป้า + จำนวนลูกค้า ตรงกันเป๊ะทั้งสามค่า
--   กับ "ผลัดเดียวกัน สาขาเดียวกัน ของวันไหนก็ได้ในช่วง 90 วันก่อนหน้า" → ถือว่าลืมแก้
--     · ถ้าผลัดนั้นมียอดจริงอยู่แล้ว  → ไม่ให้ทับ เก็บของเดิมไว้
--     · ถ้ายังไม่มียอด                → บันทึกแถวไว้แต่ "ล้างตัวเลขเป็นว่าง" พร้อมโน้ตว่าทำไม
--       (ไม่ทิ้งแถว เพื่อให้กดแก้ใส่เลขจริงในแอปได้ และขึ้นเตือนในหน้าคุณภาพข้อมูล)
--
--   ตรงกันทั้งสามค่าถึงระดับสตางค์ โอกาสบังเอิญแทบเป็นศูนย์
--   ข้อความเดียวที่ซ้ำผลัดเดิม "ภายในวันเดียวกัน" ยังเขียนทับได้ตามปกติ (ไม่โดนกฎนี้)
--   การแก้มือในแอป (ซึ่งอัป edited_at เสมอ) ไม่โดนกฎนี้เช่นกัน
--
-- ต้องรัน supabase/sales_edit.sql มาก่อน (ใช้คอลัมน์ edited_at / edited_by / edit_note)
-- วิธีปิด/ถอนกลับ อยู่ท้ายไฟล์
-- ============================================================

-- ------------------------------------------------------------
-- [1] ฟังก์ชันตรวจ
-- ------------------------------------------------------------
create or replace function public.sales_daily_guard_stale_copy()
returns trigger
language plpgsql
as $fn$
declare
  prev record;
begin
  -- (ก) แก้มือจากในแอป → ปล่อยผ่านเสมอ (hrSalesUpdate อัป edited_at ทุกครั้ง)
  if tg_op = 'UPDATE' and new.edited_at is distinct from old.edited_at then
    return new;
  end if;

  -- (ข) สนใจเฉพาะแถวที่มียอดขายจริงเข้ามา
  if coalesce(new.sales_total, 0) <= 0 then
    return new;
  end if;

  -- (ข2) ถ้าแถวเดิมเคยถูกระบบกันไว้ แล้วรอบนี้มียอดจริงเข้ามา → ล้างโน้ตเตือนทิ้ง
  if tg_op = 'UPDATE' and coalesce(old.edit_note, '') like 'ระบบกันไว้%' then
    new.edited_by := null;  new.edited_at := null;  new.edit_note := null;
  end if;

  -- (ค) หา "วันก่อนหน้า" ที่ตรงกันเป๊ะทั้งสามค่า — ไม่ใช่แค่เมื่อวาน
  --     เพราะของจริงมีทั้งก๊อปของเมื่อวาน และก๊อปของเมื่อ 13 วันก่อน (16/11 = 3/11)
  --     ย้อนดูได้ไกลสุดตามจำนวนวันใน GUARD_DAYS ด้านล่าง
  select s.sale_date
    into prev
    from public.sales_daily s
   where s.branch_id = new.branch_id
     and s.shift     = new.shift
     and s.sale_date <  new.sale_date
     and s.sale_date >= new.sale_date - 90        -- GUARD_DAYS
     and s.sales_total  = new.sales_total
     and s.target_total is not distinct from new.target_total
     and round(coalesce(s.customers, 0)::numeric) = round(coalesce(new.customers, 0)::numeric)
   order by s.sale_date desc
   limit 1;

  -- (ง) เจอวันที่ตรงกันเป๊ะ = ลืมแก้ตัวเลข
  if found then
    -- มียอดจริงอยู่แล้ว → ห้ามทับ
    -- หมายเหตุ: upsert ของ PostgREST คือ INSERT ... ON CONFLICT ซึ่งทริกเกอร์ BEFORE INSERT
    --           ทำงาน "ก่อน" ตรวจชนกัน จึงต้องเช็กแถวเดิมเองในสาขา INSERT ด้วย
    if tg_op = 'UPDATE' then
      if coalesce(old.sales_total, 0) > 0 then
        return old;
      end if;
    elsif exists (select 1 from public.sales_daily s
                   where s.branch_id = new.branch_id
                     and s.sale_date = new.sale_date
                     and s.shift     = new.shift
                     and coalesce(s.sales_total, 0) > 0) then
      return null;      -- ทิ้งการเขียนรอบนี้ ไม่ให้ไปถึงขั้นเขียนทับแถวเดิม
    end if;

    -- ยังไม่มียอด → เก็บแถวไว้แต่ล้างตัวเลข เพื่อให้ไปกดใส่เลขจริงในแอปได้
    new.target_product  := null;  new.target_card    := null;  new.target_total   := null;
    new.sales_product   := null;  new.sales_card     := null;  new.sales_total    := null;
    new.customers       := null;  new.per_head       := null;
    new.allcafe_cups    := null;  new.allcafe_baht   := null;
    new.delivery_bills  := null;  new.delivery_baht  := null;
    new.truewallet_baht := null;  new.truewallet_pct := null;
    new.extra           := null;
    new.edited_by  := 'ระบบ (กันเลขเก่าทับ)';
    new.edited_at  := now();
    new.edit_note  := 'ระบบกันไว้: ยอด/เป้า/ลูกค้า ตรงกับผลัดเดียวกันของวันที่ '
                      || to_char(prev.sale_date, 'DD/MM') || ' เป๊ะ — น่าจะก๊อปฟอร์มมาแล้วลืมแก้ตัวเลขผลัดนี้';
  end if;

  return new;
end
$fn$;

-- ------------------------------------------------------------
-- [2] ผูกเข้ากับตาราง
-- ------------------------------------------------------------
drop trigger if exists trg_sales_daily_guard_stale_copy on public.sales_daily;

create trigger trg_sales_daily_guard_stale_copy
  before insert or update on public.sales_daily
  for each row execute function public.sales_daily_guard_stale_copy();

-- ------------------------------------------------------------
-- [3] ตรวจว่าติดตั้งแล้ว
-- ------------------------------------------------------------
select tgname as "ชื่อทริกเกอร์", tgenabled as "เปิดอยู่ (O=ใช่)"
  from pg_trigger
 where tgrelid = 'public.sales_daily'::regclass
   and not tgisinternal;

select 'sales_copy_guard.sql done' as result;

-- ------------------------------------------------------------
-- [4] ดูของเก่าที่หลุดเข้ามาแล้วก่อนติดตั้งด่านนี้  (แค่ดู ไม่แก้อะไร)
--     ทริกเกอร์กันเฉพาะของที่ "จะเข้ามาใหม่" — แถวเก่าที่คาอยู่ต้องจัดการแยก
-- ------------------------------------------------------------
create or replace view public.v_sales_stale_copies as
select a.id, a.branch_id, a.sale_date, a.shift,
       a.sales_total, a.target_total, a.customers, a.reporter,
       (select max(b.sale_date) from public.sales_daily b
         where b.branch_id = a.branch_id
           and b.shift     = a.shift
           and b.sale_date <  a.sale_date
           and b.sale_date >= a.sale_date - 90
           and b.sales_total  = a.sales_total
           and b.target_total is not distinct from a.target_total
           and round(coalesce(b.customers, 0)::numeric) = round(coalesce(a.customers, 0)::numeric)
       ) as ไปตรงกับวันที่
  from public.sales_daily a
 where coalesce(a.sales_total, 0) > 0
   and a.edited_at is null;        -- แถวที่คนแก้มือไว้แล้ว ถือว่าตรวจแล้ว ไม่แตะ

select branch_id as "สาขา", sale_date as "วันที่", shift as "ผลัด",
       sales_total as "ยอดที่คีย์ไว้", "ไปตรงกับวันที่"
  from public.v_sales_stale_copies
 where "ไปตรงกับวันที่" is not null
 order by branch_id, sale_date, shift;

-- ============================================================
-- [5] (ทางเลือก) ล้างตัวเลขของแถวเก่าที่เป็นการก๊อป
--     ★ ดูผลจาก [4] ให้พอใจก่อน แล้วค่อยเอาคอมเมนต์ออกแล้วรันบล็อกนี้
--     ค่าเดิมถูกสำรองลง orig ทุกแถว → กู้คืนได้ (ดูวิธีท้ายไฟล์)
--     เก็บ "ใบแรก" ของแต่ละชุดไว้เสมอ ล้างเฉพาะใบที่ก๊อปตามมา
-- ============================================================
-- update public.sales_daily d
--    set orig = coalesce(d.orig, '{}'::jsonb) || jsonb_build_object(
--                 'target_total', d.target_total, 'sales_total', d.sales_total,
--                 'sales_product', d.sales_product, 'sales_card', d.sales_card,
--                 'customers', d.customers, 'per_head', d.per_head,
--                 'allcafe_cups', d.allcafe_cups, 'delivery_bills', d.delivery_bills),
--        target_product = null, target_card = null, target_total = null,
--        sales_product  = null, sales_card  = null, sales_total  = null,
--        customers = null, per_head = null,
--        allcafe_cups = null, allcafe_baht = null,
--        delivery_bills = null, delivery_baht = null,
--        truewallet_baht = null, truewallet_pct = null, extra = null,
--        edited_at = now(), edited_by = 'ระบบ (กันเลขเก่าทับ)',
--        edit_note = 'ระบบกันไว้: ยอด/เป้า/ลูกค้า ตรงกับผลัดเดียวกันของวันที่ '
--                    || to_char(v."ไปตรงกับวันที่", 'DD/MM') || ' เป๊ะ — ก๊อปฟอร์มมาแล้วลืมแก้ตัวเลขผลัดนี้'
--   from public.v_sales_stale_copies v
--  where d.id = v.id and v."ไปตรงกับวันที่" is not null;

-- ============================================================
-- วิธีปิดชั่วคราว / ถอนกลับ (รันเฉพาะบรรทัดที่ต้องการ)
-- ============================================================
-- -- ปิดชั่วคราว
-- alter table public.sales_daily disable trigger trg_sales_daily_guard_stale_copy;
--
-- -- เปิดกลับ
-- alter table public.sales_daily enable trigger trg_sales_daily_guard_stale_copy;
--
-- -- ถอนออกทั้งหมด
-- drop trigger if exists trg_sales_daily_guard_stale_copy on public.sales_daily;
-- drop function if exists public.sales_daily_guard_stale_copy();
--
-- -- ดูแถวที่ระบบกันไว้ (ยังไม่มีเลขจริง)
-- select branch_id, sale_date, shift, edit_note
--   from public.sales_daily
--  where sales_total is null and edit_note like 'ระบบกันไว้%'
--  order by sale_date desc, shift;
--
-- -- คืนค่าที่ล้างไปในบล็อก [5] กลับมา
-- update public.sales_daily
--    set target_total  = (orig->>'target_total')::numeric,
--        sales_total   = (orig->>'sales_total')::numeric,
--        sales_product = (orig->>'sales_product')::numeric,
--        sales_card    = (orig->>'sales_card')::numeric,
--        customers     = (orig->>'customers')::numeric,
--        per_head      = (orig->>'per_head')::numeric,
--        allcafe_cups  = (orig->>'allcafe_cups')::numeric,
--        delivery_bills= (orig->>'delivery_bills')::numeric,
--        edited_at = null, edited_by = null, edit_note = null
--  where edited_by = 'ระบบ (กันเลขเก่าทับ)' and orig ? 'sales_total';
