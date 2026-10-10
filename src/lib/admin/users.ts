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
