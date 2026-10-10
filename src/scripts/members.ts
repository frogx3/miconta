const members = document.querySelector<HTMLElement>('#members');
const invite = document.querySelector<HTMLElement>('#invite');
const messages = JSON.parse((members ?? invite)?.dataset.messages ?? '{}') as Record<string, string>;

const errorBox = document.querySelector<HTMLElement>('#members-error');
const inviteError = document.querySelector<HTMLElement>('#invite-error');

const show = (box: HTMLElement | null, text: string | null) => {
  if (!box) return;
  box.textContent = text ?? '';
  box.hidden = text === null;
};

async function call(method: string, url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, any> | null }> {
  const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: response.ok, data: (await response.json().catch(() => null)) as Record<string, any> | null };
}

const failure = (box: HTMLElement | null, data: Record<string, any> | null) => {
  if (data?.code === 'FORBIDDEN_ROLE') show(box, messages['members.error.forbidden']!);
  else if (data?.code === 'VALIDATION' && data.errors?.[0]) show(box, messages[`validation.${data.errors[0].code}`] ?? messages['common.error']!);
  else show(box, messages['common.error']!);
};

members?.addEventListener('change', async (event) => {
  const select = (event.target as HTMLElement).closest<HTMLSelectElement>('.member-role');
  const row = select?.closest<HTMLElement>('tr');
  if (!select || !row) return;
  show(errorBox, null);
  const { ok, data } = await call('PATCH', `/api/members/${row.dataset.user}`, { role: select.value });
  if (!ok) {
    failure(errorBox, data);
    setTimeout(() => location.reload(), 1200);
  }
});

members?.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.member-remove');
  const row = button?.closest<HTMLElement>('tr');
  if (!button || !row) return;
  if (!confirm(messages['members.remove.confirm']!.replace('{name}', row.dataset.name ?? ''))) return;
  show(errorBox, null);
  button.disabled = true;
  const { ok, data } = await call('DELETE', `/api/members/${row.dataset.user}`, {});
  if (ok) location.reload();
  else {
    button.disabled = false;
    failure(errorBox, data);
  }
});

const form = document.querySelector<HTMLFormElement>('#invite-form');
form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  show(inviteError, null);
  const data = new FormData(form);
  const result = await call('POST', '/api/members/invitations', { role: data.get('role'), days: Number(data.get('days')) });
  if (!result.ok || !result.data?.url) return failure(inviteError, result.data);
  const url = document.querySelector<HTMLInputElement>('#invite-url')!;
  url.value = result.data.url;
  document.querySelector<HTMLElement>('#invite-result')!.hidden = false;
  url.select();
});

const copy = document.querySelector<HTMLButtonElement>('#invite-copy');
copy?.addEventListener('click', async () => {
  const url = document.querySelector<HTMLInputElement>('#invite-url')!;
  try {
    await navigator.clipboard.writeText(url.value);
  } catch {
    url.select();
    document.execCommand('copy');
  }
  copy.textContent = messages['members.invite.copied']!;
  setTimeout(() => (copy.textContent = messages['members.invite.copy']!), 1500);
});

invite?.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.invite-revoke');
  const row = button?.closest<HTMLElement>('li');
  if (!button || !row) return;
  show(inviteError, null);
  button.disabled = true;
  const { ok, data } = await call('DELETE', '/api/members/invitations', { id: row.dataset.invite });
  if (ok) location.reload();
  else {
    button.disabled = false;
    failure(inviteError, data);
  }
});

// Marca el archivo como módulo: sus variables no son globales.
export {};
