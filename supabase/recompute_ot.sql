-- ============================================================
-- คำนวณ OT ย้อนหลังใหม่ ตามสูตรใหม่ (เริ่มคิด OT ที่ชั่วโมงที่ N หลังเลิกกะ)
-- คำนวณจากเวลากดออกจริง + เวลาเลิกกะ → รันซ้ำได้ ค่าไม่เพี้ยน (idempotent)
-- ============================================================
-- ⚠️ นี่คือข้อมูล OT/ค่าแรงย้อนหลัง — ทำตามลำดับ:
--   1) รัน "ส่วนพรีวิว" ดูก่อนว่า OT เก่า→ใหม่ เปลี่ยนยังไง ถูกต้องไหม
--   2) ปรับ free_hours และช่วงวันที่ให้ตรงกับที่ต้องการ
--   3) ค่อยรัน "ส่วนอัปเดตจริง"
-- free_hours = (ค่าที่ตั้งใน "เริ่มคิด OT ที่ชั่วโมงที่") − 1   → ปกติ 2 - 1 = 1
-- ============================================================

-- ---------- (1) พรีวิว: ดู OT เก่า vs OT ใหม่ (ไม่แก้ข้อมูล) ----------
with params as (
  select 1.0::numeric as free_hours,          -- << ชั่วโมงแรกที่ไม่คิด OT (ปกติ = 1)
         date '2026-06-21' as from_date,        -- << เริ่มจากวันที่ (ปรับเอง — เลี่ยงรอบที่จ่ายเงินไปแล้ว)
         date '2026-12-31' as to_date           -- << ถึงวันที่
)
select a.emp_id, e.name as emp_name, a.work_date, a.shift_id,
       a.check_out, s.end_time,
       a.ot_hours as ot_old,
       greatest(0, round(
         (extract(epoch from ( a.check_out
            - (((a.check_out at time zone 'Asia/Bangkok')::date + s.end_time) at time zone 'Asia/Bangkok')
         ))/3600.0)::numeric - (select free_hours from params)
       , 2)) as ot_new
from public.attendance a
join public.shifts s on s.shift_id = a.shift_id
left join public.employees e on e.emp_id = a.emp_id
cross join params p
where a.check_out is not null and s.end_time is not null
  and a.work_date >= p.from_date and a.work_date <= p.to_date
order by a.work_date, a.emp_id;

-- ---------- (2) อัปเดตจริง: เขียนทับ ot_hours (รันเมื่อพรีวิวถูกต้องแล้ว) ----------
-- ลบเครื่องหมาย /* ... */ ออกเพื่อรัน
/*
with params as (
  select 1.0::numeric as free_hours,
         date '2026-06-21' as from_date,
         date '2026-12-31' as to_date
),
calc as (
  select a.id,
    greatest(0, round(
      (extract(epoch from ( a.check_out
         - (((a.check_out at time zone 'Asia/Bangkok')::date + s.end_time) at time zone 'Asia/Bangkok')
      ))/3600.0)::numeric - (select free_hours from params)
    , 2)) as new_ot
  from public.attendance a
  join public.shifts s on s.shift_id = a.shift_id
  cross join params p
  where a.check_out is not null and s.end_time is not null
    and a.work_date >= p.from_date and a.work_date <= p.to_date
)
update public.attendance a
set ot_hours = calc.new_ot
from calc
where a.id = calc.id and a.ot_hours is distinct from calc.new_ot;
*/

select 'recompute_ot.sql — รันส่วนพรีวิวก่อน แล้วค่อยเปิดส่วนอัปเดต' as note;
