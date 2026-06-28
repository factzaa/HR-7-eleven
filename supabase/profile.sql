-- ============================================================
-- 7-Eleven HR — ให้พนักงานกรอกข้อมูล+อัปเอกสารเอง (รอแอดมินอนุมัติ)
-- รันบน Supabase: SQL Editor > วาง > Run (รันซ้ำได้)
-- ============================================================

-- 1) คอลัมน์เก็บลิงก์เอกสารใน employees
alter table public.employees add column if not exists idcard_url   text;  -- สำเนาบัตรประชาชน
alter table public.employees add column if not exists bankbook_url text;  -- หน้าสมุดบัญชี
alter table public.employees add column if not exists house_url    text;  -- ทะเบียนบ้าน
alter table public.employees add column if not exists edu_url      text;  -- วุฒิการศึกษา

-- 2) ตารางพักข้อมูลที่พนักงานส่งมา (รอตรวจ)
create table if not exists public.profile_submissions (
  id              bigint generated always as identity primary key,
  emp_id          text references public.employees(emp_id) on delete cascade,
  name            text,
  nickname        text,
  phone           text,
  address         text,
  emergency_name  text,
  emergency_phone text,
  bank_name       text,
  bank_account    text,
  id_card         text,
  photo_url       text,
  idcard_url      text,
  bankbook_url    text,
  house_url       text,
  edu_url         text,
  status          text not null default 'pending',   -- pending / approved / rejected
  note            text,
  submitted_at    timestamptz not null default now()
);
create index if not exists idx_psub_status on public.profile_submissions (status);
create index if not exists idx_psub_emp    on public.profile_submissions (emp_id);

alter table public.profile_submissions enable row level security;
drop policy if exists psub_all on public.profile_submissions;
create policy psub_all on public.profile_submissions
  for all to anon, authenticated using (true) with check (true);

-- 3) Storage bucket สำหรับเอกสาร (ตั้ง public เพื่อให้แอดมินเปิดดูได้ — เฟส 4 ค่อยรัดกุม)
insert into storage.buckets (id, name, public) values ('employee-docs', 'employee-docs', true)
on conflict (id) do nothing;

drop policy if exists "employee_docs_rw" on storage.objects;
create policy "employee_docs_rw" on storage.objects
  for all to anon, authenticated
  using (bucket_id = 'employee-docs') with check (bucket_id = 'employee-docs');

select 'profile.sql done' as result;
