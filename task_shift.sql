-- ============================================================
-- 7-Eleven HR — เพิ่ม "กะ" ให้ระบบงานในกะ
-- งานแต่ละอย่างผูกกับกะได้ (เช้า/บ่าย/ดึก/Delivery) หรือ "ทุกกะ" (ว่าง)
-- รันบน Supabase: SQL Editor > วาง > Run  (รันหลัง task_system.sql)
-- ============================================================

alter table public.task_defs        add column if not exists shift_id text;  -- กะที่ต้องทำงานนี้ (ว่าง = ทุกกะ)
alter table public.task_assignments add column if not exists shift_id text;  -- กะของงานที่มอบหมาย/ทำ

select 'task_shift.sql done' as result;
