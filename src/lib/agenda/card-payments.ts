import { listAccounts } from '../accounts/repo';
import type { Db } from '../auth/hooks';
import { shiftMonth, thresholdFor } from '../spending/analysis';
import { getWorkspaceSettings, listCutoffs, movementsForAccount } from '../spending/repo';
import { realCuts, recordsByMonth, statementPeriod, summarizeStatement, type RealCut } from '../spending/statement';

/** Un corte cuya fecha límite de pago cae en el mes pedido. */
export interface CardDue {
  cardId: string;
  accountName: string;
  currency: string;
  /** Mes en que cierra el corte (`YYYY-MM`). */
  cutMonth: string;
  from: string;
  to: string;
  dueDate: string;
  /** "Pago para no generar intereses" capturado del estado de cuenta, si existe. */
  recordedPayMinor: number | null;
  /** Adeudo del corte real anterior, para que el estimado sea exacto. */
  previousOwedMinor: number | null;
}

/**
 * Cortes de una tarjeta que se pagan en `month`. Mandan los cortes reales; si ninguno se paga ese mes, se estima el
 * corte con el día de corte de la tarjeta (el del mes anterior o el del propio mes, según caiga el pago).
 */
export function cardDuesInMonth(input: { cardId: string; accountName: string; currency: string; cutoffDay: number | null; paymentDueDay: number; cuts: RealCut[]; month: string; todayISO: string }): CardDue[] {
  const { cardId, accountName, currency, cutoffDay, paymentDueDay, cuts, month, todayISO } = input;
  const base = { cardId, accountName, currency };
  const real = cuts
    .map((cut, index): CardDue => ({
      ...base,
      cutMonth: cut.month,
      from: cut.from,
      to: cut.to,
      dueDate: cut.dueDate ?? '',
      recordedPayMinor: cut.recorded.officialPayMinor,
      previousOwedMinor: cuts[index - 1]?.recorded.officialPayMinor ?? null,
    }))
    .filter((due) => due.dueDate.startsWith(month));
  if (real.length > 0 || cutoffDay === null) return byDueDate(real);

  const records = recordsByMonth(cuts.map((cut) => cut.recorded));
  return byDueDate([shiftMonth(month, -1), month]
    .map((cutMonth) => ({ cutMonth, period: statementPeriod(cutoffDay, paymentDueDay, cutMonth, todayISO, records) }))
    .filter(({ period }) => period.dueDate?.startsWith(month))
    .map(({ cutMonth, period }) => ({
      ...base,
      cutMonth,
      from: period.from,
      to: period.to,
      dueDate: period.dueDate!,
      recordedPayMinor: period.recorded?.officialPayMinor ?? null,
      // Corte abierto: como en la vista por corte, sin adeudo anterior (ese pago ya aparece con su propia fecha).
      // Cerrado: solo el corte real inmediato anterior da el adeudo; con huecos se supone que se pagó completo.
      previousOwedMinor: period.open ? null : (records.get(shiftMonth(cutMonth, -1))?.officialPayMinor ?? null),
    })));
}

/** Un pago por fecha: si dos cortes vencen el mismo día (corte 31 y pago 30 en febrero), manda el más reciente. */
const byDueDate = (dues: CardDue[]): CardDue[] => [...new Map(dues.map((due) => [due.dueDate, due])).values()];

export interface SuggestedCardPayment {
  /** `card:${cardId}:${dueDate}` */
  key: string;
  cardId: string;
  description: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  basis: 'statement' | 'estimate';
}

/**
 * Pago de cada tarjeta de crédito que vence en `month`, calculado al vuelo. El estado de cuenta es por cuenta y la tarjeta
 * primaria (la primera de crédito con día de corte) da el día de pago y la moneda, igual que en la vista por corte.
 */
export async function suggestedCardPayments(db: Db, workspaceId: string, month: string, todayISO: string): Promise<SuggestedCardPayment[]> {
  const [accounts, settings] = await Promise.all([listAccounts(db, workspaceId), getWorkspaceSettings(db, workspaceId)]);
  const suggestions: SuggestedCardPayment[] = [];
  for (const account of accounts) {
    const primary = account.cards.find((card) => card.kind === 'credit' && card.cutoffDay !== null && !card.archivedAt);
    if (!primary || primary.paymentDueDay === null) continue;
    const cuts = realCuts(await listCutoffs(db, workspaceId, account.id), primary.cutoffDay, primary.paymentDueDay);
    const dues = cardDuesInMonth({ cardId: primary.id, accountName: account.name, currency: primary.currency, cutoffDay: primary.cutoffDay, paymentDueDay: primary.paymentDueDay, cuts, month, todayISO });
    const threshold = thresholdFor(primary.currency, settings);
    for (const due of dues) {
      let amountMinor = due.recordedPayMinor;
      const basis = amountMinor !== null ? 'statement' : 'estimate';
      if (amountMinor === null) {
        const rows = await movementsForAccount(db, workspaceId, account.id, primary.currency, { month: due.cutMonth, from: due.from, to: due.to });
        amountMinor = summarizeStatement(rows, threshold, due.previousOwedMinor).payMinor;
      }
      if (amountMinor <= 0) continue;
      suggestions.push({ key: `card:${primary.id}:${due.dueDate}`, cardId: primary.id, description: account.name, amountMinor, currency: primary.currency, dueDate: due.dueDate, basis });
    }
  }
  return suggestions.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}
