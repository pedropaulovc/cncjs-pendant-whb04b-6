import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDisplayFrame,
  CoordinateSystem,
  JogMode,
  parseInput,
  WHB04BWebHID,
} from 'cncjs-pendant-whb04b-6';
import { WHB04BWebHID as WHB04BWebHIDFromAlias } from 'cncjs-pendant-whb04b-6/webhid';

test('webhid subpath resolves to the public driver entry point', () => {
  assert.equal(WHB04BWebHIDFromAlias, WHB04BWebHID);
});

// Independently specified from LinuxCNC usb.h / usb.cc at
// https://github.com/LinuxCNC/linuxcnc/tree/24e84c4506b41634240f7087f0295e361a954886/src/hal/user_comps/xhc-whb04b-6
test('buildDisplayFrame matches the LinuxCNC packed LCD protocol', () => {
  const frame = buildDisplayFrame({
    jogMode: JogMode.Step,
    coordinateSystem: CoordinateSystem.X1Y1Z1,
    x: 1.2345,
    y: -2.6789,
    z: 300.0001,
    feedRate: 1500,
    spindleRate: 12000,
  });

  assert.deepEqual([...frame], [
    0xfe, 0xfd, 0xfe, 0x81,
    0x01, 0x00, 0x29, 0x09,
    0x02, 0x00, 0x85, 0x9a,
    0x2c, 0x01, 0x01, 0x00,
    0xdc, 0x05, 0xe0, 0x2e, 0x00,
  ]);
});

test('display flags encode CON, STP, MPG, RESET and relative coordinates', () => {
  for (const [mode, expected] of [[JogMode.Continuous, 0], [JogMode.Step, 1], [JogMode.None, 2], [JogMode.Reset, 64]]) {
    assert.equal(buildDisplayFrame({ jogMode: mode })[3], expected);
    assert.equal(buildDisplayFrame({ jogMode: mode, coordinateSystem: CoordinateSystem.X1Y1Z1 })[3], expected | 128);
  }
});

test('coordinate rounding carries into integer part and preserves negative fractions', () => {
  assert.deepEqual([...buildDisplayFrame({ x: 1.99996, y: -0.0001, z: -65535.9999 }).slice(4, 16)],
    [2, 0, 0, 0, 0, 0, 1, 128, 255, 255, 15, 167]);
});

test('invalid display values fail instead of wrapping into believable readings', () => {
  for (const x of [NaN, Infinity, -Infinity, 65536, -65536]) assert.throws(() => buildDisplayFrame({ x }), RangeError);
  for (const spindleRate of [-1, 65536, NaN, 1.5]) assert.throws(() => buildDisplayFrame({ spindleRate }), RangeError);
});

test('WebHID sends three seven-byte payloads with report ID supplied separately', async () => {
  const pendant = new WHB04BWebHID();
  const reports = [];
  pendant.connected = true;
  pendant.device = { async sendFeatureReport(id, bytes) { reports.push([id, [...bytes]]); } };
  await pendant.sendDisplayData(buildDisplayFrame({ x: 1.2345, y: -2.6789, z: 300.0001, feedRate: 63, spindleRate: 102 }));
  assert.deepEqual(reports, [
    [6, [254, 253, 254, 2, 1, 0, 41]],
    [6, [9, 2, 0, 133, 154, 44, 1]],
    [6, [1, 0, 63, 0, 102, 0, 0]],
  ]);
});

test('parseInput decodes mapped values and signed jog movement', () => {
  const bytes = Uint8Array.of(0x04, 0x00, 0x01, 0x0f, 0x0d, 0x11, 0xfe, 0x00);

  assert.deepEqual(parseInput(bytes), {
    firstKey: 'Reset',
    secondKey: 'Step',
    rightDial: '2% / 0.001',
    leftDial: 'X',
    firstKeyCode: 0x01,
    secondKeyCode: 0x0f,
    rightDialCode: 0x0d,
    leftDialCode: 0x11,
    jog: -2,
    raw: bytes,
  });
});

test('a slow HID transfer sends the active frame then only the newest snapshot', async () => {
  const pendant = new WHB04BWebHID();
  let release;
  const reports = [];
  pendant.connected = true;
  pendant.device = { async sendFeatureReport(id, bytes) {
    reports.push([...bytes]);
    if (reports.length === 1) await new Promise(resolve => { release = resolve; });
  } };
  const first = pendant.sendDisplayData(buildDisplayFrame({ x: 1 }));
  const superseded = pendant.sendDisplayData(buildDisplayFrame({ x: 2 }));
  const latest = pendant.sendDisplayData(buildDisplayFrame({ x: 3 }));
  release();
  await Promise.all([first, superseded, latest]);
  assert.equal(reports.length, 6);
  assert.equal(reports[0][4], 1);
  assert.equal(reports[3][4], 3);
});

