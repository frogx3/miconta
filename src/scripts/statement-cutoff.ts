const section = document.querySelector<HTMLElement>('#cutoff');
const form = document.querySelector<HTMLFormElement>('#cutoff-form');

if (section && form) {
  const messages = JSON.parse(section.dataset.messages!) as Record<string, string>;
  const done = document.querySelector<HTMLElement>('#cutoff-done')!;
  const error = document.querySelector<HTMLElement>('#cutoff-error')!;
  const slots = form.querySelectorAll<HTMLElement>('[data-error-for]');

  const show = (box: HTMLElement, text: string | null) => {
    box.textContent = text ?? '';
    box.hidden = text === null;
  };
  const reload = (text: string) => {
    show(done, text);
    // El mes de la URL se conserva; si el corte cambió de mes, se muestra el nuevo.
    setTimeout(() => location.reload(), 600);
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    show(done, null);
    show(error, null);
    slots.forEach((slot) => (slot.textContent = ''));

    const data = new FormData(form);
    const response = await fetch('/api/statement-cutoffs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: section.dataset.accountId,
        cutoffDate: data.get('cutoffDate'),
        startDate: data.get('startDate'),
        officialPay: data.get('officialPay'),
      }),
    });
    if (response.ok) {
      const month = String(data.get('cutoffDate')).slice(0, 7);
      const url = new URL(location.href);
      url.searchParams.set('corte', month);
      history.replaceState(null, '', url);
      reload(messages['statement.real.saved']!);
      return;
    }
    const result = (await response.json().catch(() => null)) as { code?: string; errors?: { field: string; code: string }[] } | null;
    if (result?.code === 'VALIDATION' && result.errors) {
      for (const item of result.errors) {
        const slot = form.querySelector<HTMLElement>(`[data-error-for="${item.field}"]`);
        const text = messages[`validation.${item.code}`] ?? messages['common.error']!;
        if (slot) slot.textContent = text;
        else show(error, text);
      }
    } else show(error, messages['common.error']!);
  });

  document.querySelector<HTMLButtonElement>('#cutoff-remove')?.addEventListener('click', async () => {
    show(error, null);
    const response = await fetch('/api/statement-cutoffs', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: section.dataset.recordId }),
    });
    if (response.ok) reload(messages['statement.real.removed']!);
    else show(error, messages['common.error']!);
  });
}

// Marca el archivo como módulo: sus variables no son globales.
export {};
