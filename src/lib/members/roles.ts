/** Reglas de quién puede invitar y cambiar a quién. Puras: las usan las rutas y las pantallas. */

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';
export type InviteRole = 'admin' | 'member' | 'viewer';

/** Días de vigencia que ofrece la pantalla al crear una invitación; 0 = sin vencimiento (permanente). */
export const INVITE_DAYS = [1, 7, 30, 0] as const;

/**
 * Vencimiento de una invitación permanente. shortcut: una fecha lejana en lugar de `expires_at` nulo (cambiar la columna
 * exige reconstruir la tabla en SQLite); si algún día hay que distinguirlas en consultas, migrar a NULL.
 */
export const NO_EXPIRY = new Date(Date.UTC(9999, 11, 31));
export const isPermanent = (expiresAt: Date) => expiresAt.getTime() >= NO_EXPIRY.getTime();

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
