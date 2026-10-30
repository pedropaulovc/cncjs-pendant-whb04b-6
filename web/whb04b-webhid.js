// whb04b-webhid.js
// Standalone, dependency-free WebHID driver for the WHB04B-6 CNC pendant.
// Runs directly in a Chromium browser (Chrome/Edge/Opera) over https or
// localhost -- no build step, no node-hid. ES module.
//
// This is the hand-written JS twin of src/whb04b_controller_webhid.ts so the
// demo page (index.html) can be opened with no toolchain.

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

export const JogMode = { None: 0, Continuous: 1, Step: 2, Reset: 3 };
export const CoordinateSystem = { XYZ: 0, X1Y1Z1: 1 };

// Build the 21-byte display frame (identical bytes to the node-hid version).
export function buildDisplayFrame({
  jogMode = JogMode.None, coordinateSystem = CoordinateSystem.XYZ,
  x = 0, y = 0, z = 0, feedRate = 0, spindleRate = 0,
} = {}) {
  const data = new Uint8Array(OUTPUT_PAYLOAD_SIZE);
  const dv = new DataView(data.buffer);
  const fc = (c) => (Math.round(c * 10000) >>> 0);
  let o = 0;
  data[o++] = 0x06;
  data[o++] = jogMode;
  data[o++] = coordinateSystem;
  o += 4;
  dv.setUint32(o, fc(x), true); o += 4;
  const yc = fc(y);
  data[o++] = yc & 0xff; data[o++] = (yc >>> 8) & 0xff; data[o++] = (yc >>> 16) & 0xff;
  dv.setUint32(o, fc(z), true); o += 4;
  dv.setUint16(o, feedRate & 0xffff, true); o += 2;
  data[o] = spindleRate & 0xff;
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
    // Serialize LCD writes: sendDisplayData is async and may be called
    // un-awaited on every input event, so chain writes to stop the three
    // feature reports of different frames interleaving on the device.
    this._writeChain = Promise.resolve();
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
    const devices = await navigator.hid.getDevices();
    const match = devices.find((d) => this._matches(d));
    if (!match) return false;
    await this._attach(match);
    return true;
  }

  async requestDevice() {
    if (!WHB04BWebHID.isSupported()) throw new Error('WebHID not supported in this browser.');
    const devices = await navigator.hid.requestDevice({
      filters: [{ vendorId: WHB04B_VENDOR_ID, productId: WHB04B_PRODUCT_ID }],
    });
    if (!devices.length) return false;
    await this._attach(devices[0]);
    return true;
  }

  async _attach(device) {
    this.device = device;
    if (!device.opened) await device.open();
    device.addEventListener('inputreport', this._onInput);
    this.connected = true;
    this.dispatchEvent(new CustomEvent('attach', { detail: { device } }));
  }

  // Tear down the current device. Emits 'remove' when emit=true (physical
  // disconnect or destroy); keeps the navigator.hid listeners so a later
  // re-plug of an authorised device auto-attaches.
  _teardown(emit) {
    if (this.device) {
      try { this.device.removeEventListener('inputreport', this._onInput); } catch { /* ignore */ }
      this.device = null;
    }
    this.connected = false;
    this._previous = null;
    if (emit) this.dispatchEvent(new CustomEvent('remove'));
  }

  _handleInput(e) {
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
    const run = () => this._writeFrame(frame);
    const p = this._writeChain.then(run, run);
    // Keep the chain alive even if this write rejects; return the real result.
    this._writeChain = p.catch(() => {});
    return p;
  }

  async _writeFrame(frame) {
    if (!this.device || !this.connected) throw new Error('Device not connected.');
    for (let i = 0; i < OUTPUT_PAYLOAD_SIZE; i += OUTPUT_CHUNK) {
      const chunk = new Uint8Array(OUTPUT_CHUNK);
      chunk.set(frame.subarray(i, i + OUTPUT_CHUNK));
      try {
        await this.device.sendFeatureReport(OUTPUT_REPORT_ID, chunk);
      } catch {
        await this.device.sendReport(OUTPUT_REPORT_ID, chunk);
      }
    }
  }

  async clearDisplay() {
    const f = buildDisplayFrame();
    await this.sendDisplayData(f);
    await this.sendDisplayData(f);
  }

  async destroy() {
    const dev = this.device;
    this._teardown(true);
    if (dev) { try { await dev.close(); } catch { /* ignore */ } }
    if (WHB04BWebHID.isSupported()) {
      navigator.hid.removeEventListener('connect', this._onConnect);
      navigator.hid.removeEventListener('disconnect', this._onDisconnect);
    }
  }
}
