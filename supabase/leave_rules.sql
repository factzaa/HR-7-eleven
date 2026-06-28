-- ============================================================
-- 7-Eleven HR — เงื่อนไขการลา (ลาล่วงหน้า/โควตา/ลาย้อนหลัง) + เหตุผลปฏิเสธ
-- รันบน Supabase: SQL Editor > วาง > Run (รันซ้ำได้)
-- ============================================================

create table if not exists public.leave_types (
  type            text primary key,           -- ชื่อประเภท เช่น ลาป่วย
  advance_days    int  not null default 0,     -- ต้องลาล่วงหน้าอย่างน้อยกี่วัน
  quota_per_year  int,                         -- โควตาวัน/ปี (null = ไม่จำกัด)
  allow_backdate  boolean not null default false, -- ลาย้อนหลังได้ (เช่น ลาป่วย)
  require_doc     boolean not null default false, -- ต้องแนบเอกสาร (เช่น ใบรับรองแพทย์)
  active          boolean not null default true,
  sort            int not null default 0
);

-- เผื่อรันบนตารางเดิม
alter table public.leave_types add column if not exists require_doc boolean not null default false;

insert into public.leave_types (type, advance_days, quota_per_year, allow_backdate, require_doc, sort) values
  ('ลาป่วย',     0, null, true,  true,  1),
  ('ลากิจ',      2, null, false, false, 2),
  ('อื่นๆ',      0, null, false, false, 4)
on conflict (type) do nothing;
-- ตั้งให้ลาป่วยต้องแนบใบรับรองแพทย์ (กรณีตารางมีอยู่แล้ว)
update public.leave_types set require_doc = true where type = 'ลาป่วย';

alter table public.leave_types enable row level security;
drop policy if exists leave_types_all on public.leave_types;
create policy leave_types_all on public.leave_types
  for all to anon, authenticated using (true) with check (true);

-- เหตุผลที่ HR ปฏิเสธ (ให้พนักงานเห็น) + ลิงก์เอกสารแนบ (ใบรับรองแพทย์ ฯลฯ)
alter table public.leaves add column if not exists hr_note text;
alter table public.leaves add column if not exists doc_url text;

select * from public.leave_types order by sort;
