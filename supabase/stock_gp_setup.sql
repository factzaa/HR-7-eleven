-- ============================================================
-- วิเคราะห์สต็อก เฟส 3 (ส่วนที่ข้อมูลปัจจุบันรองรับ)         22 ต.ค. 69
--   ผลกระทบต่อ GP · ของที่ควรพิจารณาเลิกสั่ง · ของที่เกินซ้ำซาก
--
-- ต้องรัน stock_analysis_setup.sql (เฟส 1) ก่อน
-- ไฟล์นี้เพิ่มเฉพาะฟังก์ชัน ไม่สร้างตารางใหม่ ไม่แตะข้อมูลเดิม · รันซ้ำได้ปลอดภัย
--
-- ★★ ข้อควรรู้เรื่องหน่วยเงิน — สำคัญมาก อย่าเอา 2 ตัวนี้มาบวกกันตรง ๆ
--    · รายงาน Audit (RLR8803)  = ราคาขาย รวมภาษี
--    · รายงานตัดจ่าย (RT040037) = ต้นทุน ไม่รวมภาษี
--    · ยอดขายใน sales_daily     = ราคาขาย รวมภาษี
--    ดังนั้น "ของหาย ÷ ยอดขาย" เทียบหน่วยเดียวกันได้
--    แต่ "ตัดจ่าย ÷ ยอดขาย" คนละหน่วย ให้ดูเป็นตัวชี้วัดแยกต่างหาก
--    ระบบจึงแยกเป็น 2 เปอร์เซ็นต์ ไม่รวมเป็นตัวเดียว เพราะรวมแล้วจะได้ตัวเลขที่ผิด
--
-- ★ ยังทำไม่ได้ด้วยข้อมูลชุดนี้: "สินค้าตัวไหนขายดีกับลูกค้ากลุ่มไหน"
--   เพราะ sales_daily เก็บแค่ยอดรวมรายวัน/รายผลัด ไม่มียอดขายรายตัวสินค้า
--   ต้องมีรายงานยอดขายราย SKU จาก CP ALL เพิ่ม จึงจะต่อยอดเรื่องคัดเลือกสินค้าได้เต็มรูปแบบ
-- ============================================================

-- ---------- 1) ผลกระทบต่อ GP รายเดือน ----------
--   real_short = ยอดขาดหลังหักคู่ "คีย์ผิดตัว" ออกแล้ว (ของที่หายจริง)
--   sales      = ยอดขายรวมของเดือนนั้นจาก sales_daily (รวมทุกผลัด)
create or replace function public.stock_gp_impact(
  p_branch text default null, p_from text default null, p_to text default null)
returns table (
  period_ym text,
  sales numeric, sale_days int,
  short_amt numeric, swap_explained numeric, real_short numeric,
  wo_branch numeric, wo_consume numeric, wo_net numeric,
  pct_short numeric, pct_wo numeric
) language sql stable as $$
  with a as (
    select i.period_ym,
           coalesce(sum(i.amount) filter (where i.amount < 0),0) as short_amt
      from public.stock_audit_items i
     where (p_branch is null or i.branch_id = p_branch)
       and (p_from   is null or i.period_ym >= p_from)
       and (p_to     is null or i.period_ym <= p_to)
     group by i.period_ym
  ), sw as (
    select s.period_ym, coalesce(sum(abs(s.short_amt)),0) as expl
      from public.stock_swap_pairs s
     where (p_branch is null or s.branch_id = p_branch)
     group by s.period_ym
  ), w as (
    select x.period_ym,
           coalesce(sum(x.amount) filter (where x.section like 'เสื่อมคุณภาพ%'),0) as wo_branch,
           coalesce(sum(x.amount) filter (where x.section = 'วัสดุสิ้นเปลือง'),0)   as wo_consume,
           coalesce(sum(x.amount),0) as wo_net
      from public.stock_writeoff_items x
     where (p_branch is null or x.branch_id = p_branch)
     group by x.period_ym
  ), s as (
    select to_char(d.sale_date,'YYYY-MM') as period_ym,
           coalesce(sum(d.sales_total),0) as sales,
           count(distinct d.sale_date)::int as sale_days
      from public.sales_daily d
     where (p_branch is null or d.branch_id = p_branch)
     group by 1
  ), m as (
    select period_ym from a
    union select period_ym from w
  )
  select m.period_ym,
         coalesce(s.sales,0), coalesce(s.sale_days,0),
         coalesce(a.short_amt,0), coalesce(sw.expl,0),
         coalesce(a.short_amt,0) + coalesce(sw.expl,0)              as real_short,
         coalesce(w.wo_branch,0), coalesce(w.wo_consume,0), coalesce(w.wo_net,0),
         case when coalesce(s.sales,0) > 0
              then round(abs(coalesce(a.short_amt,0) + coalesce(sw.expl,0)) / s.sales * 100, 3) end as pct_short,
         case when coalesce(s.sales,0) > 0
              then round(coalesce(w.wo_net,0) / s.sales * 100, 3) end as pct_wo
    from m
    left join a  on a.period_ym  = m.period_ym
    left join sw on sw.period_ym = m.period_ym
    left join w  on w.period_ym  = m.period_ym
    left join s  on s.period_ym  = m.period_ym
   where (p_from is null or m.period_ym >= p_from)
     and (p_to   is null or m.period_ym <= p_to)
   order by m.period_ym;
