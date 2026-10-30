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
