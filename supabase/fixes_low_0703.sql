-- ============================================================
-- แก้จุดปลีกย่อย (LOW) จากรายงานตรวจสอบ — รันบน Supabase (รันซ้ำได้)
-- ============================================================

-- 1) ลบฟังก์ชัน hr_dashboard() ที่ไม่ถูกใช้แล้ว (ขัดกับ JS ที่ใช้รอบ 21–20)
--    ระบบจริงคำนวณ dashboard ฝั่ง client — ฟังก์ชันนี้เป็นของค้างที่ทำให้สับสน
drop function if exists public.hr_dashboard();

-- 2) กันงานซ้ำระดับฐานข้อมูลบน task_assignments
--    (โค้ดกันซ้ำด้วย _findAsg อยู่แล้ว แต่ index ช่วยกัน race condition)
--    ⚠️ ถ้ามีแถวซ้ำอยู่ก่อน index จะสร้างไม่ผ่าน → ลบตัวซ้ำ (เก็บ id ล่าสุด) ก่อน
delete from public.task_assignments a
using public.task_assignments b
where a.id < b.id
  and a.branch_id is not distinct from b.branch_id
  and a.work_date = b.work_date
  and a.shift_id  is not distinct from b.shift_id
  and a.task_def_id = b.task_def_id;

create unique index if not exists task_assign_uniq
  on public.task_assignments (branch_id, work_date, shift_id, task_def_id);

-- 3) เพิ่มคอมเมนต์กันสับสน: leave_types.quota_per_year จริง ๆ คิดเป็น "ต่อเดือน"
--    (ไม่เปลี่ยนชื่อคอลัมน์เพื่อไม่ให้โค้ดเดิมพัง — แค่ระบุความหมายไว้)
comment on column public.leave_types.quota_per_year is
  'โควตาการลา "ต่อเดือน" (ชื่อคอลัมน์เป็น per_year แต่ตรรกะจริงคิดเป็นรายเดือน)';

select 'fixes_low_0703.sql done' as result;
