-- Esquema D1 del sistema de correspondencia (compatible con la base SQLite de la versión .NET).
CREATE TABLE IF NOT EXISTS registros(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  n TEXT, hoja TEXT, fecha TEXT, proc_ TEXT, doc TEXT, materia TEXT, dest TEXT,
  procedimiento TEXT, archivo TEXT, tipo TEXT, ppu TEXT, monto INTEGER DEFAULT 0,
  creado_por TEXT, actualizado REAL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_act ON registros(actualizado);
CREATE INDEX IF NOT EXISTS ix_hoja ON registros(hoja);

CREATE TABLE IF NOT EXISTS historial(
  id INTEGER PRIMARY KEY AUTOINCREMENT, registro_id INTEGER, usuario TEXT,
  campo TEXT, antes TEXT, despues TEXT, fecha REAL);
CREATE INDEX IF NOT EXISTS ix_hist ON historial(registro_id);

-- Cuentas: la contraseña se guarda como PBKDF2-SHA256 (100.000 iteraciones) con sal aleatoria.
CREATE TABLE IF NOT EXISTS usuarios(
  usuario TEXT PRIMARY KEY,          -- login, en minúsculas
  nombre TEXT NOT NULL,              -- nombre que queda en el historial
  hash TEXT NOT NULL, sal TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'funcionario',   -- 'admin' | 'funcionario'
  activo INTEGER NOT NULL DEFAULT 1,
  fallidos INTEGER NOT NULL DEFAULT 0, bloqueado_hasta REAL NOT NULL DEFAULT 0);

-- Sesiones: solo se guarda el SHA-256 del token, nunca el token.
CREATE TABLE IF NOT EXISTS sesiones(
  token_hash TEXT PRIMARY KEY, usuario TEXT NOT NULL, expira REAL NOT NULL);
CREATE INDEX IF NOT EXISTS ix_ses_exp ON sesiones(expira);
