-- ═══════════════════════════════════════════════════════════════════════
-- ag_leads · funciones para que agentina.app no use la clave total
--
-- CORRER EN · el proyecto de Supabase de agentina.app · SQL Editor.
-- Después de ag_leads.sql.
--
-- Hasta ahora el formulario de la lista de espera y el admin de leads usaban
-- la service_role, que puede todo en esta base. Con estas funciones cada uno
-- puede solo lo suyo:
--   · ag_waitlist_anotar: cualquiera, solo inserta un lead. Con tope por
--     minuto y por correo, porque la clave pública es pública.
--   · ag_leads_listar y ag_leads_nota: solo un usuario de Auth con correo
--     confirmado que esté en ag_admins.
-- Ninguna tabla queda legible ni escribible desde afuera.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.ag_leads') IS NULL THEN
    RAISE EXCEPTION 'Falta ag_leads: esta no es la base de agentina.app. No se cambió nada.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ag_admins (
  email      TEXT PRIMARY KEY CHECK (email = lower(btrim(email))),
  creado_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ag_limite (
  clave   TEXT NOT NULL,
  ventana TIMESTAMPTZ NOT NULL,
  cuenta  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (clave, ventana)
);

ALTER TABLE ag_leads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ag_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE ag_limite ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE ag_leads, ag_admins, ag_limite FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE ag_leads, ag_admins, ag_limite FROM anon, authenticated;
  END IF;
END $$;

-- Cuenta un pedido en la ventana del minuto y dice si sigue dentro del tope.
CREATE OR REPLACE FUNCTION _ag_por_minuto(p_clave TEXT, p_limite INTEGER) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ventana TIMESTAMPTZ := date_trunc('minute', now()); v_n INTEGER;
BEGIN
  INSERT INTO ag_limite AS l (clave, ventana, cuenta) VALUES (p_clave, v_ventana, 1)
  ON CONFLICT (clave, ventana) DO UPDATE SET cuenta = l.cuenta + 1
  RETURNING l.cuenta INTO v_n;
  IF v_n = 1 THEN DELETE FROM ag_limite WHERE ventana < v_ventana - INTERVAL '1 hour'; END IF;
  RETURN v_n <= p_limite;
END $$;

CREATE OR REPLACE FUNCTION _ag_es_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users u JOIN ag_admins a ON a.email = lower(btrim(u.email))
     WHERE u.id = auth.uid() AND u.email_confirmed_at IS NOT NULL);
$$;

CREATE OR REPLACE FUNCTION ag_waitlist_anotar(
  p_full_name TEXT, p_linkedin_url TEXT, p_company TEXT, p_email TEXT, p_whatsapp TEXT,
  p_captured_locale TEXT, p_source_path TEXT, p_user_agent TEXT, p_ip_address TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email TEXT := lower(btrim(COALESCE(p_email, '')));
  v_id    UUID;
  v_ip    INET;
BEGIN
  IF char_length(btrim(COALESCE(p_full_name, ''))) NOT BETWEEN 2 AND 200
     OR char_length(btrim(COALESCE(p_company, ''))) NOT BETWEEN 2 AND 200
     OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR char_length(v_email) > 254
     OR btrim(COALESCE(p_whatsapp, '')) !~ '^\+?[0-9]{7,15}$'
     OR char_length(COALESCE(p_linkedin_url, '')) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'datos_invalidos');
  END IF;
  -- La clave pública es pública: el tope lo pone la base, no solo el servidor.
  IF NOT _ag_por_minuto('waitlist', 60) OR NOT _ag_por_minuto('waitlist:' || v_email, 3) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'demasiados_pedidos');
  END IF;
  BEGIN v_ip := NULLIF(btrim(COALESCE(p_ip_address, '')), '')::INET; EXCEPTION WHEN others THEN v_ip := NULL; END;

  INSERT INTO ag_leads (full_name, linkedin_url, company, email, whatsapp, captured_locale, source_path, user_agent, ip_address)
  VALUES (btrim(p_full_name), NULLIF(btrim(COALESCE(p_linkedin_url, '')), ''), btrim(p_company), v_email, btrim(p_whatsapp),
          CASE WHEN p_captured_locale IN ('es', 'en', 'pt') THEN p_captured_locale ELSE 'es' END,
          left(p_source_path, 500), left(p_user_agent, 500), v_ip)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION ag_leads_listar() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN NOT _ag_es_admin() THEN NULL ELSE COALESCE((
    SELECT jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC)
      FROM (SELECT * FROM ag_leads ORDER BY created_at DESC LIMIT 1000) l), '[]'::jsonb) END;
$$;

CREATE OR REPLACE FUNCTION ag_leads_nota(p_id UUID, p_notes TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lead ag_leads%ROWTYPE;
BEGIN
  IF NOT _ag_es_admin() THEN RETURN NULL; END IF;
  UPDATE ag_leads SET notes = left(COALESCE(p_notes, ''), 5000) WHERE id = p_id RETURNING * INTO v_lead;
  IF v_lead.id IS NULL THEN RETURN jsonb_build_object('error', 'no_encontrado'); END IF;
  RETURN to_jsonb(v_lead);
END $$;

DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['_ag_por_minuto(TEXT, INTEGER)', '_ag_es_admin()',
                           'ag_waitlist_anotar(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)',
                           'ag_leads_listar()', 'ag_leads_nota(UUID, TEXT)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM anon, authenticated';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT EXECUTE ON FUNCTION ag_waitlist_anotar(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION ag_leads_listar() TO authenticated;
    GRANT EXECUTE ON FUNCTION ag_leads_nota(UUID, TEXT) TO authenticated;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
