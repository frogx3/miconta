import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Convenciones:
 * - Montos en unidades menores enteras (centavos) + código de moneda ISO; nunca floats.
 * - Fechas de calendario como texto ISO (YYYY-MM-DD); instantes como timestamp en ms.
 * - Nada se borra: planes y movimientos se liquidan/revierten y todo cambio queda en `plan_events`.
 *   Por eso las FK usan `restrict` y no existen rutas de borrado para esas tablas.
 * - Todo dato pertenece a un espacio (`workspace`); los usuarios son miembros con un rol.
 */

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);
const updatedAt = () =>
  integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
    .$onUpdate(() => new Date());

// ── Autenticación (tablas de Better Auth + plugin admin; conciliadas con `auth generate`) ──────

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  /** Rol global de la plataforma: 'admin' accede al panel de administración. */
  role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
  banned: integer('banned', { mode: 'boolean' }).notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: integer('ban_expires', { mode: 'timestamp_ms' }),
  locale: text('locale').notNull().default('es-MX'),
  /** Zona horaria IANA elegida en Tu cuenta; sin ella se usa la que Cloudflare deduce de la IP. */
  timeZone: text('time_zone'),
  /** Teléfono de WhatsApp vinculado (formato E.164); único entre usuarios. */
  whatsappPhone: text('whatsapp_phone'),
  whatsappVerifiedAt: integer('whatsapp_verified_at', { mode: 'timestamp_ms' }),
  whatsappOptIn: integer('whatsapp_opt_in', { mode: 'boolean' }).notNull().default(true),
  /** Avisos dentro de la app (banda de "hoy toca pagar" y respaldos listos). */
  inAppNotifications: integer('in_app_notifications', { mode: 'boolean' }).notNull().default(true),
  /** El usuario pidió borrar su cuenta: queda sin acceso y se purga a los 30 días salvo que un admin la restablezca. */
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('user_whatsapp_phone_uq').on(t.whatsappPhone)]);

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /** Admin que está suplantando esta sesión (plugin admin). */
    impersonatedBy: text('impersonated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Límite de intentos (login, registro) guardado en D1: la memoria de un Worker no se comparte. */
export const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
});

// ── Espacios (personal / familiar) ───────────────────────────────────────────────────────────────

export const workspaces = sqliteTable('workspaces', {
  id: id(),
  name: text('name').notNull(),
  /** Idioma + región: define textos, formato de fechas/números y moneda por defecto. */
  locale: text('locale').notNull().default('es-MX'),
  defaultCurrency: text('default_currency').notNull().default('MXN'),
  /**
   * Umbral de "gasto hormiga" en unidades menores de `defaultCurrency`: un cargo igual o menor, que no
   * pertenezca a un plan, cuenta como hormiga. Si es nulo se usa el valor por defecto de la moneda.
   */
  antThresholdMinor: integer('ant_threshold_minor'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
    role: text('role', { enum: ['owner', 'admin', 'member', 'viewer'] }).notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index('workspace_members_user_idx').on(t.userId)],
);

/**
 * Invitaciones a un espacio. El enlace lleva un token aleatorio de un solo uso; aquí solo se guarda su
 * huella (SHA-256), así que nadie con acceso a la base puede reconstruir un enlace vigente.
 */
export const workspaceInvitations = sqliteTable(
  'workspace_invitations',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    /** Rol que tendrá quien acepte; nunca 'owner'. */
    role: text('role', { enum: ['admin', 'member', 'viewer'] }).notNull(),
    createdBy: text('created_by').notNull().references(() => user.id, { onDelete: 'restrict' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    usedAt: integer('used_at', { mode: 'timestamp_ms' }),
    usedBy: text('used_by').references(() => user.id, { onDelete: 'restrict' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('workspace_invitations_token_uq').on(t.tokenHash), index('workspace_invitations_workspace_idx').on(t.workspaceId)],
);

// ── Cuentas y tarjetas ───────────────────────────────────────────────────────────────────────────

/**
 * Cuenta: lo que el banco identifica con un ID de cliente. Agrupa todas sus tarjetas (débito,
 * débito digital, crédito, crédito digital, varias de crédito...). Los CSV se importan por cuenta.
 */
export const accounts = sqliteTable(
  'accounts',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    /** Nombre personalizado: "Mi Banorte", "Nómina", etc. */
    name: text('name').notNull(),
    bank: text('bank').notNull(),
    /** ID de cliente ante el banco (opcional, informativo). */
    customerId: text('customer_id'),
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('accounts_workspace_idx').on(t.workspaceId)],
);

/**
 * Tarjeta: un plástico (físico o digital), identificado por sus últimos 4 dígitos. Una tarjeta es
 * un solo plástico; una cuenta puede tener varias. Cada tarjeta lleva su propia moneda y, si es de
 * crédito, su límite y fechas de corte y pago. Planes y movimientos se ligan a la tarjeta.
 */
export const cards = sqliteTable(
  'cards',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: ['credit', 'debit'] }).notNull().default('credit'),
    isDigital: integer('is_digital', { mode: 'boolean' }).notNull().default(false),
    /** Últimos 4 dígitos; solo nulo en tarjetas migradas que nunca tuvieron terminación. */
    last4: text('last4'),
    /** Etiqueta opcional: "Física", "Compras en línea"... */
    label: text('label'),
    currency: text('currency').notNull(),
    creditLimitMinor: integer('credit_limit_minor'),
    /** Día del mes del corte (1-31). */
    cutoffDay: integer('cutoff_day'),
    paymentDueDay: integer('payment_due_day'),
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('cards_account_last4_uq').on(t.accountId, t.last4), index('cards_workspace_idx').on(t.workspaceId)],
);

