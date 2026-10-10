import { sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { APIError } from 'better-auth/api';
import * as schema from '../../db/schema';
import { DEFAULT_LOCALE, defaultCurrencyForLocale } from '../locale';
import { claimInvitation, peekInvitation } from '../members/repo';
import { checkSetupCode, type SetupConfig } from './setup-code';

export type Db = DrizzleD1Database<typeof schema>;

/** Ruta del registro público; el alta que hace un admin (plugin admin) no pasa por aquí. */
const PUBLIC_SIGNUP_PATH = '/sign-up/email';

export async function countUsers(db: Db): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(schema.user);
  return row?.count ?? 0;
}

/** El registro público está abierto si está habilitado o si aún no existe ningún usuario (arranque). */
export async function isSignupOpen(db: Db, allowSignup: boolean): Promise<{ open: boolean; firstUser: boolean }> {
  const firstUser = (await countUsers(db)) === 0;
  return { open: firstUser || allowSignup, firstUser };
}

type HookContext = { path?: string; request?: Request; headers?: Headers } | null;

const header = (context: HookContext, name: string): string | null => context?.request?.headers.get(name) ?? context?.headers?.get(name) ?? null;

export function createUserHooks(db: Db, allowSignup: boolean, setup: SetupConfig = { required: false, code: null }) {
  return {
    before: async (user: Record<string, unknown>, context: HookContext) => {
      const { open, firstUser } = await isSignupOpen(db, allowSignup);
      // Una invitación vigente permite registrarse aunque el registro público esté cerrado.
      const inviteToken = context?.path === PUBLIC_SIGNUP_PATH && !firstUser ? header(context, 'x-invite-token') : null;
      if (inviteToken) {
        if (!(await peekInvitation(db, inviteToken))) throw new APIError('FORBIDDEN', { message: 'INVITE_INVALID', code: 'INVITE_INVALID' });
        return;
      }
      if (context?.path === PUBLIC_SIGNUP_PATH && !open) {
        throw new APIError('FORBIDDEN', { message: 'SIGNUP_DISABLED', code: 'SIGNUP_DISABLED' });
      }
      // Reclamar el sistema (primer usuario = administrador) exige el código de configuración.
      if (firstUser && context?.path === PUBLIC_SIGNUP_PATH) {
        const provided = header(context, 'x-setup-code');
        const check = checkSetupCode(setup, provided);
        if (check !== 'ok') {
          const code = check === 'not_configured' ? 'SETUP_NOT_CONFIGURED' : 'SETUP_CODE_INVALID';
          throw new APIError('FORBIDDEN', { message: code, code });
        }
      }
      // El primer usuario de la instalación es el administrador.
      if (firstUser) return { data: { ...user, role: 'admin' } };
    },

    /**
     * Cada usuario nuevo recibe un espacio propio donde es dueño.
     * Los administradores gestionan el sistema pero no lo usan: no tienen espacio.
     */
    after: async (user: { id: string; name: string } & Record<string, unknown>, context?: HookContext) => {
      if (user.role === 'admin') return;
      // Quien se registra con una invitación entra al espacio compartido y no recibe uno propio.
      const inviteToken = context?.path === PUBLIC_SIGNUP_PATH ? header(context, 'x-invite-token') : null;
      if (inviteToken && (await claimInvitation(db, inviteToken, user.id))) return;
      const locale = typeof user.locale === 'string' && user.locale ? user.locale : DEFAULT_LOCALE;
      const workspaceId = crypto.randomUUID();
      await db.batch([
        db.insert(schema.workspaces).values({
          id: workspaceId,
          name: user.name,
          locale,
          defaultCurrency: defaultCurrencyForLocale(locale),
        }),
        db.insert(schema.workspaceMembers).values({ workspaceId, userId: user.id, role: 'owner' }),
      ]);
    },
  };
}
