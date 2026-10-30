import test from 'node:test';
import assert from 'node:assert/strict';
import { SavedMacroRunner } from '../web/widget/macro-runner.js';

function fixture() {
  const calls = [], logs = [];
  const session = { generation: 1, motionEpoch: 1, workflowEpoch: 1, status: { port: 'SIMULATOR' }, workflowState: 'idle' };
  let finish;
  const library = { read: id => { calls.push(['read', id]); return new Promise(resolve => { finish = resolve; }); } };
  const grbl = { jogPhase: 'idle', manualReady: () => session.workflowState === 'idle', macro: code => { calls.push(['gcode', code]); return 'sent'; } };
  const runner = new SavedMacroRunner({ session, grbl, library, log: message => logs.push(message) });
  return { session, grbl, library, runner, calls, logs, finish: (content = 'G0 X[posx]') => finish({ name: 'Saved macro', content }) };
}

test('saved macro fetches its current definition on each press and queues the checked snapshot', async () => {
  const f = fixture();
  let run = f.runner.run('id'); f.finish('G21'); assert.equal(await run, 'sent');
  run = f.runner.run('id'); f.finish('G20'); await run;
  assert.deepEqual(f.calls, [['read', 'id'], ['gcode', 'G21'], ['read', 'id'], ['gcode', 'G20']]);
  assert.match(f.logs.at(-1), /queued/);
});

test('Stop, key changes, and settings save can cancel a loading macro without delayed execution', async () => {
  const f = fixture(); const pending = f.runner.run('id'); f.runner.cancel(); f.finish();
  assert.equal(await pending, 'dropped'); assert.equal(f.calls.length, 1);
});

for (const change of ['generation', 'motionEpoch', 'workflowEpoch', 'port', 'program', 'jog']) {
  test(`loading macro cannot cross ${change} changes`, async () => {
    const f = fixture(); const pending = f.runner.run('id');
    if (change === 'port') f.session.status.port = 'OTHER';
    if (change === 'program') f.session.workflowState = 'running';
    if (change === 'jog') f.grbl.jogPhase = 'canceling';
    if (['generation', 'motionEpoch', 'workflowEpoch'].includes(change)) f.session[change]++;
    f.finish(); assert.equal(await pending, 'dropped'); assert.equal(f.calls.length, 1);
  });
}

test('saved macros refuse missing definitions and unavailable program bounds without executing', async () => {
  const f = fixture(); f.library.read = async () => { throw new Error('Macro was deleted'); };
  assert.equal(await f.runner.run('id'), 'dropped'); assert.match(f.logs.at(-1), /deleted/);
  f.library.read = async () => ({ name: 'Bounds', content: 'G0 X[xmin]' });
  assert.equal(await f.runner.run('id'), 'dropped'); assert.equal(f.calls.length, 0);
});

test('busy controller and pending jog reject before fetching', async () => {
  const f = fixture(); f.session.workflowState = 'running'; await f.runner.run('id');
  f.session.workflowState = 'idle'; f.grbl.jogPhase = 'canceling'; await f.runner.run('id');
  assert.equal(f.calls.length, 0);
});
