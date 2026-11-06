# Agenda de pagos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Módulo "Agenda de pagos" (`/app/agenda`) que responde "¿Me alcanza este mes?" con saldos, cobros y pagos (incluidos pagos de tarjeta sugeridos), calendario y estrategia; más recordatorios por WhatsApp vía Kapso (7 y 2 días antes, botón "Ya lo pagué") detrás de un interruptor apagado.

**Architecture:** Sigue el patrón de `src/lib/goals/`: lógica pura en `src/lib/agenda/compute.ts` (probada con vitest), acceso a D1 en `repo.ts`, validación en `validation.ts`, rutas en `src/pages/api/agenda/`, página Astro SSR. Kapso vive en `src/lib/agenda/kapso.ts` + `whatsapp.ts`; el cron es un manejador `scheduled` en `src/worker.ts` junto al `email` existente.

**Tech Stack:** Astro 7 SSR en Cloudflare Workers, D1 + Drizzle (`pnpm db:generate`), vitest, smoke en Python contra `astro dev`, Web Crypto (HMAC) del runtime.

**Spec:** `docs/superpowers/specs/2026-11-05-agenda-de-pagos-design.md`

## Global Constraints

- Nombre de módulo/menú: "Agenda de pagos"; tono de la página: "¿Me alcanza?". Textos en `src/i18n/messages.ts` para es-MX, es y en.
- Montos siempre en unidades menores enteras; captura con `parseMoneyInput`, formato con `formatMinor`; nunca se suman monedas distintas.
- Todo query filtra por `workspace_id`. Rutas con cuerpo: `requireWorkspaceWithBody` (consume el cuerpo antes de rechazar); `viewer` → 403 `READ_ONLY`.
- Fechas `YYYY-MM-DD` como texto. "Hoy" de la página: `todayISO()`; "hoy" del cron: fecha en `America/Mexico_City`.
- Interruptor `WHATSAPP_NOTIFICATIONS` (defecto `"false"`): apagado ⇒ cron no hace nada, sección de WhatsApp oculta, webhook 404.
- Config Kapso: vars `KAPSO_REMINDER_TEMPLATE`, `KAPSO_BUSINESS_PHONE`; secretos `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_WEBHOOK_SECRET`. Cron `"0 15 * * *"`.
- Avisos: offsets exactos 7 y 2 días; fila en `agenda_notifications` se inserta ANTES de enviar; única `(item_key, user_id, offset)`.
- Código de vinculación: 6 caracteres de `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, vence a los 15 minutos, un solo uso.
- D1 limita a 100 parámetros por consulta: inserciones masivas en lotes.
- No se agregan dependencias.

## Review Focus

1. **Mes con día inexistente** (pago mensual el 31, quincenal que cruza febrero): el siguiente cae en el último día del mes, nunca se salta un mes → pruebas en Task 2.
2. **Doble toque de "Ya lo pagué"** (web y WhatsApp, o dos miembros a la vez): se marca una sola vez y la repetición genera UN solo siguiente → `markDone` condicional `status='pending'` en Task 4, prueba en smoke Task 9.
3. **Pago de tarjeta sugerido que ya se pagó desde la web y luego se toca en WhatsApp** (o al revés): el índice único `(card_id, due_date)` evita duplicados; la segunda acción responde "Ya estaba registrado" → Task 4 y Task 8.
4. **Corrida del cron repetida el mismo día o fallo a mitad**: no hay aviso doble; un error de Kapso se reintenta solo mientras `hoy + offset == due_date` → Task 7.
5. **Número de WhatsApp de alguien que no es miembro del espacio del pago** (token reenviado): no marca nada → Task 8.

---

### Task 1: Esquema y migración

**Files:**
- Modify: `src/db/schema.ts` (columnas en `user`; tablas nuevas al final)
- Create: `drizzle/0011_*.sql` (generada)

**Interfaces:**
- Produces: tablas Drizzle `cashBalances`, `agendaItems`, `whatsappLinkCodes`, `agendaNotifications`; columnas `user.whatsappPhone`, `user.whatsappVerifiedAt`, `user.whatsappOptIn`. Tipos `AgendaItem = typeof agendaItems.$inferSelect`, `CashBalance`.

- [ ] **Step 1: Definir tablas en `src/db/schema.ts`** con los helpers `id()`, `createdAt()`, `updatedAt()` existentes:
  - `user`: `whatsappPhone text('whatsapp_phone').unique()`, `whatsappVerifiedAt integer timestamp_ms`, `whatsappOptIn integer boolean notNull default(true)`.
  - `cash_balances`: `id, workspaceId→workspaces, cardId→cards (nullable), label text nullable, currency notNull, amountMinor integer notNull, updatedAt, archivedAt`; `uniqueIndex('cash_balances_card_uq').on(cardId)`, `index` por workspace.
  - `agenda_items`: `id, workspaceId, kind enum ['payable','receivable'], description notNull, amountMinor notNull, currency notNull, dueDate text notNull, recurrence enum ['none','monthly','biweekly'] default 'none', status enum ['pending','done','cancelled'] default 'pending', doneAt timestamp_ms, doneByUserId→user nullable, doneVia enum ['web','whatsapp'] nullable, cardId→cards nullable, previousId text nullable (registro que lo generó por repetición), createdAt, updatedAt`; `uniqueIndex('agenda_items_card_due_uq').on(cardId, dueDate)` (SQLite permite múltiples NULL), `index('agenda_items_ws_due_idx').on(workspaceId, dueDate)`.
  - `whatsapp_link_codes`: `code text primaryKey, userId→user (cascade), expiresAt timestamp_ms notNull, usedAt timestamp_ms`.
  - `agenda_notifications`: `id, workspaceId, itemKey text notNull, userId→user (cascade), offset enum ['7d','2d'], sentAt timestamp_ms, kapsoMessageId text, error text, createdAt`; `uniqueIndex('agenda_notifications_uq').on(itemKey, userId, offset)`.
- [ ] **Step 2: Generar migración**: `pnpm db:generate` → crea `drizzle/0011_*.sql`. Revisar que solo contenga `CREATE TABLE`/`ALTER TABLE ADD` (nada de recrear tablas existentes).
- [ ] **Step 3: Aplicar en local**: `pnpm db:migrate:local` → "Migrations applied". `pnpm typecheck` → sin errores.
- [ ] **Step 4: Commit** `feat(agenda): esquema de saldos, agenda y avisos`.

### Task 2: Cálculo puro de "¿Me alcanza?"

**Files:**
- Create: `src/lib/agenda/compute.ts`
- Test: `tests/agenda.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Recurrence = 'none' | 'monthly' | 'biweekly';
  export interface Entry { key: string; kind: 'payable' | 'receivable'; description: string; amountMinor: number; currency: string; dueDate: string; status: 'pending' | 'done' | 'cancelled'; suggested: boolean }
  export function nextDueDate(dueDate: string, recurrence: Exclude<Recurrence, 'none'>, anchorDay: number): string
  export interface DayPoint { date: string; balanceMinor: number; entries: Entry[] }
  export interface MonthResult { currency: string; availableMinor: number; receivableMinor: number; payableMinor: number; resultMinor: number; days: DayPoint[]; strategy: StrategyLine[] }
  export type StrategyLine =
    | { kind: 'short'; date: string; shortMinor: number; payable: string; nextReceivable: { description: string; amountMinor: number; date: string } | null }
    | { kind: 'overdue_receivable'; description: string; amountMinor: number; date: string }
    | { kind: 'ok'; biggest: { description: string; amountMinor: number; date: string } | null };
  export function monthResult(input: { month: string; todayISO: string; availableMinor: number; currency: string; entries: Entry[] }): MonthResult
  export function monthResults(input: { month: string; todayISO: string; balances: { currency: string; amountMinor: number }[]; entries: Entry[] }): MonthResult[]
  ```
  `anchorDay` = día del mes del primer registro de la serie (para que 31→30→31 no se "encoja").

- [ ] **Step 1: Escribir pruebas** en `tests/agenda.test.ts`:
  - `nextDueDate('2026-01-31','monthly',31)` → `'2026-02-28'`; `nextDueDate('2026-02-28','monthly',31)` → `'2026-03-31'`; `nextDueDate('2028-01-31','monthly',31)` → `'2028-02-29'`.
  - `nextDueDate('2026-02-20','biweekly',20)` → `'2026-03-07'`.
  - `monthResult` con disponible 8_000_00, cobro 5_000_00 el 20, pagos 6_000_00 el 18 y 3_000_00 el 25, hoy `2026-11-10`, mes `2026-11`: `resultMinor === 4_000_00`; día 18 `balanceMinor === 2_000_00`; `strategy[0].kind === 'ok'` con `biggest.description` del pago de 6_000_00.
  - Mismo caso con pago el 18 de 9_000_00: día 18 `balanceMinor === -1_000_00`; `strategy[0]` = `{ kind:'short', date:'2026-11-18', shortMinor:1_000_00, nextReceivable:{date:'2026-11-20',…} }`; `resultMinor === 1_000_00`.
  - Pago `pending` con fecha `2026-10-30` (vencido) cuenta en el mes actual y se aplica el día de hoy; en un mes pasado o futuro no.
  - Cobro `pending` con fecha anterior a hoy produce línea `overdue_receivable`.
  - Entradas `done`/`cancelled` no suman. `resultMinor === 0` es posible (no se considera faltante).
  - Mes futuro (`2026-12` con hoy en noviembre): `availableMinor` = saldo proyectado al cierre de noviembre (cálculo de `monthResults` encadenando meses desde el actual).
  - `monthResults` con saldos MXN y USD devuelve dos resultados y nunca mezcla.
- [ ] **Step 2: Correr** `pnpm test tests/agenda.test.ts` → FAIL (módulo no existe).
- [ ] **Step 3: Implementar** en `src/lib/agenda/compute.ts`. Reusar `addDays`/`cutoffInMonth` de `src/lib/spending/statement.ts` y `shiftMonth` de `src/lib/spending/analysis.ts`. Saldo diario: los vencidos y lo de hoy se aplican en `todayISO`; recorrer días desde `max(primer día del mes, hoy)` hasta fin de mes. Estrategia: a lo más una línea `short` (el primer día < 0) + hasta dos `overdue_receivable`; `ok` solo si no hay `short`.
- [ ] **Step 4: Correr** `pnpm test tests/agenda.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(agenda): cálculo de ¿me alcanza?, saldo diario y estrategia`.

### Task 3: Pagos de tarjeta sugeridos

**Files:**
- Create: `src/lib/agenda/card-payments.ts`
- Modify: `tests/agenda.test.ts`

**Interfaces:**
- Consumes: `realCuts`, `statementPeriod`, `summarizeStatement`, `dueDateFor` (`src/lib/spending/statement.ts`); `listAccounts` (`src/lib/accounts/repo.ts`); `listCutoffs`, `movementsForAccount`, `getWorkspaceSettings` (`src/lib/spending/repo.ts`); `thresholdFor`.
- Produces:
  ```ts
  export interface CardDue { cardId: string; accountName: string; currency: string; cutMonth: string; from: string; to: string; dueDate: string; recordedPayMinor: number | null; previousOwedMinor: number | null }
  export function cardDuesInMonth(input: { cardId: string; accountName: string; currency: string; cutoffDay: number | null; paymentDueDay: number; cuts: RealCut[]; month: string; todayISO: string }): CardDue[]
  export interface SuggestedCardPayment { key: string /* `card:${cardId}:${dueDate}` */; cardId: string; description: string; amountMinor: number; currency: string; dueDate: string; basis: 'statement' | 'estimate' }
  export async function suggestedCardPayments(db: Db, workspaceId: string, month: string, todayISO: string): Promise<SuggestedCardPayment[]>
  ```

- [ ] **Step 1: Pruebas de `cardDuesInMonth`**:
  - Con un corte real `2026-10-28` y `paymentDueDay` 17 → mes `2026-11` devuelve un `CardDue` con `dueDate '2026-11-17'`, `from/to` del corte real y `recordedPayMinor` = `officialPayMinor`.
  - Sin corte real para el mes de pago (futuro) → se estima con `statementPeriod(cutoffDay, paymentDueDay, cutMonth, today)`; `recordedPayMinor === null`.
  - `paymentDueDay` presente pero `cutoffDay` null y sin cortes → `[]`.
- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar.** `cardDuesInMonth`: candidatos = cortes reales cuyo `dueDate` cae en `month`; si ninguno y `cutoffDay !== null`, probar `statementPeriod` para `shiftMonth(month,-1)` y `month` y quedarse con los de `dueDate` dentro del mes. `previousOwedMinor` = `officialPayMinor` del corte real anterior. `suggestedCardPayments`: por cuenta, tarjeta primaria = primera tarjeta de crédito no archivada con `paymentDueDay` (misma regla que `src/pages/app/gastos/corte.astro`); monto = `recordedPayMinor ?? summarizeStatement(movimientos del periodo, umbral, previousOwedMinor).payMinor`; `basis` según cuál se usó; omitir montos 0; `description` = nombre de la cuenta.
- [ ] **Step 4: Correr** → PASS. **Step 5: Commit** `feat(agenda): pagos de tarjeta sugeridos por corte`.

### Task 4: Repositorio, validación y API

**Files:**
- Create: `src/lib/agenda/repo.ts`, `src/lib/agenda/validation.ts`
- Create: `src/pages/api/agenda/items/index.ts` (POST), `src/pages/api/agenda/items/[id]/index.ts` (PATCH, DELETE), `src/pages/api/agenda/items/[id]/done.ts` (POST), `src/pages/api/agenda/items/[id]/undo.ts` (POST), `src/pages/api/agenda/card-payments.ts` (POST), `src/pages/api/agenda/balances/index.ts` (PUT), `src/pages/api/agenda/balances/[id].ts` (DELETE)
- Test: `tests/agenda.test.ts` (validación)

**Interfaces:**
- Consumes: `nextDueDate` (Task 2), `suggestedCardPayments` (Task 3).
- Produces (todas reciben `db, workspaceId` primero):
  ```ts
  validateItem(body, { locale, currency }): { ok: true; value: ItemValues } | { ok: false; errors: { field: string; code: string }[] }
  // ItemValues = { kind, description (1–120), amountMinor (>0), dueDate (fecha válida), recurrence }
  validateBalance(body, { locale, currency }): { ok: true; value: { cardId: string | null; label: string | null; amountMinor: number /* puede ser 0 o negativo (sobregiro) */ } } | …
  listAgenda(db, ws, { from: string; to: string }): Promise<AgendaItem[]>   // incluye pending vencidos con due_date < from
  createItem(db, ws, currency, value): Promise<string>
  updateItem(db, ws, id, value): Promise<boolean>
  cancelItem(db, ws, id): Promise<boolean>
  markDone(db, ws, id, by: { userId: string; via: 'web' | 'whatsapp' }): Promise<'done' | 'already' | 'not_found'>
  undoDone(db, ws, id): Promise<'reopened' | 'not_done' | 'not_found'>
  materializeCardPayment(db, ws, { cardId, dueDate, amountMinor?: number, action: 'adjust' | 'done' | 'cancel', by? }): Promise<{ id: string; result: 'done' | 'already' | 'saved' } | null>
  listBalances(db, ws): Promise<CashBalance[]>; upsertBalance(db, ws, value): Promise<string>; archiveBalance(db, ws, id): Promise<boolean>
  ```
- [ ] **Step 1: Pruebas de validación**: descripción vacía → `{field:'description',code:'required'}`; monto `"0"` → `amount/positive`; fecha `'2026-02-30'` → `dueDate/invalid`; `recurrence:'weekly'` → `recurrence/invalid`; monto `"1,234.50"` en es-MX → `123450`.
- [ ] **Step 2: Correr** → FAIL. **Step 3: Implementar** `validation.ts` (estilo de `src/lib/goals/validation.ts`) y `repo.ts`:
  - `markDone` es un `UPDATE … WHERE id=? AND workspace_id=? AND status='pending'`; si cambió 0 filas → `'already'`/`'not_found'`. Si cambió y `recurrence≠'none'`, en el mismo `db.batch` inserta el siguiente con `nextDueDate(dueDate, recurrence, anchorDay)` y `previousId = id`. `anchorDay` = `Number(root.dueDate.slice(8))`, donde `root` es el primer registro de la serie (seguir `previousId` hacia atrás).
  - `undoDone`: reabre (`status='pending'`, limpia `done*`) y borra el hijo con `previous_id = id` solo si sigue `pending` y `updated_at = created_at`.
  - `materializeCardPayment`: valida que `cardId` sea tarjeta de crédito del espacio y que `dueDate` sea una de `suggestedCardPayments` de su mes; `INSERT … ON CONFLICT(card_id, due_date) DO NOTHING`, luego aplica la acción sobre la fila existente.
  - `upsertBalance`: `cardId` debe ser tarjeta de **débito** del espacio (moneda = la de la tarjeta); renglón libre usa la moneda del espacio; `ON CONFLICT(card_id) DO UPDATE`.
- [ ] **Step 4: Rutas** siguiendo `src/pages/api/goals/index.ts`: `requireWorkspaceWithBody` → validar → repo → `json(201|200, …)`; no encontrado → 404 `NOT_FOUND`. DELETE usa `requireWorkspace(locals, request, { write: true })`.
- [ ] **Step 5: Correr** `pnpm test` y `pnpm typecheck` → PASS. **Step 6: Commit** `feat(agenda): API de pagos, cobros y saldos`.

### Task 5: Página `/app/agenda`, menú e i18n

**Files:**
- Create: `src/pages/app/agenda.astro`
- Modify: `src/lib/nav.ts` (`NavKey` + `'agenda'`, item después de `plans`), `src/lib/icons.ts` (ícono `calendar`), `src/i18n/messages.ts` (claves `nav.agenda`, `agenda.*` en los tres idiomas), `src/i18n/help.ts` (ayudas de "Disponible", "Por cobrar", "Por pagar", "Estimado del corte")

**Interfaces:**
- Consumes: `listAgenda`, `listBalances` (Task 4), `suggestedCardPayments` (Task 3), `monthResults` (Task 2), `whatsappEnabled` (Task 6, la sección se agrega en ese task).

- [ ] **Step 1: Página.** Parámetro `?mes=YYYY-MM` (defecto mes de `todayISO()`; inválido → actual). Carga entradas del mes + sugeridos de tarjeta que no estén materializados (por `key`), arma `Entry[]` y llama `monthResults`. Secciones en el orden del spec §3: encabezado con ‹ › y respuesta por moneda, estrategia, calendario lunes–domingo, lista, dinero disponible. Copias exactas (es-MX):
  - `agenda.title`: "¿Me alcanza en {month}?"
  - `agenda.result.surplus`: "Sí te alcanza: te sobran {amount}"; `agenda.result.zero`: "Justo: cierras en ceros"; `agenda.result.short`: "No te alcanza: te faltan {amount}"
  - `agenda.math`: "disponible {available} + por cobrar {receivable} − por pagar {payable}"
  - `agenda.strategy.short`: "El {date} te quedas corto por {amount} para {payable}."; `agenda.strategy.shortReceivable`: "Tu cobro {receivable} de {amount} llega el {date}: si puedes, paga {payable} ese día o pide que te adelanten el cobro."; `agenda.strategy.overdue`: "{receivable} ({amount}) sigue sin cobrarse desde el {date}."; `agenda.strategy.ok`: "Vas bien. Lo más grande que viene: {payable}, {amount}, el {date}."
  - Acciones: "Ya lo pagué", "Ya lo cobré", "Deshacer", "Estimado del corte", "¿Sigue siendo así?" (saldo con `updatedAt` > 7 días), "+ Agregar efectivo u otra cuenta", "+ Agregar".
- [ ] **Step 2: Interacción** con `<script>` del mismo estilo que `src/pages/app/metas.astro` (fetch a la API y `location.reload()`); tocar un día del calendario filtra la lista (atributo `data-date`, sin recarga). `viewer`: sin formularios ni botones.
- [ ] **Step 3: Menú, ícono, textos** en es-MX/es/en. `pnpm typecheck` → PASS (las claves de `messages.ts` son tipadas).
- [ ] **Step 4: Verificar en navegador**: `astro dev --background`, crear saldo, un pago y un cobro; ver resultado, calendario y estrategia; probar ancho móvil (375 px) sin scroll horizontal.
- [ ] **Step 5: Commit** `feat(agenda): página ¿Me alcanza? con calendario`.

### Task 6: Configuración WhatsApp, cliente Kapso, token y vinculación

**Files:**
- Create: `src/lib/agenda/whatsapp.ts`, `src/lib/agenda/kapso.ts`
- Create: `src/pages/api/agenda/whatsapp/link.ts` (POST), `src/pages/api/agenda/whatsapp/index.ts` (PATCH opt-in, DELETE desvincular)
- Modify: `wrangler.jsonc` (vars), `worker-configuration.d.ts` (`pnpm cf:types`), `src/pages/app/agenda.astro` (sección "Avisos por WhatsApp"), `README.md` (cómo encender)
- Test: `tests/agenda-whatsapp.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // whatsapp.ts
  export interface WhatsappConfig { apiKey: string; phoneNumberId: string; webhookSecret: string; template: string; businessPhone: string }
  export function whatsappEnabled(): boolean                       // WHATSAPP_NOTIFICATIONS === 'true'
  export function whatsappConfig(): WhatsappConfig | null           // null si apagado o falta algún valor
  export async function signItemToken(secret: string, itemKey: string): Promise<string>   // `${itemKey}.${hmacBase64url}`
  export async function verifyItemToken(secret: string, token: string): Promise<string | null>  // itemKey o null
  export function newLinkCode(): string
  export function parseLinkMessage(text: string): string | null     // "vincular 7kq2x9 " → "7KQ2X9"
  export async function createLinkCode(db, userId: string, now: Date): Promise<string>
  export async function redeemLinkCode(db, code: string, phone: string, now: Date): Promise<'linked' | 'invalid' | 'phone_taken'>
  // kapso.ts
  export async function sendReminder(cfg: WhatsappConfig, to: string, p: { description: string; amount: string; date: string; buttonPayload: string }, fetchFn?: typeof fetch): Promise<{ ok: true; messageId: string } | { ok: false; error: string }>
  export async function sendText(cfg: WhatsappConfig, to: string, text: string, fetchFn?: typeof fetch): Promise<boolean>
  ```
- [ ] **Step 1: Confirmar con el usuario en su panel de Kapso (Chrome)** la URL base de envío, el encabezado de auth, el JSON del envío de plantilla con botón de respuesta rápida y el nombre del encabezado de firma del webhook; anotarlos como comentario en `kapso.ts`. Si no hay acceso aún: usar la API compatible con Meta (`POST https://api.kapso.ai/meta/whatsapp/v24.0/{phoneNumberId}/messages`, `X-API-Key`) y dejar `// shortcut: formato tomado de la documentación pública, confirmar con el panel de Kapso antes de encender`.
- [ ] **Step 2: Pruebas**: `verifyItemToken(s, await signItemToken(s,'abc'))` → `'abc'`; token con un carácter cambiado → `null`; otro secreto → `null`; `parseLinkMessage('Vincular 7kq2x9')` → `'7KQ2X9'`, `parseLinkMessage('hola')` → `null`; `newLinkCode()` cumple `/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/`; `sendReminder` con `fetchFn` falso: verifica URL, encabezado de auth, que el cuerpo lleve `template.name === cfg.template`, los tres parámetros y la payload del botón; respuesta 500 → `{ ok:false }`.
- [ ] **Step 3: Correr** → FAIL. **Step 4: Implementar** (HMAC con `crypto.subtle`, comparación con `timingSafeEqual` de `src/lib/auth`). `redeemLinkCode`: código existe, no usado, no vencido; si el teléfono ya es de otro usuario → `'phone_taken'`; en un `db.batch` marca `used_at` y pone `whatsappPhone`, `whatsappVerifiedAt`, `whatsappOptIn=true`.
- [ ] **Step 5: Rutas**: `POST /api/agenda/whatsapp/link` → 404 si `!whatsappEnabled()`; devuelve `{ code, url: 'https://wa.me/'+businessPhone+'?text='+encodeURIComponent('Vincular '+code) }`. `PATCH` `{ optIn: boolean }`; `DELETE` limpia los tres campos. Son del usuario, no del espacio: permitidas también a `viewer` (usar `locals.user`, exigir `sameOrigin`).
- [ ] **Step 6: Sección en la página** (solo si `whatsappEnabled()`): estado vinculado/no, botón "Vincular mi WhatsApp" (abre la URL), "Pausar mis avisos"/"Activar", "Desvincular".
- [ ] **Step 7: `wrangler.jsonc`**: `WHATSAPP_NOTIFICATIONS: "false"`, `KAPSO_REMINDER_TEMPLATE: ""`, `KAPSO_BUSINESS_PHONE: ""` con comentario de cómo encender; `pnpm cf:types`. README: lista de secretos y pasos para encender.
- [ ] **Step 8: Correr** `pnpm test && pnpm typecheck` → PASS. **Commit** `feat(agenda): cliente Kapso, token firmado y vinculación de WhatsApp`.

