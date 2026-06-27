-- ============================================================
-- 7-Eleven HR System — RLS Policies (เฟสแรก: คงความปลอดภัยแบบง่าย)
-- รันไฟล์นี้ใน SQL Editor เพื่อปลดล็อกให้หน้าเว็บอ่าน/เขียนข้อมูลได้
-- ปลอดภัยที่จะรันซ้ำ (drop policy ก่อนสร้างใหม่)
--
-- หมายเหตุ: เฟสนี้ยังไม่มีระบบล็อกอินจริง (ตามที่เลือก "คงแบบเดิมง่ายๆ")
-- จึงเปิดให้ anon เข้าถึงตารางงานได้กว้าง ยกเว้น app_config (รหัส HR) ที่ล็อกไว้
-- เมื่อถึง Phase 4 จะรัดกุมขึ้นด้วย Supabase Auth + แยกสิทธิ์ HR/พนักงาน
-- ============================================================

-- เปิด RLS ทุกตาราง
alter table public.branches   enable row level security;
alter table public.shifts     enable row level security;
alter table public.holidays   enable row level security;
alter table public.employees  enable row level security;
alter table public.attendance enable row level security;
alter table public.warnings   enable row level security;
alter table public.leaves     enable row level security;
alter table public.app_config enable row level security;

-- ---------- ข้อมูลอ้างอิง: อ่านได้ ----------
drop policy if exists anon_read_branches on public.branches;
create policy anon_read_branches on public.branches for select to anon, authenticated using (true);

drop policy if exists anon_read_shifts on public.shifts;
create policy anon_read_shifts on public.shifts for select to anon, authenticated using (true);

drop policy if exists anon_rw_holidays on public.holidays;
create policy anon_rw_holidays on public.holidays for all to anon, authenticated using (true) with check (true);

-- ---------- พนักงาน: อ่าน + เขียน (เพิ่ม/แก้ไข/ลงทะเบียนใบหน้า) ----------
-- [PDPA] เฟสนี้ anon อ่านได้ทุกคอลัมน์ รวมข้อมูลอ่อนไหว — จะจำกัดใน Phase 4
drop policy if exists anon_rw_employees on public.employees;
create policy anon_rw_employees on public.employees for all to anon, authenticated using (true) with check (true);

-- ---------- การลงเวลา: อ่าน/เพิ่ม/แก้ไข (เช็กอิน-เอาท์ + รายงาน HR) ----------
drop policy if exists anon_rw_attendance on public.attendance;
create policy anon_rw_attendance on public.attendance for all to anon, authenticated using (true) with check (true);

-- ---------- ใบเตือน + การลา: อ่าน/เขียน (หน้า HR) ----------
drop policy if exists anon_rw_warnings on public.warnings;
create policy anon_rw_warnings on public.warnings for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_rw_leaves on public.leaves;
create policy anon_rw_leaves on public.leaves for all to anon, authenticated using (true) with check (true);

-- ---------- app_config: ไม่เปิดให้ anon เข้าถึงตรงๆ ----------
-- (ไม่สร้าง policy = ถูกบล็อกทั้งหมด) เข้าผ่านฟังก์ชัน hr_check_password เท่านั้น

-- ============================================================
-- เสร็จแล้ว: กลับไปรีเฟรชหน้าเว็บ (F5) แล้วพิมพ์ 001 ควรขึ้น "สมชาย ใจดี"
-- อย่าลืมรัน functions.sql เวอร์ชันใหม่ (hr_check_password เป็น SECURITY DEFINER)
-- ============================================================
