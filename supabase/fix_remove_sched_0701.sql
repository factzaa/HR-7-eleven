-- ลบตารางเวรที่จัดผิด (ตาล + อาม กะ 3 วันที่ 1/7/2026) ที่ค้างทำให้ขึ้นกลุ่มเสี่ยงวินัย "ขาด 1"
-- รันบน Supabase: SQL Editor > วาง > Run
delete from public.schedules
where work_date = '2026-07-01'
  and emp_id in ('1077572', '1077578');

-- ตรวจผลว่าไม่เหลือแถววันที่ 1/7 ของทั้งคู่แล้ว
select emp_id, work_date, shift_id
from public.schedules
where work_date = '2026-07-01'
  and emp_id in ('1077572', '1077578');
