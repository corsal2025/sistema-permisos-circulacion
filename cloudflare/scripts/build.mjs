// Copia la interfaz a public/ y agrega cabeceras de seguridad. Solo se publican index.html, js/ y vendor/ (nunca data.js).
import { mkdirSync, copyFileSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const raiz = new URL('..', import.meta.url);
const pub = fileURLToPath(new URL('public/', raiz));
rmSync(pub, { recursive: true, force: true });
mkdirSync(pub, { recursive: true });
copyFileSync(fileURLToPath(new URL('../dashboard/index.html', raiz)), pub + 'index.html');
cpSync(fileURLToPath(new URL('../dashboard/vendor/', raiz)), pub + 'vendor/', { recursive: true });
cpSync(fileURLToPath(new URL('../dashboard/js/', raiz)), pub + 'js/', { recursive: true });
writeFileSync(pub + '_headers', `/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
`);
console.log('public/ listo');
