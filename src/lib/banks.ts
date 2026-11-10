import { stripAccents } from './import/text';

/**
 * Catálogo de bancos. La clave se guarda en `accounts.bank_id` y servirá para elegir el lector de estados de
 * cuenta de cada banco. "other" conserva el nombre que escribe el usuario en `accounts.bank`.
 */
export const BANKS = [
  // Orden alfabético por nombre; `aliases` ayuda a reconocer nombres escritos a mano.
  { id: 'amex', name: 'American Express', aliases: ['american express', 'amex'] },
  { id: 'banamex', name: 'Banamex', aliases: ['banamex'] },
  { id: 'azteca', name: 'Banco Azteca', aliases: ['azteca'] },
  { id: 'banjercito', name: 'Banjército', aliases: ['banjercito'] },
  { id: 'banorte', name: 'Banorte', aliases: ['banorte'] },
  { id: 'bbva', name: 'BBVA', aliases: ['bbva', 'bancomer'] },
  { id: 'hsbc', name: 'HSBC', aliases: ['hsbc'] },
  { id: 'invex', name: 'Invex', aliases: ['invex'] },
  { id: 'klar', name: 'Klar', aliases: ['klar'] },
  { id: 'mercadopago', name: 'Mercado Pago', aliases: ['mercado pago', 'mercadopago'] },
  { id: 'plata', name: 'Plata', aliases: ['plata'] },
  { id: 'santander', name: 'Santander', aliases: ['santander'] },
] as const;

export const OTHER_BANK = 'other';
export type BankId = (typeof BANKS)[number]['id'] | typeof OTHER_BANK;

export const bankName = (id: string): string | null => BANKS.find((bank) => bank.id === id)?.name ?? null;
export const isBankId = (value: unknown): value is BankId => value === OTHER_BANK || (typeof value === 'string' && bankName(value) !== null);

/** Deduce la clave desde un nombre escrito a mano ("Mi Banorte", "Citibanamex", "BBVA Bancomer"). */
export function bankIdFromText(text: string): BankId {
  const plain = stripAccents(text).toLowerCase();
  // Gana el alias más largo: "banamex" contiene "amex".
  let best: { id: BankId; length: number } = { id: OTHER_BANK, length: 0 };
  for (const bank of BANKS) for (const alias of bank.aliases) if (alias.length > best.length && plain.includes(alias)) best = { id: bank.id, length: alias.length };
  return best.id;
}
