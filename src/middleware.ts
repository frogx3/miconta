import { asc, eq } from 'drizzle-orm';
import type { APIContext, MiddlewareNext } from 'astro';
import { defineMiddleware } from 'astro:middleware';
import { workspaceMembers, workspaces } from './db/schema';
import { getAuth, getDb } from './lib/auth';
import { isSupportedLocale, resolveLocale } from './lib/locale';

const isArea = (pathname: string, area: string) => pathname === area || pathname.startsWith(`${area}/`);
const GUEST_ONLY = ['/login', '/registro'];
/** APIs de datos de usuario: necesitan el espacio activo. */
const WORKSPACE_APIS = ['/api/accounts', '/api/import', '/api/plans', '/api/categories', '/api/category-rules', '/api/movements', '/api/workspace', '/api/statement-cutoffs', '/api/members', '/api/goals'];

/**
 * Cabeceras de seguridad. La CSP solo se aplica en el build de producción: en desarrollo, Vite necesita websockets
 * y scripts en línea para recargar. `'unsafe-inline'` es necesario porque Astro inserta scripts y
 * estilos en línea; aun así la política impide cargar código de otros orígenes, incrustar la app en
 * otra página y enviar formularios a otro sitio.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function applySecurityHeaders(headers: Headers, secure: boolean) {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (import.meta.env.PROD) headers.set('Content-Security-Policy', CSP);
  if (secure) headers.set('Strict-Transport-Security', 'max-age=31536000');
}

/** Algunas respuestas (p. ej. redirecciones) tienen cabeceras inmutables: en ese caso se copian. */
function withSecurityHeaders(response: Response, secure: boolean): Response {
  try {
    applySecurityHeaders(response.headers, secure);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    applySecurityHeaders(copy.headers, secure);
    return copy;
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  const secure = context.url.protocol === 'https:';
  return withSecurityHeaders(await handle(context, next), secure);
});

async function handle(context: APIContext, next: MiddlewareNext): Promise<Response> {
  const { pathname } = context.url;
  context.locals.user = null;
  context.locals.session = null;
  context.locals.workspace = null;
  context.locals.locale = resolveLocale(context.request.headers.get('accept-language'));

  // Better Auth resuelve su propia sesión en sus endpoints.
  if (isArea(pathname, '/api/auth')) return next();

  const data = await getAuth().api.getSession({ headers: context.request.headers });
  if (data) {
    context.locals.user = data.user;
    context.locals.session = data.session;
    if (isSupportedLocale(data.user.locale)) context.locals.locale = data.user.locale;
  }

  const inApp = isArea(pathname, '/app');
  const inAdmin = isArea(pathname, '/admin');

  // El administrador gestiona el sistema desde /admin; la app de gastos es solo para usuarios.
  const isAdmin = data?.user.role === 'admin';
  const home = isAdmin ? '/admin' : '/app';

  if ((inApp || inAdmin) && !data) return context.redirect('/login');
  if (GUEST_ONLY.includes(pathname) && data) return context.redirect(home);
  if (inAdmin && !isAdmin) return context.redirect('/app');
  if (inApp && isAdmin) return context.redirect('/admin');

  // El espacio activo se carga para la app y para las APIs de datos de usuario.
  if ((inApp || WORKSPACE_APIS.some((area) => isArea(pathname, area))) && data) {
    const [membership] = await getDb()
      .select({
        id: workspaces.id,
        name: workspaces.name,
        role: workspaceMembers.role,
        locale: workspaces.locale,
        defaultCurrency: workspaces.defaultCurrency,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, data.user.id))
      .orderBy(asc(workspaceMembers.createdAt))
      .limit(1);
    context.locals.workspace = membership ?? null;
  }

  return next();
}
