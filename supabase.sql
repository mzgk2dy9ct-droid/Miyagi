-- ============================================================
-- Miyagi · Base de datos (pegar en Supabase → SQL Editor → Run)
-- Va en el MISMO proyecto que Alfred, pero en su propia tabla.
-- ============================================================

-- 1) Una sola tabla para todo: cada fila es un documento (un día, una foto, la despensa…)
create table if not exists public.miyagi_docs (
  col        text        not null,
  id         text        not null,
  data       jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);
create index if not exists miyagi_docs_updated_idx on public.miyagi_docs (updated_at);

-- 2) Seguridad: nadie puede leerla desde fuera. Solo el servidor de Miyagi,
--    que usa la clave secreta, tiene acceso.
alter table public.miyagi_docs enable row level security;
