import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDisplayFrame, parseInput } from 'cncjs-pendant-whb04b-6';
import { WHB04BSidecar, DEFAULT_SIDECAR_URL, SidecarLink } from 'cncjs-pendant-whb04b-6/sidecar';
import { WHB04BWebHID } from '../web/whb04b-webhid.js';
import {
  DEFAULT_LINK, parseLink, createPendant, hiddenTabPolicy, connectLabel, linkPill, linkMessage,
} from '../web/widget/pendant-link.js';

class FakeSocket extends EventTarget {
  constructor(url) {
    super();
    Object.assign(this, { url, sent: [], closed: null });
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code) { this.closed = code; }
  open() { this.dispatchEvent(new Event('open')); }
  receive(message) { this.dispatchEvent(Object.assign(new Event('message'), { data: typeof message === 'string' ? message : JSON.stringify(message) })); }
  hello(device = 'attached', extra = {}) { this.open(); this.receive({ type: 'hello', protocol: 1, version: '1.0.0', device, ...extra }); }
  shut(code = 1006, reason = '') { this.dispatchEvent(Object.assign(new Event('close'), { code, reason })); }
}

function fixture() {
  const sockets = [];
  let time = 0;
  const timers = new Map();
  const Socket = class extends FakeSocket { constructor(url) { super(url); sockets.push(this); } };
  const pendant = new WHB04BSidecar({
    WebSocket: Socket,
    schedule: (fn, ms) => { timers.set(fn, time + ms); return fn; },
    cancel: fn => timers.delete(fn),
  });
  const events = [];
  for (const type of ['attach', 'remove', 'use', 'link']) pendant.addEventListener(type, e => events.push([type, e.detail]));
  const delays = () => [...timers.values()].map(due => due - time);
  const advance = (ms) => {
    time += ms;
    for (const [fn, due] of [...timers]) if (due <= time) { timers.delete(fn); fn(); }
  };
  const of = type => events.filter(([name]) => name === type).map(([, detail]) => detail);
  return { pendant, sockets, timers, delays, advance, events, of, get socket() { return sockets.at(-1); } };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('sidecar subpath exports the default loopback endpoint', () => {
  assert.equal(DEFAULT_SIDECAR_URL, 'ws://127.0.0.1:17104/whb04b');
  assert.equal(new WHB04BSidecar({ WebSocket: FakeSocket }).url, DEFAULT_SIDECAR_URL);
});

test('hello with an attached pendant connects and emits attach once', async () => {
  const f = fixture();
  const result = f.pendant.connect();
  assert.equal(f.socket.url, DEFAULT_SIDECAR_URL);
  assert.equal(f.pendant.link, SidecarLink.Connecting);
  f.socket.hello();
  assert.equal(await result, true);
  assert.equal(f.pendant.connected, true);
  assert.equal(f.pendant.link, SidecarLink.Open);
  assert.equal(f.pendant.version, '1.0.0');
  assert.equal(f.of('attach').length, 1);
  assert.deepEqual(f.of('link').map(({ link }) => link), ['connecting', 'open']);
  f.socket.receive({ type: 'device', state: 'attached' });
  assert.equal(f.of('attach').length, 1, 'A repeated attached state is not a new attachment');
});

test('device transitions map to device-missing, attach, and remove', async () => {
  const f = fixture();
  const result = f.pendant.connect();
  f.socket.hello('detached');
  assert.equal(await result, false);
  assert.equal(f.pendant.connected, false);
  assert.equal(f.pendant.link, SidecarLink.DeviceMissing);
  assert.equal(f.of('attach').length, 0);
  f.socket.receive({ type: 'device', state: 'attached' });
  assert.equal(f.pendant.connected, true);
  assert.equal(f.of('attach').length, 1);
  f.socket.receive({ type: 'device', state: 'detached' });
  assert.equal(f.pendant.connected, false);
  assert.equal(f.pendant.link, SidecarLink.DeviceMissing);
  assert.equal(f.of('remove').length, 1);
  assert.equal(f.sockets.length, 1, 'A detached pendant keeps the sidecar connection');
});

test('input re-prepends the report ID, parses like WebHID, and drops identical consecutive reports', () => {
  const f = fixture();
  f.pendant.connect();
  f.socket.receive({ type: 'input', reportId: 4, data: [1, 2, 0, 0x0f, 0x11, 1, 0] });
  assert.equal(f.of('use').length, 0, 'Input before hello/attach is ignored');
  f.socket.hello();
  const body = [0x5a, 0x0c, 0x04, 0x0f, 0x11, 0xff, 0x99];
  f.socket.receive({ type: 'input', reportId: 4, data: body });
  f.socket.receive({ type: 'input', reportId: 4, data: body });
  f.socket.receive({ type: 'input', reportId: 4, data: [0x5a, 0, 0, 0x0f, 0x11, 0, 0x99] });
  f.socket.receive({ type: 'input', reportId: 4, data: body });
  const uses = f.of('use');
  assert.equal(uses.length, 3);
  assert.deepEqual(uses[0], parseInput(Uint8Array.from([4, ...body])));
  assert.equal(uses[0].firstKey, 'Fn');
  assert.equal(uses[0].secondKey, 'Feed+');
  assert.equal(uses[0].jog, -1);
  assert.deepEqual([...uses[0].raw], [4, ...body]);
  assert.equal(uses[1].jog, 0);
  for (const bad of [{ reportId: 6, data: body }, { reportId: 4, data: body.slice(1) }, { reportId: 4, data: [...body.slice(1), 256] }, { reportId: 4, data: 'x' }]) {
    f.socket.receive({ type: 'input', ...bad });
  }
  f.socket.receive('not json');
  f.socket.receive({ type: 'future-message' });
  assert.equal(f.of('use').length, 3);
});

test('reattach resets input dedupe so the first report after reconnect is delivered', () => {
  const f = fixture();
  f.pendant.connect();
  f.socket.hello();
  const body = [1, 0, 0, 0x0f, 0x11, 0, 0];
  f.socket.receive({ type: 'input', reportId: 4, data: body });
  f.socket.receive({ type: 'device', state: 'detached' });
  f.socket.receive({ type: 'device', state: 'attached' });
  f.socket.receive({ type: 'input', reportId: 4, data: body });
  assert.equal(f.of('use').length, 2);
});

test('display keeps one frame in flight, coalesces pending snapshots, and settles on ack', async () => {
  const f = fixture();
  f.pendant.connect();
  f.socket.hello();
  const frames = [1, 2, 3].map(x => buildDisplayFrame({ x }));
  const settled = [];
  const first = f.pendant.sendDisplayData(frames[0]).then(() => settled.push('first'));
  const second = f.pendant.sendDisplayData(frames[1]).then(() => settled.push('second'));
  const third = f.pendant.sendDisplayData(frames[2]).then(() => settled.push('third'));
  await flush();
  assert.deepEqual(f.socket.sent, [{ type: 'display', id: 1, frame: [...frames[0]] }]);
  f.socket.receive({ type: 'display:ack', id: 99 });
  await flush();
  assert.equal(f.socket.sent.length, 1, 'An unknown ack id does not release the frame');
  f.socket.receive({ type: 'display:ack', id: 1 });
  await first;
  await flush();
  assert.deepEqual(f.socket.sent.at(-1), { type: 'display', id: 2, frame: [...frames[2]] }, 'Only the newest pending snapshot is sent');
  assert.equal(f.socket.sent.length, 2);
  f.socket.receive({ type: 'display:ack', id: 2 });
  await Promise.all([second, third]);
  assert.deepEqual(settled, ['first', 'second', 'third']);
});

test('display:error rejects that frame and the next frame still goes out', async () => {
  const f = fixture();
  f.pendant.connect();
  f.socket.hello();
  const failed = f.pendant.sendDisplayData(buildDisplayFrame({ x: 1 }));
  await flush();
  f.socket.receive({ type: 'display:error', id: 1, message: 'Pendant LCD feature report timed out.' });
  await assert.rejects(failed, /timed out/);
  const next = f.pendant.sendDisplayData(buildDisplayFrame({ x: 2 }));
  await flush();
  assert.equal(f.socket.sent.at(-1).id, 2);
  f.socket.receive({ type: 'display:ack', id: 2 });
  await next;
});

test('clearDisplay sends two blank frames in order', async () => {
  const f = fixture();
  f.pendant.connect();
  f.socket.hello();
  const cleared = f.pendant.clearDisplay();
  await flush();
  f.socket.receive({ type: 'display:ack', id: 1 });
  await flush();
  f.socket.receive({ type: 'display:ack', id: 2 });
  await cleared;
  assert.deepEqual(f.socket.sent.map(({ frame }) => frame), [[...buildDisplayFrame()], [...buildDisplayFrame()]]);
});

test('display without an attached pendant rejects without sending', async () => {
  const f = fixture();
  await assert.rejects(f.pendant.sendDisplayData(buildDisplayFrame()), /not connected/);
  f.pendant.connect();
  f.socket.hello('detached');
  await assert.rejects(f.pendant.sendDisplayData(buildDisplayFrame()), /not connected/);
  assert.deepEqual(f.socket.sent, []);
});

for (const [name, disconnect] of [
  ['socket close', f => f.socket.shut(1006)],
  ['device detach', f => f.socket.receive({ type: 'device', state: 'detached' })],
  ['destroy', f => f.pendant.destroy()],
]) test(`${name} rejects the in-flight frame and every pending waiter`, async () => {
  const f = fixture();
  f.pendant.connect();
  f.socket.hello();
  const inFlight = f.pendant.sendDisplayData(buildDisplayFrame({ x: 1 }));
  await flush();
  const pending = [f.pendant.sendDisplayData(buildDisplayFrame({ x: 2 })), f.pendant.sendDisplayData(buildDisplayFrame({ x: 3 }))];
  const socket = f.socket;
  disconnect(f);
  await assert.rejects(inFlight, /disconnected/);
  for (const waiter of pending) await assert.rejects(waiter, /not connected|disconnected/);
  assert.equal(socket.sent.length, 1, 'No frame is sent after the pendant goes away');
  assert.equal(f.of('remove').length, 1);
  socket.receive({ type: 'display:ack', id: 1 });
});

test('superseded close 4001 never auto-reconnects; manual connect reclaims', async () => {
  const f = fixture();
  f.pendant.connect();
  f.socket.hello();
  f.socket.receive({ type: 'superseded' });
  f.socket.shut(4001, 'superseded');
  assert.equal(f.pendant.link, SidecarLink.Superseded);
  assert.equal(f.pendant.connected, false);
  assert.equal(f.of('remove').length, 1);
  assert.equal(f.timers.size, 0, 'No reconnect timer after 4001');
  assert.equal(await f.pendant.tryReconnect(), false);
  f.advance(60000);
  assert.equal(f.sockets.length, 1);
  const reclaimed = f.pendant.connect();
  assert.equal(f.sockets.length, 2);
  f.socket.hello();
  assert.equal(await reclaimed, true);
  assert.equal(f.pendant.link, SidecarLink.Open);
});

test('a superseded message wins even if the close code is lost', () => {
  const f = fixture();
  f.pendant.connect();
  f.socket.hello();
  f.socket.receive({ type: 'superseded' });
  f.socket.shut(1006);
  assert.equal(f.pendant.link, SidecarLink.Superseded);
  assert.equal(f.timers.size, 0);
});

test('other closes reconnect with 0.5 s doubling backoff capped at 5 s, reset by hello', async () => {
  const f = fixture();
  f.pendant.connect();
  f.socket.shut(1006);
  assert.equal(f.pendant.link, SidecarLink.Offline);
  assert.equal(f.pendant.linkDetail.cause, 'unreachable');
  const observed = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    assert.equal(f.timers.size, 1);
    const [delay] = f.delays();
    observed.push(delay);
    const sockets = f.sockets.length;
    f.advance(delay - 1);
    assert.equal(f.sockets.length, sockets, 'No reconnect before the backoff delay');
    f.advance(1);
    assert.equal(f.sockets.length, sockets + 1);
    f.socket.shut(1006);
  }
  assert.deepEqual(observed, [500, 1000, 2000, 4000, 5000, 5000]);
  assert.equal(f.of('link').filter(({ link }) => link === 'offline').length, 1, 'Retries do not repeat the same offline status');
  f.advance(f.delays()[0]);
  f.socket.hello();
  assert.equal(f.pendant.link, SidecarLink.Open);
  f.socket.shut(1001, 'going away');
  assert.equal(f.pendant.linkDetail.cause, 'lost');
  assert.deepEqual(f.delays(), [500], 'A successful hello resets the backoff');
});

