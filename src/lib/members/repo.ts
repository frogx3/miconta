import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm';
import { user, workspaceInvitations, workspaceMembers, workspaces } from '../../db/schema';
import type { Db } from '../auth/hooks';
import { defaultCurrencyForLocale } from '../locale';
import { canManageMember, type InviteRole, type WorkspaceRole } from './roles';

/**
 * Todas las funciones reciben el `workspaceId` y lo aplican en cada consulta. El token de una invitación solo
 * existe en el enlace: la base guarda su huella SHA-256.
 */

const bytesToBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ── Invitaciones ──────────────────────────────────────────────────────────────────────────────

export async function createInvitation(db: Db, workspaceId: string, createdBy: string, role: InviteRole, days: number): Promise<{ token: string; expiresAt: Date }> {
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  await db.insert(workspaceInvitations).values({ workspaceId, tokenHash: await hashToken(token), role, createdBy, expiresAt });
  return { token, expiresAt };
}

export interface PendingInvitation {
  id: string;
  role: InviteRole;
  expiresAt: Date;
  createdByName: string;
}

/** Invitaciones sin usar ni revocar y aún vigentes. */
export async function listInvitations(db: Db, workspaceId: string): Promise<PendingInvitation[]> {
  return db
    .select({ id: workspaceInvitations.id, role: workspaceInvitations.role, expiresAt: workspaceInvitations.expiresAt, createdByName: user.name })
    .from(workspaceInvitations)
    .innerJoin(user, eq(user.id, workspaceInvitations.createdBy))
    .where(and(eq(workspaceInvitations.workspaceId, workspaceId), isNull(workspaceInvitations.usedAt), isNull(workspaceInvitations.revokedAt), gt(workspaceInvitations.expiresAt, new Date())))
    .orderBy(desc(workspaceInvitations.createdAt));
}

export async function revokeInvitation(db: Db, workspaceId: string, invitationId: string): Promise<boolean> {
  const rows = await db
    .update(workspaceInvitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(workspaceInvitations.id, invitationId), eq(workspaceInvitations.workspaceId, workspaceId), isNull(workspaceInvitations.usedAt), isNull(workspaceInvitations.revokedAt)))
    .returning({ id: workspaceInvitations.id });
  return rows.length > 0;
}

export interface ValidInvitation {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: InviteRole;
}

/** La invitación del token si sigue vigente (sin usar, sin revocar, sin vencer); si no, null. No la consume. */
export async function peekInvitation(db: Db, token: string): Promise<ValidInvitation | null> {
  if (!token || token.length > 200) return null;
  const [row] = await db
    .select({ id: workspaceInvitations.id, workspaceId: workspaceInvitations.workspaceId, workspaceName: workspaces.name, role: workspaceInvitations.role })
    .from(workspaceInvitations)
    .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
    .where(and(eq(workspaceInvitations.tokenHash, await hashToken(token)), isNull(workspaceInvitations.usedAt), isNull(workspaceInvitations.revokedAt), gt(workspaceInvitations.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

/**
 * Consume la invitación y mete al usuario en el espacio con el rol invitado. El UPDATE condicionado es el que
 * garantiza que un enlace sirve una sola vez aunque dos personas lo abran a la vez. Devuelve false si ya no valía.
 */
export async function claimInvitation(db: Db, token: string, userId: string): Promise<boolean> {
  const rows = await db
    .update(workspaceInvitations)
    .set({ usedAt: new Date(), usedBy: userId })
    .where(and(eq(workspaceInvitations.tokenHash, await hashToken(token)), isNull(workspaceInvitations.usedAt), isNull(workspaceInvitations.revokedAt), gt(workspaceInvitations.expiresAt, new Date())))
    .returning({ workspaceId: workspaceInvitations.workspaceId, role: workspaceInvitations.role });
  const claimed = rows[0];
  if (!claimed) return false;
  await db.insert(workspaceMembers).values({ workspaceId: claimed.workspaceId, userId, role: claimed.role });
  return true;
}

// ── Miembros ──────────────────────────────────────────────────────────────────────────────────

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  joinedAt: Date;
}

export async function listMembers(db: Db, workspaceId: string): Promise<Member[]> {
  return db
    .select({ userId: user.id, name: user.name, email: user.email, role: workspaceMembers.role, joinedAt: workspaceMembers.createdAt })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembers.createdAt));
}

export type MemberResult = { ok: true } | { ok: false; reason: 'not_found' | 'forbidden' };

async function findMember(db: Db, workspaceId: string, userId: string) {
  const [row] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).limit(1);
  return row ?? null;
}

export async function changeMemberRole(db: Db, workspaceId: string, actorRole: WorkspaceRole, userId: string, role: InviteRole): Promise<MemberResult> {
  const target = await findMember(db, workspaceId, userId);
  if (!target) return { ok: false, reason: 'not_found' };
  if (!canManageMember(actorRole, target.role, role)) return { ok: false, reason: 'forbidden' };
  await db.update(workspaceMembers).set({ role }).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return { ok: true };
}

/**
 * Saca a un miembro del espacio. Para que su sesión siga funcionando (la app exige un espacio) recibe uno propio y
 * vacío, igual que cualquier usuario nuevo. Su historial en este espacio no se toca.
 */
export async function removeMember(db: Db, workspaceId: string, actorRole: WorkspaceRole, userId: string): Promise<MemberResult> {
  const target = await findMember(db, workspaceId, userId);
  if (!target) return { ok: false, reason: 'not_found' };
  if (!canManageMember(actorRole, target.role)) return { ok: false, reason: 'forbidden' };
  const [person] = await db.select({ name: user.name, locale: user.locale }).from(user).where(eq(user.id, userId)).limit(1);
  const ownId = crypto.randomUUID();
  await db.batch([
    db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))),
    db.insert(workspaces).values({ id: ownId, name: person?.name ?? 'Don Bigo', locale: person?.locale ?? 'es-MX', defaultCurrency: defaultCurrencyForLocale(person?.locale ?? 'es-MX') }),
    db.insert(workspaceMembers).values({ workspaceId: ownId, userId, role: 'owner' }),
  ]);
  return { ok: true };
}
