import { handle } from '@astrojs/cloudflare/handler';
import PostalMime from 'postal-mime';
import { runReminders } from './lib/agenda/reminders';
import { whatsappConfig } from './lib/agenda/whatsapp';
import { getDb } from './lib/auth';
import { emailCaptureEnabled } from './lib/email/config';
import { receiveEmail } from './lib/email/inbound';
import { dkimPassDomains, htmlToText } from './lib/email/notice';
import { sha256Hex } from './lib/import/parse';

/** Un aviso de cargo pesa unos KB; lo demás (adjuntos, boletines) no se procesa. */
const MAX_EMAIL_BYTES = 1_000_000;

/**
 * Punto de entrada del Worker: las páginas las sirve Astro y el correo que llega a `<token>@<INBOUND_EMAIL_DOMAIN>`
 * (Email Routing, regla comodín hacia este Worker) se procesa aquí. El cron diario manda los recordatorios por WhatsApp.
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

  async scheduled(_controller, _env, ctx) {
    const cfg = whatsappConfig();
    if (!cfg) return;
    ctx.waitUntil(
      runReminders(getDb(), cfg, new Date())
        .then((counts) => console.log(`recordatorios: ${counts.sent} enviados, ${counts.failed} fallidos, ${counts.skipped} saltados, ${counts.errors} errores`))
        .catch((e) => console.error('recordatorios: corrida falló', e instanceof Error ? e.message : e)),
    );
  },
} satisfies ExportedHandler<Env>;
