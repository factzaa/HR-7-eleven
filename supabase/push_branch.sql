-- ============================================================
-- 7-Eleven HR — Web Push แยกตามสาขา
-- เพิ่ม branch_id ให้แต่ละอุปกรณ์ที่สมัครรับแจ้งเตือน
--   branch_id = รหัสสาขา → เครื่องนี้รับเฉพาะแจ้งเตือนของสาขานั้น
--   branch_id ว่าง (null) → เครื่องส่วนกลาง รับทุกสาขา
-- รันบน Supabase: SQL Editor > วาง > Run (รันหลัง push_notifications.sql)
-- ============================================================

alter table public.push_subscriptions add column if not exists branch_id text;

select 'push_branch.sql done' as result;