test('close 4400 reports the rejected message and reconnects with backoff', () => {
  const f = fixture();
  f.pendant.connect();
  f.socket.hello();
  f.socket.shut(4400, 'frame must have 21 bytes');
  assert.equal(f.pendant.link, SidecarLink.Offline);
  assert.deepEqual(f.of('link').at(-1), { link: 'offline', url: DEFAULT_SIDECAR_URL, code: 4400, reason: 'frame must have 21 bytes', cause: 'rejected' });
  assert.deepEqual(f.delays(), [500]);
  f.advance(500);
  assert.equal(f.sockets.length, 2);
});

test('a different protocol version stops without reconnecting', async () => {
  const f = fixture();
  const result = f.pendant.connect();
  f.socket.hello('attached', { protocol: 2, version: '2.0.0' });
  assert.equal(await result, false);
  assert.equal(f.pendant.link, SidecarLink.Incompatible);
  assert.equal(f.socket.closed, 1000);
  assert.equal(f.pendant.connected, false);
  assert.equal(f.of('attach').length, 0);
  f.socket.shut(1000);
  assert.equal(f.timers.size, 0);
  assert.equal(await f.pendant.tryReconnect(), false);
});

test('destroy closes the socket, cancels reconnects, and ignores the stale close', async () => {
  const f = fixture();
  f.pendant.connect();
  f.socket.shut(1006);
  assert.equal(f.timers.size, 1);
  f.advance(500);
  const socket = f.socket;
  socket.hello();
  await f.pendant.destroy();
  assert.equal(socket.closed, 1000);
  assert.equal(f.pendant.link, SidecarLink.Idle);
  assert.equal(f.of('remove').length, 1);
  socket.shut(1000);
  socket.receive({ type: 'input', reportId: 4, data: [1, 0, 0, 0x0f, 0x11, 1, 0] });
  assert.equal(f.timers.size, 0);
  assert.equal(f.of('use').length, 0);
  f.advance(60000);
  assert.equal(f.sockets.length, 2);
});

