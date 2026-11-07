-- ============================================================
-- ซ่อมคนที่ย้ายสาขาไปแล้ว แต่เวรล่วงหน้ายังปักสาขาเดิม      7 พ.ย. 69
--
-- รันไฟล์นี้ "หลัง" fix-transfer-emp-timeout-2569-11-07.sql
--   ไฟล์นั้นแก้ที่ต้นเหตุ (ย้ายสาขาครั้งต่อไปจะพาเวรล่วงหน้าไปด้วย)
--   ไฟล์นี้ตามเก็บของที่ย้ายไปก่อนหน้าแล้วตกค้างอยู่
--
-- ของจริงที่ค้างอยู่ตอนนี้ (ตรวจ 7 พ.ย. 69)
--   0874702  กิตติพงษ์ จันทรเปา   10775 → 08747   เวรค้าง 6-8 พ.ย.
--   2302406  นายคมกฤช เรียงพรม    23024 → 08747   เวรค้าง 7-8 พ.ย.
--   0000064  สุณิสา แก้วคูณ        08747 → 23024   เวรค้าง 7-8 พ.ย.
--
-- ยืนยันทิศทางด้วยการตอกบัตรจริง ไม่ได้เดาจากทะเบียนอย่างเดียว
--   0874702  ตอกที่ 10775 ถึง 1 พ.ย. · ตอกที่ 08747 ตั้งแต่ 4 พ.ย.
--   2302406  ตอกที่ 23024 ถึง 3 พ.ย. · ตอกที่ 08747 ตั้งแต่ 4 พ.ย.
--   0000064  ตอกที่ 08747 วันที่ 5 พ.ย. · ตอกที่ 23024 ตั้งแต่ 6 พ.ย.
--   → ทั้งสามคน "สาขาในทะเบียนถูกแล้ว ตารางเวรต่างหากที่ค้าง"
--
-- กันพลาดไว้ 4 ชั้น
--   1. แตะเฉพาะ work_date >= วันนี้ — ประวัติย้อนหลังไม่ขยับแม้แต่แถวเดียว
--   2. ข้ามเวรที่ is_cover = true — ไปช่วยสาขาอื่นเป็นครั้งคราว ต้องคงสาขานั้นไว้
--   3. เฉพาะพนักงานที่ยัง active
--   4. ไม่แตะ attendance / checkout_* — บันทึกว่าตอกบัตรที่ไหนจริง ห้ามแก้
--
-- รันซ้ำได้ (รอบสองจะได้ 0 แถว) · ไม่ลบข้อมูล
-- ============================================================


-- ============================================================
-- ส่วนที่ 1 — ดูก่อนว่าจะแก้แถวไหนบ้าง (ไม่เปลี่ยนอะไรทั้งสิ้น)
--   รันส่วนนี้ก่อน ถ้ารายชื่อตรงกับที่รู้ว่าย้ายจริง ค่อยรันส่วนที่ 2
--   ถ้ามีชื่อแปลก ๆ โผล่มา = คนนั้นอาจไม่ได้ย้าย แต่ทะเบียนถูกตั้งผิด — หยุดแล้วตรวจก่อน
-- ============================================================

select s.emp_id            as รหัส,
       e.name              as ชื่อ,
       s.branch_id         as เวรปักสาขา,
       e.branch_id         as ทะเบียนบอกสาขา,
       s.work_date         as วันที่,
       s.shift_id          as ผลัด,
       s.is_cover          as เป็นเวรช่วยสาขาอื่น,
       (select string_agg(distinct a.branch_id, ', ')
          from attendance a
         where a.emp_id = s.emp_id and a.work_date >= current_date - 14) as ตอกบัตรจริง14วัน
  from schedules s
  join employees e on e.emp_id = s.emp_id
 where s.work_date >= current_date
   and coalesce(s.is_cover, false) = false
   and coalesce(e.active, true)
   and coalesce(s.branch_id, '') <> coalesce(e.branch_id, '')
 order by s.emp_id, s.work_date;


-- ============================================================
-- ส่วนที่ 2 — ย้ายแผนล่วงหน้าให้ตามคนไป
--   ตารางที่แก้ = ตารางที่บอกแค่ว่า "ใครอยู่เวรไหน สาขาไหน"
--   ตารางงาน (task_assignments ฯลฯ) ไม่แตะ เพราะผูกกับรายการงานของสาขาเดิม
--   ปล่อยให้ระบบสร้างงานของสาขาใหม่ให้เองตามปกติ
-- ============================================================

