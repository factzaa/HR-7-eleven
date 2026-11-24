-- ============================================================
-- ปิดข้อมูลส่วนบุคคลในตาราง employees
-- 24 พ.ย. 2569
--
-- ปัญหาที่แก้:
--   แอปคุยกับฐานข้อมูลด้วย anon key ที่อยู่ในไฟล์หน้าเว็บ (รีโปสาธารณะ)
--   ตาราง employees เปิดให้อ่านทั้งตาราง → ดึงข้อมูลพนักงาน 107 คนได้ในคำขอเดียว
--   ในนั้นมี เลขบัตรประชาชน · ที่อยู่ · เบอร์โทร · เบอร์ฉุกเฉิน · เลขบัญชีธนาคาร
--   · ลิงก์รูปบัตร/ทะเบียนบ้าน/วุฒิการศึกษา · ข้อมูลใบหน้า · รหัส PIN ที่เข้ารหัสไว้
--   หนักกว่านั้น: หน้าลงเวลาโหลด face_descriptor ของ "ทุกคน" มาเก็บในเครื่องทุกครั้งที่เปิดแอป
--
-- แนวทาง (ทำเป็นขั้น ไม่ให้ระบบสะดุด):
--   ขั้นนี้ = เพิ่มของใหม่อย่างเดียว ยังไม่ปิดอะไร ของเดิมทำงานเหมือนเดิมทุกอย่าง
--     [1] view employees_pub — เหลือเฉพาะคอลัมน์ที่ไม่อ่อนไหว ให้แอปใช้แทน
--     [2] emp_face_check   — เทียบใบหน้าในฐานข้อมูล ไม่ต้องส่งข้อมูลใบหน้าออกมาที่เครื่องอีก
--     [3] emp_face_register— ลงทะเบียนใบหน้าผ่านฟังก์ชัน แทนการเขียนตารางตรง ๆ
--     [4] emp_profile_self — พนักงานดูโปรไฟล์ตัวเอง (สิทธิ์เท่าเดิม แต่ได้ทีละคน ไม่ใช่ยกตาราง)
--   ขั้นถัดไป = บล็อก [6] ท้ายไฟล์ (ปิดตาราง employees จริง) รันเมื่อยืนยันแล้วว่าขั้นนี้ไม่มีปัญหา
--
-- รันทั้งไฟล์ใน Supabase → SQL Editor ได้เลย · รันซ้ำได้ ไม่พัง
-- ============================================================

-- [1] หน้าต่างสาธารณะของตารางพนักงาน — มีแต่คอลัมน์ที่เปิดได้
--     ตั้งใจไม่ใส่: id_card · address · phone · email · emergency_* · bank_* · *_url เอกสาร
--                  · face_descriptor · pin_* · manager_pin · birth_date · line_user_id
create or replace view public.employees_pub as
select emp_id, name, nickname, branch_id, default_shift, weekly_off, position,
       photo_url, start_date, end_date, active, is_manager, is_rider,
       pin_reset_locked_until, created_at, updated_at
  from public.employees;

grant select on public.employees_pub to anon, authenticated;

-- [2] เทียบใบหน้าในฐานข้อมูล — ส่งใบหน้าที่สแกนได้เข้ามา คืนแค่ ตรง / ไม่ตรง / ยังไม่ลงทะเบียน
--     เดิมหน้าเว็บโหลดใบหน้าของทุกคนมาเทียบเอง ซึ่งเท่ากับแจกข้อมูลชีวมิติให้ทุกเครื่อง
--     คืน null = คนนี้ยังไม่ได้ลงทะเบียนใบหน้า (หน้าเว็บจะบอกให้ไปลงทะเบียนก่อน เหมือนเดิม)
create or replace function public.emp_face_check(
  p_emp_id text, p_descriptor float8[], p_threshold float8 default 0.5)
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp
as $fn$
declare ref float8[]; s float8 := 0; i int; n int;
begin
  if p_emp_id is null or p_descriptor is null or array_length(p_descriptor, 1) is null then
    return null;
  end if;
  -- to_jsonb รองรับทั้งกรณีคอลัมน์เป็น jsonb และเป็น float8[]
  select array(select t.x::float8
                 from jsonb_array_elements_text(to_jsonb(e.face_descriptor)) as t(x))
    into ref
    from public.employees e
   where e.emp_id = p_emp_id and e.face_descriptor is not null;
  if ref is null or array_length(ref, 1) is null then return null; end if;
  n := least(array_length(ref, 1), array_length(p_descriptor, 1));
  if n < 1 then return null; end if;
  for i in 1 .. n loop
    s := s + (ref[i] - p_descriptor[i]) ^ 2;
  end loop;
  return sqrt(s) <= coalesce(p_threshold, 0.5);
exception when others then
  return null;      -- ข้อมูลใบหน้าเพี้ยน → ถือว่ายังไม่ลงทะเบียน ไม่ปล่อยผ่าน
end
$fn$;

