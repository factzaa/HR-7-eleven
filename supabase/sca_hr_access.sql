-- ============================================================
-- เช็กลิสต์ SCA — ให้ HR เข้าด้วยรหัสผ่านได้                  6 พ.ย. 69
--
-- ปัญหาที่แก้
--   ของเดิมเปิดหน้านี้ได้ด้วย "รหัสพนักงาน" อย่างเดียว
--   แต่ HR สำนักงานไม่มีรหัสพนักงาน จึงเข้าไม่ได้เลย
--   (พลาดแบบเดียวกับตอนทำประตูหน้าแรก — ที่นั่นแก้ด้วยการรับรหัสผ่าน HR ในช่องเดียวกัน)
--
--   อีกเรื่องคือ HR ไม่ได้สังกัดสาขาใดสาขาหนึ่ง ต่างจากพนักงาน
--   การติ๊กผูกกับสาขาเสมอ HR จึงต้อง "เลือกสาขา" ก่อน ฟังก์ชันพวกนี้เลยรับ branch_id เข้ามา
--
-- ไฟล์นี้เพิ่มของใหม่อย่างเดียว ไม่แก้ไม่ลบอะไรที่มีอยู่
-- ต้องรัน supabase/sca_setup.sql ไปแล้ว · รันซ้ำได้
-- ============================================================


