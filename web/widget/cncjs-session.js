// Own one CNCjs socket and join only a port already opened by the operator.
export class CncjsSession {
  constructor({ io, origin, onStatus = () => {}, onState = () => {}, schedule = (...args) => setInterval(...args), cancel = (...args) => clearInterval(...args) }) {
    Object.assign(this, { io, origin, onStatus, onState, schedule, cancel });
    this.socket = null;
    this.timer = null;
    this.stopTimer = null;
    this.stopPhase = 'idle';
    this.stopIntent = 'motion';
    this.stopPort = null;
    this.holdRequest = 'not-requested';
    this.workflowState = 'unknown';
    this.state = {};
    this.settings = {};
    this.reportSequence = 0;
    this.idleReports = 0;
    this.overrideSequence = 0;
    this.overrides = [];
    this.positionReport = null;
    this.positionReports = {};
    this.positionSequence = 0;
    this.statePositionSignatures = {};
    this.motionState = '';
    this.motionEpoch = 0;
    this.activeState = '';
    this.selection = 'automatic';
    this.selectedPort = null;
    this.generation = 0;
    this.status = { phase: 'disconnected', port: null, controller: null, detail: '' };
  }

  update(phase, detail = '') {
    if (this.status.phase === phase && this.status.detail === detail) return;
    this.status.phase = phase;
    this.status.detail = detail;
    this.onStatus({ ...this.status });
  }

  clear() {
    this.cancelStopPolling();
    if (this.stopPhase !== 'idle') this.stopPhase = 'interrupted';
    this.workflowState = 'unknown';
    this.state = {};
    this.settings = {};
    this.activeState = '';
    this.overrides = [];
    this.positionReport = null;
    this.positionReports = {};
    this.statePositionSignatures = {};
    this.motionState = '';
    this.idleReports = 0;
    this.generation += 1;
    this.pendingPort = null;
    this.status.port = null;
    this.status.controller = null;
  }

  discover() {
    if (this.socket?.connected) this.socket.emit('list');
  }

  selectPort(port) {
    const next = typeof port === 'string' && port ? port : null;
    if (this.selection === 'explicit' && next === this.selectedPort) return;
    this.selection = 'explicit';
    this.selectedPort = next;
    this.refresh();
  }

  refresh() {
    this.clear();
    // Disconnect leaves the old controller room without closing the machine.
    this.socket?.disconnect();
    this.socket?.connect();
  }

  connect(token) {
    this.disconnect();
    if (!token) return;
    const socket = this.io(this.origin, { query: { token } });
    this.socket = socket;
    const on = (event, handler) => socket.on(event, (...args) => {
      if (this.socket === socket) handler(...args);
    });
    on('connect', () => {
      this.clear();
      this.update('discovering');
      this.discover();
    });
    on('disconnect', () => {
      this.clear();
      this.update('disconnected');
    });
    const connectionError = error => {
      this.clear();
      this.update('disconnected', String(error.message || error));
    };
    on('connect_error', connectionError);
    on('error', connectionError);
    on('serialport:change', () => this.discover());
    on('serialport:close', () => {
      this.clear();
      this.update('discovering');
      this.discover();
    });
    on('serialport:open', (info) => {
      if (info?.port !== this.pendingPort && info?.port !== this.status.port) return;
      this.status.controller = info.controllerType;
    });
    on('controller:state', (type, state) => {
      if (type !== 'Grbl') return;
      this.state = state;
      const status = state?.status || {};
      for (const [kind, position] of [['MPos', status.mpos], ['WPos', status.wpos]]) {
        const words = ['x', 'y', 'z'].map(axis => position?.[axis]);
        const signature = JSON.stringify([status.activeState, ...words]);
        if (signature === this.statePositionSignatures[kind] || words.some(value => value === undefined)) continue;
        this.statePositionSignatures[kind] = signature;
        this.recordPosition(kind, words.map(String), status.activeState);
      }
      if (Array.isArray(state?.status?.ov) && state.status.ov.length === 3) this.overrides = state.status.ov.map(Number);
      this.onState(type, state);
    });
    on('controller:settings', (type, settings) => {
      if (type === 'Grbl') this.settings = settings;
    });
    on('workflow:state', state => {
      if ((this.pendingPort || this.status.port) && ['idle', 'running', 'paused'].includes(state)) this.workflowState = state;
    });
    on('serialport:read', line => {
      if (typeof line === 'string' && line.startsWith('Grbl ')) {
        this.motionEpoch += 1;
        this.motionState = '';
        this.activeState = '';
        this.positionReport = null;
        this.positionReports = {};
        this.overrides = [];
        this.statePositionSignatures = {};
        this.state = {};
      }
      const state = typeof line === 'string' ? /^<([^|>]+)/.exec(line)?.[1] : null;
      if (state) {
        this.activeState = state;
        this.motionState = state;
        this.reportSequence += 1;
        this.idleReports = state === 'Idle' ? this.idleReports + 1 : 0;
      }
      const position = typeof line === 'string' ? /\|(MPos|WPos):([^|>]+)/.exec(line) : null;
      if (position) {
        const words = position[2].split(',').slice(0, 3);
        this.recordPosition(position[1], words, state);
      }
      const overrides = typeof line === 'string' ? /\|Ov:(\d+),(\d+),(\d+)/.exec(line) : null;
      if (overrides) { this.overrides = overrides.slice(1).map(Number); this.overrideSequence += 1; }
      this.stopReport(line);
    });
    on('serialport:list', (ports) => this.join(ports));
    this.timer = this.schedule(() => this.discover(), 2000);
  }

