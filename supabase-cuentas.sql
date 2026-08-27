-- ════════════════════════════════════════════════════════════════
-- Cuentas (checklist de pagos mensuales) para el dashboard
-- Correr una vez en el SQL Editor de Supabase.
-- ════════════════════════════════════════════════════════════════

-- Ítems recurrentes (nombre + monto default que se repite mes a mes)
create table if not exists cuentas_items (
  id         bigint generated always as identity primary key,
  nombre     text    not null default '',
  monto      numeric not null default 0,
  orden      int     not null default 0,
  deleted    boolean not null default false,
  creado_at  timestamptz not null default now(),
  updated_at timestamptz default now()
);

-- Estado por mes: pagado sí/no. Una fila por (ítem, mes 'YYYY-MM').
create table if not exists cuentas_mes (
  item_id    bigint not null references cuentas_items(id) on delete cascade,
  mes        text   not null,
  pagado     boolean not null default false,
  updated_at timestamptz default now(),
  primary key (item_id, mes)
);

-- Los endpoints ya validan con x-api-key; desactivamos RLS como en las
-- otras tablas del dashboard (daily_notes, event_notes, note_items).
alter table cuentas_items disable row level security;
alter table cuentas_mes   disable row level security;
