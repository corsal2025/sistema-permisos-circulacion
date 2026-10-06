# Sistema de Correspondencia · Permisos de Circulación

Dashboard web para registrar y dar seguimiento a la correspondencia de la Dirección de Tránsito
(traslados, bloqueos, Ley 18.440, pagos a terceros, prescripciones, devoluciones, etc.).
Reemplaza el libro Excel `CORRESPONDENCIA` que se llevaba desde 2011.

## Funciones

- **Panel**: indicadores del año, ingresos por mes, tipos de trámite, carga por funcionario y municipios.
- **Correspondencia**: tabla con búsqueda, filtros por tipo, funcionario y estado; ficha lateral para editar.
- **Pendientes**: ingresos sin procedimiento, ordenados del más antiguo al más nuevo.
- **Buscar patente**: historial completo de una PPU desde 2011 y situación de bloqueo.
- **Multiusuario**: cada cambio queda registrado con usuario, fecha, valor anterior y nuevo.
- **Control de conflictos**: si dos personas editan la misma ficha, la segunda recibe aviso en vez de pisar el cambio.
- **Exportar a Excel** de la vista filtrada (funciona sin internet: Chart.js y SheetJS van incluidos en `dashboard/vendor/`).
- **Inicio de sesión** con contraseña, roles (administrador / funcionario), administración de usuarios y bloqueo por intentos fallidos.
- **Documentos adjuntos y lectura automática**: arrastra el PDF o la foto del oficio a la ficha (o a cualquier parte de la pantalla).
  En un ingreso nuevo se leen procedencia, N° y fecha del oficio, materia, patentes, monto y tipo, y se marcan en amarillo para revisar.
  Funciona con PDF digitales (pdf.js) y con escaneos o fotos (OCR en español con Tesseract), todo dentro del navegador y sin internet.
  Adjuntos de hasta 15 MB (PDF, imagen, Word, Excel, correo); se valida la firma del archivo y se muestran aislados.
- **Respaldo automático diario** de la base local en `respaldos/` (se conservan los últimos 30 días).

## Arquitectura

| Parte | Tecnología | Carpeta |
|---|---|---|
| Servidor + API | ASP.NET Core (.NET 10), minimal API | `servidor/` |
| Base de datos | SQLite (`correspondencia.db`, se crea sola) | junto al `.exe` |
| Interfaz | HTML + JS sin framework, Chart.js, SheetJS | `dashboard/index.html` |
| Migración inicial | Script que normaliza el Excel histórico a `data.js` | `dashboard/convertir.py` |
| Lector de oficios | Extracción de datos del texto del documento (probado con `npm test`) | `dashboard/js/leer-oficio.js` |
| Pruebas | Node `node:test`: API contra el `.exe` y lector de oficios | `pruebas/` |

API: `GET /api/registros?desde=<ts>`, `POST /api/registros`, `PUT /api/registros/{id}`, `GET /api/historial/{id}`.
Adjuntos: `GET|POST /api/registros/{id}/adjuntos`, `GET|DELETE /api/adjuntos/{id}` (se guardan en la base y entran al respaldo diario).

## Probarlo con datos ficticios

**En la nube, sin instalar nada (GitHub Codespaces):** en GitHub, botón **Code → Codespaces → Create codespace on**
esta rama. Se abre VS Code en el navegador, se instala todo solo y arranca la demo; se abre una pestaña con el sistema
(si no, pestaña **PORTS** → globo del puerto 8765). Usuario `demo`, contraseña `demo-demo-123`.
El link del puerto es privado: solo lo abre quien tenga acceso al repositorio en GitHub.

**En tu PC con VS Code:** instalar [.NET 10 SDK](https://dotnet.microsoft.com/download) y [Node.js 22](https://nodejs.org),
clonar el repositorio, abrir la carpeta y ejecutar la tarea **Sistema: iniciar demo** (Ctrl+Shift+B), o en la terminal:

```bash
node scripts/demo.mjs            # abre en http://localhost:8765
node scripts/demo.mjs --reiniciar   # vuelve a crear los datos de demo
```

La demo vive en `.demo/` (no se sube a git) y solo publica la interfaz, nunca `data.js` ni el Excel.
El diagrama de cómo funciona el sistema está en `docs/mapa-sistema.html` (se abre directo en el navegador).

## Uso local (Windows, sin internet)

1. Ejecutar `PUBLICAR.bat` (compila y arma la carpeta `SISTEMA/`).
2. Abrir `SISTEMA/INICIAR.bat`. **La primera vez** pide crear la cuenta de administrador en la consola; luego se abre `http://localhost:8765`.
   Los demás usuarios se crean desde el sistema (clic en tu nombre → *Administrar usuarios*), o por consola:
   `CorrespondenciaPC.exe --crear-usuario rosa "ROSA PEREZ" funcionario`.
3. Para varios usuarios: `SISTEMA/INICIAR EN RED.bat` y compartir `http://IP-DEL-PC:8765`.

El sistema deja una copia diaria en `SISTEMA/respaldos/`; igual conviene copiar esa carpeta a otro equipo o unidad.
Otras opciones: `--datos <carpeta>` (dónde guardar la base y los respaldos) y `--puerto <n>`.

Seguridad: contraseñas PBKDF2-SHA256 (100.000 iteraciones), sesión en cookie `HttpOnly; SameSite=Strict` de 12 h
(en la base solo se guarda el hash del token), bloqueo de 15 min tras 5 intentos fallidos, verificación de `Origin` en escrituras,
validación y límite de tamaño de las entradas. El usuario del historial sale de la sesión, no de lo que envía el navegador.

## Pruebas

Casos de login, bloqueo, correlativo, historial, conflictos, permisos de administrador, validación (XSS), adjuntos, CSRF y cabeceras
contra el servidor `.exe`, más las pruebas del lector de oficios (requiere .NET 10 SDK y Node 22):

```bash
cd pruebas
npm test
```

## Datos

Los datos reales (Excel, `data.js`, `correspondencia.db`) contienen información personal de contribuyentes
y **no se versionan** (ver `.gitignore`). El respaldo es la carpeta `SISTEMA/respaldos/` (ver arriba); conviene copiarla periódicamente a otro equipo.

## Pendiente

- Ingreso automático desde la casilla de partes (Outlook / Microsoft 365, vía Microsoft Graph): requiere que informática registre
  una aplicación en Entra ID con permiso de lectura solo sobre esa casilla.
- HTTPS en el modo red del `.exe` (hoy atiende por http dentro de la red municipal; no exponerlo a internet).
