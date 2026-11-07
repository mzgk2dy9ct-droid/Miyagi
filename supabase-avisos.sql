-- ============================================================
-- Miyagi · Avisos push (pegar en Supabase → SQL Editor → Run)
-- Hazlo DESPUÉS de tener la app en Vercel. Cambia las dos cosas en MAYÚSCULAS.
-- ============================================================
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Cada 2 minutos, Supabase avisa a Miyagi para que envíe los avisos pendientes.
select cron.schedule(
  'miyagi-avisos',
  '*/2 * * * *',
  $$ select net.http_get(url := 'https://TU-APP.vercel.app/api/cron?key=TU_CRON_SECRET') $$
);

-- Para quitarlo algún día:  select cron.unschedule('miyagi-avisos');
