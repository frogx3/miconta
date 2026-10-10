const section = document.querySelector<HTMLElement>('#balances');
const form = document.querySelector<HTMLFormElement>('#balances-form');

if (section && form) {
  const messages = JSON.parse(section.dataset.messages!) as Record<string, string>;
  const money = new Intl.NumberFormat(section.dataset.locale, { style: 'currency', currency: section.dataset.currency });
  const error = document.querySelector<HTMLElement>('#balances-error')!;
  const done = document.querySelector<HTMLElement>('#balances-done')!;
  const preview = document.querySelector<HTMLElement>('#balances-preview')!;
  const rows = document.querySelector<HTMLElement>('#balances-rows')!;
  const unmatched = document.querySelector<HTMLElement>('#balances-unmatched')!;
  const unmatchedList = document.querySelector<HTMLElement>('#balances-unmatched-list')!;
  const apply = document.querySelector<HTMLButtonElement>('#balances-apply')!;

  const show = (box: HTMLElement, text: string | null) => {
    box.textContent = text ?? '';
    box.hidden = text === null;
  };

  async function payload(applyNow: boolean) {
    const data = new FormData(form!);
    const files = await Promise.all(
      [...(form!.querySelector<HTMLInputElement>('#b-files')!.files ?? [])].map(async (file) => ({ name: file.name, text: await file.text() })),
    );
    return { accountId: data.get('accountId'), asOf: data.get('asOf'), files, apply: applyNow };
  }

  async function send(applyNow: boolean) {
    show(error, null);
    form!.querySelectorAll<HTMLElement>('[data-error-for]').forEach((slot) => (slot.textContent = ''));
    const response = await fetch('/api/plans/balances', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await payload(applyNow)) });
    const result = (await response.json().catch(() => null)) as Record<string, any> | null;
    if (!response.ok || !result) {
      if (result?.code === 'VALIDATION') {
        for (const item of result.errors as { field: string; code: string }[]) {
          const slot = form!.querySelector<HTMLElement>(`[data-error-for="${item.field}"]`);
          if (slot) slot.textContent = messages[`validation.${item.code}`] ?? messages['common.error']!;
        }
      } else if (result?.code === 'BAD_FILE') show(error, `${result.file}: ${messages['balances.badFile']}`);
      else show(error, messages['common.error']!);
      return null;
    }
    return result;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    show(done, null);
    preview.hidden = true;
    const result = await send(false);
    if (!result) return;
    rows.replaceChildren(
      ...(result.matches as { name: string; current: number; bank: number }[]).map((match) => {
        const tr = document.createElement('tr');
        const name = document.createElement('td');
        name.textContent = match.name;
        const current = document.createElement('td');
        current.className = 'num nowrap muted';
        current.textContent = money.format(match.current / 100);
        const bank = document.createElement('td');
        bank.className = 'num nowrap';
        bank.textContent = money.format(match.bank / 100);
        tr.append(name, current, bank);
        return tr;
      }),
    );
    const missing = result.unmatched as { description: string; date: string; number: string; bank: number }[];
    unmatchedList.replaceChildren(
      ...missing.map((row) => {
        const li = document.createElement('li');
        li.textContent = `${row.description} · ${row.date} · ${row.number} · ${money.format(row.bank / 100)}`;
        return li;
      }),
    );
    unmatched.hidden = missing.length === 0;
    apply.hidden = result.matches.length === 0;
    preview.hidden = false;
  });

  apply.addEventListener('click', async () => {
    apply.disabled = true;
    const result = await send(true);
    apply.disabled = false;
    if (!result) return;
    show(done, messages['balances.done']!.replace('{n}', String(result.applied)));
    setTimeout(() => location.reload(), 900);
  });
}

// Marca el archivo como módulo: sus variables no son globales.
export {};
