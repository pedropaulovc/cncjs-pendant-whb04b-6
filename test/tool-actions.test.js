import test from 'node:test';
import assert from 'node:assert/strict';
import { CncjsMacros } from '../web/widget/cncjs-macros.js';
import { SavedMacroRunner } from '../web/widget/macro-runner.js';
import { PendantControls } from '../web/widget/pendant-controls.js';

function fixture() {
  const calls = [], commands = [], logs = [];
  const session = { generation: 1, motionEpoch: 1, workflowEpoch: 1,
    status: { port: 'SIMULATOR' }, workflowState: 'idle' };
  let token = 'first', body = '{}', status = 200, fail = null, pending = null;
  const library = new CncjsMacros({ getToken: () => token, fetch: async (url, options) => {
    calls.push({ url, options });
    if (pending) await pending;
    if (fail) throw fail;
    return { ok: status === 200, status, text: async () => body };
  } });
  const grbl = { jogPhase: 'idle', manualReady: () => session.workflowState === 'idle',
    macro: code => { commands.push(code); return 'sent'; }, cancelJog() {}, stop() { commands.push('STOP'); } };
  const runner = new SavedMacroRunner({ session, grbl, library, log: message => logs.push(message) });
  const controls = new PendantControls(grbl, { onSuspend: () => runner.cancel(),
    onClearance: home => runner.runClearance(home), onProbe: () => runner.runProbe() });
  return { calls, commands, logs, session, grbl, library, runner, controls,
    setToken: value => { token = value; }, setBody: value => { body = value; },
    setStatus: value => { status = value; }, setFailure: value => { fail = value; },
    defer() { let finish; pending = new Promise(resolve => { finish = resolve; }); return finish; } };
}

const actions = [
  { name: 'Safe-Z', key: 9, run: f => f.runner.runClearance(), field: 'toolChangeZ',
    expected: z => [`G21 G53 G0 G90 Z${z}`] },
  { name: 'W-Home', key: 10, run: f => f.runner.runClearance(true), field: 'toolChangeZ',
    expected: z => [`G21 G53 G0 G90 Z${z}`, 'G21 G54 G0 G90 X0 Y0'] },
  { name: 'Probe-Z', key: 13, run: f => f.runner.runProbe(), field: 'touchPlateHeight',
    expected: z => ['G21 G91', 'G38.2 Z-50 F120', `G10 L20 P1 Z${z + 0.001}`, 'G0 Z3', 'G90'] },
];

