# Agenda de pagos — diseño

Fecha: 2026-11-05 · Estado: aprobado en conversación, pendiente de revisión escrita.

## Objetivo

Responder **"¿Me alcanza este mes?"**: con lo que tengo hoy (saldos de débito, efectivo) más lo que me van a pagar,
¿cubro lo que debo pagar? Si no, ¿cuánto falta, cuándo me quedo corto y qué puedo mover? Más recordatorios por
WhatsApp (Kapso) 7 y 2 días antes de cada pago, con un botón "Ya lo pagué".

- Nombre del módulo y del menú: **Agenda de pagos**. El tono de la página: **"¿Me alcanza?"**.
- Se lanza **sin avisos** (interruptor apagado). La integración con Kapso queda hecha: para encenderla solo se
  asigna el ID de plantilla y se activa el interruptor.

## Decisiones

| Tema | Decisión |
|---|---|
| Pagos de tarjeta de crédito | Se **sugieren solos**: cada tarjeta de crédito activa con día de pago aparece como pago por hacer, con monto estimado. |
| Dinero disponible | Saldo "hoy" por cada **tarjeta de débito** existente + **renglones libres** (efectivo, otra cuenta). |
| Periodo | **Mes calendario**, navegable con ‹ ›. |
| Repetición | Una vez · cada mes · cada quincena. |
| Destinatarios de WhatsApp | Cada usuario vincula **su** número y activa sus avisos. |
| Monedas | Nunca se mezclan: todo resultado es por moneda (como Planes). |
| Permisos | Todo filtrado por workspace; `viewer` ve pero no captura. Rutas con cuerpo usan `requireWorkspaceWithBody`. |
| Estrategia | Reglas deterministas, sin IA. |

Fuera de alcance (v1): IA para la estrategia, pagos mínimos de tarjeta, recurrencias distintas a mensual/quincenal,
avisos de cobros, notificaciones por otros canales.

## 1. Datos (una migración en `drizzle/`)

**`cash_balances`** — dinero disponible.
- `id`, `workspace_id`, `card_id` (nullable, tarjeta de débito; único), `label` (nullable, para renglones libres),
  `currency`, `amount_minor`, `updated_at`, `archived_at`.
- Exactamente uno de `card_id` / `label`. La moneda de un saldo de tarjeta es la de la tarjeta.

**`agenda_items`** — cobros y pagos.
- `id`, `workspace_id`, `kind` (`payable` | `receivable`), `description`, `amount_minor`, `currency`,
  `due_date` (`YYYY-MM-DD`), `recurrence` (`none` | `monthly` | `biweekly`),
  `status` (`pending` | `done` | `cancelled`), `done_at`, `done_by_user_id`, `done_via` (`web` | `whatsapp`),
  `card_id` (nullable: pago de tarjeta sugerido que se materializó), `created_at`, `updated_at`.
- Índice único parcial `(card_id, due_date)` para que un pago de tarjeta no se materialice dos veces.

**`user`** (columnas nuevas): `whatsapp_phone` (E.164, único), `whatsapp_verified_at`, `whatsapp_opt_in`
(defecto `true` al vincular).

**`whatsapp_link_codes`**: `code` (6 caracteres), `user_id`, `expires_at` (15 min), `used_at`.

**`agenda_notifications`** — idempotencia de avisos.
- `item_key` (id de `agenda_item`, o `card:<card_id>:<due_date>` para sugeridos), `user_id`,
  `offset` (`7d` | `2d`), `sent_at`, `kapso_message_id`, `error`. Único `(item_key, user_id, offset)`.

## 2. Cálculo de "¿Me alcanza?" (`src/lib/agenda/`, funciones puras con pruebas)

**Pago de tarjeta sugerido.** Para cada tarjeta de crédito activa con `payment_due_day`, por cada fecha de pago
que cae en el mes visible (`statementPeriod` / `dueDateFor` de `src/lib/spending/statement.ts`):
monto = `officialPayMinor` del corte capturado si existe; si no, el "Pago estimado del corte" de
`summarizeStatement`. Se calcula al vuelo y solo se guarda como `agenda_item` (con `card_id`) cuando el usuario
ajusta el monto, lo marca pagado o lo cancela; a partir de ahí manda la fila guardada.

