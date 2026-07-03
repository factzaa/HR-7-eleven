-- ============================================================
-- 7-Eleven HR — ปิดงานอัตโนมัติเมื่อพนักงานลืมกดออก + ควบกะต่อ + คำขอแก้ไขเวลาออก
-- รันบน Supabase: SQL Editor > วาง > Run (รันซ้ำได้)
-- ============================================================

-- คอลัมน์เสริมใน attendance
alter table public.attendance add column if not exists auto_closed  boolean not null default false;  -- ระบบปิดงานให้ (ลืมกดออก) → OT=0
alter table public.attendance add column if not exists extend_until timestamptz;                      -- ประกาศ "ควบกะต่อ" ถึงเวลานี้ (ห้ามปิดก่อน)

-- ค่าตั้งเวลาปิดงานอัตโนมัติ (นาทีหลังเวลาเลิกกะ) — checkout_grace_min ใช้เป็น "เวลาเตือน" อยู่แล้ว
insert into public.app_settings (key, value) values ('checkout_autoclose_min', '60')
on conflict (key) do nothing;

-- คำขอแก้ไขเวลาออก (พนักงานยื่น → หัวหน้า/HR อนุมัติ)
create table if not exists public.checkout_corrections (
  id             bigint generated always as identity primary key,
  emp_id         text not null,
  emp_name       text,
  work_date      date not null,
  branch_id      text,
  shift_id       text,
  system_checkout  timestamptz,        -- เวลาที่ระบบปิดให้ (อ้างอิง)
  actual_checkout  timestamptz not null, -- เวลาออกจริงที่พนักงานแจ้ง
  reason         text,
  status         text not null default 'pending',  -- pending | approved | rejected
  reviewer       text,
  review_note    text,
  reviewed_at    timestamptz,
  notified       boolean not null default false,   -- แจ้ง HR แล้วหรือยัง
  created_at     timestamptz not null default now()
);
create index if not exists idx_cocorr_status on public.checkout_corrections (status);
create index if not exists idx_cocorr_emp on public.checkout_corrections (emp_id, work_date);

alter table public.checkout_corrections enable row level security;
drop policy if exists checkout_corrections_all on public.checkout_corrections;
create policy checkout_corrections_all on public.checkout_corrections for all to anon, authenticated using (true) with check (true);

select 'auto_checkout.sql done' as result;