test('feature-report errors propagate without an unsupported output-report fallback', async () => {
  const pendant = new WHB04BWebHID();
  pendant.connected = true;
  pendant.device = {
    async sendFeatureReport() { throw new Error('feature failed'); },
    async sendReport() { assert.fail('Output reports are not the LCD protocol'); },
  };
  await assert.rejects(pendant.sendDisplayData(buildDisplayFrame()), /feature failed/);
});

test('disconnect and reconnect never continue old frames on the new connection', async () => {
  const pendant = new WHB04BWebHID();
  let release;
  const reports = [];
  const device = {
    removeEventListener() {},
    async sendFeatureReport(id, bytes) {
      reports.push([...bytes]);
      if (reports.length === 1) await new Promise(resolve => { release = resolve; });
    },
  };
  pendant.connected = true;
  pendant.device = device;
  const first = assert.rejects(pendant.sendDisplayData(buildDisplayFrame({ x: 1 })), /disconnected/);
  const queued = assert.rejects(pendant.sendDisplayData(buildDisplayFrame({ x: 2 })), /disconnected/);
  pendant._teardown(false);
  // The browser can return the same HIDDevice object on reconnection.
  pendant.device = device;
  pendant.connected = true;
  release();
  await Promise.all([first, queued]);
  assert.equal(reports.length, 1);
  await pendant.sendDisplayData(buildDisplayFrame({ x: 3 }));
  assert.equal(reports.length, 4);
  assert.equal(reports[1][4], 3);
});

test('a stalled feature report times out, closes the connection and rejects queued frames', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pendant = new WHB04BWebHID();
  let closed = 0;
  pendant.connected = true;
  pendant.device = {
    sendFeatureReport() { return new Promise(() => {}); },
    removeEventListener() {},
    async close() { closed++; },
  };
  const first = assert.rejects(pendant.sendDisplayData(buildDisplayFrame()), /timed out/);
  const queued = assert.rejects(pendant.sendDisplayData(buildDisplayFrame({ x: 1 })), /not connected/);
  t.mock.timers.tick(1000);
  await Promise.all([first, queued]);
  assert.equal(pendant.connected, false);
  assert.equal(closed, 1);
});

test('timeout reconnect waits for the old close before reopening the same device', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pendant = new WHB04BWebHID();
  const calls = [];
  let finishClose;
  const device = {
    vendorId: 0x10ce, productId: 0xeb93,
    opened: true,
    removeEventListener() {}, addEventListener() {},
    sendFeatureReport() { return new Promise(() => {}); },
    close() {
      calls.push('close');
      return new Promise(resolve => { finishClose = () => { device.opened = false; resolve(); }; });
    },
    async open() { calls.push('open'); device.opened = true; },
  };
  pendant.device = device;
  pendant.connected = true;
  Object.defineProperty(navigator, 'hid', { configurable: true, value: { addEventListener() {}, async getDevices() { return [device]; } } });
  t.after(() => { delete navigator.hid; });
  let reconnect;
  pendant.addEventListener('remove', () => { reconnect = pendant.tryReconnect(); });
  const write = assert.rejects(pendant.sendDisplayData(buildDisplayFrame()), /timed out/);
  t.mock.timers.tick(1000);
  await write;
  assert.deepEqual(calls, ['close']);
  assert.equal(pendant.connected, false);
  finishClose();
  await reconnect;
  assert.deepEqual(calls, ['close', 'open']);
  assert.equal(device.opened, true);
  assert.equal(pendant.connected, true);
});

test('destroy supersedes an attachment waiting on device close', async () => {
  const pendant = new WHB04BWebHID();
  let finishClose;
  const device = {
    opened: true,
    removeEventListener() {}, addEventListener() {},
    close() { return new Promise(resolve => { finishClose = resolve; }); },
    async open() { assert.fail('Destroyed attachment must not reopen'); },
  };
  const closing = pendant._closeDevice(device);
  const attach = assert.rejects(pendant._attach(device), /superseded/);
  await Promise.resolve();
  await Promise.resolve();
  const destroying = pendant.destroy();
  finishClose();
  await Promise.all([closing, attach, destroying]);
  assert.equal(pendant.connected, false);
  assert.equal(pendant.device, null);
});