-- ---------- 1) อ่านเช็กลิสต์ด้วยรหัสผ่าน HR ----------
create or replace function public.sca_checklist_hr(
  p_password  text,
  p_branch_id text,
  p_cycle     text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle  text;
  v_branch text;
  v_name   text;
begin
  if not coalesce(public.hr_check_password(p_password), false) then
    return json_build_object('ok', false, 'error', 'รหัสผ่าน HR ไม่ถูกต้อง');
  end if;

  v_branch := trim(coalesce(p_branch_id, ''));
  if v_branch = '' then
    return json_build_object('ok', false, 'error', 'ยังไม่ได้เลือกสาขา');
  end if;
  select b.name into v_name from public.branches b where b.branch_id = v_branch;
  if not found then
    return json_build_object('ok', false, 'error', 'ไม่พบสาขารหัส ' || v_branch);
  end if;

  v_cycle := coalesce(nullif(trim(coalesce(p_cycle, '')), ''),
                      to_char((now() at time zone 'Asia/Bangkok')::date, 'YYYY-MM'));

  return json_build_object(
    'ok', true,
    'hr', true,
    'emp', json_build_object('emp_id', null, 'name', 'HR สำนักงาน',
                             'nickname', 'HR', 'branch_id', v_branch, 'branch_name', v_name),
    'cycle', v_cycle,
    'roles', coalesce((
      select json_agg(row_to_json(r) order by r.sort, r.role)
        from (select role, name, full_name, night, is_voe, rules, sort
                from public.sca_roles where active) r), '[]'::json),
    'items', coalesce((
      select json_agg(row_to_json(i) order by i.role, i.sort, i.n)
        from (select id, role, n, d, grp, icon, title, purpose, who, psao,
                     points, output, evid, sample, car, tip, caution, sort
                from public.sca_items where active) i), '[]'::json),
    'ticks', coalesce((
      select json_agg(json_build_array(l.shift, l.role, l.item_id, l.line_kind, l.line_idx))
        from public.sca_check_logs l
       where l.branch_id = v_branch and l.cycle = v_cycle and l.done), '[]'::json)
  );
end
$$;


-- ---------- 2) ติ๊ก / ยกเลิกติ๊ก ด้วยรหัสผ่าน HR ----------
create or replace function public.sca_tick_hr(
  p_password  text,
  p_branch_id text,
  p_shift     text,
  p_role      text,
  p_item_id   bigint,
  p_kind      text,
  p_idx       int,
  p_done      boolean
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle  text;
  v_branch text;
begin
  if not coalesce(public.hr_check_password(p_password), false) then
    return json_build_object('ok', false, 'error', 'รหัสผ่าน HR ไม่ถูกต้อง');
  end if;

  v_branch := trim(coalesce(p_branch_id, ''));
  if not exists (select 1 from public.branches where branch_id = v_branch) then
    return json_build_object('ok', false, 'error', 'ไม่พบสาขานี้');
  end if;
  if p_shift not in ('day', 'night', 'all') then
    return json_build_object('ok', false, 'error', 'ผลัดไม่ถูกต้อง');
  end if;
  if p_kind not in ('p', 'e') then
    return json_build_object('ok', false, 'error', 'ชนิดบรรทัดไม่ถูกต้อง');
  end if;
  if not exists (select 1 from public.sca_items where id = p_item_id and active) then
    return json_build_object('ok', false, 'error', 'ไม่พบข้อตรวจนี้');
  end if;

  v_cycle := to_char((now() at time zone 'Asia/Bangkok')::date, 'YYYY-MM');

  -- emp_id เว้นว่างไว้เพราะ HR ไม่มีรหัสพนักงาน · emp_name เขียนว่า HR ให้รู้ว่าใครติ๊ก
  if coalesce(p_done, false) then
    insert into public.sca_check_logs
      (branch_id, cycle, shift, role, item_id, line_kind, line_idx, done, emp_id, emp_name, updated_at)
    values
      (v_branch, v_cycle, p_shift, p_role, p_item_id, p_kind, p_idx, true, null, 'HR สำนักงาน', now())
    on conflict (branch_id, cycle, shift, role, item_id, line_kind, line_idx)
    do update set done = true, emp_id = null, emp_name = 'HR สำนักงาน', updated_at = now();
  else
    delete from public.sca_check_logs
     where branch_id = v_branch and cycle = v_cycle and shift = p_shift
       and role = p_role and item_id = p_item_id and line_kind = p_kind and line_idx = p_idx;
  end if;

  return json_build_object('ok', true);
end
$$;


-- ---------- 3) ล้างการติ๊กทั้งตำแหน่ง ด้วยรหัสผ่าน HR ----------
create or replace function public.sca_clear_hr(
  p_password  text,
  p_branch_id text,
  p_shift     text,
  p_role      text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle text;
  v_n int;
begin
  if not coalesce(public.hr_check_password(p_password), false) then
    return json_build_object('ok', false, 'error', 'รหัสผ่าน HR ไม่ถูกต้อง');
  end if;

  v_cycle := to_char((now() at time zone 'Asia/Bangkok')::date, 'YYYY-MM');
  delete from public.sca_check_logs
   where branch_id = trim(coalesce(p_branch_id, '')) and cycle = v_cycle
     and shift = p_shift and role = p_role;
  get diagnostics v_n = row_count;
  return json_build_object('ok', true, 'cleared', v_n);
end
$$;


-- ---------- 4) รายชื่อสาขาให้ HR เลือก ----------
--   ตาราง branches เปิดให้ anon อ่านอยู่แล้ว (หน้าสมัครงานใช้) แต่ทำเป็นฟังก์ชันไว้
--   เพื่อให้หน้า SCA เรียกที่เดียวจบ และกันไว้เผื่ออนาคตปิดสิทธิ์ตาราง branches
create or replace function public.sca_branches_hr(p_password text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.hr_check_password(p_password), false) then
    return json_build_object('ok', false, 'error', 'รหัสผ่าน HR ไม่ถูกต้อง');
  end if;
  return json_build_object('ok', true, 'branches', coalesce((
    select json_agg(json_build_object('branch_id', b.branch_id, 'name', b.name) order by b.branch_id)
      from public.branches b), '[]'::json));
end
$$;


grant execute on function public.sca_checklist_hr(text, text, text)                            to anon, authenticated;
grant execute on function public.sca_tick_hr(text, text, text, text, bigint, text, int, boolean) to anon, authenticated;
grant execute on function public.sca_clear_hr(text, text, text, text)                          to anon, authenticated;
grant execute on function public.sca_branches_hr(text)                                         to anon, authenticated;


-- ============================================================
-- ตรวจหลังรัน — ต้องได้ 4 ฟังก์ชัน
--
-- select routine_name from information_schema.routines
--  where routine_schema='public' and routine_name like 'sca\_%\_hr' order by 1;
--
-- ลองด้วยรหัสผิด ต้องได้ ok=false (อย่าพิมพ์รหัสจริงทิ้งไว้ในหน้าต่าง SQL)
-- select public.sca_branches_hr('รหัสผิด');
-- ============================================================
