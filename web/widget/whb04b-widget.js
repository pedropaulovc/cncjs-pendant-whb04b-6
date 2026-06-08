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
  WHB04BWebHID, buildDisplayFrame, JogMode,
} from '../whb04b-webhid.js';

//---------------------------------------------------------------------------
// grbl feed rates / step distances per right-dial code (from whb04b_actions)
//---------------------------------------------------------------------------
const FEED_RATES = {
  0x0d: 50, 0x0e: 125, 0x0f: 250, 0x10: 750, 0x1a: 1500, 0x1b: 2500, 0x9b: 3000,
};
const STEP_DISTANCES = {
  0x0d: 0.001, 0x0e: 0.01, 0x0f: 0.1, 0x10: 1.0, 0x1a: 10.0, 0x1b: 50.0, 0x9b: 100.0,
};
const AXIS_BY_CODE = { 0x11: 'X', 0x12: 'Y', 0x13: 'Z', 0x14: 'A', 0x15: 'B', 0x16: 'C' };

// key byte codes -> action name (grbl)
const RESET = 0x01, STOP = 0x02, START = 0x03, MHOME = 0x08, SAFEZ = 0x09,
  WHOME = 0x0a, SPINDLE = 0x0b, PROBEZ = 0x0d, CONT = 0x0e, STEP = 0x0f;

const Z_SAFE = -5.0;          // machine Z deemed safe to travel
let zProbeThickness = 20.0;   // touch-plate thickness (mm)

//---------------------------------------------------------------------------
// Credential + context acquisition from the parent frame
//---------------------------------------------------------------------------
const ctx = { token: null, host: '', port: null, controller: 'Grbl' };

function readQuery() {
  const q = new URLSearchParams(location.search);
  if (q.get('token')) ctx.token = q.get('token');
  if (q.get('host')) ctx.host = q.get('host');
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
    const msg = e.data || {};
    if (msg.token) ctx.token = msg.token;
    const action = msg.action || {};
    if (action.type === 'change') {
      const p = action.payload || {};
      if (p.port) ctx.port = p.port;
      if (p.controller) ctx.controller = p.controller;
      onChange?.();
    }
  });
}

//---------------------------------------------------------------------------
// grbl command sender over the CNCjs socket (reusing the app's open port)
//---------------------------------------------------------------------------
class Grbl {
  constructor(getSocket, getPort) { this._socket = getSocket; this._port = getPort; }
  _cmd(directive, data) {
    const s = this._socket();
    const port = this._port();
    if (!s || !port) { log(`drop (${!s ? 'no socket' : 'no port'}): ${directive} ${data ?? ''}`); return; }
    s.emit('command', port, directive, data);
  }
  gcode(g) { this._cmd('gcode', g); }
  reset() { this._cmd('reset'); }
  stop() { this._cmd('stop'); }
  cyclestart() { this._cmd('cyclestart'); }
  homing() { this._cmd('homing'); }
  spindleOff() { this.gcode('M5'); }
  safeZ() { this.gcode(`G53 G0 G90 Z${Z_SAFE}`); }
  wcsHome() { this.safeZ(); this.gcode('G54 G0 G90 X0 Y0'); }
  probeZ() {
    const dz = Number(zProbeThickness) + 0.001;
    this.gcode('G91');
    this.gcode('G38.2 Z-50 F120');
    this.gcode(`G10 L20 P1 Z${dz}`);
    this.gcode('G0 Z3');
    this.gcode('G90');
  }
  jog(axis, signedDetents, rightCode) {
    const step = STEP_DISTANCES[rightCode] ?? 0.1;
    const feed = FEED_RATES[rightCode] ?? 500;
    const dist = (signedDetents * step).toFixed(4);
    this.gcode(`$J=G91 ${axis}${dist} F${feed}`);
  }
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
let socket = null;
let jogMode = JogMode.Step;
const pendant = new WHB04BWebHID();
const grbl = new Grbl(() => socket, () => ctx.port);

function refreshCtxUI() {
  setPill('tokenPill', !!ctx.token, ctx.token ? 'token ✓' : 'no token');
  setPill('portPill', !!ctx.port, ctx.port ? `port ${ctx.port}` : 'no port');
}

function connectSocket() {
  if (!ctx.token) { log('No token from parent frame; cannot connect socket.'); return; }
  if (typeof io === 'undefined') { log('socket.io client not loaded (open inside CNCjs).'); return; }
  // Same-origin connect; ctx.host is normally empty when mounted in CNCjs.
  socket = io(ctx.host || undefined, { query: `token=${ctx.token}` });
  socket.on('connect', () => { setPill('sockPill', true, 'socket ✓'); log('Socket connected to CNCjs.'); });
  socket.on('error', () => log('Socket error from CNCjs.'));
  socket.on('disconnect', () => { setPill('sockPill', false, 'socket ✗'); log('Socket disconnected.'); });
  socket.on('serialport:open', (info) => { if (info?.port) { ctx.port = info.port; refreshCtxUI(); log(`Serial open: ${info.port}`); } });
  socket.on('controller:state', (type, state) => onControllerState(type, state));
}

// Push live machine coordinates / feed to the pendant LCD.
function onControllerState(type, state) {
  const st = state?.status || {};
  const pos = st.wpos || st.mpos || {};
  const x = Number(pos.x) || 0, y = Number(pos.y) || 0, z = Number(pos.z) || 0;
  const feed = Number(st.feedrate) || 0;
  const spindle = Number(st.spindle) || 0;
  if (pendant.connected) {
    pendant.sendDisplayData(buildDisplayFrame({ jogMode, x, y, z, feedRate: feed, spindleRate: spindle }))
      .catch(() => { /* device may be busy */ });
  }
}

function handleInput(d) {
  // buttons
  const onKey = (code) => {
    switch (code) {
      case RESET: grbl.reset(); break;
      case STOP: grbl.stop(); break;
      case START: grbl.cyclestart(); break;
      case MHOME: grbl.homing(); break;
      case SAFEZ: grbl.safeZ(); break;
      case WHOME: grbl.wcsHome(); break;
      case SPINDLE: grbl.spindleOff(); break;
      case PROBEZ: grbl.probeZ(); break;
      case CONT: jogMode = JogMode.Continuous; log('Jog mode: continuous'); break;
      case STEP: jogMode = JogMode.Step; log('Jog mode: step'); break;
      default: break;
    }
  };
  if (d.firstKeyCode) onKey(d.firstKeyCode);
  if (d.secondKeyCode) onKey(d.secondKeyCode);

  // jog wheel
  if (d.jog !== 0) {
    const axis = AXIS_BY_CODE[d.leftDialCode];
    if (axis) {
      // continuous spins the same jog faster (higher feed dial behaviour)
      grbl.jog(axis, d.jog, d.rightDialCode);
    }
  }

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
  const thick = $('thickness');
  if (thick) thick.onchange = () => { zProbeThickness = parseFloat(thick.value) || 20; };
}

function boot() {
  wireUI();
  readQuery();
  readParentStore();
  listenParentMessages(refreshCtxUI);
  refreshCtxUI();

  pendant.addEventListener('attach', () => { setPill('hidPill', true, 'pendant ✓'); log('Pendant connected.'); });
  pendant.addEventListener('remove', () => { setPill('hidPill', false, 'pendant ✗'); log('Pendant removed.'); });
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
