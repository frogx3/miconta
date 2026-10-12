import './local-time';

const root = document.querySelector<HTMLElement>('#batches');

if (root) {
  const messages = JSON.parse(root.dataset.messages!) as Record<string, string>;
  const errorBox = root.querySelector<HTMLElement>('#batches-error')!;
  const doneBox = root.querySelector<HTMLElement>('#batches-done')!;
  const msg = (key: string, params: Record<string, string | number> = {}) =>
    (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));

  const show = (box: HTMLElement, text: string | null) => {
    box.textContent = text ?? '';
    box.hidden = text === null;
  };

  root.querySelectorAll<HTMLFormElement>('.period-form').forEach((form) =>
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const batch = form.closest<HTMLElement>('[data-batch]')!;
      show(errorBox, null);
      show(doneBox, null);
      const data = new FormData(form);
      const response = await fetch(`/api/import/batches/${batch.dataset.batch}/period`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cutoffDate: data.get('cutoffDate'), startDate: data.get('startDate') }),
      });
      if (response.ok) {
        show(doneBox, msg('batches.period.saved'));
        setTimeout(() => location.reload(), 800);
        return;
      }
      const result = (await response.json().catch(() => null)) as { errors?: { code: string }[] } | null;
      show(errorBox, messages[`validation.${result?.errors?.[0]?.code ?? ''}`] ?? msg('common.error'));
    }),
  );

  root.querySelectorAll<HTMLElement>('[data-toggle-revert]').forEach((button) =>
    button.addEventListener('click', () => {
      const panel = button.parentElement!.querySelector<HTMLElement>('.revert-panel')!;
      panel.hidden = !panel.hidden;
    }),
  );

  root.querySelectorAll<HTMLButtonElement>('[data-confirm-revert]').forEach((button) =>
    button.addEventListener('click', async () => {
      const batch = button.closest<HTMLElement>('[data-batch]')!;
      show(errorBox, null);
      show(doneBox, null);
      button.disabled = true;

      const response = await fetch(`/api/import/batches/${batch.dataset.batch}/revert`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const data = (await response.json().catch(() => ({}))) as { code?: string; movementsDeleted?: number; plansDeleted?: number; installmentsUndone?: number };

      if (response.ok) {
        show(doneBox, msg('batches.revert.done', { movements: data.movementsDeleted ?? 0, plans: data.plansDeleted ?? 0, installments: data.installmentsUndone ?? 0 }));
        setTimeout(() => location.reload(), 1500);
        return;
      }
      button.disabled = false;
      const known: Record<string, string> = {
        ALREADY_REVERTED: 'batches.revert.alreadyReverted',
        NOT_LATEST: 'batches.revert.notLatest',
        PLANS_CHANGED: 'batches.revert.blocked',
      };
      show(errorBox, msg(known[data.code ?? ''] ?? 'batches.revert.error'));
    }),
  );
}
