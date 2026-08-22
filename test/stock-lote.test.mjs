// =============================================================================
// Prueba de marcar VARIOS tickets a la vez y de los precios en otra moneda.
//
// Lo que se comprueba, en orden de importancia:
//
//   - un precio en euros acaba apuntado en DÓLARES en el panel, y al lado queda
//     el rastro de cuánto se tecleó y con qué cambio;
//   - una moneda extranjera SIN cambio no se guarda: antes reventar que apuntar
//     300 euros como 300 dólares e inflar el beneficio de ese ticket;
//   - el lote es todo o nada: si un ticket del lote ya no existe, no se toca
//     ninguno (media compra vendida y media en stock es un lío de cuadrar);
//   - editar un ticket pagado en euros por lo normal (cambiar la fila, la
//     sección…) no le borra la moneda ni le mueve el importe;
//   - los tickets que ya estaban apuntados de antes quedan marcados como USD.
//
// Uso:  node test/stock-lote.test.mjs
// =============================================================================

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'test' + 'a'.repeat(28);
const PORT = 4196;   // apartado de los puertos que se usan a mano para mirar el panel
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FALLA ${name} ${extra}`); fails++; }
}

const tmp = mkdtempSync(join(tmpdir(), 'kemin-lote-'));
const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), PANEL_TOKEN: TOKEN,
         DB_PATH: join(tmp, 'test.db'), UPLOADS_DIR: join(tmp, 'uploads'), ANTHROPIC_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
srv.stdout.on('data', d => { log += d; });
srv.stderr.on('data', d => { log += d; });

let cookie = '';
async function api(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const txt = await r.text();
  let body = null;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, ok: r.ok, body };
}
const nuevoTicket = (extra = {}) =>
  api('/api/stock', { method: 'POST', body: JSON.stringify({ evento: 'Bad Bunny Madrid', price_retail: 100, ...extra }) });
const traer = async (id) => (await api('/api/stock')).body.find(x => x.id === id);

async function main() {
  // --- arranque + entrada
  for (let i = 0; i < 75; i++) {
    if (/EADDRINUSE/.test(log)) {
      console.log(`\n  El puerto ${PORT} ya está ocupado por otra cosa. La prueba se habría`);
      console.log(`  conectado a ESE panel en vez de al suyo y los fallos no querrían decir nada.`);
      throw new Error('puerto ' + PORT + ' ocupado');
    }
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  const puerta = await fetch(`${BASE}/k/${TOKEN}`, { redirect: 'manual' });
  cookie = (puerta.headers.get('set-cookie') || '').split(';')[0];
  check('el server de pruebas arranca y deja entrar', !!cookie, log.slice(-300));
  if (!cookie) throw new Error('sin entrar al panel, el resto de la prueba no significa nada');

  // ---------------------------------------------------------------------------
  console.log('\n1) Marcar varios como publicados, en dólares');
  const lote = [];
  for (let i = 0; i < 4; i++) lote.push((await nuevoTicket()).body.id);
  check('se crean los 4 tickets del lote', lote.every(Boolean));

  let r = await api('/api/stock/bulk-update', { method: 'POST', body: JSON.stringify({
    ids: lote, patch: { listed_amount_orig: 250, listed_currency: 'USD', listed_fx: 1 } }) });
  check('responde ok', r.ok && r.body.updated === 4, JSON.stringify(r.body));
  let t = await traer(lote[0]);
  check('el precio publicado queda en 250', t.listed_at === 250, `listed_at=${t.listed_at}`);
  check('el estado pasa solo a "listed"', t.status === 'listed', `status=${t.status}`);
  check('queda anotado que fue en dólares', t.listed_currency === 'USD' && t.listed_fx === 1);

  // ---------------------------------------------------------------------------
  console.log('\n2) Marcar varios como vendidos en EUROS');
  r = await api('/api/stock/bulk-update', { method: 'POST', body: JSON.stringify({
    ids: lote, patch: { sold_amount_orig: 300, sold_currency: 'EUR', sold_fx: 1.0842, sold_date: '2026-08-20' } }) });
  check('responde ok', r.ok && r.body.updated === 4, JSON.stringify(r.body));
  t = await traer(lote[0]);
  // 300 × 1.0842 = 325.26
  check('EL PUNTO CLAVE: se apunta en dólares (325.26), no 300', t.sold_at === 325.26, `sold_at=${t.sold_at}`);
  check('se guarda el importe tal cual se tecleó (300)', t.sold_amount_orig === 300, `orig=${t.sold_amount_orig}`);
  check('se guarda la moneda', t.sold_currency === 'EUR', `cur=${t.sold_currency}`);
  check('se guarda el cambio usado', t.sold_fx === 1.0842, `fx=${t.sold_fx}`);
  check('el estado pasa solo a "sold"', t.status === 'sold', `status=${t.status}`);
  check('se guarda la fecha de venta', t.sold_date === '2026-08-20', `fecha=${t.sold_date}`);
  check('los 4 quedan igual', (await Promise.all(lote.map(traer))).every(x => x.sold_at === 325.26));
  check('el beneficio sale de los dólares, no de los euros',
    Math.round((t.sold_at - t.price_retail) * 100) / 100 === 225.26);

  // ---------------------------------------------------------------------------
  console.log('\n3) Una moneda extranjera SIN cambio no entra (lo importante)');
  const solo = (await nuevoTicket()).body.id;
  r = await api('/api/stock/bulk-update', { method: 'POST', body: JSON.stringify({
    ids: [solo], patch: { sold_amount_orig: 300, sold_currency: 'EUR' } }) });
  check('lo rechaza', r.status === 400, `status=${r.status}`);
  check('dice claramente que falta el cambio', /cambio/i.test(r.body.error || ''), r.body.error);
  t = await traer(solo);
  check('y el ticket se queda sin tocar', t.sold_at === null && t.status === 'comprado', JSON.stringify(t.sold_at));

  r = await api('/api/stock/bulk-update', { method: 'POST', body: JSON.stringify({
    ids: [solo], patch: { sold_amount_orig: 300, sold_currency: 'EUR', sold_fx: 0 } }) });
  check('un cambio de 0 tampoco cuela', r.status === 400, `status=${r.status}`);
  r = await api('/api/stock/bulk-update', { method: 'POST', body: JSON.stringify({
    ids: [solo], patch: { sold_amount_orig: 300, sold_currency: 'BITCOIN', sold_fx: 2 } }) });
  check('una moneda que no existe tampoco', r.status === 400 && /no soportada/i.test(r.body.error || ''), r.body.error);

  // ---------------------------------------------------------------------------
  console.log('\n4) El lote es todo o nada');
  const a = (await nuevoTicket()).body.id;
  r = await api('/api/stock/bulk-update', { method: 'POST', body: JSON.stringify({
    ids: [a, 'id-que-no-existe'], patch: { listed_amount_orig: 99, listed_currency: 'USD', listed_fx: 1 } }) });
  check('si un ticket del lote no existe, falla', r.status === 400, `status=${r.status}`);
  check('avisa de que no ha tocado nada', /no se ha tocado nada/i.test(r.body.error || ''), r.body.error);
  check('y de verdad no ha tocado el que sí existía', (await traer(a)).listed_at === null);

  r = await api('/api/stock/bulk-update', { method: 'POST', body: JSON.stringify({ ids: [], patch: { listed_at: 1 } }) });
  check('sin tickets seleccionados avisa en vez de tragar', r.status === 400, `status=${r.status}`);
  r = await api('/api/stock/bulk-update', { method: 'POST', body: JSON.stringify({ ids: [a] }) });
  check('sin decir qué cambiar, avisa', r.status === 400, `status=${r.status}`);
  r = await api('/api/stock/bulk-update', { method: 'POST', body: JSON.stringify({
    ids: Array.from({ length: 501 }, (_, i) => 'x' + i), patch: { listed_at: 1 } }) });
  check('un lote absurdo (501) se corta', r.status === 400 && /máximo/i.test(r.body.error || ''), r.body.error);

  // ---------------------------------------------------------------------------
  console.log('\n5) Editar por lo normal un ticket vendido en euros');
  t = await traer(lote[0]);
  // Esto es lo que manda el formulario de editar: todos los campos de golpe.
  r = await api('/api/stock/' + lote[0], { method: 'PATCH', body: JSON.stringify({
    evento: t.evento, seccion: 'Pista B', price_retail: 100,
    sold_amount_orig: 300, sold_currency: 'EUR', sold_fx: 1.0842 }) });
  check('guarda', r.ok, JSON.stringify(r.body));
  t = await traer(lote[0]);
  check('cambiar la sección NO mueve el importe en dólares', t.sold_at === 325.26, `sold_at=${t.sold_at}`);
  check('cambiar la sección NO borra la moneda', t.sold_currency === 'EUR', `cur=${t.sold_currency}`);
  check('la sección sí cambia', t.seccion === 'Pista B', t.seccion);

  // Si se toca solo el importe en dólares (sin hablar de monedas), es un importe
  // en dólares y punto: no se puede volver a multiplicar por el cambio viejo.
  r = await api('/api/stock/' + lote[1], { method: 'PATCH', body: JSON.stringify({ sold_at: 400 }) });
  t = await traer(lote[1]);
  check('poner 400 dólares a pelo deja 400, no 300×1.0842', t.sold_at === 400, `sold_at=${t.sold_at}`);
  check('y pasa a estar en dólares', t.sold_currency === 'USD' && t.sold_fx === 1, `cur=${t.sold_currency}`);

  // ---------------------------------------------------------------------------
  console.log('\n6) Un ticket dado de alta a la antigua queda marcado como USD');
  const viejo = (await nuevoTicket({ listed_at: 180 })).body.id;
  t = await traer(viejo);
  check('el importe se respeta', t.listed_at === 180, `listed_at=${t.listed_at}`);
  check('y se le pone moneda dólar', t.listed_currency === 'USD' && t.listed_fx === 1, `cur=${t.listed_currency}`);

  // ---------------------------------------------------------------------------
  console.log('\n7) Borrar varios de golpe');
  const paraBorrar = [];
  for (let i = 0; i < 3; i++) paraBorrar.push((await nuevoTicket()).body.id);
  const antes = (await api('/api/stock')).body.length;
  r = await api('/api/stock/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: paraBorrar }) });
  check('borra los 3', r.ok && r.body.deleted === 3, JSON.stringify(r.body));
  check('y solo esos 3', (await api('/api/stock')).body.length === antes - 3);
  r = await api('/api/stock/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [] }) });
  check('sin selección avisa en vez de borrar', r.status === 400, `status=${r.status}`);

  // ---------------------------------------------------------------------------
  console.log('\n8) El cambio de moneda que trae el panel');
  r = await api('/api/fx?from=USD');
  check('dólar contra dólar es 1', r.ok && r.body.rate === 1, JSON.stringify(r.body));
  r = await api('/api/fx?from=PESETAS');
  check('una moneda inventada se rechaza', r.status === 400, `status=${r.status}`);
  // La ruta con barra es la que usa el lector de capturas desde antes. Las dos
  // comparten código: si se toca una, la otra tiene que seguir contestando igual.
  const rutaOcr = await api('/api/fx/USD');
  check('la ruta /api/fx/USD del lector de capturas sigue viva', rutaOcr.ok && rutaOcr.body.rate === 1, JSON.stringify(rutaOcr.body));
  r = await api('/api/fx?from=EUR');
  if (r.ok) {
    check('trae el cambio EUR→USD', r.body.rate > 0.5 && r.body.rate < 2, JSON.stringify(r.body));
    check('dice de qué día es', /^\d{4}-\d{2}-\d{2}$/.test(r.body.date || ''), r.body.date);
    const r2 = await api('/api/fx?from=EUR');
    check('la segunda vez sale de la caché', r2.body.cached === true, JSON.stringify(r2.body));
    const r3 = await api('/api/fx/EUR');
    check('las dos rutas dan el mismo cambio', r3.ok && r3.body.rate === r.body.rate, JSON.stringify(r3.body));
    const r4 = await api('/api/fx?from=EUR&date=2026-08-14');
    check('se puede pedir el cambio de otro día', r4.ok && r4.body.rate > 0 && r4.body.date <= '2026-08-14', JSON.stringify(r4.body));
  } else {
    check('sin internet responde 503 con un aviso claro (no un cambio inventado)',
      r.status === 503 && !!r.body.error && r.body.rate === undefined, JSON.stringify(r.body));
    console.log('       (esta máquina no llega a frankfurter.app — se ha probado el camino del fallo)');
  }

  // ---------------------------------------------------------------------------
  console.log('\n9) La página lleva las casillas de selección');
  const html = await (await fetch(BASE + '/', { headers: { cookie } })).text();
  check('hay casilla en cada fila', html.includes('class="stock-check"'));
  check('hay casilla de "todos"', html.includes('id="stock-check-all"'));
  check('está la barra de acciones', html.includes('id="stock-bulk-bar"'));
  check('está el modal de marcar', html.includes('id="bulk-form"'));
  check('el selector de moneda ofrece euros', html.includes('value="EUR"'));
  const cabeceras = (html.match(/<th[ >]/g) || []).length;
  check('la cabecera de la tabla no se ha descuadrado', cabeceras > 0 && html.includes('col-check'));
}

main()
  .catch(e => { console.error('\nEXPLOTÓ:', e); fails++; })
  .finally(() => {
    try { srv.kill(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
    console.log(fails === 0 ? '\nTODO OK ✅' : `\n${fails} FALLO(S) ❌`);
    process.exit(fails === 0 ? 0 : 1);
  });
