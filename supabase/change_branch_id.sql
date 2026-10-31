-- ============================================================
-- เปลี่ยน "รหัสสาขา" ทั้งระบบอย่างปลอดภัย                    31 ต.ค. 69
--   เคสที่ทำ: สาขาย้ายที่ · 06573 ตลาดหล่มสัก → 23024 โรงพยาบาลหล่มสัก
--
-- ทำไมต้องมีฟังก์ชันนี้ ไม่แก้ในหน้าเว็บเอา
--   หน้า "ตั้งค่าสาขา" ของ HR ล็อกช่องรหัสไว้ตอนแก้ไข (แก้ไม่ได้อยู่แล้ว)
--   และถ้าไปแก้ในตาราง branches ตรง ๆ จะเจอ 2 ปัญหา
--     1) ตารางที่มี foreign key (employees, attendance, schedules,
--        shift_leads, shelves) จะไม่ยอมให้แก้
--     2) อีกกว่า 60 ตารางเก็บ branch_id เป็นข้อความเฉย ๆ ไม่มี foreign key
--        → แก้แล้ว "ไม่ error" แต่ข้อมูลเก่าจะค้างอยู่กับรหัสเดิมเงียบ ๆ
--        ซึ่งแย่กว่า error เพราะไม่มีใครรู้จนกว่าจะหาของไม่เจอ
--
--   ฟังก์ชันนี้ไล่เปลี่ยนให้ครบ "ทุกคอลัมน์ที่เก็บรหัสสาขา" โดยอ่านจาก
--   โครงสร้างฐานข้อมูลจริง (information_schema) ไม่ได้ไล่พิมพ์ชื่อตารางเอง
--   → ตารางที่เพิ่มมาใหม่ในอนาคตก็จะถูกเปลี่ยนตามอัตโนมัติ ไม่มีตกหล่น
--
--   ทั้งหมดอยู่ใน "ทรานแซกชันเดียว" — ถ้าพลาดกลางทาง ย้อนกลับทั้งหมด
--
-- ⚠ สำรองฐานข้อมูลก่อนรันจริง (Supabase → Database → Backups)
-- ============================================================

