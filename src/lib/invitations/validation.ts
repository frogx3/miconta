/** Lo que se puede elegir en «¿Qué te gustaría ordenar primero?» del formulario de la landing. */
export const INTERESTS = ['cards', 'agenda', 'spending', 'savings'] as const;
export type Interest = (typeof INTERESTS)[number];

export interface InvitationRequest {
  name: string;
  email: string;
  interest: Interest | null;
}

export type RequestCheck = { ok: true; value: InvitationRequest } | { ok: false; bot: true } | { ok: false; bot: false; errors: { field: string; code: string }[] };

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
// Suficiente para atrapar errores de dedo; el correo de respuesta es la verdadera prueba.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Valida el formulario público. `website` es un campo trampa oculto: si trae algo, lo llenó un bot. */
export function checkInvitationRequest(raw: Record<string, unknown>): RequestCheck {
  if (text(raw.website)) return { ok: false, bot: true };
  const errors: { field: string; code: string }[] = [];
  const name = text(raw.name);
  if (!name) errors.push({ field: 'name', code: 'required' });
  else if (name.length > 80) errors.push({ field: 'name', code: 'too_long' });
  const email = text(raw.email).toLowerCase();
  if (!email) errors.push({ field: 'email', code: 'required' });
  else if (email.length > 254 || !EMAIL.test(email)) errors.push({ field: 'email', code: 'invalid_email' });
  if (raw.consent !== true && raw.consent !== 'on' && raw.consent !== 'true') errors.push({ field: 'consent', code: 'required' });
  const interest = (INTERESTS as readonly string[]).includes(raw.interest as string) ? (raw.interest as Interest) : null;
  if (errors.length > 0) return { ok: false, bot: false, errors };
  return { ok: true, value: { name, email, interest } };
}
