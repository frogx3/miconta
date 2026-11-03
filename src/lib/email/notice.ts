import { parseDate } from '../import/dates';
import { parseMoney } from '../import/money';
import { stripAccents } from '../import/text';

/**
 * Lectura de los avisos de cargo que mandan los bancos por correo. Todo aquí es puro (sin red ni base)
 * para poder probarlo con correos de ejemplo.
 *
 * El lector se ancla en etiquetas ("Monto", "Comercio", "Terminación"...) en lugar de un formato por banco:
 * shortcut: lector genérico por etiquetas; cuando haya correos reales de cada banco, añadir sus etiquetas
 * (o un lector propio) con el correo como caso de prueba en tests/email.test.ts.
 */

export interface EmailNotice {
  /** Fecha de operación que trae el aviso (no la de recepción), ISO. */
  date: string;
  /** Monto como texto decimal con punto ("1234.56"); los decimales finales los fija la moneda de la tarjeta. */
  amount: string;
  merchant: string;
  reference: string | null;
  last4: string;
  kind: 'charge' | 'credit';
}

export type Classified =
  | { kind: 'confirmation'; code: string | null }
  | { kind: 'notice'; notice: EmailNotice }
  | { kind: 'unparsed' };

const GMAIL_FORWARDING = 'forwarding-noreply@google.com';

/** HTML → texto: cada celda, renglón o párrafo en su propia línea, para que etiqueta y valor queden juntos. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h\d|table)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim();
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", dollar: '$' };
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return named[code.toLowerCase()] ?? whole;
  });
}

/** Dominios con `dkim=pass` según los encabezados Authentication-Results del servidor que recibió el correo. */
export function dkimPassDomains(authResults: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const header of authResults) {
    for (const match of header.matchAll(/dkim=pass\b[^;]*?header\.(?:d=|i=@?)([a-z0-9.-]+)/gi)) domains.add(match[1]!.toLowerCase().replace(/\.$/, ''));
  }
  return [...domains];
}

/** Buzones de uso personal: firmar con ellos no prueba que el aviso venga de un banco. */
const MAILBOX_PROVIDERS = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'yahoo.com', 'proton.me', 'protonmail.com', 'onmicrosoft.com'];

const within = (domain: string, parent: string) => domain === parent || domain.endsWith(`.${parent}`);

/**
 * Dominio en el que se puede confiar para un correo: uno con firma DKIM válida que coincide con el del
 * remitente (alineación, como DMARC) y que no es un proveedor de correo personal. Nulo si no hay.
 */
export function trustableDomain(fromAddress: string, dkimDomains: readonly string[]): string | null {
  const fromDomain = fromAddress.split('@').pop()?.toLowerCase() ?? '';
  const aligned = dkimDomains.filter((d) => within(fromDomain, d) && !MAILBOX_PROVIDERS.some((p) => within(d, p)));
  // El más corto es el dominio organizacional (banorte.com antes que mail.banorte.com).
  return aligned.sort((a, b) => a.length - b.length)[0] ?? null;
}

export function isTrusted(fromAddress: string, dkimDomains: readonly string[], trusted: readonly string[]): boolean {
  const domain = trustableDomain(fromAddress, dkimDomains);
  return domain !== null && trusted.some((t) => within(domain, t));
}

export function classifyEmail(input: { fromAddress: string; subject: string; text: string }): Classified {
  if (input.fromAddress.toLowerCase() === GMAIL_FORWARDING) {
    const code = /\b(\d{8,10})\b/.exec(input.subject)?.[1] ?? /\b(\d{8,10})\b/.exec(input.text)?.[1] ?? null;
    return { kind: 'confirmation', code };
  }
  const notice = parseNotice(`${input.subject}\n${input.text}`);
  return notice ? { kind: 'notice', notice } : { kind: 'unparsed' };
}

