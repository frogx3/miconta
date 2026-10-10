import type { Db } from '../auth/hooks';
import { listPlans } from '../plans/repo';
import { lastMonths, monthBounds, thresholdFor, trend } from '../spending/analysis';
import { getWorkspaceSettings, movementsForAnalysis } from '../spending/repo';
import { antGoalProgress, planGoalProgress, savingsProgress, type AntGoalProgress, type PlanGoalProgress, type SavingsProgress } from './compute';
import { listEntries, listGoals, type GoalEntry, type GoalWithSaved } from './repo';

/** Cómo se muestra el estado de una meta, sin importar su tipo. */
export type Tone = 'done' | 'good' | 'warn' | 'bad';

export type GoalView =
  | { kind: 'plans'; goal: GoalWithSaved; tone: Tone; ratio: number; progress: PlanGoalProgress; planName: string | null; openPlans: number }
  | { kind: 'savings'; goal: GoalWithSaved; tone: Tone; ratio: number; progress: SavingsProgress; entries: GoalEntry[] }
  | { kind: 'ant'; goal: GoalWithSaved; tone: Tone; ratio: number; progress: AntGoalProgress };

const planTone = (state: PlanGoalProgress['state'] | SavingsProgress['state']): Tone => (state === 'achieved' ? 'done' : state === 'on_track' ? 'good' : state === 'behind' ? 'warn' : 'bad');
const antTone = (state: 'ok' | 'warn' | 'over'): Tone => (state === 'ok' ? 'good' : state === 'warn' ? 'warn' : 'bad');

/** Metas del espacio con su avance calculado hoy. Lo comparten la pantalla de Metas y el resumen de Inicio. */
export async function buildGoalViews(db: Db, workspaceId: string, todayISO: string, includeArchived = false): Promise<GoalView[]> {
  const goals = await listGoals(db, workspaceId, includeArchived);
  if (goals.length === 0) return [];

  const plans = goals.some((goal) => goal.type === 'debt_free' || goal.type === 'payoff_plan') ? await listPlans(db, workspaceId) : [];

  // El gasto hormiga solo se consulta si hay una meta de ese tipo.
  const antGoals = goals.filter((goal) => goal.type === 'ant_spend');
  const month = todayISO.slice(0, 7);
  let series: { month: string; antMinor: number; spendMinor: number }[] = [];
  if (antGoals.length > 0) {
    const months = lastMonths(month, 6);
    const [rows, settings] = await Promise.all([movementsForAnalysis(db, workspaceId, monthBounds(months[0]!).from, monthBounds(month).to), getWorkspaceSettings(db, workspaceId)]);
    const thresholdOf = (currency: string) => thresholdFor(currency, { currency: settings.currency, thresholdMinor: settings.thresholdMinor });
    const currency = antGoals[0]!.currency;
    series = trend(rows, months, thresholdOf).find((entry) => entry.currency === currency)?.points ?? [];
  }

  const views: GoalView[] = [];
  for (const goal of goals) {
    if (goal.type === 'debt_free' || goal.type === 'payoff_plan') {
      const scope = goal.type === 'payoff_plan' ? plans.filter((plan) => plan.id === goal.planId) : plans.filter((plan) => plan.currency === goal.currency);
      const progress = planGoalProgress(scope, goal.targetDate!, todayISO);
      views.push({
        kind: 'plans',
        goal,
        tone: planTone(progress.state),
        ratio: progress.paidRatio,
        progress,
        planName: goal.type === 'payoff_plan' ? (scope[0]?.name ?? null) : null,
        openPlans: scope.filter((plan) => plan.status === 'active' || plan.status === 'review').length,
      });
    } else if (goal.type === 'savings') {
      const progress = savingsProgress(goal.targetAmountMinor ?? 0, goal.savedMinor, goal.targetDate, goal.createdAt.toISOString().slice(0, 10), todayISO);
      views.push({ kind: 'savings', goal, tone: planTone(progress.state), ratio: progress.ratio, progress, entries: (await listEntries(db, workspaceId, goal.id)).slice(0, 8) });
    } else {
      const progress = antGoalProgress(goal.targetAmountMinor ?? 0, series, month);
      views.push({ kind: 'ant', goal, tone: antTone(progress.status.state), ratio: Math.min(1, progress.status.ratio), progress });
    }
  }
  return views;
}
