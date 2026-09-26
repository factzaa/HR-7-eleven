-- ============================================================
-- 26 ก.ย. 69 — ลอก "ก. ข. ค. ง." ที่ฝังอยู่ในเนื้อตัวเลือกข้อสอบออก
--
-- ปัญหา: ผู้ออกข้อสอบพิมพ์ตัวอักษรนำไว้ในตัวเลือกเอง เช่น "ก. จัดเรียงสินค้า..."
--        แต่หน้าทำข้อสอบ "สุ่มลำดับตัวเลือก" กันลอกกัน → ตัวอักษรเลยสลับมั่ว
--        พนักงานเห็นเป็น "ค. … / ก. … / ง. … / ข. …"
-- แก้:   เอาตัวอักษรนำออกจากข้อมูล แล้วให้หน้าจอใส่ 1. 2. 3. 4. ตามลำดับที่แสดงจริงแทน
--
-- ⚠ ไม่กระทบเฉลย — answer เก็บเป็น "ลำดับที่" ไม่ใช่ตัวอักษร การลอกข้อความไม่ทำให้เฉลยเพี้ยน
-- ⚠ ไม่กระทบผลสอบเดิม — exam_attempts เก็บคำตอบเป็นลำดับที่เช่นกัน
--
-- รันตามลำดับ 1 → 2 → 3  (ขั้น 1 คือสำรอง ห้ามข้าม)
-- ============================================================

-- ---------- 1) สำรองก่อน (กู้คืนได้ถ้าผลไม่ถูกใจ) ----------
create table if not exists exam_questions_backup_2569_09_26 as
select id, exam_id, seq, question, choices, answer, now() as backed_up_at
from exam_questions;

select count(*) as สำรองแล้วกี่ข้อ from exam_questions_backup_2569_09_26;


-- ---------- 2) ดูก่อนว่าจะเปลี่ยนอะไรบ้าง (ยังไม่แก้จริง) ----------
with cleaned as (
  select id, exam_id, left(question, 50) as คำถาม,
         choices as ของเดิม,
         (select jsonb_agg(trim(regexp_replace(c #>> '{}', '^\s*([ก-ฉ]|[1-9][0-9]?|[a-zA-Z])\s*[.):\-]\s+', '')) order by ord)
            from jsonb_array_elements(choices) with ordinality as t(c, ord)) as ของใหม่
  from exam_questions
  where choices::text ~ '"\s*([ก-ฉ]|[1-9][0-9]?|[a-zA-Z])\s*[.):\-]\s'
)
select * from cleaned order by exam_id, id;


-- ---------- 3) แก้จริง ----------
update exam_questions q
   set choices = (
         select jsonb_agg(trim(regexp_replace(c #>> '{}', '^\s*([ก-ฉ]|[1-9][0-9]?|[a-zA-Z])\s*[.):\-]\s+', '')) order by ord)
           from jsonb_array_elements(q.choices) with ordinality as t(c, ord))
 where q.choices::text ~ '"\s*([ก-ฉ]|[1-9][0-9]?|[a-zA-Z])\s*[.):\-]\s';


-- ---------- 4) ตรวจผล — ต้องได้ 0 ทั้งคู่ ----------
select count(*) as ยังเหลือตัวอักษรนำ
  from exam_questions
 where choices::text ~ '"\s*([ก-ฉ]|[1-9][0-9]?|[a-zA-Z])\s*[.):\-]\s';

select count(*) as จำนวนตัวเลือกเปลี่ยนไป
  from exam_questions q join exam_questions_backup_2569_09_26 b on b.id = q.id
 where q.choices is distinct from b.choices;


-- ---------- (ถ้าต้องการย้อนกลับ) ----------
-- update exam_questions q set choices = b.choices
--   from exam_questions_backup_2569_09_26 b where b.id = q.id;
