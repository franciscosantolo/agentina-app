// GET    /api/leads          - lista todos los leads (autenticado)
// PATCH  /api/leads?id=:id   - actualiza notes de un lead (autenticado)
//
// Auth: Bearer token de Supabase en header Authorization.
// Verifica que el email del usuario coincida con NOTIFICATION_EMAIL, y la base
// vuelve a verificarlo: ag_leads_listar y ag_leads_nota solo responden a un
// usuario con correo confirmado que esté en ag_admins. Las consultas van con
// la sesión de quien entra, nunca con la clave total.

import { createClient } from '@supabase/supabase-js';

async function authenticate(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return { error: 'missing_token', status: 401 };

  const token = match[1];
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return { error: 'server_misconfigured', status: 500 };

  // Verificar el token con Supabase (devuelve user si es válido)
  const supabase = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return { error: 'invalid_token', status: 401 };

  // Allowlist por email
  const allowedEmail = (process.env.NOTIFICATION_EMAIL || '').toLowerCase();
  const userEmail = (data.user.email || '').toLowerCase();
  if (!allowedEmail || userEmail !== allowedEmail) {
    return { error: 'forbidden', status: 403 };
  }

  return { user: data.user, token };
}

// Cliente con la sesión de quien entra: la base decide qué puede ver.
function clienteConSesion(token) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

export default async function handler(req, res) {
  // Auth check para todos los métodos
  const authResult = await authenticate(req);
  if (authResult.error) {
    return res.status(authResult.status).json({ error: authResult.error });
  }

  const db = clienteConSesion(authResult.token);

  if (req.method === 'GET') {
    // Listar leads (max 1000 — si crece, paginar)
    const { data, error } = await db.rpc('ag_leads_listar');

    if (error) {
      console.error('[leads:list] error:', error);
      return res.status(500).json({ error: 'query_failed' });
    }
    if (data === null) return res.status(403).json({ error: 'forbidden' });

    return res.status(200).json({ leads: data });
  }

  if (req.method === 'PATCH') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid_json' }); }
    }
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid_body' });

    // Solo permitimos editar `notes` por ahora — los datos del lead no se tocan después de captura
    const updates = {};
    if (typeof body.notes === 'string') {
      updates.notes = body.notes.slice(0, 5000); // límite razonable
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no_updates' });
    }

    const { data, error } = await db.rpc('ag_leads_nota', { p_id: id, p_notes: updates.notes });

    if (error) {
      console.error('[leads:patch] error:', error);
      return res.status(500).json({ error: 'update_failed' });
    }
    if (data === null) return res.status(403).json({ error: 'forbidden' });
    if (data.error) return res.status(404).json({ error: 'not_found' });

    return res.status(200).json({ lead: data });
  }

  return res.status(405).json({ error: 'method_not_allowed' });
}
