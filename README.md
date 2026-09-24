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
- **Exportar a Excel** de la vista filtrada.

## Arquitectura

| Parte | Tecnología | Carpeta |
|---|---|---|
| Servidor + API | ASP.NET Core (.NET 10), minimal API | `servidor/` |
| Base de datos | SQLite (`correspondencia.db`, se crea sola) | junto al `.exe` |
| Interfaz | HTML + JS sin framework, Chart.js, SheetJS | `dashboard/index.html` |
| Migración inicial | Script que normaliza el Excel histórico a `data.js` | `dashboard/convertir.py` |

API: `GET /api/registros?desde=<ts>`, `POST /api/registros`, `PUT /api/registros/{id}`, `GET /api/historial/{id}`.

## Uso

1. Ejecutar `PUBLICAR.bat` (compila y arma la carpeta `SISTEMA/`).
2. Abrir `SISTEMA/INICIAR.bat` → se abre `http://localhost:8765`.
3. Para varios usuarios: `SISTEMA/INICIAR EN RED.bat` y compartir `http://IP-DEL-PC:8765`.

Respaldar periódicamente `SISTEMA/correspondencia.db`.

## Datos

Los datos reales (Excel, `data.js`, `correspondencia.db`) contienen información personal de contribuyentes
y **no se versionan** (ver `.gitignore`). Permanecen solo en el equipo municipal.

## Pendiente

- Inicio de sesión con contraseña antes de abrir el sistema a la red.
