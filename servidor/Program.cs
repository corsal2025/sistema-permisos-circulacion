// Servidor del dashboard de correspondencia (ASP.NET Core + SQLite).
// Local:  CorrespondenciaPC.exe          -> http://localhost:8765
// Red:    CorrespondenciaPC.exe --red    -> otros PCs entran a http://IP-DE-ESTE-PC:8765
// Otras opciones:
//   --crear-usuario <usuario> "<NOMBRE>" [admin|funcionario]   crea o restablece una cuenta (pide la contraseña)
//   --datos <carpeta>      dónde viven correspondencia.db, data.js y respaldos/ (por defecto, junto al .exe)
//   --puerto <n>           puerto HTTP (por defecto 8765)
//   --sin-navegador        no abre el navegador al iniciar
// La API y las reglas de seguridad son las mismas que las del Worker de Cloudflare (cloudflare/src/index.js).
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

string? Opcion(string nombre) { var i = Array.IndexOf(args, nombre); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }

var carpeta = Path.GetFullPath(Opcion("--datos") ?? AppContext.BaseDirectory);
var puerto = int.TryParse(Opcion("--puerto"), out var pu) ? pu : 8765;
var cs = $"Data Source={Path.Combine(carpeta, "correspondencia.db")}";
string[] campos = ["n", "hoja", "fecha", "proc_", "doc", "materia", "dest", "procedimiento", "archivo", "tipo", "ppu", "monto"];
string[] editables = [.. campos.Where(k => k is not ("n" or "hoja"))];
const int LargoMax = 4000, CuerpoMax = 64 * 1024, SesionHoras = 12, IntentosMax = 5, BloqueoMin = 15, Iteraciones = 100_000;
var candado = new object();
double Ahora() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;

SqliteConnection Conectar()
{
    var c = new SqliteConnection(cs);
    c.Open();
    using var p = c.CreateCommand();
    p.CommandText = "PRAGMA busy_timeout=5000;";
    p.ExecuteNonQuery();
    return c;
}

SqliteCommand Comando(SqliteConnection c, string sql, object?[] a)
{
    var cmd = c.CreateCommand();
    cmd.CommandText = sql;
    for (int i = 0; i < a.Length; i++) cmd.Parameters.AddWithValue("$p" + i, a[i] ?? DBNull.Value);
    return cmd;
}

int Ejecutar(SqliteConnection c, string sql, params object?[] a)
{
    using var cmd = Comando(c, sql, a);
    return cmd.ExecuteNonQuery();
}

List<Dictionary<string, object?>> Consultar(SqliteConnection c, string sql, params object?[] a)
{
    using var cmd = Comando(c, sql, a);
    using var r = cmd.ExecuteReader();
    var lista = new List<Dictionary<string, object?>>();
    while (r.Read())
    {
        var fila = new Dictionary<string, object?>();
        for (int i = 0; i < r.FieldCount; i++) fila[r.GetName(i)] = r.IsDBNull(i) ? null : r.GetValue(i);
        lista.Add(fila);
    }
    return lista;
}

Dictionary<string, object?>? Uno(SqliteConnection c, string sql, params object?[] a) => Consultar(c, sql, a).FirstOrDefault();

string Param(int cantidad) => string.Join(",", Enumerable.Range(0, cantidad).Select(i => "$p" + i));
string Texto(JsonNode? n) => n is null ? "" : n.GetValueKind() == JsonValueKind.String ? n.GetValue<string>() : n.ToJsonString();
object ValorImportado(string campo, JsonNode? n) => campo == "monto" ? (long.TryParse(Texto(n), out var m) ? m : 0L) : Texto(n);

// ---------- cifrado (compatible con el Worker: PBKDF2-SHA256, 100.000 iteraciones, 32 bytes) ----------
string Derivar(string clave, string salHex) =>
    Convert.ToHexStringLower(Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(clave), Convert.FromHexString(salHex), Iteraciones, HashAlgorithmName.SHA256, 32));
