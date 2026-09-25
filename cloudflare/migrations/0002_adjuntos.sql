-- Adjuntos: el archivo vive en R2 (clave), aquí solo los metadatos.
CREATE TABLE IF NOT EXISTS adjuntos(
  id INTEGER PRIMARY KEY AUTOINCREMENT, registro_id INTEGER NOT NULL, nombre TEXT NOT NULL,
  tipo TEXT NOT NULL, tamano INTEGER NOT NULL, clave TEXT NOT NULL, subido_por TEXT, fecha REAL);
CREATE INDEX IF NOT EXISTS ix_adj ON adjuntos(registro_id);
