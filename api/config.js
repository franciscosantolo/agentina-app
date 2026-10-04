// GET /api/config
// Devuelve config pública del admin (URL + anon key de Supabase).
// Esto NO es secreto — la anon key está pensada para uso público y RLS protege los datos.
// Lo exponemos vía endpoint en lugar de inline en HTML para mantener admin/index.html versionable
// sin tener que reescribirlo cuando rotemos credenciales.

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const supabaseUrl = process.env.AGENTINA_SUPABASE_URL;
  const supabaseAnonKey = process.env.AGENTINA_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  // Cache: 5 minutos al edge — config no cambia seguido
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  return res.status(200).json({
    supabaseUrl,
    supabaseAnonKey,
  });
}
