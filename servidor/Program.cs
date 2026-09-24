// Servidor del dashboard de correspondencia (ASP.NET Core + SQLite).
// Local:  CorrespondenciaPC.exe          -> http://localhost:8765
// Red:    CorrespondenciaPC.exe --red    -> otros PCs entran a http://IP-DE-ESTE-PC:8765
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

var carpeta = AppContext.BaseDirectory;
var cs = $"Data Source={Path.Combine(carpeta, "correspondencia.db")}";
string[] campos = ["n", "hoja", "fecha", "proc_", "doc", "materia", "dest", "procedimiento", "archivo", "tipo", "ppu", "monto"];
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

async Task<JsonObject?> LeerJson(HttpRequest req)
{
    try { return (await JsonNode.ParseAsync(req.Body)) as JsonObject; }
    catch (JsonException) { return null; }
}

SqliteCommand Comando(SqliteConnection c, string sql, object?[] args)
{
    var cmd = c.CreateCommand();
    cmd.CommandText = sql;
    for (int i = 0; i < args.Length; i++) cmd.Parameters.AddWithValue("$p" + i, args[i] ?? DBNull.Value);
    return cmd;
}

void Ejecutar(SqliteConnection c, string sql, params object?[] args)
{
    using var cmd = Comando(c, sql, args);
    cmd.ExecuteNonQuery();
}

