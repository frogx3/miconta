const section = document.querySelector<HTMLElement>('#tags');

if (section) {
  const planId = section.dataset.planId!;
  const messages = JSON.parse(section.dataset.messages!) as Record<string, string>;
  const error = document.querySelector<HTMLElement>('#tags-error')!;
  const list = document.querySelector<HTMLElement>('#tag-list')!;
  const empty = document.querySelector<HTMLElement>('#tags-empty')!;
  const form = document.querySelector<HTMLFormElement>('#tag-form');
  const input = document.querySelector<HTMLInputElement>('#tag-name');

  const show = (text: string | null) => {
    error.textContent = text ?? '';
    error.hidden = text === null;
  };
  const refreshEmpty = () => (empty.hidden = list.children.length > 0);

  async function call(method: string, body: unknown) {
    const response = await fetch(`/api/plans/${planId}/tags`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: response.ok, data: (await response.json().catch(() => null)) as Record<string, any> | null };
  }

  const fail = (data: Record<string, any> | null) =>
    show(data?.code === 'VALIDATION' && data.errors?.[0] ? (messages[`validation.${data.errors[0].code}`] ?? messages['common.error']!) : messages['common.error']!);

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    show(null);
    const name = input!.value;
    if (!name.trim()) return;
    const { ok, data } = await call('POST', { name });
    if (!ok || !data?.tag) return fail(data);
    if (!list.querySelector(`[data-tag="${data.tag.id}"]`)) {
      const item = document.createElement('li');
      item.className = 'chip';
      item.dataset.tag = data.tag.id;
      const label = document.createElement('span');
      label.textContent = data.tag.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'tag-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', messages['plan.tags.remove']!.replace('{name}', data.tag.name));
      item.append(label, remove);
      list.append(item);
    }
    input!.value = '';
    refreshEmpty();
  });

  list.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.tag-remove');
    const item = button?.closest<HTMLElement>('li');
    if (!button || !item) return;
    show(null);
    button.disabled = true;
    const { ok, data } = await call('DELETE', { tagId: item.dataset.tag });
    if (!ok) {
      button.disabled = false;
      return fail(data);
    }
    item.remove();
    refreshEmpty();
  });
}

// Marca el archivo como módulo: sus variables no son globales.
export {};
