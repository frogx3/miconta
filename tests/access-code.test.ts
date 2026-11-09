import { describe, expect, it } from 'vitest';
import { generateAccessCode, normalizeAccessCode } from '../src/lib/auth/access-code';

describe('código de primer acceso', () => {
  it('son 10 caracteres sin ambiguos, en dos grupos', () => {
    for (let i = 0; i < 200; i++) expect(generateAccessCode()).toMatch(/^[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/);
  });

  it('acepta el código como lo escriba la persona', () => {
    expect(normalizeAccessCode(' abcde fghjk ')).toBe('ABCDE-FGHJK');
    expect(normalizeAccessCode('abcde-fghjk')).toBe('ABCDE-FGHJK');
    expect(normalizeAccessCode('abc')).toBe('ABC');
  });
});
