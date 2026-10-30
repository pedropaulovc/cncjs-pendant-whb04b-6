import { validateMacroContent } from './macro-validation.js';

export const MACRO_BUTTONS = [
  { slot: '1', button: 'Feed+' }, { slot: '2', button: 'Feed-' },
  { slot: '5', button: 'M-Home' }, { slot: '6', button: 'Safe-Z' },
  { slot: '7', button: 'W-Home' }, { slot: '9', button: 'Probe-Z' },
  { slot: '11', button: 'Reset' }, { slot: '12', button: 'Stop' },
  { slot: '13', button: 'Start/Pause' }, { slot: '14', button: 'Macro-10' },
];

// Edits live in these controls until Save settings is pressed. Refreshing the
// server catalog replaces choices and previews, never the pending assignments.
export class MacroSettings {
  constructor({ container, status, refreshButton, onRefresh = () => {}, onChange = () => {} }) {
    Object.assign(this, { container, status, refreshButton, onRefresh, onChange });
    this.document = container.ownerDocument;
    this.catalog = new Map();
    this.macroNames = new Map();
    this.catalogState = 'unloaded';
    this.rows = new Map();
    container.replaceChildren();
    for (const definition of MACRO_BUTTONS) this.createRow(definition);
    refreshButton.addEventListener('click', () => this.onRefresh());
    this.setStatus('unloaded');
  }

  element(tag, text) {
    const element = this.document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  }

  createRow({ slot, button }) {
    const name = `Fn + ${button}`;
    const fieldset = this.element('fieldset');
    fieldset.className = 'macro-assignment';
    const legend = this.element('legend', name);
    const number = this.element('span', `Macro ${slot}`);
    number.className = 'macro-slot';
    legend.append(number);
    const choice = this.element('label');
    choice.className = 'macro-choice';
    choice.append(this.element('span', 'Action'));
    const select = this.element('select');
    select.id = `macro-${slot}-assignment`;
    select.setAttribute('aria-label', `Assignment for ${name}`);
    choice.append(select);
    const code = this.element('textarea');
    code.id = `macro-${slot}-code`;
    code.className = 'macro-code';
    code.rows = 4;
    code.maxLength = 2000;
    code.spellcheck = false;
    code.setAttribute('aria-label', `G-code for ${name}`);
    code.placeholder = 'Enter G-code, one command per line';
    const preview = this.element('pre');
    preview.className = 'macro-preview';
    preview.setAttribute('aria-label', `Saved G-code for ${name}`);
    const note = this.element('p');
    note.id = `macro-${slot}-note`;
    note.className = 'macro-note';
    select.setAttribute('aria-describedby', note.id);
    code.setAttribute('aria-describedby', note.id);
    fieldset.append(legend, choice, code, preview, note);
    this.container.append(fieldset);
    const row = { select, code, preview, note };
    this.rows.set(slot, row);
    this.updateOptions(row, 'disabled');
    select.addEventListener('change', () => { this.updateRow(row); this.onChange(); });
    code.addEventListener('input', () => { this.updateRow(row); this.onChange(); });
  }

  option(value, text) {
    const option = this.element('option', text);
    option.value = value;
    return option;
  }

  updateOptions(row, selection = row.select.value) {
    const options = [this.option('disabled', 'Disabled'), this.option('custom', 'Custom G-code')];
    if (this.catalog.size) {
      const group = this.element('optgroup');
      group.label = 'Saved CNCjs macros';
      for (const macro of this.catalog.values()) group.append(this.option(`cncjs:${macro.id}`, macro.name || '(Unnamed macro)'));
      options.push(group);
    }
    const id = selection.startsWith('cncjs:') ? selection.slice(6) : null;
    if (id !== null && !this.catalog.has(id)) {
      const name = this.macroNames.has(id) ? this.macroNames.get(id) || '(Unnamed macro)' : null;
      const suffix = this.catalogState === 'ready' ? 'unavailable' : 'awaiting refresh';
      const fallback = this.catalogState === 'ready' ? 'Unavailable saved macro' : 'Saved macro awaiting refresh';
      options.push(this.option(selection, name ? `${name} (${suffix})` : fallback));
    }
    row.select.replaceChildren(...options);
    row.select.value = selection;
    this.updateRow(row);
  }

  updateRow(row) {
    const selection = row.select.value;
    row.code.hidden = selection !== 'custom';
    row.preview.hidden = true;
    row.note.dataset.state = 'normal';
    if (selection === 'disabled') { row.note.textContent = 'This Fn combination has no macro assigned.'; return; }
    if (selection === 'custom') {
      row.note.textContent = 'Up to 2,000 characters. Save settings to apply your changes.';
      if (row.code.value.trim()) {
        try { validateMacroContent(row.code.value); }
        catch (error) { row.note.dataset.state = 'missing'; row.note.textContent = error.message; }
      }
      return;
    }
    const macro = this.catalog.get(selection.slice(6));
    if (!macro) {
      row.note.dataset.state = this.catalogState === 'ready' ? 'missing' : 'normal';
      row.note.textContent = this.catalogState === 'ready'
        ? 'This macro is no longer available in CNCjs. Choose another macro or disable this assignment.'
        : 'Refresh CNCjs macros to view this saved assignment.';
      return;
    }
    row.preview.textContent = macro.content || '(Empty macro)';
    row.preview.hidden = false;
    row.note.textContent = 'Linked to CNCjs. Edit its commands in the CNCjs Macro widget.';
    try { validateMacroContent(macro.content); }
    catch (error) { row.note.dataset.state = 'missing'; row.note.textContent = error.message; }
  }

  setAssignments(assignments) {
    for (const [slot, row] of this.rows) {
      const assignment = assignments?.[slot];
      if (assignment?.source === 'cncjs' && typeof assignment.name === 'string' && !this.catalog.has(assignment.id)) {
        this.macroNames.set(assignment.id, assignment.name);
      }
      row.code.value = typeof assignment === 'string' ? assignment : '';
      const selection = typeof assignment === 'string' && assignment.trim() ? 'custom'
        : assignment?.source === 'cncjs' ? `cncjs:${assignment.id}` : 'disabled';
      this.updateOptions(row, selection);
    }
  }

  getAssignments() {
    const assignments = {};
    for (const [slot, { select, code }] of this.rows) {
      if (select.value === 'custom' && code.value.trim()) assignments[slot] = code.value;
      if (select.value.startsWith('cncjs:')) {
        const id = select.value.slice(6);
        assignments[slot] = { source: 'cncjs', id };
        if (this.macroNames.has(id)) assignments[slot].name = this.macroNames.get(id);
      }
    }
    return assignments;
  }

  setCatalog(records) {
    this.catalog = new Map(records.map(record => [record.id, record]));
    for (const record of records) this.macroNames.set(record.id, record.name);
    this.catalogState = 'ready';
    for (const row of this.rows.values()) this.updateOptions(row);
  }

  setStatus(state, message) {
    const defaults = {
      unloaded: 'Connect to CNCjs to load its saved macros.',
      loading: 'Loading CNCjs macros…',
      ready: this.catalog.size ? `${this.catalog.size} saved CNCjs macro${this.catalog.size === 1 ? '' : 's'} available.`
        : 'No saved CNCjs macros yet. Create one in the CNCjs Macro widget, then refresh this list.',
      error: 'Could not load CNCjs macros. Check the connection and refresh to try again.',
    };
    this.status.textContent = message ?? defaults[state] ?? '';
    this.status.dataset.state = state;
    this.refreshButton.disabled = state === 'loading';
  }
}
