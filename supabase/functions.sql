-- ============================================================
-- 7-Eleven HR System — Postgres Functions (RPC)
-- ใช้คำนวณบนฐานข้อมูล (เร็วกว่าทำใน browser) และรวม logic ความปลอดภัย
-- รันหลัง schema.sql + seed.sql
-- ============================================================

-- ---------- ตรวจรหัสผ่าน HR ----------
-- เรียกจาก client: supabase.rpc('hr_check_password', { p_password: '...' })
-- คืน true/false โดยไม่ส่งรหัสจริงกลับ
-- SECURITY DEFINER: ฟังก์ชันรันด้วยสิทธิ์เจ้าของ จึงอ่าน app_config ได้
-- แม้ตาราง app_config จะถูก RLS ล็อกจาก anon (กันรหัส HR รั่ว)
create or replace function public.hr_check_password(p_password text)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_config
    where key = 'hr_password' and value = p_password
  );
$$;

-- ---------- คำนวณสาย/OT ตอนเช็กอิน-เอาท์ ----------
-- คืนค่านาทีที่สาย เทียบกับเวลาเข้ากะ + grace
create or replace function public.calc_late_min(p_shift_id text, p_check_in timestamptz)
returns int
language plpgsql stable
as $$
declare
  v_start time;
  v_grace int;
  v_late  int;
begin
  select start_time, grace_min into v_start, v_grace
  from public.shifts where shift_id = p_shift_id;
  if v_start is null then return 0; end if;

  v_late := extract(epoch from (
    (p_check_in at time zone 'Asia/Bangkok')::time - v_start
  )) / 60;

  v_late := v_late - coalesce(v_grace, 0);
  if v_late < 0 then v_late := 0; end if;
  return v_late;
end;
$$;

-- ---------- KPI Dashboard วันนี้ + แนวโน้ม 30 วัน ----------
-- เรียก: supabase.rpc('hr_dashboard')
create or replace function public.hr_dashboard()
returns jsonb
language plpgsql stable
as $$
declare
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
  v_result jsonb;
begin
  select jsonb_build_object(
    'cards', jsonb_build_object(
      'total_emp', (select count(*) from public.employees where active),
      'checked_in', (select count(*) from public.attendance where work_date = v_today and check_in is not null),
      'late_today', (select count(*) from public.attendance where work_date = v_today and late_min > 0),
      'still_open', (select count(*) from public.attendance where work_date = v_today and status = 'OPEN'),
      'cycle_start', to_char(date_trunc('month', v_today), 'YYYY-MM-DD'),
      'cycle_end',   to_char((date_trunc('month', v_today) + interval '1 month - 1 day'), 'YYYY-MM-DD')
    ),
    'trend', (
      select coalesce(jsonb_agg(t order by t->>'date'), '[]'::jsonb) from (
        select jsonb_build_object(
          'date', to_char(d, 'MM-DD'),
          'late', (select count(*) from public.attendance a where a.work_date = d and a.late_min > 0),
          'ot',   (select coalesce(sum(ot_hours),0) from public.attendance a where a.work_date = d)
        ) as t
        from generate_series(v_today - 29, v_today, interval '1 day') as g(d)
      ) sub
    ),
    'branches', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', b.name,
        'count', (select count(*) from public.attendance a where a.branch_id = b.branch_id and a.work_date = v_today),
        'late',  (select count(*) from public.attendance a where a.branch_id = b.branch_id and a.work_date = v_today and a.late_min > 0)
      )), '[]'::jsonb)
      from public.branches b
    )
  ) into v_result;
  return v_result;
end;
$$;

-- หมายเหตุ: top_late / shifts breakdown สามารถเพิ่มเป็น query แยกฝั่ง client ได้
-- เพื่อความยืดหยุ่น (ดูตัวอย่างใน hr/app.js)
