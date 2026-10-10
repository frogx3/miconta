/** Tema de la interfaz: 'light', 'dark' o 'system' (sigue al sistema). Se recuerda en este navegador. */

export {};

const KEY = 'miconta-theme';
const root = document.documentElement;
const dark = window.matchMedia('(prefers-color-scheme: dark)');

type Choice = 'light' | 'dark' | 'system';

const stored = (): Choice => {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
};

function apply(choice: Choice) {
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  const effective = choice === 'system' ? (dark.matches ? 'dark' : 'light') : choice;
  root.setAttribute('data-mode', effective);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', effective === 'dark' ? '#132238' : '#ffffff');
  document.querySelectorAll<HTMLInputElement>('input[data-theme-choice]').forEach((input) => (input.checked = input.value === choice));
}

function choose(choice: Choice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* sin almacenamiento: el cambio vale solo para esta página */
  }
  apply(choice);
}

apply(stored());
dark.addEventListener('change', () => {
  if (stored() === 'system') apply('system');
});

document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]').forEach((button) =>
  button.addEventListener('click', () => choose(root.getAttribute('data-mode') === 'dark' ? 'light' : 'dark')),
);
document.querySelectorAll<HTMLInputElement>('input[data-theme-choice]').forEach((input) => input.addEventListener('change', () => choose(input.value as Choice)));
