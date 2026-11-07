/**
 * Notificaciones push en este navegador (sección con `#push-settings` y `data-key`). En iPhone solo existen con Don
 * Bigo agregado a la pantalla de inicio. Los textos llegan en `data-messages`.
 */
const push = document.querySelector<HTMLElement>('#push-settings');

if (push) {
  const messages = JSON.parse(push.dataset.messages!) as Record<string, string>;
  const msg = (key: string) => messages[key] ?? key;
  const note = push.querySelector<HTMLElement>('[data-push-note]')!;
  const toggle = push.querySelector<HTMLButtonElement>('[data-push-toggle]')!;
  const say = (key: string | null) => {
    note.textContent = key ? msg(key) : '';
    note.hidden = key === null;
  };
  const call = (method: string, body: unknown) => fetch('/api/agenda/push', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.ok, () => false);

  push.hidden = false;
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    say(ios ? 'agenda.push.ios' : 'agenda.push.unsupported');
  } else {
    void (async () => {
      const registration = await navigator.serviceWorker.register('/sw.js');
      let current = await registration.pushManager.getSubscription();
      const render = (error = false) => {
        toggle.hidden = false;
        toggle.textContent = msg(current ? 'agenda.push.disable' : 'agenda.push.enable');
        say(error ? 'common.error' : current ? 'agenda.push.enabled' : Notification.permission === 'denied' ? 'agenda.push.denied' : null);
      };
      render();
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        let error = false;
        try {
          if (current) {
            await call('DELETE', { endpoint: current.endpoint });
            await current.unsubscribe();
            current = null;
          } else if ((await Notification.requestPermission()) === 'granted') {
            const key = Uint8Array.from(atob(push.dataset.key!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
            current = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
            if (!(await call('POST', { ...current.toJSON(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }))) {
              await current.unsubscribe();
              current = null;
              error = true;
            }
          }
        } catch {
          error = true;
        } finally {
          toggle.disabled = false;
          render(error);
        }
      });
    })();
  }
}

export {};
