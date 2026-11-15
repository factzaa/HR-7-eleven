-- ============================================================
-- 7-Eleven HR — ใบนับลังคงค้าง (Crate stock count)
--   ปัญหาเดิม: ยอดลังคงค้าง = ยอดตั้งต้น + Σ(ลังเข้า − ลังคืน) เท่านั้น
--   ปรับได้ทางเดียวคือแก้ "ยอดตั้งต้น" ซึ่งไม่มีวันที่ → แก้ทีหนึ่งยอดทั้งสายเปลี่ยนหมด
--   และ opening ติดลบไม่ได้ จึงแก้เคสลังเกิน/ลังขาดสะสมไม่ได้เลย
--   ใหม่: บันทึก "ใบนับลัง" ตามวันที่ → ยอดถูกตั้งใหม่ ณ วันนั้น ประวัติเดิมไม่ถูกแก้
--
-- รันบน Supabase: SQL Editor > วาง > Run   (รันหลัง schema เดิมของงานรับสินค้า)
-- ============================================================

-- ---------- 1) ใบนับลัง ----------
create table if not exists public.goods_crate_counts (
  id            bigint generated always as identity primary key,
  branch_id     text   not null,
  warehouse_id  bigint not null,
  count_date    date   not null,

  counted       int    not null,          -- จำนวนลังที่นับได้จริง (รวมทุกประเภท)
  by_type       jsonb,                    -- แยกตามประเภทลัง {"ลังแดง":12,"ลังฟ้า":5}
  expected      int,                      -- ยอดตามระบบ ณ สิ้นวันที่นับ (สแนปช็อต ไว้ย้อนดู)
  diff          int,                      -- counted − expected (บวก = ลังเกิน, ลบ = ลังขาด)

  reason        text,                     -- บังคับกรอกเมื่อ diff ≠ 0
  photos        jsonb,
  note          text,

  shift_id      text,
  counted_by    text,
  counted_name  text,
  counted_role  text,                     -- lead / mgr

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 1 คลัง นับได้วันละ 1 ใบ (นับซ้ำวันเดิม = แก้ใบเดิม)
create unique index if not exists uq_gcc_branch_wh_date
  on public.goods_crate_counts (branch_id, warehouse_id, count_date);
create index if not exists idx_gcc_chain on public.goods_crate_counts (branch_id, warehouse_id, count_date desc);
create index if not exists idx_gcc_date  on public.goods_crate_counts (count_date desc);

alter table public.goods_crate_counts enable row level security;
drop policy if exists gcc_all on public.goods_crate_counts;
create policy gcc_all on public.goods_crate_counts for all to anon, authenticated using (true) with check (true);


-- ---------- 2) ประเภทลังที่ใช้ตอนนับ (ปรับได้จากหน้า HR) ----------
insert into public.app_settings (key, value) values
  ('crate_types', 'ลังแดง,ลังฟ้า,ลังนม,ลังผัก')
on conflict (key) do nothing;


-- ---------- 3) งานรายสัปดาห์ "นับลังคงค้าง" ----------
--   ผูกกับระบบงานในกะด้วย link_kind = 'นับลัง' (ชุดเดียวกับงานรับสินค้าที่ใช้ 'รับสินค้า')
--   ค่าเริ่มต้น: ทุกวันจันทร์ · ยังไม่เปิดใช้ (active=false) ให้ไปติ๊กเปิดเองที่หน้า "ตั้งค่างาน"
--   พร้อมเลือกกะและวันที่ต้องการก่อน จะได้ไม่เด้งขึ้นทุกสาขาทันที
--   หมายเหตุ: days_of_week เป็น smallint[] (ไม่ใช่ jsonb) — ต้องใส่เป็น array[1]::smallint[]
insert into public.task_defs (title, link_kind, freq, days_of_week, active, sort, how_to, criteria, who_label)
select 'นับลังคงค้าง (รายสัปดาห์)', 'นับลัง', 'weekly', array[1]::smallint[], false, 900,
       E'นับลังคงค้างของทุกคลังที่ร้านถืออยู่\nแยกนับตามประเภทลัง\nกรอกจำนวนที่นับได้ในเมนู "รับสินค้าจากคลัง" → ส่วน "นับลังคงค้าง"',
       E'นับครบทุกคลังที่มียอดคงค้าง\nถ้าไม่ตรงกับระบบ ต้องระบุเหตุผลและแนบรูปกองลัง',
       'หัวหน้าผลัด / ผจก.'
where not exists (select 1 from public.task_defs where link_kind = 'นับลัง');


-- ---------- 4) คำนวณ "ควรคืน/ส่วนต่าง" ใหม่ทั้งสาย ----------
--   กติกา (ต้องตรงกับ _whOutstanding ใน shared/supabase.js เป๊ะ ๆ):
--     • ยอดตั้งต้น = goods_opening.opening
--     • เดินทีละ "วัน" ตามลำดับเวลา
--     • ใบรับสินค้าของวันนั้นทุกใบ เทียบกับยอด ณ สิ้นวันก่อนหน้า (return_expected เท่ากันทั้งวัน)
--       — คงกติกาเดิมไว้ ไม่งั้นส่วนต่างของเอกสารเก่ากว่า 1,000 ใบจะเปลี่ยนยกแผง
--     • จบวัน: ยอด += Σ(ลังเข้า − ลังคืน) ของวันนั้น
--     • ถ้าวันนั้นมีใบนับลัง: ยอด = จำนวนที่นับได้ (ทับทิ้งเลย) และเก็บ expected/diff ลงใบนับ
create or replace function public.recalc_goods_chain(p_branch text, p_wh bigint)
returns void
language plpgsql
as $$
declare
  v_bal  int := 0;
  v_day  date;
  v_sum  int;
  v_cnt  record;
begin
  select coalesce(opening, 0) into v_bal
    from public.goods_opening
   where branch_id = p_branch and warehouse_id = p_wh;
  if v_bal is null then v_bal := 0; end if;

  for v_day in
    select d from (
      select work_date  as d from public.goods_receipts
       where branch_id = p_branch and warehouse_id = p_wh
      union
      select count_date as d from public.goods_crate_counts
       where branch_id = p_branch and warehouse_id = p_wh
    ) x
    where d is not null
    order by d
  loop
    -- ใบรับสินค้าของวันนี้ เทียบกับยอด ณ สิ้นวันก่อนหน้า
    update public.goods_receipts
       set return_expected = v_bal,
           diff            = coalesce(crates_return, 0) - v_bal
     where branch_id = p_branch and warehouse_id = p_wh and work_date = v_day;

    select coalesce(sum(coalesce(crates_in, 0) - coalesce(crates_return, 0)), 0)
      into v_sum
      from public.goods_receipts
     where branch_id = p_branch and warehouse_id = p_wh and work_date = v_day;
    v_bal := v_bal + v_sum;

    -- มีใบนับลังของวันนี้ → ยอดถูกตั้งใหม่ตามที่นับได้
    select * into v_cnt
      from public.goods_crate_counts
     where branch_id = p_branch and warehouse_id = p_wh and count_date = v_day;
    if found then
      update public.goods_crate_counts
         set expected = v_bal,
             diff     = counted - v_bal,
             updated_at = now()
       where id = v_cnt.id;
      v_bal := v_cnt.counted;
    end if;
  end loop;
end;
$$;


-- ---------- 5) ตรวจผลลัพธ์ ----------
select 'goods_crate_count.sql done' as result;
select key, value from public.app_settings where key = 'crate_types';
select id, title, link_kind, freq, active from public.task_defs where link_kind = 'นับลัง';
