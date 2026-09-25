// Extrae los datos de un oficio a partir de su texto (PDF digital u OCR de un escaneo).
// Pensado para el formato habitual de la correspondencia pública chilena:
//   ORD. N° 455 / ANT.: ... / MAT.: ... / QUILPUÉ, 12 de marzo de 2026 / DE: ... / A: ...
// Se usa en el navegador (window.leerOficio) y en las pruebas con Node (module.exports).
(function (raiz) {
  const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
    septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

  // Mismo criterio que convertir.py y el formulario.
  const TIPOS = [['DESBLOQUEO', /DESBLOQ/], ['BLOQUEO', /BLOQUE/], ['TRASLADO', /TRASLAD/],
    ['PAGO / FONDOS', /CHEQUE|DEP[OÓ]SITO|TRANSFERENCIA|FONDOS|MONTO/], ['LEY 18.440', /18\.?440|NO CIRCULAR/],
    ['PRESCRIPCION', /PRESCRIP/], ['DEVOLUCION', /DEVOLUC/], ['PLACAS PROVISORIAS', /PLACA.{0,10}PROVISOR|PLACAS DE PRUEBA/],
    ['MULTAS / RNMP', /MULTA/], ['EXENTOS', /EXENT/], ['INE / ESTADISTICA', /\bINE\b|ESTADIST/], ['BAJA / ROBO', /\bROB[OA]|\bBAJA\b|SINIESTR/]];

  // Patentes: 4 letras + 2 números (actual), 2 letras + 4 números (antigua), 3 letras + 3 números (motos antiguas).
  const PPU = /\b([A-Z]{4}\s?[-·.]?\s?\d{2}|[A-Z]{2}\s?[-·.]?\s?\d{4}|[A-Z]{3}\s?[-·.]?\s?\d{3})(?:\s?[-*]\s?[\dK])?\b/g;
  const NO_PPU = /^(ORD|MAIL|ROL|PROV|MEMO|CART|RUT|FONO|CASA|DPTO|OF|RES|LEY|ART|INC|ANT|MAT)/;

  const INSTITUCIONES = [
    [/SERVICIO\s+DE\s+IMPUESTOS\s+INTERNOS|\bS\.?I\.?I\.?\b/, 'SII'],
    [/TESORER[IÍ]A\s+GENERAL/, 'TESORERIA GENERAL'],
    [/SERVICIO\s+DE\s+REGISTRO\s+CIVIL|REGISTRO\s+CIVIL/, 'REGISTRO CIVIL'],
    [/JUZGADO\s+DE\s+POLIC[IÍ]A\s+LOCAL[A-ZÁÉÍÓÚÑ ]*/, null],
    [/CARABINEROS\s+DE\s+CHILE/, 'CARABINEROS DE CHILE'],
    [/CONTRALOR[IÍ]A\s+GENERAL[A-ZÁÉÍÓÚÑ ]*/, null],
    [/MINISTERIO\s+DE\s+TRANSPORTES[A-ZÁÉÍÓÚÑ ]*/, null],
    [/SEREMI\s+DE\s+TRANSPORTES[A-ZÁÉÍÓÚÑ ]*/, null],
  ];

  const limpiar = s => s.replace(/\s+/g, ' ').trim();
  const sinTildes = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const dos = n => String(n).padStart(2, '0');

  function fecha(t) {
    const hoy = new Date().getFullYear();
    const valida = (y, m, d) => y >= 2000 && y <= hoy + 1 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
    let m = sinTildes(t).match(/\b(\d{1,2})\s*(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s*(?:de[l]?\s+)?(\d{4})\b/i);
    if (m && valida(+m[3], MESES[m[2].toLowerCase()], +m[1])) return `${m[3]}-${dos(MESES[m[2].toLowerCase()])}-${dos(m[1])}`;
    for (m of t.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})\b/g)) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      if (valida(y, +m[2], +m[1])) return `${y}-${dos(m[2])}-${dos(m[1])}`;
    }
    return '';
  }

  function documento(t) {
    const m = t.match(/\b(ORD(?:INARIO)?|OF(?:ICIO)?|MEMO(?:R[AÁ]NDUM)?|RES(?:OLUCI[OÓ]N)?(?:\s+EXENTA)?|CARTA|CIRCULAR)\s*\.?\s*(?:N\s*[°º*"'?o.]?\s*)?[:]?\s*(\d{1,6}(?:\s*[/-]\s*\d{2,4})?)\b/i);
    if (!m) return '';
    const tipo = m[1].toUpperCase().startsWith('ORD') ? 'ORD.' : m[1].toUpperCase().startsWith('OF') ? 'OF.'
      : m[1].toUpperCase().startsWith('MEMO') ? 'MEMO' : m[1].toUpperCase().startsWith('RES') ? (/EXENTA/i.test(m[1]) ? 'RES. EX.' : 'RES.')
      : m[1].toUpperCase();
    return `${tipo} ${m[2].replace(/\s+/g, '')}`;
  }

  function materia(t) {
    const m = t.match(/\bMAT(?:ERIA)?\s*\.?\s*:\s*([\s\S]+?)(?=\n\s*(?:ANT|REF|INCL|ADJ|FECHA|DE|A|PARA|SE[ÑN]OR(?:A|ES)?)\s*\.?\s*:|\n[^\n]{0,40},\s*\d{1,2}\s+de\s+[a-záéíóú]+|\n\s*\n|$)/i);
    return m ? limpiar(m[1]).slice(0, 400) : '';
  }

  function procedencia(t) {
    const u = t.toUpperCase();
    // Si hay un "DE:" explícito, manda sobre el membrete.
    const de = u.match(/\n\s*DE\s*:\s*([^\n]+)/);
    const zonas = de ? [de[1], u] : [u];
    for (const z of zonas) {
      const mun = z.match(/(?:I\.\s*)?(?:ILUSTRE\s+)?MUNICIPALIDAD\s+DE\s+([A-ZÁÉÍÓÚÑ]+(?:\s+(?:DEL?|LA|LOS|LAS|[A-ZÁÉÍÓÚÑ]{3,}))*)/);
      if (mun) return 'MUNICIPALIDAD DE ' + limpiar(mun[1]).replace(/\s+(DIRECCI[OÓ]N|DEPARTAMENTO|OFICINA|SECCI[OÓ]N|ORD|OF|MAT|ANT)\b.*$/, '');
      for (const [re, nombre] of INSTITUCIONES) {
        const x = z.match(re);
        if (x) return nombre || limpiar(x[0]);
      }
    }
    return de ? limpiar(de[1]).slice(0, 120) : '';
  }

  function patentes(t) {
    const out = new Set();
    for (const m of t.toUpperCase().matchAll(PPU)) {
      const p = m[1].replace(/[\s\-·.]/g, '');
      // "DE 2026", "EN 2025": palabra de dos letras seguida de un año, no es patente antigua
      if (!NO_PPU.test(p) && !/^(DE|EN|AL|EL|LA|LO|DEL|Y)(19|20)\d{2}$/.test(p)) out.add(p);
    }
    return [...out];
  }

  function montos(t) {
    return [...t.matchAll(/\$\s?(\d{1,3}(?:\.\d{3})+|\d{3,})/g)].map(m => +m[1].replace(/\./g, ''));
  }

  function tipo(t) {
    const u = t.toUpperCase();
    return (TIPOS.find(([, re]) => re.test(u)) || ['OTROS'])[0];
  }

  function leerOficio(texto) {
    const t = String(texto || '').replace(/\r/g, '');
    const mat = materia(t);
    // La materia es lo más confiable para clasificar; si no hay, se usa todo el texto.
    const base = mat || t;
    const pp = patentes(base).length ? patentes(base) : patentes(t);
    const mm = montos(base);
    return {
      fecha: fecha(t),
      doc: documento(t),
      proc_: procedencia(t),
      materia: mat,
      ppu: pp.join(' '),
      monto: mm.length ? mm.reduce((a, b) => a + b, 0) : 0,
      tipo: tipo(base),
    };
  }

  raiz.leerOficio = leerOficio;
  raiz.detectarTipo = tipo;
  raiz.detectarPatentes = patentes;
  if (typeof module !== 'undefined') module.exports = { leerOficio, detectarTipo: tipo, detectarPatentes: patentes };
})(typeof window !== 'undefined' ? window : globalThis);
