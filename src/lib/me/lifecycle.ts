import { and, eq, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import * as schema from '../../db/schema';
import { removeUserWorkspaces, wipeWorkspaceData } from '../admin/users';
import type { Db } from '../auth/hooks';
import { deleteBackupFiles } from './backup';

/** Días que una cuenta borrada espera en stand-by antes de purgarse. */
export const DELETION_GRACE_DAYS = 30;
/** Marca (`ban_reason`) de una cuenta ya purgada que se conservó anónima porque dejó historial en un espacio ajeno. */
const PURGED = 'purged';

/** Espacios del usuario: cuántos miembros tiene cada uno y qué rol tiene él. */
async function memberships(db: Db, userId: string) {
  return db
    .select({
      workspaceId: schema.workspaceMembers.workspaceId,
      role: schema.workspaceMembers.role,
      // Columna externa escrita a mano: dentro de sql`` drizzle la deja sin tabla y se resolvería contra `m`.
      members: sql<number>`(select count(*) from workspace_members m where m.workspace_id = workspace_members.workspace_id)`,
    })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.userId, userId));
}

/**
 * El usuario pide borrar su cuenta: queda en stand-by (sin acceso, como si no existiera) hasta que un admin la
 * restablezca o pasen los días de gracia. El dueño de un espacio con más miembros debe quitarlos antes.
 */
export async function requestDeletion(db: Db, userId: string, now = new Date()): Promise<'ok' | 'has_members'> {
  if ((await memberships(db, userId)).some((m) => m.role === 'owner' && m.members > 1)) return 'has_members';
  await db.batch([
    db.update(schema.user).set({ deletedAt: now }).where(eq(schema.user.id, userId)),
    db.delete(schema.session).where(eq(schema.session.userId, userId)),
    // Sin suscripciones no le llegan avisos push; al restablecer, vuelve a activarlos en su dispositivo.
    db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId)),
  ]);
  return 'ok';
}

export async function restoreUser(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .update(schema.user)
    .set({ deletedAt: null })
    .where(and(eq(schema.user.id, userId), isNotNull(schema.user.deletedAt), pendingWhere()))
    .returning({ id: schema.user.id });
  return rows.length > 0;
}

const pendingWhere = () => or(isNull(schema.user.banReason), ne(schema.user.banReason, PURGED));

export interface PendingDeletion {
  id: string;
  name: string;
  email: string;
  deletedAt: Date;
}

export async function listPendingDeletion(db: Db): Promise<PendingDeletion[]> {
  const rows = await db
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email, deletedAt: schema.user.deletedAt })
    .from(schema.user)
    .where(and(isNotNull(schema.user.deletedAt), pendingWhere()))
    .orderBy(schema.user.deletedAt);
  return rows as PendingDeletion[];
}

/**
 * Borrado definitivo. Los espacios donde solo está él se vacían y se eliminan (con sus respaldos en R2). Si dejó
 * historial en un espacio ajeno (cargas, eventos de planes, metas), ese historial se conserva y el usuario queda anónimo
 * y sin credenciales; si no, se elimina la fila del usuario.
 */
export async function purgeUser(db: Db, files: R2Bucket, userId: string): Promise<'deleted' | 'anonymized' | 'not_pending'> {
  const [target] = await db.select({ id: schema.user.id }).from(schema.user).where(and(eq(schema.user.id, userId), isNotNull(schema.user.deletedAt), pendingWhere())).limit(1);
  if (!target) return 'not_pending';

  const solo = (await memberships(db, userId)).filter((m) => m.members === 1).map((m) => m.workspaceId);
  for (const workspaceId of solo) await deleteBackupFiles(files, workspaceId);
  await wipeWorkspaceData(db, solo);
  await removeUserWorkspaces(db, userId);

  const s = schema;
  const [refs] = await db
    .select({
      n: sql<number>`(select count(*) from ${s.importBatches} where ${s.importBatches.createdBy} = ${userId})
        + (select count(*) from ${s.planEvents} where ${s.planEvents.actorUserId} = ${userId})
        + (select count(*) from ${s.goals} where ${s.goals.createdBy} = ${userId})
        + (select count(*) from ${s.goalEntries} where ${s.goalEntries.createdBy} = ${userId})
        + (select count(*) from ${s.emailInboxes} where ${s.emailInboxes.createdBy} = ${userId})`,
    })
    .from(s.user)
    .where(eq(s.user.id, userId));
  if ((refs?.n ?? 0) === 0) {
    await db.delete(s.user).where(eq(s.user.id, userId));
    return 'deleted';
  }
  await db.batch([
    db.update(s.user).set({ name: '—', email: `deleted-${userId}@deleted.invalid`, image: null, whatsappPhone: null, whatsappVerifiedAt: null, banned: true, banReason: PURGED }).where(eq(s.user.id, userId)),
    db.delete(s.account).where(eq(s.account.userId, userId)),
    db.delete(s.session).where(eq(s.session.userId, userId)),
  ]);
  return 'anonymized';
}

/** Purga las cuentas que llevan más de los días de gracia en stand-by. La corre el cron diario. */
export async function purgeExpired(db: Db, files: R2Bucket, now = new Date()): Promise<number> {
  const limit = new Date(now.getTime() - DELETION_GRACE_DAYS * 86_400_000);
  const due = await db.select({ id: schema.user.id }).from(schema.user).where(and(lt(schema.user.deletedAt, limit), pendingWhere()));
  for (const { id } of due) await purgeUser(db, files, id);
  return due.length;
}

/** Reboot: solo el dueño, y borra la información de su espacio activo (no la cuenta ni los miembros). */
export async function rebootWorkspace(db: Db, files: R2Bucket, workspaceId: string): Promise<void> {
  await deleteBackupFiles(files, workspaceId);
  await wipeWorkspaceData(db, [workspaceId]);
}

