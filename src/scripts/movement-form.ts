type Field = HTMLElement & { value: string };
const form = document.querySelector<HTMLFormElement>('#movement-form');

if (form) {
  const messages = JSON.parse(document.querySelector<HTMLElement>('#movements')?.dataset.messages ?? '{}') as Record<string, string>;
  const errorBox = form.querySelector<HTMLElement>('#movement-form-error')!;
  const kind = form.querySelector<Field>('#m-kind')!;
  const category = form.querySelector<Field>('#m-category')!;
  const categoryField = form.querySelector<HTMLElement>('#m-category-field')!;
  const newField = form.querySelector<HTMLElement>('#m-new-category-field')!;
  const newName = form.querySelector<Field>('#m-new-category')!;

  // La categoría solo aplica a cargos; "crear nueva" muestra el campo del nombre.
  const sync = () => {
    const charge = kind.value === 'charge';
    categoryField.hidden = !charge;
    newField.hidden = !charge || category.value !== '__new__';
  };
  kind.addEventListener('change', sync);
  category.addEventListener('change', () => {
    sync();
    if (category.value === '__new__') newName.focus();
  });

  const show = (text: string | null) => {
    errorBox.textContent = text ?? '';
    errorBox.hidden = text === null;
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    show(null);
    const data = new FormData(form);
    const creating = kind.value === 'charge' && category.value === '__new__';
    const body = {
      cardId: data.get('cardId'),
      kind: data.get('kind'),
      date: data.get('date'),
      description: data.get('description'),
      amount: data.get('amount'),
      categoryId: kind.value === 'charge' && !creating ? data.get('categoryId') : '',
      newCategory: creating ? data.get('newCategory') : '',
    };
    const response = await fetch('/api/movements', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (response.ok) {
      location.reload();
      return;
    }
    const result = (await response.json().catch(() => null)) as { errors?: { field: string; code: string }[] } | null;
    const first = result?.errors?.[0];
    show(first ? (messages[`validation.${first.code}`] ?? messages['common.error']!) : messages['common.error']!);
  });
}
