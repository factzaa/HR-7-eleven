-- ============================================================
-- เปลี่ยนชื่อประเภทการลา "อื่นๆ" → "แจ้งขอหยุด"
-- รันบน Supabase: SQL Editor > วาง > Run
-- ============================================================

-- เปลี่ยนชื่อในตารางเงื่อนไขการลา
update public.leave_types set type = 'แจ้งขอหยุด' where type = 'อื่นๆ';

-- เปลี่ยนชื่อในใบลาเดิม (ถ้ามี) ให้ตรงกัน
update public.leaves set type = 'แจ้งขอหยุด' where type = 'อื่นๆ';

select type, advance_days, quota_per_year, require_doc from public.leave_types order by sort;
