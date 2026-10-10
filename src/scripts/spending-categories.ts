import { normalizePattern } from '../lib/spending/categorize';

const root = document.querySelector<HTMLElement>('#categories-app');

if (root) {
  const messages = JSON.parse(root.dataset.messages!) as Record<string, string>;
  const config = JSON.parse(root.dataset.config!) as { canWrite: boolean; uncategorized: [string, number][]; initialPattern: string; initialCategory: string };
  const errorBox = root.querySelector<HTMLElement>('#app-error')!;
  const doneBox = root.querySelector<HTMLElement>('#app-done')!;
  const msg = (key: string, params?: Record<string, string | number>) =>
    (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`));

  const show = (box: HTMLElement, text: string | null) => {
    box.textContent = text ?? '';
    box.hidden = text === null;
  };

  async function call(method: string, url: string, body?: unknown) {
    show(errorBox, null);
    const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = (await response.json().catch(() => ({}))) as { code?: string; errors?: { field: string; code: string }[]; applied?: number; created?: number };
    return { ok: response.ok, data };
  }

  /** Muestra el motivo del rechazo: errores de campo, duplicados o un mensaje general. */
  function fail(form: HTMLElement | null, data: { code?: string; errors?: { field: string; code: string }[] }) {
    form?.querySelectorAll<HTMLElement>('[data-error-for]').forEach((el) => (el.textContent = ''));
    if (data.code === 'VALIDATION' && data.errors && form) {
      for (const { field, code } of data.errors) {
        const slot = form.querySelector<HTMLElement>(`[data-error-for="${field}"]`);
        if (slot) slot.textContent = msg(`validation.${code}`);
      }
      return;
    }
    const known: Record<string, string> = { DUPLICATE_CATEGORY: 'categories.duplicate', DUPLICATE_RULE: 'rules.duplicate' };
    show(errorBox, msg(known[data.code ?? ''] ?? 'common.error'));
  }

  const colorOf = (form: HTMLFormElement) => form.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value ?? '';
  const nameOf = (form: HTMLFormElement) => form.querySelector<HTMLInputElement>('input[name="name"]')!.value;
  const budgetOf = (form: HTMLFormElement) => form.querySelector<HTMLInputElement>('input[name="budget"]')?.value ?? '';

  // Categorías sugeridas
  root.querySelector('#seed-defaults')?.addEventListener('click', async () => {
    const { ok, data } = await call('POST', '/api/categories/defaults', {});
    if (ok) {
      show(doneBox, msg('categories.defaultsDone', { n: data.created ?? 0 }));
      setTimeout(() => location.reload(), 500);
    } else fail(null, data);
  });

  // Alta, edición y baja de categorías
  root.querySelector<HTMLFormElement>('#category-add')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const { ok, data } = await call('POST', '/api/categories', { name: nameOf(form), color: colorOf(form), budget: budgetOf(form) });
    if (ok) location.reload();
    else fail(form, data);
  });

  root.querySelectorAll<HTMLFormElement>('form.category-row[data-id]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const { ok, data } = await call('PATCH', `/api/categories/${form.dataset.id}`, { name: nameOf(form), color: colorOf(form), budget: budgetOf(form) });
      if (ok) location.reload();
      else fail(form, data);
    });
    form.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (!confirm(msg('categories.deleteConfirm', { name: form.dataset.name ?? '', n: form.dataset.count ?? 0 }))) return;
      const { ok, data } = await call('DELETE', `/api/categories/${form.dataset.id}`);
      if (ok) location.reload();
      else fail(null, data);
    });
  });

  // Reglas: coincidencias en vivo, alta, baja y aplicación
  const ruleForm = root.querySelector<HTMLFormElement>('#rule-add');
  const patternInput = root.querySelector<HTMLInputElement>('#rule-pattern');
  const matches = root.querySelector<HTMLElement>('#rule-matches');

  const countMatches = () => {
    if (!patternInput || !matches) return;
    const pattern = normalizePattern(patternInput.value);
    if (pattern.length < 2) {
      matches.textContent = '';
      return;
    }
    const total = config.uncategorized.reduce((sum, [description, count]) => (description.includes(pattern) ? sum + count : sum), 0);
    matches.textContent = msg('rules.matches', { n: total });
  };
  patternInput?.addEventListener('input', countMatches);

  const fillRule = (pattern: string, categoryId?: string) => {
    if (!ruleForm || !patternInput) return;
    patternInput.value = pattern;
    if (categoryId) {
      const select = ruleForm.querySelector<HTMLElement & { value: string }>('#rule-category');
      if (select) select.value = categoryId;
    }
    countMatches();
    ruleForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
    patternInput.focus();
  };
  if (config.initialPattern) fillRule(config.initialPattern, config.initialCategory || undefined);

  root.querySelectorAll<HTMLElement>('[data-rule-for]').forEach((button) => button.addEventListener('click', () => fillRule(button.dataset.ruleFor!)));

  ruleForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(ruleForm);
    const { ok, data: result } = await call('POST', '/api/category-rules', {
      pattern: data.get('pattern'),
      categoryId: data.get('categoryId'),
      applyNow: data.get('applyNow') === 'on',
    });
    if (ok) location.reload();
    else fail(ruleForm, result);
  });

  root.querySelectorAll<HTMLElement>('[data-delete-rule]').forEach((button) =>
    button.addEventListener('click', async () => {
      const { ok, data } = await call('DELETE', `/api/category-rules/${button.dataset.deleteRule}`);
      if (ok) location.reload();
      else fail(null, data);
    }),
  );

  root.querySelector('#apply-rules')?.addEventListener('click', async () => {
    const { ok, data } = await call('POST', '/api/category-rules/apply', {});
    if (ok) {
      show(doneBox, msg('rules.applied', { n: data.applied ?? 0 }));
      setTimeout(() => location.reload(), 900);
    } else fail(null, data);
  });
}