// ── Importación ──────────────────────────────────────────────────────────────────────────────────

/** Perfil de lectura del CSV de una cuenta (ver `ImportProfile` en src/lib/import/types.ts). */
export const importProfiles = sqliteTable(
  'import_profiles',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    config: text('config', { mode: 'json' }).notNull(),
    headerFingerprint: text('header_fingerprint'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('import_profiles_account_idx').on(t.accountId)],
);

export const importBatches = sqliteTable(
  'import_batches',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'restrict' }),
    profileId: text('profile_id').references(() => importProfiles.id, { onDelete: 'restrict' }),
    fileName: text('file_name').notNull(),
    /** Llave del archivo original en R2, para auditar o reprocesar. */
    fileKey: text('file_key'),
    /** Fecha del último corte hasta la que el usuario descargó el archivo. */
    cutoffDate: text('cutoff_date'),
    summary: text('summary', { mode: 'json' }),
    status: text('status', { enum: ['applied', 'reverted'] }).notNull().default('applied'),
    /**
     * `manual` / `email` = lote que agrupa los movimientos capturados a mano o recibidos por correo de una cuenta;
     * no es una carga y no aparece en el historial.
     */
    source: text('source', { enum: ['csv', 'manual', 'email'] }).notNull().default('csv'),
    createdBy: text('created_by').notNull().references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    revertedAt: integer('reverted_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('import_batches_account_idx').on(t.accountId, t.createdAt)],
);

/**
 * Corte real de una cuenta, capturado del estado de cuenta del banco. El día de corte de la tarjeta
 * solo estima: los bancos cortan en fechas que varían (4-sep, 2-oct) y el CSV trae la fecha de operación,
 * no la de cargo, así que un periodo puede necesitar un primer día propio (`startDate`).
 */
export const statementCutoffs = sqliteTable(
  'statement_cutoffs',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'restrict' }),
    cutoffDate: text('cutoff_date').notNull(),
    startDate: text('start_date'),
    /** "Pago para no generar intereses" del estado de cuenta, en unidades menores. */
    officialPayMinor: integer('official_pay_minor'),
    /** Fecha límite de pago del estado de cuenta; nula = se estima con el día de pago de la tarjeta (Banorte: corte + 20 días). */
    dueDate: text('due_date'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('statement_cutoffs_account_date_uq').on(t.accountId, t.cutoffDate)],
);

// ── Metas ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Metas del espacio. Cuatro tipos: `debt_free` (terminar todos los planes de la moneda antes de una fecha),
 * `payoff_plan` (liquidar un plan antes de una fecha), `ant_spend` (tope mensual de gasto hormiga) y `savings`
 * (monto objetivo con aportes capturados a mano). El avance no se guarda: se calcula con los datos vigentes.
 */
