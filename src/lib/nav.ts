import type { IconName } from './icons';
import type { MessageKey } from '../i18n/messages';

export type NavKey = 'dashboard' | 'accounts' | 'plans' | 'spending' | 'import' | 'users' | 'members' | 'goals';

export interface NavItem {
  key: NavKey;
  href: string;
  icon: IconName;
  label: MessageKey;
}

const APP: NavItem[] = [
  { key: 'dashboard', href: '/app', icon: 'home', label: 'nav.dashboard' },
  { key: 'accounts', href: '/app/cuentas', icon: 'landmark', label: 'nav.accounts' },
  { key: 'plans', href: '/app/planes', icon: 'stairs', label: 'nav.plans' },
  { key: 'spending', href: '/app/gastos', icon: 'chart', label: 'nav.spending' },
  { key: 'import', href: '/app/importar', icon: 'upload', label: 'nav.import' },
  { key: 'goals', href: '/app/metas', icon: 'target', label: 'nav.goals' },
  { key: 'members', href: '/app/miembros', icon: 'users', label: 'nav.members' },
];

const ADMIN: NavItem[] = [{ key: 'users', href: '/admin', icon: 'users', label: 'admin.users' }];

/** Menú de cada área; quien solo lee (viewer) no ve Importar. */
export function navFor(area: 'app' | 'admin', opts: { readOnly?: boolean } = {}): NavItem[] {
  if (area === 'admin') return ADMIN;
  return opts.readOnly ? APP.filter((item) => item.key !== 'import') : APP;
}
