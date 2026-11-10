import { and, asc, eq, sql } from 'drizzle-orm';
import { balanceMovements, type BalanceMovement } from '../../db/schema';
import type { Db } from '../auth/hooks';

/** Saldo global de hoy por moneda: la suma de su historial. */
export async function balanceTotals(db: Db, workspaceId: string): Promise<{ currency: string; amountMinor: number; lastDate: string }[]> {
  return db
    .select({ currency: balanceMovements.currency, amountMinor: sql<number>`sum(${balanceMovements.amountMinor})`, lastDate: sql<string>`max(${balanceMovements.date})` })
    .from(balanceMovements)
    .where(eq(balanceMovements.workspaceId, workspaceId))
    .groupBy(balanceMovements.currency)
    .orderBy(asc(balanceMovements.currency));
}

/** shortcut: trae todo el historial de la moneda; si algún espacio llega a miles de movimientos, paginar o resumir por día. */
export async function balanceHistory(db: Db, workspaceId: string, currency: string): Promise<BalanceMovement[]> {
  return db
    .select()
    .from(balanceMovements)
    .where(and(eq(balanceMovements.workspaceId, workspaceId), eq(balanceMovements.currency, currency)))
    .orderBy(asc(balanceMovements.date), asc(balanceMovements.createdAt));
}

/**
 * Corrige el saldo a lo que la persona dice tener hoy: guarda la diferencia como ajuste (o el saldo inicial si es la
 * primera captura de esa moneda). Sin diferencia no guarda nada.
 */
export async function setBalance(db: Db, workspaceId: string, value: { currency: string; amountMinor: number; date: string; userId: string }): Promise<'saved' | 'unchanged'> {
  const [current] = await db
    .select({ openings: sql<number>`count(*) filter (where ${balanceMovements.kind} = 'opening')`, total: sql<number>`coalesce(sum(${balanceMovements.amountMinor}), 0)` })
    .from(balanceMovements)
    .where(and(eq(balanceMovements.workspaceId, workspaceId), eq(balanceMovements.currency, value.currency)));
  // Sin saldo inicial (aunque ya haya pagos marcados), esta captura es el punto de partida.
  const first = !current || current.openings === 0;
  const diff = value.amountMinor - (current?.total ?? 0);
  if (!first && diff === 0) return 'unchanged';
  await db.insert(balanceMovements).values({
    workspaceId, currency: value.currency, amountMinor: diff, kind: first ? 'opening' : 'adjustment', date: value.date, createdByUserId: value.userId,
  });
  return 'saved';
}

export interface BalancePoint {
  date: string;
  balanceMinor: number;
}

/** Saldo al cierre de cada día con movimientos (para la gráfica). */
export function dailyBalance(movements: readonly Pick<BalanceMovement, 'date' | 'amountMinor'>[]): BalancePoint[] {
  const points: BalancePoint[] = [];
  let balance = 0;
  for (const m of [...movements].sort((a, b) => a.date.localeCompare(b.date))) {
    balance += m.amountMinor;
    const last = points[points.length - 1];
    if (last?.date === m.date) last.balanceMinor = balance;
    else points.push({ date: m.date, balanceMinor: balance });
  }
  return points;
}