export const goals = sqliteTable(
  'goals',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    type: text('type', { enum: ['debt_free', 'payoff_plan', 'ant_spend', 'savings'] }).notNull(),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    /** Fecha objetivo (todas menos `ant_spend`; en `savings` es opcional). */
    targetDate: text('target_date'),
    /** Monto objetivo: tope mensual en `ant_spend`, meta en `savings`. */
    targetAmountMinor: integer('target_amount_minor'),
    /** Plan a liquidar (solo `payoff_plan`). */
    planId: text('plan_id').references(() => plans.id, { onDelete: 'restrict' }),
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
    createdBy: text('created_by').notNull().references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('goals_workspace_idx').on(t.workspaceId)],
);

/** Aportes (o retiros, en negativo) de una meta de ahorro. */
export const goalEntries = sqliteTable(
  'goal_entries',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    goalId: text('goal_id').notNull().references(() => goals.id, { onDelete: 'restrict' }),
    amountMinor: integer('amount_minor').notNull(),
    date: text('date').notNull(),
    note: text('note'),
    createdBy: text('created_by').notNull().references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [index('goal_entries_goal_idx').on(t.goalId, t.date)],
);

// ── Categorías, etiquetas, movimientos ───────────────────────────────────────────────────────────

export const categories = sqliteTable(
  'categories',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    color: text('color'),
    /** Presupuesto mensual de la categoría, en unidades menores de la moneda del espacio; nulo = sin presupuesto. */
    budgetMinor: integer('budget_minor'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('categories_workspace_name_uq').on(t.workspaceId, t.name)],
);

/**
 * Reglas de categorización: si el concepto normalizado CONTIENE `pattern`, el movimiento va a la
 * categoría. Solo subcadenas (sin regex): una expresión del usuario ejecutada en el servidor podría
 * bloquear un Worker. Gana el patrón más largo (el más específico).
 */
export const categoryRules = sqliteTable(
  'category_rules',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    /** Nula si la regla solo renombra. */
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'restrict' }),
    pattern: text('pattern').notNull(),
    /** Nombre propio que se muestra en lugar del concepto del banco ("AMZN MKTP" → "Amazon"); nulo = no renombra. */
    name: text('name'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('category_rules_workspace_pattern_uq').on(t.workspaceId, t.pattern), index('category_rules_category_idx').on(t.categoryId)],
);

export const tags = sqliteTable(
  'tags',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    color: text('color'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('tags_workspace_name_uq').on(t.workspaceId, t.name)],
);

/** Planes de pago: lo que realmente se administra (MSI, meses con intereses, pagos fijos). */
export const plans = sqliteTable(
  'plans',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    cardId: text('card_id').notNull().references(() => cards.id, { onDelete: 'restrict' }),
    type: text('type', { enum: ['msi', 'mci', 'fixed'] }).notNull(),
    name: text('name').notNull(),
    /** Texto que identifica al comercio en los cargos mensuales del CSV. */
    matchText: text('match_text').notNull(),
    currency: text('currency').notNull(),
    totalAmountMinor: integer('total_amount_minor').notNull(),
    installmentAmountMinor: integer('installment_amount_minor').notNull(),
    totalInstallments: integer('total_installments').notNull(),
    /** Mensualidades ya cobradas. */
    paidInstallments: integer('paid_installments').notNull().default(0),
    /** Tasa anual en puntos base (0 para MSI). */
    interestRateBp: integer('interest_rate_bp').notNull().default(0),
    /** Fecha del primer cargo; los siguientes recurren el mismo día de cada mes. */
    firstChargeDate: text('first_charge_date').notNull(),
    /**
     * Saldo pendiente que reportó el banco (CSV de planes) y las mensualidades pagadas en ese momento.
     * Mientras no haya más pagos se muestra tal cual; después se le restan las mensualidades nuevas.
     */
    reportedBalanceMinor: integer('reported_balance_minor'),
    reportedBalanceDate: text('reported_balance_date'),
    reportedBalancePaid: integer('reported_balance_paid'),
    status: text('status', { enum: ['active', 'completed_natural', 'settled_manual', 'review'] }).notNull().default('active'),
    settledAt: integer('settled_at', { mode: 'timestamp_ms' }),
    /** Cómo se liquidó cuando no fue de forma natural (abono, liquidación anticipada...). */
    settlementNote: text('settlement_note'),
    /** Campos editados a mano (JSON: string[]); una carga futura avisa en vez de pisarlos. */
    overriddenFields: text('overridden_fields', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('plans_workspace_status_idx').on(t.workspaceId, t.status), index('plans_card_idx').on(t.cardId)],
);

