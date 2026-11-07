-- ============================================================
-- แก้ย้ายรหัส/ย้ายสาขาพนักงาน — 2 อาการ                7 พ.ย. 69
--
--   อาการที่ 1  กดย้ายรหัสแล้วไม่ผ่าน ขึ้นข้อความว่ายังไม่ได้ติดตั้งฟังก์ชัน
--   อาการที่ 2  คนที่ย้ายสาขาไปแล้ว ยังขึ้นงานของสาขาเดิมอยู่
--
--   สองอาการนี้คนละเรื่องกัน แก้คนละส่วน แต่อยู่ในไฟล์เดียวกันเพราะแก้ที่ฟังก์ชันตัวเดียวกัน
-- ============================================================


-- ============================================================
-- อาการที่ 1 — "ย้ายรหัสพนักงานไม่ได้"
--   กดยืนยันย้ายรหัส แล้วขึ้น
--          "ติดตั้ง transfer_emp.sql แล้วหรือยัง? (canceling statement due to statement timeout)"
--
-- สาเหตุจริง — ไม่ใช่ว่ายังไม่ได้ติดตั้ง  (ข้อความนั้นเดาผิดมาตลอด)
--   ฟังก์ชัน transfer_emp ติดตั้งอยู่แล้วและทำงานถูก แต่ "ช้าเกินเพดานเวลา"
--
--   หน้าเว็บคุยกับฐานข้อมูลในฐานะ role `anon` ซึ่งตั้ง statement_timeout = 3 วินาที
--   (authenticated = 8s · postgres/service_role = ไม่จำกัด)
--
--   วัดของจริงกับพนักงานรหัส 1077504 ที่ย้ายไม่ผ่าน:
--     · ตารางที่มีคอลัมน์ emp_id      54 ตาราง (31 ตารางมีข้อมูลของคนนี้จริง รวม 2,340 แถว)
--     · แค่ "นับ" อย่างเดียวไม่เขียนอะไรเลย   ใช้ 1,406 ms
--     · คอลัมน์รหัสที่ชื่อไม่ใช่ emp_id อีก 14 ช่อง  ใช้อีก 1,306 ms
--       (task_assignments 21,823 แถว ถูกสแกนทั้งตาราง 3 รอบ เพราะไม่มีดัชนี)
--     → รวมแค่ "อ่าน" ก็ 2.7 วินาที ยังไม่นับงานเขียน + information_schema ที่ฟังก์ชันเรียก
--       ชน 3 วินาทีแน่นอน
--
--   ทำไมถึงเพิ่งมาพังตอนนี้: ตอนเขียนฟังก์ชันมี emp_id ไม่กี่ตาราง ตอนนี้ 54 ตาราง
--   ระบบโตขึ้นเรื่อย ๆ ฟังก์ชันจึงช้าขึ้นเรื่อย ๆ จนวันหนึ่งข้ามเส้น
--
-- ข่าวดี: ข้อมูลไม่เสีย — timeout ทำให้ทรานแซกชันย้อนกลับทั้งหมด
--   ตรวจแล้ว รหัส 1077504 ยังอยู่ครบ ไม่มีย้ายค้างครึ่ง ๆ กลาง ๆ
--
-- ทางที่ "ใช้ไม่ได้" และเหตุผล (ทดสอบแล้วจริง ไม่ได้เดา)
--   ใส่ set statement_timeout ในตัวฟังก์ชันเอง → ไม่ช่วย
--   PostgreSQL ตั้งนาฬิกาจับเวลาตอน "เริ่มคำสั่ง" เท่านั้น เปลี่ยนค่าระหว่างทางไม่ตั้งนาฬิกาใหม่
--   (ทดสอบ: set_config('statement_timeout','150ms') แล้ว pg_sleep(1) → ผ่านฉลุย ไม่โดนตัด)
--   ส่วนการไปขยาย timeout ของ anon ทั้งระบบ = ถอดเกราะที่กันคิวรีหลุดไปค้างฐานข้อมูล ไม่ทำ
--
-- ทางที่เลือก: ทำให้มันเร็วพอ — ใส่ดัชนี + เลิกใช้ information_schema
-- ============================================================


