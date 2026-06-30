-- ============================================================
-- 7-Eleven HR — ผลัดหลัก (จัดกลุ่มกะเข้า เช้า/บ่าย/ดึก)
-- ใช้กับระบบงานผลัด: งาน/กระดาน/ตรวจ อิง "ผลัดหลัก" ของแต่ละกะ
-- main_shift = shift_id ของผลัดหลักที่กะนี้สังกัด (ว่าง = พิเศษ ไม่นับในวงจรตรวจ)
-- รันบน Supabase: SQL Editor > วาง > Run
-- ============================================================

alter table public.shifts add column if not exists main_shift text;

-- กะหลักทั้ง 3 ให้สังกัดตัวเอง (M=เช้า, A=บ่าย, N=ดึก หรืออิงชื่อ)
update public.shifts set main_shift = shift_id
where (shift_id in ('M','A','N') or name in ('เช้า','บ่าย','ดึก')) and main_shift is null;

-- กะที่เหลือ (Delivery, 8.00-18.00 ฯลฯ) ปล่อยว่างไว้ = พิเศษ → HR ค่อยแท็กเข้าผลัดหลักในหน้า "ตั้งค่ากะ"

select shift_id, name, start_time, main_shift from public.shifts order by start_time;
