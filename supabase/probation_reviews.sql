-- ============================================================
-- ประเมินผลทดลองงานพนักงานใหม่                            10 พ.ย. 69
--
-- ทำไมต้องมีเมนูนี้
--   ใบเตือนมีไว้สร้างฐาน "เลิกจ้างโดยไม่จ่ายค่าชดเชย" ของพนักงานที่ผ่าน 120 วันแล้ว
--   แต่กับพนักงานใหม่ที่ยังไม่ถึง 120 วัน การไม่ผ่านทดลองงานไม่ต้องใช้ใบเตือนเลย
--   สิ่งที่ต้องมีคือ "หลักฐานการประเมิน" + "การบอกกล่าวล่วงหน้า" ซึ่งระบบเดิมไม่มีที่เก็บ
--
-- กติกาที่ตกลงกันไว้
--   · ระยะทดลองงาน 90 วันนับจากวันเริ่มงาน (แก้ได้ที่ app_settings.probation_days)
--   · ผจก.สาขาเป็นคนให้คะแนน 5 หัวข้อ · HR เป็นคนกดตัดสินผ่าน/ไม่ผ่าน/ขยายเวลา
--   · หน้าประเมินดึงข้อมูลจากระบบมาให้เอง (วันทำงาน สาย ขาด คะแนนวินัย งานในกะ แบบทดสอบ)
--     พร้อมประวัติตักเตือนทั้งหมด — ผจก.กรอกเฉพาะหัวข้อที่ระบบวัดไม่ได้
--   · ตัดสินแล้วออกหนังสือแจ้งผลให้พนักงานเซ็นรับทราบได้เลย
--
-- ★ เส้น 120 วัน: ทดลองงาน 90 วันไม่ได้แปลว่าเลิกจ้างวันที่ 91 แล้วจบ
--   ถ้าเก็บไว้จนเกิน 120 วันแล้วค่อยเลิกจ้าง ต้องจ่ายค่าชดเชยตามกฎหมาย
--   หน้าเว็บจึงแสดงทั้งวันครบทดลองงาน (90) และวันครบ 120 วันคู่กันเสมอ
--
-- รันบน Supabase: SQL Editor > วาง > Run (รันซ้ำได้ ไม่ลบข้อมูล)
-- ============================================================

create table if not exists public.probation_reviews (
  id             bigint generated always as identity primary key,
  emp_id         text not null,
  emp_name       text,
  branch_id      text,
  start_date     date not null,                    -- วันเริ่มงาน (คัดลอกไว้ตอนสร้าง เผื่อมีการแก้ทีหลัง)
  period_days    int  not null default 90,         -- ระยะทดลองงานที่ใช้กับคนนี้
  due_date       date not null,                    -- วันครบทดลองงาน = start_date + period_days

  -- ① ผจก.ให้คะแนน (หัวข้อที่ระบบวัดเองไม่ได้)
  mgr_scores     jsonb,                            -- {ready:1-5, learn:1-5, team:1-5, service:1-5, trust:1-5}
  mgr_total      numeric,                          -- รวมเป็น % เพื่อให้อ่านง่าย
  mgr_comment    text,
  mgr_by         text,
  mgr_at         timestamptz,

  -- ข้อมูลจากระบบ ณ วันที่ประเมิน — เก็บเป็นภาพนิ่งไว้ เพราะตัวเลขสดเปลี่ยนทุกวัน
  -- ถ้ามีข้อโต้แย้งภายหลังต้องตอบได้ว่า "ตอนตัดสินเห็นตัวเลขอะไร"
  snapshot       jsonb,

  -- ② HR ตัดสิน
  decision       text,                             -- pass | fail | extend
  decision_reason text,
  decided_by     text,
  decided_at     timestamptz,
  extend_to      date,                             -- ถ้าขยายเวลา ครบใหม่วันไหน

  -- ③ แจ้งผล (ใช้กับกรณีไม่ผ่าน)
  notice_date    date,                             -- วันที่แจ้งพนักงาน
  last_day       date,                             -- วันทำงานวันสุดท้าย
  sign_url       text,                             -- ลายเซ็นรับทราบบนจอ
  signed_at      timestamptz,

  status         text not null default 'open',     -- open | decided | closed
  created_at     timestamptz not null default now(),

  -- คนหนึ่งมีใบประเมินทดลองงานใบเดียว
  unique (emp_id)
);