-- ============================================================
-- อาการที่ 2 — "ย้ายสาขาแล้วยังขึ้นงานของสาขาเดิม"
--
-- สาเหตุ: transfer_emp เปลี่ยนแค่ employees.branch_id ช่องเดียว
--   แต่ตารางเวรกับตารางงานเก็บ branch_id ของตัวเองไว้ในแต่ละแถว
--   และหน้าเว็บอ่าน "สาขาของวันนั้น" จากแถวตารางเวร ไม่ได้อ่านจากทะเบียนพนักงาน
--     shared/supabase.js — branch_id: s.branch_id || branch || null
--   → เวรล่วงหน้าที่ลงไว้ก่อนย้าย ยังปักสาขาเก่า คนจึงยังโผล่ในกะของสาขาเดิม
--     และได้รายการงานของสาขาเดิม
--
-- ตรวจของจริง 7 พ.ย. 69 — มี 3 คนที่สาขาในทะเบียนไม่ตรงกับสาขาในตารางเวร
--   2302406 นายคมกฤช เรียงพรม     ทะเบียน 08747 · เวรยังเป็น 23024 · ค้าง 2 เวร (7-8 พ.ย.)
--   0874702 กิตติพงษ์ จันทรเปา     ทะเบียน 08747 · เวรยังเป็น 10775 · ค้าง 2 เวร (7-8 พ.ย.)
--   0000064 สุณิสา แก้วคูณ         ทะเบียน 23024 · เวรยังเป็น 08747 · ค้าง 2 เวร (7-8 พ.ย.)
--   (ส่วนของเก่าก่อนวันย้าย เป็นประวัติที่ถูกต้องแล้ว ไม่ต้องแก้)
--
-- หลักที่ยึด: "แผนในอนาคตตามคนไป · ประวัติอยู่กับที่"
--   ย้าย   : schedules · sched_change_queue · shift_leads · shift_helpers ·
--            shift_controllers · shift_submits  (เฉพาะ work_date >= วันนี้)
--            + push_subscriptions (ไม่งั้นได้ประกาศของสาขาเก่า)
--   ไม่ย้าย : attendance · checkout_* — เป็นบันทึกว่าตอกบัตรที่ไหนจริง แก้ไม่ได้
--            task_assignments · task_week_picks — ผูกกับรายการงานที่เป็นของสาขาเก่า
--            ชั้นวาง/โฟลเดอร์ QA/งานพิเศษ — ผูกกับของที่สาขาใหม่ไม่มี
--            → สามกลุ่มหลังฟังก์ชันจะ "นับแล้วเตือน" ให้ไปยกเลิกและมอบหมายใหม่เอง
--
-- ซ่อมของเก่า 3 คนนี้อยู่ในไฟล์ fix-branch-move-backfill-2569-11-07.sql (รันหลังไฟล์นี้)
-- ============================================================


-- รันซ้ำได้ · ไม่ลบข้อมูล · ไม่แตะข้อมูลพนักงาน


-- ============================================================
-- ส่วนที่ 1 — ใส่ดัชนีให้ทุกคอลัมน์ที่เก็บ "รหัสพนักงาน"
--   ตอนนี้ 20 ตารางที่มี emp_id และอีก 11 คอลัมน์รหัสชื่ออื่น ยังไม่มีดัชนีเลย
--   ทุกครั้งที่ย้ายรหัส ฐานข้อมูลจึงต้องอ่านทั้งตารางเพื่อหาแถวของคนคนเดียว
--   ใส่ดัชนีแล้วกลายเป็นเปิดสารบัญ — จาก 2,700 ms เหลือหลักสิบ ms
--
--   เขียนแบบไล่จากแคตตาล็อกจริง ไม่ฮาร์ดโค้ดชื่อตาราง
--   → เพิ่มตารางใหม่ในอนาคตแล้วรันไฟล์นี้ซ้ำ ก็ได้ดัชนีเองอัตโนมัติ
-- ============================================================

do $$
declare
  r record;
  idxname text;
  made int := 0;
