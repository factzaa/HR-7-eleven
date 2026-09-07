-- ============================================================
-- คู่มือจากบทเรียน (SOP) — เก็บสิ่งที่ AI อ่านได้จากภาพขั้นตอนของวิดีโออบรม
--
-- ที่มา: หลักสูตร "เตรียมพื้นฐานผู้ช่วยผู้จัดการร้าน Ver.2022" (รหัส 011043)
--        วิดีโอเป็นการอัดหน้าจอ POS + ตัวหนังสือไทยพิมพ์บนภาพทุกขั้นตอน
--        สคริปต์ capture-lesson.js จับภาพจุดที่ขึ้นขั้นตอนใหม่ → แผ่นภาพ
--        แล้วส่งเข้า course_import ให้ AI เรียบเรียงเป็นขั้นตอนที่อ่านรู้เรื่อง
--
-- ⚠ เนื้อหาเป็นลิขสิทธิ์ CP ALL/ปัญญธารา — ใช้สอนงานภายในร้านเท่านั้น
-- ⚠ ทุกบทต้องมีคนตรวจแก้ (reviewed) ก่อน นิดาถึงจะเอาไปตอบได้
--    เพราะ AI อ่านจากภาพ อาจตกหล่นส่วนที่ผู้บรรยายพูดโดยไม่ขึ้นจอ
-- ============================================================

-- 1) บทเรียน 1 บท = 1 แถว ------------------------------------------------
create table if not exists public.course_lessons (
  id           bigint generated always as identity primary key,
  course_code  text        not null default '011043',
  course_name  text        not null default 'เตรียมพื้นฐานผู้ช่วยผู้จัดการร้าน Ver.2022',
  section      text,                                    -- "ส่วน 2 - การบริหารงานขายประจำผลัด"
  lesson_no    text        not null,                    -- "2.1"
  title        text        not null,                    -- ชื่อบทตามหลักสูตร
  summary      text,                                    -- สรุปว่าบทนี้สอนอะไร ใช้เมื่อไหร่ (AI เขียน คนตรวจ)
  when_to_use  text,                                    -- สถานการณ์ที่ต้องใช้ขั้นตอนนี้
  cautions     text,                                    -- ข้อควรระวัง/เงื่อนไขสำคัญ
  source_url   text,                                    -- ลิงก์บทเรียนต้นทาง (ย้อนไปดูวิดีโอจริงได้)
  duration_sec int,
  sheet_urls   text[]      not null default '{}',       -- แผ่นภาพที่ใช้เป็นหลักฐาน
  step_count   int         not null default 0,
  reviewed     boolean     not null default false,      -- ★ คนตรวจแก้แล้วหรือยัง
  reviewed_by  text,
  reviewed_at  timestamptz,
  active       boolean     not null default true,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- กันนำเข้าซ้ำ: หลักสูตรเดียวกัน บทเดียวกัน = แถวเดียว
create unique index if not exists uq_course_lessons_key
  on public.course_lessons (course_code, lesson_no);
create index if not exists idx_course_lessons_sec on public.course_lessons (section);

-- 2) ขั้นตอนในบท --------------------------------------------------------
create table if not exists public.course_steps (
  id          bigint generated always as identity primary key,
  lesson_id   bigint      not null references public.course_lessons(id) on delete cascade,
  step_no     int         not null,
  heading     text,                                     -- หัวข้อสั้น ๆ ของขั้นตอน
  instruction text        not null,                     -- ทำอะไร (ภาษาสั่งงาน)
  screen      text,                                     -- อยู่ที่หน้าจอไหน/กดปุ่มไหน
  note        text,                                     -- ข้อสังเกต/ตัวเลือกที่มี
  at_sec      int,                                      -- นาทีในวิดีโอ ไว้ย้อนไปดูของจริง
  image_url   text,                                     -- แผ่นภาพที่ขั้นตอนนี้อยู่
  created_at  timestamptz not null default now()
);
create index if not exists idx_course_steps_lesson on public.course_steps (lesson_id, step_no);
create unique index if not exists uq_course_steps_no on public.course_steps (lesson_id, step_no);

-- 3) ที่เก็บแผ่นภาพ -----------------------------------------------------
insert into storage.buckets (id, name, public)
values ('course-sheets', 'course-sheets', true)
on conflict (id) do nothing;

do $$ begin
  begin
    create policy "course sheets read"  on storage.objects for select using (bucket_id = 'course-sheets');
  exception when duplicate_object then null; end;
  begin
    create policy "course sheets write" on storage.objects for insert with check (bucket_id = 'course-sheets');
  exception when duplicate_object then null; end;
end $$;

-- 4) มุมมองที่นิดาใช้ค้น (เห็นเฉพาะบทที่ตรวจแก้แล้ว) ------------------------
drop view if exists public.course_sop_v;
create view public.course_sop_v as
select
  l.id            as lesson_id,
  l.course_code, l.section, l.lesson_no, l.title,
  l.summary, l.when_to_use, l.cautions, l.source_url,
  l.sheet_urls, l.step_count, l.reviewed, l.active,
  s.step_no, s.heading, s.instruction, s.screen, s.note, s.at_sec, s.image_url
from public.course_lessons l
left join public.course_steps s on s.lesson_id = l.id
where l.active;

-- 5) สรุปความคืบหน้า (ไว้โชว์บนหน้าคู่มือ) --------------------------------
drop view if exists public.course_progress_v;
create view public.course_progress_v as
select
  coalesce(section, '(ไม่ระบุส่วน)') as ส่วน,
  count(*)                                          as บททั้งหมด,
  count(*) filter (where reviewed)                  as ตรวจแก้แล้ว,
  count(*) filter (where not reviewed)              as ยังไม่ตรวจ,
  sum(step_count)                                   as ขั้นตอนรวม
from public.course_lessons
where active
group by 1
order by 1;

-- 6) ตรวจว่าพร้อมแล้ว
select 'course_lessons' as ตาราง, count(*) as แถว from public.course_lessons
union all select 'course_steps', count(*) from public.course_steps;