alter table public.probation_reviews add column if not exists mgr_scores      jsonb;
alter table public.probation_reviews add column if not exists mgr_total       numeric;
alter table public.probation_reviews add column if not exists mgr_comment     text;
alter table public.probation_reviews add column if not exists mgr_by          text;
alter table public.probation_reviews add column if not exists mgr_at          timestamptz;
alter table public.probation_reviews add column if not exists snapshot        jsonb;
alter table public.probation_reviews add column if not exists decision        text;
alter table public.probation_reviews add column if not exists decision_reason text;
alter table public.probation_reviews add column if not exists decided_by      text;
alter table public.probation_reviews add column if not exists decided_at      timestamptz;
alter table public.probation_reviews add column if not exists extend_to       date;
alter table public.probation_reviews add column if not exists notice_date     date;
alter table public.probation_reviews add column if not exists last_day        date;
alter table public.probation_reviews add column if not exists sign_url        text;
alter table public.probation_reviews add column if not exists signed_at       timestamptz;
alter table public.probation_reviews add column if not exists status          text not null default 'open';

create index if not exists idx_prob_emp    on public.probation_reviews (emp_id);
create index if not exists idx_prob_branch on public.probation_reviews (branch_id);
create index if not exists idx_prob_due    on public.probation_reviews (due_date);
create index if not exists idx_prob_status on public.probation_reviews (status);

-- ============================================================
-- กันค่าที่เป็นไปไม่ได้ — บังคับที่ฐานข้อมูล ไม่ปล่อยให้หน้าเว็บคุมอย่างเดียว
--   (หน้าเว็บเรียก API ตรงได้ และเปิดสองจอพร้อมกันก็ไม่เห็นกัน)
-- ============================================================
create or replace function public.probation_guard()
returns trigger language plpgsql as $$
begin
  if new.decision is not null and new.decision not in ('pass','fail','extend') then
    raise exception 'ผลการตัดสินต้องเป็น pass / fail / extend เท่านั้น (ได้รับ %)', new.decision;
  end if;
  -- ตัดสินแล้วต้องมีเหตุผลเสมอ — เอกสารที่ไม่มีเหตุผลใช้อ้างอิงไม่ได้
  if new.decision is not null and coalesce(btrim(new.decision_reason),'') = '' then
    raise exception 'ต้องระบุเหตุผลประกอบผลการตัดสินทดลองงาน';
  end if;
  if new.decision = 'extend' and new.extend_to is null then
    raise exception 'ขยายเวลาทดลองงานต้องระบุวันครบกำหนดใหม่';
  end if;
  if new.extend_to is not null and new.extend_to <= new.due_date then
    raise exception 'วันครบกำหนดใหม่ (%) ต้องหลังวันครบกำหนดเดิม (%)', new.extend_to, new.due_date;
  end if;
  if new.last_day is not null and new.notice_date is not null and new.last_day < new.notice_date then
    raise exception 'วันทำงานวันสุดท้ายต้องไม่อยู่ก่อนวันที่แจ้ง';
  end if;
  if new.decision is not null and new.decided_at is null then
    new.decided_at := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_probation_guard on public.probation_reviews;
create trigger trg_probation_guard
  before insert or update on public.probation_reviews
  for each row execute function public.probation_guard();

alter table public.probation_reviews enable row level security;
drop policy if exists probation_reviews_all on public.probation_reviews;
create policy probation_reviews_all on public.probation_reviews
  for all to anon, authenticated using (true) with check (true);


-- ============================================================
-- ค่าตั้งต้น — แก้ได้ภายหลังโดยไม่ต้องแก้โค้ด
-- ============================================================
insert into public.app_settings (key, value) values ('probation_days', '90')
on conflict (key) do nothing;
-- วันบอกกล่าวล่วงหน้าขั้นต่ำก่อนวันทำงานวันสุดท้าย (1 รอบจ่ายค่าจ้าง)
insert into public.app_settings (key, value) values ('probation_notice_days', '30')
on conflict (key) do nothing;


-- ============================================================
-- ตรวจหลังรัน
-- ============================================================
select 'probation_reviews.sql done' as result,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='probation_reviews') as จำนวนคอลัมน์,
       (select value from public.app_settings where key='probation_days')        as ระยะทดลองงาน,
       (select value from public.app_settings where key='probation_notice_days') as วันบอกกล่าวล่วงหน้า,
       (select count(*) from public.employees
         where active is not false and start_date is not null
           and start_date > current_date - 90)                                   as ยังทดลองงานอยู่;
