-- ============================================================
-- 7-Eleven HR — แก้ยอดขายรายผลัดในแอป (กรณีพนักงานคีย์ในไลน์มาผิด)
-- เพิ่มคอลัมน์เก็บ "ใครแก้ เมื่อไร เพราะอะไร" + ค่าเดิมก่อนแก้
-- รันบน Supabase: SQL Editor > วาง > Run (รันซ้ำได้ ไม่กระทบข้อมูลเดิม)
-- ============================================================

alter table public.sales_daily
  add column if not exists edited_at timestamptz,          -- แก้ล่าสุดเมื่อไร (ว่าง = ยังไม่เคยแก้)
  add column if not exists edited_by text,                 -- ใครแก้ (ชื่อผู้ใช้ HR / ผจก.)
  add column if not exists edit_note text,                 -- เหตุผลที่แก้
  add column if not exists orig      jsonb;                -- ค่าก่อนแก้ครั้งแรก (เป้า/ยอด/ลูกค้า/ต่อหัว)

-- ใช้ตอนนำเข้าแชทไลน์ซ้ำ: หาแถวที่เคยแก้มือ เพื่อไม่ให้ถูกทับ
create index if not exists idx_sales_daily_edited on public.sales_daily (edited_at) where edited_at is not null;

select 'sales_edit.sql done' as result;
