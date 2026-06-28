-- ============================================================
-- ลบข้อมูลพนักงานตัวอย่าง (001, 002, 003) ออกจากระบบ
-- รันบน Supabase: SQL Editor > วาง > Run
-- ⚠️ การลบนี้ถาวร กู้คืนไม่ได้ — ตรวจรหัสให้แน่ใจก่อนรัน
-- ============================================================

-- ลบข้อมูลที่ผูกกับพนักงานก่อน (กัน foreign key)
delete from public.attendance          where emp_id in ('001','002','003');
delete from public.leaves              where emp_id in ('001','002','003');
delete from public.warnings            where emp_id in ('001','002','003');
delete from public.schedules           where emp_id in ('001','002','003');
delete from public.rule_acks           where emp_id in ('001','002','003');
delete from public.profile_submissions where emp_id in ('001','002','003');

-- ลบตัวพนักงาน
delete from public.employees           where emp_id in ('001','002','003');

-- ตรวจผล (ควรไม่เหลือ 001/002/003)
select emp_id, name from public.employees order by emp_id;

-- ============================================================
-- (ทางเลือก) ถ้าต้องการลบ "สาขาตัวอย่าง" B001/B002 ด้วย
-- ให้ลบเครื่องหมาย -- ข้างหน้า 4 บรรทัดล่างนี้แล้วรัน
-- ============================================================
-- delete from public.schedules  where branch_id in ('B001','B002');
-- delete from public.attendance where branch_id in ('B001','B002');
-- update public.employees set branch_id = null where branch_id in ('B001','B002');
-- delete from public.branches   where branch_id in ('B001','B002');
