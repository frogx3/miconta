import { t } from '../../i18n/messages';
import type { Locale } from '../locale';
import { formatMinor } from '../money-format';
import { CARD_TONES, type CardTone } from './validation';

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

/**
 * Color de cada tarjeta: el que eligió la persona o, si no eligió, uno automático por cuenta (las tarjetas de una cuenta
 * comparten color). Las cuentas se ordenan por fecha de alta para que el color no cambie al archivar o renombrar.
 */
export function cardTones(accounts: { id: string; createdAt: Date; cards: { id: string; tone: CardTone | null }[] }[]): Map<string, CardTone> {
  const byAge = [...accounts].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const tones = new Map<string, CardTone>();
  byAge.forEach((account, index) => {
    for (const card of account.cards) tones.set(card.id, card.tone ?? CARD_TONES[index % CARD_TONES.length]!);
  });
  return tones;
}
