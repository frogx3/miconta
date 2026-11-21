# Don Bigo

Seguimiento de deudas a plazos (meses sin intereses, meses con intereses y pagos fijos de tarjetas) a partir
de lo que el banco deja descargar (CSV o PDF del estado de cuenta), más agenda de pagos, gastos hormiga,
categorías y metas. Producción: **https://donbigo.com**. Uso personal y familiar hoy; camino a beta pública
y membresías.

Antes se llamó **miconta** y luego **MiConta**: el repositorio, el Worker, la D1 (`miconta`), el R2
(`miconta-files`), la cola (`miconta-backups`), los archivos `public/brand/miconta-icon*.png` y la clave
`localStorage` `miconta-theme` conservan el nombre antiguo **a propósito**. No renombrarlos.

Documentos de referencia: [README.md](README.md) (desarrollo, despliegue, secretos, seguridad),
[PRODUCT.md](PRODUCT.md) (usuarios, principios, terminología), [DESIGN.md](DESIGN.md) (sistema visual),
[docs/plan-de-actualizacion.md](docs/plan-de-actualizacion.md) (fases hacia membresías),
[docs/plan-rediseno.md](docs/plan-rediseno.md) (rediseño y beta pública), maquetas en `docs/propuestas/`,
specs y planes en `docs/superpowers/`.

## Producto

- **Sigue deudas, no gastos.** El *plan* es el objeto central; los movimientos del banco solo son la fuente.
- **El usuario manda.** La app sugiere (p. ej. qué cargo es la siguiente mensualidad) y nunca aplica sola.
  Todo parámetro de un plan es editable a mano y cada cambio queda en su historial (valor anterior/nuevo +
  comentario). Los pagos nunca se borran.
- **Los datos no se pierden.** Cuentas, tarjetas y planes se archivan o liquidan, no se borran (una tarjeta
  sin historial sí se puede quitar). Deshacer solo la **última** carga de cada cuenta; se bloquea (409
  `PLANS_CHANGED`) si un plan cambió después.
- **Periodo = corte, no mes.** Las vistas nuevas se calculan por corte de tarjeta, no por mes calendario.
- **Calma, no culpa.** Voz cercana, español de México, sin jerga bancaria. Primero el celular, a una mano.
- Nunca mezclar monedas en un resumen; los decimales los define la moneda de la tarjeta.

### Terminología (vinculante, también en i18n)

- **Usuario**: quien inicia sesión.
- **Cuenta** (`accounts`): lo que el banco identifica con un ID de cliente; agrupa tarjetas. El CSV/PDF se
  importa por cuenta. Banco desde el catálogo `src/lib/banks.ts` (`bank_id`).
- **Tarjeta** (`cards`): un solo plástico, físico o digital, crédito o débito, por sus últimos 4 dígitos.
  Límite, corte, día de pago y moneda viven en la tarjeta. Nunca decir "plástico".
- **Plan** (`plans`): MSI, meses con intereses o pago fijo; ligado a una tarjeta. «Fecha de compra» = fecha
  de operación del pago 1 (el banco la repite en cada mensualidad; la fecha de pago depende del corte).
- **Movimientos**: ligados a la cuenta y, por últimos 4 dígitos, a la tarjeta. Deduplicados por hash
  (tarjeta+fecha+concepto+referencia+cargo+abono + contador de ocurrencia).
- **Espacio** (workspace): cada usuario tiene uno; miembros con rol (`viewer` = solo lectura).
- **Admin**: gestiona el sistema en `/admin` (usuarios, invitaciones, borrados), **no** usa finanzas: no
  tiene espacio y `/app` lo redirige. Solo se eliminan usuarios sin información financiera; los demás se
  suspenden.

## Qué existe (en producción)

| Área | Ruta | Notas |
|---|---|---|
| Portada / resumen | `/app` | Próximos pagos en el encabezado (campana) |
| Cuentas y tarjetas | `/app/cuentas` | Corte real por periodo (`statement_cutoffs`, con `due_date`) |
| Planes | `/app/planes` | Escalera de compromisos y fecha de libertad; saldo reportado por el banco |
| Importar CSV | `/app/importar` | Perfil de columnas por encabezado; plantilla `public/plantillas/movimientos.csv` |
| Importar PDF | `/app/importar/pdf` | pdf.js en el navegador; la persona **siempre** elige tablas y columnas; compara contra la base y guarda solo lo aprobado como carga que se puede deshacer (llaves `pdf:`) |
| Historial de cargas | `/app/importar/historial` | Deshacer la última carga por cuenta |
| Gastos | `/app/gastos` (+ `corte`, `movimientos`, `categorias`) | Hormiga = cargo ≤ umbral que no es de un plan; intereses/IVA separados; reglas por subcadena (sin regex), con nombre propio |
| Agenda «¿Me alcanza?» | `/app/agenda` | Saldo global con historial (`balance_movements`); resultado = disponible − por pagar (los cobros cuentan al marcarlos) |
| Metas | `/app/metas` | Por fecha de cargo |
| Tu cuenta | `/app/cuenta` | Respaldo CSV por cola, Reboot, borrar cuenta (stand-by 30 días), miembros |
| Bienvenida | `/app/bienvenida` | Wizard tras canjear el código de acceso |
| Acceso | `/acceso`, `/login`, `/registro` | Invitación con código de un solo uso (48 h) por SMTP |
| Admin | `/admin` | Crear/editar/suspender/eliminar usuarios, estatus de invitaciones |

