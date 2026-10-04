// GET /api/planes · la lista de productos de Messenger, tal como la cobra la
// base: plan, escalón, topes y precio. La página de planes la lee para
// mostrar los mismos números que rigen en la cuenta. Solo lectura.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const supabaseUrl = process.env.MESSENGER_SUPABASE_URL;
  const publicKey = process.env.MESSENGER_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publicKey) {
    console.error('[planes] Missing Supabase env vars');
    return res.status(500).json({ error: 'server_misconfigured' });
  }
  const supabase = createClient(supabaseUrl, publicKey, { auth: { persistSession: false } });
  const { data, error } = await supabase.rpc('productos_publicos');
  if (error || !data || data.ok !== true || !Array.isArray(data.productos)) {
    console.error('[planes] read error:', error?.message ?? 'respuesta inesperada');
    return res.status(502).json({ error: 'unavailable' });
  }
  // Cinco minutos en el borde: un cambio de precio se ve enseguida y la base no recibe una lectura por visita.
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
  return res.status(200).json({ ok: true, productos: data.productos });
}
