import { merchantKey } from '../lib/spending/categorize';

const root = document.querySelector<HTMLElement>('#movements');

if (root && root.dataset.config) {
  const messages = JSON.parse(root.dataset.messages!) as Record<string, string>;
  const config = JSON.parse(root.dataset.config) as { canWrite: boolean; categories: { id: string; name: string }[] };
  const errorBox = root.querySelector<HTMLElement>('#movements-error')!;
  const msg = (key: string, params: Record<string, string | number>) =>
    (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));

  const show = (text: string | null) => {
    errorBox.textContent = text ?? '';
    errorBox.hidden = text === null;
  };

  async function assign(ids: string[], categoryId: string | null): Promise<boolean> {
    show(null);
    const response = await fetch('/api/movements', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, categoryId }),
    });
    if (!response.ok) show(messages['common.error']!);
    return response.ok;
  }

  // Categoría de una fila. Si se asignó una, se ofrece crear una regla para todo el comercio.
  root.querySelectorAll<HTMLElement & { value: string; dataset: DOMStringMap }>('.row-category').forEach((select) => {
    select.addEventListener('change', async () => {
      const row = select.closest<HTMLElement>('tr')!;
      const value = select.value || null;
      const saved = await assign([row.dataset.id!], value);
      const suggestion = row.querySelector<HTMLElement>('.suggest')!;
      if (!saved) {
        select.value = select.dataset.current ?? '';
        return;
      }
      select.dataset.current = value ?? '';
      suggestion.innerHTML = '';
      if (!value) return;
      const key = merchantKey(row.dataset.desc!);
      const link = document.createElement('a');
      link.href = `/app/gastos/categorias?patron=${encodeURIComponent(key)}&categoria=${encodeURIComponent(value)}`;
      link.textContent = msg('movements.suggest', { key });
      link.className = 'hint block';
      suggestion.appendChild(link);
    });
  });

  // Selección múltiple y asignación masiva
  const picks = () => [...root.querySelectorAll<HTMLInputElement>('.pick')];
  const bar = root.querySelector<HTMLElement>('#bulk-bar');
  const label = root.querySelector<HTMLElement>('#bulk-label');
  const refreshBar = () => {
    if (!bar || !label) return;
    const selected = picks().filter((pick) => pick.checked).length;
    bar.hidden = selected === 0;
    label.textContent = msg('movements.bulk.label', { n: selected });
  };
  root.querySelector<HTMLInputElement>('#select-all')?.addEventListener('change', (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    picks().forEach((pick) => (pick.checked = checked));
    refreshBar();
  });
  picks().forEach((pick) => pick.addEventListener('change', refreshBar));

  root.querySelector<HTMLButtonElement>('#bulk-apply')?.addEventListener('click', async () => {
    const choice = root.querySelector<HTMLElement & { value: string }>('#bulk-category')!.value;
    if (!choice) return;
    const ids = picks().filter((pick) => pick.checked).map((pick) => pick.closest<HTMLElement>('tr')!.dataset.id!);
    if (ids.length === 0) return;
    if (await assign(ids, choice === 'none' ? null : choice)) location.reload();
  });
}
