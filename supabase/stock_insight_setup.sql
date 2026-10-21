-- ============================================================
-- วิเคราะห์สต็อก เฟส 2 — บทวิเคราะห์ของนิดา + งานเฝ้าระวัง      22 ต.ค. 69
--
-- ต้องรัน stock_analysis_setup.sql (เฟส 1) ให้ผ่านก่อน
-- ไฟล์นี้เพิ่มของใหม่ 2 ตาราง ไม่แตะของเดิม · รันซ้ำได้ปลอดภัย
--
-- stock_insights  = บทวิเคราะห์ที่นิดาเขียน เก็บเป็นประวัติรายเดือน
--                   (เก็บ facts ที่ส่งให้นิดาไว้ด้วย เพื่อให้ย้อนตรวจได้ว่าสรุปมาจากตัวเลขชุดไหน)
-- stock_watch     = รายการสินค้าที่สั่งเฝ้าระวัง ผูกกับงานพิเศษที่มอบหมายไป
--                   ทำให้เดือนถัดไปตอบได้ว่า "ที่เฝ้าระวังไว้ ดีขึ้นหรือยัง"
--
-- ★ ข้อตกลงที่ไม่เปลี่ยน: ระบบนี้บอกว่าหายเท่าไร ที่ไหน กลุ่มไหน
--   ไม่ชี้ตัวบุคคล · บทวิเคราะห์เป็นจุดให้ไปตรวจ ไม่ใช่ข้อสรุปหรือข้อกล่าวหา
-- ============================================================

-- ---------- 1) บทวิเคราะห์ของนิดา ----------
create table if not exists public.stock_insights (
  id          uuid primary key default gen_random_uuid(),
  branch_id   text not null,
  period_ym   text not null,              -- เดือนของข้อมูลที่วิเคราะห์
  body        text not null,              -- บทวิเคราะห์ (ข้อความล้วน)
  facts       jsonb not null default '{}'::jsonb,   -- ตัวเลขที่ส่งให้นิดา ณ ตอนนั้น
  model       text,
  is_auto     boolean not null default false,       -- true = สั่งอัตโนมัติตอนนำเข้าไฟล์
  created_at  timestamptz not null default now(),
  created_by  text
);

create index if not exists stock_insights_bp_idx
  on public.stock_insights (branch_id, period_ym, created_at desc);

-- ---------- 2) รายการเฝ้าระวัง ----------
create table if not exists public.stock_watch (
  id          bigserial primary key,
  branch_id   text not null,
  period_ym   text not null,              -- เดือนที่สั่งเฝ้าระวัง (ใช้เป็นจุดตั้งต้นเทียบผล)
  sku         text not null,
  name        text,
  pma         text,
  reason      text,                       -- เหตุผลที่ถูกหยิบมา เช่น "ขาด 4/4 เดือน"
  source      text not null default 'chronic',   -- chronic | risk | swap | nida | manual
  amt_at_set  numeric not null default 0,  -- ยอดขาดของเดือนที่ตั้ง (ตรึงไว้ กันข้อมูลถูกอัปทับแล้วเทียบเพี้ยน)
  special_id  bigint,                      -- งานพิเศษที่สร้างคู่กัน (public.special_tasks)
  status      text not null default 'open',-- open | done
  created_at  timestamptz not null default now(),
  created_by  text,
  closed_at   timestamptz,
  closed_by   text
);

create index if not exists stock_watch_bp_idx on public.stock_watch (branch_id, status, period_ym desc);
create unique index if not exists stock_watch_uniq on public.stock_watch (branch_id, period_ym, sku);

-- ---------- 3) รายการเฝ้าระวัง + ผลล่าสุด ----------
--   amt_last = ยอดขาดของ SKU นั้นในเดือนล่าสุดที่สาขานั้นมีข้อมูล
--   ใช้ตอบว่า "ตั้งเฝ้าระวังไปแล้วดีขึ้นไหม" โดยไม่ต้องให้คนไปไล่เปิดรายงานเอง
create or replace function public.stock_watch_list(
  p_branch text default null, p_status text default null, p_limit int default 200)
returns table (
  id bigint, branch_id text, period_ym text, sku text, name text,
  pma text, pma_name text, risk_type text, reason text, source text,
  special_id bigint, status text, created_at timestamptz, created_by text,
  amt_at_set numeric, amt_last numeric, last_period text, delta numeric
) language sql stable as $$
  with last_p as (
    select i.branch_id, max(i.period_ym) as pm
      from public.stock_audit_items i
     where (p_branch is null or i.branch_id = p_branch)
     group by i.branch_id
  )
  select w.id, w.branch_id, w.period_ym, w.sku, w.name,
         w.pma, coalesce(g.name,'(ไม่ทราบกลุ่ม)'), coalesce(g.risk_type,'other'),
         w.reason, w.source, w.special_id, w.status, w.created_at, w.created_by,
         w.amt_at_set,
         coalesce(l.amt, 0)        as amt_last,
         lp.pm                     as last_period,
         coalesce(l.amt, 0) - w.amt_at_set as delta   -- บวก = ขาดน้อยลง (ดีขึ้น)
    from public.stock_watch w
    left join public.pma_groups g on g.code = w.pma
    left join last_p lp on lp.branch_id = w.branch_id
    left join lateral (
      select sum(i.amount) as amt
        from public.stock_audit_items i
       where i.branch_id = w.branch_id and i.sku = w.sku and i.period_ym = lp.pm
    ) l on true
   where (p_branch is null or w.branch_id = p_branch)
     and (p_status is null or w.status = p_status)
   order by w.status, w.created_at desc
   limit greatest(p_limit,1);
$$;

-- ---------- 4) RLS (เหมือนตารางอื่นในระบบ — คุมสิทธิ์จริงที่ชั้น API) ----------
alter table public.stock_insights enable row level security;
alter table public.stock_watch    enable row level security;

drop policy if exists anon_rw_stock_insights on public.stock_insights;
create policy anon_rw_stock_insights on public.stock_insights
  for all to anon, authenticated using (true) with check (true);

drop policy if exists anon_rw_stock_watch on public.stock_watch;
create policy anon_rw_stock_watch on public.stock_watch
  for all to anon, authenticated using (true) with check (true);

-- ---------- ตรวจผล ----------
-- select branch_id, period_ym, is_auto, left(body,60) from public.stock_insights order by created_at desc limit 5;
-- select * from public.stock_watch_list('08747');
