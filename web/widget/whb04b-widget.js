// whb04b-widget.js
// CNCjs custom-widget integration for the WHB04B-6 pendant over WebHID.
//
// Runs inside a same-origin CNCjs custom-widget iframe. It does NOT manage the
// serial connection (the CNCjs app already owns it); it reuses the app's
// session by pulling credentials and the active port FROM THE PARENT FRAME,
// then maps pendant input to grbl commands and pushes machine state to the LCD.
//
// Credentials are obtained, in priority order:
//   1. the `token` query param the parent sets on the iframe src,
//   2. the `{ token, action:{type:'change', payload:{port,controller}} }`
//      message the parent postMessages into the iframe (also gives the port),
//   3. the parent's persisted CNCjs store at localStorage['cnc'] (same-origin
//      read of state.session.token) as a fallback.
//
// socket.io is loaded from the same-origin /socket.io/socket.io.js so the
// client version always matches the CNCjs server (2.x).

import {
  WHB04BWebHID, buildDisplayFrame, JogMode, CoordinateSystem,
} from '../whb04b-webhid.js';
import { CncjsSession, isParentMessage } from './cncjs-session.js';
import { Grbl } from './grbl.js';
import { PendantControls, CONFIG_KEY, parseConfig } from './pendant-controls.js';

//---------------------------------------------------------------------------
// Credential + context acquisition from the parent frame
//---------------------------------------------------------------------------
const ctx = { token: null, port: null, controller: 'Grbl' };

function readQuery() {
  const q = new URLSearchParams(location.search);
  if (q.get('token')) ctx.token = q.get('token');
}

function readParentStore() {
  // Same-origin only: read the CNCjs app's persisted session token.
  try {
    const raw = window.parent.localStorage.getItem('cnc');
    const token = JSON.parse(raw)?.state?.session?.token;
    if (token) ctx.token = ctx.token || token;
  } catch (_) { /* cross-origin or unavailable: ignore */ }
}

// The parent posts { token, version, action:{ type, payload } } into the iframe.
function listenParentMessages(onChange) {
  window.addEventListener('message', (e) => {
    if (!isParentMessage(e, window.parent, location.origin)) return;
    const msg = e.data || {};
    if (msg.token && msg.token !== ctx.token) {
      ctx.token = msg.token;
      connectSocket();
    }
    const action = msg.action || {};
    if (action.type === 'change') {
      const p = action.payload || {};
      if (Object.hasOwn(p, 'port')) session.selectPort(p.port);
      if (p.controller) ctx.controller = p.controller;
      onChange?.();
    }
  });
}

