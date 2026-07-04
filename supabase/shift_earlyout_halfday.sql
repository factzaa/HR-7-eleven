-- ============================================================
-- 7-Eleven HR — กะครึ่งวัน (day_value) + ออกก่อนเวลา (early_out)
-- ============================================================

-- 1) กะครึ่งวัน: น้ำหนักการนับวันของกะ (1.0 = เต็มวัน, 0.5 = ครึ่งวัน)
alter table shifts add column if not exists day_value numeric not null default 1.0;

-- 2) ออกก่อนเวลา: เก็บจำนวนนาทีที่ออกก่อนเวลาเลิกกะ (บันทึกตอนกดออกงาน)
alter table attendance add column if not exists early_out_min integer;

-- 3) ค่าตั้งค่าเกณฑ์ (app_settings เป็น key/value อยู่แล้ว — insert ค่าเริ่มต้นถ้ายังไม่มี)
--    early_out_grace_min : ออกก่อนไม่เกิน N นาที ไม่นับว่าออกก่อน (ผ่อนผัน)
--    early_out_warn_days : ออกก่อนเวลาเกิน N วัน/รอบ = ขึ้นเตือน (watch)
insert into app_settings(key, value)
select 'early_out_grace_min', '10'
where not exists (select 1 from app_settings where key = 'early_out_grace_min');
insert into app_settings(key, value)
select 'early_out_warn_days', '3'
where not exists (select 1 from app_settings where key = 'early_out_warn_days');
