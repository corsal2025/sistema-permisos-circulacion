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
- **Versión en la nube** (Cloudflare): inicio de sesión con contraseña, roles, administración de usuarios y bloqueo por intentos fallidos.

## Arquitectura

| Parte | Tecnología | Carpeta |
|---|---|---|
| Servidor + API | ASP.NET Core (.NET 10), minimal API | `servidor/` |
| Base de datos | SQLite (`correspondencia.db`, se crea sola) | junto al `.exe` |
| Interfaz | HTML + JS sin framework, Chart.js, SheetJS | `dashboard/index.html` |
| Migración inicial | Script que normaliza el Excel histórico a `data.js` | `dashboard/convertir.py` |
| Versión nube | Cloudflare Worker + D1 + Workers Assets | `cloudflare/` |

API: `GET /api/registros?desde=<ts>`, `POST /api/registros`, `PUT /api/registros/{id}`, `GET /api/historial/{id}`.

La misma `index.html` sirve para ambas versiones: si el servidor responde `/api/yo` (nube) pide usuario y contraseña;
si no (servidor `.exe`), funciona como antes pidiendo solo el nombre.

## Uso local (Windows, sin internet)

1. Ejecutar `PUBLICAR.bat` (compila y arma la carpeta `SISTEMA/`).
2. Abrir `SISTEMA/INICIAR.bat` → se abre `http://localhost:8765`.
3. Para varios usuarios: `SISTEMA/INICIAR EN RED.bat` y compartir `http://IP-DEL-PC:8765`.

Respaldar periódicamente `SISTEMA/correspondencia.db`.

## Versión Cloudflare (`cloudflare/`)

El Worker (`src/index.js`) expone la misma API más `/api/login`, `/api/logout`, `/api/yo`, `/api/clave` y `/api/usuarios` (solo admin).
Seguridad: contraseñas PBKDF2-SHA256 (100.000 iteraciones), sesión en cookie `HttpOnly; Secure; SameSite=Strict` de 12 h
(en la base solo se guarda el hash del token), bloqueo de 15 min tras 5 intentos fallidos, verificación de `Origin` en escrituras,
validación y límite de tamaño de las entradas, cabeceras CSP/HSTS/X-Frame-Options. El usuario del historial sale de la sesión,
no de lo que envía el navegador.

### Desplegar con GitHub Actions (recomendado)

1. En Cloudflare, crear un **API Token** con permisos *Workers Scripts: Edit* y *D1: Edit* (cuenta propia).
2. En GitHub → *Settings → Secrets and variables → Actions*, agregar `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`.
3. Hacer merge a `main` (o ejecutar el workflow *Cloudflare* a mano). El workflow corre las pruebas, crea la base D1
   `correspondencia` si no existe, aplica las migraciones y publica en `https://correspondencia-permisos.<subdominio>.workers.dev`.

### Desplegar desde un PC

```bash
cd cloudflare
npm install
npx wrangler login
npx wrangler d1 create correspondencia     # copiar el database_id a wrangler.toml
npm run deploy
```

### Primer administrador y datos históricos (desde un PC con el Excel o la base local)

```bash
cd cloudflare
npm run usuario -- rsalazar "RAUL SALAZAR" admin          # pide la contraseña (mín. 10 caracteres)
npm run importar -- ../SISTEMA/correspondencia.db         # conserva ids e historial de la versión .exe
# o bien: npm run importar -- ../dashboard/data.js        # desde el Excel convertido
```

Los siguientes usuarios se crean desde la interfaz: clic en el nombre (abajo a la izquierda) → *Administrar usuarios*.
La importación se niega a correr si la base D1 ya tiene registros.

**Recomendado**: agregar además **Cloudflare Access** (Zero Trust, gratis hasta 50 usuarios) delante del Worker,
limitado a los correos municipales, como segunda capa antes del login.

### Pruebas

`cd cloudflare && npm test` levanta el Worker con una D1 local temporal y prueba login, bloqueo, correlativo,
historial, conflictos, permisos de administrador y CSRF (no requiere cuenta de Cloudflare).

## Datos

Los datos reales (Excel, `data.js`, `correspondencia.db`) contienen información personal de contribuyentes
y **no se versionan** (ver `.gitignore`). En la versión nube quedan en la base D1 de la cuenta Cloudflare del municipio;
antes de subirlos, confirmar con el encargado de protección de datos (Ley 19.628) que el uso de ese proveedor está autorizado.
D1 tiene *Time Travel* (restaurar a cualquier punto de los últimos 30 días); igual conviene exportar un respaldo
periódico con `npx wrangler d1 export correspondencia --remote --output respaldo.sql`.

## Pendiente

- Inicio de sesión en la versión `.exe` local (la versión nube ya lo tiene): mientras tanto, no usar `INICIAR EN RED.bat` fuera de la red municipal.
