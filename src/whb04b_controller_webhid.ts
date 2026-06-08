// whb04b_controller_webhid
// A browser/WebHID reimplementation of the WHB04B-6 pendant HID layer.
//
// This is a drop-in alternative to `whb04b_controller.ts` (which uses the
// Node-only `node-hid` native addon). It preserves the same public surface
// used by `whb04b_actions.ts` -- an EventEmitter-like object that emits
// 'attach', 'use' and 'remove', plus `sendDisplayData`, `clearDisplay`,
// `isConnected`, `numDevices` and `destroy` -- so the existing actions /
// connector / gcode layers can run unchanged inside a Chromium browser.
//
// Key differences vs node-hid:
//   * Discovery uses navigator.hid.requestDevice (user gesture required) and
//     navigator.hid.getDevices for previously authorised devices.
//   * Input is event driven (the 'inputreport' event) rather than polled.
//   * WebHID strips the numbered-report ID into a separate field on both the
//     input report (event.reportId / event.data) and on sendFeatureReport.
//   * A single HIDDevice aggregates every top-level collection, so the
//     col01/col02 input/output split needed on Windows with node-hid is gone.
//
// Based on the LinuxCNC xhc-whb04b-6 component and the C# WHB04BClient.

//------------------------------------------------------------------------------
// Minimal WebHID ambient declarations (so this compiles without @types/w3c-web-hid)
//------------------------------------------------------------------------------
interface HIDInputReportEvent extends Event {
  device: HIDDevice;
  reportId: number;
  data: DataView;
}
interface HIDDevice extends EventTarget {
  opened: boolean;
  vendorId: number;
  productId: number;
  productName: string;
  collections: unknown[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  addEventListener(type: 'inputreport', listener: (e: HIDInputReportEvent) => void): void;
  removeEventListener(type: 'inputreport', listener: (e: HIDInputReportEvent) => void): void;
}
interface HIDDeviceFilter { vendorId?: number; productId?: number; }
interface HID extends EventTarget {
  getDevices(): Promise<HIDDevice[]>;
  requestDevice(options: { filters: HIDDeviceFilter[] }): Promise<HIDDevice[]>;
}
declare global {
  interface Navigator { readonly hid: HID; }
}

//------------------------------------------------------------------------------
// Constants
//------------------------------------------------------------------------------
const LOGPREFIX = 'WHB04B-WH';

export const WHB04B_VENDOR_ID = 0x10ce;
export const WHB04B_PRODUCT_ID = 0xeb93;

const INPUT_REPORT_ID = 0x04;   // pendant -> host input report id
const OUTPUT_REPORT_ID = 0x06;  // host -> pendant feature report id
const OUTPUT_PAYLOAD_SIZE = 21; // 3 blocks x 7 data bytes
const OUTPUT_CHUNK = 7;         // data bytes per feature report (report id excluded)

// Tiny browser-safe logger (no npmlog).
type Verbosity = number;
function mklog(verbose: Verbosity) {
  return {
    info: (m: string) => verbose >= 1 && console.log(`[${LOGPREFIX}] ${m}`),
    debug: (m: string) => verbose >= 2 && console.log(`[${LOGPREFIX}] ${m}`),
    trace: (m: string) => verbose >= 3 && console.log(`[${LOGPREFIX}] ${m}`),
    warn: (m: string) => console.warn(`[${LOGPREFIX}] ${m}`),
    error: (m: string) => console.error(`[${LOGPREFIX}] ${m}`),
  };
}

//------------------------------------------------------------------------------
// Enums (identical to the node-hid implementation)
//------------------------------------------------------------------------------
export enum KeyPressed {
  None = 0, Key1 = 1, Key2 = 2, Key3 = 3, Key4 = 4, Key5 = 5, Key6 = 6,
  Key7 = 7, Key8 = 8, Key9 = 9, Key10 = 10, Key11 = 11, Key12 = 12,
  Key13 = 13, Key14 = 16, Key15 = 14, Key16 = 15, Unknown = 255,
}

export enum DialPosition {
  Off = 0x06, X = 0x11, Y = 0x12, Z = 0x13, A = 0x14, B = 0x15, C = 0x16,
  Rate2Percent = 0x0d, Rate5Percent = 0x0e, Rate10Percent = 0x0f,
  Rate30Percent = 0x10, Rate60Percent = 0x1a, Rate100Percent = 0x1b,
  Lead = 0x9b, Unknown = 255,
}

export enum JogMode { None = 0, Continuous = 1, Step = 2, Reset = 3 }
export enum CoordinateSystem { XYZ = 0, X1Y1Z1 = 1 }

//------------------------------------------------------------------------------
// Input data structure
//
// `bytes` is the full logical 8-byte packet [reportId, ...7 data bytes], i.e.
// the report id has been re-prepended so the byte offsets match the original
// node-hid implementation exactly (data[2]=button1 ... data[6]=jog).
//------------------------------------------------------------------------------
export class PendantInputData {
  public rawData: Uint8Array;
  public timestamp: Date;
  public firstKeyPressed: KeyPressed;
  public secondKeyPressed: KeyPressed;
  public rightDial: DialPosition;
  public leftDial: DialPosition;
  public jogCountOffset: number;

