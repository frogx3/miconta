import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../../db/schema';
import { ownWorkspace, type Db } from '../auth/hooks';
import type { InvitationRequest } from './validation';

export type PendingRequest = Pick<typeof schema.user.$inferSelect, 'id' | 'name' | 'email' | 'locale' | 'timeZone' | 'signupInterest' | 'requestedAt'>;

/**
 * Guarda la solicitud como usuario `pending`: sin espacio, sin contraseña y sin código (no puede entrar).
 * Devuelve false si el correo ya existe; quien llama responde igual en ambos casos para no revelar quién está registrado.
 */
export async function createRequest(db: Db, input: InvitationRequest, locale: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .insert(schema.user)
    .values({
      id: crypto.randomUUID(),
      name: input.name,
      email: input.email,
      locale,
      approvalStatus: 'pending',
      requestedAt: now,
      signupInterest: input.interest,
      privacyAcceptedAt: now,
    })
    .onConflictDoNothing({ target: schema.user.email })
    .returning({ id: schema.user.id });
  return rows.length > 0;
}

const pendingColumns = {
  id: schema.user.id,
  name: schema.user.name,
  email: schema.user.email,
  locale: schema.user.locale,
  timeZone: schema.user.timeZone,
  signupInterest: schema.user.signupInterest,
  requestedAt: schema.user.requestedAt,
};

export async function listPending(db: Db): Promise<PendingRequest[]> {
  return db.select(pendingColumns).from(schema.user).where(eq(schema.user.approvalStatus, 'pending')).orderBy(asc(schema.user.requestedAt));
}

export async function countPending(db: Db): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(schema.user).where(eq(schema.user.approvalStatus, 'pending'));
  return row?.n ?? 0;
}

/**
 * Aprueba solicitudes pendientes en una sola transacción por persona: espacio propio, una contraseña aleatoria que nadie
 * conoce (el código de acceso la reemplaza) y la marca de la beta. Devuelve las que sí estaban pendientes.
 * `hashPassword` es el de Better Auth, para que la cuenta quede igual que las que crea el admin a mano.
 */
export async function approveRequests(db: Db, ids: string[], adminId: string, hashPassword: (password: string) => Promise<string>, now = new Date()): Promise<PendingRequest[]> {
  if (ids.length === 0) return [];
  const pending = await db.select(pendingColumns).from(schema.user).where(and(inArray(schema.user.id, ids), eq(schema.user.approvalStatus, 'pending')));
  for (const person of pending) {
    const random = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    await db.batch([
      db
        .update(schema.user)
        .set({ approvalStatus: 'approved', betaMember: true, reviewedAt: now, reviewedBy: adminId })
        .where(and(eq(schema.user.id, person.id), eq(schema.user.approvalStatus, 'pending'))),
      db.insert(schema.account).values({ id: crypto.randomUUID(), userId: person.id, accountId: person.id, providerId: 'credential', password: await hashPassword(random) }),
      ...ownWorkspace(db, person),
    ]);
  }
  return pending;
}

/** Rechaza solicitudes pendientes; quedan guardadas (con la nota) y el correo no puede volver a pedir. */
export async function rejectRequests(db: Db, ids: string[], adminId: string, note: string | null, now = new Date()): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(schema.user)
    .set({ approvalStatus: 'rejected', reviewedAt: now, reviewedBy: adminId, reviewNote: note })
    .where(and(inArray(schema.user.id, ids), eq(schema.user.approvalStatus, 'pending')))
    .returning({ id: schema.user.id });
  return rows.length;
}

/**
 * Límite de intentos con la tabla `rate_limit` (la misma de Better Auth, con otra llave). Ventana fija: cuenta las
 * peticiones desde la primera de la ventana. Devuelve false si ya se pasó de `max`.
 */
export async function allowAttempt(db: Db, key: string, max: number, windowMs: number, now = Date.now()): Promise<boolean> {
  const [row] = await db
    .insert(schema.rateLimit)
    .values({ id: key, key, count: 1, lastRequest: now })
    .onConflictDoUpdate({
      target: schema.rateLimit.key,
      // Si la ventana ya pasó, vuelve a empezar; si no, suma uno.
      set: {
        count: sql`CASE WHEN ${now} - ${schema.rateLimit.lastRequest} > ${windowMs} THEN 1 ELSE ${schema.rateLimit.count} + 1 END`,
        lastRequest: sql`CASE WHEN ${now} - ${schema.rateLimit.lastRequest} > ${windowMs} THEN ${now} ELSE ${schema.rateLimit.lastRequest} END`,
      },
    })
    .returning({ count: schema.rateLimit.count });
  return (row?.count ?? 1) <= max;
}
