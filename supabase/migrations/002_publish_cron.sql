-- تشغيل الناشر الآلي كل دقيقة.
-- استبدل القيمتين قبل التشغيل: رابط المشروع، وقيمة CRON_SECRET نفسها المحفوظة في أسرار الدوال.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://YOUR-PROJECT.supabase.co/functions/v1/publish-due', 'rasd_publish_url');
select vault.create_secret('REPLACE-WITH-CRON-SECRET', 'rasd_cron_secret');

select cron.schedule('rasd-publish-due', '* * * * *', $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'rasd_publish_url'),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'rasd_cron_secret')),
    body    := '{}'::jsonb
  );
$$);
