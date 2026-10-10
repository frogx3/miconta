import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { cards, importBatches, importProfiles, movements, planEvents, plans } from '../../db/schema';
import type { Db } from '../auth/hooks';
import type { AccountWithCards, Card } from '../accounts/repo';
import { lastCutoffDate } from '../cutoff';
import { currencyDigits, toInputString } from '../money-format';
import { validatePlanDraft, type PlanDraft, type PlanFieldError } from '../plans/validation';
import { matchCategory } from '../spending/categorize';
import { loadRules } from '../spending/repo';
import { parseCsv } from './csv';
import { isValidISODate } from './dates';
import { parseImport } from './parse';
import { sanitizeProfile } from './profile-input';
import { detectProfile, headerFingerprint } from './profile';
import { matchPlanInstallments, planHints, scheduledDate, type InstallmentMatch, type MissingInstallment, type PlanHint, type PlanLike } from './plans';
import type { CardKind, ImportField, ImportProfile, NormalizedMovement, RowError } from './types';

export const MAX_FILE_CHARS = 2_000_000;
const MAX_ROWS = 5000;
const SAMPLE_ROWS = 5;
/**
 * D1 admite como máximo 100 parámetros por consulta: los movimientos (17 columnas) se insertan
 * en bloques pequeños, todos dentro de la misma transacción (`db.batch`).
 */
const MOVEMENT_ROWS_PER_INSERT = 5;

export interface PreviewMovement {
  key: string;
  line: number;
  date: string;
  description: string;
  reference: string | null;
  chargeMinor: number;
  creditMinor: number;
  /** Cargo en el formato del locale, listo para precargar el formulario de un plan. */
  chargeInput: string;
  cardLast4: string | null;
  cardKind: CardKind | null;
  status: 'new' | 'duplicate';
  hints: PlanHint[];
}

export interface PreviewResult {
  profile: ImportProfile;
  profileSource: 'saved' | 'detected' | 'custom';
  /** El perfil no es fiable todavía: el usuario debe revisar el mapeo de columnas. */
  needsMapping: boolean;
  headers: string[];
  sampleRows: string[][];
  ambiguousDateFormats: string[];
  missingFields: ImportField[];
  headerChanged: boolean;
  errors: RowError[];
  summary: { total: number; fresh: number; duplicates: number; errors: number };
  movements: PreviewMovement[];
  /** Moneda con la que se lee el archivo (la de las tarjetas de la cuenta). */
  currency: string;
  /** La cuenta tiene tarjetas activas en monedas distintas: un archivo se lee en una sola moneda. */
  mixedCurrencies: boolean;
  /** Terminaciones de tarjeta que trae el archivo y si la cuenta ya las tiene. */
  cards: { last4: string; kind: CardKind | null; exists: boolean }[];
  planMatches: (InstallmentMatch & { planName: string; amountMinor: number; totalInstallments: number })[];
  missingInstallments: (MissingInstallment & { planName: string })[];
  coverageEnd: string | null;
  cutoffSuggestion: string | null;
}

export class ImportInputError extends Error {
  constructor(public code: 'FILE_TOO_LARGE' | 'TOO_MANY_ROWS') {
    super(code);
  }
}

const today = () => new Date().toISOString().slice(0, 10);

const activeCards = (account: AccountWithCards): Card[] => account.cards.filter((card) => !card.archivedAt);

/** Un archivo se lee en una sola moneda: la de las tarjetas activas de la cuenta (o la del espacio si aún no hay). */
export function importCurrency(account: AccountWithCards, defaultCurrency: string): { currency: string; mixed: boolean } {
  const currencies = [...new Set(activeCards(account).map((card) => card.currency))];
  return { currency: currencies[0] ?? defaultCurrency, mixed: currencies.length > 1 };
}

/** Datos que heredan las tarjetas nuevas detectadas en el archivo: las de la tarjeta de crédito principal de la cuenta. */
function templateCard(account: AccountWithCards): Card | null {
  const active = activeCards(account);
  return active.find((card) => card.kind === 'credit') ?? active[0] ?? null;
}

/** Tarjeta por defecto para un plan cuyo cargo no trae terminación: solo si no hay duda (una sola tarjeta de crédito, o una sola). */
function defaultCardId(account: AccountWithCards): string | null {
  const active = activeCards(account);
  const credit = active.filter((card) => card.kind === 'credit');
  if (credit.length === 1) return credit[0]!.id;
  return active.length === 1 ? active[0]!.id : null;
}

