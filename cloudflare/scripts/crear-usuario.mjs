// Crea (o restablece) un usuario directamente en D1. Útil para el primer administrador.
// Uso: npm run usuario -- <usuario> "<NOMBRE COMPLETO>" [admin|funcionario] [--local]
// La contraseña se pide por consola (o variable CLAVE) y nunca se escribe en disco.
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const args = process.argv.slice(2);
const local = args.includes('--local');
const [usuario, nombre, rol = 'funcionario'] = args.filter(a => a !== '--local');
if (!usuario || !nombre || !/^[a-z0-9._-]{3,40}$/.test(usuario.toLowerCase())) {
  console.error('Uso: npm run usuario -- <usuario> "<NOMBRE COMPLETO>" [admin|funcionario] [--local]');
  process.exit(1);
}
let clave = process.env.CLAVE;
if (!clave) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  clave = await rl.question('Contraseña (mínimo 10 caracteres): ');
  rl.close();
}
if (clave.length < 10) { console.error('La contraseña debe tener al menos 10 caracteres'); process.exit(1); }

const sal = randomBytes(16).toString('hex');
const hash = pbkdf2Sync(clave, Buffer.from(sal, 'hex'), 100_000, 32, 'sha256').toString('hex');
const q = s => `'${String(s).replace(/'/g, "''")}'`;
const sql = `INSERT INTO usuarios(usuario,nombre,hash,sal,rol,activo) VALUES(${q(usuario.toLowerCase())},${q(nombre.toUpperCase())},${q(hash)},${q(sal)},${q(rol === 'admin' ? 'admin' : 'funcionario')},1)
ON CONFLICT(usuario) DO UPDATE SET nombre=excluded.nombre,hash=excluded.hash,sal=excluded.sal,rol=excluded.rol,activo=1,fallidos=0,bloqueado_hasta=0;`;
execFileSync('npx', ['wrangler', 'd1', 'execute', 'correspondencia', local ? '--local' : '--remote', '--command', sql], { stdio: 'inherit' });
console.log(`Usuario ${usuario} listo.`);
