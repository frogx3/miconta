import { describe, expect, it } from 'vitest';
import { checkInvitationRequest } from '../src/lib/invitations/validation';

describe('solicitud de invitación', () => {
  const valid = { name: '  Ana López ', email: ' Ana@Ejemplo.MX ', interest: 'agenda', consent: true };

  it('normaliza nombre y correo y guarda el interés', () => {
    expect(checkInvitationRequest(valid)).toEqual({ ok: true, value: { name: 'Ana López', email: 'ana@ejemplo.mx', interest: 'agenda' } });
  });

  it('un interés desconocido se guarda vacío, no es error', () => {
    const result = checkInvitationRequest({ ...valid, interest: 'cripto' });
    expect(result.ok && result.value.interest).toBeNull();
  });

  it('exige nombre, correo válido y consentimiento', () => {
    const result = checkInvitationRequest({ name: '', email: 'ana@', consent: false });
    expect(result).toEqual({
      ok: false,
      bot: false,
      errors: [
        { field: 'name', code: 'required' },
        { field: 'email', code: 'invalid_email' },
        { field: 'consent', code: 'required' },
      ],
    });
    expect(checkInvitationRequest({ ...valid, name: 'x'.repeat(81) })).toMatchObject({ ok: false, errors: [{ field: 'name', code: 'too_long' }] });
  });

  it('el campo trampa lleno delata a un bot aunque lo demás sea válido', () => {
    expect(checkInvitationRequest({ ...valid, website: 'http://spam.example' })).toEqual({ ok: false, bot: true });
  });
});
