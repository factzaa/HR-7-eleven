-- ============================================================
-- 24 ก.ย. 69 — เพิ่ม "ตำแหน่ง" ให้พนักงาน
-- ใช้กับ: บัตรพนักงานหน้าสรุปรายบุคคล · เอกสารสรุปผลการปฏิบัติงาน · การออกบัตรพนักงาน
-- เดิมระบบมีแค่ is_manager (จริง/เท็จ) จึงแยก ผู้ช่วยผู้จัดการ / หัวหน้าผลัด / พาร์ทไทม์ ไม่ได้
-- รันซ้ำได้ ไม่ทำลายข้อมูลเดิม
-- ============================================================

ALTER TABLE employees ADD COLUMN IF NOT EXISTS position text;

-- เติมค่าเริ่มต้นให้คนที่ยังว่าง (ผู้จัดการอ่านจาก is_manager เดิม)
UPDATE employees SET position = 'ผู้จัดการร้าน'
 WHERE (position IS NULL OR position = '') AND is_manager = true;

UPDATE employees SET position = 'พนักงานร้าน'
 WHERE (position IS NULL OR position = '') AND (is_manager IS NULL OR is_manager = false);

-- ตรวจผล
-- SELECT position, count(*) FROM employees WHERE active = true GROUP BY position ORDER BY 2 DESC;
