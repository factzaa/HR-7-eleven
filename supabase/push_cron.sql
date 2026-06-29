-- ============================================================
-- ตั้ง cron ให้เรียก Edge Function hr-notify ทุก 15 นาที
-- ต้องเปิด extension ก่อน: Dashboard > Database > Extensions > เปิด pg_cron และ pg_net
-- รันบน Supabase: SQL Editor > วาง > Run
-- ============================================================

-- ลบตัวตั้งเวลาเก่าเฉพาะถ้ามี (ไม่ error ถ้าไม่มี)
select cron.unschedule(jobid) from cron.job where jobname in ('hr-notify-15m','hr-notify-5m');

select cron.schedule(
  'hr-notify-5m',
  '*/5 * * * *',                          -- ทุก 5 นาที (ปรับได้ เช่น '*/10 * * * *')
  $$
  select net.http_post(
    url     := 'https://vppvctftfgchweonxycb.supabase.co/functions/v1/hr-notify',
    headers := jsonb_build_object('Content-Type','application/json'),
    body    := '{}'::jsonb
  );
  $$
);

-- ดูรายการ cron ที่ตั้งไว้:  select * from cron.job;
-- ยกเลิก:                    select cron.unschedule('hr-notify-5m');
