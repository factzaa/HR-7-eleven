-- ============================================================
-- 7-Eleven HR System — ข้อมูลตั้งต้นสำหรับทดสอบ
-- รันหลัง schema.sql
-- แก้พิกัดสาขา/รหัสพนักงานให้ตรงของจริงได้
-- ============================================================

-- ---------- กะ ----------
insert into public.shifts (shift_id, name, start_time, end_time, grace_min) values
  ('M', 'เช้า', '07:00', '15:00', 5),
  ('A', 'บ่าย', '15:00', '23:00', 5),
  ('N', 'ดึก',  '23:00', '07:00', 5)
on conflict (shift_id) do update
  set name = excluded.name, start_time = excluded.start_time,
      end_time = excluded.end_time, grace_min = excluded.grace_min;

-- ---------- สาขา (แก้พิกัดเป็นของจริง) ----------
insert into public.branches (branch_id, name, lat, lng, radius_m) values
  ('B001', 'สาขาสยามสแควร์',   13.745300, 100.534200, 80),
  ('B002', 'สาขาอโศก',         13.736700, 100.560300, 80)
on conflict (branch_id) do update
  set name = excluded.name, lat = excluded.lat,
      lng = excluded.lng, radius_m = excluded.radius_m;

-- ---------- พนักงานทดลอง ----------
insert into public.employees (emp_id, name, nickname, start_date, default_shift, branch_id, weekly_off, phone, active) values
  ('001', 'สมชาย ใจดี',   'ชาย', '2025-01-15', 'M', 'B001', 'Sun',     '0812345678', true),
  ('002', 'สมหญิง รักงาน', 'หญิง','2025-03-01', 'A', 'B001', 'Sat,Sun', '0823456789', true),
  ('003', 'อนุชา ขยัน',    'ชา',  '2024-11-20', 'N', 'B002', '',         '0834567890', true)
on conflict (emp_id) do nothing;

-- ---------- วันหยุดตัวอย่าง ----------
insert into public.holidays (date, name, type, active) values
  ('2026-01-01', 'วันขึ้นปีใหม่', 'ราชการ', true),
  ('2026-04-13', 'วันสงกรานต์',   'ราชการ', true)
on conflict (date) do nothing;

-- ---------- ตั้งค่าระบบ: รหัส HR ----------
-- เริ่มต้นใช้รหัสง่าย ๆ ก่อน (เปลี่ยนได้ที่นี่) — ดู SETUP.md เรื่องการ hash ภายหลัง
insert into public.app_config (key, value) values
  ('hr_password', 'admin1234'),
  ('face_threshold', '0.5')
on conflict (key) do update set value = excluded.value;