### Task 7: Cron de recordatorios

**Files:**
- Create: `src/lib/agenda/reminders.ts`
- Modify: `src/worker.ts` (manejador `scheduled`), `wrangler.jsonc` (`"triggers": { "crons": ["0 15 * * *"] }`)
- Test: `tests/agenda-whatsapp.test.ts`

**Interfaces:**
- Consumes: `whatsappConfig`, `signItemToken`, `sendReminder` (Task 6); `suggestedCardPayments` (Task 3).
- Produces:
  ```ts
  export function mexicoCityToday(now: Date): string
  export function reminderOffset(todayISO: string, dueDate: string): '7d' | '2d' | null
  export async function runReminders(db: Db, cfg: WhatsappConfig, now: Date, fetchFn?: typeof fetch): Promise<{ sent: number; failed: number; skipped: number }>
  ```
- [ ] **Step 1: Pruebas**: `mexicoCityToday(new Date('2026-11-06T03:00:00Z'))` → `'2026-11-05'`; `reminderOffset('2026-11-05','2026-11-12')` → `'7d'`; `('2026-11-05','2026-11-07')` → `'2d'`; `('2026-11-05','2026-11-08')` → `null`.
- [ ] **Step 2: Correr** → FAIL. **Step 3: Implementar.** `runReminders`: por cada workspace con algún miembro con `whatsappVerifiedAt` y `whatsappOptIn`: pagos `pending` (items `payable` + sugeridos no materializados) con `reminderOffset ≠ null`; por destinatario: `INSERT … ON CONFLICT DO NOTHING` en `agenda_notifications`; si ya existía con `sent_at` → `skipped`; si existía con `error` → reintenta (mismo día hábil, porque el offset se recalcula con "hoy"). Envía; guarda `sentAt`+`kapsoMessageId` o `error`. Monto con `formatMinor` en el `locale` del usuario, fecha con `formatDate`.
- [ ] **Step 4: Worker**: `async scheduled(_event, _env, ctx) { const cfg = whatsappConfig(); if (cfg) ctx.waitUntil(runReminders(getDb(), cfg, new Date())); }`.
- [ ] **Step 5: Correr** `pnpm test && pnpm typecheck` → PASS. **Commit** `feat(agenda): cron diario de recordatorios por WhatsApp`.

