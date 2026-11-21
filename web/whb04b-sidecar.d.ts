export const SIDECAR_PROTOCOL: 1;
export const DEFAULT_SIDECAR_URL: string;
/** Close code for a connection taken over by a newer widget; never auto-reconnects. */
export const SIDECAR_CLOSE_SUPERSEDED: 4001;
/** Close code the sidecar uses after a malformed client message. */
export const SIDECAR_CLOSE_MALFORMED: 4400;

export const SidecarLink: Readonly<{
  Idle: 'idle';
  Connecting: 'connecting';
  Open: 'open';
  DeviceMissing: 'device-missing';
  Offline: 'offline';
  Superseded: 'superseded';
  Incompatible: 'incompatible';
}>;

export type SidecarLinkStatus = typeof SidecarLink[keyof typeof SidecarLink];

export interface SidecarLinkDetail {
  link: SidecarLinkStatus;
  url?: string;
  version?: string | null;
  /** WebSocket close code, for offline and superseded. */
  code?: number;
  reason?: string;
  /** Offline cause: never reached, connection lost, or closed for a malformed message (4400). */
  cause?: 'unreachable' | 'lost' | 'rejected';
  /** Protocol reported by an incompatible sidecar. */
  protocol?: unknown;
}

export interface WHB04BSidecarOptions {
  url?: string;
  WebSocket?: new (url: string) => WebSocket;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (id: unknown) => void;
}

/**
 * Same `attach` / `remove` / `use` events as WHB04BWebHID, plus a `link`
 * CustomEvent<SidecarLinkDetail> whenever the sidecar link status changes.
 */
export class WHB04BSidecar extends EventTarget {
  constructor(options?: WHB04BSidecarOptions);
  url: string;
  connected: boolean;
  link: SidecarLinkStatus;
  linkDetail: Omit<SidecarLinkDetail, 'link'>;
  version: string | null;

  static isSupported(): boolean;
  /** Manual connect; resets backoff and reclaims the sidecar after supersede. */
  connect(url?: string): Promise<boolean>;
  /** Automatic connect; does nothing after supersede or a protocol mismatch. */
  tryReconnect(): Promise<boolean>;
  sendDisplayData(frame: Uint8Array): Promise<void>;
  clearDisplay(): Promise<void>;
  destroy(): Promise<void>;
}
