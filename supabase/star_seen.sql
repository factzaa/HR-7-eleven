-- ============================================================
-- star_seen.sql — จำว่าพนักงาน "ดูฉากฉลองพนักงานดีเด่นแล้ว"           ★ 24 พ.ย. 69
--
-- ทำไมต้องมี:
--   ฉากฉลองในแอปพนักงานต้องเด้ง "ครั้งเดียวต่อรอบ" ถ้าจำไว้ในเครื่องอย่างเดียว
--   พอเปลี่ยนเครื่อง/ล้างแคช/ลงแอปใหม่ มันจะเด้งซ้ำ ดูไม่น่าเชื่อถือ
--   จึงเก็บเวลาที่ดูไว้ในฐานข้อมูล ติดกับใบรางวัลนั้นเลย
--
-- ปลอดภัยแค่ไหน:
--   · เพิ่มคอลัมน์ใหม่ ไม่แตะข้อมูลเดิม · ไม่ลบอะไรทั้งสิ้น
--   · ยังไม่รันไฟล์นี้ แอปก็ทำงานได้ปกติ (ถอยไปจำในเครื่องแทนเอง)
--   · ฟังก์ชันเขียนได้เฉพาะคอลัมน์ seen_at เท่านั้น แก้เงิน/ชื่อ/รอบ ไม่ได้
--     และตั้งเวลาเองไม่ได้ (ใช้ now() ของเซิร์ฟเวอร์เสมอ)
--   · ถ้าใบนั้นถูกดูไปแล้ว เรียกซ้ำก็ไม่เปลี่ยนเวลาเดิม
--
-- รันทีเดียวจบใน Supabase → SQL Editor
-- ย้อนกลับได้ที่บล็อก [3] ท้ายไฟล์
-- ============================================================

-- ---------- [1] คอลัมน์เก็บเวลาที่ดูฉากฉลอง ----------
alter table public.star_awards
  add column if not exists seen_at timestamptz;

comment on column public.star_awards.seen_at is
  'เวลาที่พนักงานกดรับทราบฉากฉลองในแอปพนักงาน (null = ยังไม่เคยเห็น)';


-- ---------- [2] ฟังก์ชันให้แอปพนักงานเรียก ----------
-- SECURITY DEFINER เพื่อให้เขียนได้โดยไม่ต้องเปิดสิทธิ์ update ทั้งตารางให้ anon
-- (ถ้าเปิด update ทั้งตาราง จะมีคนแก้ยอดเบี้ยตัวเองได้)
create or replace function public.star_mark_seen(p_emp text, p_cycle text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if p_emp is null or p_cycle is null then
    return false;
  end if;

  update public.star_awards
     set seen_at = now()
   where emp_id = p_emp
     and cycle  = p_cycle
     and seen_at is null;          -- ดูแล้วไม่ทับเวลาเดิม

  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on function public.star_mark_seen(text, text) from public;
grant execute on function public.star_mark_seen(text, text) to anon, authenticated;


-- ---------- ตรวจผลหลังรัน ----------
-- select cycle, emp_name, amount, seen_at from public.star_awards order by cycle desc;
-- select public.star_mark_seen('<รหัสพนักงาน>', '2026-11');   -- ทดลองเรียก (true = เพิ่งบันทึก)


-- ============================================================
-- [3] ย้อนกลับ — เอาออกทั้งหมด (คัดลอกเฉพาะส่วนนี้ไปรัน)
-- ============================================================
-- drop function if exists public.star_mark_seen(text, text);
-- alter table public.star_awards drop column if exists seen_at;
-- ============================================================
