-- ============================================================
-- วิเคราะห์สต็อก — เปิดทางให้ "ทุกจุดที่สรุป" กดดูรายการจริงได้   22 ต.ค. 69
--
-- ต้องรัน stock_analysis_setup.sql (เฟส 1) ให้ผ่านก่อน
-- ไฟล์นี้แก้ฟังก์ชันเดิม 1 ตัว ไม่สร้างตารางใหม่ ไม่แตะข้อมูล · รันซ้ำได้ปลอดภัย
--
-- เดิม stock_pma_items กรองได้แค่ "กลุ่ม PMA"
-- เพิ่ม p_risk เพื่อให้กรองตาม "ลักษณะความเสี่ยง" ได้ด้วย
--   (theft / control / consume / fresh / drink / home / other)
-- ทำให้หน้าเว็บใช้ฟังก์ชันตัวเดียวเปิดรายละเอียดได้ทั้ง
--   · กดแท่งกราฟอันดับกลุ่ม        → กรองด้วย p_pma
--   · กดแถวตารางลักษณะความเสี่ยง   → กรองด้วย p_risk
--   · กดแถวเดือนในตารางแนวโน้ม     → กรองด้วย p_from = p_to = เดือนนั้น
--
-- เปลี่ยนจำนวนอาร์กิวเมนต์ → create or replace จะกลายเป็นฟังก์ชันตัวใหม่ซ้อนของเดิม
-- ต้อง drop ตัวเก่าทิ้งก่อน ไม่งั้นจะมี 2 ตัวและ PostgREST เลือกไม่ถูก
-- ============================================================

drop function if exists public.stock_pma_items(text, text, text, text, int);

create or replace function public.stock_pma_items(
  p_branch text default null, p_from text default null, p_to text default null,
  p_pma text default null, p_limit int default 300, p_risk text default null)
returns table (
  sku text, name text, pma text, pma_name text, risk_type text,
  months_n int, months_short int,
  short_amt numeric, short_qty numeric, over_amt numeric, over_qty numeric,
  net_amt numeric, wo_amt numeric, last_period text, by_month jsonb
) language sql stable as $$
  with scope as (
    select i.* from public.stock_audit_items i
     left join public.pma_groups g0 on g0.code = i.pma
     where (p_branch is null or i.branch_id = p_branch)
       and (p_from   is null or i.period_ym >= p_from)
       and (p_to     is null or i.period_ym <= p_to)
       and (p_pma    is null or i.pma = p_pma)
       and (p_risk   is null or coalesce(g0.risk_type,'other') = p_risk)
  ), agg as (          -- รวมหลายสาขาให้เป็นค่าเดียวต่อ (สินค้า, เดือน) ก่อน ไม่งั้น jsonb ซ้ำคีย์
    select sku, period_ym, sum(amount) as amt, sum(qty) as q,
           max(name) as nm, max(pma) as pm
      from scope group by sku, period_ym
  ), wo as (
    select w.sku, sum(w.amount) as amt
      from public.stock_writeoff_items w
     where (p_branch is null or w.branch_id = p_branch)
       and (p_from   is null or w.period_ym >= p_from)
       and (p_to     is null or w.period_ym <= p_to)
       and (p_pma    is null or w.pma = p_pma)
       and coalesce(w.section,'') <> 'ชดเชยคืน'
     group by w.sku
  )
  select a.sku, max(a.nm) as name, max(a.pm) as pma,
         coalesce(max(g.name),'(ไม่ทราบกลุ่ม)') as pma_name,
         coalesce(max(g.risk_type),'other')     as risk_type,
         count(*)::int                                   as months_n,
         count(*) filter (where a.amt < 0)::int          as months_short,
         coalesce(sum(a.amt) filter (where a.amt < 0),0) as short_amt,
         coalesce(sum(a.q)   filter (where a.amt < 0),0) as short_qty,
         coalesce(sum(a.amt) filter (where a.amt > 0),0) as over_amt,
         coalesce(sum(a.q)   filter (where a.amt > 0),0) as over_qty,
         coalesce(sum(a.amt),0)                          as net_amt,
         coalesce(max(w.amt),0)                          as wo_amt,
         max(a.period_ym) filter (where a.amt < 0)       as last_period,
         jsonb_object_agg(a.period_ym, a.amt)            as by_month
    from agg a
    left join public.pma_groups g on g.code = a.pm
    left join wo w on w.sku = a.sku
   group by a.sku
   order by coalesce(sum(a.amt) filter (where a.amt < 0),0) asc
   limit greatest(p_limit,1);
$$;

-- ---------- ตรวจผล ----------
-- select sku, name, pma_name, short_amt from public.stock_pma_items('08747',null,null,'50',10);
-- select sku, name, risk_type, short_amt from public.stock_pma_items('08747',null,null,null,10,'theft');
-- select sku, name, short_amt from public.stock_pma_items('08747','2026-09','2026-09',null,10);
