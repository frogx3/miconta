import { env } from 'cloudflare:workers';
import { WorkerMailer } from 'worker-mailer';
import { t } from '../../i18n/messages';
import { DEFAULT_TIME_ZONE, isTimeZone } from '../date-format';
import { DEFAULT_LOCALE, isSupportedLocale } from '../locale';

/**
 * Servidor SMTP de salida, configurado con variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM`) y el secreto
 * `SMTP_PASSWORD`. Puerto 465 = TLS directo; cualquier otro (587 por defecto) usa STARTTLS. Cloudflare bloquea el 25.
 */
export function smtpConfig() {
  const vars = env as unknown as Record<string, string | undefined>;
  const host = vars.SMTP_HOST?.trim();
  const from = vars.SMTP_FROM?.trim();
  if (!host || !from) return null;
  const port = Number(vars.SMTP_PORT) || 587;
  const username = vars.SMTP_USER?.trim();
  return {
    from,
    options: { host, port, secure: port === 465, startTls: port !== 465, ...(username ? { credentials: { username, password: vars.SMTP_PASSWORD ?? '' }, authType: ['plain', 'login', 'cram-md5'] as ('plain' | 'login' | 'cram-md5')[] } : {}) },
  };
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Recipient {
  name: string;
  email: string;
  locale: string;
  timeZone: string | null;
}

/** Correo con el código de primer acceso por SMTP. Lanza si no hay SMTP configurado o no se pudo enviar. */
export async function sendAccessCode(to: Recipient, code: string, expiresAt: Date, origin: string): Promise<void> {
  const smtp = smtpConfig();
  if (!smtp) throw new Error('SMTP_NOT_CONFIGURED');
  const locale = isSupportedLocale(to.locale) ? to.locale : DEFAULT_LOCALE;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short', timeZone: isTimeZone(to.timeZone) ? to.timeZone : DEFAULT_TIME_ZONE }).format(expiresAt);
  const url = `${origin}/acceso?codigo=${encodeURIComponent(code)}`;
  const lines = {
    greeting: t(locale, 'access.email.greeting', { name: to.name }),
    intro: t(locale, 'access.email.intro'),
    cta: t(locale, 'access.email.cta'),
    expires: t(locale, 'access.email.expires', { date }),
  };
  await WorkerMailer.send(smtp.options, {
    from: { name: 'Don Bigo', email: smtp.from },
    to: { name: to.name, email: to.email },
    subject: t(locale, 'access.email.subject'),
    text: `${lines.greeting}\n\n${lines.intro}\n\n${code}\n\n${lines.cta}: ${url}\n\n${lines.expires}\n`,
    html: `<div style="font-family:Montserrat,Arial,sans-serif;color:#1d3557;max-width:480px">
<p>${escapeHtml(lines.greeting)}</p>
<p>${escapeHtml(lines.intro)}</p>
<p style="font-size:28px;font-weight:700;letter-spacing:4px;font-family:monospace">${escapeHtml(code)}</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#1d3557;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">${escapeHtml(lines.cta)}</a></p>
<p style="color:#5b6577;font-size:14px">${escapeHtml(lines.expires)}</p>
</div>`,
  });
}