// Se busca sobre texto sin acentos y en minúsculas; los valores se toman del texto original en la misma posición
// (quitar acentos no cambia la longitud porque antes se normaliza a NFC y solo se reemplazan letras sueltas).
const MONEY = String.raw`\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)`;
const SEP = String.raw`\s*(?:mxn|m\.n\.|usd)?\s*[:\-]?\s*`;
const AMOUNT_LABEL = new RegExp(String.raw`(?:monto|importe|cantidad|total)(?: de (?:la )?(?:compra|operacion|transaccion|cargo))?${SEP}${MONEY}`);
const LAST4 = [
  /(?:terminacion|terminada en|termina en|con terminacion|con final|final)\s*[:\-]?\s*(?:[*x•·]+\s*)?(\d{4})\b/,
  /(?:tarjeta|tdc|tdd|cuenta)[^\n\d]{0,30}[*x•·]{2,}\s*(\d{4})\b/,
  /[*x•·]{4,}\s*(\d{4})\b/,
];
const MERCHANT = /(?:comercio|establecimiento|negocio|lugar|concepto|descripcion)\s*[:\-]?\s*([^\n\t]{2,80})/;
const REFERENCE = /(?:numero de referencia|no\.? de referencia|referencia|numero de autorizacion|no\.? de autorizacion|autorizacion|folio)\s*[:\-#]?\s*((?=[a-z-]*\d)[a-z0-9][a-z0-9-]{3,30})\b/;
const DATE_LABEL = /fecha(?: y hora)?(?: de (?:la )?(?:operacion|compra|transaccion|cargo))?\s*[:\-]?\s*([^\n\t]{6,40})/;
const CREDIT_WORDS = /\b(?:devolucion|reembolso|abono|pago recibido|deposito recibido|bonificacion)\b/;

const DATE_FORMATS: [RegExp, string][] = [
  [/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/, 'D/M/YYYY'],
  [/\b(\d{1,2}-\d{1,2}-\d{4})\b/, 'D-M-YYYY'],
  [/\b(\d{1,2}\/\d{1,2}\/\d{2})\b/, 'D/M/YY'],
  [/\b(\d{4}-\d{2}-\d{2})\b/, 'YYYY-MM-DD'],
  [/\b(\d{1,2}[\/\-\s]\p{L}{3,10}\.?[\/\-\s]\d{4})\b/u, 'D MMM YYYY'],
  [/\b(\d{1,2} de \p{L}{3,10} de(?:l)? \d{4})\b/u, 'D de MMMM de YYYY'],
];

function findDate(text: string): string | null {
  for (const [pattern, format] of DATE_FORMATS) {
    const raw = pattern.exec(text)?.[1];
    if (!raw) continue;
    const cleaned = format === 'D MMM YYYY' ? raw.replace(/[\/\-.]/g, ' ').replace(/\s+/g, ' ') : raw.replace(/ del /, ' de ');
    const iso = parseDate(cleaned, format, 'es');
    if (iso) return iso;
  }
  return null;
}

/** Lee un aviso de cargo; nulo si falta algo indispensable (monto, terminación de tarjeta o fecha). */
export function parseNotice(raw: string): EmailNotice | null {
  const original = raw.normalize('NFC');
  const text = stripAccents(original).toLowerCase();

  const amountMatch = AMOUNT_LABEL.exec(text);
  let amountRaw = amountMatch?.[1];
  if (!amountRaw) {
    // Sin etiqueta solo vale si el correo trae un único monto con signo de pesos.
    const all = [...text.matchAll(/\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g)].map((m) => m[1]!);
    if (new Set(all).size === 1) amountRaw = all[0];
  }
  const amountMinor = amountRaw ? parseMoney(amountRaw, { decimalSeparator: '.', thousandsSeparator: ',', minorDigits: 2 }) : null;
  if (!amountMinor || amountMinor <= 0) return null;

  const last4 = LAST4.map((p) => p.exec(text)?.[1]).find(Boolean);
  if (!last4) return null;

  const labeled = DATE_LABEL.exec(text);
  const date = (labeled && findDate(labeled[1]!)) || findDate(text);
  if (!date) return null;

  const merchantMatch = MERCHANT.exec(text);
  const merchant = merchantMatch ? original.slice(merchantMatch.index + merchantMatch[0].length - merchantMatch[1]!.length, merchantMatch.index + merchantMatch[0].length).trim() : '';
  const reference = REFERENCE.exec(text)?.[1]?.toUpperCase() ?? null;

  return {
    date,
    amount: (amountMinor / 100).toFixed(2),
    merchant: merchant || 'Aviso por correo',
    reference,
    last4,
    kind: CREDIT_WORDS.test(text) ? 'credit' : 'charge',
  };
}

/** Referencia comparable entre el aviso y el CSV: solo letras y dígitos, sin ceros a la izquierda. */
export function normalizeReference(reference: string | null | undefined): string | null {
  const value = (reference ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
  return value.length >= 4 ? value : null;
}
