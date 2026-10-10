/** Utilidades compartidas por los formularios de acceso (login y registro). */

export type Messages = Record<string, string>;

/** Escribe o limpia el error en línea de un campo y mantiene aria-invalid / aria-describedby al día. */
export function setFieldError(input: HTMLInputElement, message: string | null): void {
  const error = document.getElementById(`${input.id}-error`);
  if (!error) return;
  error.textContent = message ?? '';
  if (message) {
    input.setAttribute('aria-invalid', 'true');
  } else {
    input.removeAttribute('aria-invalid');
  }
}

/** Aviso general del formulario: región viva siempre presente; recibe el foco para que no se pierda tras el teclado. */
export function showAlert(box: HTMLElement, label: string, message: string): void {
  const strong = document.createElement('strong');
  strong.textContent = `${label}: `;
  box.replaceChildren(strong, document.createTextNode(message));
  box.hidden = false;
  box.focus();
  box.scrollIntoView({ block: 'nearest' });
}

export function clearAlert(box: HTMLElement): void {
  box.hidden = true;
  box.replaceChildren();
}

/** Valida campos requeridos en el cliente; devuelve el primero inválido (y lo marca) o null. */
export function validateRequired(checks: Array<{ input: HTMLInputElement | null; message: string; test?: (value: string) => boolean }>): HTMLInputElement | null {
  let first: HTMLInputElement | null = null;
  for (const { input, message, test } of checks) {
    if (!input) continue;
    const value = input.value.trim();
    const bad = test ? !test(value) : value === '';
    setFieldError(input, bad ? message : null);
    if (bad && !first) first = input;
  }
  return first;
}

export function setBusy(form: HTMLFormElement, button: HTMLButtonElement, busy: boolean, busyText: string, idleText: string): void {
  form.setAttribute('aria-busy', String(busy));
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.textContent = busy ? busyText : idleText;
}

/** Botones "Mostrar / Ocultar" de contraseña. */
export function initPasswordToggles(messages: Messages): void {
  for (const toggle of document.querySelectorAll<HTMLButtonElement>('[data-pw-toggle]')) {
    const input = document.getElementById(toggle.dataset.pwToggle!) as HTMLInputElement | null;
    if (!input) continue;
    toggle.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', String(show));
      toggle.setAttribute('aria-label', messages[show ? 'auth.password.hideLabel' : 'auth.password.showLabel']!);
      toggle.textContent = messages[show ? 'auth.password.hide' : 'auth.password.show']!;
    });
  }
}

/** Foco automático solo con puntero fino: en el celular abriría el teclado y taparía la pantalla. */
export function focusFirstOnDesktop(input: HTMLInputElement | null): void {
  if (input && window.matchMedia('(pointer: fine)').matches) input.focus();
}

export function clearOnInput(form: HTMLFormElement): void {
  form.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    if (target.getAttribute('aria-invalid') === 'true') setFieldError(target, null);
  });
}