string Sha256(string texto) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(texto)));
bool IgualSeguro(string a, string b) => CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(a), Encoding.ASCII.GetBytes(b));
string AleatorioHex(int bytes) => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(bytes));
(string sal, string hash) HashClave(string clave) { var sal = AleatorioHex(16); return (sal, Derivar(clave, sal)); }

void ValidarClave(string? c)
{
    if (c is null || c.Length < 10) throw new ErrorHttp(400, "La contraseña debe tener al menos 10 caracteres");
}

// ---------- validación ----------
async Task<JsonObject> LeerJson(HttpRequest req)
{
    if (!(req.ContentType ?? "").Contains("application/json")) throw new ErrorHttp(415, "Se espera JSON");
    if (req.ContentLength > CuerpoMax) throw new ErrorHttp(413, "Solicitud demasiado grande");
    var buf = new byte[CuerpoMax + 1];
    int leidos = 0, n;
    while (leidos < buf.Length && (n = await req.Body.ReadAsync(buf.AsMemory(leidos))) > 0) leidos += n;
    if (leidos > CuerpoMax) throw new ErrorHttp(413, "Solicitud demasiado grande");
    try { return JsonNode.Parse(buf.AsSpan(0, leidos)) as JsonObject ?? throw new ErrorHttp(400, "JSON inválido"); }
    catch (JsonException) { throw new ErrorHttp(400, "JSON inválido"); }
}

object Normalizar(string campo, JsonNode? v)
{
    if (campo == "monto")
    {
        var s = Texto(v);
        var m = s == "" || s == "null" ? 0L : double.TryParse(s, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d) ? (long)Math.Truncate(d) : 0L;
        if (m < 0 || m > 10_000_000_000_000) throw new ErrorHttp(400, "Monto fuera de rango");
        return m;
    }
    var t = (v is null || v.GetValueKind() == JsonValueKind.Null ? "" : Texto(v)).Trim();
    if (t.Length > LargoMax) throw new ErrorHttp(400, $"El campo {campo} es demasiado largo");
    if (campo == "fecha" && t != "" && !Regex.IsMatch(t, @"^\d{4}-\d{2}-\d{2}$")) throw new ErrorHttp(400, "Fecha inválida (AAAA-MM-DD)");
    return campo is "ppu" or "dest" or "proc_" ? t.ToUpperInvariant() : t;
}