for (const action of actions) {
  test(`${action.name} fetches fresh metric values with the current bearer on each press`, async () => {
    const f = fixture();
    f.setBody(JSON.stringify({ [action.field]: 12.5 }));
    assert.equal(await action.run(f), 'sent');
    f.setToken('second'); f.setBody(JSON.stringify({ [action.field]: 7 }));
    assert.equal(await action.run(f), 'sent');
    assert.deepEqual(f.commands, [action.expected(12.5), action.expected(7)]);
    assert.deepEqual(f.calls.map(({ url, options }) => [url, options.headers.Authorization, options.cache]),
      [['/api/tool', 'Bearer first', 'no-store'], ['/api/tool', 'Bearer second', 'no-store']]);
    assert.ok(f.calls.every(({ options }) => options.signal instanceof AbortSignal));
  });

  for (const body of ['', '{}', '{"unrelated":42}']) {
    test(`${action.name} matches native unset default 0 for ${JSON.stringify(body)}`, async () => {
      const f = fixture(); f.setBody(body);
      assert.equal(await action.run(f), 'sent'); assert.deepEqual(f.commands, [action.expected(0)]);
    });
  }

  for (const value of [null, '4', false, [], {}, ...(action.field === 'touchPlateHeight' ? [-1] : [])]) {
    test(`${action.name} refuses present invalid ${JSON.stringify(value)}`, async () => {
      const f = fixture(); f.setBody(JSON.stringify({ [action.field]: value }));
      assert.equal(await action.run(f), 'dropped'); assert.deepEqual(f.commands, []);
      assert.match(f.logs.at(-1), /finite/);
    });
  }

  for (const body of [' ', 'null', '[]', '""', 'false', '{', `{"${action.field}":1e400}`]) {
    test(`${action.name} refuses malformed or nonfinite response ${body}`, async () => {
      const f = fixture(); f.setBody(body);
      assert.equal(await action.run(f), 'dropped'); assert.deepEqual(f.commands, []);
    });
  }

  test(`${action.name} rejects missing credentials and failed reads without fallback motion`, async () => {
    const f = fixture(); f.setToken(null);
    assert.equal(await action.run(f), 'dropped'); assert.equal(f.calls.length, 0);
    f.setToken('token');
    for (const status of [401, 403, 404, 500]) {
      f.setStatus(status); assert.equal(await action.run(f), 'dropped');
      assert.match(f.logs.at(-1), new RegExp(`HTTP ${status}`));
    }
    f.setStatus(200);
    for (const error of [new TypeError('offline'), new DOMException('timeout', 'TimeoutError')]) {
      f.setFailure(error); assert.equal(await action.run(f), 'dropped');
    }
    assert.deepEqual(f.commands, []);
  });

  for (const change of ['Stop', 'another key', 'disconnect', 'generation', 'motionEpoch', 'workflowEpoch', 'port', 'program', 'jog']) {
    test(`${action.name} cannot dispatch after in-flight ${change}`, async () => {
      const f = fixture(), finish = f.defer(); const run = action.run(f);
      assert.equal(f.calls.length, 1);
      if (change === 'Stop') f.controls.key(2, 'plain');
      if (change === 'another key') f.controls.key(0, 'plain');
      if (change === 'disconnect') f.controls.suspend();
      if (['generation', 'motionEpoch', 'workflowEpoch'].includes(change)) f.session[change]++;
      if (change === 'port') f.session.status.port = 'OTHER';
      if (change === 'program') f.session.workflowState = 'running';
      if (change === 'jog') f.grbl.jogPhase = 'canceling';
      finish(); assert.equal(await run, 'dropped');
      assert.deepEqual(f.commands, change === 'Stop' ? ['STOP'] : []);
    });
  }

  test(`${action.name} rejects busy or pending-jog controllers before fetching`, async () => {
    const f = fixture(); f.session.workflowState = 'running'; await action.run(f);
    f.session.workflowState = 'idle'; f.grbl.jogPhase = 'canceling'; await action.run(f);
    assert.equal(f.calls.length, 0);
  });
}

test('tool numeric reads reject actual nonfinite numbers without coercion', async () => {
  const f = fixture();
  for (const value of [NaN, Infinity, -Infinity, undefined]) {
    f.library.request = async () => ({ toolChangeZ: value, touchPlateHeight: value });
    await assert.rejects(f.library.readToolChangeZ(), /finite/);
    await assert.rejects(f.library.readTouchPlateHeight(), /finite/);
  }
});

test('machine Z accepts either sign and renders small and large values without exponents', async () => {
  const f = fixture();
  for (const [value, text] of [[-5, '-5'], [1e-7, '0.0000001'], [-1e-7, '-0.0000001'], [1e21, '1000000000000000000000']]) {
    f.setBody(JSON.stringify({ toolChangeZ: value })); await f.runner.runClearance();
    assert.deepEqual(f.commands.pop(), [`G21 G53 G0 G90 Z${text}`]);
  }
});

test('a newer tool action supersedes the pending one through the same intent lifecycle', async () => {
  const f = fixture(), finish = f.defer();
  const first = f.runner.runClearance(); const second = f.runner.runProbe();
  finish(); assert.equal(await first, 'dropped'); assert.equal(await second, 'sent');
  assert.deepEqual(f.commands, [actions[2].expected(0)]);
});

test('fire-and-forget physical dispatch contains read rejections and logs failures', async () => {
  const f = fixture(); f.setFailure(new Error('offline'));
  let logged;
  const settled = new Promise(resolve => { logged = resolve; });
  f.runner.log = message => { f.logs.push(message); logged(); };
  f.controls.key(13, 'plain'); await settled;
  assert.deepEqual(f.commands, []); assert.match(f.logs.at(-1), /request failed/);
});
