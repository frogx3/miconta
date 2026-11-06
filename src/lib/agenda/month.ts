import type { Db } from '../auth/hooks';
import { listAccounts } from '../accounts/repo';
import { monthOf, shiftMonth } from '../spending/analysis';
import { suggestedCardPayments, type SuggestedCardPayment } from './card-payments';
import { monthResults, projectRecurring, type Entry } from './compute';
import { anchorDays, idsWithChild, listAgenda, listBalances } from './repo';

/**
 * Todo lo que la agenda calcula para un mes: registros, sugeridos de tarjeta, proyección de recurrentes y resultado por
 * moneda. Lo usan la Agenda, la portada y los avisos del día.
 */
export async function loadAgendaMonth(db: Db, workspaceId: string, month: string, today: string) {
  const current = monthOf(today);
  const isPast = month < current;
  // Mes pasado: solo ese mes. Actual o futuro: desde el mes actual, para encadenar la proyección (incluye vencidos).
  const firstMonth = isPast ? month : current;
  const months: string[] = [];
  for (let m = firstMonth; m <= month; m = shiftMonth(m, 1)) months.push(m);
  const [items, balances, accounts, suggestionsByMonth] = await Promise.all([
    listAgenda(db, workspaceId, { from: `${firstMonth}-01`, to: `${month}-31` }),
    listBalances(db, workspaceId),
    listAccounts(db, workspaceId),
    Promise.all(months.map((m) => suggestedCardPayments(db, workspaceId, m, today))),
  ]);

  // Un sugerido ya guardado (cualquier estado) lo reemplaza su registro.
  const materialized = new Set(items.filter((item) => item.cardId).map((item) => `${item.cardId}:${item.dueDate}`));
  const suggestions: SuggestedCardPayment[] = suggestionsByMonth.flat().filter((s) => !materialized.has(`${s.cardId}:${s.dueDate}`));

  // Mes actual o futuro: las series pendientes se proyectan hasta el fin del mes visible (solo la última ocurrencia de cada una).
  const recurring = isPast ? [] : items.filter((item) => item.status === 'pending' && item.recurrence !== 'none');
  const [anchors, withChild] = await Promise.all([anchorDays(db, workspaceId, recurring), idsWithChild(db, workspaceId, recurring.map((item) => item.id))]);
  const projected = projectRecurring(
    recurring.filter((item) => !withChild.has(item.id)).map((item) => ({ ...item, key: item.id, anchorDay: anchors.get(item.id)! })),
    `${month}-31`,
  );

  const entries: Entry[] = [
    ...projected,
    ...items.map((item) => ({ key: item.id, kind: item.kind, description: item.description, amountMinor: item.amountMinor, currency: item.currency, dueDate: item.dueDate, status: item.status, suggested: false })),
    ...suggestions.map((s) => ({ key: s.key, kind: 'payable' as const, description: s.description, amountMinor: s.amountMinor, currency: s.currency, dueDate: s.dueDate, status: 'pending' as const, suggested: true })),
  ];

  const debitCards = accounts.flatMap((account) => account.cards.filter((card) => card.kind === 'debit' && !card.archivedAt).map((card) => ({ card, accountName: account.name })));
  const activeDebit = new Set(debitCards.map(({ card }) => card.id));
  const usedBalances = balances.filter((b) => b.cardId === null || activeDebit.has(b.cardId));
  const results = monthResults({ month, todayISO: today, balances: usedBalances, entries });

  return { isPast, items, balances, accounts, suggestions, entries, debitCards, results };
}

/** Pagos pendientes que tocan hoy o ya vencieron (lo que avisa la banda de la app). */
export function duePayables(entries: Entry[], today: string): { today: Entry[]; overdue: Entry[] } {
  const pending = entries.filter((e) => e.kind === 'payable' && e.status === 'pending' && !e.projected);
  return {
    today: pending.filter((e) => e.dueDate === today),
    overdue: pending.filter((e) => e.dueDate < today).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
  };
}

type AgendaMonth = Awaited<ReturnType<typeof loadAgendaMonth>>;
const perRequest = new WeakMap<object, Promise<AgendaMonth>>();

/** El mes actual de la agenda, calculado una sola vez por petición (lo usan la portada, el encabezado y los avisos). */
export function currentAgenda(locals: App.Locals, db: Db, today: string): Promise<AgendaMonth> | null {
  if (!locals.workspace) return null;
  let month = perRequest.get(locals);
  if (!month) perRequest.set(locals, (month = loadAgendaMonth(db, locals.workspace.id, today.slice(0, 7), today)));
  return month;
}

/** Lo que sigue: pendientes (pagos y cobros), lo vencido primero. */
export const upcomingEntries = (entries: Entry[], limit = 5): Entry[] =>
  entries
    .filter((e) => e.status === 'pending')
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.description.localeCompare(b.description))
    .slice(0, limit);

/** ¿Hay un pago pendiente vencido, de hoy o de mañana? (el punto del botón del encabezado) */
export const hasPaymentSoon = (entries: Entry[], tomorrow: string): boolean =>
  entries.some((e) => e.kind === 'payable' && e.status === 'pending' && !e.projected && e.dueDate <= tomorrow);
