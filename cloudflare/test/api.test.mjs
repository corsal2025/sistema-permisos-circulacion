// Prueba de punta a punta de la API. Los mismos casos validan los dos servidores:
//   npm test               -> Worker de Cloudflare con `wrangler dev` y una D1 local temporal (sin cuenta)
//   npm run test:dotnet    -> servidor .exe (servidor/Program.cs) con una carpeta de datos temporal
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.WRANGLER_SEND_METRICS = 'false';
const DOTNET = process.env.SERVIDOR === 'dotnet';
const PUERTO = DOTNET ? 8797 : 8799, BASE = `http://127.0.0.1:${PUERTO}`;
const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const estado = mkdtempSync(join(tmpdir(), 'correspondencia-prueba-'));
const CLAVE = 'clave-segura-123';
let servidor;

function prepararWorker() {
  const w = (...a) => execFileSync('npx', ['wrangler', ...a, '--persist-to', estado], { stdio: 'pipe' });
  execFileSync('node', ['scripts/build.mjs']);
  w('d1', 'migrations', 'apply', 'correspondencia', '--local');
  const sql = (u, n, rol) => execFileSync('node', ['-e', `
    const c=require('crypto');const s=c.randomBytes(16).toString('hex');
    const h=c.pbkdf2Sync('${CLAVE}',Buffer.from(s,'hex'),100000,32,'sha256').toString('hex');
    process.stdout.write("INSERT INTO usuarios(usuario,nombre,hash,sal,rol) VALUES('${u}','${n}','"+h+"','"+s+"','${rol}')")`]).toString();
  w('d1', 'execute', 'correspondencia', '--local', '--command', sql('admin', 'ADMIN PRUEBA', 'admin'));
  w('d1', 'execute', 'correspondencia', '--local', '--command', sql('ana', 'ANA PRUEBA', 'funcionario'));
  return spawn('npx', ['wrangler', 'dev', '--port', String(PUERTO), '--ip', '127.0.0.1', '--persist-to', estado], { stdio: 'ignore', detached: true });
}

function prepararDotnet() {
  const salida = join(estado, 'bin');
  execFileSync('dotnet', ['build', join(RAIZ, 'servidor/Servidor.csproj'), '-c', 'Release', '-o', salida], { stdio: 'pipe' });
  mkdirSync(join(salida, 'web'));
  copyFileSync(join(RAIZ, 'dashboard/index.html'), join(salida, 'web/index.html'));
  cpSync(join(RAIZ, 'dashboard/vendor'), join(salida, 'web/vendor'), { recursive: true });
  const datos = join(estado, 'datos');
  const exe = (...a) => execFileSync('dotnet', [join(salida, 'CorrespondenciaPC.dll'), '--datos', datos, ...a], { stdio: 'pipe', env: { ...process.env, CLAVE } });
  exe('--crear-usuario', 'admin', 'Admin Prueba', 'admin');
  exe('--crear-usuario', 'ana', 'Ana Prueba', 'funcionario');
  return spawn('dotnet', [join(salida, 'CorrespondenciaPC.dll'), '--datos', datos, '--puerto', String(PUERTO), '--sin-navegador'], { stdio: 'ignore', detached: true });
}

