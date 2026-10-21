-- ============================================================
-- ถังขยะใบสมัคร — เพิ่มคอลัมน์ที่ระบบใหม่ต้องใช้
-- สร้างเมื่อ 21 ต.ค. 2569  ·  รันครั้งเดียว (รันซ้ำได้ ไม่พัง)
--
-- หลังรัน: ปุ่ม "ลบใบสมัคร" จะเปลี่ยนเป็นย้ายลงถังขยะ
--          กู้คืนได้ภายใน 30 วัน · ครบ 30 วันระบบลบถาวรให้เอง
--          ไฟล์เอกสารใน Storage ไม่ถูกลบทั้งสองกรณี
--
-- ลำดับที่ถูกต้อง: รัน SQL นี้ "ก่อน" แล้วค่อยอัปไฟล์เว็บขึ้น GitHub
-- ============================================================

alter table applicants
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by text;

-- ดัชนีช่วยให้การกรอง "ยังไม่ถูกลบ" เร็ว (หน้ารับสมัครงานเรียกบ่อย)
create index if not exists applicants_deleted_at_idx
  on applicants (deleted_at)
  where deleted_at is null;


-- ---------- ตรวจผล ----------
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'applicants'
  and column_name in ('deleted_at','deleted_by');

-- ควรได้ 2 แถว: deleted_at (timestamp with time zone) · deleted_by (text)