  recordPosition(kind, words, activeState) {
    const values = words.map(Number);
    if (!activeState || words.length !== 3 || !values.every(Number.isFinite)) return;
    this.motionState = activeState;
    this.positionReport = { kind, values, sequence: ++this.positionSequence,
      units: this.settings.settings?.$13,
      resolution: Math.max(...words.map(word => 10 ** -(word.split('.')[1]?.length || 0))) };
    this.positionReports[kind] = this.positionReport;
  }

  join(ports) {
    if (!this.socket?.connected || !Array.isArray(ports)) return;
    const available = ports.filter((port) => port.inuse === true && typeof port.port === 'string');
    const target = this.selection === 'explicit'
      ? available.find((port) => port.port === this.selectedPort)
      : available.length === 1 ? available[0] : null;
    if (!target) {
      if (this.status.port) this.refresh();
      this.clear();
      this.update('discovering', 'Open and select a GRBL port in CNCjs.');
      return;
    }
    if (target.port === this.status.port || target.port === this.pendingPort) return;
    if (this.status.port) {
      this.refresh();
      return;
    }
    this.workflowState = 'unknown';
    this.status.controller = null;
    this.pendingPort = target.port;
    this.update('joining');
    const generation = ++this.generation;
    // CNCjs's open RPC also joins an existing controller and sends its current
    // state. It has no separate join-only RPC, so only in-use ports qualify.
    this.socket.emit('open', target.port, { controllerType: 'Grbl', baudrate: 115200 }, (error) => {
      if (generation !== this.generation || !this.socket?.connected) return;
      this.pendingPort = null;
      if (error) {
        this.workflowState = 'unknown';
        this.status.controller = null;
        this.update('discovering', `Cannot join port: ${String(error.message || error)}`);
        return;
      }
      this.status.port = target.port;
      this.update(this.status.controller === 'Grbl' ? 'joined' : 'unsupported',
        this.stopPhase === 'interrupted' ? 'Stop interrupted: inspect CNCjs, then press Stop or Reset to recover.' : '');
    });
  }

  command(directive, data) {
    if (!this.socket?.connected || this.status.phase !== 'joined') {
      this.update(this.status.phase, 'Command dropped: no joined GRBL controller.');
      return 'dropped';
    }
    if (this.stopPhase !== 'idle' && !['reset', 'statusreport'].includes(directive)) {
      this.update('joined', this.stopPhase === 'interrupted'
        ? 'Command dropped: Stop interrupted; inspect CNCjs, then press Stop or Reset to recover.'
        : 'Command dropped: Stop is waiting for the controller.');
      return 'dropped';
    }
    if (this.stopPhase !== 'idle' && directive === 'reset') {
      if (this.stopPort !== this.status.port) this.stopIntent = 'motion';
      this.stopPort = this.status.port;
      this.stopPhase = 'resetting';
      this.update('joined', 'Stopping: waiting for controller reset.');
      this.startStopPolling();
    }
    this.socket.emit('command', this.status.port, directive, data);
    return 'sent';
  }

