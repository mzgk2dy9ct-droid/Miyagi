-- ============================================================
-- Miyagi · Clave de Gemini (pegar en Supabase → SQL Editor → Run)
-- Cambia PEGA_AQUI_TU_CLAVE por tu clave de aistudio.google.com (déjale las comillas).
-- Se guarda en una fila privada: la app nunca la envía al móvil.
-- ============================================================
insert into public.miyagi_docs (col, id, data)
values ('_config', 'gemini', jsonb_build_object('key', 'PEGA_AQUI_TU_CLAVE'))
on conflict (col, id) do update set data = excluded.data, deleted = false, updated_at = now();