  constructor(bytes: Uint8Array) {
    this.rawData = bytes;
    this.timestamp = new Date();
    this.firstKeyPressed = PendantInputData.parseKey(bytes.length > 2 ? bytes[2] : 0);
    this.secondKeyPressed = PendantInputData.parseKey(bytes.length > 3 ? bytes[3] : 0);
    this.rightDial = PendantInputData.parseRightDial(bytes.length > 4 ? bytes[4] : 0);
    this.leftDial = PendantInputData.parseLeftDial(bytes.length > 5 ? bytes[5] : 0);
    // jog offset is a signed 8-bit value.
    const raw = bytes.length > 6 ? bytes[6] : 0;
    this.jogCountOffset = raw > 127 ? raw - 256 : raw;
  }

  private static parseKey(v: number): KeyPressed {
    const map: { [k: number]: KeyPressed } = {
      0x00: KeyPressed.None, 0x01: KeyPressed.Key1, 0x02: KeyPressed.Key2,
      0x03: KeyPressed.Key3, 0x04: KeyPressed.Key4, 0x05: KeyPressed.Key5,
      0x06: KeyPressed.Key6, 0x07: KeyPressed.Key7, 0x08: KeyPressed.Key8,
      0x09: KeyPressed.Key9, 0x0a: KeyPressed.Key10, 0x0b: KeyPressed.Key11,
      0x0c: KeyPressed.Key12, 0x0d: KeyPressed.Key13, 0x10: KeyPressed.Key14,
      0x0e: KeyPressed.Key15, 0x0f: KeyPressed.Key16,
    };
    return v in map ? map[v] : KeyPressed.Unknown;
  }

  private static parseRightDial(v: number): DialPosition {
    switch (v) {
      case 0x0d: return DialPosition.Rate2Percent;
      case 0x0e: return DialPosition.Rate5Percent;
      case 0x0f: return DialPosition.Rate10Percent;
      case 0x10: return DialPosition.Rate30Percent;
      case 0x1a: return DialPosition.Rate60Percent;
      case 0x1b: return DialPosition.Rate100Percent;
      case 0x9b: return DialPosition.Lead;
      default: return DialPosition.Unknown;
    }
  }

  private static parseLeftDial(v: number): DialPosition {
    switch (v) {
      case 0x06: return DialPosition.Off;
      case 0x11: return DialPosition.X;
      case 0x12: return DialPosition.Y;
      case 0x13: return DialPosition.Z;
      case 0x14: return DialPosition.A;
      case 0x15: return DialPosition.B;
      case 0x16: return DialPosition.C;
      default: return DialPosition.Unknown;
    }
  }
}

//------------------------------------------------------------------------------
// Display data structure (browser-safe; uses DataView instead of Buffer).
// Produces the identical 21-byte logical frame as the node-hid version.
//------------------------------------------------------------------------------
export class PendantDisplayData {
  private data: Uint8Array;

