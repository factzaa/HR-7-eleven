-- ============================================================
-- ล้าง OT ของพนักงาน 2 คน (ตามคำขอ 3 ก.ค.)
--   ขวัญจิรา ยาดี (มิน)   emp_id = 0874730
--   เกศทิพย์ สายบุญเที่ยง (เกศ) emp_id = 1077518
-- รันบน Supabase: SQL Editor > วาง > Run
-- ============================================================

-- ดูข้อมูลก่อนล้าง (จะได้เห็นว่าจะแก้กี่แถว)
select emp_id, work_date, check_in, check_out, ot_hours
from public.attendance
where emp_id in ('0874730','1077518')
  and coalesce(ot_hours,0) <> 0
order by emp_id, work_date;

-- ล้าง OT ให้เป็น 0
update public.attendance
set ot_hours = 0
where emp_id in ('0874730','1077518')
  and coalesce(ot_hours,0) <> 0;

-- ยืนยันผล (ควรไม่เหลือแถวที่ ot_hours <> 0)
select emp_id, count(*) as rows_with_ot
from public.attendance
where emp_id in ('0874730','1077518')
  and coalesce(ot_hours,0) <> 0
group by emp_id;

select 'clear_ot_two_0703.sql done' as result;
