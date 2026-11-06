import { handle } from '@astrojs/cloudflare/handler';
import PostalMime from 'postal-mime';
import { runPushReminders, runReminders } from './lib/agenda/reminders';
import { whatsappConfig } from './lib/agenda/whatsapp';
import { getDb } from './lib/auth';
import { emailCaptureEnabled } from './lib/email/config';
import { receiveEmail } from './lib/email/inbound';
import { dkimPassDomains, htmlToText } from './lib/email/notice';
import { sha256Hex } from './lib/import/parse';
import { vapidConfig } from './lib/push/webpush';
import { expireBackups, runBackup, type BackupJob } from './lib/me/backup';
import { notifyBackupReady } from './lib/me/notify';
import { purgeExpired } from './lib/me/lifecycle';

/** Un aviso de cargo pesa unos KB; lo demás (adjuntos, boletines) no se procesa. */
const MAX_EMAIL_BYTES = 1_000_000;

/**
 * Punto de entrada del Worker: las páginas las sirve Astro y el correo que llega a `<token>@<INBOUND_EMAIL_DOMAIN>`
 * (Email Routing, regla comodín hacia este Worker) se procesa aquí. El cron diario manda los recordatorios por WhatsApp y push y purga cuentas y respaldos vencidos; la cola genera los respaldos.
 */
export default {
  fetch: handle,

  async email(message, env) {
    if (!emailCaptureEnabled()) return message.setReject('Unknown address');
    if (message.rawSize > MAX_EMAIL_BYTES) return message.setReject('Message too large');
    const token = message.to.split('@')[0]!.split('+')[0]!.toLowerCase();
    if (!/^[a-z2-7]{26}$/.test(token)) return message.setReject('Unknown address');

    const raw = await new Response(message.raw).arrayBuffer();
    const email = await PostalMime.parse(raw);
    // shortcut: confía en el primer Authentication-Results que agregó Cloudflare al recibir (los de abajo los pudo
    // escribir el remitente). Verificar con un correo real que Email Routing lo agrega; si no, todo queda en revisión.
    const auth = email.headers.find((h) => (h.key === 'authentication-results' || h.key === 'arc-authentication-results') && /cloudflare/i.test(h.value));

    const result = await receiveEmail(getDb(), env.FILES, {
      token,
      messageKey: email.messageId?.slice(0, 300) ?? (await sha256Hex(new TextDecoder().decode(raw))),
      fromAddress: email.from?.address ?? message.from,
      subject: email.subject ?? '',
      text: email.text?.trim() ? email.text : htmlToText(email.html ?? ''),
      dkimDomains: auth ? dkimPassDomains([auth.value]) : [],
      raw,
    });
    if (result === 'rejected') message.setReject('Unknown address');
  },

  /** Cola `miconta-backups`: genera los CSV de un respaldo y avisa por push a quien lo pidió. */
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        if ((await runBackup(getDb(), env.FILES, message.body.backupId)) === 'ready') await notifyBackupReady(getDb(), message.body.backupId);
        message.ack();
      } catch (e) {
        console.error('respaldo falló', message.body.backupId, e instanceof Error ? e.message : e);
        // runBackup ya lo marcó como fallido; no se reintenta para no dejar al usuario esperando en bucle.
        message.ack();
      }
    }
  },

  async scheduled(_controller, env, ctx) {
    const now = new Date();
    const log = (channel: string) => (counts: { sent: number; failed: number; skipped: number; errors: number }) =>
      console.log(`recordatorios (${channel}): ${counts.sent} enviados, ${counts.failed} fallidos, ${counts.skipped} saltados, ${counts.errors} errores`);
    const fail = (channel: string) => (e: unknown) => console.error(`recordatorios (${channel}): corrida falló`, e instanceof Error ? e.message : e);
    const whatsapp = whatsappConfig();
    if (whatsapp) ctx.waitUntil(runReminders(getDb(), whatsapp, now).then(log('whatsapp')).catch(fail('whatsapp')));
    const vapid = vapidConfig();
    if (vapid) ctx.waitUntil(runPushReminders(getDb(), vapid, now).then(log('push')).catch(fail('push')));
    ctx.waitUntil(
      Promise.all([purgeExpired(getDb(), env.FILES, now), expireBackups(getDb(), env.FILES, now)])
        .then(([users, backups]) => console.log(`limpieza: ${users} cuentas purgadas, ${backups} respaldos vencidos`))
        .catch((e: unknown) => console.error('limpieza falló', e instanceof Error ? e.message : e)),
    );
  },
} satisfies ExportedHandler<Env, BackupJob>;
