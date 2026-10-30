export const WHB04B_VENDOR_ID: number;
export const WHB04B_PRODUCT_ID: number;

export const KeyPressed: Readonly<Record<number, string>>;
export const RightDial: Readonly<Record<number, string>>;
export const LeftDial: Readonly<Record<number, string>>;

export const JogMode: Readonly<{
  /** MPG indicator. */
  None: 2;
  Continuous: 0;
  Step: 1;
  Reset: 64;
}>;

export const CoordinateSystem: Readonly<{
  XYZ: 0;
  X1Y1Z1: 128;
}>;

export interface DisplayFrameOptions {
  jogMode?: number;
  coordinateSystem?: number;
  /** Coordinates: finite, four decimal places, magnitude at most 65535.9999. */
  x?: number;
  y?: number;
  z?: number;
  /** Unsigned 16-bit integers. The CNCjs widget supplies override percentages. */
  feedRate?: number;
  spindleRate?: number;
}

export interface InputReport {
  firstKey: string;
  secondKey: string;
  rightDial: string;
  leftDial: string;
  firstKeyCode: number;
  secondKeyCode: number;
  rightDialCode: number;
  leftDialCode: number;
  jog: number;
  raw: ArrayLike<number>;
}

export function buildDisplayFrame(options?: DisplayFrameOptions): Uint8Array;
export function parseInput(bytes: ArrayLike<number>): InputReport;

export class WHB04BWebHID extends EventTarget {
  device: HIDDevice | null;
  connected: boolean;

  static isSupported(): boolean;
  tryReconnect(): Promise<boolean>;
  requestDevice(): Promise<boolean>;
  sendDisplayData(frame: Uint8Array): Promise<void>;
  clearDisplay(): Promise<void>;
  destroy(): Promise<void>;
}
