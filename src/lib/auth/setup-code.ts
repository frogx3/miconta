/**
 * Código de configuración del primer administrador.
 *
 * El primer usuario que se registra queda como administrador. Con la app pública en internet,
 * cualquiera que encontrara la URL antes que tú podría adueñarse del sistema. Por eso en producción
 * (URL https) el primer registro exige un código secreto que solo conoce quien despliega.
 * Falla cerrado: si es producción y no hay código configurado, nadie puede registrarse.
 */
export interface SetupConfig {
  required: boolean;
  code: string | null;
}

export function setupConfig(baseURL: string, code: string | null | undefined): SetupConfig {
  const normalized = code?.trim() || null;
  // Se exige en producción, y también en local si se configura un código (útil para probarlo).
  return { required: normalized !== null || baseURL.startsWith('https://'), code: normalized };
}

/** Comparación sin atajos: el tiempo no revela cuántos caracteres coinciden. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return difference === 0;
}

export type SetupCheck = 'ok' | 'not_configured' | 'invalid';

export function checkSetupCode(config: SetupConfig, provided: string | null | undefined): SetupCheck {
  if (!config.required) return 'ok';
  if (!config.code) return 'not_configured';
  return typeof provided === 'string' && timingSafeEqual(provided.trim(), config.code) ? 'ok' : 'invalid';
}
