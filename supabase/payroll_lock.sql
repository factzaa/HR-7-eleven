-- ============================================================
-- ล็อกตารางเงินเดือน — payroll_items / payroll_profiles
-- 23 พ.ย. 2569
--
-- ปัญหาที่แก้:
--   แอปทั้งระบบคุยกับฐานข้อมูลด้วย anon key ซึ่งอยู่ในไฟล์หน้าเว็บ (รีโปสาธารณะ)
--   รหัสหน้าเงินเดือนที่มีอยู่กันได้แค่ "ปุ่มในหน้าเว็บ" — ใครก็ตามที่หยิบ anon key ไป
--   ยิงตรงเข้า REST API ก็อ่าน payroll_items ได้ทั้งตาราง (ค่าแรง · ยอดสุทธิ · เลขบัญชี · อีเมล)
--   โดยไม่ต้องผ่านหน้าเว็บเลย   ← คอมเมนต์ใน shared/hr-api.js เขียนข้อจำกัดนี้ไว้แล้ว
--
-- วิธีแก้ในไฟล์นี้:
--   เปิด RLS ที่สองตารางนี้ แล้วให้ผ่านได้เฉพาะคำขอที่แนบ header  x-payroll-pass
--   ที่ตรงกับรหัสหน้าเงินเดือน (ตรวจด้วย public.payroll_check_password ของเดิม)
--   → ยิงตรงด้วย anon key เปล่า ๆ จะได้ 0 แถว และเขียนไม่ได้
--   → หน้าเงินเดือนในแอปแนบ header ให้อัตโนมัติหลังปลดล็อก (shared/hr-api.js v303)
--
-- ขอบเขต: เฉพาะสองตารางนี้ เพราะมีแต่ action เงินเดือน (hr_payroll_*) ที่แตะ
--   payroll_installments / payroll_runs / payroll_review ยังเปิดอยู่ — ฝั่ง ผจก. ใช้อยู่
--   และตาราง advance_requests ก็มีเลขบัญชีเหมือนกัน ทั้งสองส่วนต้องตามปิดทีหลัง
--
-- รันทั้งไฟล์ใน Supabase → SQL Editor ได้เลย · รันซ้ำได้ ไม่พัง
-- เลิกใช้เมื่อไหร่ ดูบล็อก [4] ท้ายไฟล์
-- ============================================================

-- [1] ประตู: คำขอนี้แนบรหัสหน้าเงินเดือนมาถูกหรือไม่
--     อ่าน header ของคำขอที่ PostgREST ส่งต่อมาให้ แล้วส่งไปตรวจกับฟังก์ชันเดิม
--     ไม่เก็บ ไม่ log ค่าที่รับมา · ถ้าอะไรพังระหว่างทางให้ตอบ false เสมอ (ปิดไว้ก่อน)
create or replace function public.payroll_req_ok()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare h text;
begin
  begin
    h := nullif(current_setting('request.headers', true)::json ->> 'x-payroll-pass', '');
  exception when others then
    return false;
  end;
  if h is null then return false; end if;
  return coalesce(public.payroll_check_password(h), false);
exception when others then
  return false;
end
$fn$;

revoke all on function public.payroll_req_ok() from public;
grant execute on function public.payroll_req_ok() to anon, authenticated;

-- [2] เปิด RLS + วางนโยบายเดียวต่อหนึ่งตาราง (ล้างของเก่าออกก่อน ไม่ให้มีช่องเปิดค้างไว้)
--     ไม่ใช้ FORCE เพื่อให้ Edge Function ที่ใช้ service key (เช่น payroll-mail) ทำงานได้เหมือนเดิม
do $blk$
declare t text; p record;
begin
  foreach t in array array['payroll_items','payroll_profiles'] loop
    if to_regclass('public.' || t) is null then
      raise notice 'ข้ามตาราง % (ไม่มีในฐานข้อมูลนี้)', t;
      continue;
    end if;
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format(
      'create policy %I on public.%I for all to anon, authenticated '
      || 'using (public.payroll_req_ok()) with check (public.payroll_req_ok())',
      'pay_gate_' || t, t);
    raise notice 'ล็อกตาราง % แล้ว', t;
  end loop;
end
$blk$;

-- [3] ตรวจผล — ควรได้ rls_on = true และ policies = 1 ทั้งสองแถว
select c.relname                                   as ตาราง,
       c.relrowsecurity                            as rls_on,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname) as policies
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('payroll_items','payroll_profiles')
 order by c.relname;

-- หลังรันเสร็จ ลองยิงตรงด้วย anon key เปล่า ๆ (ไม่แนบ header) — ต้องได้ [] ว่าง:
--   curl "<SUPABASE_URL>/rest/v1/payroll_items?select=emp_id&limit=1" \
--        -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"

-- ============================================================
-- [4] ถ้าต้องการเลิกใช้ (ยกเลิกการล็อก) — เอาคอมเมนต์ออกแล้วรันเฉพาะบล็อกนี้
-- ============================================================
-- do $blk$
-- declare t text;
-- begin
--   foreach t in array array['payroll_items','payroll_profiles'] loop
--     if to_regclass('public.' || t) is null then continue; end if;
--     execute format('drop policy if exists %I on public.%I', 'pay_gate_' || t, t);
--     execute format('alter table public.%I disable row level security', t);
--   end loop;
-- end
-- $blk$;
-- drop function if exists public.payroll_req_ok();
