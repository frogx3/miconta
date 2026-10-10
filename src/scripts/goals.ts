const root = document.querySelector<HTMLElement>('#goals');

if (root) {
  const messages = JSON.parse(root.dataset.messages!) as Record<string, string>;
  const errorBox = root.querySelector<HTMLElement>('#goals-error')!;
  const msg = (key: string, params: Record<string, string> = {}) => (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`);

  const show = (text: string | null) => {
    errorBox.textContent = text ?? '';
    errorBox.hidden = text === null;
  };

  async function call(method: string, url: string, body: unknown) {
    show(null);
    const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: response.ok, data: (await response.json().catch(() => null)) as { code?: string; errors?: { field: string; code: string }[] } | null };
  }

  /** Errores de validación bajo cada campo; cualquier otro fallo, un aviso general. */
  function fail(form: HTMLElement | null, data: { code?: string; errors?: { field: string; code: string }[] } | null) {
    form?.querySelectorAll<HTMLElement>('[data-error-for]').forEach((slot) => (slot.textContent = ''));
    if (data?.code === 'VALIDATION' && data.errors && form) {
      for (const { field, code } of data.errors) {
        const slot = form.querySelector<HTMLElement>(`[data-error-for="${field}"]`);
        if (slot) slot.textContent = msg(`validation.${code}`);
        else show(msg(`validation.${code}`));
      }
      return;
    }
    show(msg('common.error'));
  }

  const values = (form: HTMLFormElement) => Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value)]));

  // Alta: los campos cambian según el tipo de meta.
  const form = root.querySelector<HTMLFormElement>('#goal-form');
  if (form) {
    const type = form.querySelector<HTMLSelectElement>('#g-type')!;
    const help = JSON.parse(document.querySelector('#type-help')!.textContent!) as Record<string, string>;
    const sync = () => {
      form.querySelectorAll<HTMLElement>('[data-for]').forEach((field) => {
        field.hidden = !field.dataset.for!.split(' ').includes(type.value);
      });
      form.querySelector<HTMLElement>('#g-type-help')!.textContent = help[type.value] ?? '';
      const dateLabel = form.querySelector<HTMLElement>('label[for="g-date"]')!;
      dateLabel.textContent = type.value === 'savings' ? dateLabel.dataset.labelSavings! : dateLabel.dataset.labelDefault!;
      const amountLabel = form.querySelector<HTMLElement>('label[for="g-amount"]')!;
      amountLabel.textContent = type.value === 'savings' ? amountLabel.dataset.labelSavings! : amountLabel.dataset.labelAnt!;
    };
    type.addEventListener('change', sync);
    sync();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const all = values(form);
      // Solo se mandan los campos del tipo elegido (los ocultos pueden traer valores viejos).
      const body: Record<string, string> = { type: all.type!, name: all.name! };
      if (['debt_free', 'payoff_plan', 'savings'].includes(all.type!)) body.targetDate = all.targetDate ?? '';
      if (['ant_spend', 'savings'].includes(all.type!)) body.targetAmount = all.targetAmount ?? '';
      if (all.type === 'payoff_plan') body.planId = all.planId ?? '';
      const { ok, data } = await call('POST', '/api/goals', body);
      if (ok) location.reload();
      else fail(form, data);
    });
  }

  root.querySelectorAll<HTMLElement>('.goal-card').forEach((card) => {
    const id = card.dataset.goal!;

    card.querySelector<HTMLFormElement>('.goal-edit-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formEl = event.currentTarget as HTMLFormElement;
      const { ok, data } = await call('PATCH', `/api/goals/${id}`, values(formEl));
      if (ok) location.reload();
      else fail(formEl, data);
    });

    card.querySelector<HTMLButtonElement>('[data-archive]')?.addEventListener('click', async (event) => {
      const archived = (event.currentTarget as HTMLElement).dataset.archive === 'true';
      const { ok, data } = await call('PATCH', `/api/goals/${id}`, { archived });
      if (ok) location.reload();
      else fail(null, data);
    });

    card.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (!confirm(msg('goals.delete.confirm', { name: card.dataset.name ?? '' }))) return;
      const { ok, data } = await call('DELETE', `/api/goals/${id}`, {});
      if (ok) location.reload();
      else fail(null, data);
    });

    card.querySelector<HTMLFormElement>('.entry-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formEl = event.currentTarget as HTMLFormElement;
      const { ok, data } = await call('POST', `/api/goals/${id}/entries`, values(formEl));
      if (ok) location.reload();
      else fail(formEl, data);
    });

    card.querySelectorAll<HTMLButtonElement>('.entry-remove').forEach((button) => {
      button.addEventListener('click', async () => {
        const entryId = button.closest<HTMLElement>('li')!.dataset.entry;
        const { ok, data } = await call('DELETE', `/api/goals/${id}/entries`, { entryId });
        if (ok) location.reload();
        else fail(null, data);
      });
    });
  });
}

// Marca el archivo como módulo: sus variables no son globales.
export {};