// ---------- base de datos ----------
Directory.CreateDirectory(carpeta);
using (var c = Conectar())
{
    Ejecutar(c, "PRAGMA journal_mode=WAL;");
    Ejecutar(c, """
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
        CREATE TABLE IF NOT EXISTS usuarios(
          usuario TEXT PRIMARY KEY, nombre TEXT NOT NULL, hash TEXT NOT NULL, sal TEXT NOT NULL,
          rol TEXT NOT NULL DEFAULT 'funcionario', activo INTEGER NOT NULL DEFAULT 1,
          fallidos INTEGER NOT NULL DEFAULT 0, bloqueado_hasta REAL NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS sesiones(token_hash TEXT PRIMARY KEY, usuario TEXT NOT NULL, expira REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS ix_ses_exp ON sesiones(expira);
        """);

    if (args.Contains("--crear-usuario"))
    {
        var i = Array.IndexOf(args, "--crear-usuario");
        var u = (args.ElementAtOrDefault(i + 1) ?? "").Trim().ToLowerInvariant();
        var nom = (args.ElementAtOrDefault(i + 2) ?? "").Trim().ToUpperInvariant();
        var rol = args.ElementAtOrDefault(i + 3) == "admin" ? "admin" : "funcionario";
        if (!Regex.IsMatch(u, "^[a-z0-9._-]{3,40}$") || nom == "")
        {
            Console.WriteLine("Uso: CorrespondenciaPC.exe --crear-usuario <usuario> \"<NOMBRE>\" [admin|funcionario]");
            return 1;
        }
        CrearUsuario(c, u, nom, rol, Environment.GetEnvironmentVariable("CLAVE") ?? PedirClave());
        Console.WriteLine($"Usuario {u} listo.");
        return 0;
    }

    if ((long)Uno(c, "SELECT COUNT(*) AS n FROM registros")!["n"]! == 0)
    {
        var src = Path.Combine(carpeta, "data.js");
        if (File.Exists(src))
        {
            var txt = File.ReadAllText(src);
            var filas = JsonNode.Parse(txt[txt.IndexOf('[')..(txt.LastIndexOf(']') + 1)])!.AsArray();
            using var tx = c.BeginTransaction();
            using var cmd = c.CreateCommand();
            cmd.CommandText = $"INSERT INTO registros({string.Join(",", campos)},creado_por) VALUES({Param(campos.Length)},'IMPORTACION')";
            var ps = campos.Select((_, i) => cmd.Parameters.Add("$p" + i, SqliteType.Text)).ToArray();
            foreach (var f in filas)
            {
                for (int i = 0; i < campos.Length; i++) ps[i].Value = ValorImportado(campos[i], f![campos[i]]);
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
            Console.WriteLine($"Base creada con {filas.Count} registros importados del Excel.");
        }
        else Console.WriteLine("Base nueva sin datos históricos (no se encontró data.js).");
    }

    if ((long)Uno(c, "SELECT COUNT(*) AS n FROM usuarios WHERE rol='admin' AND activo=1")!["n"]! == 0)
    {
        if (Console.IsInputRedirected)
            Console.WriteLine("No hay administradores. Crea uno con: CorrespondenciaPC.exe --crear-usuario <usuario> \"<NOMBRE>\" admin");
        else
        {
            Console.WriteLine("Primer inicio: crea la cuenta de administrador.");
            string u;
            do { Console.Write("Usuario (minúsculas, ej: rsalazar): "); u = (Console.ReadLine() ?? "").Trim().ToLowerInvariant(); }
            while (!Regex.IsMatch(u, "^[a-z0-9._-]{3,40}$"));
            string nom;
            do { Console.Write("Nombre completo: "); nom = (Console.ReadLine() ?? "").Trim().ToUpperInvariant(); } while (nom == "");
            CrearUsuario(c, u, nom, "admin", PedirClave());
            Console.WriteLine($"Administrador {u} creado. Los demás usuarios se crean desde el sistema.");
        }
    }
}

string PedirClave()
{
    while (true)
    {
        Console.Write("Contraseña (mínimo 10 caracteres): ");
        var sb = new StringBuilder();
        ConsoleKeyInfo k;
        while ((k = Console.ReadKey(true)).Key != ConsoleKey.Enter)
        {
            if (k.Key == ConsoleKey.Backspace) { if (sb.Length > 0) sb.Length--; }
            else if (!char.IsControl(k.KeyChar)) sb.Append(k.KeyChar);
        }
        Console.WriteLine();
        if (sb.Length >= 10) return sb.ToString();
        Console.WriteLine("Muy corta.");
    }
}

void CrearUsuario(SqliteConnection c, string usuario, string nombre, string rol, string clave)
{
    ValidarClave(clave);
    var (sal, hash) = HashClave(clave);
    Ejecutar(c, """
        INSERT INTO usuarios(usuario,nombre,hash,sal,rol,activo) VALUES($p0,$p1,$p2,$p3,$p4,1)
        ON CONFLICT(usuario) DO UPDATE SET nombre=excluded.nombre,hash=excluded.hash,sal=excluded.sal,rol=excluded.rol,activo=1,fallidos=0,bloqueado_hasta=0
        """, usuario, nombre, hash, sal, rol);
    Ejecutar(c, "DELETE FROM sesiones WHERE usuario=$p0", usuario);
}

// ---------- respaldo diario: respaldos/correspondencia-AAAA-MM-DD.db, se conservan los últimos 30 ----------
var carpetaRespaldos = Path.Combine(carpeta, "respaldos");
void Respaldar()
{
    try
    {
        Directory.CreateDirectory(carpetaRespaldos);
        var destino = Path.Combine(carpetaRespaldos, $"correspondencia-{DateTime.Now:yyyy-MM-dd}.db");
        if (File.Exists(destino)) return;
        using (var c = Conectar()) Ejecutar(c, "VACUUM INTO $p0", destino);
        foreach (var viejo in Directory.GetFiles(carpetaRespaldos, "correspondencia-*.db").OrderDescending().Skip(30)) File.Delete(viejo);
    }
    catch (Exception e) { Console.WriteLine("No se pudo crear el respaldo: " + e.Message); }
}
Respaldar();
using var temporizador = new Timer(_ => Respaldar(), null, TimeSpan.FromHours(1), TimeSpan.FromHours(1));

// ---------- sesiones ----------
string? Cookie(HttpRequest req) => req.Cookies.TryGetValue("sid", out var t) && Regex.IsMatch(t, "^[0-9a-f]{64}$") ? t : null;

Sesion? SesionActual(HttpRequest req)
{
    var token = Cookie(req);
    if (token is null) return null;
    using var c = Conectar();
    var f = Uno(c, """
        SELECT u.usuario, u.nombre, u.rol FROM sesiones s JOIN usuarios u ON u.usuario = s.usuario
        WHERE s.token_hash = $p0 AND s.expira > $p1 AND u.activo = 1
        """, Sha256(token), Ahora());
    return f is null ? null : new Sesion((string)f["usuario"]!, (string)f["nombre"]!, (string)f["rol"]!);
}

void PonerCookie(HttpContext ctx, string valor, int segundos) =>
    ctx.Response.Cookies.Append("sid", valor, new CookieOptions
    {
        HttpOnly = true, SameSite = SameSiteMode.Strict, Path = "/", MaxAge = TimeSpan.FromSeconds(segundos),
        Secure = ctx.Request.IsHttps, // en la red municipal el .exe atiende por http
    });

// ---------- servidor web ----------
var enRed = args.Contains("--red");
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = [], ContentRootPath = AppContext.BaseDirectory, WebRootPath = Path.Combine(AppContext.BaseDirectory, "web")
});
builder.WebHost.UseUrls(enRed ? $"http://0.0.0.0:{puerto}" : $"http://127.0.0.1:{puerto}");
builder.Logging.SetMinimumLevel(LogLevel.Warning);
var app = builder.Build();

