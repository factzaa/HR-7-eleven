-- ============================================================
-- วันอบรม / ปฏิบัติงานนอกสถานที่ — นับเป็นวันทำงาน (ไม่นับขาด) โดยไม่ต้องสแกนหน้า
-- HR บันทึกให้ → สร้างรายการ attendance status='TRAINING' (check_in/out = เวลากะ, OT=0)
-- รันบน Supabase: SQL Editor > วาง > Run (รันซ้ำได้)
-- ============================================================

alter table public.attendance add column if not exists duty_note text;  -- เหตุผล/หัวข้ออบรม

select 'training_day.sql done' as result;
