import { describe, expect, it } from 'vitest';
import { canManageMember, invitableRoles, isInviteRole, type WorkspaceRole } from '../src/lib/members/roles';
import { hashToken } from '../src/lib/members/repo';

describe('roles de miembros', () => {
  it('el dueño invita a cualquier rol y el administrador solo a miembro y lectura', () => {
    expect(invitableRoles('owner')).toEqual(['admin', 'member', 'viewer']);
    expect(invitableRoles('admin')).toEqual(['member', 'viewer']);
    expect(invitableRoles('member')).toEqual([]);
    expect(invitableRoles('viewer')).toEqual([]);
  });

  it('nadie toca al dueño ni da el rol de dueño', () => {
    for (const actor of ['owner', 'admin', 'member', 'viewer'] as WorkspaceRole[]) expect(canManageMember(actor, 'owner'), actor).toBe(false);
    expect(canManageMember('owner', 'member', 'owner' as WorkspaceRole)).toBe(false);
  });

  it('el administrador solo gestiona miembros y lectores y no puede dar administrador', () => {
    expect(canManageMember('admin', 'member', 'viewer')).toBe(true);
    expect(canManageMember('admin', 'viewer')).toBe(true);
    expect(canManageMember('admin', 'admin')).toBe(false);
    expect(canManageMember('admin', 'member', 'admin')).toBe(false);
  });

  it('miembros y lectores no gestionan a nadie; el dueño gestiona a todos menos a sí mismo', () => {
    expect(canManageMember('member', 'viewer')).toBe(false);
    expect(canManageMember('viewer', 'member')).toBe(false);
    expect(canManageMember('owner', 'admin', 'viewer')).toBe(true);
  });

  it('solo admin, member y viewer son roles invitables', () => {
    expect(['admin', 'member', 'viewer'].every(isInviteRole)).toBe(true);
    expect(isInviteRole('owner')).toBe(false);
    expect(isInviteRole('')).toBe(false);
  });
});

describe('huella del token', () => {
  it('es SHA-256 en hexadecimal, estable y distinta por token', async () => {
    const hash = await hashToken('abc');
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await hashToken('abc')).toBe(hash);
    expect(await hashToken('abd')).not.toBe(hash);
  });
});
