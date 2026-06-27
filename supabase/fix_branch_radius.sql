-- ============================================================
-- แก้รัศมี geofence สาขา B002 (อโศก) กลับจากค่าทดสอบ 20000 ม. → 20 ม.
-- รันบน Supabase: Dashboard → SQL Editor → วางทั้งหมด → Run
-- (หรือใช้ Table Editor → ตาราง branches → แถว B002 → แก้ช่อง radius_m เป็น 20)
-- ============================================================

update public.branches
set    radius_m = 20
where  branch_id = 'B002';

-- ตรวจผล
select branch_id, name, lat, lng, radius_m
from   public.branches
order  by branch_id;

-- หมายเหตุ: GPS บนมือถือมักคลาดเคลื่อน 5–30 ม. ถ้ารัศมี 20 ม. แคบเกินไป
-- จนพนักงานที่ยืนหน้าร้านจริงเช็กอินไม่ผ่าน ให้ขยับเป็น 50–150 ม. ได้ตามหน้างาน