//---------------------------------------------------------------------------
// UI helpers
//---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
function log(m) {
  const el = $('log');
  el.textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`;
  el.scrollTop = el.scrollHeight;
}
function setPill(id, on, text) {
  const el = $(id);
  el.textContent = text;
  el.className = 'pill ' + (on ? 'ok' : 'bad');
}

//---------------------------------------------------------------------------
// Main
//---------------------------------------------------------------------------
let jogMode = JogMode.None;
const pendant = new WHB04BWebHID();
const session = new CncjsSession({
  io: (...args) => io(...args),
  origin: location.origin,
  onStatus(status) {
    if (status.phase !== 'joined') { controls.suspend(); grbl.clearOverrides(); grbl.clearJog(); }
    ctx.port = status.port;
    setPill('sockPill', status.phase === 'joined', status.phase);
    refreshCtxUI();
    if (status.detail) log(status.detail);
  },
  onState: onControllerState,
});
const grbl = new Grbl(session, () => $('thickness')?.valueAsNumber ?? NaN, log);
const controls = new PendantControls(grbl, {
  log,
  onMode(mode) {
    jogMode = { step: JogMode.Step, continuous: JogMode.Continuous }[mode] ?? JogMode.None;
    $('mode').textContent = mode;
    onControllerState('Grbl', session.state);
  },
  onCoordinates() { onControllerState('Grbl', session.state); },
});

function refreshCtxUI() {
  setPill('tokenPill', !!ctx.token, ctx.token ? 'token ✓' : 'no token');
  setPill('portPill', !!ctx.port, ctx.port ? `port ${ctx.port}` : 'no port');
}

function connectSocket() {
  if (!ctx.token) { log('No token from parent frame; cannot connect socket.'); return; }
  if (typeof io === 'undefined') { log('socket.io client not loaded (open inside CNCjs).'); return; }
  session.connect(ctx.token);
}

// Push live machine coordinates / feed to the pendant LCD.
function onControllerState(type, state) {
  const st = state?.status || {};
  const pos = (controls.coordinates === 'machine' ? st.mpos : st.wpos) || {};
  const x = Number(pos.x) || 0, y = Number(pos.y) || 0, z = Number(pos.z) || 0;
  const feed = Number(st.feedrate) || 0;
  const spindle = Number(st.spindle) || 0;
  if (pendant.connected) {
    pendant.sendDisplayData(buildDisplayFrame({ jogMode, coordinateSystem: controls.coordinates === 'work' ? CoordinateSystem.X1Y1Z1 : CoordinateSystem.XYZ, x, y, z, feedRate: feed, spindleRate: spindle }))
      .catch(() => { /* device may be busy */ });
  }
}

function handleInput(d) {
  if (!document.hidden) controls.handleInput(d);

  // mirror to UI
  $('k1').textContent = d.firstKey; $('k2').textContent = d.secondKey;
  $('ld').textContent = d.leftDial; $('rd').textContent = d.rightDial;
  $('jog').textContent = String(d.jog);
}

function wireUI() {
  $('connect').onclick = async () => {
    try { if (!await pendant.requestDevice()) log('No pendant selected.'); }
    catch (err) { log('Pendant error: ' + err.message); }
  };
  $('reconnectSock').onclick = () => { readParentStore(); refreshCtxUI(); connectSocket(); };
  const config = $('config');
  try { controls.setConfig(parseConfig(JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'))); }
  catch (error) { log(`Pendant settings: ${error.message}`); }
  config.value = JSON.stringify(controls.config.macros, null, 2);
  $('stepFeed').value = controls.config.stepFeed;
  $('spindleIncrement').value = controls.config.spindleIncrement;
  $('largeSteps').value = controls.config.largeSteps;
  $('saveConfig').onclick = () => {
    try {
      const value = parseConfig({ macros: JSON.parse(config.value), stepFeed: Number($('stepFeed').value), spindleIncrement: Number($('spindleIncrement').value), largeSteps: $('largeSteps').value });
      controls.setConfig(value);
      localStorage.setItem(CONFIG_KEY, JSON.stringify(value));
      log('Pendant settings saved for this browser and CNCjs address.');
    } catch (error) { log(`Pendant settings: ${error.message}`); }
  };
}

function boot() {
  wireUI();
  readQuery();
  readParentStore();
  listenParentMessages(refreshCtxUI);
  refreshCtxUI();

  pendant.addEventListener('attach', () => { setPill('hidPill', true, 'pendant ✓'); log('Pendant connected.'); });
  pendant.addEventListener('remove', () => { controls.suspend(); grbl.clearOverrides(); controls.keys.clear(); setPill('hidPill', false, 'pendant ✗'); log('Pendant removed.'); });
  pendant.addEventListener('use', (e) => handleInput(e.detail));

  // Re-attach to an already-authorised pendant without a prompt.
  pendant.tryReconnect().then((ok) => ok && log('Re-attached to authorised pendant.')).catch(() => {});

  // Connect the socket using parent creds.
  connectSocket();

  if (!WHB04BWebHID.isSupported()) {
    $('connect').disabled = true;
    log('WebHID unavailable: use Chrome/Edge over https or localhost.');
  }
}

document.addEventListener('DOMContentLoaded', boot);
window.addEventListener('pagehide', () => { controls.suspend(); grbl.clearOverrides(); grbl.clearJog(); session.disconnect(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) controls.suspend(); });

