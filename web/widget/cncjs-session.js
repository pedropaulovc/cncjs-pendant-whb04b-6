// Own one CNCjs socket and join only a port already opened by the operator.
export class CncjsSession {
  constructor({ io, origin, onStatus = () => {}, onState = () => {}, schedule = (...args) => setInterval(...args), cancel = (...args) => clearInterval(...args) }) {
    Object.assign(this, { io, origin, onStatus, onState, schedule, cancel });
    this.socket = null;
    this.timer = null;
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
    on('connect_error', (error) => this.update('disconnected', String(error.message || error)));
    on('error', (error) => this.update('disconnected', String(error.message || error)));
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
      this.update(this.status.controller === 'Grbl' ? 'joined' : 'unsupported');
    });
  }

  command(directive, data) {
    if (!this.socket?.connected || this.status.phase !== 'joined') {
      this.update(this.status.phase, 'Command dropped: no joined GRBL controller.');
      return;
    }
    this.socket.emit('command', this.status.port, directive, data);
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
