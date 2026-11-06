import { and, asc, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import * as schema from '../../db/schema';
import type { Db } from '../auth/hooks';
import { currencyDigits } from '../money-format';

/** Días que un respaldo listo se puede descargar antes de que el cron lo borre. */
export const BACKUP_DAYS = 7;
export const BACKUP_FILES = ['gastos', 'pagos'] as const;
export type BackupFile = (typeof BACKUP_FILES)[number];

export interface BackupJob {
  backupId: string;
}

export const backupKey = (workspaceId: string, backupId: string, file: BackupFile) => `backups/${workspaceId}/${backupId}/${file}.csv`;

/** Monto en unidades menores como decimal sin separador de miles (lo lee cualquier hoja de cálculo). */
export function decimal(minor: number, currency: string): string {
  const digits = currencyDigits(currency) ?? 2;
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  if (digits === 0) return `${sign}${abs}`;
  const text = String(abs).padStart(digits + 1, '0');
  return `${sign}${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/**
 * Una fila CSV (RFC 4180). Los textos que una hoja de cálculo tomaría por fórmula (=, +, -, @) llevan un apóstrofo
 * delante: el concepto del banco o una descripción no deben ejecutarse al abrir el archivo.
 */
export function csvRow(cells: (string | number | null)[]): string {
  return cells
    .map((cell) => {
      if (cell === null) return '';
      let text = String(cell);
      if (typeof cell === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    })
    .join(',');
}

const csv = (header: string[], rows: (string | number | null)[][]) => `﻿${[header, ...rows].map(csvRow).join('\r\n')}\r\n`;

/** Pide un respaldo. Solo uno a la vez por espacio: si hay uno en cola o generándose, responde `busy`. */
export async function requestBackup(db: Db, queue: Queue<BackupJob>, workspaceId: string, userId: string): Promise<{ ok: true; id: string } | { ok: false; reason: 'busy' }> {
  const [active] = await db
    .select({ id: schema.backupExports.id })
    .from(schema.backupExports)
    .where(and(eq(schema.backupExports.workspaceId, workspaceId), inArray(schema.backupExports.status, ['queued', 'running'])))
    .limit(1);
  if (active) return { ok: false, reason: 'busy' };
  const [row] = await db.insert(schema.backupExports).values({ workspaceId, requestedBy: userId }).returning({ id: schema.backupExports.id });
  try {
    await queue.send({ backupId: row!.id });
  } catch (e) {
    await db.update(schema.backupExports).set({ status: 'failed', error: 'no se pudo encolar', finishedAt: new Date() }).where(eq(schema.backupExports.id, row!.id));
    throw e;
  }
  return { ok: true, id: row!.id };
}

export async function listBackups(db: Db, workspaceId: string) {
  return db.select().from(schema.backupExports).where(eq(schema.backupExports.workspaceId, workspaceId)).orderBy(desc(schema.backupExports.createdAt)).limit(5);
}

export async function getBackup(db: Db, workspaceId: string, id: string) {
  const [row] = await db.select().from(schema.backupExports).where(and(eq(schema.backupExports.id, id), eq(schema.backupExports.workspaceId, workspaceId))).limit(1);
  return row ?? null;
}

/** Respaldos listos que quien los pidió aún no ha visto (para el aviso en la app). */
export async function unseenBackups(db: Db, workspaceId: string, userId: string) {
  return db
    .select({ id: schema.backupExports.id })
    .from(schema.backupExports)
    .where(and(eq(schema.backupExports.workspaceId, workspaceId), eq(schema.backupExports.requestedBy, userId), eq(schema.backupExports.status, 'ready'), isNull(schema.backupExports.seenAt)));
}

export async function markBackupsSeen(db: Db, workspaceId: string, userId: string): Promise<void> {
  await db
    .update(schema.backupExports)
    .set({ seenAt: new Date() })
    .where(and(eq(schema.backupExports.workspaceId, workspaceId), eq(schema.backupExports.requestedBy, userId), isNull(schema.backupExports.seenAt)));
}

async function buildMovementsCsv(db: Db, workspaceId: string): Promise<string> {
  const s = schema;
  const rows = await db
    .select({
      date: s.movements.date,
      description: s.movements.description,
      reference: s.movements.reference,
      charge: s.movements.chargeMinor,
      credit: s.movements.creditMinor,
      currency: s.movements.currency,
      account: s.accounts.name,
      last4: s.cards.last4,
      category: s.categories.name,
      plan: s.plans.name,
      installment: s.movements.planInstallmentNo,
      statementMonth: s.movements.statementMonth,
    })
    .from(s.movements)
    .innerJoin(s.accounts, eq(s.accounts.id, s.movements.accountId))
    .leftJoin(s.cards, eq(s.cards.id, s.movements.cardId))
    .leftJoin(s.categories, eq(s.categories.id, s.movements.categoryId))
    .leftJoin(s.plans, eq(s.plans.id, s.movements.planId))
    .where(eq(s.movements.workspaceId, workspaceId))
    .orderBy(asc(s.movements.date), asc(s.movements.createdAt));
  return csv(
    ['fecha', 'concepto', 'referencia', 'cargo', 'abono', 'moneda', 'cuenta', 'tarjeta', 'categoria', 'plan', 'mensualidad', 'corte'],
    rows.map((r) => [r.date, r.description, r.reference, decimal(r.charge, r.currency), decimal(r.credit, r.currency), r.currency, r.account, r.last4, r.category, r.plan, r.installment, r.statementMonth]),
  );
}

async function buildPaymentsCsv(db: Db, workspaceId: string): Promise<string> {
  const s = schema;
  const doneBy = alias(s.user, 'done_by');
  const rows = await db
    .select({
      dueDate: s.agendaItems.dueDate,
      kind: s.agendaItems.kind,
      description: s.agendaItems.description,
      amount: s.agendaItems.amountMinor,
      currency: s.agendaItems.currency,
      status: s.agendaItems.status,
      recurrence: s.agendaItems.recurrence,
      doneAt: s.agendaItems.doneAt,
      doneBy: doneBy.name,
      last4: s.cards.last4,
    })
    .from(s.agendaItems)
    .leftJoin(s.cards, eq(s.cards.id, s.agendaItems.cardId))
    .leftJoin(doneBy, eq(doneBy.id, s.agendaItems.doneByUserId))
    .where(eq(s.agendaItems.workspaceId, workspaceId))
    .orderBy(asc(s.agendaItems.dueDate), asc(s.agendaItems.createdAt));
  const kind = { payable: 'pago', receivable: 'cobro' } as const;
  const status = { pending: 'pendiente', done: 'hecho', cancelled: 'cancelado' } as const;
  const recurrence = { none: 'no', monthly: 'mensual', biweekly: 'quincenal' } as const;
  return csv(
    ['vence', 'tipo', 'descripcion', 'monto', 'moneda', 'estado', 'repeticion', 'hecho_el', 'hecho_por', 'tarjeta'],
    rows.map((r) => [r.dueDate, kind[r.kind], r.description, decimal(r.amount, r.currency), r.currency, status[r.status], recurrence[r.recurrence], r.doneAt ? r.doneAt.toISOString().slice(0, 10) : null, r.doneBy, r.last4]),
  );
}

/**
 * Lo corre el consumidor de la cola. El UPDATE condicionado "reclama" el trabajo: un reintento de la cola sobre un
 * respaldo que ya terminó no hace nada.
 * shortcut: arma cada CSV en memoria; con decenas de miles de movimientos, paginar y escribir con multipart en R2.
 */
export async function runBackup(db: Db, files: R2Bucket, backupId: string): Promise<'ready' | 'skipped'> {
  const [job] = await db
    .update(schema.backupExports)
    .set({ status: 'running' })
    .where(and(eq(schema.backupExports.id, backupId), inArray(schema.backupExports.status, ['queued', 'running'])))
    .returning();
  if (!job) return 'skipped';
  try {
    const [movements, payments] = await Promise.all([buildMovementsCsv(db, job.workspaceId), buildPaymentsCsv(db, job.workspaceId)]);
    const meta = { httpMetadata: { contentType: 'text/csv; charset=utf-8' } };
    await files.put(backupKey(job.workspaceId, job.id, 'gastos'), movements, meta);
    await files.put(backupKey(job.workspaceId, job.id, 'pagos'), payments, meta);
    await db.update(schema.backupExports).set({ status: 'ready', finishedAt: new Date(), error: null }).where(eq(schema.backupExports.id, job.id));
    return 'ready';
  } catch (e) {
    await db
      .update(schema.backupExports)
      .set({ status: 'failed', finishedAt: new Date(), error: (e instanceof Error ? e.message : String(e)).slice(0, 500) })
      .where(eq(schema.backupExports.id, job.id));
    throw e;
  }
}

export async function deleteBackupFiles(files: R2Bucket, workspaceId: string, backupId?: string): Promise<void> {
  const prefix = backupId ? `backups/${workspaceId}/${backupId}/` : `backups/${workspaceId}/`;
  let cursor: string | undefined;
  do {
    const page = await files.list({ prefix, cursor });
    if (page.objects.length > 0) await files.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Borra los respaldos con más de `BACKUP_DAYS` días (archivos y registro). La corre el cron diario. */
export async function expireBackups(db: Db, files: R2Bucket, now = new Date()): Promise<number> {
  const limit = new Date(now.getTime() - BACKUP_DAYS * 86_400_000);
  const old = await db.select({ id: schema.backupExports.id, workspaceId: schema.backupExports.workspaceId }).from(schema.backupExports).where(lt(schema.backupExports.createdAt, limit));
  for (const row of old) await deleteBackupFiles(files, row.workspaceId, row.id);
  if (old.length > 0) await db.delete(schema.backupExports).where(inArray(schema.backupExports.id, old.map((r) => r.id)));
  return old.length;
}
