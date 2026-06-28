-- ============================================================
-- ลบประเภท "ลาพักร้อน" ออกจากระบบ
-- รันบน Supabase: SQL Editor > วาง > Run
-- (ใบลาที่เคยยื่นเป็นลาพักร้อนเดิมจะยังอยู่ในประวัติ ไม่ถูกลบ)
-- ============================================================

delete from public.leave_types where type = 'ลาพักร้อน';

select type, advance_days, quota_per_year, require_doc from public.leave_types order by sort;
