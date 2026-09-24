// Worker de Cloudflare: API del sistema de correspondencia sobre D1.
// La interfaz estática (public/index.html) la sirve Workers Assets; este código solo atiende /api/*.

const CAMPOS = ['n', 'hoja', 'fecha', 'proc_', 'doc', 'materia', 'dest', 'procedimiento', 'archivo', 'tipo', 'ppu', 'monto'];
const EDITABLES = CAMPOS.filter(k => k !== 'n' && k !== 'hoja');
const LARGO_MAX = 4000;
const CUERPO_MAX = 64 * 1024;
const SESION_HORAS = 12;
const INTENTOS_MAX = 5, BLOQUEO_MIN = 15;
const ITERACIONES = 100_000; // máximo que admite PBKDF2 en Workers

const ahora = () => Date.now() / 1000;
const enc = new TextEncoder();

class ErrorHttp extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; }
}

function json(datos, status = 200, extra = {}) {
  return new Response(JSON.stringify(datos), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

// ---------- utilidades de cifrado ----------
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const deHex = s => new Uint8Array(s.match(/../g).map(h => parseInt(h, 16)));

async function derivar(clave, salHex) {
  const k = await crypto.subtle.importKey('raw', enc.encode(clave), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: deHex(salHex), iterations: ITERACIONES }, k, 256);
  return hex(bits);
}

async function sha256(texto) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(texto)));
}

function igualSeguro(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function aleatorioHex(bytes) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashClave(clave) {
  const sal = aleatorioHex(16);
  return { sal, hash: await derivar(clave, sal) };
}

// ---------- validación ----------
async function leerJson(req) {
  if (!(req.headers.get('Content-Type') || '').includes('application/json'))
    throw new ErrorHttp(415, 'Se espera JSON');
  const txt = await req.text();
  if (txt.length > CUERPO_MAX) throw new ErrorHttp(413, 'Solicitud demasiado grande');
  try {
    const d = JSON.parse(txt);
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw 0;
    return d;
  } catch { throw new ErrorHttp(400, 'JSON inválido'); }
}

function normalizar(campo, v) {
  if (campo === 'monto') {
    const m = Math.trunc(Number(v) || 0);
    if (m < 0 || m > 1e13) throw new ErrorHttp(400, 'Monto fuera de rango');
    return m;
  }
  const s = v == null ? '' : String(v).trim();
  if (s.length > LARGO_MAX) throw new ErrorHttp(400, `El campo ${campo} es demasiado largo`);
  if (campo === 'fecha' && s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ErrorHttp(400, 'Fecha inválida (AAAA-MM-DD)');
  if (campo === 'ppu' || campo === 'dest' || campo === 'proc_') return s.toUpperCase();
  return s;
}

// ---------- sesiones ----------
function leerCookie(req, nombre) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + nombre + '=([^;]+)'));
  return m ? m[1] : null;
}

const cookieSesion = (token, segundos) =>
  `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${segundos}`;

async function sesionActual(req, env) {
  const token = leerCookie(req, 'sid');
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return env.DB.prepare(
    `SELECT u.usuario, u.nombre, u.rol FROM sesiones s JOIN usuarios u ON u.usuario = s.usuario
     WHERE s.token_hash = ? AND s.expira > ? AND u.activo = 1`)
    .bind(await sha256(token), ahora()).first();
}

async function login(req, env) {
  const d = await leerJson(req);
  const usuario = String(d.usuario || '').trim().toLowerCase();
  const clave = String(d.clave || '');
  const u = await env.DB.prepare('SELECT * FROM usuarios WHERE usuario = ?').bind(usuario).first();
  const t = ahora();
  if (u && u.bloqueado_hasta > t)
    throw new ErrorHttp(429, `Cuenta bloqueada por intentos fallidos. Intenta en ${Math.ceil((u.bloqueado_hasta - t) / 60)} min.`);
  // Siempre se deriva la clave para no revelar por tiempo de respuesta si el usuario existe.
  const calculado = await derivar(clave, u ? u.sal : '00'.repeat(16));
  if (!u || !u.activo || !igualSeguro(calculado, u.hash)) {
    if (u) {
      const f = u.fallidos + 1;
      await env.DB.prepare('UPDATE usuarios SET fallidos = ?, bloqueado_hasta = ? WHERE usuario = ?')
        .bind(f >= INTENTOS_MAX ? 0 : f, f >= INTENTOS_MAX ? t + BLOQUEO_MIN * 60 : 0, usuario).run();
    }
    throw new ErrorHttp(401, 'Usuario o contraseña incorrectos');
  }
  const token = aleatorioHex(32);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sesiones WHERE expira < ?').bind(t),
    env.DB.prepare('INSERT INTO sesiones(token_hash, usuario, expira) VALUES(?, ?, ?)')
      .bind(await sha256(token), usuario, t + SESION_HORAS * 3600),
    env.DB.prepare('UPDATE usuarios SET fallidos = 0, bloqueado_hasta = 0 WHERE usuario = ?').bind(usuario),
  ]);
  return json({ usuario: u.usuario, nombre: u.nombre, rol: u.rol }, 200,
    { 'Set-Cookie': cookieSesion(token, SESION_HORAS * 3600) });
}

