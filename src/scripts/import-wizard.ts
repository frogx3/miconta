import type { PreviewMovement, PreviewResult } from '../lib/import/service';
import type { ImportField, ImportProfile } from '../lib/import/types';
import { formatMinor } from '../lib/money-format';

interface Config {
  locale: string;
  initialAccount: string | null;
  accounts: { id: string; name: string; currency: string; mixedCurrencies: boolean }[];
  messages: Record<string, string>;
}

/** Campos de un plan en construcción; son los textos que se envían tal cual al servidor. */
interface Draft {
  movementKey: string;
  type: 'msi' | 'mci' | 'fixed';
  name: string;
  matchText: string;
  installmentAmount: string;
  currentInstallment: string;
  totalInstallments: string;
  totalAmount: string;
  interestRate: string;
}

const root = document.querySelector<HTMLElement>('#import-app');
if (root) start(root);

function start(root: HTMLElement) {
  const config = JSON.parse(root.dataset.config!) as Config;
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const msg = (key: string, params?: Record<string, string | number>) => {
    const template = config.messages[key] ?? key;
    return params ? template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`)) : template;
  };
  const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const state = {
    file: null as { name: string; text: string } | null,
    accountId: config.initialAccount ?? '',
    preview: null as PreviewResult | null,
    profile: null as ImportProfile | null,
    drafts: new Map<string, Draft>(),
    openForm: null as string | null,
    confirmed: new Set<string>(),
    filter: 'all' as 'all' | 'hints',
    cutoff: '',
    ignoreErrors: false,
    createCards: true,
  };

  const currency = () => config.accounts.find((account) => account.id === state.accountId)?.currency ?? 'MXN';
  const money = (minor: number) => formatMinor(minor, currency(), config.locale);

  async function post<T>(url: string, body: unknown): Promise<{ status: number; data: T }> {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: (await response.json().catch(() => ({}))) as T };
  }

  function showError(box: HTMLElement, text: string | null) {
    box.textContent = text ?? '';
    box.hidden = text === null;
  }

  async function readFile(file: File): Promise<string> {
    const bytes = await file.arrayBuffer();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes); // CSV exportados desde Excel/Windows
    }
  }

  // ── Paso 1: subir y analizar ──────────────────────────────────────────────────────────────────

  $('#account').addEventListener('change', (event) => {
    state.accountId = (event.target as HTMLSelectElement).value;
  });

  $<HTMLFormElement>('#upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = $('#upload-error');
    showError(errorBox, null);
    const file = $<HTMLInputElement>('#file').files?.[0];
    if (!file) return showError(errorBox, msg('validation.required'));

    const button = $<HTMLButtonElement>('#upload-form button');
    button.disabled = true;
    button.textContent = msg('import.analyzing');
    try {
      state.file = { name: file.name, text: await readFile(file) };
    } catch {
      showError(errorBox, msg('import.error.read'));
      button.disabled = false;
      button.textContent = msg('import.analyze');
      return;
    }
    state.drafts.clear();
    state.confirmed.clear();
    state.openForm = null;
    await runPreview(null, errorBox);
    button.disabled = false;
    button.textContent = msg('import.analyze');
  });

  async function runPreview(profile: ImportProfile | null, errorBox: HTMLElement) {
    const { status, data } = await post<{ preview?: PreviewResult; code?: string }>('/api/import/preview', {
      accountId: state.accountId,
      text: state.file!.text,
      profile,
    });
    if (!data.preview) {
      showError(errorBox, status === 413 ? msg('import.error.fileTooLarge') : msg('common.error'));
      return;
    }
    showError(errorBox, null);
    state.preview = data.preview;
    state.profile = structuredClone(data.preview.profile);
    // Si el mapeo cambió, las llaves de los movimientos pueden haber cambiado: se conservan solo los planes que siguen vigentes.
    const live = new Set(data.preview.movements.filter((m) => m.status === 'new').map((m) => m.key));
    for (const key of [...state.drafts.keys()]) if (!live.has(key)) state.drafts.delete(key);
    state.confirmed = new Set(data.preview.planMatches.map((m) => `${m.planId}|${m.movementKey}`));
    state.cutoff = state.cutoff || data.preview.cutoffSuggestion || '';
    state.filter = data.preview.movements.some((m) => m.status === 'new' && m.hints.length > 0) ? 'hints' : 'all';
    state.createCards = true;
    state.ignoreErrors = false;
    renderAll();
  }

  // ── Paso 2: revisar ───────────────────────────────────────────────────────────────────────────

  function renderAll() {
    const preview = state.preview!;
    $('#step-review').hidden = false;
    $('#step-done').hidden = true;
    renderSummary(preview);
    renderMapping(preview);
    renderMatches(preview);
    renderMissing(preview);
    renderMovements(preview);
    renderConfirm(preview);
  }

  function renderSummary(preview: PreviewResult) {
    const notice = preview.headerChanged ? 'import.profile.changed' : `import.profile.${preview.profileSource}`;
    const { total, fresh, duplicates, errors } = preview.summary;
    $('#summary').innerHTML = `
      <p class="hint">${esc(state.file!.name)} · ${esc(msg(notice))}</p>
      <div class="chips">
        <span class="chip">${esc(msg('import.summary.total', { n: total }))}</span>
        <span class="chip chip-ok">${esc(msg('import.summary.fresh', { n: fresh }))}</span>
        ${duplicates ? `<span class="chip">${esc(msg('import.summary.duplicates', { n: duplicates }))}</span>` : ''}
        ${errors ? `<span class="chip chip-bad">${esc(msg('import.summary.errors', { n: errors }))}</span>` : ''}
      </div>`;
  }

  // Mapeo de columnas
  const FIELDS: ImportField[] = ['date', 'description', 'charge', 'credit', 'amount', 'reference', 'card'];
  const REQUIRED = new Set<ImportField>(['date', 'description']);
  const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY', 'DD-MMM-YYYY', 'DD/MM/YY', 'D MMM YYYY'];

  function renderMapping(preview: PreviewResult) {
    const profile = state.profile!;
    const options = (selected: string | undefined) =>
      `<option value="">${esc(msg('import.mapping.none'))}</option>` +
      preview.headers.map((h) => `<option value="${esc(h)}"${h === selected ? ' selected' : ''}>${esc(h)}</option>`).join('');
    const select = (name: string, items: [string, string][], current: string) =>
      `<select data-profile="${name}">${items.map(([v, label]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    const formats = DATE_FORMATS.includes(profile.dateFormat) ? DATE_FORMATS : [profile.dateFormat, ...DATE_FORMATS];

    const missing = preview.missingFields.length ? `<div class="alert">${esc(msg('import.mapping.missing', { fields: preview.missingFields.map((f) => msg(`import.field.${f}`)).join(', ') }))}</div>` : '';
    const sample = preview.sampleRows.length
      ? `<details class="sample"><summary>${esc(msg('import.mapping.sample'))}</summary><div class="table-scroll"><table class="import-table"><thead><tr>${preview.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${preview.sampleRows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`
      : '';

    $('#mapping-card').innerHTML = `
      <details id="mapping" ${preview.needsMapping ? 'open' : ''}>
        <summary><h2 class="inline">${esc(msg('import.mapping.title'))}</h2></summary>
        ${missing}
        <div class="form-grid">
          ${FIELDS.map(
            (field) => `<div class="field"><label>${esc(msg(`import.field.${field}`))}${REQUIRED.has(field) ? ' *' : ''}</label>
              <select data-column="${field}">${options(profile.columns[field])}</select></div>`,
          ).join('')}
          <div class="field"><label>${esc(msg('import.mapping.dateFormat'))}</label>
            ${select('dateFormat', formats.map((f) => [f, f]), profile.dateFormat)}</div>
          <div class="field"><label>${esc(msg('import.mapping.dateLocale'))}</label>
            ${select('dateLocale', [['es', 'Español'], ['en', 'English']], profile.dateLocale)}</div>
          <div class="field"><label>${esc(msg('import.mapping.decimal'))}</label>
            ${select('decimalSeparator', [['.', '1,234.56'], [',', '1.234,56']], profile.decimalSeparator)}</div>
          <div class="field"><label>${esc(msg('import.mapping.thousands'))}</label>
            ${select('thousandsSeparator', [[',', ','], ['.', '.'], [' ', msg('import.mapping.thousandsSpace')], ['', msg('import.mapping.thousandsNone')]], profile.thousandsSeparator)}</div>
          <div class="field"><label>${esc(msg('import.mapping.delimiter'))}</label>
            ${select('delimiter', [['auto', msg('import.mapping.delimiterAuto')], [',', ','], [';', ';'], ['\t', msg('import.mapping.delimiterTab')]], profile.delimiter)}</div>
          <div class="field"><label>${esc(msg('import.mapping.skipRows'))}</label>
            <input type="number" min="0" max="20" data-profile="skipRows" value="${profile.skipRows}" /></div>
          <div class="field"><label>${esc(msg('import.mapping.referenceLabel'))}</label>
            <input type="text" maxlength="30" data-profile="referenceLabel" value="${esc(profile.referenceLabel ?? '')}" />
            <span class="hint">${esc(msg('import.mapping.referenceLabelHint'))}</span></div>
          <div class="field"><label>${esc(msg('import.mapping.convention'))}</label>
            ${select('amountConvention', [['positive_is_charge', msg('import.mapping.conventionPositive')], ['negative_is_charge', msg('import.mapping.conventionNegative')]], profile.amountConvention)}</div>
          <div class="form-actions"><button type="button" class="btn btn-ghost" id="apply-mapping">${esc(msg('import.mapping.apply'))}</button></div>
        </div>
        ${sample}
      </details>`;

    const card = $('#mapping-card');
    card.querySelectorAll<HTMLElement & { value: string }>('[data-column]').forEach((el) =>
      el.addEventListener('change', () => {
        const field = el.dataset.column as ImportField;
        if (el.value) profile.columns[field] = el.value;
        else delete profile.columns[field];
      }),
    );
    card.querySelectorAll<HTMLElement & { value: string }>('[data-profile]').forEach((el) =>
      el.addEventListener('change', () => {
        const name = el.dataset.profile!;
        const raw = el.value;
        const target = profile as unknown as Record<string, unknown>;
        target[name] = name === 'skipRows' ? Number(raw) : name === 'referenceLabel' ? raw.trim() || null : raw;
      }),
    );
    $('#apply-mapping').addEventListener('click', async () => {
      const button = $<HTMLButtonElement>('#apply-mapping');
      button.disabled = true;
      await runPreview(profile, $('#upload-error'));
    });
  }

  function renderMatches(preview: PreviewResult) {
    const box = $('#matches-card');
    box.hidden = preview.planMatches.length === 0;
    if (box.hidden) return;
    const byKey = new Map(preview.movements.map((m) => [m.key, m]));
    box.innerHTML = `
      <h2>${esc(msg('import.matches.title'))}</h2>
      <p class="hint">${esc(msg('import.matches.hint'))}</p>
      <ul class="check-list">
        ${preview.planMatches
          .map((match) => {
            const movement = byKey.get(match.movementKey)!;
            const id = `${match.planId}|${match.movementKey}`;
            return `<li><label class="check"><input type="checkbox" data-match="${esc(id)}" ${state.confirmed.has(id) ? 'checked' : ''} />
              <span><strong>${esc(msg('import.matches.item', { plan: match.planName, n: match.installmentNo, total: match.totalInstallments }))}</strong>
              ${match.isFinal ? `<span class="badge">${esc(msg('import.matches.final'))}</span>` : ''}<br />
              <span class="muted">${esc(movement.date)} · ${esc(movement.description)} · ${esc(money(movement.chargeMinor))}</span></span></label></li>`;
          })
          .join('')}
      </ul>`;
    box.querySelectorAll<HTMLInputElement>('[data-match]').forEach((el) =>
      el.addEventListener('change', () => {
        if (el.checked) state.confirmed.add(el.dataset.match!);
        else state.confirmed.delete(el.dataset.match!);
        renderConfirm(preview);
      }),
    );
  }

  function renderMissing(preview: PreviewResult) {
    const box = $('#missing-card');
    box.hidden = preview.missingInstallments.length === 0;
    if (box.hidden) return;
    box.innerHTML = `
      <h2>${esc(msg('import.missing.title'))}</h2>
      <ul>${preview.missingInstallments.map((m) => `<li>${esc(msg('import.missing.item', { plan: m.planName, n: m.installmentNo, date: m.expectedDate }))}</li>`).join('')}</ul>
      <p class="hint">${esc(msg('import.missing.hint'))}</p>`;
  }

  // Movimientos y planes nuevos
  const firstWords = (text: string, n: number) => text.split(/\s+/).slice(0, n).join(' ');

  function newDraft(movement: PreviewMovement): Draft {
    return {
      movementKey: movement.key,
      type: 'msi',
      name: movement.description.slice(0, 60),
      matchText: firstWords(movement.description, 4),
      installmentAmount: movement.chargeInput,
      currentInstallment: '1',
      totalInstallments: '12',
      totalAmount: '',
      interestRate: '',
    };
  }

  function renderMovements(preview: PreviewResult) {
    const fresh = preview.movements.filter((m) => m.status === 'new');
    const hinted = fresh.filter((m) => m.hints.length > 0).length;
    const shown = state.filter === 'hints' ? fresh.filter((m) => m.hints.length > 0 || state.drafts.has(m.key)) : fresh;
    const pills = hinted
      ? `<div class="chips">
           <button type="button" class="chip chip-button ${state.filter === 'all' ? 'is-on' : ''}" data-filter="all">${esc(msg('import.filter.all'))} (${fresh.length})</button>
           <button type="button" class="chip chip-button ${state.filter === 'hints' ? 'is-on' : ''}" data-filter="hints">${esc(msg('import.filter.hints'))} (${hinted})</button>
         </div>`
      : '';
    const hintBadges = (m: PreviewMovement) =>
      m.hints.map((h) => `<span class="badge">${esc(msg(h === 'installments_in_description' ? 'import.hint.installments' : 'import.hint.interest'))}</span>`).join(' ');

    const rows = shown
      .map((m) => {
        const draft = state.drafts.get(m.key);
        const amount = m.chargeMinor > 0 ? money(m.chargeMinor) : `<span class="credit">+${esc(money(m.creditMinor))}</span>`;
        const action =
          m.chargeMinor <= 0
            ? ''
            : draft
              ? `<span class="badge">${esc(msg('import.plan.badge', { name: draft.name, n: draft.currentInstallment, total: draft.totalInstallments }))}</span>
                 <button type="button" class="link-button" data-open="${esc(m.key)}">${esc(msg('import.plan.edit'))}</button>`
              : `<button type="button" class="btn btn-ghost btn-small" data-open="${esc(m.key)}">${esc(msg('import.plan.create'))}</button>`;
        const main = `<tr>
            <td class="nowrap">${esc(m.date)}</td>
            <td>${esc(m.description)}${m.reference ? `<br /><span class="muted">${esc(m.reference)}</span>` : ''} ${hintBadges(m)}</td>
            <td class="nowrap num">${amount}</td>
            <td class="nowrap">${m.cardLast4 ? `···· ${esc(m.cardLast4)}` : ''}</td>
            <td class="actions">${action}</td></tr>`;
        return state.openForm === m.key ? main + `<tr class="plan-form-row"><td colspan="5">${planForm(m, draft ?? newDraft(m))}</td></tr>` : main;
      })
      .join('');

    $('#movements-card').innerHTML = `
      <h2>${esc(msg('import.movements.title'))}</h2>
      <p class="hint">${esc(msg('import.movements.hint'))}</p>
      ${pills}
      <div class="table-scroll"><table class="import-table">
        <thead><tr><th>${esc(msg('import.col.date'))}</th><th>${esc(msg('import.col.description'))}</th><th>${esc(msg('import.col.amount'))}</th><th>${esc(msg('import.col.card'))}</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      ${preview.summary.duplicates ? `<p class="hint">${esc(msg('import.duplicates.note', { n: preview.summary.duplicates }))}</p>` : ''}`;

    const card = $('#movements-card');
    card.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((el) =>
      el.addEventListener('click', () => {
        state.filter = el.dataset.filter as 'all' | 'hints';
        renderMovements(preview);
      }),
    );
    card.querySelectorAll<HTMLElement>('[data-open]').forEach((el) =>
      el.addEventListener('click', () => {
        const key = el.dataset.open!;
        state.openForm = state.openForm === key ? null : key;
        renderMovements(preview);
      }),
    );
    bindPlanForm(preview);
  }

  function planForm(movement: PreviewMovement, draft: Draft): string {
    const input = (name: keyof Draft, label: string, extra = '', hint = '', attrs = '') =>
      `<div class="field"${extra}><label>${esc(msg(label))}</label><input data-plan="${name}" type="text" value="${esc(draft[name])}" ${attrs} />${hint ? `<span class="hint">${esc(msg(hint))}</span>` : ''}</div>`;
    return `<form class="plan-form form-grid" data-key="${esc(movement.key)}" novalidate>
      <div class="field"><label>${esc(msg('import.plan.type'))}</label>
        <select data-plan="type">${(['msi', 'mci', 'fixed'] as const).map((t) => `<option value="${t}"${t === draft.type ? ' selected' : ''}>${esc(msg(`import.plan.type.${t}`))}</option>`).join('')}</select></div>
      ${input('name', 'import.plan.name', '', '', 'maxlength="80"')}
      ${input('matchText', 'import.plan.matchText', '', 'import.plan.matchTextHint', 'maxlength="120"')}
      ${input('installmentAmount', 'import.plan.installment', '', '', 'inputmode="decimal"')}
      ${input('currentInstallment', 'import.plan.current', '', 'import.plan.currentHint', 'inputmode="numeric"')}
      ${input('totalInstallments', 'import.plan.total', '', '', 'inputmode="numeric"')}
      ${input('totalAmount', 'import.plan.totalAmount', '', 'import.plan.totalAmountHint', 'inputmode="decimal"')}
      <div class="field" data-rate${draft.type === 'msi' ? ' hidden' : ''}><label>${esc(msg('import.plan.rate'))}</label>
        <input data-plan="interestRate" type="text" inputmode="decimal" value="${esc(draft.interestRate)}" /></div>
      <div class="form-actions row-actions">
        <button type="submit" class="btn btn-small">${esc(msg('import.plan.save'))}</button>
        <button type="button" class="btn btn-ghost btn-small" data-cancel>${esc(msg('common.cancel'))}</button>
        ${state.drafts.has(movement.key) ? `<button type="button" class="link-button" data-remove-plan>${esc(msg('import.plan.remove'))}</button>` : ''}
      </div></form>`;
  }

  function bindPlanForm(preview: PreviewResult) {
    const form = root.querySelector<HTMLFormElement>('.plan-form');
    if (!form) return;
    const key = form.dataset.key!;
    const read = (): Draft => {
      const draft = { ...newDraft(preview.movements.find((m) => m.key === key)!) } as Draft;
      form.querySelectorAll<HTMLElement & { value: string }>('[data-plan]').forEach((el) => {
        (draft as unknown as Record<string, string>)[el.dataset.plan!] = el.value;
      });
      return draft;
    };
    form.querySelector<HTMLElement & { value: string }>('[data-plan="type"]')!.addEventListener('change', (event) => {
      form.querySelector<HTMLElement>('[data-rate]')!.hidden = (event.target as HTMLSelectElement).value === 'msi';
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const draft = read();
      const total = Number(draft.totalInstallments);
      const current = Number(draft.currentInstallment);
      const invalid =
        !draft.name.trim() || !draft.matchText.trim() || !draft.installmentAmount.trim() || !Number.isInteger(total) || !Number.isInteger(current) || total < 2 || current < 1 || current > total;
      if (invalid) {
        form.querySelectorAll<HTMLInputElement>('[data-plan]').forEach((el) => el.setAttribute('aria-invalid', String(!el.value.trim())));
        return;
      }
      state.drafts.set(key, draft);
      state.openForm = null;
      renderMovements(preview);
      renderConfirm(preview);
    });
    form.querySelector('[data-cancel]')!.addEventListener('click', () => {
      state.openForm = null;
      renderMovements(preview);
    });
    form.querySelector('[data-remove-plan]')?.addEventListener('click', () => {
      state.drafts.delete(key);
      state.openForm = null;
      renderMovements(preview);
      renderConfirm(preview);
    });
  }

  // ── Paso 3: confirmar ─────────────────────────────────────────────────────────────────────────

  function renderConfirm(preview: PreviewResult) {
    const newCards = preview.cards.filter((c) => !c.exists);
    const counts = { movements: preview.summary.fresh, plans: state.drafts.size, linked: state.confirmed.size };
    const blockedByErrors = preview.errors.length > 0 && !state.ignoreErrors;
    const canImport = counts.movements > 0 && preview.missingFields.length === 0 && !blockedByErrors && !preview.mixedCurrencies;

    $('#confirm-card').innerHTML = `
      <h2>${esc(msg('import.confirm.title'))}</h2>
      <div id="confirm-error" class="alert" role="alert" hidden></div>
      ${preview.mixedCurrencies ? `<div class="alert">${esc(msg('import.error.mixedCurrencies'))}</div>` : ''}
      ${
        preview.errors.length
          ? `<div class="alert"><strong>${esc(msg('import.errors.title'))}</strong><ul>${preview.errors
              .slice(0, 10)
              .map((e) => `<li>${esc(msg('import.errors.line', { line: e.line, message: e.message }))}</li>`)
              .join('')}</ul>
            <label class="check"><input type="checkbox" id="ignore-errors" ${state.ignoreErrors ? 'checked' : ''} /><span>${esc(msg('import.errors.ignore'))}</span></label></div>`
          : ''
      }
      ${
        newCards.length
          ? `<label class="check"><input type="checkbox" id="create-cards" ${state.createCards ? 'checked' : ''} />
             <span>${esc(msg('import.cards.create'))}: ${esc(newCards.map((c) => `···· ${c.last4}`).join(', '))}</span></label>`
          : ''
      }
      <div class="field narrow"><label for="cutoff">${esc(msg('import.cutoff'))}</label>
        <input id="cutoff" type="date" value="${esc(state.cutoff)}" required />
        <span class="hint">${esc(msg('import.cutoff.hint'))}</span></div>
      <p>${esc(counts.movements ? msg('import.confirm.summary', counts) : msg('import.confirm.nothing'))}</p>
      <button type="button" class="btn btn-auto" id="do-import" ${canImport ? '' : 'disabled'}>${esc(msg('import.confirm.submit'))}</button>`;

    $<HTMLInputElement>('#cutoff').addEventListener('change', (event) => (state.cutoff = (event.target as HTMLInputElement).value));
    root.querySelector<HTMLInputElement>('#ignore-errors')?.addEventListener('change', (event) => {
      state.ignoreErrors = (event.target as HTMLInputElement).checked;
      renderConfirm(preview);
    });
    root.querySelector<HTMLInputElement>('#create-cards')?.addEventListener('change', (event) => (state.createCards = (event.target as HTMLInputElement).checked));
    $('#do-import').addEventListener('click', () => void importNow(preview));
  }

  const FIELD_KEY: Record<string, string> = { installmentAmount: 'import.plan.installment', currentInstallment: 'import.plan.current', totalInstallments: 'import.plan.total', totalAmount: 'import.plan.totalAmount', interestRate: 'import.plan.rate', name: 'import.plan.name', matchText: 'import.plan.matchText', type: 'import.plan.type' };

  async function importNow(preview: PreviewResult) {
    const errorBox = $('#confirm-error');
    showError(errorBox, null);
    if (!state.cutoff) return showError(errorBox, msg('import.error.cutoff'));

    const button = $<HTMLButtonElement>('#do-import');
    button.disabled = true;
    button.textContent = msg('import.confirm.working');
    const drafts = [...state.drafts.values()];
    const { status, data } = await post<{ batchId?: string; counts?: Record<string, number>; code?: string; details?: unknown }>('/api/import/apply', {
      accountId: state.accountId,
      text: state.file!.text,
      fileName: state.file!.name,
      profile: preview.profile,
      cutoffDate: state.cutoff,
      planDrafts: drafts,
      confirmedMatches: [...state.confirmed].map((id) => {
        const [planId, movementKey] = id.split('|');
        return { planId, movementKey };
      }),
      ignoreErrors: state.ignoreErrors,
      createMissingCards: state.createCards,
    });

    if (status === 201 && data.counts) return renderDone(data.counts);

    button.disabled = false;
    button.textContent = msg('import.confirm.submit');
    const code = data.code;
    if (code === 'INVALID_PLAN') {
      const first = (data.details as { index: number; errors: { field: string; code: string }[] | string }[])?.[0];
      const draft = first ? drafts[first.index] : undefined;
      const detail = Array.isArray(first?.errors)
        ? first.errors.map((e) => `${msg(FIELD_KEY[e.field] ?? 'import.plan.name')}: ${msg(`validation.${e.code}`)}`).join('; ')
        : first?.errors === 'card_required'
          ? msg('import.error.cardRequired')
          : msg('common.error');
      return showError(errorBox, msg('import.error.plan', { name: draft?.name ?? '', detail }));
    }
    const map: Record<string, string> = {
      NOTHING_TO_IMPORT: 'import.error.nothing',
      INVALID_CUTOFF: 'import.error.cutoff',
      ALREADY_IMPORTED: 'import.error.alreadyImported',
      ROW_ERRORS: 'import.error.rows',
      PARSE_PROBLEMS: 'import.error.parse',
      INVALID_MATCH: 'import.error.match',
      FILE_TOO_LARGE: 'import.error.fileTooLarge',
      MIXED_CURRENCIES: 'import.error.mixedCurrencies',
    };
    showError(errorBox, msg(map[code ?? ''] ?? 'common.error'));
  }

  function renderDone(counts: Record<string, number>) {
    $('#step-review').hidden = true;
    const done = $('#step-done');
    done.hidden = false;
    done.innerHTML = `
      <h2>${esc(msg('import.done.title'))}</h2>
      <p>${esc(msg('import.done.summary', { movements: counts.movements ?? 0, plans: counts.plansCreated ?? 0, linked: counts.installmentsLinked ?? 0, cards: counts.cardsCreated ?? 0 }))}</p>
      ${counts.categorized ? `<p class="hint">${esc(msg('import.done.categorized', { n: counts.categorized }))}</p>` : ''}
      <div class="row-actions">
        <a class="btn btn-link" href="/app/cuentas/${esc(state.accountId)}">${esc(msg('import.done.account'))}</a>
        <a href="/app/importar?cuenta=${esc(state.accountId)}">${esc(msg('import.done.again'))}</a>
        <a href="/app/importar/historial">${esc(msg('import.history'))}</a>
      </div>`;
    done.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