  constructor(
    jogMode: JogMode = JogMode.None,
    coordinateSystem: CoordinateSystem = CoordinateSystem.XYZ,
    x = 0, y = 0, z = 0, feedRate = 0, spindleRate = 0,
  ) {
    this.data = new Uint8Array(OUTPUT_PAYLOAD_SIZE);
    const dv = new DataView(this.data.buffer);
    const fc = (c: number) => (Math.round(c * 10000) >>> 0);

    let o = 0;
    // Block 1: header + status
    this.data[o++] = 0x06;
    this.data[o++] = jogMode;
    this.data[o++] = coordinateSystem;
    o += 4; // reserved
    // Block 2: X (u32 LE) + Y (u24 LE)
    dv.setUint32(o, fc(x), true); o += 4;
    const yc = fc(y);
    this.data[o++] = yc & 0xff;
    this.data[o++] = (yc >>> 8) & 0xff;
    this.data[o++] = (yc >>> 16) & 0xff;
    // Block 3: Z (u32 LE) + feed (u16 LE) + spindle (u8)
    dv.setUint32(o, fc(z), true); o += 4;
    dv.setUint16(o, feedRate & 0xffff, true); o += 2;
    this.data[o] = spindleRate & 0xff;
  }

  get rawData(): Uint8Array { return this.data; }
}

//------------------------------------------------------------------------------
// Compatibility state object (matches the node-hid implementation).
//------------------------------------------------------------------------------
export interface WHB04BState {
  id: number;
  connected: boolean;
  timestamp: number;
  buttons: { [key: string]: boolean };
  axes: { [key: string]: number };
}

//------------------------------------------------------------------------------
// Minimal EventEmitter (the browser has no Node 'events' module).
//------------------------------------------------------------------------------
type Listener = (...args: any[]) => void;
class TinyEmitter {
  private listeners: { [evt: string]: Listener[] } = {};
  on(evt: string, fn: Listener): this {
    (this.listeners[evt] ||= []).push(fn);
    return this;
  }
  off(evt: string, fn: Listener): this {
    this.listeners[evt] = (this.listeners[evt] || []).filter((l) => l !== fn);
    return this;
  }
  protected emit(evt: string, ...args: any[]): void {
    for (const fn of this.listeners[evt] || []) fn(...args);
  }
}

//------------------------------------------------------------------------------
// Main WebHID controller
//------------------------------------------------------------------------------
export class WHB04BControllerWebHID extends TinyEmitter {
  private device: HIDDevice | null = null;
  private connected = false;
  private deviceCount = 0;
  private previous: string | null = null;
  private verbose: number;
  private log: ReturnType<typeof mklog>;
  private onInput = (e: HIDInputReportEvent) => this.handleInputReport(e);

  constructor(verbose = 1) {
    super();
    this.verbose = verbose;
    this.log = mklog(verbose);
    if (typeof navigator === 'undefined' || !('hid' in navigator)) {
      this.log.error('WebHID is not available in this environment (needs a Chromium browser over https/localhost).');
    }
  }

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'hid' in navigator;
  }

  // Reconnect to a device the user has already authorised in a previous session.
  // Returns true if a device was found and opened. Safe to call on page load
  // (does not require a user gesture).
  async tryReconnect(): Promise<boolean> {
    if (!WHB04BControllerWebHID.isSupported()) return false;
    const devices = await navigator.hid.getDevices();
    const match = devices.find(
      (d) => d.vendorId === WHB04B_VENDOR_ID && d.productId === WHB04B_PRODUCT_ID,
    );
    if (!match) return false;
    await this.attach(match);
    return true;
  }

