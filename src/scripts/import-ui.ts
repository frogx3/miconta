/** Piezas visuales compartidas por Importar CSV y Comparar PDF: pasos, mosaico, zona para soltar y «Listo». */
import { countTiles } from '../lib/import/mosaic';

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Marca el paso actual; los anteriores quedan hechos salvo los que se saltaron (p. ej. columnas ya conocidas). */
export function setImportStep(current: number, skipped: number[] = []) {
  document.querySelectorAll<HTMLElement>('[data-import-steps] [data-step]').forEach((li) => {
    const n = Number(li.dataset.step);
    if (n === current) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
    li.classList.toggle('is-done', n < current && !skipped.includes(n));
  });
}

/** Un cuadrito por renglón y una leyenda con el conteo de cada tipo (en el orden de `labels`). */
export function mosaicHtml<T extends string>(tiles: readonly T[], labels: [T, string][]): string {
  const counts = countTiles(tiles);
  const shown = labels.filter(([kind]) => counts[kind]);
  const summary = shown.map(([kind, label]) => `${label}: ${counts[kind]}`).join(', ');
  return `<div class="mosaic" role="img" aria-label="${esc(summary)}">${tiles.map((t) => `<i class="tile-${t}"></i>`).join('')}</div>
    <div class="mosaic-legend">${shown.map(([kind, label]) => `<span><i class="tile-${kind}"></i>${esc(label)} <b>${counts[kind]}</b></span>`).join('')}</div>`;
}

/** Arrastrar y soltar un archivo sobre la zona: lo pone en el input como si se hubiera elegido. */
export function bindDrop(zone: HTMLElement, input: HTMLInputElement) {
  const on = (over: boolean) => zone.classList.toggle('is-over', over);
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    on(true);
  });
  zone.addEventListener('dragleave', () => on(false));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    on(false);
    if (!event.dataTransfer?.files.length) return;
    input.files = event.dataTransfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Pantalla final con la mascota (su única aparición en Importar). `actions` y `note` ya vienen escapados. */
export function doneHtml(o: { title: string; results: [number | string, string][]; note?: string; actions: string; undo?: string }): string {
  return `<div class="import-done">
      <div class="import-done-pup"><img src="/brand/mascota/listo.webp" alt="" width="420" height="410" /></div>
      <div>
        <h2>${esc(o.title)}</h2>
        ${o.results.length ? `<div class="import-results">${o.results.map(([n, label]) => `<div><strong>${esc(String(n))}</strong><span>${esc(label)}</span></div>`).join('')}</div>` : ''}
        ${o.note ?? ''}
        <div class="import-next">${o.actions}</div>
        ${o.undo ? `<p class="hint">${o.undo}</p>` : ''}
      </div>
    </div>`;
}
