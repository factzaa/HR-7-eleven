-- ============================================================
-- แก้ย้อนหลัง: แถวลงเวลาที่ "กะว่าง" + "ไม่คำนวณสาย"
-- สาเหตุ: เดิม checkIn ใช้ default_shift (ว่าง) แทนกะจากตารางเวร
-- ไฟล์นี้: (1) เติม shift_id จากตารางเวร (2) คำนวณ late_min ใหม่
-- รันใน Supabase SQL Editor (ปลอดภัยที่จะรันซ้ำ)
-- ⚠️ ต้องรัน shift_codes.sql + schedules.sql ไปแล้ว และ calc_late_min ต้องมี
-- ============================================================

-- (1) เติมกะจากตารางเวร ให้แถวลงเวลาที่ยังไม่มีกะ
update public.attendance a
set shift_id = s.shift_id
from public.schedules s
where a.emp_id = s.emp_id
  and a.work_date = s.work_date
  and (a.shift_id is null or a.shift_id = '')
  and s.shift_id is not null;

-- (2) คำนวณสายใหม่ทุกแถวที่มีเวลาเข้า + มีกะแล้ว
--     (คนตรงเวลาจะได้ 0 เหมือนเดิม, คนสายที่เคยเป็น 0 จะถูกแก้ให้ถูก)
--     หมายเหตุ: ถ้าเคยปรับ late ด้วยมือ บรรทัดนี้จะคำนวณทับ
--     ถ้าต้องการจำกัดเฉพาะช่วงวันที่ ให้เพิ่ม:  and a.work_date >= '2026-06-30'
update public.attendance a
set late_min = public.calc_late_min(a.shift_id, a.check_in)
where a.check_in is not null
  and a.shift_id is not null;

-- ตรวจผล: ดูแถววันนี้
-- select work_date, emp_id, shift_id, check_in, late_min from public.attendance
-- where work_date = (now() at time zone 'Asia/Bangkok')::date order by check_in;
