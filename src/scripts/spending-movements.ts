import { merchantKey } from '../lib/spending/categorize';

const root = document.querySelector<HTMLElement>('#movements');

if (root && root.dataset.config) {
  const messages = JSON.parse(root.dataset.messages!) as Record<string, string>;
  const config = JSON.parse(root.dataset.config) as { canWrite: boolean; locale: string; categories: { id: string; name: string }[] };
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

  // Convertir un movimiento en plan: formulario en una fila justo debajo del movimiento.
  const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const firstWords = (text: string, n: number) => text.split(/\s+/).slice(0, n).join(' ');
  const FIELDS: [string, string, string, string][] = [
    ['name', 'import.plan.name', '', 'maxlength="80"'],
    ['matchText', 'import.plan.matchText', 'import.plan.matchTextHint', 'maxlength="120"'],
    ['installmentAmount', 'import.plan.installment', '', 'inputmode="decimal"'],
    ['currentInstallment', 'import.plan.current', 'import.plan.currentHint', 'inputmode="numeric"'],
    ['totalInstallments', 'import.plan.total', '', 'inputmode="numeric"'],
    ['totalAmount', 'import.plan.totalAmount', 'import.plan.totalAmountHint', 'inputmode="decimal"'],
  ];

  function closeForms() {
    root!.querySelectorAll('.plan-form-row').forEach((row) => row.remove());
  }

  root.querySelectorAll<HTMLButtonElement>('.convert-plan').forEach((button) => {
    button.addEventListener('click', () => {
      const row = button.closest<HTMLElement>('tr')!;
      closeForms();
      show(null);
      const defaults: Record<string, string> = {
        name: (row.dataset.name ?? '').slice(0, 60),
        matchText: firstWords(row.dataset.name ?? '', 4),
        installmentAmount: row.dataset.amount ?? '',
        type: row.dataset.type ?? 'msi',
        currentInstallment: '1',
        totalInstallments: '12',
        totalAmount: '',
        interestRate: '',
      };
      const fields = FIELDS.map(
        ([name, label, hint, attrs]) =>
          `<div class="field"><label>${esc(messages[label] ?? label)}</label><input data-plan="${name}" type="text" value="${esc(defaults[name]!)}" ${attrs} />${hint ? `<span class="hint">${esc(messages[hint] ?? hint)}</span>` : ''}</div>`,
      ).join('');
      const types = (['msi', 'mci', 'fixed'] as const).map((type) => `<option value="${type}">${esc(messages[`import.plan.type.${type}`] ?? type)}</option>`).join('');
      const formRow = document.createElement('tr');
      formRow.className = 'plan-form-row';
      formRow.innerHTML = `<td colspan="${row.children.length}">
        <p class="hint">${esc(msg('movements.plan.hint', {}))}</p>
        <form class="plan-form form-grid" novalidate>
          <div class="field"><label>${esc(messages['import.plan.type']!)}</label><select data-plan="type">${types}</select></div>
          ${fields}
          <div class="field" data-rate${defaults.type === 'msi' ? ' hidden' : ''}><label>${esc(messages['import.plan.rate']!)}</label><input data-plan="interestRate" type="text" inputmode="decimal" /></div>
          <div class="form-actions row-actions">
            <button type="submit" class="btn btn-small">${esc(messages['import.plan.save']!)}</button>
            <button type="button" class="btn btn-ghost btn-small" data-cancel>${esc(messages['common.cancel']!)}</button>
          </div>
        </form></td>`;
      row.insertAdjacentElement('afterend', formRow);
      presetPlanType(formRow, defaults.type!);

      const form = formRow.querySelector<HTMLFormElement>('form')!;
      const read = () => {
        const values: Record<string, string> = {};
        form.querySelectorAll<HTMLElement & { value: string }>('[data-plan]').forEach((el) => (values[el.dataset.plan!] = el.value));
        return values;
      };
      form.querySelector<HTMLElement>('[data-plan="type"]')!.addEventListener('change', (event) => {
        form.querySelector<HTMLElement>('[data-rate]')!.hidden = (event.target as HTMLInputElement).value === 'msi';
      });
      formRow.querySelector('[data-cancel]')!.addEventListener('click', closeForms);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        show(null);
        const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        submit.disabled = true;
        const response = await fetch(`/api/movements/${row.dataset.id}/plan`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(read()),
        });
        if (response.ok) return location.reload();
        submit.disabled = false;
        const body = (await response.json().catch(() => ({}))) as { code?: string; errors?: { field: string; code: string }[] };
        form.querySelectorAll<HTMLElement>('[data-plan]').forEach((el) => el.removeAttribute('aria-invalid'));
        if (body.code === 'VALIDATION' && body.errors?.length) {
          body.errors.forEach((e) => form.querySelector(`[data-plan="${e.field}"]`)?.setAttribute('aria-invalid', 'true'));
          show(body.errors.map((e) => `${messages[`import.plan.${FIELD_LABEL[e.field] ?? e.field}`] ?? e.field}: ${messages[`validation.${e.code}`] ?? e.code}`).join('; '));
        } else if (body.code === 'CARD_REQUIRED') show(messages['movements.plan.error.card']!);
        else if (body.code === 'NOT_CONVERTIBLE' || body.code === 'NOT_FOUND') show(messages['movements.plan.error.taken']!);
        else show(messages['common.error']!);
      });
      form.querySelector<HTMLInputElement>('[data-plan="name"]')!.focus();
    });
  });
}

const FIELD_LABEL: Record<string, string> = { installmentAmount: 'installment', currentInstallment: 'current', totalInstallments: 'total', totalAmount: 'totalAmount', interestRate: 'rate', matchText: 'matchText', name: 'name', type: 'type' };

/** Deja elegido el tipo de plan que sugiere el movimiento (un pago agrupado con intereses es "meses con intereses"). */
function presetPlanType(formRow: HTMLElement, type: string) {
  const select = formRow.querySelector<HTMLElement & { value: string }>('[data-plan="type"]');
  if (select) select.value = type;
}