  // Prompt the user to pick the pendant. MUST be called from a user gesture
  // (e.g. a click handler) per the WebHID security model.
  async requestDevice(): Promise<boolean> {
    if (!WHB04BControllerWebHID.isSupported()) {
      throw new Error('WebHID not supported in this browser.');
    }
    const devices = await navigator.hid.requestDevice({
      filters: [{ vendorId: WHB04B_VENDOR_ID, productId: WHB04B_PRODUCT_ID }],
    });
    if (!devices.length) {
      this.log.warn('No WHB04B-6 device selected.');
      return false;
    }
    await this.attach(devices[0]);
    return true;
  }

  private async attach(device: HIDDevice): Promise<void> {
    this.device = device;
    if (!device.opened) await device.open();
    device.addEventListener('inputreport', this.onInput);
    this.connected = true;
    this.deviceCount = 1;
    this.log.info(`Connected to ${device.productName || 'WHB04B-6'}`);
    this.emit('attach', 0, this.getState());
  }

  private handleInputReport(e: HIDInputReportEvent): void {
    if (e.reportId !== INPUT_REPORT_ID) return;

    // Re-prepend the report id so byte offsets match the node-hid layout:
    // [reportId, random, button1, button2, rightDial, leftDial, jog, checksum]
    const body = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    const bytes = new Uint8Array(body.length + 1);
    bytes[0] = e.reportId;
    bytes.set(body, 1);

    // Dedup identical consecutive packets (matches node-hid behaviour).
    const sig = bytes.join(',');
    if (sig === this.previous) return;
    this.previous = sig;

    const input = new PendantInputData(bytes);
    if (this.verbose >= 3) {
      this.log.trace(
        `Key1:${KeyPressed[input.firstKeyPressed]} Key2:${KeyPressed[input.secondKeyPressed]} ` +
        `R:${DialPosition[input.rightDial]} L:${DialPosition[input.leftDial]} Jog:${input.jogCountOffset}`,
      );
    }
    this.emit('use', 0, input, this.getState());
  }

  // Send a 21-byte display frame as three 0x06 feature reports of 7 bytes each.
  async sendDisplayData(displayData: PendantDisplayData): Promise<void> {
    if (!this.device || !this.connected) {
      this.log.warn('Cannot send display data - device not connected');
      return;
    }
    const payload = displayData.rawData;
    for (let i = 0; i < OUTPUT_PAYLOAD_SIZE; i += OUTPUT_CHUNK) {
      const chunk = new Uint8Array(OUTPUT_CHUNK);
      chunk.set(payload.subarray(i, i + OUTPUT_CHUNK));
      try {
        await this.device.sendFeatureReport(OUTPUT_REPORT_ID, chunk);
      } catch (featureErr) {
        // Fallback to an output report, mirroring the node-hid write() fallback.
        try {
          await this.device.sendReport(OUTPUT_REPORT_ID, chunk);
        } catch (writeErr) {
          this.log.error(`Failed to send display block at ${i}: ${writeErr}`);
          throw writeErr;
        }
      }
    }
  }

  async clearDisplay(): Promise<void> {
    const clear = new PendantDisplayData(JogMode.None, CoordinateSystem.XYZ, 0, 0, 0);
    await this.sendDisplayData(clear);
    await this.sendDisplayData(clear); // send twice for reliability (as in node-hid)
  }

  isConnected(): boolean { return this.connected; }
  numDevices(): number { return this.deviceCount; }

  private getState(): WHB04BState {
    return { id: 0, connected: this.connected, timestamp: Date.now(), buttons: {}, axes: {} };
  }

  async destroy(): Promise<void> {
    if (this.device) {
      this.device.removeEventListener('inputreport', this.onInput);
      try { await this.device.close(); } catch { /* ignore */ }
      this.device = null;
    }
    this.connected = false;
    this.deviceCount = 0;
    this.emit('remove', 0, this.getState());
  }
}
