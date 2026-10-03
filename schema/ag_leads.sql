-- Schema para waitlist de agentina.app
-- Convención del ecosistema: prefijo ag_ para todas las tablas relacionadas con agentina
-- Ejecutar una vez en el SQL Editor del proyecto de Supabase de agentina.app

create table if not exists ag_leads (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  linkedin_url text,
  company text not null,
  email text not null,
  whatsapp text not null,
  captured_locale text not null default 'es',
  source_path text,
  user_agent text,
  ip_address inet,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ag_leads_email_idx on ag_leads (email);
create index if not exists ag_leads_created_at_idx on ag_leads (created_at desc);
create index if not exists ag_leads_company_idx on ag_leads (company);

-- RLS: nadie lee ni escribe la tabla desde afuera. El formulario y el admin
-- pasan por las funciones de ag_leads_funciones.sql, sin la clave total.
alter table ag_leads enable row level security;

-- Trigger para mantener updated_at actualizado
create or replace function ag_leads_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists ag_leads_updated_at on ag_leads;
create trigger ag_leads_updated_at
  before update on ag_leads
  for each row execute function ag_leads_set_updated_at();