async function logout(req, env) {
  const token = leerCookie(req, 'sid');
  if (token) await env.DB.prepare('DELETE FROM sesiones WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': cookieSesion('', 0) });
}

async function cambiarClave(req, env, yo) {
  const d = await leerJson(req);
  const u = await env.DB.prepare('SELECT * FROM usuarios WHERE usuario = ?').bind(yo.usuario).first();
  if (!igualSeguro(await derivar(String(d.actual || ''), u.sal), u.hash)) throw new ErrorHttp(403, 'La contraseña actual no es correcta');
  validarClave(d.nueva);
  const { sal, hash } = await hashClave(d.nueva);
  await env.DB.batch([
    env.DB.prepare('UPDATE usuarios SET hash = ?, sal = ? WHERE usuario = ?').bind(hash, sal, yo.usuario),
    // cierra las demás sesiones abiertas de este usuario
    env.DB.prepare('DELETE FROM sesiones WHERE usuario = ? AND token_hash <> ?')
      .bind(yo.usuario, await sha256(leerCookie(req, 'sid'))),
  ]);
  return json({ ok: true });
}

function validarClave(c) {
  if (typeof c !== 'string' || c.length < 10) throw new ErrorHttp(400, 'La contraseña debe tener al menos 10 caracteres');
}

// ---------- administración de usuarios (solo rol admin) ----------
async function listarUsuarios(env) {
  const r = await env.DB.prepare('SELECT usuario, nombre, rol, activo FROM usuarios ORDER BY nombre').all();
  return json(r.results);
}

async function guardarUsuario(req, env, yo) {
  const d = await leerJson(req);
  const usuario = String(d.usuario || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) throw new ErrorHttp(400, 'Usuario inválido (3-40 caracteres: letras, números, . _ -)');
  const nombre = String(d.nombre || '').trim().toUpperCase();
  if (!nombre || nombre.length > 80) throw new ErrorHttp(400, 'Nombre inválido');
  const rol = d.rol === 'admin' ? 'admin' : 'funcionario';
  const activo = d.activo === false ? 0 : 1;
  if (usuario === yo.usuario && (!activo || rol !== 'admin')) throw new ErrorHttp(400, 'No puedes quitarte el rol de administrador ni desactivarte');
  const existe = await env.DB.prepare('SELECT 1 FROM usuarios WHERE usuario = ?').bind(usuario).first();
  const ops = [];
  if (d.clave) {
    validarClave(d.clave);
    const { sal, hash } = await hashClave(d.clave);
    ops.push(existe
      ? env.DB.prepare('UPDATE usuarios SET nombre=?, rol=?, activo=?, hash=?, sal=?, fallidos=0, bloqueado_hasta=0 WHERE usuario=?')
          .bind(nombre, rol, activo, hash, sal, usuario)
      : env.DB.prepare('INSERT INTO usuarios(usuario, nombre, hash, sal, rol, activo) VALUES(?,?,?,?,?,?)')
          .bind(usuario, nombre, hash, sal, rol, activo));
  } else {
    if (!existe) throw new ErrorHttp(400, 'Un usuario nuevo necesita contraseña');
    ops.push(env.DB.prepare('UPDATE usuarios SET nombre=?, rol=?, activo=? WHERE usuario=?').bind(nombre, rol, activo, usuario));
  }
  if (!activo || d.clave) ops.push(env.DB.prepare('DELETE FROM sesiones WHERE usuario = ?').bind(usuario));
  await env.DB.batch(ops);
  return json({ ok: true }, existe ? 200 : 201);
}

// ---------- registros ----------
async function listarRegistros(url, env) {
  const desde = Number(url.searchParams.get('desde')) || 0;
  const t = ahora();
  const r = await env.DB.prepare('SELECT * FROM registros WHERE actualizado > ?').bind(desde).all();
  // El cursor retrocede 5 s para no perder escrituras concurrentes; el cliente absorbe duplicados.
  return json({ ahora: t - 5, filas: r.results });
}

async function historial(id, env) {
  const r = await env.DB.prepare('SELECT * FROM historial WHERE registro_id = ? ORDER BY fecha DESC').bind(id).all();
  return json(r.results);
}

