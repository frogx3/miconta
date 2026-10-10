const section = document.querySelector<HTMLElement>('#settings');
const form = document.querySelector<HTMLFormElement>('#threshold-form');

if (section && form) {
  const messages = JSON.parse(section.dataset.messages!) as Record<string, string>;
  const done = document.querySelector<HTMLElement>('#settings-done')!;
  const error = document.querySelector<HTMLElement>('#settings-error')!;
  const slot = form.querySelector<HTMLElement>('[data-error-for="antThreshold"]')!;

  const show = (box: HTMLElement, text: string | null) => {
    box.textContent = text ?? '';
    box.hidden = text === null;
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    show(done, null);
    show(error, null);
    slot.textContent = '';

    const response = await fetch('/api/workspace', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ antThreshold: new FormData(form).get('antThreshold') }),
    });
    if (response.ok) {
      show(done, messages['spending.settings.saved']!);
      setTimeout(() => location.reload(), 600);
      return;
    }
    const result = (await response.json().catch(() => null)) as { code?: string; errors?: { code: string }[] } | null;
    if (result?.code === 'VALIDATION' && result.errors?.[0]) slot.textContent = messages[`validation.${result.errors[0].code}`] ?? messages['common.error']!;
    else show(error, messages['common.error']!);
  });
}

// Marca el archivo como módulo: sus variables no son globales.
export {};
