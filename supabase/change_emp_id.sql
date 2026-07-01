-- ============================================================
-- 7-Eleven HR — ฟังก์ชันเปลี่ยน "รหัสพนักงาน" อย่างปลอดภัย
-- รหัสพนักงานเป็นคีย์หลักที่หลายตารางอ้างอิง (attendance, schedules, leaves,
-- warnings, profile_submissions, rule_acks, shift_leads, activity_log,
-- score_events, task_assignments, handovers) — แก้ตรง ๆ ไม่ได้
-- ฟังก์ชันนี้ย้ายข้อมูลทุกตารางให้ครบใน "ทรานแซกชันเดียว" (พลาด = ย้อนกลับหมด)
-- รันบน Supabase: SQL Editor > วาง > Run
-- ============================================================

create or replace function public.change_emp_id(p_old text, p_new text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  p_new := trim(coalesce(p_new, ''));
  p_old := trim(coalesce(p_old, ''));
  if p_new = '' then return json_build_object('ok', false, 'error', 'กรุณากรอกรหัสใหม่'); end if;
  if p_old = p_new then return json_build_object('ok', false, 'error', 'รหัสเดิมกับรหัสใหม่เหมือนกัน'); end if;
  if not exists (select 1 from public.employees where emp_id = p_old) then
    return json_build_object('ok', false, 'error', 'ไม่พบรหัสพนักงานเดิม'); end if;
  if exists (select 1 from public.employees where emp_id = p_new) then
    return json_build_object('ok', false, 'error', 'รหัส ' || p_new || ' มีพนักงานใช้อยู่แล้ว'); end if;

  -- 1) สร้างแถวพนักงานใหม่ด้วยรหัสใหม่ (คัดลอกทุกคอลัมน์)
  insert into public.employees
    (emp_id, name, nickname, start_date, default_shift, branch_id, weekly_off, phone, line_user_id, address,
     emergency_name, emergency_phone, bank_name, bank_account, id_card, photo_url, face_descriptor, active,
     created_at, updated_at, idcard_url, bankbook_url, house_url, edu_url)
  select p_new, name, nickname, start_date, default_shift, branch_id, weekly_off, phone, line_user_id, address,
     emergency_name, emergency_phone, bank_name, bank_account, id_card, photo_url, face_descriptor, active,
     created_at, now(), idcard_url, bankbook_url, house_url, edu_url
  from public.employees where emp_id = p_old;

  -- 2) ย้ายข้อมูลอ้างอิงทุกตาราง old -> new (เฉพาะตารางที่มีจริง)
  if to_regclass('public.attendance')          is not null then update public.attendance          set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.schedules')           is not null then update public.schedules           set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.leaves')              is not null then update public.leaves              set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.warnings')            is not null then update public.warnings            set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.profile_submissions') is not null then update public.profile_submissions set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.rule_acks')           is not null then update public.rule_acks           set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.shift_leads')         is not null then update public.shift_leads         set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.activity_log')        is not null then update public.activity_log        set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.score_events')        is not null then update public.score_events        set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.task_assignments')    is not null then update public.task_assignments    set emp_id = p_new where emp_id = p_old; end if;
  if to_regclass('public.handovers')           is not null then
    update public.handovers set from_emp_id = p_new where from_emp_id = p_old;
    update public.handovers set to_emp_id   = p_new where to_emp_id   = p_old;
  end if;

  -- 3) ลบแถวพนักงานเดิม (ตอนนี้ไม่มีตารางไหนอ้างถึงแล้ว)
  delete from public.employees where emp_id = p_old;

  return json_build_object('ok', true, 'old_id', p_old, 'new_id', p_new);
exception when others then
  return json_build_object('ok', false, 'error', SQLERRM);
end
$$;

grant execute on function public.change_emp_id(text, text) to anon, authenticated;

-- ทดสอบ (ไม่บังคับ): select public.change_emp_id('OLD','NEW');
