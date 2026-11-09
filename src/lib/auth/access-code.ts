import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { accessCodes } from '../../db/schema';
import { hashToken } from '../members/repo';
import type { Db } from './hooks';

export const ACCESS_CODE_HOURS = 48;

// Sin 0/O, 1/I/L ni U: se dicta y se teclea sin confusiones. 10 caracteres = 50 bits, de sobra para 48 h.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateAccessCode(): string {
  const chars = [...crypto.getRandomValues(new Uint8Array(10))].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/** Como lo escriba la persona (minúsculas, sin guion, con espacios) cuenta igual. */
export const normalizeAccessCode = (input: string): string => {
  const clean = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return clean.length === 10 ? `${clean.slice(0, 5)}-${clean.slice(5)}` : clean;
};

/** Crea un código nuevo y anula los anteriores sin usar: solo vale el último que se mandó. */
export async function issueAccessCode(db: Db, userId: string, now = new Date()): Promise<{ code: string; expiresAt: Date }> {
  const code = generateAccessCode();
  const expiresAt = new Date(now.getTime() + ACCESS_CODE_HOURS * 3_600_000);
  await db.batch([
    db.delete(accessCodes).where(and(eq(accessCodes.userId, userId), isNull(accessCodes.usedAt))),
    db.insert(accessCodes).values({ userId, codeHash: await hashToken(code), expiresAt }),
  ]);
  return { code, expiresAt };
}

/** Consume el código (una sola vez aunque se envíe dos veces a la par) y devuelve su usuario; null si ya no vale. */
export async function claimAccessCode(db: Db, input: string, now = new Date()): Promise<string | null> {
  const code = normalizeAccessCode(input);
  if (code.length !== 11) return null;
  const [row] = await db
    .update(accessCodes)
    .set({ usedAt: now })
    .where(and(eq(accessCodes.codeHash, await hashToken(code)), isNull(accessCodes.usedAt), gt(accessCodes.expiresAt, now)))
    .returning({ userId: accessCodes.userId });
  return row?.userId ?? null;
}

/** Último código mandado a cada usuario (o solo a `userId`), para mostrar en el admin si está pendiente, vencido o usado. */
export async function lastAccessCodes(db: Db, userId?: string) {
  const rows = await db
    .select({ userId: accessCodes.userId, sentAt: accessCodes.createdAt, expiresAt: accessCodes.expiresAt, usedAt: accessCodes.usedAt })
    .from(accessCodes)
    .where(userId ? eq(accessCodes.userId, userId) : undefined)
    .orderBy(desc(accessCodes.createdAt));
  const last = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!last.has(row.userId)) last.set(row.userId, row);
  return last;
}