app.Use(async (ctx, siguiente) =>
{
    var h = ctx.Response.Headers;
    h["X-Frame-Options"] = "DENY";
    h["X-Content-Type-Options"] = "nosniff";
    h["Referrer-Policy"] = "same-origin";
    h["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    if (!ctx.Request.Path.StartsWithSegments("/api")) { await siguiente(); return; }
    h.CacheControl = "no-store";
    try
    {
        // Bloqueo básico de CSRF: las escrituras deben venir del mismo origen.
        var origen = ctx.Request.Headers.Origin.FirstOrDefault();
        if (!HttpMethods.IsGet(ctx.Request.Method) && origen is not null && origen != $"{ctx.Request.Scheme}://{ctx.Request.Host}")
            throw new ErrorHttp(403, "Origen no permitido");
        var ruta = ctx.Request.Path.Value!;
        if (ruta is not ("/api/login" or "/api/logout"))
        {
            var yo = SesionActual(ctx.Request) ?? throw new ErrorHttp(401, "Sesión no iniciada o expirada");
            if (ruta == "/api/usuarios" && yo.Rol != "admin") throw new ErrorHttp(403, "Solo administradores");
            ctx.Items["yo"] = yo;
        }
        await siguiente();
    }
    catch (ErrorHttp e)
    {
        ctx.Response.StatusCode = e.Status;
        await ctx.Response.WriteAsJsonAsync(new { error = e.Message });
    }
    catch (Exception e) when (e is not OperationCanceledException)
    {
        Console.WriteLine(e);
        ctx.Response.StatusCode = 500;
        await ctx.Response.WriteAsJsonAsync(new { error = "Error interno del servidor" });
    }
});
app.UseDefaultFiles();
app.UseStaticFiles();

Sesion Yo(HttpContext ctx) => (Sesion)ctx.Items["yo"]!;

app.MapPost("/api/login", async (HttpContext ctx) =>
{
    var d = await LeerJson(ctx.Request);
    var usuario = Texto(d["usuario"]).Trim().ToLowerInvariant();
    var clave = Texto(d["clave"]);
    var t = Ahora();
    using var c = Conectar();
    var u = Uno(c, "SELECT * FROM usuarios WHERE usuario=$p0", usuario);
    if (u is not null && (double)u["bloqueado_hasta"]! > t)
        throw new ErrorHttp(429, $"Cuenta bloqueada por intentos fallidos. Intenta en {Math.Ceiling(((double)u["bloqueado_hasta"]! - t) / 60)} min.");
    // Siempre se deriva la clave para no revelar por tiempo de respuesta si el usuario existe.
    var calculado = Derivar(clave, u is null ? new string('0', 32) : (string)u["sal"]!);
    if (u is null || (long)u["activo"]! == 0 || !IgualSeguro(calculado, (string)u["hash"]!))
    {
        if (u is not null)
        {
            var f = (long)u["fallidos"]! + 1;
            Ejecutar(c, "UPDATE usuarios SET fallidos=$p0, bloqueado_hasta=$p1 WHERE usuario=$p2",
                     f >= IntentosMax ? 0 : f, f >= IntentosMax ? t + BloqueoMin * 60 : 0.0, usuario);
        }
        throw new ErrorHttp(401, "Usuario o contraseña incorrectos");
    }
    var token = AleatorioHex(32);
    using (var tx = c.BeginTransaction())
    {
        Ejecutar(c, "DELETE FROM sesiones WHERE expira < $p0", t);
        Ejecutar(c, "INSERT INTO sesiones(token_hash, usuario, expira) VALUES($p0,$p1,$p2)", Sha256(token), usuario, t + SesionHoras * 3600);
        Ejecutar(c, "UPDATE usuarios SET fallidos=0, bloqueado_hasta=0 WHERE usuario=$p0", usuario);
        tx.Commit();
    }
    PonerCookie(ctx, token, SesionHoras * 3600);
    return Results.Json(new { usuario = u["usuario"], nombre = u["nombre"], rol = u["rol"] });
});

app.MapPost("/api/logout", (HttpContext ctx) =>
{
    if (Cookie(ctx.Request) is string token)
    {
        using var c = Conectar();
        Ejecutar(c, "DELETE FROM sesiones WHERE token_hash=$p0", Sha256(token));
    }
    PonerCookie(ctx, "", 0);
    return Results.Json(new { ok = true });
});

app.MapGet("/api/yo", (HttpContext ctx) => { var yo = Yo(ctx); return Results.Json(new { usuario = yo.Usuario, nombre = yo.Nombre, rol = yo.Rol }); });

app.MapPost("/api/clave", async (HttpContext ctx) =>
{
    var yo = Yo(ctx);
    var d = await LeerJson(ctx.Request);
    using var c = Conectar();
    var u = Uno(c, "SELECT * FROM usuarios WHERE usuario=$p0", yo.Usuario)!;
    if (!IgualSeguro(Derivar(Texto(d["actual"]), (string)u["sal"]!), (string)u["hash"]!)) throw new ErrorHttp(403, "La contraseña actual no es correcta");
    var nueva = d["nueva"]?.GetValueKind() == JsonValueKind.String ? Texto(d["nueva"]) : null;
    ValidarClave(nueva);
    var (sal, hash) = HashClave(nueva!);
    using var tx = c.BeginTransaction();
    Ejecutar(c, "UPDATE usuarios SET hash=$p0, sal=$p1 WHERE usuario=$p2", hash, sal, yo.Usuario);
    // cierra las demás sesiones abiertas de este usuario
    Ejecutar(c, "DELETE FROM sesiones WHERE usuario=$p0 AND token_hash<>$p1", yo.Usuario, Sha256(Cookie(ctx.Request)!));
    tx.Commit();
    return Results.Json(new { ok = true });
});

app.MapGet("/api/usuarios", () =>
{
    using var c = Conectar();
    return Results.Json(Consultar(c, "SELECT usuario, nombre, rol, activo FROM usuarios ORDER BY nombre"));
});

app.MapPost("/api/usuarios", async (HttpContext ctx) =>
{
    var yo = Yo(ctx);
    var d = await LeerJson(ctx.Request);
    var usuario = Texto(d["usuario"]).Trim().ToLowerInvariant();
    if (!Regex.IsMatch(usuario, "^[a-z0-9._-]{3,40}$")) throw new ErrorHttp(400, "Usuario inválido (3-40 caracteres: letras, números, . _ -)");
    var nombre = Texto(d["nombre"]).Trim().ToUpperInvariant();
    if (nombre == "" || nombre.Length > 80) throw new ErrorHttp(400, "Nombre inválido");
    var rol = Texto(d["rol"]) == "admin" ? "admin" : "funcionario";
    var activo = d["activo"]?.GetValueKind() == JsonValueKind.False ? 0 : 1;
    if (usuario == yo.Usuario && (activo == 0 || rol != "admin")) throw new ErrorHttp(400, "No puedes quitarte el rol de administrador ni desactivarte");
    var clave = d["clave"]?.GetValueKind() == JsonValueKind.String ? Texto(d["clave"]) : "";
    lock (candado)
    {
        using var c = Conectar();
        var existe = Uno(c, "SELECT 1 AS x FROM usuarios WHERE usuario=$p0", usuario) is not null;
        using var tx = c.BeginTransaction();
        if (clave != "")
        {
            ValidarClave(clave);
            var (sal, hash) = HashClave(clave);
            if (existe)
                Ejecutar(c, "UPDATE usuarios SET nombre=$p0, rol=$p1, activo=$p2, hash=$p3, sal=$p4, fallidos=0, bloqueado_hasta=0 WHERE usuario=$p5",
                         nombre, rol, activo, hash, sal, usuario);
            else
                Ejecutar(c, "INSERT INTO usuarios(usuario, nombre, hash, sal, rol, activo) VALUES($p0,$p1,$p2,$p3,$p4,$p5)",
                         usuario, nombre, hash, sal, rol, activo);
        }
        else
        {
            if (!existe) throw new ErrorHttp(400, "Un usuario nuevo necesita contraseña");
            Ejecutar(c, "UPDATE usuarios SET nombre=$p0, rol=$p1, activo=$p2 WHERE usuario=$p3", nombre, rol, activo, usuario);
        }
        if (activo == 0 || clave != "") Ejecutar(c, "DELETE FROM sesiones WHERE usuario=$p0", usuario);
        tx.Commit();
        return Results.Json(new { ok = true }, statusCode: existe ? 200 : 201);
    }
});

app.MapGet("/api/registros", (double? desde) =>
{
    var t = Ahora();
    using var c = Conectar();
    // El cursor retrocede 5 s para no perder escrituras concurrentes; el cliente absorbe duplicados.
    return Results.Json(new { ahora = t - 5, filas = Consultar(c, "SELECT * FROM registros WHERE actualizado > $p0", desde ?? 0) });
});

app.MapGet("/api/historial/{id:long}", (long id) =>
{
    using var c = Conectar();
    return Results.Json(Consultar(c, "SELECT * FROM historial WHERE registro_id=$p0 ORDER BY fecha DESC", id));
});

app.MapPost("/api/registros", async (HttpContext ctx) =>
{
    var yo = Yo(ctx);
    var d = await LeerJson(ctx.Request);
    var v = editables.ToDictionary(k => k, k => Normalizar(k, d[k]));
    var fecha = (string)v["fecha"];
    if (fecha == "") throw new ErrorHttp(400, "La fecha es obligatoria");
    if ((string)v["proc_"] == "" || (string)v["materia"] == "") throw new ErrorHttp(400, "Procedencia y materia son obligatorias");
    if ((string)v["tipo"] == "") v["tipo"] = "OTROS";
    v["hoja"] = fecha[..4];
    lock (candado)
    {
        using var c = Conectar();
        using var tx = c.BeginTransaction();
        // correlativo asignado por el servidor dentro de la transacción: dos usuarios nunca reciben el mismo N°
        var max = Uno(c, "SELECT MAX(CAST(n AS INTEGER)) AS m FROM registros WHERE hoja=$p0", v["hoja"])!["m"];
        v["n"] = ((max is long m ? m : 0) + 1).ToString();
        var t = Ahora();
        object?[] valores = [.. campos.Select(k => v[k]), yo.Nombre, t];
        Ejecutar(c, $"INSERT INTO registros({string.Join(",", campos)},creado_por,actualizado) VALUES({Param(valores.Length)})", valores);
        var id = (long)Uno(c, "SELECT last_insert_rowid() AS id")!["id"]!;
        Ejecutar(c, "INSERT INTO historial(registro_id,usuario,campo,antes,despues,fecha) VALUES($p0,$p1,'CREADO','',$p2,$p3)", id, yo.Nombre, v["n"], t);
        tx.Commit();
        return Results.Json(Uno(c, "SELECT * FROM registros WHERE id=$p0", id), statusCode: 201);
    }
});

app.MapPut("/api/registros/{id:long}", async (long id, HttpContext ctx) =>
{
    var yo = Yo(ctx);
    var d = await LeerJson(ctx.Request);
    lock (candado)
    {
        using var c = Conectar();
        var viejo = Uno(c, "SELECT * FROM registros WHERE id=$p0", id) ?? throw new ErrorHttp(404, "Registro no encontrado");
        // control de concurrencia: si otro usuario guardó después de que se abrió la ficha, no se pisa su cambio
        if (d["version"] is JsonNode ver && ver.GetValueKind() != JsonValueKind.Null
            && double.TryParse(Texto(ver), System.Globalization.CultureInfo.InvariantCulture, out var version)
            && Math.Abs(version - Convert.ToDouble(viejo["actualizado"] ?? 0.0)) > 1e-6)
            return Results.Json(new { error = "Otro usuario modificó este ingreso mientras lo editabas. Revisa los cambios y vuelve a guardar.", registro = viejo }, statusCode: 409);
        var cambios = new Dictionary<string, object>();
        foreach (var k in editables)
        {
            if (!d.ContainsKey(k)) continue;
            var nv = Normalizar(k, d[k]);
            if (nv.ToString() != (viejo[k]?.ToString() ?? "")) cambios[k] = nv;
        }
        if (cambios.TryGetValue("fecha", out var f) && (string)f == "") throw new ErrorHttp(400, "La fecha es obligatoria");
        if (cambios.Count > 0)
        {
            var t = Ahora();
            var claves = cambios.Keys.ToList();
            var sets = string.Join(",", claves.Select((k, i) => $"{k}=$p{i}"));
            using var tx = c.BeginTransaction();
            Ejecutar(c, $"UPDATE registros SET {sets}, actualizado=$p{claves.Count} WHERE id=$p{claves.Count + 1}",
                     [.. claves.Select(k => cambios[k]), t, id]);
            foreach (var k in claves)
                Ejecutar(c, "INSERT INTO historial(registro_id,usuario,campo,antes,despues,fecha) VALUES($p0,$p1,$p2,$p3,$p4,$p5)",
                         id, yo.Nombre, k, viejo[k]?.ToString() ?? "", cambios[k].ToString(), t);
            tx.Commit();
        }
        return Results.Json(Uno(c, "SELECT * FROM registros WHERE id=$p0", id));
    }
});

app.Map("/api/{**resto}", () => Results.Json(new { error = "Ruta no encontrada" }, statusCode: 404));

Console.WriteLine($"Dashboard listo en http://localhost:{puerto}" + (enRed ? "  (abierto a la red)" : ""));
Console.WriteLine("Deja esta ventana abierta. Cierrala para detener el sistema.");
if (!args.Contains("--sin-navegador"))
    try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo($"http://localhost:{puerto}") { UseShellExecute = true }); } catch { }
app.Run();
return 0;

record Sesion(string Usuario, string Nombre, string Rol);

class ErrorHttp(int status, string mensaje) : Exception(mensaje)
{
    public int Status { get; } = status;
}
