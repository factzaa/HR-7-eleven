-- ============================================================
-- 7-Eleven HR — Web Push (แจ้งเตือนฝั่ง HR แม้ปิดแอป)
-- เก็บ subscription ของอุปกรณ์ HR/โทรศัพท์ร้าน + ledger กันส่งซ้ำ
-- รันบน Supabase: SQL Editor > วาง > Run
-- ============================================================

-- อุปกรณ์ที่สมัครรับแจ้งเตือน (1 แถว = 1 เบราว์เซอร์/เครื่อง)
create table if not exists public.push_subscriptions (
  id         bigint generated always as identity primary key,
  endpoint   text not null unique,        -- URL ปลายทางของ push service
  p256dh     text not null,               -- กุญแจเข้ารหัส (จาก browser)
  auth       text not null,               -- auth secret (จาก browser)
  label      text,                        -- ชื่อเครื่อง เช่น "โทรศัพท์ร้าน A"
  created_at timestamptz not null default now()
);

-- บันทึกว่าเหตุการณ์ไหน "ส่งแจ้งเตือนไปแล้ว" เพื่อไม่ให้ส่งซ้ำทุกครั้งที่ cron รัน
create table if not exists public.notify_sent (
  event_key  text primary key,            -- เช่น absent:0874779:2026-06-29:S1
  sent_at    timestamptz not null default now()
);
create index if not exists idx_notify_sent_at on public.notify_sent (sent_at);

alter table public.push_subscriptions enable row level security;
alter table public.notify_sent        enable row level security;
drop policy if exists push_subs_all  on public.push_subscriptions;
drop policy if exists notify_sent_all on public.notify_sent;
-- หน้า HR (anon) ต้องเพิ่ม/ลบ subscription ของตัวเองได้
create policy push_subs_all  on public.push_subscriptions for all to anon, authenticated using (true) with check (true);
-- ledger ปกติ Edge Function (service role) เป็นคนเขียน — เปิดไว้เพื่อความสะดวก
create policy notify_sent_all on public.notify_sent        for all to anon, authenticated using (true) with check (true);

select 'push_notifications.sql done' as result;