create or replace function public.change_branch_id(
  p_old     text,
  p_new     text,
  p_dry     boolean          default true,    -- true = ลองดูเฉย ๆ ไม่แก้จริง
  p_name    text             default null,    -- ชื่อสาขาใหม่ (เว้นว่าง = คงชื่อเดิม)
  p_lat     double precision default null,    -- พิกัดใหม่ (เว้นว่าง = คงเดิม)
  p_lng     double precision default null,
  p_radius  int              default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  r          record;
  n          bigint;
  total      bigint := 0;
  report     jsonb  := '{}'::jsonb;
  -- ชื่อคอลัมน์ที่ "เก็บรหัสสาขา" (ไม่ใช่ชื่อสาขา)
  code_cols  text[] := array[
    'branch_id',            -- ส่วนใหญ่
    'branch_id2',           -- กะที่สองในตารางลงเวลา
    'checkout_branch_id',   -- สาขาที่กดออกงาน (ไปช่วยสาขาอื่น)
    'from_branch',          -- แชตระหว่าง ผจก.
    'to_branch'
  ];
begin
  p_old := trim(coalesce(p_old, ''));
  p_new := trim(coalesce(p_new, ''));

  if p_old = '' or p_new = '' then
    return json_build_object('ok', false, 'error', 'ต้องระบุทั้งรหัสเดิมและรหัสใหม่');
  end if;
  if p_old = p_new then
    return json_build_object('ok', false, 'error', 'รหัสเดิมกับรหัสใหม่เหมือนกัน');
  end if;
  if not exists (select 1 from public.branches where branch_id = p_old) then
    return json_build_object('ok', false, 'error', 'ไม่พบสาขารหัส ' || p_old);
  end if;
  if exists (select 1 from public.branches where branch_id = p_new) then
    return json_build_object('ok', false, 'error',
      'มีสาขารหัส ' || p_new || ' อยู่แล้ว — ถ้าตั้งใจรวมสองสาขาเข้าด้วยกัน ต้องทำอีกแบบ');
  end if;

  -- ---------- 1) สร้างแถวสาขาใหม่ก่อน ----------
  --   ต้องมีก่อน ไม่งั้นตารางที่มี foreign key จะอัปเดตไม่ผ่าน
  if not p_dry then
    insert into public.branches as b (branch_id, name, lat, lng, radius_m)
    select p_new,
           coalesce(p_name,   o.name),
           coalesce(p_lat,    o.lat),
           coalesce(p_lng,    o.lng),
           coalesce(p_radius, o.radius_m)
      from public.branches o where o.branch_id = p_old;

    -- คอลัมน์เสริมที่เพิ่มมาทีหลัง (เช่น line_group_id, task_v2) — คัดลอกเท่าที่มีจริง
    for r in
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'branches'
         and column_name not in ('branch_id','name','lat','lng','radius_m')
    loop
      execute format(
        'update public.branches t set %1$I = o.%1$I from public.branches o
          where t.branch_id = $2 and o.branch_id = $1', r.column_name)
        using p_old, p_new;
    end loop;
  end if;

  -- ---------- 2) ไล่เปลี่ยนทุกคอลัมน์ที่เก็บรหัสสาขา ----------
  for r in
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       and t.table_type   = 'BASE TABLE'
       and c.table_name  <> 'branches'
       and c.column_name  = any(code_cols)
     order by c.table_name, c.column_name
  loop
    if p_dry then
      execute format('select count(*) from public.%I where %I = $1', r.table_name, r.column_name)
        into n using p_old;
    else
      execute format('update public.%I set %I = $2 where %I = $1',
                     r.table_name, r.column_name, r.column_name)
        using p_old, p_new;
      get diagnostics n = row_count;
    end if;

    if n > 0 then
      report := report || jsonb_build_object(r.table_name || '.' || r.column_name, n);
      total  := total + n;
    end if;
  end loop;

  -- ---------- 3) คอลัมน์ที่เก็บเป็น "อาเรย์ของรหัสสาขา" ----------
  --   ประกาศข่าว/ข้อสอบ ที่เลือกเฉพาะบางสาขา เก็บเป็น text[]
  for r in
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       and t.table_type   = 'BASE TABLE'
       and c.column_name  = 'branch_ids'
       and c.data_type    = 'ARRAY'
  loop
    if p_dry then
      execute format('select count(*) from public.%I where $1 = any(%I)', r.table_name, r.column_name)
        into n using p_old;
    else
      execute format('update public.%1$I set %2$I = array_replace(%2$I, $1, $2) where $1 = any(%2$I)',
                     r.table_name, r.column_name)
        using p_old, p_new;
      get diagnostics n = row_count;
    end if;
    if n > 0 then
      report := report || jsonb_build_object(r.table_name || '.' || r.column_name || ' (อาเรย์)', n);
      total  := total + n;
    end if;
  end loop;

  -- ---------- 4) กุญแจห้องแชทระหว่าง ผจก. ----------
  --   room_key = รหัสสาขาสองตัวเรียงแล้วคั่นด้วย | เช่น '06573|08747'
  --   ถ้าไม่แก้ ห้องแชทเก่าจะหายไปจากหน้าจอทั้งที่ข้อความยังอยู่
  if to_regclass('public.mgr_peer_chat') is not null then
    if p_dry then
      select count(*) into n from public.mgr_peer_chat
       where string_to_array(room_key, '|') @> array[p_old];
    else
      update public.mgr_peer_chat
         set room_key = array_to_string(
               (select array_agg(x order by x)
                  from unnest(array_replace(string_to_array(room_key, '|'), p_old, p_new)) x), '|')
       where string_to_array(room_key, '|') @> array[p_old];
      get diagnostics n = row_count;
    end if;
    if n > 0 then report := report || jsonb_build_object('mgr_peer_chat.room_key', n); total := total + n; end if;
  end if;

  if to_regclass('public.mgr_peer_reads') is not null then
    if p_dry then
      select count(*) into n from public.mgr_peer_reads
       where string_to_array(room_key, '|') @> array[p_old];
    else
      update public.mgr_peer_reads
         set room_key = array_to_string(
               (select array_agg(x order by x)
                  from unnest(array_replace(string_to_array(room_key, '|'), p_old, p_new)) x), '|')
       where string_to_array(room_key, '|') @> array[p_old];
      get diagnostics n = row_count;
    end if;
    if n > 0 then report := report || jsonb_build_object('mgr_peer_reads.room_key', n); total := total + n; end if;
  end if;

  -- ---------- 5) ลบแถวสาขาเดิม ----------
  if not p_dry then
    delete from public.branches where branch_id = p_old;
    begin
      insert into public.activity_log (action, detail, actor)
      values ('เปลี่ยนรหัสสาขา', p_old || ' → ' || p_new || ' · ย้าย ' || total || ' แถว', 'SQL');
    exception when others then null;   -- ไม่มีตาราง log ก็ไม่เป็นไร
    end;
  end if;

  return json_build_object(
    'ok', true,
    'dry_run', p_dry,
    'old_id', p_old,
    'new_id', p_new,
    'total_rows', total,
    'by_column', report,
    'note', case when p_dry
                 then 'นี่คือการลองดูเท่านั้น ยังไม่มีอะไรถูกแก้ · สั่งจริงด้วย p_dry => false'
                 else 'เปลี่ยนเรียบร้อยแล้ว' end
  );

