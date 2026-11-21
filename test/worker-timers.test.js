import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerTimers } from '../web/widget/worker-timers.js';

// Stands in for the dedicated Worker: records posted commands; `tick(id)`
// delivers the worker's "timer fired" message for that id.
function fakeWorker() {
  const worker = { posted: [], terminated: false, onmessage: null, onerror: null,
    postMessage(message) { this.posted.push(message); },
    terminate() { this.terminated = true; },
    tick(id) { this.onmessage({ data: id }); },
    fail(message) { this.onerror({ message, preventDefault() {} }); } };
  return worker;
}

test('schedule and repeat run in the worker and fire from its messages', () => {
  const worker = fakeWorker();
  const timers = createWorkerTimers({ createWorker: () => worker });
  assert.equal(timers.mode, 'worker');
  const fired = [];
  const once = timers.schedule(() => fired.push('once'), 750);
  const every = timers.repeat(() => fired.push('every'), 250);
  assert.deepEqual(worker.posted, [{ op: 'once', id: once, ms: 750 }, { op: 'repeat', id: every, ms: 250 }]);
  worker.tick(every); worker.tick(every); worker.tick(once); worker.tick(once);
  assert.deepEqual(fired, ['every', 'every', 'once'], 'A one-shot fires once even if a duplicate message arrives');
  timers.cancel(every);
  assert.deepEqual(worker.posted.at(-1), { op: 'cancel', id: every });
  worker.tick(every);
  assert.deepEqual(fired, ['every', 'every', 'once'], 'A late message for a canceled timer is ignored');
});

test('cancel ignores unknown, finished, and null ids without posting', () => {
  const worker = fakeWorker();
  const timers = createWorkerTimers({ createWorker: () => worker });
  const id = timers.schedule(() => {}, 10);
  worker.tick(id);
  const posted = worker.posted.length;
  timers.cancel(id); timers.cancel(null); timers.cancel(12345);
  assert.equal(worker.posted.length, posted);
});

test('a Worker that cannot start falls back to window timers and logs once', async () => {
  const logs = [];
  const timers = createWorkerTimers({ createWorker: () => { throw new Error('blocked by CSP'); }, log: message => logs.push(message) });
  assert.equal(timers.mode, 'window');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /blocked by CSP.*window timers/);
  const fired = await new Promise(resolve => timers.schedule(() => resolve('fired'), 1));
  assert.equal(fired, 'fired');
  let count = 0;
  const id = timers.repeat(() => { count++; }, 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  timers.cancel(id);
  const stopped = count;
  assert.ok(stopped >= 2);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(count, stopped);
  assert.equal(logs.length, 1);
});

test('a Worker error moves pending timers to window timers with their remaining delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let time = 0;
  const worker = fakeWorker();
  const logs = [];
  const timers = createWorkerTimers({ createWorker: () => worker, log: message => logs.push(message), now: () => time });
  const fired = [];
  timers.schedule(() => fired.push('stop-timeout'), 1000);
  const canceled = timers.schedule(() => fired.push('canceled'), 100);
  timers.repeat(() => fired.push('poll'), 250);
  timers.cancel(canceled);
  time = 400;
  worker.fail('script failed');
  worker.fail('again');
  assert.equal(worker.terminated, true);
  assert.equal(timers.mode, 'window');
  assert.equal(logs.length, 1, 'The fallback is logged once');
  t.mock.timers.tick(250);
  assert.deepEqual(fired, ['poll']);
  t.mock.timers.tick(350);
  assert.deepEqual(fired, ['poll', 'poll', 'stop-timeout'], 'The one-shot keeps its original deadline');
  const later = timers.schedule(() => fired.push('later'), 50);
  t.mock.timers.tick(50);
  assert.equal(fired.at(-1), 'later');
  assert.equal(typeof later, 'number');
});
