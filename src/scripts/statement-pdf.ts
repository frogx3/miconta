import { getDocument, GlobalWorkerOptions, PasswordResponses } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { parseDate } from '../lib/import/dates';
import { formatMinor } from '../lib/money-format';
import type { StatementComparison } from '../lib/statements/compare';
import {
  DATE_FORMATS,
  draftMovement,
  finishMovement,
  guessColumns,
  guessDateFormat,
  guessKind,
  last4From,
  MOVEMENT_FIELDS,
  PLAN_FIELDS,
  planRow,
  type Columns,
  type MovementDraft,
  type MovementField,
  type PlanField,
  type TableKind,
} from '../lib/statements/mapping';
import { detectTables, labeledDate, type DetectedTable, type PdfText } from '../lib/statements/tables';
import type { BankPlanRow } from '../lib/plans/bank-balances';
import { statementTiles, type StatementTile } from '../lib/import/mosaic';
import { bindDrop, doneHtml, mosaicHtml, setImportStep } from './import-ui';

GlobalWorkerOptions.workerSrc = workerUrl;

interface Config {
  locale: string;
  accounts: { id: string; name: string; currency: string }[];
  messages: Record<string, string>;
}

/** Lo que la persona decidió de cada tabla que marcó para usar. */
interface Choice {
  kind: TableKind;
  movementColumns: Columns<MovementField>;
  planColumns: Columns<PlanField>;
  dateFormat: number;
  last4: string;
}

const root = document.querySelector<HTMLElement>('#statement-app');
if (root) start(root);

