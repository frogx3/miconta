// El servidor deja la hora en UTC como respaldo; aquí se muestra en la zona horaria de la persona.
document.querySelectorAll<HTMLTimeElement>('time[data-ts]').forEach((el) => {
  const date = new Date(el.dateTime);
  if (!Number.isNaN(date.getTime())) el.textContent = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
});

// Marca el archivo como módulo.
export {};
