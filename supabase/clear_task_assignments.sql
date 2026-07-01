-- ============================================================
-- ลบ "งานในกะ" (task_assignments) ที่ลงผิดวัน/ซ้ำ ออกทีเดียว
-- ใช้ตอนเคลียร์ข้อมูลทดสอบหรืองานที่เกิดจากบั๊กก่อนหน้า
-- ⚠️ ลบถาวร กู้คืนไม่ได้ — ดูให้ชัดก่อนกด Run
-- วิธีใช้: แก้เงื่อนไข WHERE ให้ตรง แล้ว Run บน Supabase SQL Editor
-- ============================================================

-- 1) ดูก่อนว่าจะโดนลบกี่แถว (แนะนำให้รันอันนี้ก่อนเสมอ)
select work_date, shift_id, branch_id, count(*) as จำนวน
from public.task_assignments
where work_date = '2026-07-01'          -- << แก้เป็นวันที่ต้องการเคลียร์
  -- and branch_id = 'B001'             -- << (ถ้าจะเจาะจงสาขา ให้เอา -- ออก)
  -- and shift_id  = 'N'                -- << (ถ้าจะเจาะจงกะ เช่น ดึก)
group by work_date, shift_id, branch_id
order by work_date, shift_id;

-- 2) ลบจริง (เอา -- ออกจากบล็อกด้านล่างเมื่อยืนยันแล้ว)
-- delete from public.task_assignments
-- where work_date = '2026-07-01'         -- << วันที่
--   -- and branch_id = 'B001'
--   -- and shift_id  = 'N'
-- ;

-- ตัวอย่างอื่น:
-- ลบเฉพาะงานที่ "ยังไม่ทำ" (todo) ของวันนั้น:
-- delete from public.task_assignments where work_date='2026-07-01' and status='todo';
