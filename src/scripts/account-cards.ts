/** Formularios de tarjetas de una cuenta: agregar, editar en el lugar, archivar y quitar. */

export {};

type Facts = Record<string, string | boolean>;
interface ApiResult {
  ok: boolean;
  code?: string;
  errors?: { field: string; code: string }[];
  facts?: Facts | null;
}

const NEXT_KEY = 'miconta:next-card';

const section = document.querySelector<HTMLElement>('#cards');
if (section) {
  const messages = JSON.parse(section.dataset.messages!) as Record<string, string>;
  const msg = (key: string) => messages[key] ?? messages['common.error']!;

  async function send(method: string, url: string, body?: unknown): Promise<ApiResult> {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as Partial<ApiResult>;
    return { ...data, ok: response.ok };
  }

  const radio = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as unknown as { value: string };
  const input = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as unknown as HTMLInputElement;

  // Cada tarjeta muestra su resumen y enlaces; el editor se abre aparte.
  section.querySelectorAll<HTMLButtonElement>('[data-card-toggle]').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
      const open = panel.hidden;
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.firstElementChild!.textContent = open ? toggle.dataset.closeLabel! : toggle.dataset.openLabel!;
      // En el celular, enfocar un campo abriría el teclado y taparía el formulario.
      if (open && window.matchMedia('(pointer: fine)').matches) panel.querySelector<HTMLInputElement>('input[name="last4"]')?.focus();
    });
  });

  section.querySelectorAll<HTMLFormElement>('form[data-card-form]').forEach((form) => {
    const base = `/api/accounts/${form.dataset.accountId}/cards`;
    const cardId = form.dataset.cardId;
    const alertBox = form.querySelector<HTMLElement>('.form-alert')!;
    const status = form.querySelector<HTMLElement>('[data-status]');
    const creditOnly = form.querySelector<HTMLElement>('[data-credit-only]');
    let statusTimer: number | undefined;

    const fieldError = (name: string, text: string | null) => {
      const slot = form.querySelector<HTMLElement>(`[data-error-for="${name}"]`);
      const field = input(form, name);
      if (slot) slot.textContent = text ?? '';
      if (field && 'setAttribute' in field) {
        if (text) field.setAttribute('aria-invalid', 'true');
        else field.removeAttribute('aria-invalid');
      }
    };
    const clearErrors = () => {
      alertBox.hidden = true;
      form.querySelectorAll<HTMLElement>('[data-error-for]').forEach((el) => (el.textContent = ''));
      form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    };
    const showAlert = (text: string) => {
      alertBox.textContent = `${msg('auth.error.label')}: ${text}`;
      alertBox.hidden = false;
      alertBox.focus();
    };
    const flash = (text: string) => {
      if (!status) return;
      status.textContent = text;
      window.clearTimeout(statusTimer);
      statusTimer = window.setTimeout(() => (status.textContent = ''), 3500);
    };
    const failure = (result: ApiResult) => {
      clearErrors();
      if (result.code === 'VALIDATION' && result.errors) {
        let first: HTMLInputElement | null = null;
        for (const { field, code } of result.errors) {
          fieldError(field, msg(`validation.${code}`));
          first ??= input(form, field) && 'focus' in input(form, field) ? input(form, field) : null;
        }
        first?.focus();
        return;
      }
      showAlert(result.code === 'DUPLICATE_CARD' ? msg('card.duplicate') : result.code === 'CARD_IN_USE' ? msg('card.inUse') : msg('common.error'));
    };

    // Los campos de crédito solo aplican a tarjetas de crédito.
    const syncKind = () => {
      if (creditOnly) creditOnly.hidden = radio(form, 'kind').value !== 'credit';
    };
    form.querySelectorAll('input[name="kind"]').forEach((el) => el.addEventListener('change', syncKind));
    syncKind();

    // Validación mientras se escribe: los últimos 4 dígitos.
    const last4 = input(form, 'last4');
    last4.addEventListener('input', () => {
      last4.value = last4.value.replace(/\D/g, '').slice(0, 4);
      if (last4.getAttribute('aria-invalid')) fieldError('last4', null);
    });
    last4.addEventListener('blur', () => {
      if (last4.value !== '' && !/^\d{4}$/.test(last4.value)) fieldError('last4', msg('validation.invalid_digits'));
    });

    // Tarjeta nueva: parte de lo último que se capturó (misma moneda, corte y pago) y avisa que se agregó.
    if (!cardId) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(NEXT_KEY) ?? 'null') as Record<string, string> | null;
        if (saved) {
          for (const name of ['currency', 'creditLimit', 'cutoffDay', 'paymentDueDay']) if (saved[name] != null) input(form, name).value = saved[name]!;
          radio(form, 'kind').value = saved.kind ?? 'credit';
          syncKind();
          if (saved.added) document.querySelector<HTMLElement>('#added-note')!.hidden = false;
          sessionStorage.setItem(NEXT_KEY, JSON.stringify({ ...saved, added: '' }));
          if (new URLSearchParams(location.search).get('agregar') === '1') last4.focus();
        }
      } catch {
        /* sin sessionStorage: el formulario parte vacío */
      }
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearErrors();
      if (!/^\d{4}$/.test(last4.value)) {
        fieldError('last4', msg(last4.value === '' ? 'validation.required' : 'validation.invalid_digits'));
        return last4.focus();
      }
      const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      submit.disabled = true;
      const result = await send(cardId ? 'PATCH' : 'POST', cardId ? `${base}/${cardId}` : base, data);
      submit.disabled = false;
      if (!result.ok) return failure(result);

      if (!cardId) {
        try {
          sessionStorage.setItem(NEXT_KEY, JSON.stringify({ ...data, added: '1' }));
        } catch {
          /* ignorar */
        }
        return location.assign(`${location.pathname}?agregar=1#card-add`);
      }

      const row = form.closest<HTMLElement>('[data-card-row]');
      const facts = result.facts;
      // Si cambió entre crédito y débito, la fila cambia de forma: se recarga.
      if (!facts || !row || (facts.isCredit === true) !== (row.querySelector('[data-fact="limit"]') !== null)) return location.reload();
      for (const [key, value] of Object.entries(facts)) {
        const el = row.querySelector<HTMLElement>(`[data-fact="${key}"]`);
        if (el && typeof value === 'string') el.textContent = value;
      }
      flash(msg('card.saved'));
    });

    form.querySelector('[data-archive]')?.addEventListener('click', async () => {
      const result = await send('PATCH', `${base}/${cardId}`, { archived: form.dataset.archived !== 'true' });
      if (result.ok) return location.reload();
      failure(result);
    });

    const ask = form.querySelector<HTMLButtonElement>('[data-remove-ask]');
    const confirm = form.querySelector<HTMLElement>('[data-remove-confirm]');
    ask?.addEventListener('click', () => {
      ask.hidden = true;
      confirm!.hidden = false;
      confirm!.querySelector<HTMLButtonElement>('[data-remove-cancel]')!.focus();
    });
    form.querySelector('[data-remove-cancel]')?.addEventListener('click', () => {
      confirm!.hidden = true;
      ask!.hidden = false;
      ask!.focus();
    });
    form.querySelector('[data-remove]')?.addEventListener('click', async () => {
      const result = await send('DELETE', `${base}/${cardId}`);
      if (result.ok) return location.reload();
      confirm!.hidden = true;
      ask!.hidden = false;
      failure(result);
    });
  });

  document.querySelector<HTMLButtonElement>('#toggle-archive')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    const result = await send('PATCH', `/api/accounts/${button.dataset.accountId}`, { archived: button.dataset.archived !== 'true' });
    if (result.ok) return location.reload();
    button.disabled = false;
  });
}