before(async () => {
  servidor = DOTNET ? prepararDotnet() : prepararWorker();
  for (let i = 0; i < 90; i++) {
    try { await fetch(BASE + '/'); return; } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error('el servidor no arrancó');
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
const entrar = async (usuario, clave = CLAVE) => (await pedir('/api/login', { metodo: 'POST', cuerpo: { usuario, clave } })).cookie;

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

test('rechaza marcado HTML en patente, tipo y destinatario (XSS almacenado)', async () => {
  const c = await entrar('ana');
  const base = { fecha: '2026-06-01', proc_: 'A', materia: 'M' };
  const crear = extra => pedir('/api/registros', { metodo: 'POST', cookie: c, cuerpo: { ...base, ...extra } });
  assert.equal((await crear({ ppu: '<SVG/ONLOAD=&#97;lert(1)>' })).status, 400);
  assert.equal((await crear({ tipo: '<img src=x>' })).status, 400);
  assert.equal((await crear({ dest: 'A"B' })).status, 400);
  const ok = await crear({ ppu: 'kjpb54 ab1234', tipo: 'PAGO / FONDOS', dest: 'ROSA PEREZ' });
  assert.equal(ok.status, 201);
  assert.equal(ok.datos.ppu, 'KJPB54 AB1234');
  const mal = await pedir('/api/registros/' + ok.datos.id, { metodo: 'PUT', cookie: c, cuerpo: { ppu: '<b>', version: ok.datos.actualizado } });
  assert.equal(mal.status, 400);
});

test('editar exige la versión del registro', async () => {
  const c = await entrar('ana');
  const r = (await pedir('/api/registros', { metodo: 'POST', cookie: c, cuerpo: { fecha: '2026-06-02', proc_: 'A', materia: 'M' } })).datos;
  assert.equal((await pedir('/api/registros/' + r.id, { metodo: 'PUT', cookie: c, cuerpo: { procedimiento: 'x' } })).status, 400);
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

test('rutas desconocidas de la API responden 404 en JSON', async () => {
  const c = await entrar('ana', 'nueva-clave-789'); // contraseña cambiada en la prueba anterior
  const r = await pedir('/api/no-existe', { cookie: c });
  assert.equal(r.status, 404);
  assert.ok(r.datos.error);
});

test('cabeceras de seguridad en la interfaz', async () => {
  const r = await fetch(BASE + '/');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
});

test('adjuntos: subir, listar, descargar aislado, rechazar tipos peligrosos y permisos para quitar', async () => {
  const c = await entrar('ana', 'nueva-clave-789');
  const reg = (await pedir('/api/registros', { metodo: 'POST', cookie: c, cuerpo: { fecha: '2026-05-05', proc_: 'SII', materia: 'Oficio con adjunto' } })).datos;
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  const subir = (cuerpo, tipo, nombre, cookie = c) => fetch(`${BASE}/api/registros/${reg.id}/adjuntos`, {
    method: 'POST', headers: { 'Content-Type': tipo, 'X-Nombre': encodeURIComponent(nombre), Cookie: cookie }, body: cuerpo });

  const r = await subir(pdf, 'application/pdf', 'ORD 455 Quilpué.pdf');
  assert.equal(r.status, 201);
  const a = await r.json();
  assert.equal(a.nombre, 'ORD 455 Quilpué.pdf');
  assert.equal(a.tipo, 'application/pdf');
  assert.equal(a.tamano, pdf.length);

  // un ejecutable disfrazado de PDF se rechaza por su firma
  assert.equal((await subir(Buffer.from('MZ\x90\x00 programa'), 'application/pdf', 'virus.pdf')).status, 415);
  // un HTML no es un tipo permitido
  assert.equal((await subir(Buffer.from('<script>alert(1)</script>'), 'text/html', 'x.html')).status, 415);
  // un OLE con tipo declarado arbitrario se degrada a octet-stream (se baja como archivo, nunca se interpreta)
  const ole = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0, 0, 0, 0]);
  assert.equal((await (await subir(ole, 'application/xhtml+xml', 'x.doc')).json()).tipo, 'application/octet-stream');
  assert.equal((await (await subir(ole, 'application/msword', 'x.doc')).json()).tipo, 'application/msword');
  // los nombres con rutas se limpian
  const b = await (await subir(pdf, 'application/pdf', '../../etc/passwd.pdf')).json();
  assert.ok(!b.nombre.includes('/'));

  const lista = await pedir(`/api/registros/${reg.id}/adjuntos`, { cookie: c });
  assert.equal(lista.datos.length, 4);

  const d = await fetch(`${BASE}/api/adjuntos/${a.id}`, { headers: { Cookie: c } });
  assert.equal(d.status, 200);
  assert.equal(d.headers.get('content-type'), 'application/pdf');
  assert.match(d.headers.get('content-security-policy'), /sandbox/);
  assert.match(d.headers.get('content-disposition'), /inline/);
  assert.deepEqual(Buffer.from(await d.arrayBuffer()), pdf);
  assert.equal((await fetch(`${BASE}/api/adjuntos/${a.id}`)).status, 401);

  const h = (await pedir('/api/historial/' + reg.id, { cookie: c })).datos;
  assert.ok(h.some(x => x.campo === 'ADJUNTO' && x.despues === 'ORD 455 Quilpué.pdf'));

  const del = await fetch(`${BASE}/api/adjuntos/${a.id}`, { method: 'DELETE', headers: { Cookie: c } });
  assert.equal(del.status, 200);
  assert.equal((await fetch(`${BASE}/api/adjuntos/${a.id}`, { headers: { Cookie: c } })).status, 404);
  assert.equal((await pedir(`/api/registros/${reg.id}/adjuntos`, { cookie: c })).datos.length, 3);
});
