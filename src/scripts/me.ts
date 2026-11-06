/** Tu cuenta: avisos dentro de la app, respaldo y acciones de la zona de peligro. */
const root = document.querySelector<HTMLElement>('#me');

if (root) {
  const messages = JSON.parse(root.dataset.messages!) as Record<string, string>;
  const msg = (key: string) => messages[key] ?? messages['common.error'] ?? key;
  const errorBox = root.querySelector<HTMLElement>('#me-error')!;
  const show = (text: string | null) => {
    errorBox.textContent = text ?? '';
    errorBox.hidden = text === null;
    if (text) errorBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  async function call(method: string, url: string, body: unknown): Promise<{ ok: boolean; code?: string }> {
    show(null);
    try {
      const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = (await response.json().catch(() => null)) as { code?: string } | null;
      return { ok: response.ok, code: data?.code };
    } catch {
      return { ok: false };
    }
  }
  const fail = (code?: string) => show(msg(code ? `me.error.${code}` : 'common.error'));

  const inApp = document.querySelector<HTMLInputElement>('#me-in-app');
  const saved = document.querySelector<HTMLElement>('#me-settings-saved');
  inApp?.addEventListener('change', async () => {
    inApp.disabled = true;
    const { ok, code } = await call('PATCH', '/api/me/settings', { inAppNotifications: inApp.checked });
    inApp.disabled = false;
    if (!ok) {
      inApp.checked = !inApp.checked;
      return fail(code);
    }
    if (saved) saved.hidden = false;
  });

  const backup = document.querySelector<HTMLButtonElement>('#me-backup');
  backup?.addEventListener('click', async () => {
    backup.disabled = true;
    const { ok, code } = await call('POST', '/api/me/backups', {});
    if (ok || code === 'BACKUP_BUSY') return location.reload();
    backup.disabled = false;
    fail(code);
  });
  // Mientras hay un respaldo en cola, la página se refresca sola para mostrarlo listo.
  if (root.dataset.busy) setTimeout(() => location.reload(), 5000);

  document.querySelectorAll<HTMLFormElement>('form[data-me-confirm]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const confirm = String(new FormData(form).get('confirm') ?? '').trim();
      if (confirm.toLowerCase() !== root.dataset.email!.toLowerCase()) return fail('CONFIRM_MISMATCH');
      const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
      submit.disabled = true;
      const url = form.dataset.meConfirm!;
      const { ok, code } = await call('POST', url, { confirm });
      if (!ok) {
        submit.disabled = false;
        return fail(code);
      }
      location.href = url.endsWith('/delete') ? '/login' : '/app';
    });
  });
}

export {};
