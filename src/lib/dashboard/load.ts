import { listAccounts } from '../accounts/repo';
import { cardTones } from '../accounts/format';
import type { Db } from '../auth/hooks';
import { listPlans, payDateResolver } from '../plans/repo';
import { summarize, summarizeByCard } from '../plans/schedule';
import { thresholdFor } from '../spending/analysis';
import { getWorkspaceSettings, listCutoffs, movementsForAccount } from '../spending/repo';
import { cutPeriod, realCuts } from '../spending/statement';
import { buildCutSections, dashboardMonths, lineUsage, selectMonth, type DashboardAccount } from './build';

/**
 * Datos de la portada en la moneda del espacio (nunca mezcla monedas): secciones del corte elegido (`requested`,
 * `YYYY-MM`), uso de línea y escalera de planes de hoy. Si hay tarjetas o planes en otras monedas, solo se avisan.
 */
export async function loadDashboard(db: Db, workspace: { id: string; defaultCurrency: string }, today: string, requested: string | null) {
  const currency = workspace.defaultCurrency;
  const [allAccounts, plans, payDateOf, settings] = await Promise.all([listAccounts(db, workspace.id, true), listPlans(db, workspace.id), payDateResolver(db, workspace.id), getWorkspaceSettings(db, workspace.id)]);
  const tones = cardTones(allAccounts);

  // Una cuenta entra con su tarjeta de crédito principal (titular y adicionales comparten corte y línea).
  const credit = allAccounts
    .filter((account) => !account.archivedAt)
    .map((account) => ({ account, primary: account.cards.find((card) => card.kind === 'credit' && card.cutoffDay !== null && !card.archivedAt && card.currency === currency) }))
    .filter((item): item is { account: (typeof allAccounts)[number]; primary: NonNullable<(typeof item)['primary']> } => Boolean(item.primary));

  const cutsByAccount = await Promise.all(credit.map(async ({ account, primary }) => realCuts(await listCutoffs(db, workspace.id, account.id), primary.cutoffDay, primary.paymentDueDay)));
  const selection = selectMonth(dashboardMonths(cutsByAccount.map((cuts) => ({ cuts }))), requested);

  const remainingByCard = new Map((summarizeByCard(plans, today, payDateOf).find((group) => group.currency === currency)?.cards ?? []).map((card) => [card.cardId, card.remainingBalanceMinor]));

  const accounts: DashboardAccount[] = await Promise.all(
    credit.map(async ({ account, primary }, index) => {
      const cuts = cutsByAccount[index]!;
      const months = selection.window.filter((month) => cuts.some((entry) => entry.month === month));
      const open = cutPeriod(cuts, 'actual');
      const [rows, openRows] = await Promise.all([
        Promise.all(months.map((month) => movementsForAccount(db, workspace.id, account.id, currency, cutPeriod(cuts, month)!))),
        open ? movementsForAccount(db, workspace.id, account.id, currency, open) : Promise.resolve([]),
      ]);
      return {
        accountId: account.id,
        accountName: account.name,
        last4: primary.last4,
        tone: tones.get(primary.id)!,
        creditLimitMinor: primary.creditLimitMinor,
        cuts,
        rowsByMonth: new Map(months.map((month, i) => [month, rows[i]!])),
        openRows,
        plansRemainingMinor: account.cards.reduce((total, card) => total + (remainingByCard.get(card.id) ?? 0), 0),
      };
    }),
  );

  const thresholdMinor = thresholdFor(currency, { currency: settings.currency, thresholdMinor: settings.thresholdMinor });
  const otherCurrencies = [...new Set([...plans.map((plan) => plan.currency), ...allAccounts.filter((account) => !account.archivedAt).flatMap((account) => account.cards.filter((card) => !card.archivedAt).map((card) => card.currency))])]
    .filter((code) => code !== currency)
    .sort();

  return {
    currency,
    selection,
    sections: buildCutSections(accounts, selection, currency, thresholdMinor),
    lines: lineUsage(accounts),
    plans: summarize(plans, today, 36, payDateOf).find((summary) => summary.currency === currency) ?? null,
    hasAccounts: allAccounts.some((account) => !account.archivedAt),
    otherCurrencies,
  };
}

export type Dashboard = Awaited<ReturnType<typeof loadDashboard>>;
