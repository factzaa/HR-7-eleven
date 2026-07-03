-- ============================================================================
-- RLS TEMPLATE / แนวทางตั้งค่า Row Level Security สำหรับ HR 7-Eleven
-- ============================================================================
-- ⚠️ ไฟล์นี้เป็น "แม่แบบ/คำแนะนำ" — อย่าเพิ่งรันทั้งไฟล์กับฐานข้อมูลที่ใช้งานจริง
--    เพราะระบบปัจจุบันเขียน/ลบข้อมูลผ่าน anon key โดยตรงจากเบราว์เซอร์
--    การล็อก RLS ทันทีจะทำให้ฟีเจอร์ที่เขียน/ลบข้อมูลใช้ไม่ได้ จนกว่าจะย้าย
--    งานเขียนไปไว้หลัง RPC / Edge Function (ดู PART B) หรือเพิ่มระบบ Login (PART A)
--
-- ข้อจำกัดสำคัญที่ต้องเข้าใจก่อน:
--   ระบบนี้เป็น "frontend-only + anon key" ไม่มีการยืนยันตัวตน (Auth) ต่อคน
--   → ฐานข้อมูล "ไม่รู้" ว่าใครเป็นใคร ทุกคำขอมาในฐานะ role = anon เหมือนกันหมด
--   → ด้วย anon key อย่างเดียว "ไม่สามารถ" กันการแก้ไขข้ามพนักงานได้จริง
--     (ใครก็ตามที่มี anon key = ทำได้ทุกอย่างเท่าที่ policy อนุญาตให้ anon ทำ)
--   การกันข้ามคนได้จริง ต้องมี "ตัวตน" ให้ DB ตรวจ = ทำได้ 2 ทาง (A หรือ B)
-- ============================================================================


-- ============================================================================
-- PART A — แนะนำระยะยาว: ใช้ Supabase Auth + RLS อิงตัวตน (ปลอดภัยที่สุด)
-- ============================================================================
-- แนวคิด: ให้พนักงาน/HR มี auth user (เช่น login ด้วยรหัสพนักงาน+PIN หรือ magic link)
--   แล้วผูก auth.uid() เข้ากับ emp_id ผ่านตาราง profiles → policy ตรวจจาก auth.uid()
--
-- 1) ตารางเชื่อม auth กับพนักงาน
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  emp_id  text unique references public.employees(emp_id),
  role    text not null default 'employee'   -- 'employee' | 'hr'
);
alter table public.profiles enable row level security;
create policy "read own profile" on public.profiles
  for select to authenticated using (user_id = auth.uid());

-- helper: emp_id ของผู้ใช้ที่ล็อกอินอยู่ / เป็น HR ไหม
create or replace function public.current_emp_id() returns text
  language sql stable security definer set search_path = public as
$$ select emp_id from public.profiles where user_id = auth.uid() $$;
create or replace function public.is_hr() returns boolean
  language sql stable security definer set search_path = public as
$$ select exists(select 1 from public.profiles where user_id = auth.uid() and role = 'hr') $$;

-- 2) ตัวอย่าง policy: attendance — พนักงานเห็น/บันทึกได้เฉพาะของตัวเอง, HR เห็นได้ทั้งหมด
alter table public.attendance enable row level security;
create policy "att_select_own_or_hr" on public.attendance
  for select to authenticated using (emp_id = current_emp_id() or is_hr());
create policy "att_insert_own"       on public.attendance
  for insert to authenticated with check (emp_id = current_emp_id());
create policy "att_update_own_or_hr" on public.attendance
  for update to authenticated using (emp_id = current_emp_id() or is_hr());
-- ❗ ไม่ให้พนักงานลบ (ไม่มี policy for delete) — เฉพาะ HR ลบผ่าน RPC/Edge เท่านั้น
create policy "att_delete_hr"        on public.attendance
  for delete to authenticated using (is_hr());

-- 3) ข้อมูลส่วนบุคคล (employees) — ล็อกไม่ให้ anon อ่าน, พนักงานเห็นแถวตัวเอง, HR เห็นหมด
alter table public.employees enable row level security;
create policy "emp_select_self_or_hr" on public.employees
  for select to authenticated using (emp_id = current_emp_id() or is_hr());
create policy "emp_write_hr"          on public.employees
  for all    to authenticated using (is_hr()) with check (is_hr());

