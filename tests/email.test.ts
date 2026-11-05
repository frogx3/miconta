import { describe, expect, it } from 'vitest';
import { classifyEmail, dkimPassDomains, htmlToText, isTrusted, normalizeReference, parseNotice, trustableDomain } from '../src/lib/email/notice';

// Avisos SINTÉTICOS con la forma típica (etiqueta + valor). Cuando haya correos reales de cada banco, agregarlos aquí.
const tableHtml = `
<html><head><style>td{color:red}</style></head><body>
<p>Estimado cliente, se realizó una compra con tu Tarjeta de Crédito</p>
<table>
  <tr><td>Tarjeta:</td><td>**** **** **** 1234</td></tr>
  <tr><td>Comercio:</td><td>AMAZON MX MARKETPLACE</td></tr>
  <tr><td>Monto:</td><td>$1,234.50 MXN</td></tr>
  <tr><td>Fecha de operación:</td><td>01/11/2026 14:32</td></tr>
  <tr><td>Número de autorización:</td><td>004512</td></tr>
</table>
<p>Saldo disponible: $20,000.00</p>
</body></html>`;

describe('lectura de avisos de cargo', () => {
  it('lee un aviso en tabla HTML', () => {
    expect(parseNotice(htmlToText(tableHtml))).toEqual({
      date: '2026-11-01',
      amount: '1234.50',
      merchant: 'AMAZON MX MARKETPLACE',
      reference: '004512',
      last4: '1234',
      kind: 'charge',
    });
  });

  it('lee un aviso en texto con fecha escrita y terminación', () => {
    const text = 'Compra aprobada\nTu tarjeta con terminación 9876 realizó un cargo.\nImporte: $89.00\nEstablecimiento: OXXO SUC 123\nFecha: 3 de noviembre de 2026\nReferencia: AB12CD';
    expect(parseNotice(text)).toMatchObject({ date: '2026-11-03', amount: '89.00', merchant: 'OXXO SUC 123', reference: 'AB12CD', last4: '9876' });
  });

  it('una devolución es abono', () => {
    expect(parseNotice('Devolución aplicada a tu tarjeta terminación 1111. Monto: $50.00. Fecha 02-nov-2026')).toMatchObject({ kind: 'credit', date: '2026-11-02', amount: '50.00' });
  });

  it('sin terminación, monto o fecha no se adivina', () => {
    expect(parseNotice('Monto: $10.00 Fecha: 01/11/2026')).toBeNull();
    expect(parseNotice('Terminación 1234 Fecha: 01/11/2026')).toBeNull();
    expect(parseNotice('Terminación 1234 Monto: $10.00')).toBeNull();
  });

  it('sin etiqueta de monto solo acepta un único monto con signo de pesos', () => {
    expect(parseNotice('Cargo de $45.00 con tarjeta terminación 2222 el 01/11/2026')).toMatchObject({ amount: '45.00' });
    expect(parseNotice('Cargo de $45.00 con tarjeta terminación 2222 el 01/11/2026. Saldo $900.00')).toBeNull();
  });

  it('una referencia sin dígitos no es referencia', () => {
    expect(parseNotice('Terminación 1234 Monto: $10.00 Fecha: 01/11/2026 Referencia: bancaria')?.reference).toBeNull();
  });
});

describe('clasificación', () => {
  it('reconoce la confirmación de reenvío de Gmail y su código', () => {
    expect(classifyEmail({ fromAddress: 'forwarding-noreply@google.com', subject: '(#123456789) Confirmación de reenvío de Gmail', text: '' })).toEqual({ kind: 'confirmation', code: '123456789' });
  });

  it('un correo que no es aviso queda sin leer', () => {
    expect(classifyEmail({ fromAddress: 'promo@banco.com', subject: 'Conoce nuestras promociones', text: 'Hola' })).toEqual({ kind: 'unparsed' });
  });
});

describe('confianza en el remitente', () => {
  const auth = ['mx.cloudflare.net; dkim=pass header.d=banco.com.mx header.s=s1; dkim=pass header.d=gmail.com; spf=fail', 'x; dkim=fail header.d=evil.com'];

  it('toma solo las firmas válidas', () => {
    expect(dkimPassDomains(auth)).toEqual(['banco.com.mx', 'gmail.com']);
  });

  it('confía en el dominio firmado que coincide con el remitente, nunca en un buzón personal', () => {
    expect(trustableDomain('alertas@notifica.banco.com.mx', ['banco.com.mx', 'gmail.com'])).toBe('banco.com.mx');
    expect(trustableDomain('alguien@gmail.com', ['gmail.com'])).toBeNull();
    expect(trustableDomain('alertas@banco.com.mx', ['otro.com'])).toBeNull();
  });

  it('aplica solo si el dominio está en la lista de confianza', () => {
    expect(isTrusted('alertas@banco.com.mx', ['banco.com.mx'], ['banco.com.mx'])).toBe(true);
    expect(isTrusted('alertas@banco.com.mx', ['banco.com.mx'], [])).toBe(false);
    expect(isTrusted('alertas@banco.com.mx', [], ['banco.com.mx'])).toBe(false);
  });
});

it('normaliza referencias para cruzarlas con el CSV', () => {
  expect(normalizeReference('004512')).toBe('4512');
  expect(normalizeReference(' ab-12 cd ')).toBe('AB12CD');
  expect(normalizeReference('12')).toBeNull();
});
