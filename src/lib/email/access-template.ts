/** Plantilla HTML del correo de primer acceso. Tablas y estilos en línea: es lo que respetan Gmail y Outlook. */

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface AccessEmailText {
  greeting: string;
  intro: string;
  cta: string;
  expires: string;
  footer: string;
}

const NAVY = '#1d3557';
const GOLD = '#c5a047';
const PAPER = '#f1eee6';
const MUTED = '#665f55';
const FONT = "Montserrat,'Segoe UI',Helvetica,Arial,sans-serif";

/** `origin` sirve para el logo (PNG público: Gmail no muestra SVG) y el enlace al sitio. */
export function accessEmailHtml(text: AccessEmailText, code: string, url: string, origin: string): string {
  const e = escapeHtml;
  const host = new URL(origin).host;
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Don Bigo</title></head>
<body style="margin:0;padding:0;background:${PAPER}">
<div style="display:none;max-height:0;overflow:hidden">${e(text.intro)} ${e(code)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER}">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #dcd5c6;border-radius:12px;overflow:hidden">
  <tr><td align="center" style="background:${NAVY};padding:28px 24px 22px">
    <img src="${e(origin)}/brand/miconta-icon-white-240.png" width="64" height="62" alt="Don Bigo" style="display:block;border:0;margin:0 auto 10px">
    <div style="font-family:${FONT};font-size:22px;font-weight:700;color:#ffffff;letter-spacing:.2px">Don <span style="color:${GOLD}">Bigo</span></div>
  </td></tr>
  <tr><td style="padding:32px 32px 8px;font-family:${FONT};color:#14202f;font-size:16px;line-height:1.55">
    <p style="margin:0 0 12px;font-weight:600">${e(text.greeting)}</p>
    <p style="margin:0 0 20px">${e(text.intro)}</p>
  </td></tr>
  <tr><td align="center" style="padding:0 32px">
    <div style="background:#f3e8c8;border:1px solid ${GOLD};border-radius:10px;padding:16px 12px;font-family:'SFMono-Regular',Consolas,'Courier New',monospace;font-size:26px;font-weight:700;letter-spacing:4px;white-space:nowrap;color:${NAVY}">${e(code)}</div>
  </td></tr>
  <tr><td align="center" style="padding:28px 32px 8px">
    <a href="${e(url)}" style="display:inline-block;background:${NAVY};color:#ffffff;font-family:${FONT};font-size:16px;font-weight:600;text-decoration:none;padding:14px 28px;border-radius:8px">${e(text.cta)}</a>
  </td></tr>
  <tr><td style="padding:16px 32px 32px;font-family:${FONT};color:${MUTED};font-size:13px;line-height:1.5;text-align:center">${e(text.expires)}</td></tr>
</table>
<p style="margin:20px 0 0;font-family:${FONT};font-size:12px;color:${MUTED};text-align:center">${e(text.footer)}<br><a href="${e(origin)}" style="color:${MUTED}">${e(host)}</a></p>
</td></tr>
</table>
</body></html>`;
}
