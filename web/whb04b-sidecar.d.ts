export const SIDECAR_PROTOCOL: 1;
export const DEFAULT_SIDECAR_URL: string;
/** Close code for a connection taken over by a newer widget; never auto-reconnects. */
export const SIDECAR_CLOSE_SUPERSEDED: 4001;
/** Close code the sidecar uses after a malformed client message. */
export const SIDECAR_CLOSE_MALFORMED: 4400;
/** Close code for a page origin the sidecar does not allow; never auto-reconnects. */
export const SIDECAR_CLOSE_FORBIDDEN: 4403;
/** Input reports whose `t` stamp is further than this from now are stale. */
export const SIDECAR_STALE_MS: 300;

export const SidecarLink: Readonly<{
  Idle: 'idle';
  Connecting: 'connecting';
  Open: 'open';
  DeviceMissing: 'device-missing';
  Offline: 'offline';
  Superseded: 'superseded';
  Forbidden: 'forbidden';
  Incompatible: 'incompatible';
}>;

export type SidecarLinkStatus = typeof SidecarLink[keyof typeof SidecarLink];

export interface SidecarLinkDetail {
  link: SidecarLinkStatus;
  url?: string;
  version?: string | null;
  /** WebSocket close code, for offline, superseded, and forbidden. */
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
  /** Wall clock compared with each input report's `t` stamp; defaults to Date.now. */
  now?: () => number;
}

/**
 * Same `attach` / `remove` / `use` events as WHB04BWebHID, plus a `link`
 * CustomEvent<SidecarLinkDetail> whenever the sidecar link status changes and
 * a `stale` CustomEvent<{ count: number }> when a burst of stale input reports
 * ends. Stale reports are delivered as `use` with no wheel motion; Stop and
 * Reset pass, other keys keep their last delivered state.
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
  /** Automatic connect; does nothing after supersede, a refused origin, or a protocol mismatch. */
  tryReconnect(): Promise<boolean>;
  sendDisplayData(frame: Uint8Array): Promise<void>;
  clearDisplay(): Promise<void>;
  destroy(): Promise<void>;
}
