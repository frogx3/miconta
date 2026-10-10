import { t } from '../../i18n/messages';
import type { Locale } from '../locale';
import { formatMinor } from '../money-format';

/** Nombre legible de una tarjeta para listados y selectores: "Mi Banorte ···· 4172 · Física". */
export function cardDisplay(card: { accountName: string; last4: string | null; label?: string | null }): string {
  const digits = card.last4 ? ` ···· ${card.last4}` : '';
  const label = card.label ? ` · ${card.label}` : '';
  return `${card.accountName}${digits}${label}`;
}

/** Datos de una tarjeta ya formateados para mostrarlos (el servidor los usa en las páginas y en las respuestas de la API). */
export interface CardFacts {
  type: string;
  last4: string;
  label: string;
  currency: string;
  isCredit: boolean;
  limit: string;
  cutoff: string;
  due: string;
}

const plain = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

/** Una etiqueta que solo repite el formato ("Física", "Digital") no aporta nada junto al tipo de tarjeta. */
function repeatsFormat(label: string, locale: Locale): boolean {
  const formats = [t(locale, 'card.format.physical'), t(locale, 'card.format.digital')].map(plain);
  return formats.includes(plain(label));
}

export function cardFacts(
  card: { kind: 'credit' | 'debit'; isDigital: boolean; last4: string | null; label: string | null; currency: string; creditLimitMinor: number | null; cutoffDay: number | null; paymentDueDay: number | null },
  locale: Locale,
): CardFacts {
  const unset = t(locale, 'card.fact.unset');
  const day = (value: number | null) => (value == null ? unset : t(locale, 'card.fact.day', { day: String(value) }));
  const isCredit = card.kind === 'credit';
  return {
    type: t(locale, `card.type.${card.kind}${card.isDigital ? '.digital' : ''}` as 'card.type.credit'),
    last4: card.last4 ? `···· ${card.last4}` : '',
    label: card.label && !repeatsFormat(card.label, locale) ? card.label : '',
    currency: card.currency,
    isCredit,
    limit: isCredit ? (card.creditLimitMinor != null ? formatMinor(card.creditLimitMinor, card.currency, locale) : unset) : '',
    cutoff: isCredit ? day(card.cutoffDay) : '',
    due: isCredit ? day(card.paymentDueDay) : '',
  };
}