### Task 8: Webhook de Kapso

**Files:**
- Create: `src/pages/api/kapso/webhook.ts` (POST)
- Modify: `src/lib/agenda/whatsapp.ts` (parseo de evento y firma), `src/middleware.ts` solo si la ruta exige excepción de sesión/origen
- Test: `tests/agenda-whatsapp.test.ts`

**Interfaces:**
- Consumes: `verifyItemToken`, `redeemLinkCode`, `parseLinkMessage`, `sendText` (Task 6); `markDone`, `materializeCardPayment` (Task 4).
- Produces:
  ```ts
  export async function verifyWebhookSignature(secret: string, rawBody: string, header: string | null): Promise<boolean>
  export type InboundEvent = { kind: 'button'; from: string; payload: string } | { kind: 'text'; from: string; text: string } | { kind: 'other' }
  export function parseInbound(body: unknown): InboundEvent[]
  ```
- [ ] **Step 1: Pruebas**: firma válida → `true`; cuerpo alterado → `false`; header ausente → `false`; `parseInbound` con fixture del payload confirmado en Task 6 Step 1 (guardar en `tests/fixtures/kapso-button.json` y `kapso-text.json`) devuelve el evento `button` con `payload` y `from` en E.164.
- [ ] **Step 2: Correr** → FAIL. **Step 3: Implementar la ruta**: `!whatsappEnabled()` → 404; leer `request.text()`; firma inválida → 401. Por evento:
  - `button`: `verifyItemToken` → `itemKey`; buscar usuario por `whatsappPhone = from` verificado; si `itemKey` es `card:…` materializar con `action:'done'`, si no `markDone(…, { userId, via:'whatsapp' })`, siempre validando que el usuario sea miembro del workspace del registro (si no → ignora). Responder con `sendText`: "Listo, marqué *{descripción}* como pagada ✅" o "Ya estaba registrado".
  - `text`: `parseLinkMessage` → `redeemLinkCode` → "Listo, te avisaré aquí" / "Ese código ya no es válido, genera otro en Don Bigo" / "Ese número ya está vinculado a otra persona". Otro texto → "Hola, soy Don Bigo. Aquí te aviso de tus pagos; administra tu agenda en donbigo.com/app/agenda".
  - Responder `200 {}` tras procesar. La ruta no usa sesión: confirmar que `src/middleware.ts` no la redirige a `/login` ni exige `Origin`.
