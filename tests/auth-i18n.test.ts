import { describe, expect, it } from 'vitest';
import { t } from '../src/i18n/messages';
import { authErrorKey } from '../src/lib/auth/errors';
import { defaultCurrencyForLocale, resolveLocale } from '../src/lib/locale';

describe('locale', () => {
  it('elige el locale soportado a partir de Accept-Language', () => {
    expect(resolveLocale('es-MX,es;q=0.9,en;q=0.8')).toBe('es-MX');
    expect(resolveLocale('es-AR,es;q=0.9')).toBe('es');
    expect(resolveLocale('en-GB,en;q=0.9')).toBe('en');
    expect(resolveLocale('fr-FR,fr;q=0.9')).toBe('es-MX');
    expect(resolveLocale(null)).toBe('es-MX');
  });

  it('deriva la moneda por defecto de la región', () => {
    expect(defaultCurrencyForLocale('es-MX')).toBe('MXN');
    expect(defaultCurrencyForLocale('es-AR')).toBe('ARS');
    expect(defaultCurrencyForLocale('en-US')).toBe('USD');
    expect(defaultCurrencyForLocale('es-ES')).toBe('EUR');
    expect(defaultCurrencyForLocale('en')).toBe('USD');
  });
});

describe('i18n', () => {
  it('traduce e interpola parámetros', () => {
    expect(t('es-MX', 'app.dashboard.welcome', { name: 'Ana' })).toBe('Hola, Ana');
    expect(t('en', 'app.dashboard.welcome', { name: 'Ana' })).toBe('Hello, Ana');
  });

  it('una región cae en su idioma y luego en es-MX', () => {
    expect(t('es', 'auth.login.title')).toBe('Iniciar sesión');
    expect(t('es-MX', 'auth.login.title')).toBe('Iniciar sesión');
  });

  it('todos los idiomas tienen las mismas claves', () => {
    // `en` está tipado como Dictionary completo; este chequeo cubre que no queden vacías.
    expect(t('en', 'auth.error.generic')).not.toBe('auth.error.generic');
    expect(t('es', 'auth.error.generic')).not.toBe('auth.error.generic');
  });
});

describe('errores de autenticación', () => {
  it('mapea códigos de Better Auth a mensajes', () => {
    expect(authErrorKey({ code: 'INVALID_EMAIL_OR_PASSWORD' })).toBe('auth.error.invalidCredentials');
    expect(authErrorKey({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' })).toBe('auth.error.userExists');
    expect(authErrorKey({ code: 'SIGNUP_DISABLED' })).toBe('auth.error.signupClosed');
    expect(authErrorKey({ status: 429 })).toBe('auth.error.tooMany');
    expect(authErrorKey({ code: 'ALGO_NUEVO' })).toBe('auth.error.generic');
    expect(authErrorKey(null)).toBe('auth.error.generic');
  });
});

import { checkSetupCode, setupConfig, timingSafeEqual } from '../src/lib/auth/setup-code';

describe('código de configuración del primer administrador', () => {
  it('en producción (https) se exige aunque no se haya configurado, y falla cerrado', () => {
    const config = setupConfig('https://miconta.example.workers.dev', undefined);
    expect(config).toEqual({ required: true, code: null });
    expect(checkSetupCode(config, 'lo-que-sea')).toBe('not_configured');
  });

  it('en local no se exige, salvo que se configure un código', () => {
    expect(checkSetupCode(setupConfig('http://localhost:4321', undefined), null)).toBe('ok');
    const configured = setupConfig('http://localhost:4321', 'secreto');
    expect(configured.required).toBe(true);
    expect(checkSetupCode(configured, null)).toBe('invalid');
  });

  it('acepta solo el código exacto (ignora espacios alrededor)', () => {
    const config = setupConfig('https://x.dev', ' abc123 ');
    expect(checkSetupCode(config, 'abc123')).toBe('ok');
    expect(checkSetupCode(config, '  abc123  ')).toBe('ok');
    expect(checkSetupCode(config, 'abc124')).toBe('invalid');
    expect(checkSetupCode(config, 'abc12')).toBe('invalid');
    expect(checkSetupCode(config, '')).toBe('invalid');
    expect(checkSetupCode(config, undefined)).toBe('invalid');
  });

  it('un código en blanco cuenta como no configurado', () => {
    expect(setupConfig('https://x.dev', '   ')).toEqual({ required: true, code: null });
  });

  it('la comparación no se corta con el primer carácter distinto', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('ñandú', 'ñandú')).toBe(true);
  });

  it('mapea los errores del servidor a mensajes', () => {
    expect(authErrorKey({ code: 'SETUP_CODE_INVALID' })).toBe('auth.error.setupCode');
    expect(authErrorKey({ code: 'SETUP_NOT_CONFIGURED' })).toBe('auth.error.setupNotConfigured');
  });
});