List<Dictionary<string, object?>> Consultar(SqliteConnection c, string sql, params object?[] args)
{
    using var cmd = Comando(c, sql, args);
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

string Param(int cantidad) => string.Join(",", Enumerable.Range(0, cantidad).Select(i => "$p" + i));
string Texto(JsonNode? n) => n is null ? "" : n.GetValueKind() == JsonValueKind.String ? n.GetValue<string>() : n.ToJsonString();
object Valor(string campo, JsonNode? n) => campo == "monto" ? (long.TryParse(Texto(n), out var m) ? m : 0L) : Texto(n);
string Usuario(HttpRequest req) => Uri.UnescapeDataString(req.Headers["X-Usuario"].FirstOrDefault() ?? "SIN NOMBRE");

// ---------- base de datos ----------
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
        CREATE TABLE IF NOT EXISTS historial(
          id INTEGER PRIMARY KEY AUTOINCREMENT, registro_id INTEGER, usuario TEXT,
          campo TEXT, antes TEXT, despues TEXT, fecha REAL);
        """);
    if ((long)Consultar(c, "SELECT COUNT(*) AS n FROM registros")[0]["n"]! == 0)
    {
        var src = Path.Combine(carpeta, "data.js");
        if (!File.Exists(src)) { Console.WriteLine("Falta data.js junto al .exe (datos iniciales del Excel)."); Console.ReadLine(); return; }
        var txt = File.ReadAllText(src);
        var filas = JsonNode.Parse(txt[txt.IndexOf('[')..(txt.LastIndexOf(']') + 1)])!.AsArray();
        using var tx = c.BeginTransaction();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"INSERT INTO registros({string.Join(",", campos)},creado_por) VALUES({Param(campos.Length)},'IMPORTACION')";
        var ps = campos.Select((_, i) => cmd.Parameters.Add("$p" + i, SqliteType.Text)).ToArray();
        foreach (var f in filas)
        {
            for (int i = 0; i < campos.Length; i++) ps[i].Value = Valor(campos[i], f![campos[i]]);
            cmd.ExecuteNonQuery();
        }
        tx.Commit();
        Console.WriteLine($"Base creada con {filas.Count} registros importados del Excel.");
    }
}

// ---------- servidor web ----------
var enRed = args.Contains("--red");
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = [], ContentRootPath = carpeta, WebRootPath = Path.Combine(carpeta, "web")
});
builder.WebHost.UseUrls(enRed ? "http://0.0.0.0:8765" : "http://127.0.0.1:8765");
builder.Logging.SetMinimumLevel(LogLevel.Warning);
var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/registros", (double? desde) =>
{
    using var c = Conectar();
    return Results.Json(new { ahora = Ahora(), filas = Consultar(c, "SELECT * FROM registros WHERE actualizado > $p0", desde ?? 0) });
});

app.MapGet("/api/historial/{id:long}", (long id) =>
{
    using var c = Conectar();
    return Results.Json(Consultar(c, "SELECT * FROM historial WHERE registro_id=$p0 ORDER BY fecha DESC", id));
});

app.MapPost("/api/registros", async (HttpRequest req) =>
{
    var d = await LeerJson(req);
    if (d is null) return Results.BadRequest(new { error = "JSON inválido" });
    var usuario = Usuario(req);
    var fecha = Texto(d["fecha"]);
    d["hoja"] = fecha.Length >= 4 ? fecha[..4] : DateTime.Now.ToString("yyyy");
    lock (candado)
    {
        using var c = Conectar();
        // correlativo asignado por el servidor: dos usuarios nunca reciben el mismo N°
        var max = Consultar(c, "SELECT MAX(CAST(n AS INTEGER)) AS m FROM registros WHERE hoja=$p0", Texto(d["hoja"]))[0]["m"];
        d["n"] = ((max is long m ? m : 0) + 1).ToString();
        object?[] valores = [.. campos.Select(k => Valor(k, d[k])), usuario, Ahora()];
        Ejecutar(c, $"INSERT INTO registros({string.Join(",", campos)},creado_por,actualizado) VALUES({Param(valores.Length)})", valores);
        var id = (long)Consultar(c, "SELECT last_insert_rowid() AS id")[0]["id"]!;
        Ejecutar(c, "INSERT INTO historial(registro_id,usuario,campo,antes,despues,fecha) VALUES($p0,$p1,'CREADO','',$p2,$p3)",
                 id, usuario, Texto(d["n"]), Ahora());
        return Results.Json(Consultar(c, "SELECT * FROM registros WHERE id=$p0", id)[0], statusCode: 201);
    }
});

app.MapPut("/api/registros/{id:long}", async (long id, HttpRequest req) =>
{
    var d = await LeerJson(req);
    if (d is null) return Results.BadRequest(new { error = "JSON inválido" });
    var usuario = Usuario(req);
    lock (candado)
    {
        using var c = Conectar();
        var viejos = Consultar(c, "SELECT * FROM registros WHERE id=$p0", id);
        if (viejos.Count == 0) return Results.NotFound();
        var viejo = viejos[0];
        // control de concurrencia: si otro usuario guardó después de que se abrió la ficha, no se pisa su cambio
        if (d["version"] is JsonNode ver && double.TryParse(Texto(ver), System.Globalization.CultureInfo.InvariantCulture, out var v)
            && Math.Abs(v - Convert.ToDouble(viejo["actualizado"] ?? 0.0)) > 1e-6)
            return Results.Json(new { error = "Otro usuario modificó este ingreso mientras lo editabas. Revisa los cambios y vuelve a guardar.", registro = viejo }, statusCode: 409);
        var cambios = d.Where(kv => campos.Contains(kv.Key) && kv.Key is not ("n" or "hoja")
                                    && Valor(kv.Key, kv.Value).ToString() != (viejo[kv.Key]?.ToString() ?? ""))
                       .ToDictionary(kv => kv.Key, kv => Valor(kv.Key, kv.Value));
        if (cambios.Count > 0)
        {
            var ahora = Ahora();
            var claves = cambios.Keys.ToList();
            var sets = string.Join(",", claves.Select((k, i) => $"{k}=$p{i}"));
            Ejecutar(c, $"UPDATE registros SET {sets}, actualizado=$p{claves.Count} WHERE id=$p{claves.Count + 1}",
                     [.. claves.Select(k => cambios[k]), ahora, id]);
            foreach (var k in claves)
                Ejecutar(c, "INSERT INTO historial(registro_id,usuario,campo,antes,despues,fecha) VALUES($p0,$p1,$p2,$p3,$p4,$p5)",
                         id, usuario, k, viejo[k]?.ToString() ?? "", cambios[k].ToString(), ahora);
        }
        return Results.Json(Consultar(c, "SELECT * FROM registros WHERE id=$p0", id)[0]);
    }
});

Console.WriteLine("Dashboard listo en http://localhost:8765" + (enRed ? "  (abierto a la red)" : ""));
Console.WriteLine("Deja esta ventana abierta. Cierrala para detener el sistema.");
if (!args.Contains("--sin-navegador"))
    try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("http://localhost:8765") { UseShellExecute = true }); } catch { }
app.Run();
