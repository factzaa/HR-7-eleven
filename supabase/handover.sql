-- ============================================================
-- 7-Eleven HR — ส่ง/รับผลัด (Shift Handover)
-- เช็กลิสต์สภาพร้าน (ความสะอาด/เติมสินค้า/ความเรียบร้อย) แบบ 2 ขั้น: ส่ง → รับยืนยัน
-- รันบน Supabase: SQL Editor > วาง > Run
-- ============================================================

create table if not exists public.handovers (
  id           bigint generated always as identity primary key,
  branch_id    text,
  shift_id     text,
  work_date    date not null,
  from_emp_id  text,                 -- ผู้ส่งผลัด
  from_name    text,
  to_emp_id    text,                 -- ผู้รับผลัด (ว่างจนกว่าจะรับ)
  to_name      text,
  status       text not null default 'sent',  -- sent / received / rejected / no_handover
  checklist    jsonb,                -- {key:true/false,...}
  done_count   int,                  -- ทำครบกี่ข้อ
  total_count  int,                  -- ทั้งหมดกี่ข้อ
  pending_work text,                 -- งานค้าง/สิ่งที่ต้องสานต่อ
  issues       text,                 -- ปัญหา/เหตุการณ์
  photo_url    text,                 -- รูปหน้าร้าน (ถ้ามี)
  receiver_note text,                -- หมายเหตุตอนรับ (ถ้าไม่เรียบร้อย)
  created_at   timestamptz not null default now(),  -- เวลาส่ง
  received_at  timestamptz                            -- เวลารับ
);
create index if not exists idx_handover_branch on public.handovers (branch_id);
create index if not exists idx_handover_date   on public.handovers (work_date desc);
create index if not exists idx_handover_status on public.handovers (status);

alter table public.handovers enable row level security;
drop policy if exists handovers_all on public.handovers;
create policy handovers_all on public.handovers for all to anon, authenticated using (true) with check (true);

select 'handover.sql done' as result;