async function savedProfile(db: Db, workspaceId: string, accountId: string): Promise<{ id: string; profile: ImportProfile } | null> {
  const [row] = await db
    .select()
    .from(importProfiles)
    .where(and(eq(importProfiles.workspaceId, workspaceId), eq(importProfiles.accountId, accountId)))
    .orderBy(desc(importProfiles.updatedAt))
    .limit(1);
  if (!row) return null;
  const sanitized = sanitizeProfile(row.config);
  return sanitized.ok ? { id: row.id, profile: sanitized.profile } : null;
}

interface Analysis {
  preview: PreviewResult;
  fresh: NormalizedMovement[];
  openPlans: (PlanLike & { name: string })[];
  savedProfileId: string | null;
}

async function analyze(
  db: Db,
  input: { workspaceId: string; account: AccountWithCards; defaultCurrency: string; text: string; profile: ImportProfile | null; locale: string },
): Promise<Analysis> {
  const { workspaceId, account, text, locale } = input;
  const { currency, mixed } = importCurrency(account, input.defaultCurrency);
  if (text.length > MAX_FILE_CHARS) throw new ImportInputError('FILE_TOO_LARGE');
  if (text.split('\n').length > MAX_ROWS + 50) throw new ImportInputError('TOO_MANY_ROWS');

  const saved = await savedProfile(db, workspaceId, account.id);
  const detected = detectProfile(text, locale.startsWith('en') ? 'en' : 'es');
  const profileSource: PreviewResult['profileSource'] = input.profile ? 'custom' : saved ? 'saved' : 'detected';
  // Los decimales los define la moneda de las tarjetas, no el archivo: así 'JPY' (0 decimales) se lee bien.
  const chosen = input.profile ?? saved?.profile ?? detected.profile;
  const profile: ImportProfile = { ...chosen, minorDigits: currencyDigits(currency) ?? chosen.minorDigits };

  const table = parseCsv(text, profile.delimiter).slice(profile.skipRows);
  const parsed = await parseImport(text, profile);

  const dates = parsed.movements.map((m) => m.date).sort();
  const existingKeys = new Set<string>();
  if (dates.length > 0) {
    const rows = await db
      .select({ key: movements.uniqueKey })
      .from(movements)
      .where(and(eq(movements.accountId, account.id), gte(movements.date, dates[0]!), lte(movements.date, dates.at(-1)!)));
    for (const row of rows) existingKeys.add(row.key);
  }
  const fresh = parsed.movements.filter((m) => !existingKeys.has(m.uniqueKey));
  const coverageEnd = dates.at(-1) ?? null;

  const planRows = account.cards.length
    ? await db
        .select()
        .from(plans)
        .where(
          and(
            eq(plans.workspaceId, workspaceId),
            inArray(
              plans.cardId,
              account.cards.map((card) => card.id),
            ),
            inArray(plans.status, ['active', 'review']),
          ),
        )
    : [];
  const openPlans = planRows.map((p) => ({
    id: p.id,
    name: p.name,
    matchText: p.matchText,
    installmentAmountMinor: p.installmentAmountMinor,
    totalInstallments: p.totalInstallments,
    paidInstallments: p.paidInstallments,
    firstChargeDate: p.firstChargeDate,
    status: p.status,
  }));
  const { matches, missing } = matchPlanInstallments(openPlans, fresh, coverageEnd ? { coverageEnd } : {});
  const planById = new Map(openPlans.map((p) => [p.id, p]));
  const hints = planHints(fresh);

  const cardMap = new Map<string, CardKind | null>();
  for (const m of parsed.movements) if (m.cardLast4 && !cardMap.has(m.cardLast4)) cardMap.set(m.cardLast4, m.cardKind);

  const preview: PreviewResult = {
    profile,
    profileSource,
    needsMapping: profileSource === 'detected' || parsed.headerChanged || parsed.missingFields.length > 0,
    headers: table[0] ?? [],
    sampleRows: table.slice(1, 1 + SAMPLE_ROWS),
    ambiguousDateFormats: profileSource === 'detected' ? detected.ambiguousDateFormats : [],
    missingFields: parsed.missingFields,
    headerChanged: parsed.headerChanged,
    errors: parsed.errors,
    summary: {
      total: parsed.movements.length,
      fresh: fresh.length,
      duplicates: parsed.movements.length - fresh.length,
      errors: parsed.errors.length,
    },
    movements: parsed.movements.map((m) => ({
      key: m.uniqueKey,
      line: m.line,
      date: m.date,
      description: m.description,
      reference: m.reference,
      chargeMinor: m.chargeMinor,
      creditMinor: m.creditMinor,
      chargeInput: m.chargeMinor > 0 ? toInputString(m.chargeMinor, locale, currency) : '',
      cardLast4: m.cardLast4,
      cardKind: m.cardKind,
      status: existingKeys.has(m.uniqueKey) ? 'duplicate' : 'new',
      hints: hints.get(m.uniqueKey) ?? [],
    })),
    currency,
    mixedCurrencies: mixed,
    cards: [...cardMap].map(([last4, kind]) => ({ last4, kind, exists: account.cards.some((card) => card.last4 === last4) })),
    planMatches: matches.map((match) => {
      const plan = planById.get(match.planId)!;
      return { ...match, planName: plan.name, amountMinor: plan.installmentAmountMinor, totalInstallments: plan.totalInstallments };
    }),
    missingInstallments: missing.map((item) => ({ ...item, planName: planById.get(item.planId)!.name })),
    coverageEnd,
    cutoffSuggestion: cutoffSuggestion(account),
  };
  return { preview, fresh, openPlans, savedProfileId: saved?.id ?? null };
}

