import assert from 'node:assert/strict';
import test from 'node:test';
import { controllerDisplayFrame } from '../web/widget/pendant-display.js';

const state = { status: {
  wpos: { x: '-0.1234', y: '1.2345', z: '2' },
  mpos: { x: '100', y: '-200', z: '300' },
  ov: [63, 50, 102], feedrate: 0, spindle: 12000,
}, parserstate: { modal: { units: 'G21' } } };

test('LCD shows work coordinates and feed/spindle overrides even at rest', () => {
  assert.deepEqual([...controllerDisplayFrame(state, { reportUnits: 0 })], [
    254, 253, 254, 130, 0, 0, 210, 132, 1, 0, 41, 9,
    2, 0, 0, 0, 63, 0, 102, 0, 0,
  ]);
});

test('machine coordinates use absolute labels in the active G21 units', () => {
  const frame = controllerDisplayFrame(state, { coordinates: 'machine', jogMode: 0, reportUnits: 0 });
  assert.deepEqual([...frame.slice(3, 16)], [0, 100, 0, 0, 0, 200, 0, 0, 128, 44, 1, 0, 0]);
});

test('missing controller feedback does not fabricate zero positions or overrides', () => {
  assert.equal(controllerDisplayFrame({}), null);
  assert.equal(controllerDisplayFrame({ ...state, status: { ...state.status, ov: undefined } }, { reportUnits: 0 }), null);
  assert.equal(controllerDisplayFrame({ ...state, status: { ...state.status, wpos: { x: '', y: 1, z: 2 } } }, { reportUnits: 0 }), null);
});

test('all report/display unit combinations convert work and machine coordinates', () => {
  for (const reportUnits of [0, 1]) {
    const input = reportUnits === 0 ? { x: '25.4', y: '-50.8', z: '12.7' } : { x: '1', y: '-2', z: '0.5' };
    for (const units of ['G20', 'G21']) {
      const snapshot = { status: { wpos: input, mpos: input, ov: [100, 100, 100] }, parserstate: { modal: { units } } };
      for (const coordinates of ['work', 'machine']) {
        const frame = controllerDisplayFrame(snapshot, { reportUnits: String(reportUnits), coordinates });
        const expected = units === 'G20'
          ? [1, 0, 0, 0, 2, 0, 0, 128, 0, 0, 136, 19]
          : [25, 0, 160, 15, 50, 0, 64, 159, 12, 0, 88, 27];
        assert.deepEqual([...frame.slice(4, 16)], expected);
      }
    }
  }
});

test('G21 to G20 and back recomputes from raw coordinates without accumulating conversions', () => {
  const snapshot = structuredClone(state);
  snapshot.status.wpos = { x: 25.4, y: -25.4, z: 0 };
  const before = controllerDisplayFrame(snapshot, { reportUnits: 0 });
  snapshot.parserstate.modal.units = 'G20';
  assert.equal(controllerDisplayFrame(snapshot, { reportUnits: 0 })[4], 1);
  snapshot.parserstate.modal.units = 'G21';
  assert.deepEqual(controllerDisplayFrame(snapshot, { reportUnits: 0 }), before);
  assert.equal(snapshot.status.wpos.x, 25.4);
});

test('unknown report or modal units withhold the display rather than guessing', () => {
  for (const reportUnits of [undefined, null, '', 2, 'mm']) assert.equal(controllerDisplayFrame(state, { reportUnits }), null);
  assert.equal(controllerDisplayFrame({ ...state, parserstate: {} }, { reportUnits: 0 }), null);
});