begin
  for r in
    select c.relname as tbl, a.attname as col
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where ns.nspname = 'public'
       and c.relkind in ('r', 'p')
       and a.atttypid = 'text'::regtype
       and c.relname <> 'employees'
       and ( a.attname = 'emp_id'
             or (c.relname || '.' || a.attname) = any (array[
                  'advance_windows.opened_emp', 'applicants.hired_emp_id', 'goods_receipts.done_by',
                  'handovers.from_emp_id',      'handovers.to_emp_id',     'mgr_daily_logs.done_by',
                  'mgr_eval_snapshots.mgr_emp', 'mgr_tasks.assignee_emp',
                  'task_assignments.checked_by_emp', 'task_assignments.closed_by',
                  'task_assignments.draft_by',       'task_assignments.fix_emp',
                  'termination_cases.closed_by',     'warnings.closed_by' ]) )
       -- ข้ามคอลัมน์ที่มีดัชนีนำหน้าอยู่แล้ว
       and not exists (
             select 1 from pg_index i
              where i.indrelid = c.oid
                and (select attname from pg_attribute
                      where attrelid = i.indrelid and attnum = i.indkey[0]) = a.attname )
    order by 1, 2
  loop
    idxname := left('idx_' || r.tbl || '_' || r.col, 63);
    execute format('create index if not exists %I on public.%I (%I)', idxname, r.tbl, r.col);
    -- อัปเดตสถิติให้ตัววางแผนคิวรีรู้ว่ามีดัชนีใหม่แล้ว
    execute format('analyze public.%I', r.tbl);
    made := made + 1;
    raise notice 'สร้างดัชนี % บน %.%', idxname, r.tbl, r.col;
  end loop;
  raise notice '--- สร้างดัชนีใหม่ทั้งหมด % ตัว ---', made;
end $$;


-- ============================================================
-- ส่วนที่ 2 — เขียน transfer_emp ใหม่ให้เร็วขึ้น
--
-- ของเดิมช้าตรงไหนบ้าง
--   1) ใช้ information_schema.columns + information_schema.tables หารายชื่อตาราง
--      วิวพวกนี้เป็นวิวซ้อนวิวที่ช้ามาก (ของจริงกินหลักร้อย ms) → เปลี่ยนไปอ่าน pg_catalog ตรง ๆ
--   2) ประกอบค่าเป็น literal ด้วย %L ทุกตาราง → ฐานข้อมูลต้อง parse+plan ใหม่ทุกคำสั่ง 54 รอบ
--      → เปลี่ยนเป็นส่งค่าผ่าน USING แทน แผนถูกใช้ซ้ำได้
--   3) ลิสต์คอลัมน์รหัสชื่ออื่นแยกเป็น array แล้ววนอีกรอบ ชนตาราง/คอลัมน์ที่ไม่มีก็ต้อง try/catch
--      → รวมเป็นลูปเดียวที่คัดจากแคตตาล็อกจริง ไม่มีทางหลุดไปอ้างของที่ไม่มีอยู่
--
-- พฤติกรรมเหมือนเดิมทุกอย่าง — เว้นสามข้อที่ดีขึ้น
--   · ตรวจรูปแบบรหัสใหม่ที่ฝั่งฐานข้อมูลด้วย (เดิมตรวจแค่ในหน้าเว็บ เรียก RPC ตรงก็เลี่ยงได้)
--   · คืนเวลาที่ใช้มาด้วย จะได้เห็นว่าเหลือระยะห่างจากเพดาน 3 วินาทีเท่าไร
--   · ไม่ต้องมีลิสต์ตารางฮาร์ดโค้ดอีก เพิ่มตารางใหม่ก็ครอบคลุมเอง
-- ============================================================