También: Web App instalable + **push** (7 d, 2 d, hoy, vencidos, día después del corte; a las 9 de la zona
del usuario, cron cada hora), zona horaria por usuario (`user.time_zone`), tema Claro/Oscuro/Auto, ayuda
contextual (`src/i18n/help.ts`), i18n es-MX/es/en (`src/i18n`).

**Hecho pero apagado:** captura por correo (`EMAIL_CAPTURE=false`; los bancos ya no mandan avisos) y avisos
por WhatsApp con Kapso (`WHATSAPP_NOTIFICATIONS=false`; pasos para encender en el README).

## Lo que sigue

- **Rediseño + beta pública** (`docs/plan-rediseno.md`, sin programar): «Pide tu invitación» en la landing
  crea un usuario `pending`; el admin aprueba en «Cuentas por aprobar» y se manda la invitación con código.
- **Membresías** (`docs/plan-de-actualizacion.md`): Estándar gratis / Profesional (actual + MCP) / Premium
  (IA). Fases: API REST de lectura → MCP de lectura → cobro → IA → conectores CFDI → .ics/webhooks.
  Desde agentes nunca escritura directa: solo propuestas.
- Pendientes sueltos: corregir desde las diferencias del PDF (montos distintos, sobrantes), incluir el
  historial de saldo en el respaldo CSV.

## Stack y código

Astro 7 SSR en Cloudflare Workers (`src/worker.ts`: fetch, `scheduled` para el cron, `queue` para respaldos,
`email`), D1 + Drizzle (`src/db/schema.ts`, migraciones en `drizzle/`), R2 para archivos originales,
Better Auth (correo y contraseña + plugin admin; `src/lib/auth`), Montserrat autoalojada. Sin framework de
UI: componentes `.astro` y scripts en `src/scripts`. Lógica de dominio en `src/lib/<área>` con pruebas en
`tests/`.

Reglas del código:

- Todo filtrado por el espacio activo. Rutas con cuerpo usan `requireWorkspaceWithBody` (consume el cuerpo
  antes de rechazar; evita 500 intermitentes en dev).
- El servidor **vuelve a leer** archivos y decisiones; el navegador solo aporta elecciones.
- Escrituras de varias filas en una transacción `db.batch`. D1 limita a 100 parámetros por consulta.
- Nada de regex escrita por el usuario en el servidor (riesgo ReDoS): texto plano / subcadenas.
- D1 no deja apagar llaves foráneas: migraciones que reconstruyen tablas se escriben a mano (copia a `bk_*`).
- CSP solo en builds de producción. `session: false` e `imageService: 'passthrough'` en `astro.config`
  evitan los bindings KV que el adaptador activa solo.

## Desarrollo

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

- `pnpm test`, `pnpm typecheck`, `pnpm db:generate`.
- `pnpm smoke:*` necesitan la D1 local **vacía** y el servidor en el puerto 4321: respaldar
  `.wrangler/state` antes y restaurarlo después (la base local tiene datos de prueba). Al reiniciar la base,
  borrar solo `.wrangler/state`, no `.wrangler`. Si astro arranca en 4322, hay un `workerd` viejo.
- En `astro dev` el HTML lleva atributos `data-astro-source-*`: las comprobaciones sobre HTML usan regex
  tolerante a atributos.
- `tests/fixtures/movements-sample.csv` está ignorado por git (datos reales).

## Despliegue (solo cuando el usuario lo pida)

1. `npx wrangler whoami` debe mostrar la cuenta **personal** (id `f862968900755169ee91638d284d290f`), no la
   de empresas/clientes. Si no, pedir `wrangler logout && wrangler login`.
2. Si hay migraciones: respaldo primero
   (`pnpm exec wrangler d1 export miconta --remote --output backups/prod-pre-XXXX-<fecha>.sql`), luego
   `pnpm db:migrate:remote`.
3. `pnpm cf:deploy` (no `pnpm deploy`). Revertir: `pnpm exec wrangler rollback`.

Correr migración y deploy como pasos separados. Escribir en la D1 de producción requiere el sí explícito del
usuario. No rotar `BETTER_AUTH_SECRET` ni las claves VAPID. Secretos locales en `.secrets.production`
(ignorado por git).

## Marca y diseño

- Navy `#1D3557` y dorado `#C5A047` son marca y no se quitan. El dorado no va como texto sobre claro (solo
  relleno/borde, "logro"); excepción: «Bigo» del wordmark (`.brand-bigo`).
- Claro: papel cálido, navy que enmarca (encabezado/pie). Oscuro: fondos grafito cálido, **nunca** navy de
  fondo; navy/dorado solo como acento; avisos en coral `#EC7272`. Acompañantes: salvia, terracota, cielo,
  marfil. Sin sombras; rojo solo para errores.
- Cambios de paleta: proponer y mostrar en local antes, esperar aprobación.
- Mascota: schnauzer navy con moño dorado (`docs/brand/mascota/`, recortes en `docs/propuestas/assets/`).
  Con mesura: una vez por pantalla (saludo, vacíos, logros), nunca decoración repetida. El logo sigue
  siendo `public/brand/miconta-icon*.png`.

## Forma de trabajar

- Pedir justificación/confirmar antes de decisiones de diseño grandes.
- Ramas + PR por cambio; `main` = producción.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