- [ ] **Step 4: Correr** `pnpm test && pnpm typecheck` → PASS. **Commit** `feat(agenda): webhook de Kapso para "Ya lo pagué" y vinculación`.

### Task 9: Smoke de punta a punta y cierre

**Files:**
- Create: `scripts/smoke-agenda.py` (patrón de `scripts/smoke-goals.py`)
- Modify: `package.json` (`"smoke:agenda": "python3 -I scripts/smoke-agenda.py"`), `.dev.vars` local (encender `WHATSAPP_NOTIFICATIONS` y secretos de prueba; NO se commitea)

- [ ] **Step 1: Escribir el smoke** (D1 local vacía, `astro dev --background`). Comprobaciones:
  - Dueño crea saldo de débito, renglón libre, pago mensual el 31, cobro; `GET /app/agenda` muestra el resultado esperado (regex tolerante a `data-astro-source-*`).
  - Marcar el pago como hecho dos veces seguidas → segunda responde `already`; existe exactamente un siguiente con fecha fin de mes. Deshacer → el siguiente desaparece.
  - Pago de tarjeta sugerido: materializar `done` dos veces → una sola fila (`SELECT count(*)` vía `wrangler d1 execute --local`).
  - `viewer` recibe 403 en POST/PATCH/DELETE y ve la página.
  - Otro espacio no ve ni modifica registros ajenos (404).
  - Webhook: firma inválida → 401; texto "Vincular CÓDIGO" con firma válida liga el número; botón con token firmado marca el pago; botón con token de un registro de otro espacio no cambia nada. (Las respuestas salientes a Kapso fallan en local sin red real; el smoke solo verifica el estado en D1.)
- [ ] **Step 2: Correr** `pnpm smoke:agenda` → todas las líneas con ✓. Correr también `pnpm test`, `pnpm typecheck`, `pnpm smoke:spending` y `pnpm smoke:cards` (no regresión).
- [ ] **Step 3: Commit** `test(agenda): smoke de agenda y webhook`.
