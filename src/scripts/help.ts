/** Coloca el globo de ayuda junto a su botón al abrirse y lo cierra si la página se desplaza. */
const GAP = 8;
const MARGIN = 12;

document.addEventListener(
  'toggle',
  (event) => {
    const pop = event.target;
    if (!(pop instanceof HTMLElement) || !pop.classList.contains('help-pop')) return;
    if ((event as ToggleEvent).newState !== 'open') return;
    const button = document.querySelector<HTMLElement>(`[popovertarget="${pop.id}"]`);
    if (!button) return;

    const anchor = button.getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const left = Math.min(Math.max(MARGIN, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - width - MARGIN);
    const fitsBelow = anchor.bottom + GAP + height <= window.innerHeight - MARGIN;
    const top = fitsBelow ? anchor.bottom + GAP : Math.max(MARGIN, anchor.top - GAP - height);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  },
  true,
);

function closeOpen() {
  document.querySelectorAll<HTMLElement>('.help-pop:popover-open').forEach((pop) => pop.hidePopover());
}

window.addEventListener('scroll', closeOpen, { passive: true });
window.addEventListener('resize', closeOpen);
