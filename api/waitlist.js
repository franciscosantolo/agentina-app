// POST /api/waitlist
// Recibe el form de waitlist desde el sitio público.
// Valida, inserta en ag_leads (Supabase) y notifica por email (Resend).
//
// Filosofía: errores visibles del lado server, mensajes claros del lado cliente,
// nunca silencioso. Anti-bot vía honeypot + rate limit por IP en memoria.

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const RATE_LIMIT_WINDOW_MS = 10_000; // 10s entre requests por IP
const recentByIp = new Map(); // IP -> timestamp último request

// Templates del email de notificación localizados por captured_locale.
// El email lo lee Francisco — localizar le da contexto rápido del lead
// (ej: si llegó en EN, probablemente conviene contactarlo en EN).
const EMAIL_TEMPLATES = {
  es: {
    subject: (name, company) => `Nuevo lead: ${name} (${company})`,
    title: 'Nuevo lead en la waitlist de Agentina',
    labels: { name: 'Nombre', company: 'Empresa', email: 'Email', whatsapp: 'WhatsApp', linkedin: 'LinkedIn', locale: 'Idioma de captura', path: 'Path', date: 'Fecha' },
    cta: 'Ver en el admin',
  },
  en: {
    subject: (name, company) => `New lead: ${name} (${company})`,
    title: 'New lead on the Agentina waitlist',
    labels: { name: 'Name', company: 'Company', email: 'Email', whatsapp: 'WhatsApp', linkedin: 'LinkedIn', locale: 'Capture language', path: 'Path', date: 'Date' },
    cta: 'View in admin',
  },
  pt: {
    subject: (name, company) => `Novo lead: ${name} (${company})`,
    title: 'Novo lead na waitlist da Agentina',
    labels: { name: 'Nome', company: 'Empresa', email: 'Email', whatsapp: 'WhatsApp', linkedin: 'LinkedIn', locale: 'Idioma de captura', path: 'Path', date: 'Data' },
    cta: 'Ver no admin',
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
  // CORS — el sitio sirve desde el mismo dominio, pero por si se llama desde otro contexto
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Rate limit por IP
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'rate_limited', message: 'Demasiadas solicitudes. Esperá unos segundos.' });
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

  const errors = {};
  if (!fullName || fullName.length < 2) errors.full_name = 'Nombre requerido (mínimo 2 caracteres)';
  if (!company || company.length < 2) errors.company = 'Empresa requerida';
  if (!isValidEmail(email)) errors.email = 'Email inválido';
  if (!isValidWhatsapp(whatsapp)) errors.whatsapp = 'WhatsApp inválido — incluí código de país (ej: +5491165432100)';
  if (linkedin && !isValidLinkedinUrl(linkedin)) errors.linkedin_url = 'URL de LinkedIn inválida';

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ error: 'validation_failed', fields: errors });
  }

  // Insert en Supabase
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('[waitlist] Missing Supabase env vars');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const userAgent = req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 500) : null;

  const { data: lead, error: insertError } = await supabase
    .from('ag_leads')
    .insert({
      full_name: fullName,
      linkedin_url: normalizeLinkedinUrl(linkedin),
      company,
      email,
      whatsapp: normalizeWhatsapp(whatsapp),
      captured_locale: locale,
      source_path: sourcePath,
      user_agent: userAgent,
      ip_address: ip !== 'unknown' ? ip : null,
    })
    .select()
    .single();

  if (insertError) {
    console.error('[waitlist] Insert error:', insertError);
    // Detectar email duplicado (no devolver 500, devolver mensaje amable)
    if (insertError.code === '23505') {
      return res.status(409).json({ error: 'duplicate', message: 'Ya estás en la waitlist. Te avisamos cuando abramos.' });
    }
    return res.status(500).json({ error: 'insert_failed' });
  }

  // Notificación por email (no bloqueante — si falla el email, igual respondemos OK al usuario)
  // Localizado por captured_locale para que el subject/labels coincidan con el idioma
  // del lead — útil para contexto rápido al decidir cómo contactarlo.
  const resendKey = process.env.RESEND_API_KEY;
  const notifyEmail = process.env.NOTIFICATION_EMAIL;
  if (resendKey && notifyEmail) {
    try {
      const resend = new Resend(resendKey);
      const adminUrl = `https://www.agentina.app/admin/#${lead.id}`;
      const t = EMAIL_TEMPLATES[locale] || EMAIL_TEMPLATES.es;
      const normalizedWa = normalizeWhatsapp(whatsapp);
      const normalizedLi = normalizeLinkedinUrl(linkedin);
      await resend.emails.send({
        from: 'Agentina <hola@agentina.app>',
        replyTo: notifyEmail,
        to: notifyEmail,
        subject: t.subject(fullName, company),
        html: `
<h2>${t.title}</h2>
<table cellpadding="6" style="border-collapse:collapse;font-family:system-ui,sans-serif">
<tr><td><strong>${t.labels.name}</strong></td><td>${escapeHtml(fullName)}</td></tr>
<tr><td><strong>${t.labels.company}</strong></td><td>${escapeHtml(company)}</td></tr>
<tr><td><strong>${t.labels.email}</strong></td><td><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>
<tr><td><strong>${t.labels.whatsapp}</strong></td><td><a href="https://wa.me/${normalizedWa.replace('+','')}">${escapeHtml(normalizedWa)}</a></td></tr>
${linkedin ? `<tr><td><strong>${t.labels.linkedin}</strong></td><td><a href="${escapeHtml(normalizedLi)}">${escapeHtml(normalizedLi)}</a></td></tr>` : ''}
<tr><td><strong>${t.labels.locale}</strong></td><td>${locale.toUpperCase()}</td></tr>
<tr><td><strong>${t.labels.path}</strong></td><td>${escapeHtml(sourcePath || '/')}</td></tr>
<tr><td><strong>${t.labels.date}</strong></td><td>${new Date(lead.created_at).toISOString()}</td></tr>
</table>
<p><a href="${adminUrl}">${t.cta}</a></p>
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