export const planTags = sqliteTable(
  'plan_tags',
  {
    planId: text('plan_id').notNull().references(() => plans.id, { onDelete: 'restrict' }),
    tagId: text('tag_id').notNull().references(() => tags.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.planId, t.tagId] })],
);

export const movements = sqliteTable(
  'movements',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'restrict' }),
    /** Tarjeta que hizo el cargo, según los últimos 4 dígitos del CSV; nulo si el archivo no la trae. */
    cardId: text('card_id').references(() => cards.id, { onDelete: 'restrict' }),
    batchId: text('batch_id').notNull().references(() => importBatches.id, { onDelete: 'restrict' }),
    /** `${hash}#${ocurrencia}`; único por cuenta, evita duplicar al subir rangos traslapados. */
    uniqueKey: text('unique_key').notNull(),
    date: text('date').notNull(),
    description: text('description').notNull(),
    descriptionNorm: text('description_norm').notNull(),
    reference: text('reference'),
    chargeMinor: integer('charge_minor').notNull().default(0),
    creditMinor: integer('credit_minor').notNull().default(0),
    currency: text('currency').notNull(),
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'restrict' }),
    /** Plan al que pertenece este cargo y qué mensualidad representa. */
    planId: text('plan_id').references(() => plans.id, { onDelete: 'restrict' }),
    planInstallmentNo: integer('plan_installment_no'),
    /**
     * Corte al que se contabiliza este movimiento, como el mes en que cierra (`YYYY-MM`). Nulo = el que le toca por su fecha.
     * El CSV solo trae la fecha de operación y el banco arma el estado de cuenta por fecha de cargo, así que un movimiento de
     * los últimos días de un corte puede caer en el siguiente; este campo permite corregirlo a mano.
     */
    statementMonth: text('statement_month'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('movements_account_key_uq').on(t.accountId, t.uniqueKey),
    index('movements_workspace_date_idx').on(t.workspaceId, t.date),
    index('movements_plan_idx').on(t.planId),
    index('movements_batch_idx').on(t.batchId),
  ],
);

/** Historial de cada plan: creación, mensualidades vinculadas, ediciones, liquidación, reversiones. */
export const planEvents = sqliteTable(
  'plan_events',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    planId: text('plan_id').notNull().references(() => plans.id, { onDelete: 'restrict' }),
    type: text('type', {
      enum: ['created', 'installment_recorded', 'edited', 'status_changed', 'settled', 'reverted', 'balance_reported'],
    }).notNull(),
    /** Detalle estructurado: campos antes/después, número de mensualidad, etc. */
    data: text('data', { mode: 'json' }),
    comment: text('comment'),
    movementId: text('movement_id').references(() => movements.id, { onDelete: 'restrict' }),
    batchId: text('batch_id').references(() => importBatches.id, { onDelete: 'restrict' }),
    actorUserId: text('actor_user_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [index('plan_events_plan_idx').on(t.planId, t.createdAt)],
);

// ── Captura por correo ───────────────────────────────────────────────────────────────────────────

/**
 * Dirección de reenvío de una cuenta: el usuario reenvía ahí las notificaciones de su banco. El token es
 * el secreto de la dirección (`<token>@<dominio de entrada>`); regenerarlo invalida la anterior.
 * Don Bigo nunca accede a la bandeja del usuario: solo recibe lo que su filtro reenvía.
 */
export const emailInboxes = sqliteTable(
  'email_inboxes',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'restrict' }),
    token: text('token').notNull(),
    /** Dominios con firma DKIM válida cuyos avisos se aplican solos; el resto espera revisión. */
    trustedDomains: text('trusted_domains', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    createdBy: text('created_by').notNull().references(() => user.id, { onDelete: 'restrict' }),
    disabledAt: integer('disabled_at', { mode: 'timestamp_ms' }),
    lastReceivedAt: integer('last_received_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('email_inboxes_account_uq').on(t.accountId), uniqueIndex('email_inboxes_token_uq').on(t.token)],
);

/**
 * Bitácora de cada correo recibido y qué se hizo con él. Del correo solo se guardan remitente, asunto y
 * los datos leídos; el original se guarda en R2 únicamente si no se pudo leer (`rawKey`).
 */
export const emailMessages = sqliteTable(
  'email_messages',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    inboxId: text('inbox_id').notNull().references(() => emailInboxes.id, { onDelete: 'restrict' }),
    /** Message-ID del correo (o huella del contenido): evita procesar dos veces el mismo aviso. */
    messageKey: text('message_key').notNull(),
    fromAddress: text('from_address').notNull(),
    subject: text('subject').notNull(),
    /** Dominios con firma DKIM válida según el servidor que recibió el correo. */
    dkimDomains: text('dkim_domains', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    status: text('status', { enum: ['applied', 'duplicate', 'review', 'unknown_card', 'unparsed', 'confirmation', 'dismissed'] }).notNull(),
    /** Datos leídos del aviso (`EmailNotice`), o el código de confirmación de reenvío. */
    data: text('data', { mode: 'json' }),
    movementId: text('movement_id').references(() => movements.id, { onDelete: 'restrict' }),
    rawKey: text('raw_key'),
    receivedAt: createdAt(),
  },
  (t) => [uniqueIndex('email_messages_inbox_key_uq').on(t.inboxId, t.messageKey), index('email_messages_inbox_idx').on(t.inboxId, t.receivedAt)],
);

/** Saldo disponible por tarjeta/cuenta (o libre con `label`) para la agenda de pagos. */
export const cashBalances = sqliteTable(
  'cash_balances',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    cardId: text('card_id').references(() => cards.id, { onDelete: 'restrict' }),
    label: text('label'),
    currency: text('currency').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    updatedAt: updatedAt(),
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
  },
  (t) => [uniqueIndex('cash_balances_card_uq').on(t.cardId), index('cash_balances_ws_idx').on(t.workspaceId)],
);