function start(root: HTMLElement) {
  const config = JSON.parse(root.dataset.config!) as Config;
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const msg = (key: string, params?: Record<string, string | number>) => {
    const template = config.messages[key] ?? key;
    return params ? template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`)) : template;
  };
  const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const errorBox = $('#statement-error');
  const showError = (text: string | null) => {
    errorBox.textContent = text ?? '';
    errorBox.hidden = text === null;
    if (text) errorBox.scrollIntoView({ block: 'center' });
  };

  const state = {
    items: [] as PdfText[],
    tables: [] as DetectedTable[],
    choices: new Map<number, Choice>(),
    /** Movimientos por tabla elegida; los incompletos los completa la persona. */
    drafts: [] as { table: number; draft: MovementDraft; postedDate: string | null; last4: string | null; include: boolean }[],
    plans: [] as BankPlanRow[],
    unreadablePlans: 0,
    period: { start: '', cutoff: '', dueDate: '' },
    totals: { charges: '', credits: '' },
  };
  const account = () => config.accounts.find((a) => a.id === root.querySelector<HTMLElement & { value: string }>('#statement-account')!.value) ?? config.accounts[0]!;
  const money = (minor: number) => formatMinor(minor, account().currency, config.locale);
  const toMinor = (text: string) => {
    const clean = text.replace(/[$,\s]/g, '');
    return /^\d+(\.\d{1,2})?$/.test(clean) ? Math.round(Number(clean) * 100) : null;
  };

  // ── 1. Leer el PDF en el navegador (no se sube) ──────────────────────────────────────────────
  const fileInput = $<HTMLInputElement>('#statement-file');
  bindDrop($('#statement-drop'), fileInput);
  fileInput.addEventListener('change', () => {
    $('#statement-file-name').textContent = fileInput.files?.[0]?.name ?? '';
    $('#statement-password-field').hidden = true;
  });

  $<HTMLFormElement>('#statement-upload').addEventListener('submit', async (event) => {
    event.preventDefault();
    showError(null);
    const file = fileInput.files?.[0];
    if (!file) return showError(msg('statement.error.noFile'));
    const submit = $<HTMLButtonElement>('#statement-upload button[type=submit]');
    submit.disabled = true;
    try {
      state.items = await readPdf(new Uint8Array(await file.arrayBuffer()), $<HTMLInputElement>('#statement-password').value);
      state.tables = detectTables(state.items);
      state.choices.clear();
      $('#statement-review').hidden = true;
      $('#statement-result').hidden = true;
      if (state.tables.length === 0) showError(msg('statement.error.noTables'));
      renderTables();
    } catch (error) {
      if ((error as { name?: string }).name === 'PasswordException') {
        $('#statement-password-field').hidden = false;
        showError(msg((error as { code?: number }).code === PasswordResponses.INCORRECT_PASSWORD ? 'statement.error.badPassword' : 'statement.error.password'));
        $<HTMLInputElement>('#statement-password').focus();
      } else showError(msg('statement.error.read'));
    } finally {
      submit.disabled = false;
    }
  });

  async function readPdf(data: Uint8Array, password: string): Promise<PdfText[]> {
    const doc = await getDocument({ data, password: password || undefined, isEvalSupported: false }).promise;
    const items: PdfText[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { height } = page.getViewport({ scale: 1 });
      for (const item of (await page.getTextContent()).items) {
        if (!('str' in item) || !item.str.trim()) continue;
        items.push({ page: n, x: item.transform[4], y: height - item.transform[5], width: item.width, str: item.str });
      }
    }
    await doc.destroy();
    return items;
  }

  // ── 2. Tablas encontradas: la persona elige cuáles y qué es cada columna ─────────────────────
  const columnLabel = (table: DetectedTable, i: number) => table.header[i] || table.rows.find((row) => row[i])?.[i] || msg('statement.column', { n: i + 1 });
  const fieldSelect = (index: number, field: string, value: number, table: DetectedTable) => `
    <div class="field narrow"><label>${esc(msg(`statement.field.${field}`))}
      <select data-table="${index}" data-field="${field}">
        <option value="-1">—</option>
        ${table.header.map((_, i) => `<option value="${i}" ${i === value ? 'selected' : ''}>${esc(`${i + 1}. ${columnLabel(table, i)}`.slice(0, 48))}</option>`).join('')}
      </select></label></div>`;

  function newChoice(index: number): Choice {
    const table = state.tables[index]!;
    const kind = guessKind(table);
    const movementColumns = guessColumns(table, 'movements');
    const planColumns = guessColumns(table, 'plans');
    const dateColumn = kind === 'plans' ? planColumns.date : movementColumns.date;
    return { kind, movementColumns, planColumns, dateFormat: guessDateFormat(table.rows.map((row) => row[dateColumn] ?? '')), last4: last4From(table.subtitle) ?? '' };
  }

  function renderTables() {
    const box = $('#statement-tables');
    box.hidden = state.tables.length === 0;
    setImportStep(box.hidden ? 1 : 2);
    box.innerHTML = `
      <section class="card"><h2>${esc(msg('statement.tables.title', { n: state.tables.length }))}</h2><p class="hint">${esc(msg('statement.tables.hint'))}</p></section>
      ${state.tables.map((table, index) => tableCard(table, index)).join('')}
      <section class="card"><div class="form-actions"><button type="button" class="btn" id="statement-continue" ${state.choices.size ? '' : 'disabled'}>${esc(msg('statement.continue'))}</button></div></section>`;
  }

  function tableCard(table: DetectedTable, index: number): string {
    const choice = state.choices.get(index);
    const fields = choice?.kind === 'plans' ? PLAN_FIELDS : MOVEMENT_FIELDS;
    const columns = (choice?.kind === 'plans' ? choice.planColumns : choice?.movementColumns) as Record<string, number> | undefined;
    return `
      <section class="card statement-table${choice ? ' is-chosen' : ''}">
        <label class="check"><input type="checkbox" data-use="${index}" ${choice ? 'checked' : ''} />
          <strong>${esc(table.title ?? msg('statement.tables.untitled'))}</strong></label>
        <p class="muted">${esc([table.subtitle, msg('statement.tables.meta', { pages: table.pages.join(', '), rows: table.rows.length })].filter(Boolean).join(' · '))}</p>
        <div class="table-scroll"><table class="import-table">
          <thead><tr>${table.header.map((_, i) => `<th>${esc(table.header[i] || msg('statement.column', { n: i + 1 }))}</th>`).join('')}</tr></thead>
          <tbody>${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>
        ${
          choice && columns
            ? `<div class="form-grid">
                <div class="field narrow"><label>${esc(msg('statement.kind'))}
                  <select data-table="${index}" data-kind>${(['movements', 'plans'] as const).map((k) => `<option value="${k}" ${k === choice.kind ? 'selected' : ''}>${esc(msg(`statement.kind.${k}`))}</option>`).join('')}</select></label></div>
                <div class="field narrow"><label>${esc(msg('statement.dateFormat'))}
                  <select data-table="${index}" data-date-format>${DATE_FORMATS.map((f, i) => `<option value="${i}" ${i === choice.dateFormat ? 'selected' : ''}>${esc(`${f.format} (${f.locale})`)}</option>`).join('')}</select></label></div>
                ${choice.kind === 'movements' ? `<div class="field narrow"><label>${esc(msg('statement.last4'))}<input data-table="${index}" data-last4 inputmode="numeric" maxlength="4" value="${esc(choice.last4)}" /></label></div>` : ''}
                ${fields.map((field) => fieldSelect(index, field, columns[field] ?? -1, table)).join('')}
              </div>
              <p class="hint">${esc(msg(choice.kind === 'plans' ? 'statement.fields.plansHint' : 'statement.fields.movementsHint'))}</p>`
            : ''
        }
      </section>`;
  }

  $('#statement-tables').addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const index = Number(target.dataset.use ?? target.dataset.table);
    if (target.dataset.use !== undefined) {
      if ((target as HTMLInputElement).checked) state.choices.set(index, newChoice(index));
      else state.choices.delete(index);
    } else {
      const choice = state.choices.get(index);
      if (!choice) return;
      if (target.dataset.kind !== undefined) choice.kind = target.value as TableKind;
      else if (target.dataset.dateFormat !== undefined) choice.dateFormat = Number(target.value);
      else if (target.dataset.last4 !== undefined) choice.last4 = target.value.replace(/\D/g, '').slice(0, 4);
      else if (target.dataset.field) {
        const columns = (choice.kind === 'plans' ? choice.planColumns : choice.movementColumns) as Record<string, number>;
        columns[target.dataset.field] = Number(target.value);
      }
    }
    $('#statement-review').hidden = true;
    $('#statement-result').hidden = true;
    renderTables();
    root.querySelector<HTMLElement>(`[data-use="${index}"]`)?.focus();
  });

  // ── 3. Revisión: completar lo ilegible, periodo y totales ────────────────────────────────────
  $('#statement-tables').addEventListener('click', (event) => {
    if ((event.target as HTMLElement).id !== 'statement-continue') return;
    showError(null);
    state.drafts = [];
    state.plans = [];
    state.unreadablePlans = 0;
    for (const [index, choice] of [...state.choices].sort((a, b) => a[0] - b[0])) {
      const table = state.tables[index]!;
      const columns = choice.kind === 'plans' ? choice.planColumns : choice.movementColumns;
      if (columns.date < 0) return showError(msg('statement.error.dateColumn', { table: table.title ?? msg('statement.tables.untitled') }));
      if (choice.kind === 'plans') {
        for (const row of table.rows) {
          const plan = planRow(row, choice.planColumns, choice.dateFormat);
          if (plan) state.plans.push(plan);
          else state.unreadablePlans++;
        }
      } else {
        const last4 = /^\d{4}$/.test(choice.last4) ? choice.last4 : null;
        const { format, locale } = DATE_FORMATS[choice.dateFormat]!;
        for (const row of table.rows) {
          const postedDate = choice.movementColumns.postedDate >= 0 ? parseDate(row[choice.movementColumns.postedDate] ?? '', format, locale) : null;
          state.drafts.push({ table: index, draft: draftMovement(row, choice.movementColumns, choice.dateFormat, last4), postedDate, last4, include: true });
        }
      }
    }
    // El periodo empieza con la primera fecha de cargo (una compra de antes del corte anterior puede cargarse en este).
    const dates = state.drafts.map((d) => d.postedDate ?? d.draft.date).filter(Boolean).sort();
    const labeled = (label: RegExp) => {
      const raw = labeledDate(state.items, label);
      if (!raw) return '';
      const f = DATE_FORMATS[guessDateFormat([raw])]!;
      return parseDate(raw, f.format, f.locale) ?? '';
    };
    const cutoff = labeled(/corte|statement date|closing date/i);
    state.period = { start: dates[0] ?? '', cutoff: cutoff || (dates[dates.length - 1] ?? ''), dueDate: labeled(/l[ií]mite de pago|due date/i) };
    renderReview();
    $('#statement-review').scrollIntoView({ block: 'start' });
  });

  const included = () => state.drafts.filter((d) => d.include);
  const sums = () => included().reduce((s, d) => ({ charges: s.charges + (d.draft.value?.chargeMinor ?? 0), credits: s.credits + (d.draft.value?.creditMinor ?? 0) }), { charges: 0, credits: 0 });

  function renderReview() {
    const box = $('#statement-review');
    box.hidden = false;
    const incomplete = state.drafts.map((d, i) => ({ d, i })).filter(({ d }) => !d.draft.value);
    box.innerHTML = `
      <section class="card">
        <h2>${esc(msg('statement.review.title'))}</h2>
        <p>${esc(msg('statement.review.summary', { movements: state.drafts.length - incomplete.length, plans: state.plans.length }))}</p>
        ${state.unreadablePlans ? `<p class="alert">${esc(msg('statement.review.unreadablePlans', { n: state.unreadablePlans }))}</p>` : ''}
        <div class="form-grid">
          <div class="field narrow"><label>${esc(msg('statement.period.start'))}<input type="date" data-period="start" value="${state.period.start}" /></label></div>
          <div class="field narrow"><label>${esc(msg('statement.period.cutoff'))}<input type="date" data-period="cutoff" value="${state.period.cutoff}" /></label></div>
          <div class="field narrow"><label>${esc(msg('statement.period.dueDate'))}<input type="date" data-period="dueDate" value="${state.period.dueDate}" /></label></div>
        </div>
      </section>
      ${
        incomplete.length
          ? `<section class="card"><h2>${esc(msg('statement.incomplete.title', { n: incomplete.length }))}</h2><p class="hint">${esc(msg('statement.incomplete.hint'))}</p>
            ${incomplete.map(({ d, i }) => `
              <fieldset class="form-grid statement-fill" data-row="${i}">
                <legend>${esc(msg('statement.incomplete.row', { table: state.tables[d.table]!.title ?? msg('statement.tables.untitled'), cells: state.tables[d.table]!.rows[state.drafts.filter((x) => x.table === d.table).indexOf(d)]!.filter(Boolean).join(' · ') }))}</legend>
                <div class="field narrow"><label>${esc(msg('statement.field.date'))}<input type="date" data-fill="date" value="${d.draft.date}" /></label></div>
                <div class="field"><label>${esc(msg('statement.field.description'))}<input data-fill="description" maxlength="200" value="${esc(d.draft.description)}" /></label></div>
                <div class="field narrow"><label>${esc(msg('statement.field.amount'))}<input data-fill="amount" inputmode="decimal" value="${esc(d.draft.amount)}" /></label></div>
                <div class="field narrow"><label>${esc(msg('statement.fill.kind'))}<select data-fill="isCredit"><option value="0" ${d.draft.isCredit ? '' : 'selected'}>${esc(msg('statement.fill.charge'))}</option><option value="1" ${d.draft.isCredit ? 'selected' : ''}>${esc(msg('statement.fill.credit'))}</option></select></label></div>
                <label class="check"><input type="checkbox" data-fill="include" ${d.include ? 'checked' : ''} />${esc(msg('statement.fill.include'))}</label>
              </fieldset>`).join('')}
          </section>`
          : ''
      }
      <section class="card">
        <h2>${esc(msg('statement.totals.title'))}</h2>
        <p class="hint">${esc(msg('statement.totals.hint'))}</p>
        <div class="form-grid">
          <div class="field narrow"><label>${esc(msg('statement.totals.charges'))}<input data-total="charges" inputmode="decimal" value="${esc(state.totals.charges)}" /></label></div>
          <div class="field narrow"><label>${esc(msg('statement.totals.credits'))}<input data-total="credits" inputmode="decimal" value="${esc(state.totals.credits)}" /></label></div>
        </div>
        <p id="statement-sums" aria-live="polite"></p>
        <div class="form-actions"><button type="button" class="btn" id="statement-compare">${esc(msg('statement.compare'))}</button></div>
      </section>`;
    renderSums();
  }

  function renderSums() {
    const { charges, credits } = sums();
    const typed = { charges: toMinor(state.totals.charges), credits: toMinor(state.totals.credits) };
    const line = (key: 'charges' | 'credits', read: number) =>
      typed[key] === null ? msg(`statement.sums.${key}`, { amount: money(read) }) : msg(typed[key] === read ? 'statement.sums.ok' : 'statement.sums.off', { what: msg(`statement.totals.${key}`), read: money(read), printed: money(typed[key]!) });
    $('#statement-sums').innerHTML = [line('charges', charges), line('credits', credits)].map((text) => esc(text)).join('<br />');
  }

  $('#statement-review').addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target.dataset.period) state.period[target.dataset.period as keyof typeof state.period] = target.value;
    else if (target.dataset.total) state.totals[target.dataset.total as 'charges' | 'credits'] = target.value;
    else if (target.dataset.fill) {
      const row = state.drafts[Number(target.closest<HTMLElement>('[data-row]')!.dataset.row)]!;
      const field = target.dataset.fill;
      if (field === 'include') row.include = (target as HTMLInputElement).checked;
      else if (field === 'isCredit') row.draft = { ...row.draft, isCredit: target.value === '1' };
      else row.draft = { ...row.draft, [field]: target.value };
      row.draft = finishMovement(row.draft, row.postedDate, row.last4);
    }
    $('#statement-result').hidden = true;
    setImportStep(2);
    renderSums();
  });

  // ── 4. Comparar contra Don Bigo (no se guarda nada) ──────────────────────────────────────────
  $('#statement-review').addEventListener('click', async (event) => {
    const button = event.target as HTMLButtonElement;
    if (button.id !== 'statement-compare') return;
    showError(null);
    const rows = included();
    if (rows.some((d) => !d.draft.value)) return showError(msg('statement.error.incomplete'));
    if (!state.period.start || !state.period.cutoff || state.period.start > state.period.cutoff) return showError(msg('statement.error.period'));
    const typed = { chargesMinor: toMinor(state.totals.charges), creditsMinor: toMinor(state.totals.credits) };
    const totals = typed.chargesMinor !== null && typed.creditsMinor !== null ? typed : null;
    button.disabled = true;
    try {
      sent = { accountId: account().id, period: { ...state.period, dueDate: state.period.dueDate || null }, totals, movements: rows.map((d) => d.draft.value), plans: state.plans };
      const response = await fetch('/api/statements/compare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sent) });
      if (!response.ok) return showError(msg('common.error'));
      const { comparison, currency, missingIndexes } = (await response.json()) as { comparison: StatementComparison; currency: string; missingIndexes: number[] };
      renderResult(comparison, currency, missingIndexes);
    } catch {
      showError(msg('common.error'));
    } finally {
      button.disabled = false;
    }
  });

  /** Lo último que se comparó: el guardado manda exactamente lo mismo y el servidor vuelve a comparar. */
  let sent: Record<string, unknown> | null = null;

  function renderResult(c: StatementComparison, currency: string, missingIndexes: number[]) {
    const box = $('#statement-result');
    box.hidden = false;
    const fmt = (minor: number) => formatMinor(minor, currency, config.locale);
    const amount = (m: { chargeMinor: number; creditMinor: number }) => (m.creditMinor ? `−${fmt(m.creditMinor)}` : fmt(m.chargeMinor));
    const kind = (m: { creditMinor: number }) => `<span class="badge ${m.creditMinor ? 'badge-good' : 'badge-muted'}">${esc(msg(m.creditMinor ? 'statement.fill.credit' : 'statement.fill.charge'))}</span>`;
    /** Cuántos cargos y abonos hay en un grupo y cuánto suman, para leer la diferencia de un vistazo. */
    const tally = (items: { chargeMinor: number; creditMinor: number }[]) => {
      const charges = items.filter((m) => !m.creditMinor);
      const credits = items.filter((m) => m.creditMinor);
      return msg('statement.result.tally', { charges: charges.length, chargesAmount: fmt(charges.reduce((t, m) => t + m.chargeMinor, 0)), credits: credits.length, creditsAmount: fmt(credits.reduce((t, m) => t + m.creditMinor, 0)) });
    };
    const list = (title: string, items: string[], head: string[], note = '') =>
      items.length
        ? `<h3>${esc(title)} (${items.length})</h3>${note ? `<p class="hint">${esc(note)}</p>` : ''}
          <div class="table-scroll"><table class="import-table statement-diff"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${items.map((i) => `<tr>${i}</tr>`).join('')}</tbody></table></div>`
        : '';
    const cells = (...values: string[]) => values.map((v) => `<td>${v}</td>`).join('');
    const movementHead = [msg('statement.field.date'), msg('statement.field.description'), msg('statement.fill.kind'), msg('statement.field.amount')];
    const movementCells = (m: { date: string; description: string; chargeMinor: number; creditMinor: number }) => cells(esc(m.date), `<strong>${esc(m.description)}</strong>`, kind(m), `<span class="num">${esc(amount(m))}</span>`);
    const differences = c.missing.length + c.changed.length + c.extra.length + c.plans.differs.length + c.plans.missing.length;
    const legend: [StatementTile, string][] = (['matched', 'missing', 'changed', 'planDiffers', 'planMissing', 'extra'] as const).map((k) => [k, msg(`statement.mosaic.${k}`)]);
    setImportStep(3);
    box.innerHTML = `
      <section class="card">
        <div class="mosaic-head">
          <div><h2>${esc(msg('statement.mosaic.title'))}</h2><p class="hint">${esc(msg('statement.mosaic.hint'))}</p></div>
          <strong>${esc(msg('statement.mosaic.count', { n: differences }))}</strong>
        </div>
        ${mosaicHtml(statementTiles(c), legend)}
      </section>
      <section class="card">
        <h2>${esc(msg('statement.result.title'))}</h2>
        ${c.totalsOk === false ? `<p class="alert">${esc(msg('statement.result.totalsOff'))}</p>` : c.totalsOk ? `<p class="alert ok">${esc(msg('statement.result.totalsOk'))}</p>` : ''}
        ${c.cutoffDiffers ? `<p class="alert">${esc(msg('statement.result.cutoffDiffers'))}</p>` : ''}
        <p>${esc(msg('statement.result.summary', { matched: c.matched.length, plans: c.plans.matched.length, differences }))}</p>
        ${list(msg('statement.result.missing'), c.missing.map((m, i) => cells(`<label class="check"><input type="checkbox" data-pick="${missingIndexes[i]}" checked /><span class="sr-only">${esc(msg('statement.save.pick'))}</span></label>`) + movementCells(m)), [msg('statement.result.add'), ...movementHead], `${msg('statement.result.missingHint')} ${tally(c.missing)}`)}
        ${list(msg('statement.result.changed'), c.changed.map((p) => cells(esc(p.statement.date), `<strong>${esc(p.statement.description)}</strong>`, kind(p.statement), `<span class="num">${esc(amount(p.statement))}</span>`, `<span class="num">${esc(amount(p.existing))}</span>`)), [msg('statement.field.date'), msg('statement.field.description'), msg('statement.fill.kind'), msg('statement.result.bank'), msg('statement.result.app')])}
        ${list(msg('statement.result.extra'), c.extra.map((m) => movementCells(m) + cells(esc(m.last4 ? `···· ${m.last4}` : '—'))), [...movementHead, msg('statement.result.card')], `${msg('statement.result.extraHint')} ${tally(c.extra)}`)}
        ${list(msg('statement.result.plansDiffer'), c.plans.differs.map((d) => {
          const bankAmount = d.row.paymentMinor - d.row.interestMinor;
          const parts = [
            d.paidInstallments !== d.row.current ? msg('statement.result.planNumbers', { bank: `${d.row.current}/${d.row.total}`, app: `${d.paidInstallments}/${d.row.total}` }) : '',
            Math.abs(d.installmentAmountMinor - bankAmount) > 2 ? msg('statement.result.planAmounts', { bank: formatMinor(bankAmount, currency, config.locale), app: formatMinor(d.installmentAmountMinor, currency, config.locale) }) : '',
          ];
          return cells(esc(d.row.date), `<strong>${esc(d.planName)}</strong>`, esc(parts.filter(Boolean).join(' · ')));
        }), [msg('statement.field.date'), msg('statement.result.plan'), msg('statement.result.detail')])}
        ${list(msg('statement.result.plansMissing'), c.plans.missing.map((r) => cells(esc(r.date), `<strong>${esc(r.description)}</strong>`, esc(`${r.current}/${r.total}`), `<span class="num">${esc(fmt(r.pendingMinor))}</span>`)), [msg('statement.field.date'), msg('statement.field.description'), msg('statement.result.payment'), msg('statement.result.pending')], msg('statement.result.plansMissingHint'))}
        ${differences === 0 ? `<p class="alert ok">${esc(msg('statement.result.none'))}</p>` : ''}
      </section>
      ${saveCard(c)}`;
    box.scrollIntoView({ block: 'start' });
  }

  // ── 5. Guardar lo aprobado: faltantes, corte y saldos de planes ──────────────────────────────
  function saveCard(c: StatementComparison): string {
    const plans = c.plans.matched.length + c.plans.differs.length;
    if (c.missing.length === 0 && plans === 0 && c.cutoffDiffers === false) return '';
    return `
      <section class="card" id="statement-save-card">
        <h2>${esc(msg('statement.save.title'))}</h2>
        <p class="hint">${esc(msg('statement.save.hint'))}</p>
        ${c.missing.length ? `<p>${esc(msg('statement.save.movements', { n: c.missing.length }))}</p>` : ''}
        ${c.cutoffDiffers !== false ? `<label class="check"><input type="checkbox" id="statement-save-cutoff" checked />${esc(msg('statement.save.cutoff'))}</label>` : ''}
        ${plans ? `<label class="check"><input type="checkbox" id="statement-save-plans" checked />${esc(msg('statement.save.plans', { n: plans }))}</label>` : ''}
        ${c.changed.length + c.extra.length + c.plans.missing.length ? `<p class="hint">${esc(msg('statement.save.manual'))}</p>` : ''}
        <div class="form-actions"><button type="button" class="btn" id="statement-save">${esc(msg('statement.save.button'))}</button></div>
      </section>`;
  }

  $('#statement-result').addEventListener('click', async (event) => {
    const button = event.target as HTMLButtonElement;
    if (button.id !== 'statement-save' || !sent) return;
    showError(null);
    const checked = (selector: string) => root.querySelector<HTMLInputElement>(selector)?.checked === true;
    const picks = [...root.querySelectorAll<HTMLInputElement>('[data-pick]')].filter((box) => box.checked).map((box) => Number(box.dataset.pick));
    const apply = { movements: picks, cutoff: checked('#statement-save-cutoff'), planBalances: checked('#statement-save-plans') };
    if (!picks.length && !apply.cutoff && !apply.planBalances) return showError(msg('statement.save.nothing'));
    button.disabled = true;
    try {
      const response = await fetch('/api/statements/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...sent, fileName: fileInput.files?.[0]?.name ?? '', apply }),
      });
      const data = (await response.json().catch(() => null)) as { code?: string; movements?: number; categorized?: number; cutoff?: boolean; planBalances?: number } | null;
      if (!response.ok) {
        button.disabled = false;
        return showError(msg(data?.code === 'NOT_MISSING' ? 'statement.save.stale' : 'common.error'));
      }
      // Ya guardado: las tablas y la comparación dejan de ser editables, así que se ocultan y solo queda el resultado.
      $('#statement-tables').hidden = true;
      $('#statement-review').hidden = true;
      root.querySelectorAll<HTMLElement>('#statement-result > section:not(#statement-save-card)').forEach((section) => (section.hidden = true));
      setImportStep(4);
      const done = data!;
      $('#statement-save-card').innerHTML = doneHtml({
        title: msg('statement.done.heading'),
        results: [
          ...(done.movements ? ([[done.movements, msg('statement.done.n.movements')]] as [number, string][]) : []),
          ...(done.categorized ? ([[done.categorized, msg('statement.done.n.categorized')]] as [number, string][]) : []),
          ...(done.planBalances ? ([[done.planBalances, msg('statement.done.n.plans')]] as [number, string][]) : []),
        ],
        note: done.cutoff ? `<p class="hint">${esc(msg('statement.save.doneCutoff'))}</p>` : '',
        actions: `${done.movements ? `<a class="btn" href="/app/importar/historial">${esc(msg('statement.save.history'))}</a>` : ''}
          <a class="btn btn-ghost" href="/app/importar/pdf?cuenta=${encodeURIComponent(account().id)}">${esc(msg('statement.save.again'))}</a>`,
        undo: esc(msg('statement.done.undo')),
      });
      $('#statement-save-card').scrollIntoView({ block: 'start' });
    } catch {
      button.disabled = false;
      showError(msg('common.error'));
    }
  });
}