begin;

-- 2.1 ตารางเวร — ตัวที่ทำให้ขึ้นงานผิดสาขา
update schedules s
   set branch_id = e.branch_id
  from employees e
 where e.emp_id = s.emp_id
   and s.work_date >= current_date
   and coalesce(s.is_cover, false) = false
   and coalesce(e.active, true)
   and coalesce(s.branch_id, '') <> coalesce(e.branch_id, '');

-- 2.2 คำขอเปลี่ยนเวรที่ยังค้างอยู่
update sched_change_queue q
   set branch_id = e.branch_id
  from employees e
 where e.emp_id = q.emp_id
   and q.work_date >= current_date
   and coalesce(e.active, true)
   and coalesce(q.branch_id, '') <> coalesce(e.branch_id, '');

-- 2.3 คนคุมผลัด / คนช่วยผลัด / ผู้ควบคุมผลัด / การปิดผลัด — เฉพาะล่วงหน้า
do $$
declare r record; v_tbl text; n int;
begin
  foreach v_tbl in array array['shift_leads','shift_helpers','shift_controllers','shift_submits']
  loop
    if to_regclass('public.' || v_tbl) is not null then
      execute format($f$
        update public.%I t
           set branch_id = e.branch_id
          from public.employees e
         where e.emp_id = t.emp_id
           and t.work_date >= current_date
           and coalesce(e.active, true)
           and coalesce(t.branch_id,'') <> coalesce(e.branch_id,'')
      $f$, v_tbl);
      get diagnostics n = row_count;
      raise notice '% : แก้ % แถว', v_tbl, n;
    end if;
  end loop;
end $$;

-- 2.4 การแจ้งเตือนเข้าเครื่อง — ไม่งั้นยังได้ประกาศของสาขาเก่า
update push_subscriptions p
   set branch_id = e.branch_id
  from employees e
 where e.emp_id = p.emp_id
   and coalesce(e.active, true)
   and coalesce(p.branch_id, '') <> coalesce(e.branch_id, '');

commit;


-- ============================================================
-- ส่วนที่ 3 — ตรวจหลังรัน ต้องได้ 0
-- ============================================================

select count(*) as เวรล่วงหน้าที่ผิด
  from schedules s join employees e on e.emp_id = s.emp_id
 where s.work_date >= current_date
   and coalesce(s.is_cover, false) = false
   and coalesce(e.active, true)
   and coalesce(s.branch_id, '') <> coalesce(e.branch_id, '');


-- ============================================================
-- ส่วนที่ 4 — ของที่ "ไม่แก้ให้" ต้องไปจัดการเองในแอป
--   พวกนี้ผูกกับของที่เป็นของสาขาเดิม (ชั้นวางเบอร์นั้น โฟลเดอร์ QA ใบนั้น งานพิเศษใบนั้น)
--   ถ้าย้าย branch_id ไปเฉย ๆ จะกลายเป็นชี้ไปยังของที่สาขาใหม่ไม่มี
--   วิธีที่ถูกคือ ยกเลิกที่สาขาเดิม แล้วมอบหมายใหม่ที่สาขาใหม่
-- ============================================================

select 'โฟลเดอร์ QA' as เรื่อง, q.emp_id as รหัส, e.name as ชื่อ,
       q.branch_id as ค้างที่สาขา, 'folder#' || q.folder_id as รายการ
  from qa_folder_assignees q join employees e on e.emp_id = q.emp_id
 where coalesce(q.branch_id,'') <> coalesce(e.branch_id,'') and coalesce(e.active, true)
union all
select 'ชั้นวาง', a.emp_id, e.name, a.branch_id, coalesce(a.month,'-') || ' shelf#' || a.shelf_id
  from shelf_assignments a join employees e on e.emp_id = a.emp_id
 where coalesce(a.branch_id,'') <> coalesce(e.branch_id,'') and coalesce(e.active, true)
   and coalesce(a.month,'') >= to_char(current_date, 'YYYY-MM')
union all
select 'งานพิเศษ', t.emp_id, e.name, t.branch_id, 'task#' || t.task_id || ' · ' || coalesce(t.status,'-')
  from special_task_assignees t join employees e on e.emp_id = t.emp_id
 where coalesce(t.branch_id,'') <> coalesce(e.branch_id,'') and coalesce(e.active, true)
   and coalesce(t.status,'') not in ('approved','done','rejected')
 order by 1, 2;
