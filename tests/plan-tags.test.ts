import { describe, expect, it } from 'vitest';
import { MAX_TAG_LENGTH, plansWithTag, sameTagName, validateTagName } from '../src/lib/plans/tags';

describe('etiquetas de planes', () => {
  it('normaliza espacios y conserva cómo la escribió la persona', () => {
    expect(validateTagName('  De   Ana ')).toEqual({ ok: true, name: 'De Ana' });
    expect(validateTagName('casa')).toEqual({ ok: true, name: 'casa' });
  });

  it('rechaza vacías, solo espacios, no texto y demasiado largas', () => {
    expect(validateTagName('')).toEqual({ ok: false, code: 'required' });
    expect(validateTagName('   ')).toEqual({ ok: false, code: 'required' });
    expect(validateTagName(null)).toEqual({ ok: false, code: 'required' });
    expect(validateTagName(42)).toEqual({ ok: false, code: 'required' });
    expect(validateTagName('x'.repeat(MAX_TAG_LENGTH + 1))).toEqual({ ok: false, code: 'too_long' });
    expect(validateTagName('x'.repeat(MAX_TAG_LENGTH))).toMatchObject({ ok: true });
  });

  it('mayúsculas no distinguen etiquetas, los acentos sí', () => {
    expect(sameTagName('Casa', 'casa')).toBe(true);
    expect(sameTagName('casa', 'cása')).toBe(false);
  });

  it('plansWithTag devuelve los planes que llevan la etiqueta', () => {
    const map = new Map([
      ['p1', [{ id: 't1', name: 'casa' }]],
      ['p2', [{ id: 't1', name: 'casa' }, { id: 't2', name: 'viaje' }]],
      ['p3', [{ id: 't2', name: 'viaje' }]],
    ]);
    expect([...plansWithTag(map, 't1')].sort()).toEqual(['p1', 'p2']);
    expect([...plansWithTag(map, 'nada')]).toEqual([]);
  });
});