exception when others then
  return json_build_object('ok', false, 'error', SQLERRM, 'hint',
    'ทั้งหมดถูกย้อนกลับแล้ว ไม่มีข้อมูลเปลี่ยน — ส่งข้อความ error นี้มาให้ดูได้');
end
$$;

grant execute on function public.change_branch_id(text, text, boolean, text, double precision, double precision, int)
  to anon, authenticated;


-- ============================================================
-- วิธีใช้ — ทำตามลำดับนี้
-- ============================================================

-- ขั้น 1  ลองดูก่อนว่าจะกระทบกี่แถว ตารางไหนบ้าง (ยังไม่แก้อะไรทั้งสิ้น)
--
-- select public.change_branch_id('06573', '23024');


-- ขั้น 2  ดูผลแล้วพอใจ ค่อยสั่งจริง พร้อมอัปเดตชื่อและพิกัดร้านใหม่ไปในคราวเดียว
--         ⚠ พิกัดต้องเป็นของร้านใหม่ ไม่งั้นพนักงานลงเวลาไม่ได้ (ติด geofence)
--         เอาพิกัดจาก Google Maps: คลิกขวาที่ตัวร้าน → ตัวเลขชุดแรกคือ lat ชุดหลังคือ lng
--
-- select public.change_branch_id(
--          '06573', '23024',
--          p_dry    => false,
--          p_name   => 'โรงพยาบาลหล่มสัก',
--          p_lat    => 16.7xxxxx,
--          p_lng    => 101.2xxxxx,
--          p_radius => 80);


-- ขั้น 3  ตรวจว่าไม่มีอะไรค้างอยู่กับรหัสเดิม — ต้องได้ 0 ทุกบรรทัด
--
-- select 'branches'        as t, count(*) from public.branches        where branch_id = '06573'
-- union all select 'employees',       count(*) from public.employees        where branch_id = '06573'
-- union all select 'attendance',      count(*) from public.attendance       where branch_id = '06573'
-- union all select 'attendance2',     count(*) from public.attendance       where branch_id2 = '06573'
-- union all select 'schedules',       count(*) from public.schedules        where branch_id = '06573'
-- union all select 'task_assignments',count(*) from public.task_assignments where branch_id = '06573'
-- union all select 'sales_daily',     count(*) from public.sales_daily      where branch_id = '06573'
-- union all select 'stock_uploads',   count(*) from public.stock_uploads    where branch_id = '06573';
