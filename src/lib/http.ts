export const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const validationError = (errors: { field: string; code: string }[]) => json(400, { code: 'VALIDATION', errors });

/** Las rutas que modifican datos solo aceptan peticiones que vienen de esta misma página. */
export function sameOrigin(request: Request): boolean {
  return request.headers.get('origin') === new URL(request.url).origin;
}

type Workspace = NonNullable<App.Locals['workspace']>;
const WRITE_ROLES: Workspace['role'][] = ['owner', 'admin', 'member'];

/**
 * Exige sesión y espacio activo; para escribir, además un rol con permiso (no `viewer`) y origen propio.
 * Los administradores del sistema no tienen espacio, así que no pasan por aquí.
 */
export function requireWorkspace(
  locals: App.Locals,
  request: Request,
  options: { write: boolean },
): { workspace: Workspace; userId: string } | { response: Response } {
  if (!locals.user) return { response: json(401, { code: 'UNAUTHENTICATED' }) };
  if (!locals.workspace) return { response: json(403, { code: 'NO_WORKSPACE' }) };
  if (options.write) {
    if (!sameOrigin(request)) return { response: json(403, { code: 'BAD_ORIGIN' }) };
    if (!WRITE_ROLES.includes(locals.workspace.role)) return { response: json(403, { code: 'READ_ONLY' }) };
  }
  return { workspace: locals.workspace, userId: locals.user.id };
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const body: unknown = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Como `requireWorkspace` para rutas con cuerpo JSON: lo consume SIEMPRE antes de decidir. Responder
 * un rechazo sin haberlo leído corta a veces la conexión (error 500 intermitente en desarrollo).
 */
export async function requireWorkspaceWithBody(
  locals: App.Locals,
  request: Request,
): Promise<{ workspace: Workspace; userId: string; body: Record<string, unknown> | null } | { response: Response }> {
  const raw = await request.text();
  const access = requireWorkspace(locals, request, { write: true });
  if ('response' in access) return access;
  return { ...access, body: parseJsonObject(raw) };
}
