import { env } from 'cloudflare:workers';

/**
 * Captura por correo, apagada mientras no haya un banco que mande avisos por correo para probarla
 * (Banorte y Banamex ya no los envían). Se enciende con la variable `EMAIL_CAPTURE = "true"`.
 */
export const emailCaptureEnabled = (): boolean => String((env as unknown as Record<string, unknown>).EMAIL_CAPTURE).toLowerCase() === 'true';