  stop() {
    if (!this.socket?.connected || this.status.phase !== 'joined') {
      this.update(this.status.phase, 'Stop dropped: no joined GRBL controller.');
      return;
    }
    if (!['idle', 'interrupted'].includes(this.stopPhase)) return;
    // A dwell reports Idle while the sender is still running. Preserve this
    // intent before gcode:stop changes workflow state, including after reconnect.
    const retryProgram = this.stopPhase === 'interrupted' && this.stopIntent === 'program' && this.stopPort === this.status.port;
    this.stopIntent = retryProgram || ['running', 'paused'].includes(this.workflowState) ? 'program' : 'motion';
    this.stopPort = this.status.port;
    this.holdRequest = 'not-requested';
    this.stopPhase = 'querying';
    this.update('joined', 'Stopping: waiting for controller status.');
    this.socket.emit('command', this.status.port, 'gcode:stop');
    this.socket.emit('command', this.status.port, 'feeder:stop');
    this.socket.emit('command', this.status.port, 'jogCancel');
    if (this.stopIntent === 'program') this.requestHold();
    this.command('statusreport');
    // CNCjs's forced stop uses a cached state and a fixed 500 ms reset delay.
    // Explicit reports retain GRBL's Hold substate; never reset during Hold:1.
    this.startStopPolling();
  }

  startStopPolling() {
    if (this.stopTimer !== null) return;
    const generation = this.generation;
    this.stopTimer = this.schedule(() => {
      if (generation === this.generation && this.stopPhase !== 'idle') this.command('statusreport');
    }, 250);
  }

  cancelStopPolling() {
    if (this.stopTimer !== null) this.cancel(this.stopTimer);
    this.stopTimer = null;
  }

  requestHold() {
    if (this.holdRequest === 'requested') return;
    this.holdRequest = 'requested';
    this.socket.emit('command', this.status.port, 'feedhold');
  }

  stopReport(line) {
    if (['idle', 'interrupted'].includes(this.stopPhase) || this.status.phase !== 'joined') return;
    if (typeof line !== 'string') return;
    if (this.stopPhase === 'resetting') {
      if (!line.startsWith('Grbl ')) return;
      this.stopIntent = 'motion';
      this.stopPhase = 'confirming';
      this.update('joined', 'Stopping: reset received; confirming controller status.');
      this.command('statusreport');
      return;
    }
    const state = /^<([^|>]+)/.exec(line)?.[1];
    if (!state) return;
    if (state === 'Idle' && this.stopIntent === 'program') {
      this.stopPhase = 'holding';
      this.update('joined', 'Stopping: waiting for program hold before reset.');
      return;
    }
    // A previous explicit status query can already be in flight at Stop.
    // Require another Idle report before releasing the motion interlock.
    if (state === 'Idle' && this.stopPhase !== 'idle-confirmation') {
      this.stopPhase = 'idle-confirmation';
      return;
    }
    if (state === 'Alarm' && this.stopPhase !== 'alarm-confirmation') {
      this.stopPhase = 'alarm-confirmation';
      return;
    }
    if (state === 'Idle' || state === 'Alarm') {
      this.finishStop();
      this.update('joined', state === 'Alarm' ? 'Stop completed with controller alarm; inspect CNCjs.' : 'Stop completed.');
      return;
    }
    // GRBL homing cannot be feed-held; reset aborts it and may raise an alarm.
    if (state === 'Home') {
      this.update('joined', 'Stopping: aborting homing with controller reset.');
      this.command('reset');
      return;
    }
    if (state === 'Hold:0') {
      if (this.stopPhase !== 'hold-confirmation') {
        this.stopPhase = 'hold-confirmation';
        this.update('joined', 'Stopping: confirming completed hold.');
        return;
      }
      this.update('joined', 'Stopping: hold complete; resetting controller.');
      this.command('reset');
      return;
    }
    if (state === 'Hold:1') {
      this.stopPhase = 'holding';
      this.update('joined', 'Stopping: waiting for deceleration.');
      return;
    }
    if (state !== 'Run' && state !== 'Jog') {
      this.stopPhase = 'querying';
      this.update('joined', `Stop waiting for controller (${state}); inspect CNCjs.`);
      return;
    }
    this.stopPhase = 'holding';
    this.update('joined', `Stopping: canceling ${state === 'Jog' ? 'jog' : 'programmed motion'}.`);
    if (state === 'Jog') this.socket.emit('command', this.status.port, 'jogCancel');
    if (state === 'Run') this.requestHold();
  }

  finishStop() {
    this.cancelStopPolling();
    this.stopPhase = 'idle';
    this.stopIntent = 'motion';
    this.stopPort = null;
    this.holdRequest = 'not-requested';
  }

  disconnect() {
    this.clear();
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.socket?.disconnect();
    this.socket = null;
    this.update('disconnected');
  }
}

export function isParentMessage(event, parent, origin) {
  return event.source === parent && event.origin === origin;
}
