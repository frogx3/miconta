import './local-time';

const root = document.querySelector<HTMLElement>('#email-inbox');

if (root) {
  const messages = JSON.parse(root.dataset.messages!) as Record<string, string>;
  const errorBox = root.querySelector<HTMLElement>('#email-error')!;
  const fail = () => {
    errorBox.textContent = messages['common.error'] ?? 'Error';
    errorBox.hidden = false;
  };
  const send = async (url: string, method: string, body: unknown) => {
    errorBox.hidden = true;
    const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (response.ok) location.reload();
    else fail();
  };

  root.querySelector<HTMLButtonElement>('[data-copy]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    await navigator.clipboard.writeText(root.querySelector('#email-address')!.textContent!.trim());
    button.textContent = messages['email.copied']!;
  });

  root.querySelectorAll<HTMLButtonElement>('[data-inbox-action]').forEach((button) =>
    button.addEventListener('click', () => {
      const action = button.dataset.inboxAction;
      if (action !== 'enable' && !confirm(messages[`email.confirm.${action}`])) return;
      button.disabled = true;
      void send(`/api/accounts/${root.dataset.accountId}/email`, action === 'disable' ? 'DELETE' : 'POST', { regenerate: action === 'regenerate' });
    }),
  );

  root.querySelectorAll<HTMLButtonElement>('[data-review]').forEach((button) =>
    button.addEventListener('click', () => {
      const row = button.closest<HTMLElement>('[data-message]')!;
      button.disabled = true;
      void send(`/api/email-messages/${row.dataset.message}`, 'POST', {
        action: button.dataset.review,
        trustDomain: row.querySelector<HTMLInputElement>('[data-trust]')?.checked === true,
      });
    }),
  );
}
