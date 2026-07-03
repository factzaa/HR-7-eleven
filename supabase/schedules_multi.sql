-- ============================================================
-- ปลดล็อกตารางเวรให้จัดได้หลายกะ/วัน (ควบกะ) + กำหนดสาขาต่อกะ
-- รันบน Supabase: SQL Editor > วาง > Run (รันซ้ำได้)
-- ============================================================

-- เดิม unique(emp_id, work_date) = 1 กะ/วัน → เปลี่ยนเป็น (emp_id, work_date, shift_id)
alter table public.schedules drop constraint if exists schedules_emp_id_work_date_key;
create unique index if not exists schedules_emp_date_shift on public.schedules (emp_id, work_date, shift_id);

select 'schedules_multi.sql done' as result;