function cutoffSuggestion(account: AccountWithCards): string | null {
  const day = activeCards(account).find((card) => card.kind === 'credit' && card.cutoffDay)?.cutoffDay;
  return day ? lastCutoffDate(day, today()) : null;
}

/** Vista previa: lee el archivo, deduplica contra lo ya guardado y propone planes. No escribe nada. */
export async function buildPreview(
  db: Db,
  input: { workspaceId: string; account: AccountWithCards; defaultCurrency: string; text: string; profile: ImportProfile | null; locale: string },
): Promise<PreviewResult> {
  return (await analyze(db, input)).preview;
}

export interface ApplyInput {
  workspaceId: string;
  userId: string;
  account: AccountWithCards;
  defaultCurrency: string;
  locale: string;
  text: string;
  fileName: string;
  profile: ImportProfile;
  cutoffDate: string;
  planDrafts: Record<string, unknown>[];
  confirmedMatches: { planId: string; movementKey: string }[];
  ignoreErrors: boolean;
  createMissingCards: boolean;
}

export type ApplyResult =
  | {
      ok: true;
      batchId: string;
      counts: { movements: number; duplicatesSkipped: number; plansCreated: number; installmentsLinked: number; cardsCreated: number; rowErrorsIgnored: number; categorized: number };
    }
  | { ok: false; code: 'INVALID_CUTOFF' | 'PARSE_PROBLEMS' | 'ROW_ERRORS' | 'NOTHING_TO_IMPORT' | 'INVALID_MATCH' | 'INVALID_PLAN' | 'MIXED_CURRENCIES'; details?: unknown };


/**
 * Importa el archivo. El servidor vuelve a leerlo y a deduplicarlo: nunca confía en las filas que
 * calculó el navegador. Todo se guarda en una sola transacción; la llave única de movimientos impide
 * cargar dos veces el mismo archivo.
 */
