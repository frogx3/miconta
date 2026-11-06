// Service worker de Don Bigo: solo notificaciones push (sin caché ni modo sin conexión).
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Don Bigo', {
      body: data.body || '',
      icon: '/icon-192.png',
      tag: data.tag,
      data: { url: data.url || '/app/agenda' },
    }),
  );
});

// Al tocarla: enfoca una ventana abierta de la app (y la lleva a la URL) o abre una nueva.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/app/agenda', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      return open ? open.focus().then((w) => w.navigate(url)) : self.clients.openWindow(url);
    }),
  );
});
