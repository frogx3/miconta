import type { MessageKey } from '../../i18n/messages';

/** Traduce el error de Better Auth (código o estado HTTP) a la clave de un mensaje i18n. */
export function authErrorKey(error: { code?: string | null; status?: number | null } | null | undefined): MessageKey {
  const code = error?.code ?? '';
  if (error?.status === 429) return 'auth.error.tooMany';
  if (code === 'INVALID_EMAIL_OR_PASSWORD') return 'auth.error.invalidCredentials';
  if (code.startsWith('USER_ALREADY_EXISTS')) return 'auth.error.userExists';
  if (code === 'PASSWORD_TOO_SHORT') return 'auth.error.passwordTooShort';
  if (code === 'INVALID_EMAIL') return 'auth.error.invalidEmail';
  if (code === 'SIGNUP_DISABLED') return 'auth.error.signupClosed';
  if (code === 'INVITE_INVALID') return 'auth.error.inviteInvalid';
  if (code === 'SETUP_CODE_INVALID') return 'auth.error.setupCode';
  if (code === 'SETUP_NOT_CONFIGURED') return 'auth.error.setupNotConfigured';
  return 'auth.error.generic';
}
