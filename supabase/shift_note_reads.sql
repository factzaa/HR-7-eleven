-- ============================================================
-- 7-Eleven HR — ใบตอบรับ "ข้อความฝากถึงผลัดถัดไป"
--   หัวหน้าผลัดพิมพ์ฝากไว้ตอนกดส่งผลัด (shift_submits.note)
--   ตารางนี้เก็บว่า "ใครของผลัดถัดไปเปิดแอปแล้วเห็นข้อความนั้นจริง เมื่อไร"
--   ส่วนกลางจะได้ตรวจได้ว่าข้อความถึงมือคนรับหรือตกหล่น
-- รันบน Supabase: SQL Editor > วาง > Run   (รันหลัง task_system.sql)
-- ============================================================

create table if not exists public.shift_note_reads (
  id         bigint generated always as identity primary key,
  submit_id  bigint not null,          -- อ้างถึง shift_submits.id
  emp_id     text   not null,          -- คนของผลัดถัดไปที่เปิดเห็น
  emp_name   text,
  read_at    timestamptz not null default now()
);

-- 1 คน ต่อ 1 ข้อความ นับครั้งเดียว (เปิดซ้ำไม่สร้างแถวใหม่)
create unique index if not exists uq_snr_submit_emp
  on public.shift_note_reads (submit_id, emp_id);
create index if not exists idx_snr_submit on public.shift_note_reads (submit_id);

alter table public.shift_note_reads enable row level security;
drop policy if exists snr_all on public.shift_note_reads;
create policy snr_all on public.shift_note_reads for all to anon, authenticated using (true) with check (true);

select 'shift_note_reads.sql done' as result;
select count(*) as จำนวนใบตอบรับ from public.shift_note_reads;