test('connect to a new URL replaces the old socket without reconnecting it', () => {
  const f = fixture();
  f.pendant.connect();
  const old = f.socket;
  old.hello();
  f.pendant.connect('ws://127.0.0.1:17200/whb04b');
  assert.equal(old.closed, 1000);
  assert.equal(f.socket.url, 'ws://127.0.0.1:17200/whb04b');
  old.shut(1000);
  assert.equal(f.timers.size, 0);
  assert.equal(f.pendant.link, SidecarLink.Connecting);
});

test('tryReconnect connects once from idle and reuses a live socket', async () => {
  const f = fixture();
  const result = f.pendant.tryReconnect();
  assert.equal(f.sockets.length, 1);
  f.socket.hello();
  assert.equal(await result, true);
  assert.equal(await f.pendant.tryReconnect(), true);
  assert.equal(f.sockets.length, 1);
});

test('pendant link settings default to WebHID and validate the sidecar URL', () => {
  assert.deepEqual(parseLink({}), { transport: 'webhid', sidecarUrl: DEFAULT_SIDECAR_URL });
  assert.deepEqual(DEFAULT_LINK, parseLink(undefined));
  assert.deepEqual(parseLink({ transport: 'sidecar', sidecarUrl: 'wss://localhost:9/x' }), { transport: 'sidecar', sidecarUrl: 'wss://localhost:9/x' });
  assert.throws(() => parseLink({ transport: 'serial' }), /WebHID or Sidecar/);
  for (const sidecarUrl of ['http://127.0.0.1:17104/whb04b', 'nonsense', '', 5]) assert.throws(() => parseLink({ transport: 'sidecar', sidecarUrl }), /ws:\/\//);
});

test('createPendant builds the selected transport', () => {
  assert.ok(createPendant({ transport: 'webhid', sidecarUrl: DEFAULT_SIDECAR_URL }) instanceof WHB04BWebHID);
  const sidecar = createPendant({ transport: 'sidecar', sidecarUrl: 'ws://127.0.0.1:1/x' }, { WebSocket: FakeSocket });
  assert.ok(sidecar instanceof WHB04BSidecar);
  assert.equal(sidecar.url, 'ws://127.0.0.1:1/x');
  assert.equal(sidecar.Socket, FakeSocket);
});

test('only the sidecar keeps handling input while the tab is hidden', () => {
  assert.equal(hiddenTabPolicy('sidecar'), 'keep-working');
  assert.equal(hiddenTabPolicy('webhid'), 'suspend');
  assert.equal(connectLabel('sidecar'), 'Connect sidecar');
  assert.equal(connectLabel('webhid'), 'Connect pendant');
});

test('pendant pill distinguishes sidecar not running, pendant unplugged, and claimed elsewhere', () => {
  const pill = (link, extra = {}) => linkPill('sidecar', { connected: false, link, linkDetail: {}, ...extra });
  assert.deepEqual(linkPill('webhid', { connected: true }), { on: true, text: 'pendant ready' });
  assert.deepEqual(linkPill('webhid', { connected: false }), { on: false, text: 'pendant offline' });
  assert.deepEqual(pill('open', { connected: true }), { on: true, text: 'pendant ready (sidecar)' });
  assert.deepEqual(pill('offline', { linkDetail: { cause: 'unreachable' } }), { on: false, text: 'sidecar not running' });
  assert.deepEqual(pill('offline', { linkDetail: { cause: 'lost' } }), { on: false, text: 'sidecar offline' });
  assert.deepEqual(pill('device-missing'), { on: false, text: 'pendant not plugged in' });
  assert.deepEqual(pill('superseded'), { on: false, text: 'claimed by another widget' });
  assert.deepEqual(pill('incompatible'), { on: false, text: 'sidecar version mismatch' });
  assert.deepEqual(pill('connecting'), { on: false, text: 'sidecar connecting' });
  assert.deepEqual(pill('idle'), { on: false, text: 'pendant offline' });
});

test('link log messages explain each sidecar state', () => {
  const url = DEFAULT_SIDECAR_URL;
  assert.match(linkMessage({ link: 'offline', url, cause: 'unreachable' }), /not running at ws:\/\/127\.0\.0\.1:17104\/whb04b.*Retrying/);
  assert.match(linkMessage({ link: 'offline', url, cause: 'lost', code: 1006 }), /connection lost \(code 1006\); reconnecting/);
  assert.match(linkMessage({ link: 'offline', url, cause: 'rejected', code: 4400, reason: 'bad frame' }), /rejected a message \(bad frame\)/);
  assert.match(linkMessage({ link: 'superseded', url }), /another CNCjs pendant widget.*Connect sidecar/);
  assert.match(linkMessage({ link: 'device-missing', url }), /not plugged in/);
  assert.equal(linkMessage({ link: 'incompatible', url, protocol: 2, version: '2.0.0' }), 'Pendant sidecar 2.0.0 speaks protocol 2; this widget needs protocol 1. Update the sidecar or the widget.');
  assert.equal(linkMessage({ link: 'open', url }), '', 'attach already logs the connection');
  assert.equal(linkMessage({ link: 'idle' }), '');
});
