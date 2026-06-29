-- ============================================================
-- 7-Eleven HR — เกณฑ์ใบเตือน/วินัย (ปรับได้จากหน้า HR)
-- กำหนดว่า "มาสายกี่ครั้ง" หรือ "ขาดงานกี่วัน" จึงจะได้ใบเตือนระดับใด
-- รันบน Supabase: SQL Editor > วาง > Run
-- ============================================================

create table if not exists public.discipline_rules (
  level       int  primary key,     -- 1..4 (มาก = รุนแรงสุด)
  level_name  text not null,        -- ชื่อระดับที่แสดง
  level_color text not null,        -- สีป้าย (hex)
  late_min    int,                  -- มาสายกี่ "ครั้ง" ขึ้นไปจึงเข้าระดับนี้ (ว่าง = ไม่ใช้เกณฑ์สาย)
  absent_min  int,                  -- ขาดงานกี่ "วัน" ขึ้นไปจึงเข้าระดับนี้ (ว่าง = ไม่ใช้เกณฑ์ขาด)
  enabled     boolean not null default true
);

-- ค่าเริ่มต้น (ตรงกับเกณฑ์เดิมในระบบ) — insert เฉพาะถ้ายังไม่มี
insert into public.discipline_rules (level, level_name, level_color, late_min, absent_min, enabled) values
  (1, 'ตักเตือนด้วยวาจา',        '#ca8a04', 3,  null, true),
  (2, 'ตักเตือนลายลักษณ์อักษร', '#d97706', 5,  1,    true),
  (3, 'ใบเตือนระดับ 1',          '#ea580c', 7,  2,    true),
  (4, 'ใบเตือนระดับ 2',          '#b91c1c', 10, 3,    true)
on conflict (level) do nothing;

alter table public.discipline_rules enable row level security;
drop policy if exists discipline_rules_all on public.discipline_rules;
create policy discipline_rules_all on public.discipline_rules
  for all to anon, authenticated using (true) with check (true);

select level, level_name, late_min, absent_min, enabled
from public.discipline_rules order by level;
