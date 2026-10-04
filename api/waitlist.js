// POST /api/waitlist
// Recibe el form de waitlist desde el sitio público.
// Valida, guarda el pedido en la base del producto y notifica por email (Resend).
//   · Desde /messenger → base de Messenger, función anotar_lista_espera.
//   · Desde el resto del sitio → base de agentina, función ag_waitlist_anotar.
// Usa solo la clave publicable de cada base: cada función inserta un pedido y nada más.
//
// Filosofía: errores visibles del lado server, mensajes claros del lado cliente,
// nunca silencioso. Anti-bot vía honeypot + rate limit por IP en memoria.

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const RATE_LIMIT_WINDOW_MS = 10_000; // 10s entre requests por IP
const CANTIDADES = ['1', '2-5', '6-20', '21-50', '50+'];
const PLATAFORMAS = ['claude_code', 'codex', 'antigravity', 'hermes', 'openclaw', 'otra'];
const PLANES = ['starter', 'pro', 'business', 'enterprise'];
const recentByIp = new Map(); // IP -> timestamp último request

// Templates del email de notificación localizados por captured_locale.
// El aviso lo lee el equipo — localizar le da contexto rápido del lead
// (ej: si llegó en EN, probablemente conviene contactarlo en EN).
const EMAIL_TEMPLATES = {
  es: {
    subject: (name, company) => `Nuevo lead: ${name} (${company})`,
    title: 'Nuevo lead en la waitlist de Agentina',
    labels: { name: 'Nombre', company: 'Empresa', email: 'Email', whatsapp: 'WhatsApp', linkedin: 'LinkedIn', locale: 'Idioma de captura', path: 'Path', date: 'Fecha' },
  },
  en: {
    subject: (name, company) => `New lead: ${name} (${company})`,
    title: 'New lead on the Agentina waitlist',
    labels: { name: 'Name', company: 'Company', email: 'Email', whatsapp: 'WhatsApp', linkedin: 'LinkedIn', locale: 'Capture language', path: 'Path', date: 'Date' },
  },
  pt: {
    subject: (name, company) => `Novo lead: ${name} (${company})`,
    title: 'Novo lead na waitlist da Agentina',
    labels: { name: 'Nome', company: 'Empresa', email: 'Email', whatsapp: 'WhatsApp', linkedin: 'LinkedIn', locale: 'Idioma de captura', path: 'Path', date: 'Data' },
  },
};

function getClientIp(req) {
  // Vercel pone la IP real en x-forwarded-for (primer item antes de la coma)
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const last = recentByIp.get(ip);
  if (last && (now - last) < RATE_LIMIT_WINDOW_MS) return true;
  recentByIp.set(ip, now);
  // Limpieza ocasional de entradas viejas (cada ~100 inserts)
  if (recentByIp.size > 1000) {
    for (const [k, v] of recentByIp) {
      if (now - v > RATE_LIMIT_WINDOW_MS * 10) recentByIp.delete(k);
    }
  }
  return false;
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function isValidWhatsapp(value) {
  // Acepta E.164 (+5491165432100) o solo números con espacios/guiones (los normalizamos)
  if (typeof value !== 'string') return false;
  const stripped = value.replace(/[\s\-()]/g, '');
  // E.164: + opcional + 7-15 dígitos
  return /^\+?\d{7,15}$/.test(stripped);
}

function normalizeWhatsapp(value) {
  const stripped = value.replace(/[\s\-()]/g, '');
  // Si no tiene +, asumimos que viene sin código país y agregamos +
  // (Mejor: idealmente el form fuerza E.164. Validación cubre ambos casos.)
  if (!stripped.startsWith('+')) return '+' + stripped;
  return stripped;
}

function isValidLinkedinUrl(value) {
  if (!value) return true; // opcional
  if (typeof value !== 'string') return false;
  // Acepta cualquier URL de linkedin.com (perfil, empresa, etc.) o solo el handle
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return /^https?:\/\/([a-z0-9-]+\.)?linkedin\.com\//i.test(value) && value.length <= 500;
  }
  // Si no tiene http, asumimos handle: linkedin.com/in/handle
  return /^[a-zA-Z0-9_-]+$/.test(value) && value.length <= 100;
}

