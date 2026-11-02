import { validateMacroContent } from './macro-validation.js';

// LinuxCNC xhc-whb04b-6 mappings, with GRBL's XYZ and realtime-command limits.
export const SELECTORS = {
  0x0d: { percent: 2, step: 0.001 }, 0x0e: { percent: 5, step: 0.01 },
  0x0f: { percent: 10, step: 0.1 }, 0x10: { percent: 30, step: 1 },
  0x1a: { percent: 60, step: 5 }, 0x1b: { percent: 100, step: 10 },
};
const AXES = { 0x11: 'X', 0x12: 'Y', 0x13: 'Z' };
const FN = 0x0c;
// Assignable Fn combinations: physical key code, persisted LinuxCNC macro slot
// (never renumbered), and the label printed on the key. Reset, Stop, and
// Start/Pause print no macro number; Fn+Spindle+/-, Fn+S on/off (printed
// Macro-3/4/8) keep their built-in spindle functions and are not assignable.
export const MACRO_BUTTONS = [
  { key: 0x04, slot: '1', button: 'Feed+', printed: 'Macro-1' }, { key: 0x05, slot: '2', button: 'Feed-', printed: 'Macro-2' },
  { key: 0x08, slot: '5', button: 'M-Home', printed: 'Macro-5' }, { key: 0x09, slot: '6', button: 'Safe-Z', printed: 'Macro-6' },
  { key: 0x0a, slot: '7', button: 'W-Home', printed: 'Macro-7' }, { key: 0x0d, slot: '9', button: 'Probe-Z', printed: 'Macro-9' },
  { key: 0x10, slot: '14', button: 'Macro-10', printed: 'Macro-10' },
  { key: 0x01, slot: '11', button: 'Reset' }, { key: 0x02, slot: '12', button: 'Stop' },
  { key: 0x03, slot: '13', button: 'Start/Pause' },
].map(({ printed, ...definition }) => ({ ...definition, name: printed ? `${printed} (Fn+${definition.button})` : `Fn+${definition.button}` }));
const MACROS = Object.fromEntries(MACRO_BUTTONS.map(definition => [definition.key, definition]));
const LEAD = new Set([0x1c, 0x9b]);
export const CONFIG_KEY = 'whb04b-controls';
// Probe plate thickness is always millimetres: Probe-Z selects G21 itself.
export const DEFAULT_CONFIG = { largeSteps: 'disabled', spindleIncrement: 100, probeThickness: 20, macros: {} };

export function parseConfig(value) {
  const config = Object.fromEntries(Object.entries(DEFAULT_CONFIG).map(([key, fallback]) => [key, value?.[key] === undefined ? fallback : value[key]]));
  if (!['enabled', 'disabled'].includes(config.largeSteps)) throw new Error('Large steps must be enabled or disabled.');
  if (!Number.isFinite(config.spindleIncrement) || config.spindleIncrement <= 0) throw new Error('Spindle increment must be positive RPM.');
  if (!Number.isFinite(config.probeThickness) || config.probeThickness < 0) throw new Error('Probe plate thickness must be a nonnegative number of millimetres.');
  if (!config.macros || typeof config.macros !== 'object' || Array.isArray(config.macros)) throw new Error('Macros must be an object keyed by macro number.');
  const allowed = new Set(MACRO_BUTTONS.map(({ slot }) => slot));
  for (const [number, code] of Object.entries(config.macros)) {
    const custom = typeof code === 'string' && code.length <= 2000;
    const saved = code?.source === 'cncjs' && typeof code.id === 'string' && code.id.trim().length > 0 && code.id.length <= 200;
    const disabled = code?.source === 'disabled';
    if (!allowed.has(number) || (!custom && !saved && !disabled)) throw new Error(`Invalid macro ${number}; choose disabled, custom G-code, or a saved CNCjs macro.`);
  }
  return config;
}

