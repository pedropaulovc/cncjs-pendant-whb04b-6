// whb04b-sidecar.js
// WHB04B-6 transport through the native Windows HID sidecar (protocol v1).
// The sidecar owns the USB device and relays raw reports and LCD frames over a
// loopback WebSocket, so the pendant keeps working while the browser window is
// unfocused or hidden. Same event surface as WHB04BWebHID: attach, remove, use.
//
// Dependency-free ES module; the WebSocket constructor and timers are injectable.

import { buildDisplayFrame, parseInput } from './whb04b-webhid.js';

export const SIDECAR_PROTOCOL = 1;
export const DEFAULT_SIDECAR_URL = 'ws://127.0.0.1:17104/whb04b';
export const SIDECAR_CLOSE_SUPERSEDED = 4001;
export const SIDECAR_CLOSE_MALFORMED = 4400;
export const SIDECAR_CLOSE_FORBIDDEN = 4403;
// Reports older (or further in the future) than this keep only their dials.
export const SIDECAR_STALE_MS = 300;

// idle: not connected (initial or destroyed).
// connecting: socket opening, or open and waiting for hello.
// open: hello received and the pendant is attached.
// device-missing: sidecar reachable, pendant not plugged in.
// offline: sidecar unreachable or connection lost; reconnecting with backoff.
// superseded: another widget took the sidecar; manual connect() only.
// forbidden: the sidecar refused this page's origin (4403); manual connect() only.
// incompatible: sidecar speaks another protocol version; manual connect() only.
export const SidecarLink = Object.freeze({
  Idle: 'idle', Connecting: 'connecting', Open: 'open', DeviceMissing: 'device-missing',
  Offline: 'offline', Superseded: 'superseded', Forbidden: 'forbidden', Incompatible: 'incompatible',
});
const MANUAL_ONLY = [SidecarLink.Superseded, SidecarLink.Forbidden, SidecarLink.Incompatible];

const INPUT_REPORT_ID = 0x04;
const INPUT_BODY_SIZE = 7;
// Body byte offsets: [random, key1, key2, rightDial, leftDial, jog, checksum].
const KEY_SLOTS = [1, 2];
const JOG_BYTE = 5;
// Reset and Stop pass through stale reports: a late Stop/Reset is always safe.
const SAFETY_KEYS = new Set([0x01, 0x02]);
const RECONNECT_MIN = 500;
const RECONNECT_MAX = 5000;

const isBodyArray = value => Array.isArray(value) && value.length >= INPUT_BODY_SIZE
  && value.slice(0, INPUT_BODY_SIZE).every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);

