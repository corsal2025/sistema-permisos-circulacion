// Pruebas del lector de oficios (dashboard/js/leer-oficio.js) con textos de ejemplo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { leerOficio } = createRequire(import.meta.url)('../dashboard/js/leer-oficio.js');

test('oficio municipal típico (PDF digital)', () => {
  const r = leerOficio(`ILUSTRE MUNICIPALIDAD DE QUILPUÉ
DIRECCIÓN DE TRÁNSITO Y TRANSPORTE PÚBLICO

ORD. N° 455

ANT.: Su presentación de fecha 02.03.2026.
MAT.: Solicita traslado de permiso de circulación
      del vehículo PPU KJPB-54 a esta comuna.

QUILPUÉ, 12 de marzo de 2026

DE: DIRECTOR DE TRÁNSITO MUNICIPALIDAD DE QUILPUÉ
A: DIRECTOR DE TRÁNSITO MUNICIPALIDAD DE VIÑA DEL MAR`);
  assert.equal(r.fecha, '2026-03-12');
  assert.equal(r.doc, 'ORD. 455');
  assert.equal(r.proc_, 'MUNICIPALIDAD DE QUILPUÉ');
  assert.equal(r.materia, 'Solicita traslado de permiso de circulación del vehículo PPU KJPB-54 a esta comuna.');
  assert.equal(r.ppu, 'KJPB54');
  assert.equal(r.tipo, 'TRASLADO');
});

test('oficio de Tesorería con monto y fecha numérica', () => {
  const r = leerOficio(`TESORERÍA GENERAL DE LA REPÚBLICA
OFICIO N° 1234/2026
MAT.: Informa transferencia de fondos por pago de permiso de circulación PPU HVCT51,
por un monto de $ 45.000.
Valparaíso, 05/08/2026`);
  assert.equal(r.fecha, '2026-08-05');
  assert.equal(r.doc, 'OF. 1234/2026');
  assert.equal(r.proc_, 'TESORERIA GENERAL');
  assert.equal(r.ppu, 'HVCT51');
  assert.equal(r.monto, 45000);
  assert.equal(r.tipo, 'PAGO / FONDOS');
});

test('texto de OCR con ruido: espacios de más y sin tildes', () => {
  const r = leerOficio(`I. MUNICIPALIDAD DE VILLA ALEMANA
ORD . No 88
MAT . : Solicita desbloqueo de  permiso de
circulacion vehiculo placa patente BB 1234 y FDKT 12
VILLA ALEMANA,  3 de septiembre del 2026`);
  assert.equal(r.fecha, '2026-09-03');
  assert.equal(r.doc, 'ORD. 88');
  assert.equal(r.proc_, 'MUNICIPALIDAD DE VILLA ALEMANA');
  assert.equal(r.ppu, 'BB1234 FDKT12');
  assert.equal(r.tipo, 'DESBLOQUEO');
});

test('juzgado y Ley 18.440', () => {
  const r = leerOficio(`JUZGADO DE POLICÍA LOCAL DE LIMACHE
Oficio 77-2026
MAT.: Comunica prohibición de circular Ley 18.440 vehículo PPU GHJK-21-3.
Limache, 1 de julio de 2026`);
  assert.equal(r.proc_, 'JUZGADO DE POLICÍA LOCAL DE LIMACHE');
  assert.equal(r.ppu, 'GHJK21');
  assert.equal(r.tipo, 'LEY 18.440');
  assert.equal(r.doc, 'OF. 77-2026');
});

test('no confunde números de documento con patentes', () => {
  const r = leerOficio('MAT.: Responde ORD 1234 y MEMO 56 sobre consulta general. ROL 123456.');
  assert.equal(r.ppu, '');
  assert.equal(r.tipo, 'OTROS');
});

test('texto vacío o sin datos no falla', () => {
  assert.deepEqual(leerOficio(''), { fecha: '', doc: '', proc_: '', materia: '', ppu: '', monto: 0, tipo: 'OTROS' });
  const r = leerOficio('Hola, adjunto documento. Saludos.');
  assert.equal(r.fecha, '');
  assert.equal(r.proc_, '');
});

test('salida real del OCR (N° leído como N*, fecha partida en dos líneas)', () => {
  const r = leerOficio(`ILUSTRE MUNICIPALIDAD DE VILLA ALEMANA
DIRECCIÓN DE TRÁNSITO Y TRANSPORTE PÚBLICO
ORD. N* 88
ANT:: Su presentación.
MAT: Solicita bloqueo de permiso de
circulación vehículo PPU HVCT-51 por
deuda.
VILLA ALEMANA, 3 de septiembre de
2026
DE: DIRECTOR DE TRÁNSITO MUNICIPALIDAD DE VILLA ALEMANA`);
  assert.equal(r.doc, 'ORD. 88');
  assert.equal(r.fecha, '2026-09-03');
  assert.equal(r.proc_, 'MUNICIPALIDAD DE VILLA ALEMANA');
  assert.equal(r.materia, 'Solicita bloqueo de permiso de circulación vehículo PPU HVCT-51 por deuda.');
  assert.equal(r.ppu, 'HVCT51');
  assert.equal(r.tipo, 'BLOQUEO');
});