$$;

-- ---------- 2) สินค้าที่ควรพิจารณาเลิกสั่ง / ลดจำนวน ----------
--   ของเสื่อมคุณภาพที่ถูกตัดจ่ายซ้ำหลายเดือน = สั่งเกินหรือขายไม่ทันเป็นประจำ
--   ไม่รวมวัสดุสิ้นเปลือง (ของที่ร้านใช้เอง) และไม่รวมชดเชยคืน
create or replace function public.stock_drop_candidates(
  p_branch text default null, p_from text default null, p_to text default null,
  p_min_months int default 2, p_limit int default 60)
returns table (
  sku text, name text, pma text, pma_name text, risk_type text,
  months_n int, months_total int, qty numeric, amount numeric,
  avg_per_month numeric, last_period text
) language sql stable as $$
  with scope as (
    select x.* from public.stock_writeoff_items x
     where (p_branch is null or x.branch_id = p_branch)
       and (p_from   is null or x.period_ym >= p_from)
       and (p_to     is null or x.period_ym <= p_to)
       and x.section like 'เสื่อมคุณภาพ%'
  ), mons as (
    select count(distinct period_ym)::int as n from scope
  )
  select s.sku, max(s.name), max(s.pma),
         coalesce(max(g.name),'(ไม่ทราบกลุ่ม)'), coalesce(max(g.risk_type),'other'),
         count(distinct s.period_ym)::int, (select n from mons),
         coalesce(sum(s.qty),0), coalesce(sum(s.amount),0),
         round(coalesce(sum(s.amount),0) / greatest(count(distinct s.period_ym),1), 2),
         max(s.period_ym)
    from scope s
    left join public.pma_groups g on g.code = s.pma
   group by s.sku
  having count(distinct s.period_ym) >= greatest(p_min_months,1)
   order by sum(s.amount) desc
   limit greatest(p_limit,1);
$$;

-- ---------- 3) สินค้าที่นับได้ "เกิน" ซ้ำซาก ----------
--   เกินซ้ำโดยไม่มีคู่คีย์ผิดตัวมารับ มักแปลว่ารับเข้าเกิน/คีย์รับผิด → เงินจมในสต็อก
--   ตัดตัวที่ระบบจับคู่ได้แล้วออก เพราะอธิบายได้ว่าเป็นการสลับรหัส ไม่ใช่ของเกินจริง
create or replace function public.stock_over_chronic(
  p_branch text default null, p_from text default null, p_to text default null,
  p_min_months int default 2, p_limit int default 60)
returns table (
  sku text, name text, pma text, pma_name text, risk_type text,
  months_over int, months_total int, over_amt numeric, over_qty numeric,
  net_amt numeric, paired_months int, last_period text
) language sql stable as $$
  with scope as (
    select i.* from public.stock_audit_items i
     where (p_branch is null or i.branch_id = p_branch)
       and (p_from   is null or i.period_ym >= p_from)
       and (p_to     is null or i.period_ym <= p_to)
  ), mons as (
    select count(distinct period_ym)::int as n from scope
  ), paired as (
    select s.over_sku as sku, count(distinct s.period_ym)::int as n
      from public.stock_swap_pairs s
     where (p_branch is null or s.branch_id = p_branch)
       and (p_from   is null or s.period_ym >= p_from)
       and (p_to     is null or s.period_ym <= p_to)
     group by s.over_sku
  )
  select c.sku, max(c.name), max(c.pma),
         coalesce(max(g.name),'(ไม่ทราบกลุ่ม)'), coalesce(max(g.risk_type),'other'),
         count(distinct c.period_ym) filter (where c.amount > 0)::int,
         (select n from mons),
         coalesce(sum(c.amount) filter (where c.amount > 0),0),
         coalesce(sum(c.qty)    filter (where c.amount > 0),0),
         coalesce(sum(c.amount),0),
         coalesce(max(p.n),0),
         max(c.period_ym) filter (where c.amount > 0)
    from scope c
    left join public.pma_groups g on g.code = c.pma
    left join paired p on p.sku = c.sku
   group by c.sku
  having count(distinct c.period_ym) filter (where c.amount > 0) >= greatest(p_min_months,1)
     and coalesce(sum(c.amount),0) > 0                       -- สุทธิยังเกิน ไม่ใช่เกินสลับขาด
     and count(distinct c.period_ym) filter (where c.amount > 0) > coalesce(max(p.n),0)   -- ไม่ได้อธิบายด้วยคู่คีย์ผิดตัวทุกเดือน
   order by sum(c.amount) desc
   limit greatest(p_limit,1);
$$;

-- ---------- ตรวจผล ----------
-- select * from public.stock_gp_impact('08747');
-- select * from public.stock_drop_candidates('08747', null, null, 2, 15);
-- select * from public.stock_over_chronic('08747', null, null, 2, 15);
