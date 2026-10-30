// LinuxCNC xhc-whb04b-6 mappings, with GRBL's XYZ and realtime-command limits.
export const SELECTORS = {
  0x0d: { percent: 2, step: 0.001 }, 0x0e: { percent: 5, step: 0.01 },
  0x0f: { percent: 10, step: 0.1 }, 0x10: { percent: 30, step: 1 },
  0x1a: { percent: 60, step: 5 }, 0x1b: { percent: 100, step: 10 },
};
const AXES = { 0x11: 'X', 0x12: 'Y', 0x13: 'Z' };
const FN = 0x0c;
const MACROS = { 1: 11, 2: 12, 3: 13, 4: 1, 5: 2, 8: 5, 9: 6, 10: 7, 13: 9, 16: 14 };
const LEAD = new Set([0x1c, 0x9b]);
export const CONFIG_KEY = 'whb04b-controls';
export const DEFAULT_CONFIG = { largeSteps: 'disabled', stepFeed: 250, spindleIncrement: 100, macros: {} };

export function parseConfig(value) {
  const config = { ...DEFAULT_CONFIG, ...value };
  if (!['enabled', 'disabled'].includes(config.largeSteps)) throw new Error('Large steps must be enabled or disabled.');
  if (!Number.isFinite(config.stepFeed) || config.stepFeed <= 0) throw new Error('Step feed must be positive mm/min.');
  if (!Number.isFinite(config.spindleIncrement) || config.spindleIncrement <= 0) throw new Error('Spindle increment must be positive RPM.');
  if (!config.macros || typeof config.macros !== 'object' || Array.isArray(config.macros)) throw new Error('Macros must be an object keyed by macro number.');
  const allowed = new Set(Object.values(MACROS).map(String));
  for (const [number, code] of Object.entries(config.macros)) {
    if (!allowed.has(number) || typeof code !== 'string' || code.length > 2000) throw new Error(`Invalid macro ${number}; use slots 1,2,5,6,7,9,11,12,13,14 and G-code text.`);
  }
  return config;
}

export class PendantControls {
  constructor(grbl, { log = () => {}, onMode = () => {}, onCoordinates = () => {},
    schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), now = () => performance.now(), config = DEFAULT_CONFIG } = {}) {
    Object.assign(this, { grbl, log, onMode, onCoordinates, schedule, cancel, now });
    this.config = parseConfig(config);
    this.mode = 'mpg';
    this.coordinates = 'work';
    this.keys = new Set();
    this.axisCode = null;
    this.rateCode = null;
    this.timer = null;
    this.lastPulse = -Infinity;
    this.direction = 0;
  }
  setConfig(config) { this.suspend(); this.config = parseConfig(config); }
  suspend() {
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
  macro(number) {
    const code = this.config.macros[number]?.trim();
    if (!code) { this.log(`Macro ${number} is not configured.`); return; }
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
    const wasLead = LEAD.has(this.rateCode);
    this.axisCode = report.leftDialCode;
    this.rateCode = report.rightDialCode;
    if (LEAD.has(this.rateCode) && this.mode !== 'lead') this.setMode('lead');
    if (wasLead && !LEAD.has(this.rateCode)) this.setMode('mpg');
    for (const code of pressed) this.key(code, modifier);
    // A button press and wheel delta in one packet must not start new motion.
    if (keys.size || !Number.isInteger(report.jog) || !report.jog || Math.abs(report.jog) > 127) return;
    if (this.axisCode === 0x06) return;
    if (!AXES[this.axisCode]) { this.log('GRBL supports XYZ; A/B/C wheel input ignored.'); return; }
    if (LEAD.has(this.rateCode)) { this.grbl.override('spindle', report.jog); return; }
    const selection = SELECTORS[this.rateCode];
    if (!selection) { this.log('Unknown rate selector; wheel input ignored.'); return; }
    if (this.mode === 'mpg') { this.grbl.override('feed', report.jog); return; }
    const axis = AXES[this.axisCode];
    if (this.mode === 'step') {
      if (selection.step > 1 && this.config.largeSteps !== 'enabled') { this.log('5/10 mm steps are disabled; enable them in pendant settings if required.'); return; }
      this.grbl.jog(axis, report.jog * selection.step, this.config.stepFeed);
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
    // At most one 200 ms travel segment per 200 ms; no unbounded motion target
    // and no timer generates motion without another physical wheel report.
    if (this.grbl.jog(axis, direction * feed / 60 * 0.2, feed) === 'sent') this.lastPulse = time;
  }
}
