import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin } from 'better-auth/plugins';
import * as schema from '../../db/schema';
import { DEFAULT_LOCALE } from '../locale';
import { createUserHooks, type Db } from './hooks';
import { setupConfig } from './setup-code';

export interface AuthDeps {
  db: Db;
  secret: string;
  baseURL: string;
  allowSignup: boolean;
  /** Código del primer administrador (obligatorio en producción). */
  setupCode?: string | null;
  /** Orígenes adicionales permitidos, p. ej. un dominio propio además de workers.dev. */
  trustedOrigins?: string[];
}

/** Fábrica pura: la usan el runtime (con `env` de Workers) y el CLI que genera el esquema. */
export function createAuthInstance({ db, secret, baseURL, allowSignup, setupCode, trustedOrigins }: AuthDeps) {
  const hooks = createUserHooks(db, allowSignup, setupConfig(baseURL, setupCode));
  const production = baseURL.startsWith('https://');
  return betterAuth({
    secret,
    baseURL,
    ...(trustedOrigins?.length ? { trustedOrigins } : {}),
    // Detrás de Cloudflare la IP real llega en `cf-connecting-ip`. Sin fijarla, el límite de intentos
    // podría leer `x-forwarded-for`, que el cliente puede falsear para esquivarlo.
    ...(production ? { advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } } } : {}),
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      autoSignIn: true,
    },
    user: {
      additionalFields: {
        locale: { type: 'string', required: false, defaultValue: DEFAULT_LOCALE, input: true },
      },
    },
    plugins: [admin({ defaultRole: 'user' })],
    // En Workers cada instancia tiene su propia memoria: el límite de intentos debe vivir en D1.
    rateLimit: { enabled: true, storage: 'database' },
    databaseHooks: {
      user: { create: { before: hooks.before, after: hooks.after } },
    },
  });
}

export type Auth = ReturnType<typeof createAuthInstance>;
