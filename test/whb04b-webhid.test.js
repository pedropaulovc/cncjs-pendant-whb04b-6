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

test('buildDisplayFrame encodes display fields in the pendant protocol layout', () => {
  const frame = buildDisplayFrame({
    jogMode: JogMode.Step,
    coordinateSystem: CoordinateSystem.X1Y1Z1,
    x: 1.2345,
    y: -1,
    z: 0,
    feedRate: 1500,
    spindleRate: 184,
  });

  assert.deepEqual([...frame], [
    0x06, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x39, 0x30, 0x00, 0x00,
    0xf0, 0xd8, 0xff,
    0x00, 0x00, 0x00, 0x00,
    0xdc, 0x05, 0xb8,
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
