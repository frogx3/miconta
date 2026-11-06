import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema';
import { t } from '../../i18n/messages';
import type { Db } from '../auth/hooks';
import { DEFAULT_LOCALE, isSupportedLocale } from '../locale';
import { sendPush, vapidConfig } from '../push/webpush';

/** Avisa por push a quien pidió el respaldo (si tiene push activo). El aviso dentro de la app sale de `backup_exports`. */
export async function notifyBackupReady(db: Db, backupId: string, now = new Date()): Promise<void> {
  const cfg = vapidConfig();
  if (!cfg) return;
  const [row] = await db
    .select({ userId: schema.backupExports.requestedBy, locale: schema.user.locale })
    .from(schema.backupExports)
    .innerJoin(schema.user, eq(schema.user.id, schema.backupExports.requestedBy))
    .where(eq(schema.backupExports.id, backupId))
    .limit(1);
  if (!row) return;
  const locale = isSupportedLocale(row.locale) ? row.locale : DEFAULT_LOCALE;
  const message = { title: t(locale, 'me.backup.push.title'), body: t(locale, 'me.backup.push.body'), url: '/app/cuenta#respaldo', tag: `backup:${backupId}` };
  for (const sub of await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, row.userId))) {
    const result = await sendPush(cfg, sub, message, now);
    if (!result.ok && result.gone) await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, sub.id));
  }
}
