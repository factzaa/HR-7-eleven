-- ============================================================
-- เปลี่ยนชื่อประเภทการลา "ลากิจ" → "แจ้งขอหยุดฉุกเฉิน"
-- (ฉุกเฉิน = ไม่ต้องลาล่วงหน้า จึงตั้ง advance_days = 0)
-- รันบน Supabase: SQL Editor > วาง > Run
-- ============================================================

update public.leave_types
set type = 'แจ้งขอหยุดฉุกเฉิน', advance_days = 0
where type = 'ลากิจ';

update public.leaves set type = 'แจ้งขอหยุดฉุกเฉิน' where type = 'ลากิจ';

select type, advance_days, quota_per_year, require_doc from public.leave_types order by sort;
