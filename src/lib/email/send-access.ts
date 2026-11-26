import { env } from 'cloudflare:workers';
import { WorkerMailer } from 'worker-mailer';
import { accessEmailHtml, brandEmailHtml, type AccessEmailText } from './access-template';
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

interface Recipient {
  name: string;
  email: string;
  locale: string;
  timeZone: string | null;
}

/** Buzón de contacto que aparece en la landing y los correos. */
export const CONTACT_EMAIL = 'contacto@donbigo.com';

const localeOf = (to: Pick<Recipient, 'locale'>) => (isSupportedLocale(to.locale) ? to.locale : DEFAULT_LOCALE);
const expiryDate = (to: Recipient, expiresAt: Date) =>
  new Intl.DateTimeFormat(localeOf(to), { dateStyle: 'long', timeStyle: 'short', timeZone: isTimeZone(to.timeZone) ? to.timeZone : DEFAULT_TIME_ZONE }).format(expiresAt);

async function send(to: Pick<Recipient, 'name' | 'email'>, subject: string, text: string, html: string): Promise<void> {
  const smtp = smtpConfig();
  if (!smtp) throw new Error('SMTP_NOT_CONFIGURED');
  await WorkerMailer.send(smtp.options, { from: { name: 'Don Bigo', email: smtp.from }, to: { name: to.name, email: to.email }, subject, text, html });
}

/** Texto plano equivalente al HTML de `brandEmailHtml`. */
const plain = (lines: AccessEmailText, code: string | null, url: string | null) =>
  [lines.greeting, lines.intro, code, url && `${lines.cta}: ${url}`, lines.expires, lines.steps?.map((step, i) => `${i + 1}. ${step}`).join('\n'), lines.note].filter(Boolean).join('\n\n') + '\n';

/**
 * Bienvenida a la beta al aprobar una solicitud: mascota, código de un solo uso, botón a /acceso, primeros pasos,
 * el beneficio de la beta y el contacto. Lanza si no hay SMTP o no se pudo enviar.
 */
export async function sendWelcome(to: Recipient, code: string, expiresAt: Date, origin: string): Promise<void> {
  const locale = localeOf(to);
  const url = `${origin}/acceso?codigo=${encodeURIComponent(code)}`;
  const lines: AccessEmailText = {
    greeting: t(locale, 'access.email.greeting', { name: to.name }),
    intro: t(locale, 'welcome.email.intro'),
    cta: t(locale, 'access.email.cta'),
    expires: t(locale, 'welcome.email.expires', { date: expiryDate(to, expiresAt) }),
    steps: [t(locale, 'welcome.email.step1'), t(locale, 'welcome.email.step2'), t(locale, 'welcome.email.step3')],
    note: t(locale, 'welcome.email.note', { contact: CONTACT_EMAIL }),
    footer: t(locale, 'welcome.email.footer'),
  };
  await send(to, t(locale, 'welcome.email.subject'), plain(lines, code, url), brandEmailHtml(lines, { code, url, image: '/brand/email/mascota-sobre.png' }, origin));
}

/** «Recibimos tu solicitud»: solo a correos nuevos (si el correo ya existía no se manda nada). */
export async function sendRequestReceived(to: Pick<Recipient, 'name' | 'email' | 'locale'>, origin: string): Promise<void> {
  const locale = localeOf(to);
  const lines: AccessEmailText = {
    greeting: t(locale, 'access.email.greeting', { name: to.name }),
    intro: t(locale, 'request.email.intro'),
    cta: '',
    expires: '',
    note: t(locale, 'request.email.note', { contact: CONTACT_EMAIL }),
    footer: t(locale, 'request.email.footer'),
  };
  await send(to, t(locale, 'request.email.subject'), plain(lines, null, null), brandEmailHtml(lines, {}, origin));
}

/** Aviso a cada administrador de que llegó una solicitud nueva, con el botón a «Por aprobar». */
export async function sendAdminNewRequest(admins: Pick<Recipient, 'name' | 'email' | 'locale'>[], requester: { name: string; email: string }, origin: string): Promise<void> {
  for (const admin of admins) {
    const locale = localeOf(admin);
    const url = `${origin}/admin/por-aprobar`;
    const lines: AccessEmailText = {
      greeting: t(locale, 'access.email.greeting', { name: admin.name }),
      intro: t(locale, 'adminRequest.email.intro', { name: requester.name, email: requester.email }),
      cta: t(locale, 'adminRequest.email.cta'),
      expires: '',
      footer: t(locale, 'adminRequest.email.footer'),
    };
    await send(admin, t(locale, 'adminRequest.email.subject', { name: requester.name }), plain(lines, null, url), brandEmailHtml(lines, { url }, origin));
  }
}

/** Correo con el código de primer acceso por SMTP. Lanza si no hay SMTP configurado o no se pudo enviar. */
export async function sendAccessCode(to: Recipient, code: string, expiresAt: Date, origin: string): Promise<void> {
  const locale = localeOf(to);
  const url = `${origin}/acceso?codigo=${encodeURIComponent(code)}`;
  const lines: AccessEmailText = {
    greeting: t(locale, 'access.email.greeting', { name: to.name }),
    intro: t(locale, 'access.email.intro'),
    cta: t(locale, 'access.email.cta'),
    expires: t(locale, 'access.email.expires', { date: expiryDate(to, expiresAt) }),
    footer: t(locale, 'access.email.footer'),
  };
  await send(to, t(locale, 'access.email.subject'), plain(lines, code, url), accessEmailHtml(lines, code, url, origin));
}
