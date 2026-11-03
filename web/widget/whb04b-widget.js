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
import { CncjsSession, isParentMessage } from './cncjs-session.js';
import { Grbl } from './grbl.js';
import { PendantControls, CONFIG_KEY, parseConfig } from './pendant-controls.js';
import { controllerDisplayFrame } from './pendant-display.js';
import { MacroSettings } from './macro-settings.js';
import { wireHelpToggle } from './help-toggle.js';
import { CncjsMacros } from './cncjs-macros.js';
import { SavedMacroRunner } from './macro-runner.js';

//---------------------------------------------------------------------------
// Credential + context acquisition from the parent frame
//---------------------------------------------------------------------------
const ctx = { token: null, port: null, controller: 'Grbl' };
const macroLibrary = new CncjsMacros({ getToken: () => ctx.token });
let macroSettings;
let catalogRequest = 0;

async function refreshMacros() {
  if (!macroSettings) return;
  const request = ++catalogRequest;
  if (!ctx.token) { macroSettings.setStatus('unloaded', 'Connect to CNCjs to load saved macros.'); return; }
  macroSettings.setStatus('loading');
  try {
    const records = await macroLibrary.list();
    if (request !== catalogRequest) return;
    macroSettings.setCatalog(records);
    macroSettings.setStatus('ready');
    if (macroLibrary.notice) {
      macroSettings.setStatus('warning', `${macroSettings.status.textContent} ${macroLibrary.notice}`);
    }
  } catch (error) {
    if (request === catalogRequest) macroSettings.setStatus('error', error.message);
  }
}

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
  $('operationStatus').textContent = m;
  const el = $('log');
  el.textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`;
  el.scrollTop = el.scrollHeight;
}
// Connection pills show faults only; the pendant pill always stays visible.
function setPill(id, on, text) {
  const el = $(id);
  el.textContent = text;
  el.className = 'pill ' + (on ? 'ok' : 'bad');
  el.hidden = on && id !== 'hidPill';
}

//---------------------------------------------------------------------------
// Main
//---------------------------------------------------------------------------
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
    onControllerState('Grbl', session.state);
  },
  onState: onControllerState,
  onConfig: refreshMacros,
});
const grbl = new Grbl(session, log);
const savedMacroRunner = new SavedMacroRunner({ session, grbl, library: macroLibrary, log });
const controls = new PendantControls(grbl, {
  log,
  onSavedMacro: id => savedMacroRunner.run(id),
  onClearance: workHome => savedMacroRunner.runClearance(workHome),
  onProbe: () => savedMacroRunner.runProbe(),
  onSuspend: () => savedMacroRunner.cancel(),
  onMode() { onControllerState('Grbl', session.state); },
  onCoordinates() { onControllerState('Grbl', session.state); },
});
function refreshJogUI() {
  const readout = controls.readout;
  $('mode').textContent = readout.mode;
  $('rd').textContent = readout.rate;
  $('largeStepsLabel').textContent = readout.largeSteps;
}
refreshJogUI();

function refreshCtxUI() {
  setPill('tokenPill', !!ctx.token, ctx.token ? 'token ready' : 'no token');
  setPill('portPill', !!ctx.port, ctx.port ? `port ${ctx.port}` : 'no port');
}

function connectSocket() {
  if (!ctx.token) { log('No token from parent frame; cannot connect socket.'); return; }
  if (typeof io === 'undefined') { log('socket.io client not loaded (open inside CNCjs).'); return; }
  session.connect(ctx.token);
  refreshMacros();
}

// Push live machine coordinates / feed to the pendant LCD.
let displayError = '';
let displayNotice = '';
async function onControllerState(type, state) {
  refreshJogUI();
  if (!pendant.connected) return;
  try {
    const unsupportedAxes = [0x14, 0x15, 0x16].includes(controls.axisCode);
    const unavailable = session.status.phase !== 'joined' || unsupportedAxes;
    const frame = unavailable ? buildDisplayFrame({ jogMode: JogMode.Reset })
      : controllerDisplayFrame(state, { coordinates: controls.coordinates, jogMode: { step: JogMode.Step, continuous: JogMode.Continuous }[controls.mode] ?? JogMode.None, reportUnits: session.settings.settings?.$13 });
    const notice = unsupportedAxes ? 'Pendant LCD: A/B/C positions unavailable on this XYZ GRBL integration; showing RESET.'
      : !frame ? 'Pendant LCD: waiting for complete coordinates, Ov overrides, $13 report units, and G20/G21 mode.' : '';
    if (notice && notice !== displayNotice) log(notice);
    displayNotice = notice;
    if (!frame) return;
    await pendant.sendDisplayData(frame);
    if (displayError) log('Pendant LCD updates restored.');
    displayError = '';
  } catch (error) {
    const message = `Pendant LCD update failed: ${error.message}`;
    if (displayError !== message) log(message);
    displayError = message;
  }
}

function handleInput(d) {
  const previousAxis = controls.axisCode;
  if (!document.hidden) controls.handleInput(d);
  if (previousAxis !== controls.axisCode) onControllerState('Grbl', session.state);

  // mirror to UI
  $('k1').textContent = d.firstKey; $('k2').textContent = d.secondKey;
  $('ld').textContent = d.leftDial;
  refreshJogUI();
  $('jog').textContent = String(d.jog);
}

function wireUI() {
  $('connect').onclick = async () => {
    try { if (!await pendant.requestDevice()) log('No pendant selected.'); }
    catch (err) { log('Pendant error: ' + err.message); }
  };
  $('reconnectSock').onclick = () => { readParentStore(); refreshCtxUI(); connectSocket(); };
  try { controls.setConfig(parseConfig(JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'))); }
  catch (error) { log(`Pendant settings: ${error.message}`); }
  wireHelpToggle($('modeHelpToggle'), $('modeHelp'));
  const settingsStatus = $('settingsStatus');
  // Every edit saves at once. An invalid draft stays on screen with its error
  // but never replaces the last valid saved configuration.
  const save = () => {
    try {
      // valueAsNumber keeps an empty field NaN (rejected) instead of Number('') = 0.
      const value = parseConfig({ macros: macroSettings.getAssignments(), spindleIncrement: $('spindleIncrement').valueAsNumber,
        largeSteps: $('largeSteps').value });
      // Another widget may already have stored this value; only the storage
      // write is skipped then. This widget's runtime always takes the value.
      const serialized = JSON.stringify(value);
      if (serialized !== localStorage.getItem(CONFIG_KEY)) localStorage.setItem(CONFIG_KEY, serialized);
      controls.setConfig(value);
      settingsStatus.dataset.state = 'saved';
      settingsStatus.textContent = 'Settings saved automatically for this browser and CNCjs address.';
    } catch (error) {
      settingsStatus.dataset.state = 'error';
      settingsStatus.textContent = `Not saved: ${error.message}`;
    }
  };
  macroSettings = new MacroSettings({ container: $('macroAssignments'), status: $('macroStatus'),
    refreshButton: $('refreshMacros'), addSelect: $('macroButtonToAdd'), addButton: $('addMacro'),
    emptyState: $('macroEmpty'), onRefresh: refreshMacros, onChange: save });
  macroSettings.setAssignments(controls.config.macros);
  $('spindleIncrement').value = controls.config.spindleIncrement;
  $('largeSteps').value = controls.config.largeSteps;
  for (const id of ['spindleIncrement', 'largeSteps']) $(id).addEventListener('input', save);
}

function boot() {
  wireUI();
  readQuery();
  readParentStore();
  listenParentMessages(refreshCtxUI);
  refreshCtxUI();

  pendant.addEventListener('attach', () => { setPill('hidPill', true, 'pendant ready'); log('Pendant connected.'); onControllerState('Grbl', session.state); });
  pendant.addEventListener('remove', () => { controls.suspend(); grbl.clearOverrides(); controls.keys.clear(); setPill('hidPill', false, 'pendant offline'); log('Pendant removed.'); });
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

