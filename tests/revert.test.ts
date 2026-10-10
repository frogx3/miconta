import { describe, expect, it } from 'vitest';
import { decideRevert, type RevertFacts } from '../src/lib/import/revert';

const clean: RevertFacts = {
  status: 'applied',
  isLatest: true,
  movementCount: 105,
  created: [{ planId: 'p-new', name: 'Seguro', laterEvents: 0, foreignMovements: 0 }],
  advanced: [{ planId: 'p-old', name: 'Gimnasio', installmentNo: 6, paidInstallments: 6, laterEvents: 0, previousStatus: 'review' }],
};

describe('deshacer una carga', () => {
  it('una carga limpia y reciente se puede deshacer: borra sus planes y restaura los avanzados', () => {
    expect(decideRevert(clean)).toEqual({
      ok: true,
      movements: 105,
      deletePlanIds: ['p-new'],
      undo: [{ planId: 'p-old', name: 'Gimnasio', installmentNo: 6, restorePaid: 5, restoreStatus: 'review' }],
    });
  });

  it('una carga ya revertida no se puede revertir otra vez', () => {
    expect(decideRevert({ ...clean, status: 'reverted' })).toEqual({ ok: false, reason: 'already_reverted' });
  });

  it('solo se deshace la última carga de la tarjeta', () => {
    expect(decideRevert({ ...clean, isLatest: false })).toEqual({ ok: false, reason: 'not_latest' });
  });

  it('un plan creado por la carga que cambió después bloquea (no se pierde trabajo)', () => {
    const result = decideRevert({ ...clean, created: [{ planId: 'p-new', name: 'Seguro', laterEvents: 2, foreignMovements: 0 }] });
    expect(result).toEqual({ ok: false, reason: 'plans_changed', blockers: [{ planId: 'p-new', name: 'Seguro', why: 'changed_after' }] });
  });

  it('un plan creado con cargos de otra carga vinculados bloquea', () => {
    const result = decideRevert({ ...clean, created: [{ planId: 'p-new', name: 'Seguro', laterEvents: 0, foreignMovements: 3 }] });
    expect(result).toMatchObject({ ok: false, blockers: [{ planId: 'p-new', why: 'linked_elsewhere' }] });
  });

  it('un plan avanzado con cambios posteriores bloquea', () => {
    const result = decideRevert({ ...clean, advanced: [{ planId: 'p-old', name: 'Gimnasio', installmentNo: 6, paidInstallments: 6, laterEvents: 1, previousStatus: 'active' }] });
    expect(result).toMatchObject({ ok: false, blockers: [{ planId: 'p-old', why: 'changed_after' }] });
  });

  it('un plan avanzado cuyos pagos ya no coinciden bloquea aunque no haya eventos', () => {
    const result = decideRevert({ ...clean, advanced: [{ planId: 'p-old', name: 'Gimnasio', installmentNo: 6, paidInstallments: 8, laterEvents: 0, previousStatus: 'active' }] });
    expect(result).toMatchObject({ ok: false, reason: 'plans_changed' });
  });

  it('lista todos los planes que bloquean, no solo el primero', () => {
    const result = decideRevert({
      ...clean,
      created: [{ planId: 'a', name: 'A', laterEvents: 1, foreignMovements: 0 }],
      advanced: [{ planId: 'b', name: 'B', installmentNo: 2, paidInstallments: 2, laterEvents: 4, previousStatus: null }],
    });
    expect(result).toMatchObject({ ok: false, blockers: [{ planId: 'a' }, { planId: 'b' }] });
  });

  it('en cargas antiguas sin estado previo, el plan vuelve a activo', () => {
    const result = decideRevert({ ...clean, advanced: [{ planId: 'p-old', name: 'G', installmentNo: 12, paidInstallments: 12, laterEvents: 0, previousStatus: null }] });
    expect(result).toMatchObject({ ok: true, undo: [{ restorePaid: 11, restoreStatus: 'active' }] });
  });

  it('una carga sin planes se deshace con solo borrar sus movimientos', () => {
    expect(decideRevert({ status: 'applied', isLatest: true, movementCount: 7, created: [], advanced: [] })).toEqual({ ok: true, movements: 7, deletePlanIds: [], undo: [] });
  });
});
