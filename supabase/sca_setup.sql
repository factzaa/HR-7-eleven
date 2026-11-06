-- ============================================================
-- เช็กลิสต์รับตรวจ SCA — โครงสร้างตาราง                     6 พ.ย. 69
--
-- ไฟล์นี้มีแต่ "โครง" ไม่มีเนื้อหาแบบตรวจ จึงอยู่ใน repo ได้
-- เนื้อหาจริง (จุดตรวจ หลักฐาน เกณฑ์ CARs) อยู่ในไฟล์ seed แยกต่างหาก
-- ซึ่งห้ามอัปขึ้น GitHub เพราะ repo เป็นสาธารณะ
--
-- ทำไมเนื้อหาต้องอยู่ในฐานข้อมูล ไม่ฝังในหน้าเว็บ
--   repo เปิดสาธารณะ ใครก็โหลดไฟล์ดิบอ่านได้โดยไม่ต้องผ่านรหัส
--   การล็อกหน้าเว็บจึงไม่ช่วยอะไรเลย ต้องเอาเนื้อหาออกจากไฟล์
--
-- ระดับการป้องกันที่ไฟล์นี้ทำให้ (ระดับ 2 ตามที่ตกลงกันไว้)
--   ปิดไม่ให้ anon อ่านตารางตรง ๆ แล้วให้อ่านผ่านฟังก์ชันแทน
--   ฟังก์ชันตรวจก่อนว่า "รหัสพนักงานที่ส่งมา" มีจริงและยังทำงานอยู่
--   → ลำพัง anon key ที่อยู่ในหน้าเว็บ ดึงเนื้อหาไม่ได้ ต้องมีรหัสพนักงานด้วย
--
--   ข้อจำกัดที่ต้องรู้: แอปนี้ไม่มี Supabase Auth ต่อคน ทุกคำขอเป็น anon เหมือนกัน
--   คนที่มีทั้ง anon key และรหัสพนักงานที่ใช้งานอยู่ ยังดึงได้อยู่ดี
--   ถ้าต้องการแน่นกว่านี้ ค่อยเพิ่มให้ฟังก์ชันรับ PIN ที่ผ่าน staff_pin_login แล้ว
--
-- ⚠ สำรองฐานข้อมูลก่อนรันจริง (Supabase → Database → Backups)
-- รันซ้ำได้ ไม่ลบข้อมูลเดิม
-- ============================================================


-- ---------- 1) ตำแหน่งและกติกาสุ่มตรวจ ----------
create table if not exists public.sca_roles (
  role      text primary key,                      -- mgr | asst | staff | cash | voe
  name      text not null,                         -- ชื่อสั้นบนปุ่มเลือกตำแหน่ง
  full_name text,                                  -- ชื่อเต็มบนหัวข้อ
  night     boolean not null default false,        -- มีในผลัดดึกไหม
  is_voe    boolean not null default false,        -- เป็นส่วนแบบสำรวจ VOE
  rules     jsonb,                                 -- {"A":"ตรวจทุกข้อ (5 ข้อ)","B":"เลือก 2 จาก 3 ข้อ","C":null}
  sort      int not null default 0,
  active    boolean not null default true
);


-- ---------- 2) ข้อตรวจ ----------
--   ชื่อฟิลด์ล้อของเดิมในหน้าเว็บ เปลี่ยนแค่ g → grp เพราะ group เป็นคำสงวนของ SQL
create table if not exists public.sca_items (
  id      bigserial primary key,
  role    text not null references public.sca_roles(role) on update cascade on delete cascade,
  n       int,              -- เลขข้อผลัดปกติ
  d       int,              -- เลขข้อผลัดดึก (ว่าง = ข้อนี้ไม่มีในผลัดดึก)
  grp     text,             -- A | B | C | ว่าง
  icon    text,
  title   text not null,
  purpose text,
  who     text,             -- ข้อนี้ผู้ตรวจเลือกถามกับใคร
  psao    boolean not null default false,   -- ข้อที่ต้องโชว์แถบ PSAO
  points  text[],           -- ผู้ตรวจจะดูอะไร
  output  text[],           -- ผ่านเมื่อเห็นผลลัพธ์นี้
  evid    jsonb,            -- [["ชื่อหลักฐาน","แนวเตรียม"], {"h":"หัวข้อกลุ่ม"}, ...]
  sample  text[],           -- ผู้ตรวจจะสุ่มอะไร
  car     text[],           -- พลาดตรงไหนถึงโดน CARs
  tip     text[],           -- ออกเป็นข้อเสนอแนะ
  caution text[],           -- ข้อควรระวัง
  sort    int not null default 0,
  active  boolean not null default true
);
create index if not exists idx_sca_items_role on public.sca_items (role, sort);

