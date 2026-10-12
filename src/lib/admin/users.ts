import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from '../../db/schema';
import type { Db } from '../auth/hooks';

export interface DeletionCheck {
  deletable: boolean;
  /** Cuentas financieras registradas en los espacios del usuario. */
  accounts: number;
}

async function countRows(db: Db, table: SQLiteTable, where: SQL): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(table).where(where);
  return row?.count ?? 0;
}

async function workspaceIdsOf(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ workspaceId: schema.workspaceMembers.workspaceId })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.userId, userId));
  return rows.map((row) => row.workspaceId);
}

/**
 * Un usuario solo se puede eliminar si no tiene información financiera: ni cuentas en sus espacios,
 * ni cargas ni historial hechos por ella. Si la tiene, el camino es suspenderlo (se conserva todo).
 */
export async function checkDeletion(db: Db, userId: string): Promise<DeletionCheck> {
  const workspaceIds = await workspaceIdsOf(db, userId);
  const accounts = workspaceIds.length
    ? await countRows(db, schema.accounts, inArray(schema.accounts.workspaceId, workspaceIds))
    : 0;
  const batches = await countRows(db, schema.importBatches, eq(schema.importBatches.createdBy, userId));
  const events = await countRows(db, schema.planEvents, eq(schema.planEvents.actorUserId, userId));
  return { deletable: accounts + batches + events === 0, accounts };
}

/**
 * Quita al usuario de sus espacios y borra los que se quedan sin miembros (vacíos, por la
 * comprobación previa). Debe llamarse solo si `checkDeletion` dio `deletable`.
 */
export async function removeUserWorkspaces(db: Db, userId: string): Promise<void> {
  const orphaned: string[] = [];
  for (const workspaceId of await workspaceIdsOf(db, userId)) {
    const members = await db
      .select({ userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.workspaceId, workspaceId));
    if (members.every((member) => member.userId === userId)) orphaned.push(workspaceId);
  }

  // Las invitaciones que creó (o que quedaron en espacios que se borran) no son información financiera: se
  // eliminan; en las que él aceptó solo se limpia la referencia.
  const statements: BatchItem<'sqlite'>[] = [
    db.delete(schema.workspaceInvitations).where(eq(schema.workspaceInvitations.createdBy, userId)),
    db.update(schema.workspaceInvitations).set({ usedBy: null }).where(eq(schema.workspaceInvitations.usedBy, userId)),
    db.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, userId)),
  ];
  if (orphaned.length > 0) {
    statements.push(
      db.delete(schema.workspaceInvitations).where(inArray(schema.workspaceInvitations.workspaceId, orphaned)),
      db.delete(schema.categories).where(inArray(schema.categories.workspaceId, orphaned)),
      db.delete(schema.tags).where(inArray(schema.tags.workspaceId, orphaned)),
      db.delete(schema.workspaces).where(inArray(schema.workspaces.id, orphaned)),
    );
  }
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}

export interface WipeCheck {
  /** Espacios del usuario con más miembros: borrarlos afectaría a otras personas. */
  sharedWorkspaces: number;
}

export async function checkWipe(db: Db, userId: string): Promise<WipeCheck> {
  let sharedWorkspaces = 0;
  for (const workspaceId of await workspaceIdsOf(db, userId)) {
    const members = await db
      .select({ userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.workspaceId, workspaceId));
    if (members.some((member) => member.userId !== userId)) sharedWorkspaces++;
  }
  return { sharedWorkspaces };
}

/**
 * Borra toda la información financiera de los espacios del usuario (cuentas, tarjetas, planes, movimientos,
 * cargas, cortes, metas, categorías y etiquetas) conservando el usuario, su membresía y el espacio con su
 * configuración. Debe llamarse solo si `checkWipe` no encontró espacios compartidos. El orden respeta las
 * llaves foráneas (`restrict`) y el lote es atómico.
 */
export async function wipeUserData(db: Db, userId: string): Promise<void> {
  const workspaceIds = await workspaceIdsOf(db, userId);
  if (workspaceIds.length === 0) return;
  const s = schema;
  const statements: BatchItem<'sqlite'>[] = [
    db.delete(s.planEvents).where(inArray(s.planEvents.workspaceId, workspaceIds)),
    db.delete(s.movements).where(inArray(s.movements.workspaceId, workspaceIds)),
    db.delete(s.planTags).where(
      inArray(s.planTags.planId, db.select({ id: s.plans.id }).from(s.plans).where(inArray(s.plans.workspaceId, workspaceIds))),
    ),
    db.delete(s.goalEntries).where(inArray(s.goalEntries.workspaceId, workspaceIds)),
    db.delete(s.goals).where(inArray(s.goals.workspaceId, workspaceIds)),
    db.delete(s.plans).where(inArray(s.plans.workspaceId, workspaceIds)),
    db.delete(s.categoryRules).where(inArray(s.categoryRules.workspaceId, workspaceIds)),
    db.delete(s.categories).where(inArray(s.categories.workspaceId, workspaceIds)),
    db.delete(s.tags).where(inArray(s.tags.workspaceId, workspaceIds)),
    db.delete(s.statementCutoffs).where(inArray(s.statementCutoffs.workspaceId, workspaceIds)),
    db.delete(s.importBatches).where(inArray(s.importBatches.workspaceId, workspaceIds)),
    db.delete(s.importProfiles).where(inArray(s.importProfiles.workspaceId, workspaceIds)),
    db.delete(s.cards).where(inArray(s.cards.workspaceId, workspaceIds)),
    db.delete(s.accounts).where(inArray(s.accounts.workspaceId, workspaceIds)),
  ];
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}