**Repetición.** Al marcar `done` un registro con `recurrence ≠ none` se crea el siguiente `pending`:
`monthly` = mismo día del mes siguiente (si no existe, último día: 31 → 30/28); `biweekly` = +15 días.
Deshacer un `done` borra el siguiente solo si sigue `pending` sin cambios; si no, solo reabre.

**Resultado del mes visible, por moneda:**
- `disponible` = suma de `cash_balances` activos. Para meses futuros: saldo proyectado al cierre del mes anterior.
- `+ por cobrar` = `receivable` pendientes con fecha en el mes.
- `− por pagar` = `payable` pendientes del mes (incluye sugeridos de tarjeta) + pendientes **vencidos** de meses
  anteriores (siguen contando en el mes actual).
- `resultado = disponible + por cobrar − por pagar` → "Te sobran $X" (> 0), "Cierras en ceros" (= 0),
  "Te faltan $X" (< 0).

**Saldo proyectado diario.** Partiendo de `disponible` hoy, se recorren los días del mes aplicando cobros y
pagos en su fecha (vencidos = hoy). Alimenta el calendario y la estrategia.

**Estrategia (1–3 frases, en este orden de prioridad):**
1. Primer día con saldo < 0: "El {día} te quedas corto por {falta} para {pago}." Si hay un cobro posterior en el
   mes: "Tu cobro {x} de {monto} llega el {día}: si puedes, paga {pago} ese día o pide que te adelanten el cobro."
2. Cobros con fecha pasada aún pendientes: "{x} ({monto}) sigue sin cobrarse desde el {día}."
3. Si todo alcanza: "Vas bien. Lo más grande que viene: {pago}, {monto}, el {día}."

## 3. Pantalla `/app/agenda`

Menú: "Agenda de pagos", después de Planes, ícono `calendar` nuevo en `src/lib/icons.ts`; `NavKey` `agenda`.
Textos en `src/i18n/messages.ts` (es-MX, es, en) y ayudas en `src/i18n/help.ts`.

1. **"¿Me alcanza en {mes}?"** con ‹ ›; respuesta grande (verde / neutro / rojo) y línea de cuentas
   `disponible + por cobrar − por pagar`. Un bloque por moneda.
2. **Estrategia** (sección 2).
3. **Calendario** lunes–domingo: puntos rojos (pagos), verdes (cobros), grises (hechos) y saldo proyectado del día
   (rojo si < 0). Tocar un día filtra la lista. En móvil la cuadrícula se compacta.
4. **Lista del mes** por fecha: descripción, monto, fecha, etiqueta (vencido · en N días · cobrado · estimado del
   corte), acciones **Ya lo pagué / Ya lo cobré** (un toque, con "Deshacer"), editar, cancelar.
