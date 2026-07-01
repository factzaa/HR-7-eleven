-- ============================================================
-- 7-Eleven HR — ค่าตั้งระบบทั่วไป (key/value) ที่ HR ปรับได้
-- ใช้เก็บค่าปรับทั่วไปที่ไม่ใช่ความลับ (anon อ่าน/เขียนได้ ผ่านหน้า HR)
-- ค่าแรก: checkout_grace_min = ผ่อนผันก่อนเตือน "ลืมกดออก" (นาที) นับจากเวลาเลิกกะ
-- รันบน Supabase: SQL Editor > วาง > Run
-- ============================================================

create table if not exists public.app_settings (
  key   text primary key,
  value text
);

insert into public.app_settings (key, value) values
  ('checkout_grace_min', '15')
on conflict (key) do nothing;

alter table public.app_settings enable row level security;
drop policy if exists app_settings_all on public.app_settings;
create policy app_settings_all on public.app_settings
  for all to anon, authenticated using (true) with check (true);

select key, value from public.app_settings order by key;