test('a newer attachment supersedes a pending attachment', async () => {
  const pendant = new WHB04BWebHID();
  let finishOpen;
  const old = { opened: false, removeEventListener() {}, open() { return new Promise(resolve => { finishOpen = () => { old.opened = true; resolve(); }; }); }, async close() { old.opened = false; }, addEventListener() { assert.fail('Old attachment revived'); } };
  const current = { opened: true, addEventListener() {} };
  const stale = assert.rejects(pendant._attach(old), /superseded/);
  await Promise.resolve();
  await pendant._attach(current);
  finishOpen();
  await stale;
  assert.equal(pendant.device, current);
  assert.equal(pendant.connected, true);
  assert.equal(old.opened, false);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('demo disconnect/connect restores physical unplug listeners and rejects old device input', async t => {
  const hid = new EventTarget();
  const createDevice = () => Object.assign(new EventTarget(), {
    vendorId: 0x10ce, productId: 0xeb93, opened: true,
    async open() { this.opened = true; }, async close() { this.opened = false; },
  });
  const first = createDevice(), second = createDevice();
  let selection = first;
  hid.requestDevice = async () => [selection];
  Object.defineProperty(navigator, 'hid', { configurable: true, value: hid });
  t.after(() => { delete navigator.hid; });
  const pendant = new WHB04BWebHID();
  let uses = 0;
  pendant.addEventListener('use', () => { uses++; });
  const input = device => {
    const event = new Event('inputreport');
    Object.assign(event, { reportId: 4, data: new DataView(Uint8Array.of(0, 0, 0, 13, 17, 1, 0).buffer) });
    device.dispatchEvent(event);
  };
  await pendant.requestDevice();
  input(first);
  assert.equal(uses, 1);
  await pendant.destroy();
  await pendant.requestDevice();
  assert.equal(first.opened, true);
  const unplug = new Event('disconnect');
  Object.assign(unplug, { device: first });
  hid.dispatchEvent(unplug);
  assert.equal(pendant.connected, false);
  await pendant.requestDevice();
  selection = second;
  const closeGate = deferred();
  first.close = async () => { await closeGate.promise; first.opened = false; };
  await pendant.requestDevice();
  input(first);
  assert.equal(uses, 1, 'Old input must not reach controls while its close is pending');
  input(second);
  assert.equal(uses, 2);
  closeGate.resolve();
  await pendant.destroy();
});

test('destroy waits for open to settle before closing; close during open would reject', async () => {
  const pendant = new WHB04BWebHID();
  const started = deferred(), finish = deferred();
  const calls = [];
  const device = {
    opened: false, phase: 'closed', removeEventListener() {},
    async open() { device.phase = 'opening'; calls.push('open'); started.resolve(); await finish.promise; device.opened = true; device.phase = 'open'; },
    async close() { assert.notEqual(device.phase, 'opening', 'WebHID rejects close while opening'); calls.push('close'); device.opened = false; device.phase = 'closed'; },
    addEventListener() { assert.fail('Destroyed open must not attach'); },
  };
  const attach = assert.rejects(pendant._attach(device), /superseded/);
  await started.promise;
  const destroy = pendant.destroy();
  assert.deepEqual(calls, ['open']);
  finish.resolve();
  await Promise.all([attach, destroy]);
  assert.deepEqual(calls, ['open', 'close']);
  assert.equal(device.opened, false);
  assert.equal(pendant.connected, false);
});

test('a newer attachment to the same opening device retains ownership', async () => {
  const pendant = new WHB04BWebHID();
  const started = deferred(), finish = deferred();
  let opens = 0;
  const device = {
    opened: false, addEventListener() {},
    async open() { opens++; started.resolve(); await finish.promise; device.opened = true; },
    close() { assert.fail('New attachment owns this device'); },
  };
  const first = assert.rejects(pendant._attach(device), /superseded/);
  await started.promise;
  const latest = pendant._attach(device);
  finish.resolve();
  await Promise.all([first, latest]);
  assert.equal(opens, 1);
  assert.equal(pendant.connected, true);
  assert.equal(device.opened, true);
});

test('a rejected close is evicted so a later reconnect can succeed', async () => {
  const pendant = new WHB04BWebHID();
  const device = { opened: true, async close() { throw new Error('transient close'); }, addEventListener() {} };
  await assert.rejects(pendant._closeDevice(device), /transient close/);
  await pendant._attach(device);
  assert.equal(pendant.connected, true);
});

for (const method of ['getDevices', 'requestDevice']) {
  test(`destroy invalidates pending ${method} discovery without preventing a later explicit connection`, async t => {
    const pendant = new WHB04BWebHID();
    const discovery = deferred();
    const device = { vendorId: 0x10ce, productId: 0xeb93, opened: true, addEventListener() {} };
    Object.defineProperty(navigator, 'hid', { configurable: true, value: { [method]: () => discovery.promise, addEventListener() {}, removeEventListener() {} } });
    t.after(() => { delete navigator.hid; });
    const pending = method === 'getDevices' ? pendant.tryReconnect() : pendant.requestDevice();
    await pendant.destroy();
    discovery.resolve([device]);
    assert.equal(await pending, false);
    assert.equal(pendant.connected, false);
    assert.equal(pendant.device, null);
    await pendant._attach(device);
    assert.equal(pendant.connected, true);
  });
}