5. **Dinero disponible**: tarjetas de débito con "saldo hoy" y fecha; renglones libres ("+ Agregar efectivo u otra
   cuenta"); aviso "¿Sigue siendo así?" si un saldo tiene > 7 días.
6. **Avisos por WhatsApp** (solo si `WHATSAPP_NOTIFICATIONS` está encendido): vincular / desvincular número, activar
   o pausar mis avisos.

Formulario "+ Agregar": Pago | Cobro, descripción, monto (`parseMoneyInput`), fecha, repetición. Moneda por defecto
la del workspace/locale.

**API** (`src/pages/api/agenda/…`, validación en servidor, filtrado por workspace, `viewer` → 403):
- `POST /api/agenda/items`, `PATCH|DELETE /api/agenda/items/[id]` (DELETE = cancelar).
- `POST /api/agenda/items/[id]/done`, `POST /api/agenda/items/[id]/undo`.
- `POST /api/agenda/card-payments` (materializa un sugerido: `card_id`, `due_date`, y monto/acción).
- `PUT /api/agenda/balances` (saldo de tarjeta de débito o renglón libre), `DELETE /api/agenda/balances/[id]`.
- `POST /api/agenda/whatsapp/link` (genera código), `PATCH|DELETE /api/agenda/whatsapp` (opt-in / desvincular).

## 4. Kapso / WhatsApp

**Configuración** (patrón de `EMAIL_CAPTURE`, `src/lib/agenda/whatsapp-config.ts`):
- `vars`: `WHATSAPP_NOTIFICATIONS: "false"`, `KAPSO_REMINDER_TEMPLATE: ""`, `KAPSO_BUSINESS_PHONE: ""` (para `wa.me`).
- secretos: `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_WEBHOOK_SECRET`.
- Encender = asignar plantilla + interruptor `true` + desplegar. Con el interruptor apagado: no hay cron activo,
  la sección de WhatsApp no se muestra y el webhook responde 404.

**Vinculación** (sin plantilla de autenticación): "Vincular mi WhatsApp" genera un código de un solo uso (15 min)
y abre `wa.me/<KAPSO_BUSINESS_PHONE>?text=Vincular <código>`. El webhook recibe el mensaje, liga el número del
remitente al usuario del código y responde "Listo, te avisaré aquí" (dentro de la ventana de 24 h: texto libre).
Un número solo puede estar en un usuario; vincular otro usuario con el mismo número se rechaza.

**Cron** (`triggers.crons: ["0 15 * * *"]` = 9:00 CDMX; manejador `scheduled` en `src/worker.ts`):
1. Si el interruptor está apagado o falta configuración → no hace nada.
2. "Hoy" en `America/Mexico_City`. Busca `payable` pendientes (incluye sugeridos de tarjeta) con fecha = hoy+7 o
   hoy+2.
3. Por cada miembro del workspace con número verificado y `whatsapp_opt_in`: inserta primero la fila en
   `agenda_notifications` (si ya existe sin error → se salta), luego envía. Error de Kapso → se guarda en `error` y
   se reintenta en la siguiente corrida solo si la fecha objetivo sigue vigente (el aviso de 7 días no se manda tarde
   como si fuera de 7).

**Envío** (`src/lib/agenda/kapso.ts`): API compatible con Meta de Kapso con `X-API-Key`, plantilla
`KAPSO_REMINDER_TEMPLATE` con parámetros {descripción, monto formateado, fecha} y botón de respuesta rápida
"Ya lo pagué" cuya *payload* es un token HMAC-SHA256 (`KAPSO_WEBHOOK_SECRET`) sobre `item_key`.

**Webhook** `POST /api/kapso/webhook`:
- Verifica firma HMAC del cuerpo crudo con `KAPSO_WEBHOOK_SECRET`; inválida → 401. Comparación en tiempo constante
  (`timingSafeEqual` existente).
- Botón "Ya lo pagué": valida el token, que el remitente sea un usuario verificado miembro del workspace del
  registro, marca `done` (`done_via = whatsapp`, `done_by_user_id`), materializa si es sugerido de tarjeta y
  responde "Listo, marqué *{descripción}* como pagada ✅". Ya pagado → "Ya estaba registrado".
- Texto "Vincular CÓDIGO" → vinculación. Otro texto → respuesta corta de ayuda.
- Siempre responde 200 a Kapso tras procesar (para no provocar reintentos), salvo firma inválida.

**Pendiente de confirmar con el panel de Kapso al programar:** nombre exacto del encabezado de firma
(`X-Webhook-Signature` vs `X-Hub-Signature-256`), forma del payload del webhook y del envío de plantilla.

## 5. Errores y bordes

- Montos en unidades menores (enteros); decimales por moneda (`currencyDigits`).
- Tarjeta archivada → deja de sugerir pagos; sus `agenda_items` ya guardados se conservan.
- Cancelar un registro recurrente cancela solo esa ocurrencia (no genera la siguiente).
- Usuario que deja el workspace → deja de recibir avisos de ese workspace.
- Desvincular número → borra `whatsapp_phone` y `whatsapp_verified_at`.

## 6. Pruebas

- Unitarias (`tests/`): resultado y estrategia del mes; saldo proyectado; repetición mensual (31 → fin de mes) y
  quincenal; deshacer; selección de avisos 7d/2d con zona horaria; token HMAC (válido, alterado); verificación de
  firma.
- `pnpm smoke:agenda`: crear saldos, pagos y cobros, ver resultado en la página, marcar/deshacer, materializar un
  pago de tarjeta; cron y webhook contra un `fetch` falso de Kapso (envío, idempotencia, botón, vinculación).
