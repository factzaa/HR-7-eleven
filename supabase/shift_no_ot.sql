-- ============================================================
-- กะที่ไม่คิด OT (เช่น กะ ผจก.) — ติ๊กได้ต่อกะในหน้า HR → ตั้งค่ากะ
-- รันบน Supabase: SQL Editor > วาง > Run (รันซ้ำได้)
-- ============================================================

-- คอลัมน์ธง "ไม่คิด OT" ต่อกะ
alter table public.shifts add column if not exists no_ot boolean not null default false;

-- (ทางเลือก) ตั้งค่าให้กะ ผจก. เลยจาก SQL — ปรับชื่อ/รหัสกะให้ตรงของคุณ
-- ดูรายชื่อกะทั้งหมดก่อน:
--   select shift_id, name, no_ot from public.shifts order by name;
-- แล้วตั้ง no_ot = true ให้กะที่ต้องการ เช่น:
--   update public.shifts set no_ot = true where name ilike '%ผจก%' or name ilike '%ผู้จัดการ%';

-- ล้าง OT ย้อนหลังของกะที่ไม่คิด OT ให้เป็น 0 (รันหลังตั้ง no_ot=true แล้ว)
update public.attendance a
set ot_hours = 0
from public.shifts s
where s.shift_id = a.shift_id
  and s.no_ot = true
  and a.ot_hours is distinct from 0;

select 'shift_no_ot.sql done — อย่าลืมตั้ง no_ot=true ให้กะ ผจก. (ในหน้า HR หรือด้วย SQL ด้านบน)' as note;