export async function applyImport(db: Db, bucket: R2Bucket, input: ApplyInput): Promise<ApplyResult> {
  if (!isValidISODate(input.cutoffDate)) return { ok: false, code: 'INVALID_CUTOFF' };

  const { preview, fresh, openPlans, savedProfileId } = await analyze(db, { ...input, profile: input.profile });
  if (preview.missingFields.length > 0) return { ok: false, code: 'PARSE_PROBLEMS', details: preview.missingFields };
  if (preview.errors.length > 0 && !input.ignoreErrors) return { ok: false, code: 'ROW_ERRORS', details: preview.errors.slice(0, 20) };
  if (fresh.length === 0) return { ok: false, code: 'NOTHING_TO_IMPORT' };
  if (preview.mixedCurrencies) return { ok: false, code: 'MIXED_CURRENCIES' };

  // Tarjetas: las que la cuenta ya tiene y, si el usuario lo acepta, las terminaciones nuevas del archivo.
  const { currency } = preview;
  const cardIds = new Map<string, string>(input.account.cards.flatMap((card) => (card.last4 ? [[card.last4, card.id] as [string, string]] : [])));
  const template = templateCard(input.account);
  const newCards: { id: string; last4: string }[] = [];
  if (input.createMissingCards) {
    for (const card of preview.cards.filter((c) => !c.exists)) {
      const id = crypto.randomUUID();
      cardIds.set(card.last4, id);
      newCards.push({ id, last4: card.last4 });
    }
  }
  const fallbackCard = defaultCardId(input.account);

  const freshByKey = new Map(fresh.map((m) => [m.uniqueKey, m]));
  const linkByMovement = new Map<string, { planId: string; installmentNo: number }>();

  // Planes nuevos a partir de movimientos del archivo.
  const drafts: { planId: string; cardId: string; draft: PlanDraft }[] = [];
  const draftErrors: { index: number; errors: PlanFieldError[] | 'unknown_movement' | 'duplicate_movement' | 'card_required' }[] = [];
  input.planDrafts.forEach((raw, index) => {
    const movement = freshByKey.get(String(raw.movementKey ?? ''));
    if (!movement || movement.chargeMinor <= 0) return void draftErrors.push({ index, errors: 'unknown_movement' });
    if (linkByMovement.has(movement.uniqueKey)) return void draftErrors.push({ index, errors: 'duplicate_movement' });
    // El plan va a la tarjeta que hizo el cargo; sin terminación, solo si la cuenta no deja duda.
    const cardId = (movement.cardLast4 ? cardIds.get(movement.cardLast4) : null) ?? fallbackCard;
    if (!cardId) return void draftErrors.push({ index, errors: 'card_required' });
    const result = validatePlanDraft(raw, { locale: input.locale, currency, movementDate: movement.date });
    if (!result.ok) return void draftErrors.push({ index, errors: result.errors });
    const planId = crypto.randomUUID();
    drafts.push({ planId, cardId, draft: result.value });
    linkByMovement.set(movement.uniqueKey, { planId, installmentNo: result.value.currentInstallment });
  });
  if (draftErrors.length > 0) return { ok: false, code: 'INVALID_PLAN', details: draftErrors };

  // Mensualidades de planes existentes: solo las que el emparejamiento del servidor propone.
  const proposed = new Map(preview.planMatches.map((m) => [`${m.planId}|${m.movementKey}`, m]));
  const matches: InstallmentMatch[] = [];
  const usedPlans = new Set<string>();
  for (const confirmation of input.confirmedMatches) {
    const match = proposed.get(`${confirmation.planId}|${confirmation.movementKey}`);
    if (!match || linkByMovement.has(match.movementKey) || usedPlans.has(match.planId)) return { ok: false, code: 'INVALID_MATCH' };
    usedPlans.add(match.planId);
    matches.push(match);
    linkByMovement.set(match.movementKey, { planId: match.planId, installmentNo: match.installmentNo });
  }

  const batchId = crypto.randomUUID();
  const fileKey = `${input.workspaceId}/${input.account.id}/${batchId}.csv`;
  await bucket.put(fileKey, input.text, { httpMetadata: { contentType: 'text/csv' }, customMetadata: { fileName: input.fileName, uploadedBy: input.userId } });

  try {
    const headers = (parseCsv(input.text, input.profile.delimiter).slice(input.profile.skipRows)[0] ?? []) as string[];
    const profileToStore: ImportProfile = { ...input.profile, headerFingerprint: headerFingerprint(headers) };
    const profileId = savedProfileId ?? crypto.randomUUID();
    const statements: BatchItem<'sqlite'>[] = [];

    statements.push(
      savedProfileId
        ? db
            .update(importProfiles)
            .set({ config: profileToStore, headerFingerprint: profileToStore.headerFingerprint })
            .where(eq(importProfiles.id, savedProfileId))
        : db.insert(importProfiles).values({
            id: profileId,
            workspaceId: input.workspaceId,
            accountId: input.account.id,
            name: 'default',
            config: profileToStore,
            headerFingerprint: profileToStore.headerFingerprint,
          }),
    );

    statements.push(
      db.insert(importBatches).values({
        id: batchId,
        workspaceId: input.workspaceId,
        accountId: input.account.id,
        profileId,
        fileName: input.fileName,
        fileKey,
        cutoffDate: input.cutoffDate,
        status: 'applied',
        createdBy: input.userId,
        summary: { rows: preview.summary, plansCreated: drafts.length, installmentsLinked: matches.length, profileSource: preview.profileSource },
      }),
    );

    // Tarjetas nuevas detectadas en el archivo: heredan moneda, límite y fechas de la tarjeta de crédito de la cuenta.
    for (const card of newCards) {
      statements.push(
        db.insert(cards).values({
          id: card.id,
          workspaceId: input.workspaceId,
          accountId: input.account.id,
          kind: template?.kind ?? 'credit',
          isDigital: false,
          last4: card.last4,
          currency,
          creditLimitMinor: template?.creditLimitMinor ?? null,
          cutoffDay: template?.cutoffDay ?? null,
          paymentDueDay: template?.paymentDueDay ?? null,
        }),
      );
    }

    // Los planes van antes que los movimientos que los referencian (llaves foráneas).
    for (const { planId, cardId, draft } of drafts) {
      const complete = draft.currentInstallment === draft.totalInstallments;
      statements.push(
        db.insert(plans).values({
          id: planId,
          workspaceId: input.workspaceId,
          cardId,
          type: draft.type,
          name: draft.name,
          matchText: draft.matchText,
          currency,
          totalAmountMinor: draft.totalAmountMinor,
          installmentAmountMinor: draft.installmentAmountMinor,
          totalInstallments: draft.totalInstallments,
          paidInstallments: draft.currentInstallment,
          interestRateBp: draft.interestRateBp,
          firstChargeDate: draft.firstChargeDate,
          status: complete ? 'completed_natural' : 'active',
          settledAt: complete ? new Date() : null,
        }),
      );
    }

    // Las reglas de categorías se aplican al guardar: los cargos nuevos entran ya clasificados.
    const rules = await loadRules(db, input.workspaceId);
    let categorized = 0;
    const movementIds = new Map<string, string>();
    const rows = fresh.map((m) => {
      const id = crypto.randomUUID();
      movementIds.set(m.uniqueKey, id);
      const link = linkByMovement.get(m.uniqueKey);
      const categoryId = m.chargeMinor > 0 && !link ? matchCategory(m.descriptionNorm, rules) : null;
      if (categoryId) categorized++;
      return {
        id,
        workspaceId: input.workspaceId,
        accountId: input.account.id,
        cardId: m.cardLast4 ? (cardIds.get(m.cardLast4) ?? null) : null,
        batchId,
        uniqueKey: m.uniqueKey,
        date: m.date,
        description: m.description,
        descriptionNorm: m.descriptionNorm,
        reference: m.reference,
        chargeMinor: m.chargeMinor,
        creditMinor: m.creditMinor,
        currency,
        planId: link?.planId ?? null,
        planInstallmentNo: link?.installmentNo ?? null,
        categoryId,
      };
    });
    for (let i = 0; i < rows.length; i += MOVEMENT_ROWS_PER_INSERT) {
      statements.push(db.insert(movements).values(rows.slice(i, i + MOVEMENT_ROWS_PER_INSERT)));
    }

    // Historial de cada plan y avance de los planes existentes.
    const actorUserId = input.userId;
    for (const { planId, draft } of drafts) {
      statements.push(
        db.insert(planEvents).values({
          workspaceId: input.workspaceId,
          planId,
          type: 'created',
          data: { type: draft.type, totalInstallments: draft.totalInstallments, installmentAmountMinor: draft.installmentAmountMinor, currentInstallment: draft.currentInstallment },
          batchId,
          actorUserId,
        }),
        db.insert(planEvents).values({
          workspaceId: input.workspaceId,
          planId,
          type: 'installment_recorded',
          data: { installmentNo: draft.currentInstallment },
          movementId: movementIds.get(draft.movementKey)!,
          batchId,
          actorUserId,
        }),
      );
    }
    for (const match of matches) {
      const plan = openPlans.find((p) => p.id === match.planId)!;
      statements.push(
        db
          .update(plans)
          .set({
            paidInstallments: match.installmentNo,
            status: match.isFinal ? 'completed_natural' : 'active',
            settledAt: match.isFinal ? new Date() : null,
          })
          .where(and(eq(plans.id, match.planId), eq(plans.workspaceId, input.workspaceId))),
        db.insert(planEvents).values({
          workspaceId: input.workspaceId,
          planId: match.planId,
          type: 'installment_recorded',
          // El estado previo permite restaurar el plan exactamente si la carga se deshace.
          data: {
            installmentNo: match.installmentNo,
            expectedDate: scheduledDate(plan, match.installmentNo),
            daysOffset: match.daysOffset,
            previousStatus: plan.status,
            previousPaid: plan.paidInstallments,
          },
          movementId: movementIds.get(match.movementKey)!,
          batchId,
          actorUserId,
        }),
      );
    }

    await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

    return {
      ok: true,
      batchId,
      counts: {
        movements: fresh.length,
        duplicatesSkipped: preview.summary.duplicates,
        plansCreated: drafts.length,
        installmentsLinked: matches.length,
        cardsCreated: newCards.length,
        rowErrorsIgnored: preview.errors.length,
        categorized,
      },
    };
  } catch (error) {
    await bucket.delete(fileKey).catch(() => undefined);
    throw error;
  }
}
