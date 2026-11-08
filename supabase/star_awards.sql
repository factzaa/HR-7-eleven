-- ============================================================
-- พนักงานดีเด่นประจำเดือน + เบี้ยพนักงานคุณภาพ            8 พ.ย. 69
--
-- กติกาที่ตกลงกันไว้
--   · คัดได้ "สาขาละ 1-2 คนต่อรอบ" (ไม่ใช่ทั้งร้านรวมกัน)
--   · ถ้าเดือนไหนไม่มีใครผ่านเกณฑ์ = ไม่มีพนักงานดีเด่น ระบบขึ้นเตือนให้เห็น ไม่ต้องฝืนเลือก
--   · คัดจากหัวข้อประเมินในหน้าสรุปรายบุคคลเท่านั้น (ตรงเวลา · มาครบ · คุณภาพงาน · วินัย · ความรู้ · ช่วยทีม)
--   · ระบบจัดอันดับให้ แต่คนกดยืนยันคือ HR
--   · รอบ = รอบเงินเดือน 21-20 เก็บเป็นเดือนของวันสิ้นรอบ เช่น '2569-11'
--   · ได้เบี้ยพนักงานคุณภาพ 500 บาท เข้าสลิปรอบนั้นอัตโนมัติ
--
-- รันบน Supabase: SQL Editor > วาง > Run (รันซ้ำได้ ไม่ลบข้อมูล)
-- ============================================================

create table if not exists public.star_awards (
  id           bigint generated always as identity primary key,
  cycle        text not null,                      -- เดือนของวันสิ้นรอบ เช่น '2026-11'
  branch_id    text not null,
  emp_id       text not null,
  emp_name     text,
  amount       numeric not null default 500,       -- เบี้ยพนักงานคุณภาพ
  rank_score   numeric,                            -- คะแนนรวมตอนคัด (เก็บไว้ดูย้อนหลัง)
  reasons      jsonb,                              -- เหรียญ/เหตุผลที่ระบบใช้ตอนนั้น
  note         text,                               -- HR เขียนเพิ่มได้
  awarded_by   text,
  awarded_at   timestamptz not null default now(),
  -- คนเดียวได้ครั้งเดียวต่อรอบ
  unique (cycle, emp_id)
);

alter table public.star_awards add column if not exists amount     numeric not null default 500;
alter table public.star_awards add column if not exists rank_score numeric;
alter table public.star_awards add column if not exists reasons    jsonb;
alter table public.star_awards add column if not exists note       text;
alter table public.star_awards add column if not exists awarded_by text;

create index if not exists idx_star_cycle  on public.star_awards (cycle);
create index if not exists idx_star_branch on public.star_awards (cycle, branch_id);
create index if not exists idx_star_emp    on public.star_awards (emp_id);

-- ============================================================
-- เพดาน "สาขาละไม่เกิน 2 คนต่อรอบ" — บังคับที่ฐานข้อมูล
--   ไม่ปล่อยให้หน้าเว็บคุมอย่างเดียว เพราะถ้าเปิดสองจอพร้อมกันแล้วกดยืนยันไล่ ๆ กัน
--   การเช็กฝั่งหน้าเว็บจะไม่เห็นกัน แล้วได้ 3 คนในสาขาเดียว
-- ============================================================

create or replace function public.star_awards_cap()
returns trigger language plpgsql as $$
declare n int;
begin
  select count(*) into n
    from public.star_awards
   where cycle = new.cycle and branch_id = new.branch_id
     and (TG_OP = 'INSERT' or id <> new.id);
  if n >= 2 then
    raise exception 'สาขา % รอบ % มีพนักงานดีเด่นครบ 2 คนแล้ว — ต้องยกเลิกคนเดิมก่อน', new.branch_id, new.cycle;
  end if;
  return new;
end $$;

drop trigger if exists trg_star_awards_cap on public.star_awards;
create trigger trg_star_awards_cap
  before insert or update on public.star_awards
  for each row execute function public.star_awards_cap();

alter table public.star_awards enable row level security;
drop policy if exists star_awards_all on public.star_awards;
create policy star_awards_all on public.star_awards
  for all to anon, authenticated using (true) with check (true);


-- ============================================================
-- ค่าเบี้ยตั้งต้น — แก้ได้ภายหลังโดยไม่ต้องแก้โค้ด
-- ============================================================
insert into public.app_settings (key, value) values ('star_award_amount', '500')
on conflict (key) do nothing;


-- ============================================================
-- ตรวจหลังรัน
-- ============================================================
select 'star_awards.sql done' as result,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='star_awards') as จำนวนคอลัมน์,
       (select value from public.app_settings where key='star_award_amount') as เบี้ยตั้งต้น,
       (select count(*) from public.star_awards) as รางวัลที่มอบแล้ว;
