import { t, type MessageKey } from '../../i18n/messages';
import type { Locale } from '../locale';
import { CATEGORY_COLORS } from './validation';

const KEYS: MessageKey[] = [
  'category.default.groceries',
  'category.default.dining',
  'category.default.transport',
  'category.default.utilities',
  'category.default.subscriptions',
  'category.default.health',
  'category.default.entertainment',
  'category.default.online',
  'category.default.other',
];

/** Categorías sugeridas, con el nombre en el idioma del usuario (se guardan tal cual, son suyas desde ahí). */
export function defaultCategories(locale: Locale): { name: string; color: string }[] {
  return KEYS.map((key, index) => ({ name: t(locale, key), color: CATEGORY_COLORS[index % CATEGORY_COLORS.length]! }));
}
