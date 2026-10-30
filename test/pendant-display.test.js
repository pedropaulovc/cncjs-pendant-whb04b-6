import assert from 'node:assert/strict';
import test from 'node:test';
import { controllerDisplayFrame } from '../web/widget/pendant-display.js';

const state = { status: {
  wpos: { x: '-0.1234', y: '1.2345', z: '2' },
  mpos: { x: '100', y: '-200', z: '300' },
  ov: [63, 50, 102], feedrate: 0, spindle: 12000,
} };

test('LCD shows work coordinates and feed/spindle overrides even at rest', () => {
  assert.deepEqual([...controllerDisplayFrame(state)], [
    254, 253, 254, 130, 0, 0, 210, 132, 1, 0, 41, 9,
    2, 0, 0, 0, 63, 0, 102, 0, 0,
  ]);
});

test('machine coordinates retain controller units and use absolute labels', () => {
  const frame = controllerDisplayFrame(state, { coordinates: 'machine', jogMode: 0 });
  assert.deepEqual([...frame.slice(3, 16)], [0, 100, 0, 0, 0, 200, 0, 0, 128, 44, 1, 0, 0]);
});

test('missing controller feedback does not fabricate zero positions or overrides', () => {
  assert.equal(controllerDisplayFrame({}), null);
  assert.equal(controllerDisplayFrame({ status: { ...state.status, ov: undefined } }), null);
  assert.equal(controllerDisplayFrame({ status: { ...state.status, wpos: { x: '', y: 1, z: 2 } } }), null);
});
