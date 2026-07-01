-- ============================================================
-- ตั้ง cron ให้เรียก Edge Function storage-cleanup วันละ 1 ครั้ง (ตี 3)
-- ลบรูปเช็กอิน + รูปงาน/ผลัด ที่เก่าเกิน RETENTION_DAYS (ดีฟอลต์ 90 วัน)
-- ต้องเปิด extension: Dashboard > Database > Extensions > pg_cron + pg_net
-- และ Deploy Edge Function "storage-cleanup" ก่อน (ตั้ง env RETENTION_DAYS ได้ถ้าต้องการ)
-- รันบน Supabase: SQL Editor > วาง > Run
-- ============================================================

select cron.unschedule(jobid) from cron.job where jobname in ('storage-cleanup-daily');

select cron.schedule(
  'storage-cleanup-daily',
  '0 20 * * *',                           -- 20:00 UTC = 03:00 ตามเวลาไทย (ทุกวัน)
  $$
  select net.http_post(
    url     := 'https://vppvctftfgchweonxycb.supabase.co/functions/v1/storage-cleanup',
    headers := jsonb_build_object('Content-Type','application/json'),
    body    := '{}'::jsonb
  );
  $$
);

-- ดู cron:        select * from cron.job;
-- ยกเลิก:         select cron.unschedule('storage-cleanup-daily');
-- ลองรันเดี๋ยวนี้:  curl -X POST https://vppvctftfgchweonxycb.supabase.co/functions/v1/storage-cleanup