export class PendantControls {
  constructor(grbl, { log = () => {}, onMode = () => {}, onCoordinates = () => {}, onSavedMacro = () => {}, onSuspend = () => {},
    schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), now = () => performance.now(), config = DEFAULT_CONFIG } = {}) {
    Object.assign(this, { grbl, log, onMode, onCoordinates, onSavedMacro, onSuspend, schedule, cancel, now });
    this.config = parseConfig(config);
    this.mode = 'step';
    this.coordinates = 'work';
    this.keys = new Set();
    this.axisCode = null;
    this.rateCode = null;
    this.timer = null;
    this.lastPulse = -Infinity;
    this.direction = 0;
  }
  get readout() {
    const units = this.grbl.jogUnits;
    const unitLabel = units?.label ?? 'waiting for G20/G21';
    const selection = SELECTORS[this.rateCode];
    const mode = ['step', 'continuous'].includes(this.mode) ? `${this.mode} (${unitLabel})` : this.mode;
    const rate = this.mode === 'lead' ? 'Spindle override'
      : !selection ? '—'
      : this.mode === 'step' ? `${selection.step} ${units ? units.label : '(waiting for G20/G21)'}`
      : `${selection.percent}% feed`;
    const largeSteps = !units ? '5/10 steps (waiting for G20/G21)'
      : units.scale === 1 ? `5/10 ${units.label} steps`
      : `5/10 ${units.label} steps (${5 * units.scale}/${10 * units.scale} mm)`;
    return { mode, rate, largeSteps };
  }
  setConfig(config) { this.suspend(); this.config = parseConfig(config); }
  suspend() {
    this.onSuspend();
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.grbl.cancelJog();
    this.lastPulse = -Infinity;
    this.direction = 0;
  }
  setMode(mode) {
    this.suspend();
    this.mode = mode;
    this.log(`Mode: ${mode}.`);
    this.onMode(mode);
  }
  macro({ slot, name }) {
    const assignment = this.config.macros[slot];
    if (assignment?.source === 'disabled') { this.log(`${name} is disabled.`); return; }
    if (assignment?.source === 'cncjs') { this.onSavedMacro(assignment.id); return; }
    const code = assignment?.trim();
    if (!code) { this.log(`${name} is not configured.`); return; }
    try { validateMacroContent(code); }
    catch (error) { this.log(`${name}: ${error.message}`); return; }
    this.grbl.macro(code.split(/\r?\n/).filter(line => line.trim()));
  }
  key(code, modifier) {
    this.suspend();
    if (modifier === 'fn') {
      if (code === 6 || code === 7) { this.grbl.spindleSpeed(code === 6 ? 1 : -1, this.config.spindleIncrement); return; }
      if (code === 11) { this.grbl.spindleDirection(); return; }
      if (code === 14 || code === 15) { this.grbl.coolantToggle(code === 14 ? 'flood' : 'mist'); return; }
      if (MACROS[code]) this.macro(MACROS[code]);
      return;
    }
    const actions = {
      1: () => this.grbl.reset(), 2: () => this.grbl.stop(), 3: () => this.grbl.startPause(),
      4: () => this.grbl.override('feed', 1), 5: () => this.grbl.override('feed', -1),
      6: () => this.grbl.override('spindle', 1), 7: () => this.grbl.override('spindle', -1),
      8: () => this.grbl.homing(), 9: () => this.grbl.safeZ(), 10: () => this.grbl.wcsHome(),
      11: () => this.grbl.spindleToggle(), 13: () => this.grbl.probeZ(),
      14: () => this.setMode('continuous'), 15: () => this.setMode('step'),
      16: () => { this.coordinates = this.coordinates === 'work' ? 'machine' : 'work'; this.onCoordinates(this.coordinates); this.log(`Display: ${this.coordinates} coordinates.`); },
    };
    actions[code]?.();
  }
  handleInput(report) {
    const keys = new Set([report.firstKeyCode, report.secondKeyCode].filter(code => code && code !== FN));
    const modifier = [report.firstKeyCode, report.secondKeyCode].includes(FN) ? 'fn' : 'plain';
    // A modifier change while a key is held never replays that physical key.
    const pressed = [...keys].filter(code => !this.keys.has(code));
    this.keys = keys;
    if (this.axisCode !== report.leftDialCode || this.rateCode !== report.rightDialCode) this.suspend();
    const previousRate = this.rateCode;
    const wasLead = LEAD.has(this.rateCode);
    this.axisCode = report.leftDialCode;
    this.rateCode = report.rightDialCode;
    if (LEAD.has(this.rateCode) && this.mode !== 'lead') this.setMode('lead');
    if (wasLead && !LEAD.has(this.rateCode)) this.setMode('mpg');
    for (const code of pressed) this.key(code, modifier);
    if (previousRate !== null && previousRate !== this.rateCode && ['mpg', 'continuous'].includes(this.mode) && SELECTORS[this.rateCode]) {
      this.grbl.overrideTarget('feed', SELECTORS[this.rateCode].percent);
    }
    // A button press and wheel delta in one packet must not start new motion.
    if (keys.size || modifier === 'fn' || !Number.isInteger(report.jog) || !report.jog || Math.abs(report.jog) > 127) return;
    if (this.axisCode === 0x06) return;
    if (!AXES[this.axisCode]) { this.log('GRBL supports XYZ; A/B/C wheel input ignored.'); return; }
    if (LEAD.has(this.rateCode)) { this.grbl.override('spindle', report.jog); return; }
    const selection = SELECTORS[this.rateCode];
    if (!selection) { this.log('Unknown rate selector; wheel input ignored.'); return; }
    if (this.mode === 'mpg') { this.grbl.override('feed', report.jog); return; }
    const axis = AXES[this.axisCode];
    if (this.mode === 'step') {
      const units = this.grbl.jogUnits;
      if (!units) { this.log('Step: waiting for known GRBL G20/G21 program units; wheel input ignored.'); return; }
      if (selection.step > 1 && this.config.largeSteps !== 'enabled') { this.log(`5/10 ${units.label} steps are disabled; enable them in pendant settings if required.`); return; }
      const max = this.grbl.maxRate(axis);
      if (!max) { this.log(`Step: waiting for GRBL ${axis} maximum-rate setting.`); return; }
      this.grbl.jog(axis, report.jog * selection.step * units.scale, max);
      return;
    }
    if (this.mode !== 'continuous') return;
    const max = this.grbl.maxRate(axis);
    if (!max) { this.log(`Continuous: waiting for GRBL ${axis} maximum-rate setting.`); return; }
    const direction = Math.sign(report.jog);
    if (this.direction && this.direction !== direction) this.suspend();
    this.direction = direction;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = this.schedule(() => this.suspend(), 180);
    const time = this.now();
    if (time - this.lastPulse < 200) return;
    const feed = max * selection.percent / 100;
    // One bounded segment outstanding, even when acceleration makes it take
    // longer than 200 ms. Timers query/cancel; only wheel input starts motion.
    if (this.grbl.jogPulse(axis, direction * feed / 60 * 0.2, feed) === 'sent') this.lastPulse = time;
  }
}
