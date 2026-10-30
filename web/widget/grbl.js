// GRBL 1.1 commands through the already-joined CNCjs session.
export class Grbl {
  constructor(session, getProbeThickness = () => 20, log = () => {}) {
    Object.assign(this, { session, getProbeThickness, log });
    this.jogPhase = 'idle';
    this.jogGeneration = null;
    this.cancelSequence = 0;
    this.spindleDirectionMode = 'M3';
  }
  get state() { return this.session.state || {}; }
  get settings() { return this.session.settings?.settings || {}; }
  get activeState() { return this.session.activeState || this.state.status?.activeState || ''; }
  _cmd(directive, data) { return this.session.command(directive, data); }
  gcode(g) { return this._cmd('gcode', g); }
  reset() { this.jogPhase = 'idle'; this._cmd('reset'); }
  stop() { this.jogPhase = 'idle'; this.session.stop(); }
  refuse(message) { this.log(message); return 'dropped'; }
  manualReady(allowJog = 'idle-only') {
    if (this.session.status?.phase !== 'joined' || this.session.stopPhase !== 'idle') return false;
    if (this.session.workflowState !== 'idle') return false;
    return this.activeState === 'Idle' || (allowJog === 'allow-jog' && this.activeState === 'Jog');
  }
  startPause() {
    if (this.session.workflowState === 'running') return this._cmd('gcode:pause');
    if (this.session.workflowState === 'paused') return this._cmd('gcode:resume');
    if (this.activeState.startsWith('Hold')) return this._cmd('cyclestart');
    if (this.manualReady()) return this._cmd('gcode:start');
    return this.refuse('Start/Pause: wait for a known idle, running, or paused state.');
  }
  override(kind, delta) {
    if (!['feed', 'spindle'].includes(kind) || !Number.isInteger(delta) || Math.abs(delta) > 127) return 'dropped';
    const direction = Math.sign(delta);
    for (let remaining = Math.abs(delta); remaining > 0;) {
      const amount = remaining >= 10 ? 10 : 1;
      if (this._cmd(`${kind}Override`, direction * amount) === 'dropped') return 'dropped';
      remaining -= amount;
    }
    return 'sent';
  }
  homing() {
    if (!this.manualReady() && this.activeState !== 'Alarm') return this.refuse('Homing: stop the program and motion first.');
    return this._cmd('homing');
  }
  macro(code) {
    if (!this.manualReady()) return this.refuse('Macro: controller must be idle with no running program.');
    return this.gcode(code);
  }
  spindleToggle() {
    if (!this.manualReady()) return this.refuse('Spindle toggle: controller must be idle.');
    const modal = this.state.parserstate?.modal?.spindle;
    if (modal === 'M3' || modal === 'M4') return this.gcode('M5');
    const rpm = Number(this.state.parserstate?.spindle);
    if (modal !== 'M5' || !(rpm > 0)) return this.refuse('Set a positive spindle S speed in CNCjs before starting the spindle.');
    return this.gcode(this.spindleDirectionMode);
  }
  spindleSpeed(direction, increment = 100) {
    if (!this.manualReady()) return this.refuse('Commanded spindle speed: controller must be idle; use Spindle +/- overrides during a program.');
    const current = Number(this.state.parserstate?.spindle);
    const max = Number(this.settings.$30), min = Number(this.settings.$31);
    if (!Number.isFinite(current) || !Number.isFinite(min) || !(max > min)) return this.refuse('Spindle speed unavailable: wait for GRBL parser state and $30/$31 settings.');
    return this.gcode(`S${Math.max(min, Math.min(max, current + direction * increment))}`);
  }
  spindleDirection() {
    if (!this.manualReady() || this.state.parserstate?.modal?.spindle !== 'M5') return this.refuse('Stop the spindle before changing its direction.');
    this.spindleDirectionMode = this.spindleDirectionMode === 'M3' ? 'M4' : 'M3';
    this.log(`Next spindle start: ${this.spindleDirectionMode === 'M3' ? 'clockwise' : 'counterclockwise'}.`);
  }
  coolantToggle(kind) {
    if (!this.manualReady()) return this.refuse('Coolant toggle: controller must be idle.');
    const modal = this.state.parserstate?.modal?.coolant;
    if (!modal) return this.refuse('Coolant state unavailable.');
    const modes = new Set(Array.isArray(modal) ? modal : [modal]);
    const target = kind === 'flood' ? 'M8' : 'M7';
    if (!modes.has(target)) return this.gcode(target);
    modes.delete(target);
    // GRBL has one coolant-off command; restore the other active channel.
    return this.gcode(['M9', ...[...modes].filter(mode => mode === 'M7' || mode === 'M8')]);
  }
  safeZ() { return this.macro('G21 G53 G0 G90 Z-5'); }
  wcsHome() { return this.macro(['G21 G53 G0 G90 Z-5', 'G21 G54 G0 G90 X0 Y0']); }
  probeZ() {
    const thickness = Number(this.getProbeThickness());
    if (!Number.isFinite(thickness) || thickness < 0) return this.refuse('Enter a valid nonnegative probe plate thickness.');
    return this.macro(['G21 G91', 'G38.2 Z-50 F120', `G10 L20 P1 Z${thickness + 0.001}`, 'G0 Z3', 'G90']);
  }
  maxRate(axis) {
    const index = ['X', 'Y', 'Z'].indexOf(axis);
    const value = Number(this.settings[`$${110 + index}`]);
    return index >= 0 && Number.isFinite(value) && value > 0 ? value : null;
  }
  cancelJog() {
    if (this.jogPhase !== 'active') return;
    this.jogPhase = 'idle';
    if (this.jogGeneration !== this.session.generation || this.session.workflowState !== 'idle') return;
    this._cmd('feeder:stop');
    if (this._cmd('jogCancel') === 'dropped') return;
    this.cancelSequence = this.session.reportSequence;
    this.jogPhase = 'canceling';
    this._cmd('statusreport');
  }
  jog(axis, distance, feed) {
    if (!['X', 'Y', 'Z'].includes(axis) || !Number.isFinite(distance) || distance === 0 || !(feed > 0)) return this.refuse('Jog requires an XYZ axis and finite distance/feed.');
    if (this.jogGeneration !== this.session.generation) this.jogPhase = 'idle';
    if (this.jogPhase === 'canceling') {
      if (this.session.reportSequence <= this.cancelSequence || this.activeState !== 'Idle') return this.refuse('Jog: waiting for cancellation to finish.');
      this.jogPhase = 'idle';
    }
    if (!this.manualReady('allow-jog')) return this.refuse('Jog: controller must be idle or jogging with no running program.');
    const max = this.maxRate(axis);
    if (!max) return this.refuse(`Jog: waiting for GRBL ${axis} maximum-rate setting.`);
    const result = this.gcode(`$J=G21 G91 ${axis}${distance.toFixed(4)} F${Math.min(feed, max).toFixed(3)}`);
    if (result === 'dropped') return result;
    this.jogPhase = 'active';
    this.jogGeneration = this.session.generation;
    return 'sent';
  }
}
