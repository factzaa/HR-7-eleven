-- ============================================================
-- 7-Eleven HR — ระบบงานผลัดใหม่ (เฟส 1: ฐานข้อมูล)
-- รูปหลายรูป/งาน + จำนวนรูปขั้นต่ำ + นับการตีกลับ
-- รันบน Supabase: SQL Editor > วาง > Run  (รันหลัง task_system.sql / task_shift.sql / shift_leads.sql)
-- ============================================================

-- จำนวนรูปขั้นต่ำที่ต้องแนบต่อ 1 งาน (0 = ไม่ต้องแนบ)
alter table public.task_defs add column if not exists min_photos int not null default 0;
-- ให้ require_photo เดิมสอดคล้องกับ min_photos (true ถ้าต้องแนบอย่างน้อย 1)
update public.task_defs set min_photos = 1 where require_photo = true and min_photos = 0;

-- เก็บรูปได้หลายรูป (อาเรย์ URL) + นับจำนวนครั้งที่ถูกตีกลับ
alter table public.task_assignments add column if not exists photos jsonb;
alter table public.task_assignments add column if not exists sent_back_count int not null default 0;

select 'handover_v2.sql done' as result;