async function crearRegistro(req, env, yo) {
  const d = await leerJson(req);
  const v = Object.fromEntries(EDITABLES.map(k => [k, normalizar(k, d[k])]));
  if (!v.fecha) throw new ErrorHttp(400, 'La fecha es obligatoria');
  if (!v.proc_ || !v.materia) throw new ErrorHttp(400, 'Procedencia y materia son obligatorias');
  v.tipo ||= 'OTROS';
  const hoja = v.fecha.slice(0, 4);
  const t = ahora();
  // El correlativo se calcula dentro del mismo INSERT: D1 serializa escrituras, así que no se repite.
  const cols = EDITABLES.filter(k => k !== 'hoja');
  const [ins, hist] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO registros(n, hoja, ${cols.join(',')}, creado_por, actualizado)
       SELECT CAST(COALESCE(MAX(CAST(n AS INTEGER)), 0) + 1 AS TEXT), ?1, ${cols.map((_, i) => '?' + (i + 2)).join(',')}, ?${cols.length + 2}, ?${cols.length + 3}
       FROM registros WHERE hoja = ?1 RETURNING *`)
      .bind(hoja, ...cols.map(k => v[k]), yo.nombre, t),
    env.DB.prepare(
      `INSERT INTO historial(registro_id, usuario, campo, antes, despues, fecha)
       SELECT id, ?, 'CREADO', '', n, ? FROM registros WHERE id = last_insert_rowid()`)
      .bind(yo.nombre, t),
  ]);
  return json(ins.results[0], 201);
}

async function editarRegistro(id, req, env, yo) {
  const d = await leerJson(req);
  const viejo = await env.DB.prepare('SELECT * FROM registros WHERE id = ?').bind(id).first();
  if (!viejo) throw new ErrorHttp(404, 'Registro no encontrado');
  if (d.version != null && Number(d.version) !== viejo.actualizado)
    return json({ error: 'Otro usuario modificó este ingreso mientras lo editabas. Revisa los cambios y vuelve a guardar.', registro: viejo }, 409);
  const cambios = {};
  for (const k of EDITABLES) {
    if (!(k in d) || k === 'hoja') continue;
    const nv = normalizar(k, d[k]);
    if (String(nv) !== String(viejo[k] ?? '')) cambios[k] = nv;
  }
  if ('fecha' in cambios && !cambios.fecha) throw new ErrorHttp(400, 'La fecha es obligatoria');
  const claves = Object.keys(cambios);
  if (!claves.length) return json(viejo);
  const t = ahora();
  // UPDATE condicionado a la versión leída; cada línea de historial se inserta solo si la anterior
  // afectó una fila (changes() = 1), así todo el lote queda en nada si hubo una edición concurrente.
  const res = await env.DB.batch([
    env.DB.prepare(`UPDATE registros SET ${claves.map(k => `${k} = ?`).join(', ')}, actualizado = ? WHERE id = ? AND actualizado = ?`)
      .bind(...claves.map(k => cambios[k]), t, id, viejo.actualizado),
    ...claves.map(k => env.DB.prepare(
      `INSERT INTO historial(registro_id, usuario, campo, antes, despues, fecha) SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
      .bind(id, yo.nombre, k, String(viejo[k] ?? ''), String(cambios[k]), t)),
  ]);
  const actual = await env.DB.prepare('SELECT * FROM registros WHERE id = ?').bind(id).first();
  if (res[0].meta.changes === 0)
    return json({ error: 'Otro usuario modificó este ingreso al mismo tiempo. Revisa los cambios y vuelve a guardar.', registro: actual }, 409);
  return json(actual);
}

// ---------- enrutador ----------
async function api(req, env) {
  const url = new URL(req.url);
  const p = url.pathname, m = req.method;

  // Bloqueo básico de CSRF: las escrituras deben venir del mismo origen.
  if (m !== 'GET' && m !== 'HEAD') {
    const origen = req.headers.get('Origin');
    if (origen && origen !== url.origin) throw new ErrorHttp(403, 'Origen no permitido');
  }

  if (p === '/api/login' && m === 'POST') return login(req, env);
  if (p === '/api/logout' && m === 'POST') return logout(req, env);

  const yo = await sesionActual(req, env);
  if (!yo) throw new ErrorHttp(401, 'Sesión no iniciada o expirada');

  if (p === '/api/yo' && m === 'GET') return json(yo);
  if (p === '/api/clave' && m === 'POST') return cambiarClave(req, env, yo);
  if (p === '/api/registros' && m === 'GET') return listarRegistros(url, env);
  if (p === '/api/registros' && m === 'POST') return crearRegistro(req, env, yo);
  let r;
  if ((r = p.match(/^\/api\/registros\/(\d+)$/)) && m === 'PUT') return editarRegistro(+r[1], req, env, yo);
  if ((r = p.match(/^\/api\/historial\/(\d+)$/)) && m === 'GET') return historial(+r[1], env);
  if (p === '/api/usuarios') {
    if (yo.rol !== 'admin') throw new ErrorHttp(403, 'Solo administradores');
    if (m === 'GET') return listarUsuarios(env);
    if (m === 'POST') return guardarUsuario(req, env, yo);
  }
  throw new ErrorHttp(404, 'Ruta no encontrada');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await api(req, env);
    } catch (e) {
      if (e instanceof ErrorHttp) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Error interno del servidor' }, 500);
    }
  },
};
