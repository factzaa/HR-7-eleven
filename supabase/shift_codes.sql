-- ============================================================
-- 7-Eleven HR — โค้ดย่อกะ (สำหรับคีย์จัดตาราง) + กะ Delivery + เปิดสิทธิ์แก้กะ
-- รันบน Supabase: SQL Editor > วาง > Run (รันซ้ำได้)
-- ============================================================

-- คอลัมน์ code = อักษร/เลขย่อที่ใช้คีย์ในตารางเวร (เช่น 1,2,3,D)
alter table public.shifts add column if not exists code   text;
alter table public.shifts add column if not exists active boolean not null default true;

-- ตั้งโค้ดให้กะเดิม: เช้า=1 บ่าย=2 ดึก=3
update public.shifts set code='1' where shift_id='M' and code is null;
update public.shifts set code='2' where shift_id='A' and code is null;
update public.shifts set code='3' where shift_id='N' and code is null;

-- เพิ่มกะ Delivery (วิ่งส่ง) โค้ด D — แก้เวลาได้ภายหลังในหน้าตั้งค่ากะ
insert into public.shifts (shift_id, name, start_time, end_time, grace_min, code, active) values
  ('D', 'Delivery (วิ่งส่ง)', '09:00', '18:00', 5, 'D', true)
on conflict (shift_id) do update set code = excluded.code;

-- โค้ดห้ามซ้ำ (เทียบแบบไม่สนตัวพิมพ์)
create unique index if not exists uq_shifts_code on public.shifts (lower(code)) where code is not null;

-- เปิดให้หน้า HR เพิ่ม/แก้/ลบกะได้ (เดิมเปิดแค่ select)
alter table public.shifts enable row level security;
drop policy if exists anon_read_shifts on public.shifts;
drop policy if exists anon_rw_shifts  on public.shifts;
create policy anon_rw_shifts on public.shifts
  for all to anon, authenticated using (true) with check (true);

select shift_id, code, name, start_time, end_time, grace_min from public.shifts order by start_time;
