/**
 * Datos del responsable que aparecen en el Aviso de Privacidad y en las Políticas de servicio.
 * Complétalos con los datos reales antes de publicar: la ley exige identificar al responsable y su domicilio.
 */
export const LEGAL = {
  /** Nombre completo de la persona física o razón social de la empresa que opera Don Bigo. */
  responsable: '[Nombre completo o razón social del responsable]',
  /** Domicilio para oír y recibir notificaciones. */
  domicilio: '[Calle, número, colonia, código postal, ciudad y estado]',
  /** Correo para ejercer derechos ARCO y atender dudas de privacidad. */
  correoPrivacidad: '[correo de privacidad, p. ej. privacidad@donbigo.com]',
  /** Ciudad cuyos tribunales resuelven controversias. */
  jurisdiccion: '[Ciudad y estado]',
  /** Fecha de la última actualización de ambos documentos. */
  actualizado: '14 de octubre de 2026',
  sitio: 'donbigo.com',
} as const;

export const LEGAL_PATHS = {
  privacy: '/aviso-privacidad',
  terms: '/politicas-de-servicio',
} as const;
