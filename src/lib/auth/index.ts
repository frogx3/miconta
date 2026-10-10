import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../../db/schema';
import { createAuthInstance, type Auth } from './options';
import type { Db } from './hooks';
import { setupConfig } from './setup-code';

export function getDb(): Db {
  return drizzle(env.DB, { schema });
}

/** Variables opcionales (secretos o vars) que no siempre están en los tipos generados de Wrangler. */
const optionalEnv = (name: 'SETUP_CODE' | 'TRUSTED_ORIGINS'): string | undefined => (env as unknown as Record<string, string | undefined>)[name];

export const getSetupConfig = () => setupConfig(env.BETTER_AUTH_URL, optionalEnv('SETUP_CODE'));

export function isSignupAllowedByConfig(): boolean {
  return String(env.ALLOW_SIGNUP).toLowerCase() === 'true';
}

// Los bindings y secretos son constantes dentro de un isolate, así que la instancia se crea una vez.
let instance: Auth | undefined;

export function getAuth(): Auth {
  instance ??= createAuthInstance({
    db: getDb(),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    allowSignup: isSignupAllowedByConfig(),
    setupCode: optionalEnv('SETUP_CODE'),
    trustedOrigins: optionalEnv('TRUSTED_ORIGINS')
      ?.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  });
  return instance;
}