/** Pagos por hacer y cobros por recibir. */
export const agendaItems = sqliteTable(
  'agenda_items',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: ['payable', 'receivable'] }).notNull(),
    description: text('description').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    /** Fecha de vencimiento YYYY-MM-DD. */
    dueDate: text('due_date').notNull(),
    recurrence: text('recurrence', { enum: ['none', 'monthly', 'biweekly'] }).notNull().default('none'),
    status: text('status', { enum: ['pending', 'done', 'cancelled'] }).notNull().default('pending'),
    doneAt: integer('done_at', { mode: 'timestamp_ms' }),
    doneByUserId: text('done_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    doneVia: text('done_via', { enum: ['web', 'whatsapp'] }),
    cardId: text('card_id').references(() => cards.id, { onDelete: 'restrict' }),
    /** Registro que generó este por repetición. */
    previousId: text('previous_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Varios NULL en cardId están permitidos (SQLite): solo evita duplicar el mismo pago de tarjeta por corte.
  (t) => [uniqueIndex('agenda_items_card_due_uq').on(t.cardId, t.dueDate), index('agenda_items_ws_due_idx').on(t.workspaceId, t.dueDate)],
);

/** Códigos de un solo uso para vincular WhatsApp. */
export const whatsappLinkCodes = sqliteTable('whatsapp_link_codes', {
  code: text('code').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp_ms' }),
});

/** Navegadores suscritos a notificaciones push (uno por dispositivo); se borran cuando el servicio responde 404/410. */
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: id(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('push_subscriptions_endpoint_uq').on(t.endpoint), index('push_subscriptions_user_idx').on(t.userId)],
);

/** Avisos enviados (evita duplicados por elemento, usuario, anticipación y canal). */
export const agendaNotifications = sqliteTable(
  'agenda_notifications',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    itemKey: text('item_key').notNull(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    offset: text('offset', { enum: ['7d', '2d', '0d', 'overdue', 'cutoff'] }).notNull(),
    channel: text('channel', { enum: ['whatsapp', 'push'] }).notNull().default('whatsapp'),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    kapsoMessageId: text('kapso_message_id'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('agenda_notifications_uq').on(t.itemKey, t.userId, t.offset, t.channel)],
);

export type AgendaItem = typeof agendaItems.$inferSelect;
export type CashBalance = typeof cashBalances.$inferSelect;

/** Respaldos CSV pedidos desde Tu cuenta; los genera la cola `miconta-backups` y los archivos viven en R2. */
export const backupExports = sqliteTable(
  'backup_exports',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'restrict' }),
    requestedBy: text('requested_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['queued', 'running', 'ready', 'failed'] }).notNull().default('queued'),
    error: text('error'),
    createdAt: createdAt(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    /** Cuándo vio el aviso "respaldo listo" quien lo pidió. */
    seenAt: integer('seen_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('backup_exports_ws_idx').on(t.workspaceId, t.createdAt)],
);

export type BackupExport = typeof backupExports.$inferSelect;
