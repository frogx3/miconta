import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/auth';
import { setBalance } from '../../../../lib/agenda/balance';
import { validateBalance } from '../../../../lib/agenda/validation';
import { todayISO } from '../../../../lib/date-format';
import { json, requireWorkspaceWithBody, validationError } from '../../../../lib/http';

/** Saldo global de hoy en la moneda del espacio: se guarda la diferencia con el historial como ajuste. */
export const PUT: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });

  const currency = access.workspace.defaultCurrency;
  const parsed = validateBalance(access.body, { locale: locals.locale, currency });
  if (!parsed.ok) return validationError(parsed.errors);
  const result = await setBalance(getDb(), access.workspace.id, { currency, amountMinor: parsed.value.amountMinor, date: todayISO(locals.timeZone), userId: access.userId });
  return json(200, { result });
};
