/**
 * Punto de entrada SOLO para el CLI de Better Auth (`auth generate`), que necesita importar
 * una instancia sin depender del runtime de Workers. No se usa en la aplicación.
 */
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../../db/schema';
import { createAuthInstance } from './options';

export const auth = createAuthInstance({
  // El CLI solo lee la configuración; este cliente nunca ejecuta consultas.
  db: drizzle({} as D1Database, { schema }),
  secret: 'cli-only-not-a-real-secret',
  baseURL: 'http://localhost:4321',
  allowSignup: false,
});
