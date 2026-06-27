-- ============================================================
-- 7-Eleven HR System — Storage Policies
-- เปิดให้หน้าเว็บ (anon) อัปโหลด/อ่านรูปใน 2 bucket ได้
-- รันใน SQL Editor (ปลอดภัยที่จะรันซ้ำ)
--
-- bucket ที่ตั้งเป็น Public จะ "อ่าน" รูปได้อยู่แล้ว แต่ "อัปโหลด" ต้องมี policy นี้
-- ============================================================

-- ---------- attendance-photos: รูปตอนเช็กอิน ----------
drop policy if exists "anon_insert_attendance_photos" on storage.objects;
create policy "anon_insert_attendance_photos" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'attendance-photos');

drop policy if exists "anon_update_attendance_photos" on storage.objects;
create policy "anon_update_attendance_photos" on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'attendance-photos')
  with check (bucket_id = 'attendance-photos');

drop policy if exists "anon_read_attendance_photos" on storage.objects;
create policy "anon_read_attendance_photos" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'attendance-photos');

-- ---------- employee-photos: รูปโปรไฟล์พนักงาน (ใช้ในหน้า HR) ----------
drop policy if exists "anon_insert_employee_photos" on storage.objects;
create policy "anon_insert_employee_photos" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'employee-photos');

drop policy if exists "anon_update_employee_photos" on storage.objects;
create policy "anon_update_employee_photos" on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'employee-photos')
  with check (bucket_id = 'employee-photos');

drop policy if exists "anon_read_employee_photos" on storage.objects;
create policy "anon_read_employee_photos" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'employee-photos');

-- ============================================================
-- เสร็จแล้ว: กลับไปหน้าเว็บ กด F5 แล้วกดเข้างานใหม่ ควรสำเร็จ
-- ============================================================
