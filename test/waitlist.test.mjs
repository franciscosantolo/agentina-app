// Prueba de /api/waitlist con fetch interceptado: a qué base y a qué función va
// cada pedido, con qué clave, y qué se rechaza sin llegar a ninguna base.
import assert from 'node:assert/strict';
process.env.AGENTINA_SUPABASE_URL = 'https://agentina.example.supabase.co';
process.env.AGENTINA_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_agentina';
process.env.MESSENGER_SUPABASE_URL = 'https://messenger.example.supabase.co';
process.env.MESSENGER_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_messenger';
delete process.env.RESEND_API_KEY;
const llamadas = [];
globalThis.fetch = async (url, init) => {
  llamadas.push({ url: String(url), body: JSON.parse(init.body || '{}'), apikey: init.headers?.apikey ?? new Headers(init.headers).get('apikey') });
  return new Response(JSON.stringify({ ok: true, id: '00000000-0000-4000-8000-000000000001' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const { default: handler } = await import('../api/waitlist.js');
let ip = 0;
async function pedir(body) {
  const res = { code: 0, json: null, headers: {}, status(c) { this.code = c; return this; }, json(j) { this.json = j; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end() { return this; } };
  await handler({ method: 'POST', headers: { 'x-forwarded-for': `10.0.0.${++ip}` }, body, socket: {} }, res);
  return res;
}
const base = { full_name: 'Ana Pérez', company: 'Acme', email: 'ana@acme.com', whatsapp: '+5491165432100', captured_locale: 'es' };
let ok = 0; const t = async (n, f) => { llamadas.length = 0; await f(); ok++; console.log('ok ·', n); };

await t('desde la home va a la base de agentina', async () => {
  const r = await pedir({ ...base, source_path: '/' });
  assert.equal(r.code, 200, JSON.stringify(r.json));
  assert.equal(llamadas.length, 1);
  assert.match(llamadas[0].url, /^https:\/\/agentina\.example\.supabase\.co\/rest\/v1\/rpc\/ag_waitlist_anotar/);
  assert.equal(llamadas[0].apikey, 'sb_publishable_agentina');
  assert.equal(llamadas[0].body.p_email, 'ana@acme.com');
  assert.equal('p_plataformas' in llamadas[0].body, false);
});
await t('desde /messenger va a la base de Messenger con agentes y plataformas', async () => {
  const r = await pedir({ ...base, source_path: '/messenger/', cantidad_agentes: '6-20', plataformas: ['codex', 'antigravity', 'codex'] });
  assert.equal(r.code, 200, JSON.stringify(r.json));
  assert.match(llamadas[0].url, /^https:\/\/messenger\.example\.supabase\.co\/rest\/v1\/rpc\/anotar_lista_espera/);
  assert.equal(llamadas[0].apikey, 'sb_publishable_messenger');
  assert.equal(llamadas[0].body.p_cantidad_agentes, '6-20');
  assert.deepEqual(llamadas[0].body.p_plataformas, ['codex', 'antigravity']);
});
await t('en Messenger, sin agentes o sin plataformas no llega a la base', async () => {
  for (const extra of [{ plataformas: ['codex'] }, { cantidad_agentes: '6-20', plataformas: [] }, { cantidad_agentes: '7', plataformas: ['codex'] }, { cantidad_agentes: '1', plataformas: ['chatgpt'] }, { cantidad_agentes: '1', plataformas: ['gemini'] }]) {
    const r = await pedir({ ...base, source_path: '/messenger/', ...extra });
    assert.equal(r.code, 400, JSON.stringify(extra));
  }
  assert.equal(llamadas.length, 0);
});
await t('si la base frena, la persona ve 429', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'demasiados_pedidos' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const r = await pedir({ ...base, source_path: '/' });
  assert.equal(r.code, 429);
});
await t('/messengerX no es Messenger, y no hay CORS abierto', async () => {
  globalThis.fetch = async (url, init) => { llamadas.push({ url: String(url) }); return new Response(JSON.stringify({ ok: true, id: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  const r = await pedir({ ...base, source_path: '/messengerX' });
  assert.equal(r.code, 200);
  assert.match(llamadas[0].url, /agentina\.example/);
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  const r2 = await pedir({ ...base, source_path: '/messenger?utm=x', cantidad_agentes: '1', plataformas: ['codex'] });
  assert.match(llamadas[1].url, /messenger\.example/, 'con query sigue siendo Messenger');
});
console.log(`${ok} de 5 en verde`);
