// whb04b-webhid.js
// Standalone, dependency-free WebHID driver for the WHB04B-6 CNC pendant.
// Runs directly in a Chromium browser (Chrome/Edge/Opera) over https or
// localhost -- no build step, no node-hid. ES module.
//

export const WHB04B_VENDOR_ID = 0x10ce;
export const WHB04B_PRODUCT_ID = 0xeb93;

const INPUT_REPORT_ID = 0x04;
const OUTPUT_REPORT_ID = 0x06;
const OUTPUT_PAYLOAD_SIZE = 21;
const OUTPUT_CHUNK = 7;

export const KeyPressed = {
  0x00: 'None', 0x01: 'Reset', 0x02: 'Stop', 0x03: 'Start/Pause',
  0x04: 'Feed+', 0x05: 'Feed-', 0x06: 'Spindle+', 0x07: 'Spindle-',
  0x08: 'M-Home', 0x09: 'Safe-Z', 0x0a: 'W-Home', 0x0b: 'S on/off',
  0x0c: 'Fn', 0x0d: 'Probe-Z', 0x10: 'Macro-10', 0x0e: 'Continuous',
  0x0f: 'Step',
};

export const RightDial = {
  0x0d: '2% / 0.001', 0x0e: '5% / 0.01', 0x0f: '10% / 0.1',
  0x10: '30% / 1', 0x1a: '60% / 5', 0x1b: '100% / 10', 0x1c: 'Lead', 0x9b: 'Lead',
};

export const LeftDial = {
  0x06: 'Off', 0x11: 'X', 0x12: 'Y', 0x13: 'Z',
  0x14: 'A', 0x15: 'B', 0x16: 'C',
};

export const JogMode = { None: 2, Continuous: 0, Step: 1, Reset: 0x40 };
export const CoordinateSystem = { XYZ: 0, X1Y1Z1: 0x80 };

// LinuxCNC xhc-whb04b-6 usb.h/usb.cc: 21 payload bytes, excluding report ID 0x06.
export function buildDisplayFrame({
  jogMode = JogMode.None, coordinateSystem = CoordinateSystem.XYZ,
  x = 0, y = 0, z = 0, feedRate = 0, spindleRate = 0,
} = {}) {
  const data = new Uint8Array(OUTPUT_PAYLOAD_SIZE);
  const dv = new DataView(data.buffer);
  if (!Object.values(JogMode).includes(jogMode) || !Object.values(CoordinateSystem).includes(coordinateSystem)) {
    throw new RangeError('Unsupported pendant display mode.');
  }
  data.set([0xfe, 0xfd, 0xfe, jogMode | coordinateSystem]);
  for (const [index, coordinate] of [x, y, z].entries()) {
    const scaled = Math.round(Math.abs(coordinate) * 10000);
    if (!Number.isFinite(coordinate) || scaled > 655359999) throw new RangeError('Pendant coordinates must be finite and within ±65535.9999.');
    const offset = 4 + index * 4;
    dv.setUint16(offset, Math.floor(scaled / 10000), true);
    dv.setUint16(offset + 2, (scaled % 10000) | (coordinate < 0 ? 0x8000 : 0), true);
  }
  for (const [index, rate] of [feedRate, spindleRate].entries()) {
    if (!Number.isInteger(rate) || rate < 0 || rate > 65535) throw new RangeError('Pendant rates must be integers from 0 to 65535.');
    dv.setUint16(16 + index * 2, rate, true);
  }
  return data;
}

// Parse an 8-byte logical packet [reportId, random, b1, b2, rDial, lDial, jog, csum].
export function parseInput(bytes) {
  const jogRaw = bytes[6] ?? 0;
  return {
    firstKey: KeyPressed[bytes[2]] ?? 'Unknown',
    secondKey: KeyPressed[bytes[3]] ?? 'Unknown',
    rightDial: RightDial[bytes[4]] ?? 'Unknown',
    leftDial: LeftDial[bytes[5]] ?? 'Unknown',
    // raw byte codes, for callers that need to map to actions/distances
    firstKeyCode: bytes[2], secondKeyCode: bytes[3],
    rightDialCode: bytes[4], leftDialCode: bytes[5],
    jog: jogRaw > 127 ? jogRaw - 256 : jogRaw,
    raw: bytes,
  };
}