-- (ทำแบบเดียวกันกับ leaves, task_assignments, checkout_corrections, special_task_assignees,
--  qa_items, warnings, score_events ฯลฯ — เห็น/แก้เฉพาะของตัวเอง, HR ได้ทั้งหมด)


-- ============================================================================
-- PART B — ทางลัดระยะสั้น (ยังไม่ทำ Login): ปิดการเขียนตรง + ผ่าน RPC เท่านั้น
-- ============================================================================
-- แนวคิด: ยกเลิกสิทธิ์ INSERT/UPDATE/DELETE ตรง ๆ ของ anon แล้วบังคับให้ทุกการเขียน
--   ผ่านฟังก์ชัน SECURITY DEFINER (RPC) ที่เราคุมตรรกะ/ตรวจสอบเองได้ (กันยิงลบมั่ว)
--   ข้อดี: ลดความเสียหายได้มากโดยไม่ต้องเพิ่มระบบ login
--   ข้อเสีย: ต้องแก้ฝั่ง client ให้เรียก rpc() แทนการ .insert()/.update()/.delete() ตรง
--
-- ตัวอย่าง: ยกเลิกสิทธิ์เขียนตรงบน attendance ให้ anon (ยังอ่านได้)
revoke insert, update, delete on public.attendance from anon;
-- แล้วสร้าง RPC สำหรับเช็กอิน (ตรวจสอบภายในเองได้ เช่น กันเช็กอินซ้ำ)
create or replace function public.emp_check_in(p_emp text, p_shift text, p_branch text, p_lat float8, p_lng float8)
returns void language plpgsql security definer set search_path = public as $$
begin
  -- ใส่ตรรกะตรวจสอบ + insert ที่นี่ (โค้ดนี้รันด้วยสิทธิ์เจ้าของฟังก์ชัน ไม่ใช่ anon)
  insert into public.attendance(emp_id, work_date, shift_id, branch_id, check_in, status)
  values (p_emp, (now() at time zone 'Asia/Bangkok')::date, p_shift, p_branch, now(), 'OPEN')
  on conflict (emp_id, work_date) do nothing;
end $$;
grant execute on function public.emp_check_in(text,text,text,float8,float8) to anon;

-- ล็อกตารางที่อ่อนไหวไม่ให้ anon แตะเลย (เข้าถึงผ่าน RPC/Edge ที่เราคุม)
revoke all on public.app_config       from anon;   -- (ควรถูกล็อกอยู่แล้ว)
revoke delete on public.employees      from anon;   -- กันลบพนักงานมั่ว
revoke delete on public.leaves         from anon;
revoke delete on public.warnings       from anon;
revoke delete on public.score_events   from anon;
-- ⚠️ ถ้ารันบรรทัด revoke ข้างบนตอนนี้ ฟีเจอร์ที่ลบผ่าน client จะใช้ไม่ได้ทันที
--    ต้องย้ายการลบไปทำผ่าน RPC/Edge (ที่ยืนยันรหัส HR) ก่อน


-- ============================================================================
-- PART C — ป้องกันความเสียหายขั้นต่ำที่ "ทำได้เลย" โดยกระทบฟีเจอร์น้อยสุด
-- ============================================================================
-- ตารางที่เป็น "log/หลักฐาน" ไม่ควรถูกแก้/ลบจากฝั่ง client เลย → ปิด update/delete
-- (ระบบปัจจุบันมีแต่ insert/read ตารางเหล่านี้ จึงปิด upd/del ได้โดยไม่กระทบ)
revoke update, delete on public.activity_log   from anon;
revoke update, delete on public.rule_acks      from anon;
revoke update, delete on public.notify_sent    from anon;   -- กันกดปิดแจ้งเตือน HR
-- storage: เปลี่ยน bucket เอกสาร/รูปลงเวลาเป็น private แล้วเสิร์ฟผ่าน signed URL
--   (ทำที่ Dashboard > Storage > bucket > ปิด Public; ออก signed URL จาก Edge Function)

-- ============================================================================
-- สรุปแนวทางที่แนะนำตามลำดับ:
--   1) ทำ PART C ก่อน (เสี่ยงต่ำ ลดการถูกลบ log/แจ้งเตือน + ปิด bucket public)
--   2) วางแผน PART A (Auth) เป็นเป้าหมายจริงเพื่อกันข้ามพนักงาน + ปกป้อง PDPA
--   3) ระหว่างทางใช้ PART B ย้ายงานเขียนสำคัญไป RPC ทีละส่วน
-- ============================================================================
