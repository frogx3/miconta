import './local-time';

const section = document.querySelector<HTMLElement>('#plan');

if (section) {
  const planId = section.dataset.planId!;
  const messages = JSON.parse(section.dataset.messages!) as Record<string, string>;
  const actionError = document.querySelector<HTMLElement>('#action-error')!;
  const editError = document.querySelector<HTMLElement>('#edit-error')!;
  const editDone = document.querySelector<HTMLElement>('#edit-done')!;
  const editForm = document.querySelector<HTMLFormElement>('#plan-edit-form')!;
  const settleForm = document.querySelector<HTMLFormElement>('#settle-box');

  const show = (box: HTMLElement, text: string | null) => {
    box.textContent = text ?? '';
    box.hidden = text === null;
  };

  async function call(method: string, path: string, body: unknown) {
    const response = await fetch(`/api/plans/${planId}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: response.ok, data: (await response.json().catch(() => ({}))) as { code?: string; changed?: string[]; errors?: { field: string; code: string }[] } };
  }

  /** Muestra los errores de validación bajo cada campo; devuelve true si había alguno. */
  function showFieldErrors(root: HTMLElement, errors: { field: string; code: string }[] | undefined): boolean {
    root.querySelectorAll<HTMLElement>('[data-error-for]').forEach((el) => (el.textContent = ''));
    for (const { field, code } of errors ?? []) {
      const slot = root.querySelector<HTMLElement>(`[data-error-for="${field}"]`);
      if (slot) slot.textContent = messages[`validation.${code}`] ?? messages['common.error']!;
    }
    return (errors?.length ?? 0) > 0;
  }

  // Edición manual de parámetros
  const type = editForm.querySelector<HTMLElement & { value: string }>('#type')!;
  type.addEventListener('change', () => (editForm.querySelector<HTMLElement>('[data-rate]')!.hidden = type.value === 'msi'));

  editForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    show(editError, null);
    show(editDone, null);
    const { ok, data } = await call('PATCH', '', Object.fromEntries(new FormData(editForm)));
    if (!ok) {
      if (!(data.code === 'VALIDATION' && showFieldErrors(editForm, data.errors))) show(editError, messages['common.error']!);
      return;
    }
    showFieldErrors(editForm, []);
    if ((data.changed ?? []).length === 0) return show(editDone, messages['plan.edit.unchanged']!);
    show(editDone, messages['common.saved']!);
    setTimeout(() => location.reload(), 600);
  });

  // Liquidación manual (comentario obligatorio)
  document.querySelector('[data-toggle="settle-box"]')?.addEventListener('click', () => {
    if (settleForm) settleForm.hidden = !settleForm.hidden;
  });
  settleForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    show(actionError, null);
    const { ok, data } = await call('POST', '/settle', Object.fromEntries(new FormData(settleForm)));
    if (ok) return location.reload();
    if (!(data.code === 'VALIDATION' && showFieldErrors(settleForm, data.errors))) show(actionError, messages['common.error']!);
  });

  // Por revisar / reabrir
  document.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((button) =>
    button.addEventListener('click', async () => {
      show(actionError, null);
      button.disabled = true;
      const { ok } = await call('POST', '/status', { to: button.dataset.status });
      if (ok) return location.reload();
      button.disabled = false;
      show(actionError, messages['common.error']!);
    }),
  );
}

// Marca el archivo como módulo: sus variables no son globales.
export {};
