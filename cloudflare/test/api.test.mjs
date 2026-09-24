// Prueba de punta a punta: levanta el Worker con `wrangler dev` sobre una D1 local temporal.
// Uso: npm test   (no requiere cuenta de Cloudflare)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WRANGLER_SEND_METRICS = 'false';
const PUERTO = 8799, BASE = `http://127.0.0.1:${PUERTO}`;
const estado = mkdtempSync(join(tmpdir(), 'd1-prueba-'));
const w = (...a) => execFileSync('npx', ['wrangler', ...a, '--persist-to', estado], { stdio: 'pipe' });
let servidor;

before(async () => {
  execFileSync('node', ['scripts/build.mjs']);
  w('d1', 'migrations', 'apply', 'correspondencia', '--local');
  const sql = (u, n, rol) => {
    // mismo algoritmo que scripts/crear-usuario.mjs
    return execFileSync('node', ['-e', `
      const c=require('crypto');const s=c.randomBytes(16).toString('hex');
      const h=c.pbkdf2Sync('clave-segura-123',Buffer.from(s,'hex'),100000,32,'sha256').toString('hex');
      process.stdout.write("INSERT INTO usuarios(usuario,nombre,hash,sal,rol) VALUES('${u}','${n}','"+h+"','"+s+"','${rol}')")`]).toString();
  };
  w('d1', 'execute', 'correspondencia', '--local', '--command', sql('admin', 'ADMIN PRUEBA', 'admin'));
  w('d1', 'execute', 'correspondencia', '--local', '--command', sql('ana', 'ANA PRUEBA', 'funcionario'));
  servidor = spawn('npx', ['wrangler', 'dev', '--port', String(PUERTO), '--ip', '127.0.0.1', '--persist-to', estado], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/'); return; } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error('wrangler dev no arrancó');
});
after(() => { try { process.kill(-servidor.pid); } catch {} rmSync(estado, { recursive: true, force: true }); });

async function pedir(ruta, { metodo = 'GET', cuerpo, cookie, headers = {} } = {}) {
  const r = await fetch(BASE + ruta, {
    method: metodo, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: cuerpo && JSON.stringify(cuerpo),
  });
  let datos = null; try { datos = await r.json(); } catch {}
  return { status: r.status, datos, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const entrar = async (usuario, clave = 'clave-segura-123') => (await pedir('/api/login', { metodo: 'POST', cuerpo: { usuario, clave } })).cookie;

test('la interfaz es pública pero la API exige sesión', async () => {
  assert.equal((await fetch(BASE + '/')).status, 200);
  assert.equal((await pedir('/api/registros')).status, 401);
  assert.equal((await fetch(BASE + '/data.js')).status === 200 && (await (await fetch(BASE + '/data.js')).text()).includes('window.DATA'), false);
});

test('login correcto e incorrecto', async () => {
  const mal = await pedir('/api/login', { metodo: 'POST', cuerpo: { usuario: 'ana', clave: 'x' } });
  assert.equal(mal.status, 401);
  const c = await entrar('ana');
  assert.match(c, /^sid=[0-9a-f]{64}$/);
  const yo = await pedir('/api/yo', { cookie: c });
  assert.deepEqual(yo.datos, { usuario: 'ana', nombre: 'ANA PRUEBA', rol: 'funcionario' });
});

test('crear asigna correlativo por año y registra historial con el usuario de la sesión', async () => {
  const c = await entrar('ana');
  const base = { proc_: 'municipalidad de viña', materia: 'Traslado KJPB54', ppu: 'kjpb54' };
  const a = await pedir('/api/registros', { metodo: 'POST', cookie: c, cuerpo: { ...base, fecha: '2026-03-01' }, headers: { 'X-Usuario': 'SUPLANTADOR' } });
  const b = await pedir('/api/registros', { metodo: 'POST', cookie: c, cuerpo: { ...base, fecha: '2026-03-02' } });
  const x = await pedir('/api/registros', { metodo: 'POST', cookie: c, cuerpo: { ...base, fecha: '2025-12-30' } });
  assert.equal(a.status, 201);
  assert.deepEqual([a.datos.n, b.datos.n, x.datos.n], ['1', '2', '1']);
  assert.equal(a.datos.hoja, '2026');
  assert.equal(a.datos.creado_por, 'ANA PRUEBA');
  assert.equal(a.datos.proc_, 'MUNICIPALIDAD DE VIÑA');
  const h = await pedir('/api/historial/' + a.datos.id, { cookie: c });
  assert.equal(h.datos[0].campo, 'CREADO');
  assert.equal(h.datos[0].usuario, 'ANA PRUEBA');
});

test('validación de entrada', async () => {
  const c = await entrar('ana');
  assert.equal((await pedir('/api/registros', { metodo: 'POST', cookie: c, cuerpo: { fecha: '01-01-2026', proc_: 'x', materia: 'y' } })).status, 400);
  assert.equal((await pedir('/api/registros', { metodo: 'POST', cookie: c, cuerpo: { fecha: '2026-01-01' } })).status, 400);
  const r = await fetch(BASE + '/api/registros', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c }, body: '{roto' });
  assert.equal(r.status, 400);
});

test('edición con historial y conflicto 409 por edición concurrente', async () => {
  const c = await entrar('ana');
  const r = (await pedir('/api/registros', { metodo: 'POST', cookie: c, cuerpo: { fecha: '2026-04-01', proc_: 'A', materia: 'M' } })).datos;
  const e1 = await pedir('/api/registros/' + r.id, { metodo: 'PUT', cookie: c, cuerpo: { procedimiento: 'Respondido', version: r.actualizado } });
  assert.equal(e1.status, 200);
  assert.equal(e1.datos.procedimiento, 'Respondido');
  const e2 = await pedir('/api/registros/' + r.id, { metodo: 'PUT', cookie: c, cuerpo: { procedimiento: 'Otra cosa', version: r.actualizado } });
  assert.equal(e2.status, 409);
  assert.equal(e2.datos.registro.procedimiento, 'Respondido');
  const h = (await pedir('/api/historial/' + r.id, { cookie: c })).datos;
  assert.ok(h.some(x => x.campo === 'procedimiento' && x.antes === '' && x.despues === 'Respondido'));
  assert.ok(!h.some(x => x.despues === 'Otra cosa'));
});

test('sincronización incremental', async () => {
  const c = await entrar('ana');
  const todo = await pedir('/api/registros?desde=-1', { cookie: c });
  assert.ok(todo.datos.filas.length >= 4);
  const nada = await pedir('/api/registros?desde=' + (Date.now() / 1000 + 60), { cookie: c });
  assert.equal(nada.datos.filas.length, 0);
});

test('solo el administrador gestiona usuarios', async () => {
  const ana = await entrar('ana');
  assert.equal((await pedir('/api/usuarios', { cookie: ana })).status, 403);
  const adm = await entrar('admin');
  const nuevo = await pedir('/api/usuarios', { metodo: 'POST', cookie: adm, cuerpo: { usuario: 'pedro', nombre: 'Pedro Prueba', clave: 'otra-clave-456' } });
  assert.equal(nuevo.status, 201);
  assert.ok(await entrar('pedro', 'otra-clave-456'));
  assert.equal((await pedir('/api/usuarios', { metodo: 'POST', cookie: adm, cuerpo: { usuario: 'corta', nombre: 'X', clave: '123' } })).status, 400);
  // desactivar corta la sesión existente
  const sesPedro = await entrar('pedro', 'otra-clave-456');
  await pedir('/api/usuarios', { metodo: 'POST', cookie: adm, cuerpo: { usuario: 'pedro', nombre: 'Pedro Prueba', activo: false } });
  assert.equal((await pedir('/api/yo', { cookie: sesPedro })).status, 401);
});

test('cambio de contraseña y cierre de sesión', async () => {
  const c = await entrar('ana');
  assert.equal((await pedir('/api/clave', { metodo: 'POST', cookie: c, cuerpo: { actual: 'mala', nueva: 'nueva-clave-789' } })).status, 403);
  assert.equal((await pedir('/api/clave', { metodo: 'POST', cookie: c, cuerpo: { actual: 'clave-segura-123', nueva: 'nueva-clave-789' } })).status, 200);
  assert.ok(await entrar('ana', 'nueva-clave-789'));
  await pedir('/api/logout', { metodo: 'POST', cookie: c });
  assert.equal((await pedir('/api/yo', { cookie: c })).status, 401);
});

test('escrituras desde otro origen se rechazan (CSRF)', async () => {
  const c = await entrar('admin');
  const r = await pedir('/api/registros', { metodo: 'POST', cookie: c, headers: { Origin: 'https://malicioso.example' }, cuerpo: { fecha: '2026-01-01', proc_: 'x', materia: 'y' } });
  assert.equal(r.status, 403);
});

test('bloqueo tras 5 intentos fallidos', async () => {
  for (let i = 0; i < 5; i++) await pedir('/api/login', { metodo: 'POST', cuerpo: { usuario: 'admin', clave: 'mala' } });
  const r = await pedir('/api/login', { metodo: 'POST', cuerpo: { usuario: 'admin', clave: 'clave-segura-123' } });
  assert.equal(r.status, 429);
});