export class WHB04BSidecar extends EventTarget {
  constructor({ url = DEFAULT_SIDECAR_URL, WebSocket: Socket = globalThis.WebSocket,
    schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), now = () => Date.now() } = {}) {
    super();
    Object.assign(this, { url, Socket, schedule, cancel, now });
    this.connected = false;
    this.link = SidecarLink.Idle;
    this.linkDetail = {};
    this.version = null;
    this.socket = null;
    this._superseded = null;
    this._previous = null;
    // Key codes in the last dispatched report, per slot.
    this._dispatchedKeys = [0, 0];
    this._staleCount = 0;
    this._reconnectTimer = null;
    this._reconnectDelay = RECONNECT_MIN;
    this._helloWaiters = [];
    // Finish the active frame, then send only the latest pending snapshot.
    this._pendingDisplay = null;
    this._displayWriter = null;
    this._displayInFlight = null;
    this._displayId = 0;
    this._displayEpoch = 0;
  }

  static isSupported() {
    return typeof globalThis.WebSocket === 'function';
  }

  // Manual connect: resets backoff and reclaims the sidecar after superseded.
  // Resolves true once hello reports an attached pendant, false otherwise.
  connect(url = this.url) {
    this.url = url;
    this._reconnectDelay = RECONNECT_MIN;
    this._close();
    this._setLink(SidecarLink.Connecting, { url });
    return this._open();
  }

  // Automatic (re)connect; never overrides superseded, forbidden, or incompatible.
  async tryReconnect() {
    if (MANUAL_ONLY.includes(this.link)) return false;
    if (this.socket) return this.connected;
    if (this.link === SidecarLink.Idle) this._setLink(SidecarLink.Connecting, { url: this.url });
    return this._open();
  }

  _open() {
    const result = new Promise(resolve => this._helloWaiters.push(resolve));
    let socket;
    try { socket = new this.Socket(this.url); }
    catch (error) {
      this._handleClose(null, { code: 0, reason: String(error.message || error) }, false);
      return result;
    }
    this.socket = socket;
    let opened = false;
    socket.addEventListener('open', () => { opened = true; });
    socket.addEventListener('message', (e) => { if (this.socket === socket) this._handleMessage(socket, e.data); });
    socket.addEventListener('close', (e) => this._handleClose(socket, e, opened));
    // error is always followed by close; close carries the outcome.
    socket.addEventListener('error', () => {});
    return result;
  }

  _settleHello(value) {
    const waiters = this._helloWaiters;
    this._helloWaiters = [];
    for (const resolve of waiters) resolve(value);
  }

  _setLink(link, detail = {}) {
    const same = link === this.link && JSON.stringify(detail) === JSON.stringify(this.linkDetail);
    this.link = link;
    this.linkDetail = detail;
    if (!same) this.dispatchEvent(new CustomEvent('link', { detail: { link, ...detail } }));
  }

  _handleMessage(socket, data) {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'hello') { this._handleHello(socket, message); return; }
    if (message.type === 'device') { this._setDevice(message.state); return; }
    if (message.type === 'input') { this._handleInput(message); return; }
    if (message.type === 'display:ack' || message.type === 'display:error') { this._handleDisplayReply(message); return; }
    if (message.type === 'superseded') this._superseded = socket;
  }

  _handleHello(socket, message) {
    if (message.protocol !== SIDECAR_PROTOCOL) {
      this._close();
      this._setLink(SidecarLink.Incompatible, { url: this.url, protocol: message.protocol, version: message.version ?? null });
      this._settleHello(false);
      return;
    }
    this.version = typeof message.version === 'string' ? message.version : null;
    this._reconnectDelay = RECONNECT_MIN;
    this._setDevice(message.device);
    this._settleHello(this.connected);
  }

  _setDevice(state) {
    if (state !== 'attached') {
      this._detach();
      this._setLink(SidecarLink.DeviceMissing, { url: this.url, version: this.version });
      return;
    }
    const attached = !this.connected;
    this.connected = true;
    if (attached) { this._previous = null; this._dispatchedKeys = [0, 0]; }
    this._setLink(SidecarLink.Open, { url: this.url, version: this.version });
    if (attached) this.dispatchEvent(new CustomEvent('attach', { detail: { device: null, transport: 'sidecar', version: this.version } }));
  }

  _detach() {
    this._displayEpoch++;
    this._failInFlight(new Error('Pendant disconnected during LCD update.'));
    this._endStaleBurst();
    if (!this.connected) return;
    this.connected = false;
    this._previous = null;
    this._dispatchedKeys = [0, 0];
    this.dispatchEvent(new CustomEvent('remove'));
  }

  _handleClose(socket, event, opened) {
    if (socket && socket !== this.socket) return;
    const superseded = event.code === SIDECAR_CLOSE_SUPERSEDED || (socket && this._superseded === socket);
    this.socket = null;
    this._superseded = null;
    this._detach();
    this._settleHello(false);
    const detail = { url: this.url, code: event.code, reason: event.reason || '' };
    if (superseded) { this._setLink(SidecarLink.Superseded, detail); return; }
    if (event.code === SIDECAR_CLOSE_FORBIDDEN) { this._setLink(SidecarLink.Forbidden, detail); return; }
    this._setLink(SidecarLink.Offline, { ...detail, cause: !opened ? 'unreachable' : event.code === SIDECAR_CLOSE_MALFORMED ? 'rejected' : 'lost' });
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer !== null) return;
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(RECONNECT_MAX, delay * 2);
    this._reconnectTimer = this.schedule(() => {
      this._reconnectTimer = null;
      if (this.link !== SidecarLink.Offline || this.socket) return;
      this._open();
    }, delay);
  }

  // Close without reconnecting; the stale socket's close event is ignored.
  _close() {
    if (this._reconnectTimer !== null) this.cancel(this._reconnectTimer);
    this._reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this._superseded = null;
    this._detach();
    this._settleHello(false);
    if (!socket) return;
    try { socket.close(1000); } catch { /* already closing */ }
  }

  // A report without a usable `t` stamp counts as stale.
  _handleInput(message) {
    if (!this.connected || message.reportId !== INPUT_REPORT_ID || !isBodyArray(message.data)) return;
    const body = message.data.slice(0, INPUT_BODY_SIZE);
    const stale = typeof message.t !== 'number' || !(Math.abs(this.now() - message.t) <= SIDECAR_STALE_MS);
    if (stale) {
      this._staleCount++;
      this._dispatch(this._staleBody(body));
      return;
    }
    this._endStaleBurst();
    this._dispatch(body);
  }

  // A late report (frozen page, backed-up socket) never jogs and never makes a
  // press or release edge, except that Stop/Reset always pass. Dials are kept.
  _staleBody(body) {
    const stale = [...body];
    stale[JOG_BYTE] = 0;
    const keys = this._staleKeys(KEY_SLOTS.map(slot => body[slot]));
    KEY_SLOTS.forEach((slot, index) => { stale[slot] = keys[index]; });
    return stale;
  }

  _staleKeys(codes) {
    // A passed Stop/Reset is plain, never Fn+Stop/Fn+Reset (macro slots):
    // every other slot is released.
    if (codes.some(code => SAFETY_KEYS.has(code))) return codes.map(code => SAFETY_KEYS.has(code) ? code : 0);
    // Otherwise each slot keeps its last dispatched key, minus a carried-over
    // Stop/Reset that this stale report no longer holds.
    return this._dispatchedKeys.map(last => SAFETY_KEYS.has(last) ? 0 : last);
  }

  _dispatch(body) {
    const bytes = Uint8Array.from([INPUT_REPORT_ID, ...body]);
    const sig = bytes.join(',');
    if (sig === this._previous) return;
    this._previous = sig;
    this._dispatchedKeys = KEY_SLOTS.map(slot => body[slot]);
    this.dispatchEvent(new CustomEvent('use', { detail: parseInput(bytes) }));
  }

  // One `stale` event per burst, when it ends, with the number of reports.
  _endStaleBurst() {
    const count = this._staleCount;
    this._staleCount = 0;
    if (count) this.dispatchEvent(new CustomEvent('stale', { detail: { count } }));
  }

  _handleDisplayReply(message) {
    const inFlight = this._displayInFlight;
    if (!inFlight || message.id !== inFlight.id) return;
    this._displayInFlight = null;
    if (message.type === 'display:ack') { inFlight.resolve(); return; }
    inFlight.reject(new Error(typeof message.message === 'string' && message.message ? message.message : 'Sidecar LCD write failed.'));
  }

  _failInFlight(error) {
    const inFlight = this._displayInFlight;
    this._displayInFlight = null;
    inFlight?.reject(error);
  }

  // Queues the frame behind the in-flight one; newer snapshots replace older.
  sendDisplayData(frame) {
    return new Promise((resolve, reject) => {
      const waiters = this._pendingDisplay?.waiters || [];
      waiters.push({ resolve, reject });
      this._pendingDisplay = { frame: frame.slice(), waiters, epoch: this._displayEpoch };
      if (!this._displayWriter) this._displayWriter = this._drainDisplay();
    });
  }

  async _drainDisplay() {
    while (this._pendingDisplay) {
      const { frame, waiters, epoch } = this._pendingDisplay;
      this._pendingDisplay = null;
      try {
        await this._writeFrame(frame, epoch);
        for (const waiter of waiters) waiter.resolve();
      } catch (error) {
        for (const waiter of waiters) waiter.reject(error);
      }
    }
    this._displayWriter = null;
  }

  _writeFrame(frame, epoch) {
    if (!this.connected || !this.socket) return Promise.reject(new Error('Device not connected.'));
    if (epoch !== this._displayEpoch) return Promise.reject(new Error('Pendant disconnected during LCD update.'));
    const id = ++this._displayId;
    return new Promise((resolve, reject) => {
      this._displayInFlight = { id, resolve, reject };
      try { this.socket.send(JSON.stringify({ type: 'display', id, frame: Array.from(frame) })); }
      catch (error) { this._failInFlight(error); }
    });
  }

  async clearDisplay() {
    const f = buildDisplayFrame();
    await this.sendDisplayData(f);
    await this.sendDisplayData(f);
  }

  async destroy() {
    this._close();
    this._setLink(SidecarLink.Idle);
  }
}