create or replace function public.transfer_emp(p_old text, p_new text, p_branch text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r        record;
  n        int;
  total    int := 0;
  detail   text := '';
  same_id  boolean;
  v_oldbranch text;
  v_tbl    text;
  v_warn   text := '';
  t0       timestamptz := clock_timestamp();
begin
  p_old := trim(coalesce(p_old, ''));
  p_new := trim(coalesce(p_new, ''));

  if p_old = '' then
    return 'ERROR: ต้องระบุรหัสเดิม';
  end if;
  if not exists (select 1 from employees where emp_id = p_old) then
    return 'ERROR: ไม่พบรหัสเดิม ' || p_old;
  end if;

  -- ★ 21 ก.ย. 69 — รองรับ "ย้ายสาขาโดยคงรหัสเดิม"
  --   เว้นรหัสใหม่ว่าง หรือใส่เท่ากับรหัสเดิม = เปลี่ยนแค่สาขา
  --   (พนักงานรหัส 0000xxx ไม่ได้อิงเลขสาขา จึงไม่มีเหตุต้องเปลี่ยนรหัสตอนย้าย)
  same_id := (p_new = '' or p_new = p_old);

  if not same_id then
    if p_new !~ '^[A-Za-z0-9_-]+$' then
      return 'ERROR: รหัสใหม่ต้องเป็นตัวอักษร/ตัวเลข/ขีด เท่านั้น';
    end if;
    if exists (select 1 from employees where emp_id = p_new) then
      return 'ERROR: รหัสใหม่ ' || p_new || ' มีพนักงานอื่นใช้อยู่แล้ว';
    end if;
  end if;

  -- ============================================================
  -- ★ 7 พ.ย. 69 — ย้ายสาขาแล้ว "งานล่วงหน้า" ต้องตามไปด้วย
  --   ของเดิมเปลี่ยนแค่ employees.branch_id ช่องเดียว
  --   แต่ตารางเวร/งาน เก็บ branch_id ของตัวเองไว้ในแถว หน้าเว็บอ่านสาขาจากแถวตารางเวร
  --   → คนที่ย้ายสาขาแล้วยังขึ้นงานของสาขาเดิม เพราะเวรล่วงหน้ายังปักสาขาเก่าอยู่
  --
  --   กฎที่ใช้: "แผนในอนาคตตามคนไป · ประวัติอยู่กับที่"
  --   ย้ายเฉพาะ work_date >= วันนี้ และเฉพาะตารางที่บอกแค่ว่า "ใครอยู่เวรไหน สาขาไหน"
  --   ไม่แตะ attendance / checkout_* — นั่นคือบันทึกว่าเขาตอกบัตรที่ไหนจริง ๆ ต้องคงไว้
  -- ============================================================
  select branch_id into v_oldbranch from employees where emp_id = p_old;

  if coalesce(p_branch, '') <> '' then
    update employees set branch_id = p_branch where emp_id = p_old;

    if p_branch is distinct from v_oldbranch then
      foreach v_tbl in array array[
            'schedules',          -- ตารางเวร — ตัวที่ทำให้ขึ้นงานผิดสาขา
            'sched_change_queue', -- คำขอเปลี่ยนเวรที่ยังค้าง
            'shift_leads',        -- คนคุมผลัด
            'shift_helpers',      -- คนช่วยผลัด
            'shift_controllers',  -- ผู้ควบคุมผลัด
            'shift_submits' ]     -- การปิดผลัด
      loop
        if to_regclass('public.' || v_tbl) is not null then
          execute format(
            'update public.%I set branch_id = $1 where emp_id = $2 and branch_id = $3 and work_date >= current_date',
            v_tbl) using p_branch, p_old, v_oldbranch;
          get diagnostics n = row_count;
          if n > 0 then detail := detail || v_tbl || '(เวรล่วงหน้า)=' || n || ' '; end if;
        end if;
      end loop;

      -- การแจ้งเตือนเข้าเครื่อง ผูกสาขาไว้ ต้องตามคนไป ไม่งั้นได้ประกาศของสาขาเก่า
      if to_regclass('public.push_subscriptions') is not null then
        update push_subscriptions set branch_id = p_branch
         where emp_id = p_old and branch_id = v_oldbranch;
        get diagnostics n = row_count;
        if n > 0 then detail := detail || 'push_subscriptions=' || n || ' '; end if;
      end if;

      -- ของที่ "ไม่ย้ายให้" เพราะผูกกับของที่เป็นของสาขาเก่า (ชั้นวาง/โฟลเดอร์ QA/งานพิเศษ)
      -- ย้าย branch_id ไปเฉย ๆ จะชี้ไปยังของที่สาขาใหม่ไม่มี → รายงานให้ HR ไปจัดการเอง
      begin
        select coalesce(sum(c), 0) into n from (
          select count(*) c from qa_folder_assignees
            where emp_id = p_old and branch_id = v_oldbranch
          union all
          select count(*) from shelf_assignments
            where emp_id = p_old and branch_id = v_oldbranch
              and coalesce(month, '') >= to_char(current_date, 'YYYY-MM')
          union all
          select count(*) from special_task_assignees
            where emp_id = p_old and branch_id = v_oldbranch
              and coalesce(status, '') not in ('approved', 'done', 'rejected')
        ) z;
      exception when undefined_table or undefined_column then n := 0;
      end;
      if n > 0 then
        v_warn := ' ⚠ ยังมีงานที่ผูกกับสาขาเดิมอีก ' || n
               || ' รายการ (ชั้นวาง/โฟลเดอร์ QA/งานพิเศษ) ต้องไปยกเลิกแล้วมอบหมายใหม่ที่สาขาใหม่เอง';
      end if;
    end if;
  end if;

  if same_id then
    return 'OK: ย้ายสาขาเป็น ' || coalesce(p_branch, '(ไม่เปลี่ยน)')
           || ' · คงรหัส ' || p_old || ' ไว้ตามเดิม'
           || coalesce(nullif(' · ' || nullif(detail, ''), ' · '), '') || v_warn;
  end if;

  -- ★ employees ต้องมา "ก่อน" — FK 7 ตัวตั้ง ON UPDATE CASCADE ไว้ ตารางลูกจะตามไปเอง
  --   (attendance · leaves · warnings · schedules · rule_acks · profile_submissions · course_exam_attempt)
  --   ของเดิมเคยทำ employees ท้ายสุด จึงชน FK ตั้งแต่ตารางแรก
  update employees set emp_id = p_new where emp_id = p_old;
  get diagnostics n = row_count;
  total  := total + n;
  detail := detail || 'employees=' || n || ' (+7 ตารางที่ผูก FK ตามอัตโนมัติ) ';

  -- ไล่ retarget คอลัมน์รหัสพนักงานที่เหลือทั้งหมด จากแคตตาล็อกจริง
  --   ตารางที่ FK พาไปแล้วจะเหลือ 0 แถว ไม่เสียเวลาเพราะมีดัชนีคุมอยู่
  for r in
    select c.relname as tbl, a.attname as col
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where ns.nspname = 'public'
       and c.relkind in ('r', 'p')
       and a.atttypid = 'text'::regtype
       and c.relname <> 'employees'
       and ( a.attname = 'emp_id'
             or (c.relname || '.' || a.attname) = any (array[
                  'advance_windows.opened_emp', 'applicants.hired_emp_id', 'goods_receipts.done_by',
                  'handovers.from_emp_id',      'handovers.to_emp_id',     'mgr_daily_logs.done_by',
                  'mgr_eval_snapshots.mgr_emp', 'mgr_tasks.assignee_emp',
                  'task_assignments.checked_by_emp', 'task_assignments.closed_by',
                  'task_assignments.draft_by',       'task_assignments.fix_emp',
                  'termination_cases.closed_by',     'warnings.closed_by' ]) )
    order by 1, 2
  loop
    execute format('update public.%I set %I = $1 where %I = $2', r.tbl, r.col, r.col)
      using p_new, p_old;
    get diagnostics n = row_count;
    if n > 0 then
      total  := total + n;
      detail := detail || r.tbl || '.' || r.col || '=' || n || ' ';
    end if;
  end loop;

  return 'OK: ย้าย ' || total || ' แถว · ใช้เวลา '
         || round(extract(milliseconds from clock_timestamp() - t0)) || ' ms (เพดาน 3,000 ms) · '
         || coalesce(nullif(detail, ''), '(ไม่มีข้อมูลผูกรหัสเก่า)') || v_warn;
end;
$$;

grant execute on function public.transfer_emp(text, text, text) to anon, authenticated;


-- ============================================================
-- ส่วนที่ 3 — ตรวจหลังรัน (รันแล้วดูตัวเลข ไม่เปลี่ยนอะไร)
--
-- 3.1 ต้องไม่เหลือคอลัมน์รหัสที่ไม่มีดัชนี — ต้องได้ 0
-- ============================================================

select count(*) as ยังไม่มีดัชนี
  from pg_class c
  join pg_namespace ns on ns.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
 where ns.nspname = 'public' and c.relkind in ('r','p')
   and a.atttypid = 'text'::regtype and c.relname <> 'employees'
   and ( a.attname = 'emp_id'
         or (c.relname||'.'||a.attname) = any (array[
              'advance_windows.opened_emp','applicants.hired_emp_id','goods_receipts.done_by',
              'handovers.from_emp_id','handovers.to_emp_id','mgr_daily_logs.done_by',
              'mgr_eval_snapshots.mgr_emp','mgr_tasks.assignee_emp',
              'task_assignments.checked_by_emp','task_assignments.closed_by',
              'task_assignments.draft_by','task_assignments.fix_emp',
              'termination_cases.closed_by','warnings.closed_by' ]) )
   and not exists (
         select 1 from pg_index i
          where i.indrelid = c.oid
            and (select attname from pg_attribute
                  where attrelid = i.indrelid and attnum = i.indkey[0]) = a.attname );


-- ============================================================
-- 3.2 ซ้อมจับเวลาแบบไม่เขียนอะไรเลย (นับแทนอัปเดต)
--     ก่อนแก้ได้ ~2,700 ms · หลังแก้ควรเหลือหลักสิบ ms
--     เปลี่ยน '1077504' เป็นรหัสที่จะย้ายจริงได้
-- ============================================================

with cols as (
  select c.relname as t, a.attname as col
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where ns.nspname = 'public' and c.relkind in ('r','p')
     and a.atttypid = 'text'::regtype and c.relname <> 'employees'
     and ( a.attname = 'emp_id'
           or (c.relname||'.'||a.attname) = any (array[
                'advance_windows.opened_emp','applicants.hired_emp_id','goods_receipts.done_by',
                'handovers.from_emp_id','handovers.to_emp_id','mgr_daily_logs.done_by',
                'mgr_eval_snapshots.mgr_emp','mgr_tasks.assignee_emp',
                'task_assignments.checked_by_emp','task_assignments.closed_by',
                'task_assignments.draft_by','task_assignments.fix_emp',
                'termination_cases.closed_by','warnings.closed_by' ]) )
), hits as (
  select t, col,
         (xpath('/row/c/text()', query_to_xml(
            format('select count(*) c from public.%I where %I = %L', t, col, '1077504'),
            false, true, '')))[1]::text::int as n
    from cols
)
select (select count(*) from cols)                  as ช่องที่ต้องไล่,
       (select count(*) from hits where n > 0)      as ช่องที่มีข้อมูลจริง,
       (select coalesce(sum(n),0) from hits)        as แถวที่ต้องย้าย,
       round(extract(milliseconds from clock_timestamp() - statement_timestamp())) as ใช้เวลา_ms;


-- ============================================================
-- 3.3 เฝ้าระวัง: คอลัมน์ชื่อ emp_id ที่ "ไม่ใช่ชนิด text"
--     ตอนนี้ทั้งฐานข้อมูลเป็น text หมด (ตรวจแล้ว 7 พ.ย. 69) ฟังก์ชันจึงครอบคลุมครบ
--     แต่ถ้าวันหน้ามีใครสร้างตารางที่ emp_id เป็นตัวเลข คิวรีนี้จะโผล่มาเตือน
--     — ต้องแก้ตารางนั้นให้เป็น text ไม่งั้นย้ายรหัสแล้วข้อมูลตารางนั้นจะตกค้าง
-- ============================================================

select c.relname as ตาราง, a.attname as คอลัมน์,
       format_type(a.atttypid, a.atttypmod) as ชนิด
  from pg_class c
  join pg_namespace ns on ns.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
 where ns.nspname = 'public' and c.relkind in ('r','p')
   and a.attname = 'emp_id' and a.atttypid <> 'text'::regtype;


-- ============================================================
-- หมายเหตุ: supabase/change_emp_id.sql เป็นของเก่าที่ "ไม่ได้ใช้แล้ว"
--   หน้าเว็บกับนิดาเรียก transfer_emp ตัวเดียว ไม่มีใครเรียก change_emp_id
--   และของเก่านั้นฮาร์ดโค้ดไว้แค่ 11 ตาราง (ตอนนี้มี 54) ถ้าเผลอไปรันจะทำข้อมูลตกค้าง
--   → เก็บไว้อ่านเป็นประวัติได้ แต่อย่าเรียกใช้
-- ============================================================
