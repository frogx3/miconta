import { env } from 'cloudflare:workers';
import { t } from '../../i18n/messages';
import { DEFAULT_TIME_ZONE, isTimeZone } from '../date-format';
import { DEFAULT_LOCALE, isSupportedLocale } from '../locale';

const FROM = { name: 'Don Bigo', email: 'no-reply@donbigo.com' };

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Recipient {
  name: string;
  email: string;
  locale: string;
  timeZone: string | null;
}

/** Correo con el código de primer acceso (Cloudflare Email Service, binding `EMAIL`). Lanza si no se pudo enviar. */
export async function sendAccessCode(to: Recipient, code: string, expiresAt: Date, origin: string): Promise<void> {
  const locale = isSupportedLocale(to.locale) ? to.locale : DEFAULT_LOCALE;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short', timeZone: isTimeZone(to.timeZone) ? to.timeZone : DEFAULT_TIME_ZONE }).format(expiresAt);
  const url = `${origin}/acceso?codigo=${encodeURIComponent(code)}`;
  const lines = {
    greeting: t(locale, 'access.email.greeting', { name: to.name }),
    intro: t(locale, 'access.email.intro'),
    cta: t(locale, 'access.email.cta'),
    expires: t(locale, 'access.email.expires', { date }),
  };
  await env.EMAIL.send({
    from: FROM,
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
