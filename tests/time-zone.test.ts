import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTimeZone, todayISO } from '../src/lib/date-format';

describe('zona horaria', () => {
  afterEach(() => vi.useRealTimers());

  it('el jueves a las 7 pm en CDMX sigue siendo jueves, aunque en UTC ya sea viernes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T01:00:00Z'));
    expect(todayISO()).toBe('2026-11-05');
    expect(todayISO('America/Mexico_City')).toBe('2026-11-05');
    expect(todayISO('Europe/Madrid')).toBe('2026-11-06');
  });

  it('solo acepta zonas IANA válidas', () => {
    expect(isTimeZone('America/Tijuana')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone(42)).toBe(false);
  });
});
