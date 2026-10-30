// Own one CNCjs socket and join only a port already opened by the operator.
export class CncjsSession {
  constructor({ io, origin, onStatus = () => {}, onState = () => {}, schedule = (...args) => setInterval(...args), cancel = (...args) => clearInterval(...args) }) {
    Object.assign(this, { io, origin, onStatus, onState, schedule, cancel });
    this.socket = null;
    this.timer = null;
    this.stopTimer = null;
    this.stopPhase = 'idle';
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
    const interrupted = this.stopPhase !== 'idle';
    this.finishStop();
    if (interrupted) this.stopPhase = 'interrupted';
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
      if (type === 'Grbl') this.onState(type, state);
    });
    on('serialport:read', line => this.stopReport(line));
    on('serialport:list', (ports) => this.join(ports));
    this.timer = this.schedule(() => this.discover(), 2000);
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
    this.pendingPort = target.port;
    this.update('joining');
    const generation = this.generation;
    // CNCjs's open RPC also joins an existing controller and sends its current
    // state. It has no separate join-only RPC, so only in-use ports qualify.
    this.socket.emit('open', target.port, { controllerType: 'Grbl', baudrate: 115200 }, (error) => {
      if (generation !== this.generation || !this.socket?.connected) return;
      this.pendingPort = null;
      if (error) {
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
      return;
    }
    if (this.stopPhase !== 'idle' && !['reset', 'statusreport'].includes(directive)) {
      this.update('joined', 'Command dropped: Stop is waiting for the controller.');
      return;
    }
    if (this.stopPhase === 'interrupted' && directive === 'reset') this.stop();
    if (this.stopPhase !== 'idle' && directive === 'reset') this.stopPhase = 'resetting';
    this.socket.emit('command', this.status.port, directive, data);
  }

  stop() {
    if (!this.socket?.connected || this.status.phase !== 'joined') return;
    if (!['idle', 'interrupted'].includes(this.stopPhase)) return;
    this.stopPhase = 'querying';
    this.update('joined', 'Stopping: waiting for controller status.');
    this.socket.emit('command', this.status.port, 'gcode:stop');
    this.socket.emit('command', this.status.port, 'feeder:stop');
    this.socket.emit('command', this.status.port, 'jogCancel');
    this.command('statusreport');
    // CNCjs's forced stop uses a cached state and a fixed 500 ms reset delay.
    // Explicit reports retain GRBL's Hold substate; never reset during Hold:1.
    const generation = this.generation;
    this.stopTimer = this.schedule(() => {
      if (generation === this.generation && this.stopPhase !== 'idle') this.command('statusreport');
    }, 250);
  }

  stopReport(line) {
    if (['idle', 'interrupted'].includes(this.stopPhase) || this.status.phase !== 'joined') return;
    if (typeof line !== 'string') return;
    if (this.stopPhase === 'resetting') {
      if (!line.startsWith('Grbl ')) return;
      this.stopPhase = 'confirming';
      this.update('joined', 'Stopping: reset received; confirming controller status.');
      this.command('statusreport');
      return;
    }
    const state = /^<([^|>]+)/.exec(line)?.[1];
    if (!state) return;
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
    this.socket.emit('command', this.status.port, state === 'Jog' ? 'jogCancel' : 'feedhold');
  }

  finishStop() {
    if (this.stopTimer !== null) this.cancel(this.stopTimer);
    this.stopTimer = null;
    this.stopPhase = 'idle';
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
