import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { accounts, goals, movements, plans } from '../../db/schema';
import type { Db } from '../auth/hooks';

/** Lo que lleva el espacio en Don Bigo, para la tarjeta de Tu cuenta: cuentas y metas vigentes, planes abiertos y movimientos. */
export async function accountTally(db: Db, workspaceId: string) {
  const [[a], [p], [m], [g]] = await Promise.all([
    db.select({ n: count() }).from(accounts).where(and(eq(accounts.workspaceId, workspaceId), isNull(accounts.archivedAt))),
    db.select({ n: count() }).from(plans).where(and(eq(plans.workspaceId, workspaceId), inArray(plans.status, ['active', 'review']))),
    db.select({ n: count() }).from(movements).where(eq(movements.workspaceId, workspaceId)),
    db.select({ n: count() }).from(goals).where(and(eq(goals.workspaceId, workspaceId), isNull(goals.archivedAt))),
  ]);
  return { accounts: a?.n ?? 0, plans: p?.n ?? 0, movements: m?.n ?? 0, goals: g?.n ?? 0 };
}
