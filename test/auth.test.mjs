// =============================================================================
// Prueba de la puerta de entrada del panel (enlace secreto + cookie).
//
// Arranca el server en un puerto y una DB de usar y tirar, y comprueba que:
//   - sin cookie no se ve NADA (ni el panel ni la API), y responde 404 para no
//     anunciar que aquí hay un panel;
//   - el enlace /k/<token> con el token bueno deja la cookie y redirige a /;
//   - un token equivocado no deja entrar;
//   - con la cookie puesta el panel carga;
//   - /api/health y /manifest.json siguen abiertos (los necesita el monitor y la
//     instalación como app en el móvil);
//   - el usuario/contraseña de antes (auth básica) ya NO abre nada;
//   - sin PANEL_TOKEN en el .env el server se niega a arrancar (fail-closed:
//     antes que quedarse abierto de par en par, no arranca).
//
// Uso:  node test/auth.test.mjs
// =============================================================================

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'test' + 'a'.repeat(28);
const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;

let fails = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { console.log(`  FALLA ${name} ${extra}`); fails++; }
}

function startServer(env) {
  const tmp = mkdtempSync(join(tmpdir(), 'kemin-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: join(tmp, 'test.db'),
      UPLOADS_DIR: join(tmp, 'uploads'),
      ANTHROPIC_API_KEY: '',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  return { child, tmp, log: () => out };
}

async function waitUp(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  // ---------------------------------------------------------------------------
  console.log('\n1) Sin PANEL_TOKEN el server NO debe arrancar');
  {
    const srv = startServer({ PANEL_TOKEN: '' });
    const code = await new Promise(res => {
      const t = setTimeout(() => res('sigue vivo'), 8000);
      srv.child.on('exit', c => { clearTimeout(t); res(c); });
      srv.child.on('error', () => { clearTimeout(t); res(-1); });
    });
    check('sale con error en vez de quedarse abierto', code !== 0 && code !== 'sigue vivo', `code=${code}`);
    check('explica qué hay que poner en el .env', /PANEL_TOKEN/.test(srv.log()), srv.log().slice(0, 200));
    try { srv.child.kill(); } catch {}
    rmSync(srv.tmp, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------
  console.log('\n2) Con PANEL_TOKEN — puerta de entrada');
  const srv = startServer({ PANEL_TOKEN: TOKEN });
  try {
    check('el server arranca', await waitUp(), srv.log().slice(-400));

    // --- sin cookie: nada de nada
    const anon = await fetch(`${BASE}/`, { redirect: 'manual' });
    check('sin cookie el panel responde 404', anon.status === 404, `status=${anon.status}`);
    const anonBody = await anon.text();
    check('sin cookie no se filtra el panel', !anonBody.includes('Tesorería'), anonBody.slice(0, 120));
    check('sin cookie no llega ninguna cookie', !anon.headers.get('set-cookie'));

    const anonApi = await fetch(`${BASE}/api/stock`);
    check('sin cookie la API responde 404', anonApi.status === 404, `status=${anonApi.status}`);

    const anonUp = await fetch(`${BASE}/uploads/2026-05/x.jpg`);
    check('sin cookie las capturas responden 404', anonUp.status === 404, `status=${anonUp.status}`);

    // --- el usuario/contraseña de antes ya no vale
    const basic = await fetch(`${BASE}/`, {
      headers: { authorization: 'Basic ' + Buffer.from('fer:cualquiera').toString('base64') }
    });
    check('usuario/contraseña ya no abre el panel', basic.status === 404, `status=${basic.status}`);

    // --- token equivocado
    const bad = await fetch(`${BASE}/k/${'b'.repeat(32)}`, { redirect: 'manual' });
    check('un enlace con token equivocado no entra', bad.status === 404, `status=${bad.status}`);
    check('un enlace equivocado no deja cookie', !bad.headers.get('set-cookie'));

    // --- token bueno
    const good = await fetch(`${BASE}/k/${TOKEN}`, { redirect: 'manual' });
    check('el enlace bueno redirige al panel', good.status === 302 && good.headers.get('location') === '/',
      `status=${good.status} loc=${good.headers.get('location')}`);
    const setCookie = good.headers.get('set-cookie') || '';
    check('el enlace bueno deja la cookie', setCookie.includes('kemin_auth='), setCookie);
    check('la cookie no es legible por scripts (HttpOnly)', /HttpOnly/i.test(setCookie), setCookie);
    check('la cookie dura ~1 año', /Max-Age=3[0-9]{7}/.test(setCookie), setCookie);
    check('la cookie es SameSite=Lax', /SameSite=Lax/i.test(setCookie), setCookie);
    check('el token NO viaja en la redirección', !(good.headers.get('location') || '').includes(TOKEN));

    // --- ya con la cookie
    const cookie = setCookie.split(';')[0];
    const ok = await fetch(`${BASE}/`, { headers: { cookie } });
    const okBody = await ok.text();
    check('con la cookie el panel carga', ok.status === 200, `status=${ok.status}`);
    check('con la cookie se ve el panel de verdad', okBody.includes('Tesorería'));
    check('ya no aparece "sesión activa" de usuario', !okBody.includes('sesión activa'));

    const okApi = await fetch(`${BASE}/api/stock`, { headers: { cookie } });
    check('con la cookie la API responde', okApi.status === 200, `status=${okApi.status}`);

    // --- cookie manipulada
    const tampered = await fetch(`${BASE}/`, { headers: { cookie: 'kemin_auth=' + 'c'.repeat(32) } });
    check('una cookie inventada no entra', tampered.status === 404, `status=${tampered.status}`);

    // --- lo que debe seguir abierto
    const health = await fetch(`${BASE}/api/health`);
    check('/api/health sigue abierto', health.status === 200, `status=${health.status}`);
    const manifest = await fetch(`${BASE}/manifest.json`);
    check('/manifest.json sigue abierto (instalar como app)', manifest.status === 200, `status=${manifest.status}`);

    // --- detrás de HTTPS la cookie debe ir marcada Secure
    const behindTls = await fetch(`${BASE}/k/${TOKEN}`, {
      redirect: 'manual', headers: { 'x-forwarded-proto': 'https' }
    });
    check('detrás de HTTPS la cookie va marcada Secure',
      /Secure/i.test(behindTls.headers.get('set-cookie') || ''), behindTls.headers.get('set-cookie'));
  } finally {
    try { srv.child.kill(); } catch {}
    rmSync(srv.tmp, { recursive: true, force: true });
  }

  console.log(fails === 0 ? '\nTODO OK\n' : `\n${fails} FALLOS\n`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
