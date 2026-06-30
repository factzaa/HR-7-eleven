-- ============================================================
-- ปิดงานให้คนที่ "ลืมกดออก" อย่างปลอดภัย (ไม่ลบข้อมูลจริง)
-- ตั้ง check_out = เวลาเลิกกะ + ปิดสถานะ เฉพาะแถวที่เลยเวลาเลิกกะแล้ว
-- → เก็บประวัติวันทำงานไว้ครบ (คิดเงินเดือนได้) และหยุดแจ้งเตือน "ลืมกดออก"
-- คนที่ยังทำงานอยู่ (ยังไม่ถึงเวลาเลิกกะ) จะไม่ถูกแตะ
-- รันใน Supabase SQL Editor (ปลอดภัยที่จะรันซ้ำ)
-- ============================================================

-- ดูก่อนว่าใครจะโดนปิด (ไม่บังคับ)
-- select a.work_date, a.emp_id, a.check_in, s.end_time
-- from public.attendance a join public.shifts s on s.shift_id = a.shift_id
-- where a.check_out is null and s.end_time > s.start_time
--   and (now() at time zone 'Asia/Bangkok') > (a.work_date + s.end_time)
-- order by a.work_date;

update public.attendance a
set check_out = ((a.work_date + s.end_time) at time zone 'Asia/Bangkok'),
    status    = 'CLOSED'
from public.shifts s
where a.shift_id = s.shift_id
  and a.check_out is null
  and s.end_time is not null
  and s.end_time > s.start_time                                   -- กะปกติ (เว้นกะข้ามคืน)
  and (now() at time zone 'Asia/Bangkok') > (a.work_date + s.end_time);  -- เลยเวลาเลิกกะแล้วเท่านั้น

-- หมายเหตุ:
-- • OT จะเป็น 0 (ถือว่าออกตรงเวลาเลิกกะ) เพราะไม่รู้เวลาออกจริง
-- • กะข้ามคืน (เลิกเช้าวันรุ่งขึ้น) ไม่ถูกปิดอัตโนมัติด้วยสคริปต์นี้ — ปิดมือถ้าจำเป็น
-- • ⚠️ ห้ามใช้ DELETE กับ attendance ที่ check_out is null เพราะจะลบคนที่กำลังทำงานอยู่ด้วย