-- evid เก็บเป็น jsonb เพราะมีสองรูปแบบปนกัน
--   คู่  ["ชื่อหลักฐาน","แนวเตรียม"]  = บรรทัดที่ติ๊กได้
--   กลุ่ม {"h":"ประเภท Food"}          = หัวข้อคั่น ไม่ใช่ช่องติ๊ก
-- ลำดับ e0 e1 e2 ที่ใช้เป็นกุญแจติ๊ก นับเฉพาะแบบคู่เท่านั้น


-- ---------- 3) การติ๊กความคืบหน้า ----------
--   ละเอียดถึงระดับบรรทัดย่อย เท่ากับที่หน้าเว็บเดิมเก็บใน localStorage
--   ผูกกับ item_id ไม่ใช่เลขข้อ เพราะเลขข้ออาจขยับเมื่อแบบตรวจเปลี่ยนฉบับ แต่ id คงที่
create table if not exists public.sca_check_logs (
  id         bigserial primary key,
  branch_id  text not null,
  cycle      text not null,                 -- 'YYYY-MM'
  shift      text not null,                 -- 'day' | 'night' | 'all' (VOE ใช้ all)
  role       text not null,
  item_id    bigint not null references public.sca_items(id) on delete cascade,
  line_kind  text not null,                 -- 'p' = จุดตรวจ · 'e' = หลักฐาน
  line_idx   int  not null,
  done       boolean not null default true,
  emp_id     text,
  emp_name   text,
  updated_at timestamptz not null default now(),
  unique (branch_id, cycle, shift, role, item_id, line_kind, line_idx)
);
create index if not exists idx_sca_logs_branch on public.sca_check_logs (branch_id, cycle);


-- ---------- 4) ปิดไม่ให้อ่านตารางตรง ๆ ----------
--   เนื้อหาแบบตรวจต้องออกทางฟังก์ชันเท่านั้น
alter table public.sca_roles      enable row level security;
alter table public.sca_items      enable row level security;
alter table public.sca_check_logs enable row level security;

-- ไม่สร้าง policy ใด ๆ = anon เข้าไม่ถึงเลย
-- และเพิกถอนสิทธิ์ตารางออกจาก role ที่ PostgREST ใช้ ให้แน่ใจอีกชั้น
revoke all on table public.sca_roles      from anon, authenticated;
revoke all on table public.sca_items      from anon, authenticated;
revoke all on table public.sca_check_logs from anon, authenticated;


-- ---------- 5) ฟังก์ชันอ่านเช็กลิสต์ ----------
--   ตรวจรหัสพนักงานก่อน แล้วคืนทั้ง ตำแหน่ง + ข้อตรวจ + การติ๊กของสาขานั้นในรอบนั้น
create or replace function public.sca_checklist(
  p_emp_id text,
  p_cycle  text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp    record;
  v_cycle  text;
begin
  select e.emp_id, e.name, e.nickname, e.branch_id, e.active
    into v_emp
    from public.employees e
   where e.emp_id = trim(coalesce(p_emp_id, ''));

  if not found then
    return json_build_object('ok', false, 'error', 'ไม่พบรหัสพนักงานนี้');
  end if;
  if not coalesce(v_emp.active, false) then
    return json_build_object('ok', false, 'error', 'รหัสนี้ไม่ได้ทำงานแล้ว');
  end if;

  v_cycle := coalesce(nullif(trim(coalesce(p_cycle, '')), ''),
                      to_char((now() at time zone 'Asia/Bangkok')::date, 'YYYY-MM'));

  return json_build_object(
    'ok', true,
    'emp', json_build_object('emp_id', v_emp.emp_id, 'name', v_emp.name,
                             'nickname', v_emp.nickname, 'branch_id', v_emp.branch_id),
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
       where l.branch_id = v_emp.branch_id and l.cycle = v_cycle and l.done), '[]'::json)
  );
end
$$;