export class WHB04BWebHID extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.connected = false;
    this._previous = null;
    this._onInput = (e) => this._handleInput(e);
    // Finish the active frame, then send only the latest pending snapshot.
    this._pendingDisplay = null;
    this._displayWriter = null;
    this._displayEpoch = 0;
    this._deviceClosing = new WeakMap();
    this._deviceOpening = new WeakMap();
    this._lifecycle = 'active';
    // React to physical plug/unplug of the already-authorised device.
    this._onConnect = (e) => { if (this._matches(e.device) && !this.connected) this._attach(e.device).catch(() => {}); };
    this._onDisconnect = (e) => { if (e.device === this.device) this._teardown(true); };
    if (WHB04BWebHID.isSupported()) {
      navigator.hid.addEventListener('connect', this._onConnect);
      navigator.hid.addEventListener('disconnect', this._onDisconnect);
    }
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && 'hid' in navigator;
  }

  _matches(d) {
    return d && d.vendorId === WHB04B_VENDOR_ID && d.productId === WHB04B_PRODUCT_ID;
  }

  async tryReconnect() {
    if (!WHB04BWebHID.isSupported()) return false;
    const epoch = this._displayEpoch;
    const devices = await navigator.hid.getDevices();
    if (epoch !== this._displayEpoch || this._lifecycle !== 'active') return false;
    const match = devices.find((d) => this._matches(d));
    if (!match) return false;
    await this._attach(match);
    return true;
  }

  async requestDevice() {
    if (!WHB04BWebHID.isSupported()) throw new Error('WebHID not supported in this browser.');
    const epoch = this._displayEpoch;
    const devices = await navigator.hid.requestDevice({
      filters: [{ vendorId: WHB04B_VENDOR_ID, productId: WHB04B_PRODUCT_ID }],
    });
    if (epoch !== this._displayEpoch || this._lifecycle !== 'active') return false;
    if (!devices.length) return false;
    await this._attach(devices[0]);
    return true;
  }

  async _attach(device) {
    if (this._lifecycle !== 'active') throw new Error('Pendant is being disconnected.');
    const epoch = ++this._displayEpoch;
    if (this.device && this.device !== device) {
      this.device.removeEventListener('inputreport', this._onInput);
      this._closeDevice(this.device).catch(() => {});
    }
    this.device = device;
    this.connected = false;
    await this._deviceClosing.get(device);
    if (epoch !== this._displayEpoch) throw new Error('Pendant connection was superseded.');
    if (!device.opened) await this._openDevice(device);
    if (epoch !== this._displayEpoch) {
      if (this.device !== device) await this._closeDevice(device);
      throw new Error('Pendant connection was superseded.');
    }
    device.addEventListener('inputreport', this._onInput);
    if (WHB04BWebHID.isSupported()) {
      navigator.hid.addEventListener('connect', this._onConnect);
      navigator.hid.addEventListener('disconnect', this._onDisconnect);
    }
    this.connected = true;
    this.dispatchEvent(new CustomEvent('attach', { detail: { device } }));
  }

  _openDevice(device) {
    const pending = this._deviceOpening.get(device);
    if (pending) return pending;
    const opening = Promise.resolve().then(() => device.open());
    this._deviceOpening.set(device, opening);
    const clear = () => this._deviceOpening.delete(device);
    opening.then(clear, clear);
    return opening;
  }

  _closeDevice(device) {
    const pending = this._deviceClosing.get(device);
    if (pending) return pending;
    // Register before remove listeners can request reconnection.
    const opening = this._deviceOpening.get(device);
    const closing = Promise.resolve(opening).catch(() => {}).then(() => device.opened === false ? undefined : device.close());
    this._deviceClosing.set(device, closing);
    const clear = () => this._deviceClosing.delete(device);
    closing.then(clear, clear);
    return closing;
  }

  // Tear down the current device. Emits 'remove' when emit=true (physical
  // disconnect or destroy); keeps the navigator.hid listeners so a later
  // re-plug of an authorised device auto-attaches.
  _teardown(emit) {
    this._displayEpoch++;
    if (this.device) {
      try { this.device.removeEventListener('inputreport', this._onInput); } catch { /* ignore */ }
      this.device = null;
    }
    this.connected = false;
    this._previous = null;
    if (emit) this.dispatchEvent(new CustomEvent('remove'));
  }

  _handleInput(e) {
    if (!this.connected || e.currentTarget !== this.device) return;
    if (e.reportId !== INPUT_REPORT_ID) return;
    const body = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    const bytes = new Uint8Array(body.length + 1);
    bytes[0] = e.reportId;
    bytes.set(body, 1);
    const sig = bytes.join(',');
    if (sig === this._previous) return;
    this._previous = sig;
    this.dispatchEvent(new CustomEvent('use', { detail: parseInput(bytes) }));
  }

  // Queues the frame behind any in-flight write so chunks never interleave.
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

  async _writeFrame(frame, epoch) {
    if (!this.device || !this.connected) throw new Error('Device not connected.');
    const device = this.device;
    for (let i = 0; i < OUTPUT_PAYLOAD_SIZE; i += OUTPUT_CHUNK) {
      if (epoch !== this._displayEpoch || device !== this.device || !this.connected) throw new Error('Device disconnected during LCD update.');
      const chunk = new Uint8Array(OUTPUT_CHUNK);
      chunk.set(frame.subarray(i, i + OUTPUT_CHUNK));
      let timer;
      try {
        await Promise.race([
          device.sendFeatureReport(OUTPUT_REPORT_ID, chunk),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              // Stop this connection before any further chunks can be sent.
              if (epoch === this._displayEpoch && device === this.device) {
                this._closeDevice(device).catch(() => {});
                this._teardown(true);
              }
              reject(new Error('Pendant LCD feature report timed out; reconnect the pendant.'));
            }, 1000);
          }),
        ]);
      } finally { clearTimeout(timer); }
    }
  }

  async clearDisplay() {
    const f = buildDisplayFrame();
    await this.sendDisplayData(f);
    await this.sendDisplayData(f);
  }

  async destroy() {
    this._lifecycle = 'destroying';
    const dev = this.device;
    const closing = dev ? this._closeDevice(dev) : Promise.resolve();
    this._teardown(true);
    try { await closing; } catch { /* reconnect will report the close failure */ }
    if (WHB04BWebHID.isSupported()) {
      navigator.hid.removeEventListener('connect', this._onConnect);
      navigator.hid.removeEventListener('disconnect', this._onDisconnect);
    }
    this._lifecycle = 'active';
  }
}
