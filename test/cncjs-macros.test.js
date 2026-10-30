import assert from 'node:assert/strict';
import test from 'node:test';
import { CncjsMacros } from '../web/widget/cncjs-macros.js';

const macro = { id: 'saved/one', name: 'Return to work origin', content: 'G0 X0 Y0', mtime: 1 };
const response = data => ({ ok: true, status: 200, json: async () => data });

test('default fetch retains the Window-compatible receiver', async t => {
  t.mock.method(globalThis, 'fetch', function () {
    assert.equal(this, globalThis);
    return Promise.resolve(response({ records: [] }));
  });
  const api = new CncjsMacros({ getToken: () => 'token' });
  assert.deepEqual(await api.list(), []);
});

test('lists and reads saved macros with the current bearer token and no cache', async () => {
  let token = 'first';
  const calls = [];
  const api = new CncjsMacros({ getToken: () => token, fetch: async (url, options) => {
    calls.push({ url, options });
    return response(url === '/api/macros' ? { records: [macro] } : macro);
  } });
  assert.deepEqual(await api.list(), [{ id: macro.id, name: macro.name, content: macro.content }]);
  token = 'renewed';
  assert.equal((await api.read(macro.id)).content, macro.content);
  assert.deepEqual(calls.map(call => call.url), ['/api/macros', '/api/macros/saved%2Fone']);
  assert.deepEqual(calls.map(call => call.options.headers.Authorization), ['Bearer first', 'Bearer renewed']);
  assert.ok(calls.every(call => call.options.cache === 'no-store' && call.options.signal instanceof AbortSignal));
});

test('execution reads fresh content and never returns a cached definition after deletion', async () => {
  let latest = 'G21';
  const api = new CncjsMacros({ getToken: () => 'token', fetch: async () => latest === null
    ? { ok: false, status: 404 } : response({ ...macro, content: latest }) });
  assert.equal((await api.read(macro.id)).content, 'G21');
  latest = 'G20';
  assert.equal((await api.read(macro.id)).content, 'G20');
  latest = null;
  await assert.rejects(api.read(macro.id), /no longer exists/);
});

test('missing credentials, invalid selections, HTTP errors and malformed responses are explicit', async () => {
  const absent = new CncjsMacros({ getToken: () => null, fetch: () => assert.fail('No unauthenticated request') });
  await assert.rejects(absent.list(), /session token/);
  await assert.rejects(absent.read(''), /Select a saved/);
  for (const status of [401, 403, 500]) {
    const api = new CncjsMacros({ getToken: () => 'token', fetch: async () => ({ ok: false, status }) });
    await assert.rejects(api.list(), new RegExp(`HTTP ${status}`));
  }
  for (const records of [null, {}]) {
    const api = new CncjsMacros({ getToken: () => 'token', fetch: async () => response({ records }) });
    await assert.rejects(api.list(), /invalid macro/);
  }
  for (const value of [{ ...macro, content: null }, { ...macro, id: '' }]) {
    const api = new CncjsMacros({ getToken: () => 'token', fetch: async () => response(value) });
    await assert.rejects(api.read(macro.id), /invalid macro record/);
  }
  const wrong = new CncjsMacros({ getToken: () => 'token', fetch: async () => response(macro) });
  await assert.rejects(wrong.read('different'), /does not match/);
  const badJson = new CncjsMacros({ getToken: () => 'token', fetch: async () => ({ ok: true, status: 200, json: () => { throw new SyntaxError(); } }) });
  await assert.rejects(badJson.list(), /invalid JSON/);
});

test('a malformed list record does not hide valid saved macros and the notice resets', async () => {
  let records = [macro, { id: 'broken' }, null];
  const api = new CncjsMacros({ getToken: () => 'token', fetch: async () => response({ records }) });
  assert.equal(api.notice, '');
  assert.deepEqual(await api.list(), [{ id: macro.id, name: macro.name, content: macro.content }]);
  assert.equal(api.notice, 'Skipped 2 invalid CNCjs macro records.');
  records = [{ id: 'broken' }];
  assert.deepEqual(await api.list(), []);
  assert.equal(api.notice, 'Skipped 1 invalid CNCjs macro record.');
  records = [macro];
  assert.equal((await api.list()).length, 1);
  assert.equal(api.notice, '');
});

test('network errors and body timeouts are reported without leaking credentials', async () => {
  const offline = new CncjsMacros({ getToken: () => 'secret', fetch: async () => { throw new TypeError('offline'); } });
  await assert.rejects(offline.list(), /^Error: CNCjs macros: request failed\.$/);
  const slowBody = new CncjsMacros({ getToken: () => 'secret', fetch: async () => ({
    ok: true, status: 200, json: async () => { throw new DOMException('timeout', 'AbortError'); },
  }) });
  await assert.rejects(slowBody.list(), /request timed out/);
});

test('a stalled request is aborted after one second', async () => {
  // AbortSignal.timeout uses an unreferenced timer; keep the test alive to observe it.
  const keepAlive = setTimeout(() => {}, 2000);
  const api = new CncjsMacros({ getToken: () => 'token', fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  try { await assert.rejects(api.list(), /request timed out/); }
  finally { clearTimeout(keepAlive); }
});