function normalizeLinkedinUrl(value) {
  if (!value) return null;
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  // Asumimos handle puro → URL completa
  return `https://www.linkedin.com/in/${value}`;
}

export default async function handler(req, res) {
  // Sin CORS: el formulario vive en el mismo dominio, y ninguna otra página
  // tiene por qué poder usar esta ruta desde el navegador.

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Rate limit por IP
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'rate_limited', message: 'Demasiadas solicitudes. Espera unos segundos.' });
  }

  // Parse body (Vercel Functions parsean JSON automático si Content-Type es application/json)
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid_body' });
  }

  // Honeypot — campo invisible que solo bots completan
  if (body.website && String(body.website).trim() !== '') {
    // Aceptamos silenciosamente (no le decimos al bot que detectamos)
    return res.status(200).json({ ok: true });
  }

  // Extraer y validar campos
  const fullName = String(body.full_name || '').trim();
  const linkedin = body.linkedin_url ? String(body.linkedin_url).trim() : null;
  const company = String(body.company || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const whatsapp = String(body.whatsapp || '').trim();
  const locale = ['es', 'en', 'pt'].includes(body.captured_locale) ? body.captured_locale : 'es';
  const sourcePath = body.source_path ? String(body.source_path).slice(0, 500) : null;
  const esMessenger = typeof sourcePath === 'string' && /^\/messenger(\/|\?|#|$)/.test(sourcePath);
  const cantidadAgentes = body.cantidad_agentes ? String(body.cantidad_agentes) : null;
  const plataformas = Array.isArray(body.plataformas) ? [...new Set(body.plataformas.map(String))] : [];
  // El plan que eligió la persona en la página de planes, si eligió uno.
  const plan = body.plan ? String(body.plan).trim().toLowerCase() : null;

  const errors = {};
  if (!fullName || fullName.length < 2) errors.full_name = 'Nombre requerido (mínimo 2 caracteres)';
  if (!company || company.length < 2) errors.company = 'Empresa requerida';
  if (!isValidEmail(email)) errors.email = 'Email inválido';
  if (!isValidWhatsapp(whatsapp)) errors.whatsapp = 'WhatsApp inválido — incluye el código de país (ej: +5491165432100)';
  if (linkedin && !isValidLinkedinUrl(linkedin)) errors.linkedin_url = 'URL de LinkedIn inválida';
  if (esMessenger) {
    if (!CANTIDADES.includes(cantidadAgentes)) errors.cantidad_agentes = 'Elige cuántos agentes manejas';
    if (plataformas.length === 0 || !plataformas.every((x) => PLATAFORMAS.includes(x))) errors.plataformas = 'Marca al menos una plataforma';
    if (plan && !PLANES.includes(plan)) errors.plan = 'Elige uno de los planes';
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ error: 'validation_failed', fields: errors });
  }

  // Guardar en la base del producto, con su clave publicable.
  const supabaseUrl = esMessenger ? process.env.MESSENGER_SUPABASE_URL : process.env.AGENTINA_SUPABASE_URL;
  const publicKey = esMessenger ? process.env.MESSENGER_SUPABASE_PUBLISHABLE_KEY : process.env.AGENTINA_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publicKey) {
    console.error('[waitlist] Missing Supabase env vars', esMessenger ? 'messenger' : 'agentina');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const supabase = createClient(supabaseUrl, publicKey, { auth: { persistSession: false } });

  const userAgent = req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 500) : null;
  const comunes = {
    p_full_name: fullName,
    p_linkedin_url: normalizeLinkedinUrl(linkedin),
    p_company: company,
    p_email: email,
    p_whatsapp: normalizeWhatsapp(whatsapp),
    p_captured_locale: locale,
    p_source_path: sourcePath,
    p_user_agent: userAgent,
    p_ip_address: ip !== 'unknown' ? ip : null,
  };
  const { data: resultado, error: rpcError } = esMessenger
    // Enterprise no es un producto de la tabla: queda en la ruta de origen (?plan=enterprise) y en el aviso, no en p_plan.
    ? await supabase.rpc('anotar_lista_espera', { ...comunes, p_cantidad_agentes: cantidadAgentes, p_plataformas: plataformas, p_plan: plan === 'enterprise' ? null : plan })
    : await supabase.rpc('ag_waitlist_anotar', comunes);

  if (rpcError || !resultado || resultado.ok !== true) {
    console.error('[waitlist] Insert error:', rpcError?.message ?? resultado?.error);
    if (resultado?.error === 'demasiados_pedidos') {
      return res.status(429).json({ error: 'rate_limited', message: 'Demasiadas solicitudes. Espera unos segundos.' });
    }
    if (resultado?.error === 'datos_invalidos') {
      return res.status(400).json({ error: 'validation_failed', fields: {} });
    }
    return res.status(500).json({ error: 'insert_failed' });
  }
  const lead = { id: resultado.id, created_at: new Date().toISOString() };

  // Notificación por email (no bloqueante — si falla el email, igual respondemos OK al usuario)
  // Localizado por captured_locale para que el subject/labels coincidan con el idioma
  // del lead — útil para contexto rápido al decidir cómo contactarlo.
  const resendKey = process.env.RESEND_API_KEY;
  const notifyEmail = process.env.NOTIFICATION_EMAIL;
  if (resendKey && notifyEmail) {
    try {
      const resend = new Resend(resendKey);
      const t = EMAIL_TEMPLATES[locale] || EMAIL_TEMPLATES.es;
      const normalizedWa = normalizeWhatsapp(whatsapp);
      const normalizedLi = normalizeLinkedinUrl(linkedin);
      await resend.emails.send({
        from: 'agentina <info@agentina.app>',
        // Responder el aviso le escribe directo a la persona que se anotó.
        replyTo: email,
        to: notifyEmail,
        subject: (esMessenger ? '[Messenger] ' : '') + t.subject(fullName, company),
        html: `
<h2>${t.title}</h2>
<table cellpadding="6" style="border-collapse:collapse;font-family:system-ui,sans-serif">
<tr><td><strong>${t.labels.name}</strong></td><td>${escapeHtml(fullName)}</td></tr>
<tr><td><strong>${t.labels.company}</strong></td><td>${escapeHtml(company)}</td></tr>
<tr><td><strong>${t.labels.email}</strong></td><td><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>
<tr><td><strong>${t.labels.whatsapp}</strong></td><td><a href="https://wa.me/${normalizedWa.replace('+','')}">${escapeHtml(normalizedWa)}</a></td></tr>
${linkedin ? `<tr><td><strong>${t.labels.linkedin}</strong></td><td><a href="${escapeHtml(normalizedLi)}">${escapeHtml(normalizedLi)}</a></td></tr>` : ''}
${esMessenger ? `<tr><td><strong>Agentes</strong></td><td>${escapeHtml(cantidadAgentes)}</td></tr><tr><td><strong>Plataformas</strong></td><td>${escapeHtml(plataformas.join(', '))}</td></tr><tr><td><strong>Plan</strong></td><td>${escapeHtml(plan || 'sin elegir')}</td></tr>` : ''}
<tr><td><strong>${t.labels.locale}</strong></td><td>${locale.toUpperCase()}</td></tr>
<tr><td><strong>${t.labels.path}</strong></td><td>${escapeHtml(sourcePath || '/')}</td></tr>
<tr><td><strong>${t.labels.date}</strong></td><td>${new Date(lead.created_at).toISOString()}</td></tr>
</table>

        `.trim(),
      });
    } catch (emailError) {
      // Loggeamos pero no rompemos el flujo del usuario
      console.error('[waitlist] Email notification failed:', emailError);
    }
  }

  return res.status(200).json({ ok: true, id: lead.id });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
