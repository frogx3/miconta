import { stripAccents } from './import/text';

/**
 * Catálogo de bancos. La clave se guarda en `accounts.bank_id` y servirá para elegir el lector de estados de
 * cuenta de cada banco. "other" conserva el nombre que escribe el usuario en `accounts.bank`.
 */
export const BANKS = [
  { id: 'banorte', name: 'Banorte' },
  { id: 'banamex', name: 'Banamex' },
  { id: 'bbva', name: 'BBVA' },
  { id: 'santander', name: 'Santander' },
  { id: 'banjercito', name: 'Banjército' },
  { id: 'hsbc', name: 'HSBC' },
] as const;

export const OTHER_BANK = 'other';
export type BankId = (typeof BANKS)[number]['id'] | typeof OTHER_BANK;

export const bankName = (id: string): string | null => BANKS.find((bank) => bank.id === id)?.name ?? null;
export const isBankId = (value: unknown): value is BankId => value === OTHER_BANK || (typeof value === 'string' && bankName(value) !== null);

/** Deduce la clave desde un nombre escrito a mano ("Mi Banorte", "Citibanamex", "BBVA Bancomer"). */
export function bankIdFromText(text: string): BankId {
  const plain = stripAccents(text).toLowerCase();
  return BANKS.find((bank) => plain.includes(bank.id))?.id ?? OTHER_BANK;
}
