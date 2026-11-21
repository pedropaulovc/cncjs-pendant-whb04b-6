// Pendant transport selection: browser WebHID, or the native sidecar that keeps
// the pendant working while the browser window is unfocused or hidden.
import { WHB04BWebHID } from '../whb04b-webhid.js';
import { WHB04BSidecar, DEFAULT_SIDECAR_URL, SIDECAR_PROTOCOL, SIDECAR_STALE_MS } from '../whb04b-sidecar.js';

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

// Both transports take the same schedule/cancel (the widget's worker timers).
export function createPendant(link, { WebSocket, schedule, cancel } = {}) {
  const timers = schedule && cancel ? { schedule, cancel } : {};
  if (link.transport !== 'sidecar') return new WHB04BWebHID(timers);
  return new WHB04BSidecar({ url: link.sidecarUrl, ...timers, ...(WebSocket ? { WebSocket } : {}) });
}

// The transport of a driver instance, never of the selected link: while a
// switch is in progress the two differ (and the driver is null).
export function transportOf(driver) {
  if (driver instanceof WHB04BSidecar) return 'sidecar';
  return driver instanceof WHB04BWebHID ? 'webhid' : null;
}

// WebHID loses the device when the window is unfocused, so a hidden tab
// suspends jogging. The sidecar keeps delivering input; jogging continues.
// Without a driver (mid-switch) the safe policy applies.
export function hiddenTabPolicy(driver) {
  return transportOf(driver) === 'sidecar' ? 'keep-working' : 'suspend';
}

export function connectLabel(transport) {
  return transport === 'sidecar' ? 'Connect sidecar' : 'Connect pendant';
}

// Manual Connect for the current driver: the sidecar reconnects to its own URL
// (reclaiming it after superseded/forbidden); WebHID opens the device chooser.
export async function connectPendant(driver) {
  const transport = transportOf(driver);
  if (!transport) return 'switching';
  if (transport === 'sidecar') { driver.connect(); return 'requested'; }
  return await driver.requestDevice() ? 'connected' : 'not-selected';
}

const SIDECAR_PILLS = {
  idle: 'pendant offline', connecting: 'sidecar connecting', open: 'pendant ready (sidecar)',
  'device-missing': 'pendant not plugged in', superseded: 'claimed by another widget',
  forbidden: 'origin not allowed', incompatible: 'sidecar version mismatch',
};

export function linkPill(pendant) {
  if (transportOf(pendant) !== 'sidecar') return { on: !!pendant?.connected, text: pendant?.connected ? 'pendant ready' : 'pendant offline' };
  if (pendant.connected) return { on: true, text: SIDECAR_PILLS.open };
  if (pendant.link === 'offline') return { on: false, text: pendant.linkDetail?.cause === 'unreachable' ? 'sidecar not running' : 'sidecar offline' };
  return { on: false, text: SIDECAR_PILLS[pendant.link] ?? SIDECAR_PILLS.idle };
}

// Log line for a sidecar `link` event; empty when attach/remove already say it.
// `origin` is this page's origin (location.origin), named when it is refused.
export function linkMessage({ link, url, code, reason, cause, protocol, version }, { origin = '' } = {}) {
  if (link === 'connecting') return `Connecting to the pendant sidecar at ${url}.`;
  if (link === 'device-missing') return 'Pendant sidecar is running, but the pendant is not plugged in; waiting for it.';
  if (link === 'superseded') return 'Pendant claimed by another CNCjs pendant widget or tab. Press Connect sidecar here to take it back.';
  if (link === 'forbidden') return `Pendant sidecar refused this page's origin ${origin}. Start the sidecar with --allow-origin ${origin}, or add "${origin}" to allowedOrigins in %LOCALAPPDATA%\\WHB04B-Sidecar\\settings.json, then press Connect sidecar.`;
  if (link === 'incompatible') return `Pendant sidecar${version ? ` ${version}` : ''} speaks protocol ${protocol}; this widget needs protocol ${SIDECAR_PROTOCOL}. Update the sidecar or the widget.`;
  if (link !== 'offline') return '';
  if (cause === 'unreachable') return `Pendant sidecar not running at ${url}; start the WHB04B sidecar app. Retrying automatically.`;
  if (cause === 'rejected') return `Pendant sidecar rejected a message${reason ? ` (${reason})` : ''}; reconnecting.`;
  return `Pendant sidecar connection lost (code ${code}${reason ? `: ${reason}` : ''}); reconnecting.`;
}

export function staleMessage(count) {
  return `Pendant: ignored keys and wheel in ${count} late sidecar report${count === 1 ? '' : 's'} (more than ${SIDECAR_STALE_MS} ms old); dial positions still applied.`;
}