-- [3] ลงทะเบียนใบหน้า (สิทธิ์เท่าเดิมกับที่หน้าเว็บทำอยู่ — เขียนได้ด้วยรหัสพนักงาน)
--     ยกมาเป็นฟังก์ชันเพื่อให้ปิดสิทธิ์เขียนตาราง employees ตรง ๆ ได้ในขั้นถัดไป
create or replace function public.emp_face_register(p_emp_id text, p_descriptor float8[])
returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp
as $fn$
declare ctype text; ok int;
begin
  if p_emp_id is null or p_descriptor is null or array_length(p_descriptor, 1) is null then
    raise exception 'ข้อมูลไม่ครบ';
  end if;
  select count(*) into ok from public.employees where emp_id = p_emp_id;
  if ok = 0 then raise exception 'ไม่พบรหัสพนักงานนี้'; end if;
  select atttypid::regtype::text into ctype
    from pg_attribute
   where attrelid = 'public.employees'::regclass and attname = 'face_descriptor' and attnum > 0;
  -- ใช้ SQL แบบ dynamic เพื่อให้รองรับได้ทั้งคอลัมน์ชนิด jsonb และ float8[]
  if ctype = 'jsonb' then
    execute 'update public.employees set face_descriptor = to_jsonb($1::float8[]) where emp_id = $2'
      using p_descriptor, p_emp_id;
  else
    execute 'update public.employees set face_descriptor = $1::float8[] where emp_id = $2'
      using p_descriptor, p_emp_id;
  end if;
  return true;
end
$fn$;

-- [4] โปรไฟล์ของตัวเอง — คืนทีละคน แทนการเปิดให้อ่านทั้งตาราง
--     หมายเหตุตรง ๆ: ขั้นนี้ยัง "รู้รหัสพนักงานก็เรียกได้" เท่าเดิมกับของเดิม
--     สิ่งที่เปลี่ยนคือดึงยกตาราง 107 คนในคำขอเดียวไม่ได้อีกแล้ว
--     ถ้าจะให้แน่นกว่านี้ต้องบังคับสแกนหน้า/ใส่ PIN ก่อน ซึ่งกระทบขั้นตอนใช้งาน ค่อยตัดสินใจรอบหน้า
create or replace function public.emp_profile_self(p_emp_id text)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $fn$
  select to_jsonb(x) from (
    select emp_id, name, nickname, active, branch_id, start_date, end_date, is_manager,
           phone, email, address, emergency_name, emergency_phone,
           bank_name, bank_account, id_card,
           photo_url, idcard_url, bankbook_url, house_url, edu_url
      from public.employees where emp_id = p_emp_id
  ) x;
$fn$;

revoke all on function public.emp_face_check(text, float8[], float8) from public;
revoke all on function public.emp_face_register(text, float8[]) from public;
revoke all on function public.emp_profile_self(text) from public;
grant execute on function public.emp_face_check(text, float8[], float8) to anon, authenticated;
grant execute on function public.emp_face_register(text, float8[]) to anon, authenticated;
grant execute on function public.emp_profile_self(text) to anon, authenticated;

-- [5] ตรวจว่าของใหม่พร้อมใช้
select 'employees_pub' as ของ,
       (select count(*) from public.employees_pub) as แถว,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='employees_pub') as คอลัมน์
union all
select 'ฟังก์ชันที่สร้าง', count(*), 3
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('emp_face_check','emp_face_register','emp_profile_self');
-- ควรได้: employees_pub มี 16 คอลัมน์ · ฟังก์ชัน 3 ตัว

-- ============================================================
-- [6] ★ ขั้นปิดจริง — ยังไม่ต้องรันตอนนี้
--     รันหลังจากใช้แอปรุ่นใหม่ (v305) แล้วมั่นใจว่าทุกหน้าปกติดี
--     ปิดแล้ว: anon key เปล่า ๆ อ่าน/เขียน employees ไม่ได้เลย
--              หน้า HR ยังใช้ได้ เพราะแนบรหัส HR มากับคำขอ (x-hr-pass)
--     ถอยกลับ: บล็อก [7]
-- ============================================================
-- create or replace function public.hr_req_ok()
-- returns boolean language plpgsql stable security definer set search_path = public, pg_temp
-- as $fn$
-- declare h text;
-- begin
--   begin
--     h := nullif(current_setting('request.headers', true)::json ->> 'x-hr-pass', '');
--   exception when others then return false;
--   end;
--   if h is null then return false; end if;
--   return coalesce(public.hr_check_password(h), false);
-- exception when others then return false;
-- end
-- $fn$;
-- revoke all on function public.hr_req_ok() from public;
-- grant execute on function public.hr_req_ok() to anon, authenticated;
--
-- do $blk$
-- declare p record;
-- begin
--   execute 'alter table public.employees enable row level security';
--   for p in select policyname from pg_policies where schemaname='public' and tablename='employees' loop
--     execute format('drop policy %I on public.employees', p.policyname);
--   end loop;
--   execute 'create policy emp_gate on public.employees for all to anon, authenticated '
--        || 'using (public.hr_req_ok()) with check (public.hr_req_ok())';
-- end
-- $blk$;

-- ============================================================
-- [7] ถอยกลับจากบล็อก [6]
-- ============================================================
-- drop policy if exists emp_gate on public.employees;
-- alter table public.employees disable row level security;
