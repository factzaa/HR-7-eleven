-- ============================================================
-- 7-Eleven HR — ฝาก "งาน" หรือ "ข้อความ" ให้ผลัดถัดไป
-- สร้าง 19 พ.ย. 69
-- รันบน Supabase: SQL Editor > วาง > Run   (รันซ้ำได้ ไม่กระทบข้อมูลเดิม)
--
-- ของเดิม: หัวหน้าผลัดพิมพ์ข้อความเดียวตอนกดส่งผลัด (shift_submits.note)
--          ผลัดถัดไปเปิดแอปก็นับว่า "เห็นแล้ว" อัตโนมัติ — ไม่มีการตอบรับจริง
--          และถ้าเป็นงานที่ต้องทำต่อ ก็ไม่มีที่ลง กลายเป็นข้อความลอย ๆ
--
-- ของใหม่: ฝากได้หลายรายการ แยกเป็น 2 ชนิด
--   งาน (task) → เข้าไปอยู่ในงานของผลัดถัดไป หัวหน้าผลัดถัดไปแจกให้คนในกะ
--                ติดธง "งานฝาก" และบังคับถ่ายรูปส่งเสมอ
--   ข้อความ (msg) → ทุกคนในกะถัดไปต้องกดรับทราบ ถ้ายังไม่ครบ ส่งผลัดไม่ได้
--
-- ใครก็ฝากได้ แต่ต้องให้หัวหน้าผลัดกดอนุมัติก่อน จึงจะส่งต่อไปผลัดถัดไป
-- ต้องรัน supabase/task_system.sql มาก่อน
-- ============================================================

-- ------------------------------------------------------------
-- [1] รายการที่ฝากไว้
-- ------------------------------------------------------------
create table if not exists public.shift_handovers (
  id             bigint generated always as identity primary key,

  -- ผลัดต้นทาง (คนฝาก)
  branch_id      text not null,
  work_date      date not null,
  shift_id       text not null,                      -- ผลัดหลัก (main_shift)

  -- ผลัดปลายทาง — เติมตอนหัวหน้าผลัดอนุมัติ (ผลัดถัดไปเท่านั้น)
  to_work_date   date,
  to_shift_id    text,

  kind           text not null check (kind in ('task','msg')),
  title          text not null,                      -- เนื้อเรื่อง / ชื่องาน
  photos         jsonb not null default '[]',        -- รูปประกอบจากคนฝาก

  created_by     text not null,
  created_by_name text,
  created_at     timestamptz not null default now(),

  -- หัวหน้าผลัดต้นทางตรวจก่อนส่งต่อ
  review         text not null default 'pending'
                 check (review in ('pending','approved','rejected')),
  reviewed_by    text,
  reviewed_name  text,
  review_note    text,                               -- เหตุผลตอนตีตก
  reviewed_at    timestamptz,

  -- สถานะปลายทาง
  --   open      = ส่งถึงผลัดถัดไปแล้ว ยังไม่ได้แจก (เฉพาะ kind='task')
  --   assigned  = หัวหน้าผลัดถัดไปแจกให้คนในกะแล้ว
  --   done      = งานถูกส่ง/ตรวจผ่านแล้ว
  --   cancelled = หัวหน้าผลัดถัดไปปิดงานพร้อมเหตุผล
  status         text not null default 'open'
                 check (status in ('open','assigned','done','cancelled')),
  assignment_id  bigint,                             -- task_assignments.id ตอนแจกแล้ว
  assigned_to    text,
  assigned_name  text,
  cancel_reason  text,
  closed_at      timestamptz
);

create index if not exists idx_sho_src on public.shift_handovers (branch_id, work_date, shift_id);
create index if not exists idx_sho_dst on public.shift_handovers (branch_id, to_work_date, to_shift_id, status);
create index if not exists idx_sho_review on public.shift_handovers (review) where review = 'pending';

-- ------------------------------------------------------------
-- [2] ใบรับทราบ (เฉพาะ kind = 'msg') — 1 คน ต่อ 1 ข้อความ
-- ------------------------------------------------------------
create table if not exists public.shift_handover_acks (
  id           bigint generated always as identity primary key,
  handover_id  bigint not null references public.shift_handovers(id) on delete cascade,
  emp_id       text not null,
  emp_name     text,
  ack_at       timestamptz not null default now(),
  unique (handover_id, emp_id)
);
create index if not exists idx_shoa_h on public.shift_handover_acks (handover_id);

-- ------------------------------------------------------------
-- [3] สิทธิ์ (ตามแบบเดียวกับตารางอื่นในระบบ)
-- ------------------------------------------------------------
alter table public.shift_handovers      enable row level security;
alter table public.shift_handover_acks  enable row level security;
drop policy if exists sho_all  on public.shift_handovers;
drop policy if exists shoa_all on public.shift_handover_acks;
create policy sho_all  on public.shift_handovers     for all to anon, authenticated using (true) with check (true);
create policy shoa_all on public.shift_handover_acks for all to anon, authenticated using (true) with check (true);

-- ------------------------------------------------------------
-- [4] งานฝากเป็นงานในกะจริง ๆ — ต้องถ่ายรูปส่งเสมอ
--     กันพลาด: ถึงฝั่งแอปจะลืมตั้ง require_photo ฐานข้อมูลก็บังคับให้เอง
-- ------------------------------------------------------------
create or replace function public.task_assign_force_photo()
returns trigger
language plpgsql
as $fn$
begin
  if new.task_def_id is null and coalesce(new.title, '') like '[งานฝาก]%' then
    new.require_photo := true;
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_task_assign_force_photo on public.task_assignments;
create trigger trg_task_assign_force_photo
  before insert or update on public.task_assignments
  for each row execute function public.task_assign_force_photo();

-- ------------------------------------------------------------
-- [5] ตรวจว่าติดตั้งแล้ว
-- ------------------------------------------------------------
select 'shift_handover.sql done' as result;
select count(*) as "รายการที่ฝากไว้"   from public.shift_handovers;
select count(*) as "ใบรับทราบ"          from public.shift_handover_acks;

-- ============================================================
-- วิธีถอนกลับ (รันเฉพาะบรรทัดที่ต้องการ)
-- ============================================================
-- drop trigger if exists trg_task_assign_force_photo on public.task_assignments;
-- drop function if exists public.task_assign_force_photo();
-- drop table if exists public.shift_handover_acks;
-- drop table if exists public.shift_handovers;
