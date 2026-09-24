# Convierte CORRESPONDENCIA*.xlsx a data.js normalizado para el dashboard.
import openpyxl, re, json, glob, os, datetime
BASE = os.path.dirname(os.path.abspath(__file__))
src = glob.glob(os.path.join(BASE, '..', 'CORRESPONDENCIA*.xlsx'))[0]
wb = openpyxl.load_workbook(src, read_only=True, data_only=True)

ALIAS = {'FECHA':'fecha','PROCEDENCIA':'procedencia','DOCUMENTO':'documento','DOCTO':'documento',
 'PROV OF. PARTES':'prov','PROV. PARTES':'prov','MATERIA':'materia','DESTINO':'destinado',
 'DESTINADO A':'destinado','RECIBI CONFORME':'procedimiento','PROCEDIMIENTO':'procedimiento',
 'TRAMITE FINAL':'archivo','DESTINO DOCUMENTO':'archivo','DOCTO. CON PROBLEMAS':'problema'}
NOMBRES = {'ROSITA':'ROSA','SRA VIVIANA':'VIVIANA','SRA. VIVIANA':'VIVIANA'}
TIPOS = [('BLOQUEO',r'DESBLOQ'),('BLOQUEO',r'BLOQUE'),('TRASLADO',r'TRASLAD'),
 ('PAGO / FONDOS',r'CHEQUE|DEPOSITO|DEP[OÓ]SITO|TRANSFERENCIA|FONDOS|MONTO'),
 ('LEY 18.440',r'18\.?440|NO CIRCULAR'),('PRESCRIPCION',r'PRESCRIP'),('DEVOLUCION',r'DEVOLUC'),
 ('PLACAS PROVISORIAS',r'PLACA.{0,10}PROVISOR|PLACAS DE PRUEBA'),('MULTAS / RNMP',r'MULTA'),
 ('EXENTOS',r'EXENT'),('INE / ESTADISTICA',r'\bINE\b|ESTADIST'),('BAJA / ROBO',r'ROB|BAJA|SINIESTR')]
PPU = re.compile(r'\b([A-Z]{4}\s?-?\s?\d{2}|[A-Z]{2}\s?-?\s?\d{4}|[A-Z]{3}\s?-?\s?\d{3})(?:\s?[-*]\s?[\dK])?\b')
MONTO = re.compile(r'\$\s?([\d\.]{3,})')

def fecha(v):
    if isinstance(v, datetime.datetime): return v.strftime('%Y-%m-%d')
    m = re.search(r'(\d{1,2})[./-](\d{1,2})[./-](\d{2,5})', str(v or ''))
    if not m: return ''
    d, mo, y = int(m[1]), int(m[2]), m[3][-4:] if len(m[3])>=4 else '20'+m[3]
    if not (1<=d<=31 and 1<=mo<=12): return ''
    return f'{y}-{mo:02d}-{d:02d}'

rows = []
for ws in wb.worksheets:
    ym = re.search(r'(20\d\d)', ws.title)
    if not ym: continue
    hdr, idx = None, {}
    for r in ws.iter_rows(values_only=True):
        cells = [str(c).strip() if c is not None else '' for c in r]
        if hdr is None:
            if any(c.upper().startswith('FECHA') for c in cells):
                hdr = True
                for i,c in enumerate(cells):
                    k = ALIAS.get(c.upper().strip())
                    if k and k not in idx: idx[k] = i
            continue
        g = lambda k: cells[idx[k]] if k in idx and idx[k] < len(cells) else ''
        materia = g('materia')
        if not materia and not g('procedencia'): continue
        up = materia.upper()
        tipo = next((t for t,p in TIPOS if re.search(p, up)), 'OTROS')
        if tipo=='BLOQUEO' and 'DESBLOQ' in up: tipo='DESBLOQUEO'
        ppus = sorted({re.sub(r'[\s-]','',m[1]) for m in PPU.finditer(up)
                       if not re.fullmatch(r'(ORD|MAIL|ROL|PROV|MEMO|CART)\w*', re.sub(r'[\s-]','',m[1])[:4])})
        montos = [int(x.replace('.','')) for x in MONTO.findall(materia) if x.replace('.','').isdigit()]
        dest = re.sub(r'\s*\d{1,2}\.\d{1,2}\.\d{2,4}.*','', g('destinado').upper()).replace('EL','').strip()
        dest = NOMBRES.get(dest, dest)
        proc = g('procedimiento')
        f = fecha(g('fecha'))
        rows.append({'n': cells[0], 'hoja': ym[1], 'fecha': f, 'proc_': g('procedencia'),
            'doc': g('documento'), 'materia': materia, 'dest': dest, 'procedimiento': proc,
            'archivo': g('archivo'), 'tipo': tipo, 'ppu': ' '.join(ppus), 'monto': sum(montos),
            'estado': 'CERRADO' if proc.strip() else 'PENDIENTE'})

with open(os.path.join(BASE,'data.js'),'w',encoding='utf-8') as fh:
    fh.write('window.DATA=' + json.dumps(rows, ensure_ascii=False, separators=(',',':')) + ';')
print(len(rows), 'registros')
