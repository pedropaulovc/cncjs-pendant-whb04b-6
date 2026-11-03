// GRBL 1.1 commands through the already-joined CNCjs session.
// Consecutive Idle reports after the last jog's ok that prove the controller
// finished it short of its target. Two reports can still be in flight from
// before the jog started, so stopping short needs more evidence than that.
const SETTLED_IDLE_REPORTS = 5;
// Native CNCjs status runs at 250 ms. Give unchanged Idle several native cycles
// before requesting evidence that CNCjs deduplicates. Never poll a moving jog.
const CONFIRM_DELAY = 750;
const CONFIRM_INTERVAL = 250;
const FEEDBACK_TIMEOUT = 3000;
const JOG_UNITS = {
  G20: { code: 'G20', scale: 25.4, label: 'in', distanceDecimals: 6, feedDecimals: 6 },
  G21: { code: 'G21', scale: 1, label: 'mm', distanceDecimals: 4, feedDecimals: 3 },
};

export class Grbl {
  constructor(session, log = () => {}, { schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), now = () => performance.now() } = {}) {
    Object.assign(this, { session, log, schedule, cancel, now });
    this.pendingOverrides = new Map();
    this.overrideTimer = null;
    this.jogPhase = 'idle';
    this.jogGeneration = null;
    this.jogEpoch = null;
    this.jogErrorSequence = 0;
    this.cancelSequence = 0;
    this.jogSequence = 0;
    this.jogPositionSequence = 0;
    this.jogTimer = null;
    this.jogUnsubscribe = null;
    this.confirmRequests = 0;
    this.confirmBlocked = false;
    this.observedReceiptState = null;
    this.observedMotionState = '';
    this.jogTarget = null;
    this.jogCompletionNotice = 'none';
    this.jogShortNotice = 'none';
    this.jogAxis = null;
    this.jogBacklog = null;
    this.backlogTimer = null;
    this.spindleDirectionMode = 'M3';
  }
  get state() { return this.session.state || {}; }
  get settings() { return this.session.settings?.settings || {}; }
  get activeState() { return this.session.motionState || this.session.activeState || this.state.status?.activeState || ''; }
  get jogUnits() {
    const code = this.state.parserstate?.modal?.units;
    return code === 'G20' || code === 'G21' ? JOG_UNITS[code] : null;
  }
  _cmd(directive, data) { return this.session.command(directive, data); }
  gcode(g) { return this._cmd('gcode', g); }
  reset() { this.clearOverrides(); this.clearJog(); this._cmd('reset'); }
  stop() { this.clearOverrides(); this.clearJog(); this.session.stop(); }
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
  clearOverrides() {
    if (this.overrideTimer !== null) this.cancel(this.overrideTimer);
    this.overrideTimer = null;
    this.pendingOverrides.clear();
  }
  overrideTarget(kind, target) {
    const current = this.pendingOverrides.get(kind)?.target ?? this.session.overrides?.[kind === 'feed' ? 0 : 2];
    if (!Number.isFinite(target) || !Number.isFinite(current)) return this.refuse('Override: waiting for GRBL Ov status.');
    const bounded = Math.max(10, Math.min(200, target));
    if (bounded !== target) this.log(`GRBL override minimum is 10%; requested ${target}% uses ${bounded}%.`);
    return this.override(kind, bounded - current);
  }
  override(kind, delta) {
    if (!['feed', 'spindle'].includes(kind) || !Number.isInteger(delta) || Math.abs(delta) > 200) return 'dropped';
    if (this.session.status?.phase !== 'joined' || this.session.stopPhase !== 'idle') return this.refuse('Override: no ready GRBL connection.');
    const current = this.session.overrides?.[kind === 'feed' ? 0 : 2];
    if (!Number.isFinite(current)) { this._cmd('statusreport'); return this.refuse('Override: waiting for GRBL Ov status.'); }
    let pending = this.pendingOverrides.get(kind);
    if (pending?.generation !== this.session.generation || pending?.epoch !== this.session.motionEpoch) pending = null;
    if (!pending) pending = { target: current, expected: null, generation: this.session.generation, epoch: this.session.motionEpoch, deadline: this.now() + 3000 };
    pending.target = Math.max(10, Math.min(200, pending.target + delta));
    this.pendingOverrides.set(kind, pending);
    this.flushOverrides();
    return 'sent';
  }
  flushOverrides() {
    if (this.overrideTimer !== null) this.cancel(this.overrideTimer);
    this.overrideTimer = null;
    for (const [kind, pending] of this.pendingOverrides) {
      if (pending.generation !== this.session.generation || pending.epoch !== this.session.motionEpoch || this.session.status?.phase !== 'joined' || this.session.stopPhase !== 'idle') {
        this.pendingOverrides.delete(kind);
        continue;
      }
      if (this.now() >= pending.deadline) {
        this.pendingOverrides.delete(kind);
        this.log(`${kind} override: no confirming status; remaining changes discarded.`);
        continue;
      }
      const current = this.session.overrides?.[kind === 'feed' ? 0 : 2];
      if (pending.expected !== null && (this.session.overrideSequence <= pending.sequence || current !== pending.expected)) continue;
      if (current === pending.target) { this.pendingOverrides.delete(kind); continue; }
      const difference = pending.target - current;
      const amount = Math.sign(difference) * (Math.abs(difference) >= 10 ? 10 : 1);
      if (this._cmd(`${kind}Override`, amount) === 'dropped') { this.pendingOverrides.delete(kind); continue; }
      pending.expected = current + amount;
      pending.sequence = this.session.overrideSequence;
      pending.deadline = this.now() + 3000;
    }
    if (!this.pendingOverrides.size) return;
    this._cmd('statusreport');
    this.overrideTimer = this.schedule(() => this.flushOverrides(), 250);
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
  maxRate(axis) {
    const index = ['X', 'Y', 'Z'].indexOf(axis);
    const value = Number(this.settings[`$${110 + index}`]);
    return index >= 0 && Number.isFinite(value) && value > 0 ? value : null;
  }
  position(axis, kind) {
    const report = kind ? this.session.positionReports?.[kind] : this.session.positionReport;
    const units = Number(report?.units);
    if (!report || ![0, 1].includes(units)) return null;
    const value = report.values[['X', 'Y', 'Z'].indexOf(axis)];
    if (!Number.isFinite(value)) return null;
    const scale = units === 1 ? 25.4 : 1;
    const stepsPerMm = Number(this.settings[`$${100 + ['X', 'Y', 'Z'].indexOf(axis)}`]);
    const stepRounding = Number.isFinite(stepsPerMm) && stepsPerMm > 0 ? 0.5 / stepsPerMm : 0;
    return { kind: report.kind, units, value: value * scale, resolution: report.resolution * scale + stepRounding, sequence: report.sequence };
  }
  jogCompleted() {
    if (this.jogBacklog || this.activeState !== 'Idle') return false;
    const acknowledgedIdle = this.jogReceipt?.state === 'acknowledged'
      && this.session.reportSequence >= this.jogReceipt.reportSequence + 2 && this.session.idleReports >= 2;
    if (!this.jogTarget) return this.unmeasuredJogCompleted(acknowledgedIdle);
    const position = this.position(this.jogTarget.axis, this.jogTarget.kind);
    if (!position || position.kind !== this.jogTarget.kind || position.units !== this.jogTarget.units) return false;
    const tolerance = Math.max(position.resolution, this.jogTarget.resolution) + 1e-8;
    // An unchanged frame is deduplicated by CNCjs. Tiny Steps and queued Steps
    // returning to their start need the last command's acknowledgement followed
    // by two fresh Idle reports: a dwell can report Idle before queued jogs run.
    if (Math.abs(this.jogTarget.value - this.jogTarget.start) <= 2 * tolerance
      && Math.abs(position.value - this.jogTarget.value) <= 2 * tolerance) return this.unmeasuredJogCompleted(acknowledgedIdle);
    const fresh = position.sequence > this.jogPositionSequence && Math.abs(position.value - this.jogTarget.start) >= tolerance;
    if (fresh && Math.abs(position.value - this.jogTarget.value) <= tolerance) return true;
    if (this.session.replyTracking === 'unknown') return this.unmeasuredJogCompleted(false);
    return this.jogStoppedShort(position);
  }
  // FluidNC clips jogs to the soft-limit range and acknowledges them with ok,
  // so a clipped jog never reaches its target and never reports an error.
  jogStoppedShort(position) {
    const settled = this.session.idleReports >= SETTLED_IDLE_REPORTS && this.session.reportSequence >= this.jogSequence + SETTLED_IDLE_REPORTS;
    if (!settled) return false;
    const acknowledged = this.jogReceipt?.state === 'acknowledged'
      && this.session.reportSequence >= this.jogReceipt.reportSequence + SETTLED_IDLE_REPORTS;
    // Without trusted acknowledgements the jog may still wait behind a dwell:
    // retain cancellation ownership rather than manufacture completion.
    if (!acknowledged) return this.unmeasuredJogCompleted(false);
    if (this.jogShortNotice === 'none') {
      this.jogShortNotice = 'shown';
      this.log(`${this.jogTarget.axis} jog ended short of its target at ${position.value.toFixed(3)} (target ${this.jogTarget.value.toFixed(3)} ${position.kind}); the controller clipped it, most likely at a soft limit.`);
    }
    return true;
  }
  unmeasuredJogCompleted(acknowledgedIdle) {
    if (this.session.replyTracking === 'unknown'
      && this.session.reportSequence >= this.jogSequence + 2 && this.session.idleReports >= 2) {
      this.jogPhase = 'armed';
      if (this.jogCompletionNotice === 'none') {
        this.jogCompletionNotice = 'shown';
        this.log('Jog completion cannot be confirmed after joining an active controller or program activity. Confirmation paused; jog cancellation remains armed. Change mode/axis or press Stop to cancel. Reset restores acknowledgement tracking.');
      }
    }
    return acknowledgedIdle;
  }
  clearJog() {
    this.stopJogObservation();
    this.dropBacklog();
    this.jogPhase = 'idle';
    this.jogTarget = null;
    this.jogReceipt = null;
    this.jogCompletionNotice = 'none';
  }
  cancelJogTimer() {
    if (this.jogTimer !== null) this.cancel(this.jogTimer);
    this.jogTimer = null;
  }
  stopJogObservation() {
    this.cancelJogTimer();
    this.jogUnsubscribe?.();
    this.jogUnsubscribe = null;
  }
  dropBacklog() {
    if (this.backlogTimer !== null) this.cancel(this.backlogTimer);
    this.backlogTimer = null;
    this.jogBacklog = null;
  }
  // CNCjs's feeder writes a lone queued line at once, without waiting for the
  // controller's ok, so rapid Steps would overrun the controller's serial and
  // planner buffers. Hold later wheel input until the controller replies to the
  // last owned line, then send it as one merged line.
  jogAwaitingReply() {
    return ['queued', 'written'].includes(this.jogReceipt?.state);
  }
  bufferJog(axis, distance, feed) {
    // Keep input in physical millimetres; only the eventual wire command rounds
    // it. A modal unit change must not reinterpret already requested detents.
    const total = (this.jogBacklog?.distance ?? 0) + distance;
    this.jogBacklog = { axis, distance: total, feed };
    if (this.jogAwaitingReply()) { this.flushBacklog(); return 'buffered'; }
    return this.sendBacklog();
  }
  flushBacklog() {
    if (this.backlogTimer !== null) return;
    this.backlogTimer = this.schedule(() => {
      this.backlogTimer = null;
      if (!this.jogBacklog) return;
      if (this.jogAwaitingReply()) { this.flushBacklog(); return; }
      this.sendBacklog();
    }, 50);
  }
  // Only the controller's reply to the line a backlog waited behind releases
  // it. A reset, program, Stop, or rejection ends that motion session, and the
  // merged detents must never start motion without fresh wheel input.
  backlogReleased() {
    return !this.jogSessionChanged() && ['acknowledged', 'uncertain'].includes(this.jogReceipt?.state);
  }
  sendBacklog() {
    const backlog = this.jogBacklog;
    if (!backlog) return 'dropped';
    if (!this.backlogReleased()) {
      this.dropBacklog();
      this.log(`Step: discarded ${backlog.distance.toFixed(4)} mm of merged ${backlog.axis} wheel input; the jog was interrupted.`);
      return 'dropped';
    }
    // Detents that returned to their start cancel out; nothing to send.
    if (Math.abs(backlog.distance) < 1e-12) { this.dropBacklog(); this.cancelJogTimer(); this.refreshJog(); return 'buffered'; }
    // Missing modal feedback is not a canceled motion session. Retain the
    // physical input until a known mode can serialize it, or an explicit
    // interruption/cancellation clears it. Do not flood the log while waiting.
    const units = this.jogUnits;
    if (!units) {
      if (!backlog.waitingUnits) {
        this.log('Step: queued wheel input retained; waiting for known G20/G21 program units.');
        backlog.waitingUnits = true;
      }
      this.flushBacklog();
      return 'buffered';
    }
    this.dropBacklog();
    if (!this.jogWords(backlog.distance, backlog.feed, this.maxRate(backlog.axis), units)) {
      this.log(`Step: discarded merged ${backlog.axis} wheel input; distance/feed rounds to zero or is unrepresentable in ${units.code}.`);
      this.cancelJogTimer();
      this.refreshJog();
      return 'dropped';
    }
    const result = this.jog(backlog.axis, backlog.distance, backlog.feed);
    if (result === 'dropped') this.log(`Step: discarded ${backlog.distance.toFixed(4)} mm of merged ${backlog.axis} wheel input.`);
    return result;
  }
  jogSessionChanged() {
    return this.jogGeneration !== this.session.generation || this.jogEpoch !== this.session.motionEpoch
      || this.jogWorkflowEpoch !== this.session.workflowEpoch;
  }
  cancellationCompleted() {
    return this.session.reportSequence >= this.cancelSequence + 2 && this.session.idleReports >= 2 && this.activeState === 'Idle';
  }
  recoverJogError() {
    const error = this.session.controllerError;
    if (!['active', 'armed'].includes(this.jogPhase) || !error || error.sequence <= this.jogErrorSequence || this.jogSessionChanged()) return 'unchanged';
    if (this.session.status?.phase !== 'joined' || this.session.workflowState !== 'idle' || this.session.stopPhase !== 'idle') return 'unchanged';
    this.jogErrorSequence = error.sequence;
    if (this.jogPhase === 'armed' && this.jogReceipt?.transmission === 'written'
      && !['written', 'rejected'].includes(this.jogReceipt.state)) return 'unchanged';
    this.log(`Controller ${error.line} during pendant jogging; canceling queued jogs and waiting for Idle.`);
    this.cancelJog('controller-error');
    return 'recovering';
  }
  observeJog() {
    if (!this.jogUnsubscribe) this.jogUnsubscribe = this.session.subscribeMotion(progress => this.refreshJog(progress));
    this.refreshJog();
  }
  refreshJog(motionProgress = false) {
    if (this.jogSessionChanged() || this.session.status?.phase !== 'joined' || this.session.stopPhase !== 'idle' || this.session.workflowState !== 'idle' || ['Alarm', 'Sleep', 'Check'].includes(this.activeState)) { this.clearJog(); return; }
    if (this.recoverJogError() === 'recovering') return;
    if (this.jogPhase === 'idle' || (this.jogPhase === 'active' && this.jogCompleted()) || (this.jogPhase === 'canceling' && this.cancellationCompleted())) { this.clearJog(); return; }
    if (this.jogPhase === 'armed') { this.stopJogObservation(); return; }
    const receiptChanged = this.observedReceiptState !== this.jogReceipt?.state;
    this.observedReceiptState = this.jogReceipt?.state;
    const motionChanged = this.observedMotionState !== this.activeState;
    this.observedMotionState = this.activeState;
    if (motionProgress || receiptChanged || motionChanged) {
      this.cancelJogTimer();
      this.confirmRequests = 0;
      this.confirmBlocked = false;
    }
    if (this.confirmBlocked || this.jogTimer !== null) return;
    // An ACK is not completion, but a trusted outstanding line can still be
    // behind a dwell. Do not query cached Idle to try to prove it has executed.
    const awaitingReply = this.jogPhase === 'active' && this.jogAwaitingReply() && this.session.replyTracking !== 'unknown';
    if (awaitingReply || this.jogBacklog) return;
    const canConfirm = this.activeState === 'Idle';
    this.scheduleJog(canConfirm ? () => this.confirmJog() : () => this.pauseJogConfirmation(),
      canConfirm ? CONFIRM_DELAY : FEEDBACK_TIMEOUT);
  }
  scheduleJog(callback, delay) {
    const timer = this.schedule(() => {
      if (this.jogTimer !== timer) return;
      this.jogTimer = null;
      callback();
    }, delay);
    this.jogTimer = timer;
  }
  confirmJog() {
    // Re-evaluate before each request; a timer is never evidence of completion.
    this.refreshJog();
    if (!['active', 'canceling'].includes(this.jogPhase) || this.confirmBlocked || this.activeState !== 'Idle') return;
    if (this.jogPhase === 'active' && (this.jogBacklog || (this.jogAwaitingReply() && this.session.replyTracking !== 'unknown'))) return;
    this.cancelJogTimer();
    if (this.confirmRequests >= SETTLED_IDLE_REPORTS) { this.pauseJogConfirmation(); return; }
    this.confirmRequests += 1;
    // Arm before emitting: a synchronous response may complete and cancel it.
    this.scheduleJog(() => this.confirmJog(), CONFIRM_INTERVAL);
    this._cmd('statusreport');
  }
  pauseJogConfirmation() {
    this.cancelJogTimer();
    this.confirmBlocked = true;
    if (this.jogPhase === 'active') {
      this.jogPhase = 'armed';
      this.stopJogObservation();
    }
    if (this.jogCompletionNotice === 'none') {
      this.jogCompletionNotice = 'shown';
      this.log('Jog completion cannot be confirmed: feedback stopped or the bounded confirmation received insufficient Idle evidence. Jog cancellation remains armed; change mode/axis or press Stop to cancel. Pending cancellation still blocks new jogs.');
    }
  }
  cancelJog(cause = 'operator') {
    if (cause === 'operator' && this.recoverJogError() === 'recovering') return;
    if (!['active', 'armed'].includes(this.jogPhase)) return;
    this.dropBacklog();
    this.stopJogObservation();
    if (this.jogSessionChanged() || this.session.workflowState !== 'idle' || (cause === 'operator' && this.jogCompleted())) { this.clearJog(); return; }
    // Once the last owned line was written, no owned commands remain in the
    // feeder. A later CNCjs macro must not be discarded by passive cancellation.
    if (this.jogReceipt?.transmission !== 'written') this._cmd('feeder:stop');
    if (this._cmd('jogCancel') === 'dropped') { this.jogPhase = 'armed'; return; }
    this.cancelSequence = this.session.reportSequence;
    this.jogPhase = 'canceling';
    this.confirmRequests = 0;
    this.confirmBlocked = false;
    this.observedReceiptState = this.jogReceipt?.state;
    this.observeJog();
  }
  jogPulse(axis, distance, feed) {
    if (this.jogSessionChanged()) this.clearJog();
    this.recoverJogError();
    if (['active', 'armed'].includes(this.jogPhase) && this.jogGeneration === this.session.generation) {
      if (!this.jogCompleted()) return 'pending';
      this.jogPhase = 'idle';
    }
    const position = this.position(axis);
    if (!position || Math.abs(distance) <= 2 * position.resolution) {
      this._cmd('statusreport');
      return this.refuse('Continuous: waiting for position units/feedback, or selected travel is below report resolution.');
    }
    return this.jog(axis, distance, feed);
  }
  // Public jog inputs and completion targets are always mm and mm/min.
  // Clamp physically first, then floor the wire feed so rounding never raises
  // it above the requested speed or the axis maximum.
  jogWords(distance, feed, max, units) {
    if (!max) return null;
    const distanceWord = (distance / units.scale).toFixed(units.distanceDecimals);
    const limit = Math.min(feed, max);
    const precision = 10 ** units.feedDecimals;
    let ticks = Math.floor(limit / units.scale * precision);
    if (ticks / precision * units.scale > limit) ticks -= 1;
    const feedWord = (ticks / precision).toFixed(units.feedDecimals);
    if (!Number.isFinite(Number(distanceWord)) || Number(distanceWord) === 0
      || !Number.isFinite(Number(feedWord)) || !(Number(feedWord) > 0)) return null;
    return { distance: distanceWord, feed: feedWord, millimetres: Number(distanceWord) * units.scale };
  }
  jog(axis, distance, feed) {
    if (!['X', 'Y', 'Z'].includes(axis) || !Number.isFinite(distance) || distance === 0 || !Number.isFinite(feed) || !(feed > 0)) return this.refuse('Jog requires an XYZ axis and finite nonzero distance/positive feed.');
    if (this.jogSessionChanged()) this.clearJog();
    this.recoverJogError();
    if (this.jogPhase === 'canceling') {
      if (!this.cancellationCompleted()) return this.refuse('Jog: waiting for cancellation to finish.');
      this.jogPhase = 'idle';
    }
    if (!this.manualReady('allow-jog')) return this.refuse('Jog: controller must be idle or jogging with no running program.');
    const max = this.maxRate(axis);
    if (!max) return this.refuse(`Jog: waiting for GRBL ${axis} maximum-rate setting.`);
    const units = this.jogUnits;
    if (!units) return this.refuse('Jog: waiting for known program units (G20 inches or G21 millimetres).');
    const words = this.jogWords(distance, feed, max, units);
    if (!words) return this.refuse('Jog: distance/feed rounds to zero or is unrepresentable in the current program units.');
    // At most one owned line awaits the controller's reply; later wheel input on
    // the same axis merges and goes out once that reply arrives. Input arriving
    // before the timer sends the merge joins it, keeping detents in order.
    if (this.jogBacklog?.axis === axis
      || (['active', 'armed'].includes(this.jogPhase) && this.jogAxis === axis && this.jogAwaitingReply())) {
      return this.bufferJog(axis, distance, feed);
    }
    let pending = ['active', 'armed'].includes(this.jogPhase) && !this.jogCompleted() && this.jogTarget?.axis === axis ? this.jogTarget : null;
    // Passive ownership may outlive a separate CNCjs move or coordinate change.
    // Rebase the next Step on fresh feedback once all owned lines were written;
    // unsent owned lines still need their accumulated relative target.
    const current = this.position(axis);
    if (pending && this.jogPhase === 'armed' && this.activeState === 'Idle' && this.jogReceipt?.transmission === 'written'
      && current && current.sequence > this.jogPositionSequence) {
      const tolerance = Math.max(current.resolution, pending.resolution) + 1e-8;
      if (current.kind !== pending.kind || current.units !== pending.units || Math.abs(current.value - pending.value) > 2 * tolerance) pending = null;
    }
    const position = this.position(axis, pending?.kind);
    const previous = pending || position;
    // Socket fixtures (and local adapters) may deliver a write/ACK inline.
    // Observe only after installing the new receipt and accumulated target.
    this.stopJogObservation();
    const generation = this.session.generation;
    const epoch = this.session.motionEpoch;
    const workflowEpoch = this.session.workflowEpoch;
    const sequence = this.session.reportSequence;
    const positionSequence = this.session.positionReport?.sequence ?? 0;
    const errorSequence = this.session.errorSequence ?? 0;
    const receipt = this.session.jog(`$J=${units.code} G91 ${axis}${words.distance} F${words.feed}`);
    if (receipt.state === 'dropped') { if (this.jogPhase === 'active') this.observeJog(); return 'dropped'; }
    if (generation !== this.session.generation || epoch !== this.session.motionEpoch || workflowEpoch !== this.session.workflowEpoch) {
      this.clearJog();
      return this.refuse('Jog interrupted while sending: controller session changed.');
    }
    this.jogReceipt = receipt;
    this.jogPhase = 'active';
    this.jogAxis = axis;
    this.jogShortNotice = 'none';
    this.jogGeneration = generation;
    this.jogEpoch = epoch;
    this.jogWorkflowEpoch = workflowEpoch;
    this.jogErrorSequence = errorSequence;
    this.jogSequence = sequence;
    this.jogPositionSequence = positionSequence;
    this.jogTarget = previous ? { ...previous, axis, start: position?.value ?? previous.start, value: previous.value + words.millimetres } : null;
    this.confirmRequests = 0;
    this.confirmBlocked = false;
    this.observedReceiptState = receipt.state;
    this.observeJog();
    return 'sent';
  }
}
