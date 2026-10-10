/** Reglas de quién puede invitar y cambiar a quién. Puras: las usan las rutas y las pantallas. */

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';
export type InviteRole = 'admin' | 'member' | 'viewer';

/** Días de vigencia que ofrece la pantalla al crear una invitación. */
export const INVITE_DAYS = [1, 7, 30] as const;

/** Roles que `actor` puede dar al invitar: el dueño todos; un administrador solo miembro y lectura. */
export function invitableRoles(actor: WorkspaceRole): InviteRole[] {
  if (actor === 'owner') return ['admin', 'member', 'viewer'];
  if (actor === 'admin') return ['member', 'viewer'];
  return [];
}

/**
 * ¿Puede `actor` tocar a un miembro con rol `target` (cambiarle el rol o quitarlo)? Nadie toca al dueño; el
 * administrador solo toca a miembros y lectores; y no se puede dar el rol de dueño por esta vía.
 */
export function canManageMember(actor: WorkspaceRole, target: WorkspaceRole, newRole?: WorkspaceRole): boolean {
  if (target === 'owner') return false;
  if (newRole === 'owner') return false;
  if (actor === 'owner') return true;
  if (actor === 'admin') return (target === 'member' || target === 'viewer') && (newRole === undefined || newRole === 'member' || newRole === 'viewer');
  return false;
}

export const isInviteRole = (value: unknown): value is InviteRole => value === 'admin' || value === 'member' || value === 'viewer';
export const isWorkspaceRole = (value: unknown): value is WorkspaceRole => value === 'owner' || isInviteRole(value);
