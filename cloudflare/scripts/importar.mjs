// Importa el histórico a D1 desde dashboard/data.js (generado por convertir.py)
// o desde una base correspondencia.db de la versión .NET (conserva ids e historial).
// Uso: npm run importar -- ../dashboard/data.js [--local]
//      npm run importar -- ../SISTEMA/correspondencia.db [--local]
// Solo corre sobre una base D1 sin registros; genera un .sql temporal que se borra al terminar.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const local = args.includes('--local');
const origen = args.find(a => !a.startsWith('--'));
if (!origen) { console.error('Uso: npm run importar -- <data.js | correspondencia.db> [--local]'); process.exit(1); }
const d1 = (...extra) => execFileSync('npx', ['wrangler', 'd1', 'execute', 'correspondencia', local ? '--local' : '--remote', ...extra], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });

const conteo = d1('--json', '--command', 'SELECT COUNT(*) AS n FROM registros');
if (JSON.parse(conteo)[0].results[0].n > 0) { console.error('La base D1 ya tiene registros; la importación se cancela para no duplicar.'); process.exit(1); }

const CAMPOS = ['n', 'hoja', 'fecha', 'proc_', 'doc', 'materia', 'dest', 'procedimiento', 'archivo', 'tipo', 'ppu', 'monto'];
const q = v => v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
let registros, historial = [];

if (origen.endsWith('.js')) {
  const txt = readFileSync(origen, 'utf8');
  registros = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1))
    .map(f => ({ ...Object.fromEntries(CAMPOS.map(k => [k, k === 'monto' ? (parseInt(f[k]) || 0) : String(f[k] ?? '')])), creado_por: 'IMPORTACION', actualizado: 0 }));
} else {
  const { DatabaseSync } = await import('node:sqlite'); // Node 22.5+
  const db = new DatabaseSync(origen, { readOnly: true });
  registros = db.prepare('SELECT * FROM registros').all();
  historial = db.prepare('SELECT * FROM historial').all();
}

const lotes = (filas, cols, tabla) => {
  const out = [];
  for (let i = 0; i < filas.length; i += 200)
    out.push(`INSERT INTO ${tabla}(${cols.join(',')}) VALUES\n` + filas.slice(i, i + 200).map(f => '(' + cols.map(c => q(f[c])).join(',') + ')').join(',\n') + ';');
  return out;
};
const colsReg = [...(registros[0]?.id != null ? ['id'] : []), ...CAMPOS, 'creado_por', 'actualizado'];
const sql = [...lotes(registros, colsReg, 'registros'),
  ...lotes(historial, ['id', 'registro_id', 'usuario', 'campo', 'antes', 'despues', 'fecha'], 'historial')].join('\n');

const archivo = `importar-${Date.now()}.sql`;
writeFileSync(archivo, sql);
try { d1('--file', archivo); } finally { unlinkSync(archivo); }
console.log(`Importados ${registros.length} registros y ${historial.length} cambios de historial.`);
