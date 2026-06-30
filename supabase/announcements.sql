-- ============================================================
-- ตาราง announcements — ประกาศ/ข้อความที่ HR เขียนถึงพนักงานเอง
-- พนักงานเห็นเป็นแบนเนอร์หน้าลงเวลา + เด้งในป๊อปอัพหลังเช็กอิน
-- รันใน Supabase SQL Editor (ปลอดภัยที่จะรันซ้ำ)
-- ============================================================
create table if not exists public.announcements (
  id          bigint generated always as identity primary key,
  message     text not null,
  level       text not null default 'info',     -- info / warn / urgent (สีต่างกัน)
  created_by  text default 'HR',
  created_at  timestamptz not null default now(),
  active      boolean not null default true,
  expire_date date                              -- ว่าง = ไม่หมดอายุ · ถ้าตั้ง จะหยุดแสดงหลังวันนั้น
);

create index if not exists idx_announce_active on public.announcements (active, expire_date);

alter table public.announcements enable row level security;
drop policy if exists anon_rw_announcements on public.announcements;
create policy anon_rw_announcements on public.announcements
  for all to anon, authenticated using (true) with check (true);
