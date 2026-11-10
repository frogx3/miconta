import type { APIRoute } from 'astro';
import { getDb } from '../../../../lib/auth';
import { createItem, markDone } from '../../../../lib/agenda/repo';
import { todayISO } from '../../../../lib/date-format';
import { validateItem } from '../../../../lib/agenda/validation';
import { json, requireWorkspaceWithBody, validationError } from '../../../../lib/http';

/** Crea un pago o cobro en la moneda del espacio; con `done` se guarda ya pagado o cobrado y mueve el saldo. */
export const POST: APIRoute = async ({ request, locals }) => {
  const access = await requireWorkspaceWithBody(locals, request);
  if ('response' in access) return access.response;
  if (!access.body) return json(400, { code: 'INVALID_JSON' });

  const currency = access.workspace.defaultCurrency;
  const parsed = validateItem(access.body, { locale: locals.locale, currency });
  if (!parsed.ok) return validationError(parsed.errors);
  const db = getDb();
  const { done, ...value } = parsed.value;
  const id = await createItem(db, access.workspace.id, currency, value);
  if (done) {
    // El dinero se movió en la fecha capturada, salvo que sea futura: entonces hoy.
    const today = todayISO(locals.timeZone);
    await markDone(db, access.workspace.id, id, { userId: access.userId, via: 'web', date: value.dueDate < today ? value.dueDate : today });
  }
  return json(201, { id });
};
