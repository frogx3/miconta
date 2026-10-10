export interface EventLike {
  type: string;
  data: unknown;
  comment: string | null;
}

/** Dependencias de presentación: textos del idioma activo y formato de importes/fechas/tasas. */
export interface EventFormat {
  t(key: string, params?: Record<string, string | number>): string;
  money(minor: number): string;
  date(iso: string): string;
  rate(bp: number): string;
}

export interface EventView {
  title: string;
  lines: string[];
  comment: string | null;
}

const MONEY_FIELDS = new Set(['installmentAmountMinor', 'totalAmountMinor']);

function formatValue(field: string, value: unknown, f: EventFormat): string {
  if (MONEY_FIELDS.has(field)) return f.money(Number(value));
  if (field === 'interestRateBp') return f.rate(Number(value));
  if (field === 'firstChargeDate') return f.date(String(value));
  if (field === 'type') return f.t(`import.plan.type.${value}`);
  return String(value);
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

/** Describe un evento del historial de un plan en lenguaje llano ("Mensualidad: $902.36 → $850.00"). */
export function describeEvent(event: EventLike, f: EventFormat): EventView {
  const data = asRecord(event.data);
  const status = (value: unknown) => f.t(`plans.status.${value}`);

  switch (event.type) {
    case 'edited': {
      const lines = Object.entries(asRecord(data.changes)).map(([field, change]) => {
        const { from, to } = asRecord(change);
        return `${f.t(`plan.field.${field}`)}: ${formatValue(field, from, f)} → ${formatValue(field, to, f)}`;
      });
      const moved = asRecord(data.status);
      if ('from' in moved) lines.push(f.t('plan.event.status_changed', { from: status(moved.from), to: status(moved.to) }));
      return { title: f.t('plan.event.edited'), lines, comment: event.comment };
    }
    case 'installment_recorded':
      return { title: f.t('plan.event.installment_recorded', { n: Number(data.installmentNo ?? 0) }), lines: [], comment: event.comment };
    case 'status_changed':
      return { title: f.t('plan.event.status_changed', { from: status(data.from), to: status(data.to) }), lines: [], comment: event.comment };
    case 'settled':
      return { title: f.t('plan.event.settled'), lines: [], comment: event.comment };
    case 'balance_reported':
      return { title: f.t('plan.event.balance_reported', { amount: f.money(Number(data.to)) }), lines: [`${f.money(Number(data.from))} → ${f.money(Number(data.to))}`], comment: event.comment };
    case 'created':
      return { title: f.t('plan.event.created'), lines: [], comment: event.comment };
    default:
      return { title: f.t(`plan.event.${event.type}`), lines: [], comment: event.comment };
  }
}
