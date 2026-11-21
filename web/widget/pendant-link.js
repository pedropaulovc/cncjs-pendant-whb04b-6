// Pendant transport selection: browser WebHID, or the native sidecar that keeps
// the pendant working while the browser window is unfocused or hidden.
import { WHB04BWebHID } from '../whb04b-webhid.js';
import { WHB04BSidecar, DEFAULT_SIDECAR_URL, SIDECAR_PROTOCOL } from '../whb04b-sidecar.js';

export const LINK_KEY = 'whb04b-link';
export const DEFAULT_LINK = Object.freeze({ transport: 'webhid', sidecarUrl: DEFAULT_SIDECAR_URL });

export function parseLink(value) {
  const link = Object.fromEntries(Object.entries(DEFAULT_LINK).map(([key, fallback]) => [key, value?.[key] === undefined ? fallback : value[key]]));
  if (!['webhid', 'sidecar'].includes(link.transport)) throw new Error('Pendant link must be WebHID or Sidecar.');
  let url;
  try { url = new URL(link.sidecarUrl); } catch { url = null; }
  if (!url || !['ws:', 'wss:'].includes(url.protocol)) throw new Error('Sidecar URL must be a ws:// or wss:// address.');
  return link;
}

export function createPendant(link, { WebSocket } = {}) {
  if (link.transport !== 'sidecar') return new WHB04BWebHID();
  return new WHB04BSidecar({ url: link.sidecarUrl, ...(WebSocket ? { WebSocket } : {}) });
}

// WebHID loses the device when the window is unfocused, so a hidden tab
// suspends jogging. The sidecar keeps delivering input; jogging continues.
export function hiddenTabPolicy(transport) {
  return transport === 'sidecar' ? 'keep-working' : 'suspend';
}

export function connectLabel(transport) {
  return transport === 'sidecar' ? 'Connect sidecar' : 'Connect pendant';
}

const SIDECAR_PILLS = {
  idle: 'pendant offline', connecting: 'sidecar connecting', open: 'pendant ready (sidecar)',
  'device-missing': 'pendant not plugged in', superseded: 'claimed by another widget', incompatible: 'sidecar version mismatch',
};

export function linkPill(transport, pendant) {
  if (transport !== 'sidecar') return { on: pendant.connected, text: pendant.connected ? 'pendant ready' : 'pendant offline' };
  if (pendant.connected) return { on: true, text: SIDECAR_PILLS.open };
  if (pendant.link === 'offline') return { on: false, text: pendant.linkDetail?.cause === 'unreachable' ? 'sidecar not running' : 'sidecar offline' };
  return { on: false, text: SIDECAR_PILLS[pendant.link] ?? SIDECAR_PILLS.idle };
}

// Log line for a sidecar `link` event; empty when attach/remove already say it.
export function linkMessage({ link, url, code, reason, cause, protocol, version }) {
  if (link === 'connecting') return `Connecting to the pendant sidecar at ${url}.`;
  if (link === 'device-missing') return 'Pendant sidecar is running, but the pendant is not plugged in; waiting for it.';
  if (link === 'superseded') return 'Pendant claimed by another CNCjs pendant widget or tab. Press Connect sidecar here to take it back.';
  if (link === 'incompatible') return `Pendant sidecar${version ? ` ${version}` : ''} speaks protocol ${protocol}; this widget needs protocol ${SIDECAR_PROTOCOL}. Update the sidecar or the widget.`;
  if (link !== 'offline') return '';
  if (cause === 'unreachable') return `Pendant sidecar not running at ${url}; start the WHB04B sidecar app. Retrying automatically.`;
  if (cause === 'rejected') return `Pendant sidecar rejected a message${reason ? ` (${reason})` : ''}; reconnecting.`;
  return `Pendant sidecar connection lost (code ${code}${reason ? `: ${reason}` : ''}); reconnecting.`;
}
