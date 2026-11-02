import { validateMacroContent } from './macro-validation.js';
import { MACRO_BUTTONS } from './pendant-controls.js';

// Every listed row is a persisted assignment: Disabled rows stay listed and
// never run; removing a row leaves its combination unassigned. Refreshing the
// server catalog replaces choices and previews, never the listed assignments.
export class MacroSettings {
  constructor({ container, status, refreshButton, addSelect, addButton, emptyState, onRefresh = () => {}, onChange = () => {} }) {
    Object.assign(this, { container, status, refreshButton, addSelect, addButton, emptyState, onRefresh, onChange });
    this.document = container.ownerDocument;
    this.catalog = new Map();
    this.macroNames = new Map();
    this.catalogState = 'unloaded';
    this.rows = new Map();
    container.replaceChildren();
    this.updateAvailableButtons();
    addButton.addEventListener('click', () => {
      const definition = MACRO_BUTTONS.find(({ slot }) => slot === addSelect.value);
      if (!definition || this.rows.has(definition.slot)) return;
      const row = this.createRow(definition);
      this.updateAvailableButtons();
      row.select.focus();
      this.onChange();
    });
    refreshButton.addEventListener('click', () => this.onRefresh());
    this.setStatus('unloaded');
  }

  element(tag, text) {
    const element = this.document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  }

  createRow({ slot, name }) {
    const fieldset = this.element('fieldset');
    fieldset.className = 'macro-assignment';
    const legend = this.element('legend', name);
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
    const remove = this.element('button', 'Remove macro');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove macro for ${name}`);
    remove.addEventListener('click', () => {
      this.rows.delete(slot);
      fieldset.remove();
      this.updateAvailableButtons();
      this.addSelect.focus();
      this.onChange();
    });
    fieldset.append(legend, choice, code, preview, note, remove);
    this.container.append(fieldset);
    const row = { name, select, code, preview, note };
    this.rows.set(slot, row);
    this.updateOptions(row, 'disabled');
    select.addEventListener('change', () => { this.updateRow(row); this.onChange(); });
    code.addEventListener('input', () => { this.updateRow(row); this.onChange(); });
    return row;
  }

  option(value, text) {
    const option = this.element('option', text);
    option.value = value;
    return option;
  }

  updateAvailableButtons() {
    const selected = this.addSelect.value;
    const available = MACRO_BUTTONS.filter(({ slot }) => !this.rows.has(slot));
    this.addSelect.replaceChildren(...available.map(({ slot, name }) => this.option(slot, name)));
    if (available.some(({ slot }) => slot === selected)) this.addSelect.value = selected;
    this.addSelect.disabled = available.length === 0;
    this.addButton.disabled = available.length === 0;
    this.emptyState.hidden = this.rows.size !== 0;
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

  // Custom G-code that cannot be saved yet; null when the row is savable.
  draftError(row) {
    if (row.select.value !== 'custom') return null;
    if (!row.code.value.trim()) return 'Enter G-code to save this assignment.';
    try { validateMacroContent(row.code.value); return null; }
    catch (error) { return error.message; }
  }

  updateRow(row) {
    const selection = row.select.value;
    row.code.hidden = selection !== 'custom';
    row.preview.hidden = true;
    row.note.dataset.state = 'normal';
    if (selection === 'disabled') { row.note.textContent = 'Disabled: pressing this combination runs nothing.'; return; }
    if (selection === 'custom') {
      const error = this.draftError(row);
      row.note.textContent = error ?? 'Up to 2,000 characters. Saved automatically.';
      if (error) row.note.dataset.state = 'missing';
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
    this.rows.clear();
    this.container.replaceChildren();
    for (const definition of MACRO_BUTTONS) {
      const assignment = assignments?.[definition.slot];
      const custom = typeof assignment === 'string' && assignment.trim();
      if (!custom && !['cncjs', 'disabled'].includes(assignment?.source)) continue;
      const row = this.createRow(definition);
      if (assignment?.source === 'cncjs' && typeof assignment.name === 'string' && !this.catalog.has(assignment.id)) {
        this.macroNames.set(assignment.id, assignment.name);
      }
      row.code.value = custom ? assignment : '';
      const selection = custom ? 'custom' : assignment.source === 'cncjs' ? `cncjs:${assignment.id}` : 'disabled';
      this.updateOptions(row, selection);
    }
    this.updateAvailableButtons();
  }

  // Throws for a custom draft that is empty or invalid, so it never replaces
  // the saved configuration.
  getAssignments() {
    const assignments = {};
    for (const [slot, row] of this.rows) {
      const { select, code } = row;
      const error = this.draftError(row);
      if (error) throw new Error(`${row.name}: ${error}`);
      if (select.value === 'disabled') assignments[slot] = { source: 'disabled' };
      if (select.value === 'custom') assignments[slot] = code.value;
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