-- ---------- 6) ฟังก์ชันติ๊ก / ยกเลิกติ๊ก ----------
create or replace function public.sca_tick(
  p_emp_id  text,
  p_shift   text,
  p_role    text,
  p_item_id bigint,
  p_kind    text,
  p_idx     int,
  p_done    boolean
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp record;
  v_cycle text;
begin
  select e.emp_id, e.name, e.nickname, e.branch_id, e.active
    into v_emp
    from public.employees e
   where e.emp_id = trim(coalesce(p_emp_id, ''));

  if not found or not coalesce(v_emp.active, false) then
    return json_build_object('ok', false, 'error', 'รหัสพนักงานไม่ถูกต้อง');
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

  if coalesce(p_done, false) then
    insert into public.sca_check_logs
      (branch_id, cycle, shift, role, item_id, line_kind, line_idx, done, emp_id, emp_name, updated_at)
    values
      (v_emp.branch_id, v_cycle, p_shift, p_role, p_item_id, p_kind, p_idx, true,
       v_emp.emp_id, coalesce(v_emp.nickname, v_emp.name), now())
    on conflict (branch_id, cycle, shift, role, item_id, line_kind, line_idx)
    do update set done = true, emp_id = excluded.emp_id,
                  emp_name = excluded.emp_name, updated_at = now();
  else
    delete from public.sca_check_logs
     where branch_id = v_emp.branch_id and cycle = v_cycle and shift = p_shift
       and role = p_role and item_id = p_item_id and line_kind = p_kind and line_idx = p_idx;
  end if;

  return json_build_object('ok', true);
end
$$;


-- ---------- 7) ฟังก์ชันล้างการติ๊กทั้งตำแหน่ง ----------
create or replace function public.sca_clear(
  p_emp_id text,
  p_shift  text,
  p_role   text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp record;
  v_cycle text;
  v_n int;
begin
  select e.emp_id, e.branch_id, e.active into v_emp
    from public.employees e where e.emp_id = trim(coalesce(p_emp_id, ''));
  if not found or not coalesce(v_emp.active, false) then
    return json_build_object('ok', false, 'error', 'รหัสพนักงานไม่ถูกต้อง');
  end if;

  v_cycle := to_char((now() at time zone 'Asia/Bangkok')::date, 'YYYY-MM');
  delete from public.sca_check_logs
   where branch_id = v_emp.branch_id and cycle = v_cycle
     and shift = p_shift and role = p_role;
  get diagnostics v_n = row_count;
  return json_build_object('ok', true, 'cleared', v_n);
end
$$;


-- ---------- 8) ฟังก์ชันสรุปความคืบหน้ารายสาขา (ให้ ผจก. ดู) ----------
create or replace function public.sca_progress(
  p_emp_id text,
  p_cycle  text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp   record;
  v_cycle text;
begin
  select e.emp_id, e.branch_id, e.active into v_emp
    from public.employees e where e.emp_id = trim(coalesce(p_emp_id, ''));
  if not found or not coalesce(v_emp.active, false) then
    return json_build_object('ok', false, 'error', 'รหัสพนักงานไม่ถูกต้อง');
  end if;

  v_cycle := coalesce(nullif(trim(coalesce(p_cycle, '')), ''),
                      to_char((now() at time zone 'Asia/Bangkok')::date, 'YYYY-MM'));

  return json_build_object(
    'ok', true,
    'branch_id', v_emp.branch_id,
    'cycle', v_cycle,
    'by_role', coalesce((
      select json_agg(json_build_object(
               'role', t.role, 'shift', t.shift, 'ticked', t.c,
               'last_by', t.who, 'last_at', t.at) order by t.role, t.shift)
        from (select l.role, l.shift, count(*) c,
                     (array_agg(l.emp_name order by l.updated_at desc))[1] who,
                     max(l.updated_at) at
                from public.sca_check_logs l
               where l.branch_id = v_emp.branch_id and l.cycle = v_cycle and l.done
               group by l.role, l.shift) t), '[]'::json)
  );
end
$$;


-- ---------- 9) เปิดให้หน้าเว็บเรียกได้เฉพาะฟังก์ชัน ----------
grant execute on function public.sca_checklist(text, text)                        to anon, authenticated;
grant execute on function public.sca_tick(text, text, text, bigint, text, int, boolean) to anon, authenticated;
grant execute on function public.sca_clear(text, text, text)                      to anon, authenticated;
grant execute on function public.sca_progress(text, text)                         to anon, authenticated;


-- ============================================================
-- ตรวจหลังรัน — ควรได้ 3 ตาราง และ 4 ฟังก์ชัน
--
-- select table_name from information_schema.tables
--  where table_schema='public' and table_name like 'sca_%' order by 1;
--
-- select routine_name from information_schema.routines
--  where routine_schema='public' and routine_name like 'sca_%' order by 1;
--
-- ยืนยันว่า anon อ่านตารางตรง ๆ ไม่ได้ (ต้องได้ false ทั้งสามบรรทัด)
-- select has_table_privilege('anon','public.sca_items','select')      as items,
--        has_table_privilege('anon','public.sca_roles','select')      as roles,
--        has_table_privilege('anon','public.sca_check_logs','select') as logs;
-- ============================================================
