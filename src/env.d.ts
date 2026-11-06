/// <reference path="../.astro/types.d.ts" />

declare namespace App {
  interface Locals {
    user: import('./lib/auth/options').Auth['$Infer']['Session']['user'] | null;
    session: import('./lib/auth/options').Auth['$Infer']['Session']['session'] | null;
    locale: import('./lib/locale').Locale;
    /** Zona IANA para saber qué día es "hoy": la de Tu cuenta, si no la de la IP (Cloudflare), si no CDMX. */
    timeZone: string;
    /** Espacio activo; solo se carga en rutas de /app. */
    workspace: {
      id: string;
      name: string;
      role: 'owner' | 'admin' | 'member' | 'viewer';
      locale: string;
      defaultCurrency: string;
    } | null;
  }
}
