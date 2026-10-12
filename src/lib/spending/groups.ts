import { isFinanceCharge } from './analysis';

/** Lo mínimo de un movimiento para detectar pagos agrupados por referencia. */
export interface GroupableRow {
  /** Identificador estable del movimiento (id en la base, llave única en una vista previa). */
  key: string;
  /** Tarjeta que hizo el cargo; la referencia solo agrupa dentro de una misma tarjeta. */
  cardKey: string | null;
  reference: string | null;
  descriptionNorm: string;
  chargeMinor: number;
  creditMinor: number;
}

/**
 * Pago a meses con intereses: el banco reparte una misma mensualidad en varios renglones con la misma
 * referencia (el "pago requerido", los intereses y el IVA sobre intereses) y, el primer mes, abona la compra
 * original. Las filas no se tocan; el grupo se calcula al leerlas.
 */
export interface PaymentGroup {
  /** El cargo que no es financiero: el "pago requerido". El grupo se muestra y se convierte en plan desde él. */
  principalKey: string;
  /** Todos los cargos del pago (principal + intereses + IVA); son los que se vinculan a un plan. */
  chargeKeys: string[];
  /** Abonos con la misma referencia: la compra original que el banco revierte al convertirla a meses. */
  creditKeys: string[];
  /** Suma de los cargos: lo que realmente se paga ese mes. */
  totalMinor: number;
  /** Parte de la suma que son intereses e IVA. */
  financeMinor: number;
}

/**
 * Detecta los grupos. Solo agrupa cuando hay certeza: misma tarjeta y referencia, al menos un cargo de
 * intereses/IVA y exactamente un cargo que no lo es (si hay más de uno no se adivina cuál es el principal).
 * Devuelve los grupos por llave del principal.
 */
export function paymentGroups(rows: GroupableRow[]): Map<string, PaymentGroup> {
  const buckets = new Map<string, GroupableRow[]>();
  for (const row of rows) {
    if (!row.reference) continue;
    const id = `${row.cardKey ?? ''}|${row.reference}`;
    const bucket = buckets.get(id);
    if (bucket) bucket.push(row);
    else buckets.set(id, [row]);
  }

  const groups = new Map<string, PaymentGroup>();
  for (const bucket of buckets.values()) {
    const charges = bucket.filter((row) => row.chargeMinor > 0);
    const finance = charges.filter((row) => isFinanceCharge(row.descriptionNorm));
    const principals = charges.filter((row) => !isFinanceCharge(row.descriptionNorm));
    if (finance.length === 0 || principals.length !== 1) continue;
    const principal = principals[0]!;
    groups.set(principal.key, {
      principalKey: principal.key,
      chargeKeys: charges.map((row) => row.key),
      creditKeys: bucket.filter((row) => row.creditMinor > 0 && row.chargeMinor <= 0).map((row) => row.key),
      totalMinor: charges.reduce((sum, row) => sum + row.chargeMinor, 0),
      financeMinor: finance.reduce((sum, row) => sum + row.chargeMinor, 0),
    });
  }
  return groups;
}

/** Llaves que se ocultan como filas sueltas porque se muestran dentro del grupo de su principal. */
export function groupedMemberKeys(groups: Map<string, PaymentGroup>): Set<string> {
  const hidden = new Set<string>();
  for (const group of groups.values()) {
    for (const key of [...group.chargeKeys, ...group.creditKeys]) if (key !== group.principalKey) hidden.add(key);
  }
  return hidden;
}
