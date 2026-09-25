// Levanta el sistema con datos FICTICIOS para probarlo desde VS Code o GitHub Codespaces.
// Uso:  node scripts/demo.mjs            (requiere .NET 10 SDK y Node 18+)
//       node scripts/demo.mjs --reiniciar   borra la base de demo y la vuelve a crear
// Entra con usuario "demo" y contraseña "demo-demo-123". Todo queda en .demo/ (no se sube a git).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const DEMO = join(RAIZ, '.demo'), BIN = join(DEMO, 'bin'), WEB = join(DEMO, 'web'), DATOS = join(DEMO, 'datos');
const PUERTO = process.env.PUERTO || '8765';
const USUARIO = 'demo', CLAVE = 'demo-demo-123';
const enCodespaces = !!process.env.CODESPACES;

if (process.argv.includes('--reiniciar')) rmSync(DATOS, { recursive: true, force: true });
mkdirSync(DATOS, { recursive: true });

console.log('1/4 Compilando el servidor…');
execFileSync('dotnet', ['build', join(RAIZ, 'servidor/Servidor.csproj'), '-c', 'Debug', '-o', BIN, '--nologo', '-v', 'q'], { stdio: 'inherit' });

console.log('2/4 Copiando la interfaz…');
rmSync(WEB, { recursive: true, force: true });
mkdirSync(WEB, { recursive: true });
copyFileSync(join(RAIZ, 'dashboard/index.html'), join(WEB, 'index.html'));
cpSync(join(RAIZ, 'dashboard/js'), join(WEB, 'js'), { recursive: true });
cpSync(join(RAIZ, 'dashboard/vendor'), join(WEB, 'vendor'), { recursive: true });

const nueva = !existsSync(join(DATOS, 'correspondencia.db'));
if (nueva) {
  console.log('3/4 Generando 900 ingresos ficticios…');
  let semilla = 7;
  const azar = () => (semilla = (semilla * 16807) % 2147483647) / 2147483647, uno = a => a[Math.floor(azar() * a.length)];
  const MUN = ['MUNICIPALIDAD DE QUILPUE', 'MUNICIPALIDAD DE VIÑA DEL MAR', 'MUNICIPALIDAD DE VALPARAISO', 'MUNICIPALIDAD DE VILLA ALEMANA',
    'TESORERIA GENERAL', 'SII', 'REGISTRO CIVIL', 'JUZGADO DE POLICIA LOCAL'];
  const TIPOS = [['TRASLADO', 'Solicita traslado de permiso de circulación PPU {p}'], ['BLOQUEO', 'Solicita bloqueo PPU {p} por deuda'],
    ['DESBLOQUEO', 'Solicita desbloqueo PPU {p}'], ['LEY 18.440', 'Informa vehículo PPU {p} no circular Ley 18.440'],
    ['PAGO / FONDOS', 'Transferencia de fondos permiso PPU {p} $ {m}'], ['PRESCRIPCION', 'Solicita prescripción de deuda PPU {p}'],
    ['DEVOLUCION', 'Solicita devolución de pago PPU {p}'], ['OTROS', 'Consulta general sobre permiso PPU {p}']];
  const DEST = ['ROSA', 'VIVIANA', 'MIGUEL', 'CARLOS', 'PATRICIA'], L = 'BCDFGHJKLPRSTVWXYZ';
  const hoy = new Date(), ay = hoy.getFullYear(), am = hoy.getMonth() + 1, cuenta = {}, filas = [];
  for (let i = 0; i < 900; i++) {
    const y = uno([ay - 2, ay - 1, ay - 1, ay, ay, ay]), mo = 1 + Math.floor(azar() * (y === ay ? am : 12)), d = 1 + Math.floor(azar() * 28);
    cuenta[y] = (cuenta[y] || 0) + 1;
    const [tipo, mat] = uno(TIPOS), p = Array.from({ length: 4 }, () => uno([...L])).join('') + (10 + Math.floor(azar() * 90));
    const monto = (20 + Math.floor(azar() * 380)) * 1000, cerrado = azar() < (y < ay ? 0.95 : 0.7);
    filas.push({ n: String(cuenta[y]), hoja: String(y), fecha: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      proc_: uno(MUN), doc: 'ORD. ' + (1 + Math.floor(azar() * 999)), materia: mat.replace('{p}', p).replace('{m}', monto.toLocaleString('es-CL')),
      dest: uno(DEST), procedimiento: cerrado ? 'Respondido por oficio' : '', archivo: cerrado ? 'ARCHIVO ' + y : '', tipo, ppu: p,
      monto: tipo === 'PAGO / FONDOS' ? monto : 0 });
  }
  writeFileSync(join(DATOS, 'data.js'), 'window.DATA=' + JSON.stringify(filas) + ';');
  execFileSync('dotnet', [join(BIN, 'CorrespondenciaPC.dll'), '--datos', DATOS, '--crear-usuario', USUARIO, 'Usuario Demo', 'admin'],
    { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, CLAVE } });
} else console.log('3/4 Usando la base de demo existente (para empezar de cero: --reiniciar)');

console.log('4/4 Iniciando el sistema…\n');
console.log(enCodespaces
  ? `   Abre la pestaña PORTS de VS Code y haz clic en el globo del puerto ${PUERTO}.`
  : `   Abre http://localhost:${PUERTO}`);
console.log(`   Usuario: ${USUARIO}   Contraseña: ${CLAVE}   (datos ficticios)\n   Ctrl+C para detener.\n`);
const args = [join(BIN, 'CorrespondenciaPC.dll'), '--datos', DATOS, '--web', WEB, '--puerto', PUERTO, '--sin-navegador'];
if (enCodespaces) args.push('--proxy');
const srv = spawn('dotnet', args, { stdio: ['ignore', 'inherit', 'inherit'] });
process.on('SIGINT', () => srv.kill('SIGINT'));
srv.on('exit', c => process.exit(c ?? 0));
