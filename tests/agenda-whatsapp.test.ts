import { describe, expect, it, vi } from 'vitest';

// Las pruebas no corren dentro de un Worker: el entorno se simula.
const env = vi.hoisted(() => ({}) as Record<string, string>);
vi.mock('cloudflare:workers', () => ({ env }));

import { newLinkCode, parseLinkMessage, signItemToken, verifyItemToken, whatsappConfig, whatsappEnabled, type WhatsappConfig } from '../src/lib/agenda/whatsapp';
import { sendReminder, sendText } from '../src/lib/agenda/kapso';
import { mexicoCityToday, reminderOffset, runReminders } from '../src/lib/agenda/reminders';
import type { Db } from '../src/lib/auth/hooks';

const cfg: WhatsappConfig = { apiKey: 'key-123', phoneNumberId: '987', webhookSecret: 's', template: 'recordatorio_pago', businessPhone: '5215500000000' };

describe('token del botón', () => {
  it('firma y verifica', async () => {
    expect(await verifyItemToken('s', await signItemToken('s', 'abc'))).toBe('abc');
    expect(await verifyItemToken('s', await signItemToken('s', 'card:c1:2026-11-20'))).toBe('card:c1:2026-11-20');
  });
  it('alterado u otro secreto → null', async () => {
    const token = await signItemToken('s', 'abc');
    const last = token.at(-1)!;
    expect(await verifyItemToken('s', token.slice(0, -1) + (last === 'A' ? 'B' : 'A'))).toBeNull();
    expect(await verifyItemToken('s', 'abd' + token.slice(3))).toBeNull();
    expect(await verifyItemToken('otro', token)).toBeNull();
    expect(await verifyItemToken('s', 'sin-punto')).toBeNull();
  });
});

describe('vinculación', () => {
  it('lee "Vincular CÓDIGO"', () => {
    expect(parseLinkMessage('Vincular 7kq2x9')).toBe('7KQ2X9');
    expect(parseLinkMessage('  vincular 7kq2x9 ')).toBe('7KQ2X9');
    expect(parseLinkMessage('hola')).toBeNull();
  });
  it('códigos de 6 caracteres sin ambiguos', () => {
    for (let i = 0; i < 50; i++) expect(newLinkCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });
});

describe('configuración', () => {
  it('apagado o incompleto → null', () => {
    expect(whatsappEnabled()).toBe(false);
    Object.assign(env, { WHATSAPP_NOTIFICATIONS: 'true', KAPSO_API_KEY: 'k', KAPSO_PHONE_NUMBER_ID: 'p', KAPSO_WEBHOOK_SECRET: 'w', KAPSO_REMINDER_TEMPLATE: '', KAPSO_BUSINESS_PHONE: '52155' });
    expect(whatsappEnabled()).toBe(true);
    expect(whatsappConfig()).toBeNull();
    env.KAPSO_REMINDER_TEMPLATE = 't';
    expect(whatsappConfig()).toEqual({ apiKey: 'k', phoneNumberId: 'p', webhookSecret: 'w', template: 't', businessPhone: '52155' });
  });
});

describe('envío por Kapso', () => {
  it('manda la plantilla con parámetros y botón', async () => {
    const fetchFn = vi.fn(async () => Response.json({ messages: [{ id: 'wamid.1' }] }));
    const result = await sendReminder(cfg, '5215512345678', { description: 'Renta', amount: '$8,000.00', date: '20 nov', buttonPayload: 'tok' }, fetchFn as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, messageId: 'wamid.1' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.kapso.ai/meta/whatsapp/v24.0/987/messages');
    expect(new Headers(init.headers).get('X-API-Key')).toBe('key-123');
    const body = JSON.parse(String(init.body));
    expect(body.to).toBe('5215512345678');
    expect(body.template.name).toBe(cfg.template);
    expect(body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(['Renta', '$8,000.00', '20 nov']);
    expect(body.template.components[1].parameters[0].payload).toBe('tok');
  });
  it('error de Kapso → ok:false', async () => {
    const fetchFn = async () => new Response('boom', { status: 500 });
    expect(await sendReminder(cfg, '52155', { description: 'a', amount: 'b', date: 'c', buttonPayload: 'd' }, fetchFn as typeof fetch)).toMatchObject({ ok: false });
    expect(await sendText(cfg, '52155', 'hola', fetchFn as typeof fetch)).toBe(false);
  });
  it('texto libre', async () => {
    const fetchFn = vi.fn(async () => Response.json({ messages: [{ id: 'x' }] }));
    expect(await sendText(cfg, '52155', 'Listo', fetchFn as unknown as typeof fetch)).toBe(true);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ messaging_product: 'whatsapp', to: '52155', type: 'text', text: { body: 'Listo' } });
  });
});

describe('recordatorios', () => {
  it('hoy en Ciudad de México', () => {
    expect(mexicoCityToday(new Date('2026-11-06T03:00:00Z'))).toBe('2026-11-05');
    expect(mexicoCityToday(new Date('2026-11-06T06:00:00Z'))).toBe('2026-11-06');
  });
  it('aviso a 7 y a 2 días', () => {
    expect(reminderOffset('2026-11-05', '2026-11-12')).toBe('7d');
    expect(reminderOffset('2026-11-05', '2026-11-07')).toBe('2d');
    expect(reminderOffset('2026-11-05', '2026-11-08')).toBeNull();
    expect(reminderOffset('2026-11-28', '2026-12-05')).toBe('7d');
  });
  it('un espacio que falla no detiene a los demás', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = [
      { workspaceId: 'w1', userId: 'u1', phone: '5215500000001', locale: 'es-MX' },
      { workspaceId: 'w2', userId: 'u2', phone: '5215500000002', locale: 'es-MX' },
    ];
    let calls = 0;
    // Solo la consulta de destinatarios responde; todo lo demás revienta.
    const db = {
      select: () => {
        if (calls++ > 0) throw new Error('boom');
        const chain = { from: () => chain, innerJoin: () => chain, where: () => Promise.resolve(rows) };
        return chain;
      },
    } as unknown as Db;
    expect(await runReminders(db, cfg, new Date('2026-11-05T15:00:00Z'))).toEqual({ sent: 0, failed: 0, skipped: 0, errors: 2 });
    expect(quiet).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
  });
});
