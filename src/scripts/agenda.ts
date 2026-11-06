const root = document.querySelector<HTMLElement>('#agenda');

if (root) {
  const messages = JSON.parse(root.dataset.messages!) as Record<string, string>;
  const errorBox = root.querySelector<HTMLElement>('#agenda-error')!;
  const msg = (key: string) => messages[key] ?? key;
  type Failure = { code?: string; errors?: { field: string; code: string }[] } | null;

  const show = (text: string | null) => {
    errorBox.textContent = text ?? '';
    errorBox.hidden = text === null;
  };

  /** Sin red (o respuesta ilegible) cuenta como fallo general. */
  async function call(method: string, url: string, body: unknown): Promise<{ ok: boolean; data: Failure }> {
    show(null);
    try {
      const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { ok: response.ok, data: (await response.json().catch(() => null)) as Failure };
    } catch {
      return { ok: false, data: null };
    }
  }

  /** Errores de validación bajo cada campo; cualquier otro fallo, un aviso general. */
  function fail(form: HTMLElement | null, data: Failure) {
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

  // Botones de un toque (pagado, cobrado, deshacer, cancelar, quitar): método, URL y cuerpo vienen en data-*.
  root.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const { ok, data } = await call(button.dataset.method!, button.dataset.url!, JSON.parse(button.dataset.body ?? '{}'));
      if (ok) return location.reload();
      button.disabled = false;
      fail(null, data);
    });
  });

  // Formularios: lo capturado más los valores fijos de data-extra.
  root.querySelectorAll<HTMLFormElement>('form[data-url]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = form.querySelector<HTMLButtonElement>('button[type=submit]');
      if (submit) submit.disabled = true;
      const body = { ...JSON.parse(form.dataset.extra ?? '{}'), ...Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value)])) };
      const { ok, data } = await call(form.dataset.method!, form.dataset.url!, body);
      if (ok) return location.reload();
      if (submit) submit.disabled = false;
      fail(form, data);
    });
  });

  // Vincular WhatsApp: pide un código y abre el chat con el mensaje "Vincular CÓDIGO" ya escrito.
  root.querySelector<HTMLButtonElement>('#agenda-whatsapp-link')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    const { ok, data } = await call('POST', '/api/agenda/whatsapp/link', {});
    button.disabled = false;
    const url = (data as { url?: string } | null)?.url;
    if (ok && url) location.href = url;
    else fail(null, data);
  });

  // Tocar un día filtra la lista sin recargar; tocarlo otra vez (o "Ver todo el mes") la muestra completa.
  const days = [...root.querySelectorAll<HTMLButtonElement>('.agenda-day')];
  const rows = [...root.querySelectorAll<HTMLElement>('.agenda-row')];
  const showAll = root.querySelector<HTMLButtonElement>('#agenda-show-all')!;
  const filter = (date: string | null) => {
    days.forEach((day) => day.setAttribute('aria-pressed', String(day.dataset.date === date)));
    rows.forEach((row) => (row.hidden = date !== null && row.dataset.date !== date));
    showAll.hidden = date === null;
  };
  days.forEach((day) => day.addEventListener('click', () => filter(day.getAttribute('aria-pressed') === 'true' ? null : day.dataset.date!)));
  showAll.addEventListener('click', () => filter(null));
}

// Marca el archivo como módulo: sus variables no son globales.
export {};
