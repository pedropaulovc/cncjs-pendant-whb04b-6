import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CncjsSession, isParentMessage } from '../web/widget/cncjs-session.js';
import { Grbl } from '../web/widget/grbl.js';

test('default timers use the browser-compatible receiver', (t) => {
  const timerId = {};
  let cancelled;
  t.mock.method(globalThis, 'setInterval', function () {
    assert.ok(this === undefined || this === globalThis);
    return timerId;
  });
  t.mock.method(globalThis, 'clearInterval', function (id) {
    assert.ok(this === undefined || this === globalThis);
    cancelled = id;
  });
  const socket = { on() {}, disconnect() {} };
  const session = new CncjsSession({ io: () => socket, origin: 'http://localhost' });
  session.connect('token');
  assert.equal(session.timer, timerId);
  session.disconnect();
  assert.equal(cancelled, timerId);
});

function fixture() {
  const emitted = [];
  const sockets = [];
  const timers = new Set();
  const states = [];
  const session = new CncjsSession({
    origin: 'http://localhost:8000',
    schedule(fn) { timers.add(fn); return fn; },
    cancel(fn) { timers.delete(fn); },
    onState: (...args) => states.push(args),
    io(origin, options) {
      assert.equal(origin, 'http://localhost:8000');
      assert.equal(options.query.token, 'test-token');
      const listeners = new Map();
      const socket = {
        connected: false,
        on(event, handler) { listeners.set(event, handler); return this; },
        emit(...args) { emitted.push(args); return this; },
        receive(event, ...args) { listeners.get(event)?.(...args); },
        connect() { this.connected = true; this.receive('connect'); return this; },
        disconnect() { this.connected = false; this.receive('disconnect'); return this; },
      };
      sockets.push(socket);
      return socket;
    },
  });
  session.connect('test-token');
  const socket = sockets[0];
  socket.connect();
  function list(ports) { socket.receive('serialport:list', ports); }
  function join(port = 'SIMULATOR', controllerType = 'Grbl') {
    list([{ port, inuse: true }]);
    socket.receive('serialport:open', { port, controllerType });
    emitted.findLast(([event]) => event === 'open')[3](null);
  }
  return { session, socket, sockets, timers, emitted, states, list, join };
}

function stopCommands(f) {
  return f.emitted.filter(([event]) => event === 'command').map(([, , ...args]) => args);
}

function report(f, state) {
  f.socket.receive('serialport:read', `<${state}|MPos:0,0,0|FS:0,0>`);
}

test('Stop delegates cancellation to the joined session', () => {
  let stops = 0;
  new Grbl({ stop() { stops++; } }).stop();
  assert.equal(stops, 1);
});

test('Stop at Idle clears queues and confirms Idle without hold or reset', () => {
  const f = fixture(); f.join(); f.session.stop();
  assert.deepEqual(stopCommands(f).map(([name]) => name), ['gcode:stop', 'feeder:stop', 'jogCancel', 'statusreport']);
  report(f, 'Idle');
  assert.notEqual(f.session.stopPhase, 'idle', 'One potentially stale reply cannot release the interlock');
  report(f, 'Idle');
  assert.equal(f.session.stopPhase, 'idle');
  assert.equal(f.timers.size, 1);
});

test('Stop uses fresh reports despite cached Idle, waits through Hold:1, then resets once', () => {
  const f = fixture(); f.join();
  f.socket.receive('controller:state', 'Grbl', { status: { activeState: 'Idle' } });
  f.session.stop();
  report(f, 'Idle'); // A prior status query may still be in flight.
  report(f, 'Run');
  assert.equal(stopCommands(f).at(-1)[0], 'feedhold');
  report(f, 'Hold:1');
  for (let tick = 0; tick < 20; tick++) for (const timer of f.timers) timer();
  assert.equal(stopCommands(f).some(([name]) => name === 'reset'), false);
  report(f, 'Hold:0');
  report(f, 'Hold:0');
  assert.equal(stopCommands(f).filter(([name]) => name === 'reset').length, 1);
  report(f, 'Idle');
  assert.equal(f.session.stopPhase, 'resetting', 'Wait for startup before accepting Idle');
  f.socket.receive('serialport:read', "Grbl 1.1h ['$' for help]");
  report(f, 'Idle'); report(f, 'Idle');
  assert.equal(f.session.stopPhase, 'idle');
  assert.equal(f.timers.size, 1);
});

test('Stop cancels jogging without resetting and blocks motion while pending', () => {
  const f = fixture(); f.join(); f.session.stop();
  f.session.stop();
  const count = stopCommands(f).length;
  f.session.command('cyclestart'); f.session.command('gcode', '$J=G91 X1 F50');
  assert.equal(stopCommands(f).length, count);
  report(f, 'Jog');
  assert.equal(stopCommands(f).at(-1)[0], 'jogCancel');
  report(f, 'Idle'); report(f, 'Idle');
  assert.equal(stopCommands(f).some(([name]) => name === 'reset' || name === 'feedhold'), false);
  f.session.command('cyclestart');
  assert.equal(stopCommands(f).at(-1)[0], 'cyclestart');
});

test('Stop aborts homing with reset and confirms the resulting alarm', () => {
  const f = fixture(); f.join(); f.session.stop(); report(f, 'Home');
  assert.equal(stopCommands(f).at(-1)[0], 'reset');
  f.socket.receive('serialport:read', "Grbl 1.1h ['$' for help]");
  report(f, 'Alarm');
  assert.notEqual(f.session.stopPhase, 'idle');
  report(f, 'Alarm');
  assert.equal(f.session.stopPhase, 'idle');
});

for (const action of ['disconnect', 'selectPort']) test(`Stop abandons pending actions on ${action}`, () => {
  const f = fixture(); f.join(); f.session.stop();
  report(f, 'Run');
  f.session[action]('COM2');
  const count = stopCommands(f).length;
  report(f, 'Hold:0');
  for (const timer of f.timers) timer();
  assert.equal(stopCommands(f).length, count);
  assert.equal(f.session.stopPhase, 'interrupted');
  assert.equal(f.session.stopTimer, null);
});

test('interrupted Stop stays interlocked after reconnect until explicitly retried', () => {
  const f = fixture(); f.join(); f.session.stop(); report(f, 'Run');
  f.socket.disconnect(); f.socket.connect(); f.join();
  const count = stopCommands(f).length;
  report(f, 'Idle'); report(f, 'Idle');
  f.session.command('cyclestart');
  assert.equal(stopCommands(f).length, count);
  f.session.stop(); report(f, 'Hold:0');
  assert.equal(stopCommands(f).at(-1)[0], 'reset');
  f.socket.receive('serialport:read', "Grbl 1.1h ['$' for help]");
  report(f, 'Idle'); report(f, 'Idle');
  assert.equal(f.session.stopPhase, 'idle');
});
test('joins an active port and delivers initial and subsequent state', () => {
  const f = fixture();
  assert.equal(f.emitted[0][0], 'list');
  f.join();
  f.socket.receive('controller:state', 'Grbl', { status: { mpos: { x: 12 } } });
  assert.equal(f.states[0][1].status.mpos.x, 12);
  f.session.command('gcode', '$J=G21 G91 X0.1 F50');
  assert.deepEqual(f.emitted.at(-1), ['command', 'SIMULATOR', 'gcode', '$J=G21 G91 X0.1 F50']);
});

test('never selects an idle port or guesses among multiple open ports', () => {
  const f = fixture();
  f.list([{ port: 'COM1', inuse: false }]);
  f.list([{ port: 'COM1', inuse: true }, { port: 'COM2', inuse: true }]);
  f.session.command('gcode', 'G0 X100');
  assert.equal(f.emitted.filter(([event]) => event === 'open' || event === 'command').length, 0);
  f.session.selectPort('COM2');
  f.list([{ port: 'COM1', inuse: true }, { port: 'COM2', inuse: true }]);
  assert.equal(f.emitted.findLast(([event]) => event === 'open')[1], 'COM2');
});

test('drops disconnected commands instead of allowing Socket.IO to buffer them', () => {
  const f = fixture();
  f.join();
  f.socket.disconnect();
  f.session.command('gcode', 'G0 X100');
  assert.equal(f.emitted.some(([event]) => event === 'command'), false);
  f.socket.connect();
  f.join();
  assert.equal(f.emitted.filter(([event]) => event === 'open').length, 2);
});

test('rejects commands to unsupported controllers', () => {
  const f = fixture();
  f.join('COM1', 'Marlin');
  f.session.command('gcode', 'G0 X100');
  assert.equal(f.emitted.some(([event]) => event === 'command'), false);
  assert.equal(f.session.status.phase, 'unsupported');
});

test('authenticates parent messages by window identity and origin', () => {
  const parent = {};
  assert.equal(isParentMessage({ source: {}, origin: 'http://localhost' }, parent, 'http://localhost'), false);
  assert.equal(isParentMessage({ source: parent, origin: 'https://evil.example' }, parent, 'http://localhost'), false);
  assert.equal(isParentMessage({ source: parent, origin: 'http://localhost' }, parent, 'http://localhost'), true);
});

test('manual reconnect disposes the previous socket and discovery timer', () => {
  const f = fixture();
  f.join();
  f.session.connect('test-token');
  assert.equal(f.socket.connected, false);
  assert.equal(f.timers.size, 1);
  f.socket.receive('controller:state', 'Grbl', { status: { mpos: { x: 999 } } });
  assert.equal(f.states.length, 0);
  f.session.disconnect();
  assert.equal(f.timers.size, 0);
});

test('clearing an automatic selection immediately disarms the joined port', () => {
  const f = fixture();
  f.join();
  f.session.selectPort(null);
  f.list([{ port: 'SIMULATOR', inuse: true }]);
  f.session.command('reset');
  assert.equal(f.emitted.some(([event]) => event === 'command'), false);
  assert.equal(f.session.status.port, null);
});

test('late join callbacks cannot re-enable a disconnected port', () => {
  const f = fixture();
  f.list([{ port: 'SIMULATOR', inuse: true }]);
  const callback = f.emitted.findLast(([event]) => event === 'open')[3];
  f.socket.disconnect();
  callback(null);
  assert.equal(f.session.status.phase, 'disconnected');
});

test('a port disappearing while join is pending invalidates its callback', () => {
  const f = fixture();
  f.list([{ port: 'SIMULATOR', inuse: true }]);
  const callback = f.emitted.findLast(([event]) => event === 'open')[3];
  f.list([{ port: 'SIMULATOR', inuse: false }]);
  callback(null);
  assert.equal(f.session.status.phase, 'discovering');
  f.session.command('reset');
  assert.equal(f.emitted.some(([event]) => event === 'command'), false);
});

test('port close disarms commands and resumes discovery without closing hardware', () => {
  const f = fixture();
  f.join();
  f.socket.receive('serialport:close');
  f.session.command('reset');
  assert.equal(f.emitted.at(-1)[0], 'list');
  assert.equal(f.emitted.some(([event]) => event === 'close' || event === 'command'), false);
});

test('jog and fixed-distance macros use mm even after a prior G20 command', () => {
  const commands = [];
  const grbl = new Grbl({ command: (...args) => commands.push(args) }, () => 12.5);
  grbl.jog('X', -2, 0x0f);
  assert.deepEqual(commands.pop(), ['gcode', '$J=G21 G91 X-0.2000 F250']);
  grbl.wcsHome();
  assert.deepEqual(commands.splice(0), [['gcode', 'G21 G53 G0 G90 Z-5'], ['gcode', 'G21 G54 G0 G90 X0 Y0']]);
  grbl.probeZ();
  assert.equal(commands[0][1], 'G21 G91');
  assert.equal(commands[2][1], 'G10 L20 P1 Z12.501');
});

test('a canceled poll callback cannot send commands to a new port', () => {
  const f = fixture(); f.join(); f.session.stop();
  const oldPoll = f.session.stopTimer;
  f.session.selectPort('COM2'); f.join('COM2');
  const count = stopCommands(f).length;
  oldPoll(); report(f, 'Hold:0');
  assert.equal(stopCommands(f).length, count);
});

for (const event of ['error', 'connect_error', 'serialport:close']) test(`Stop clears its poll on ${event}`, () => {
  const f = fixture(); f.join(); f.session.stop();
  f.socket.receive(event, new Error('connection lost'));
  assert.equal(f.session.stopPhase, 'interrupted');
  assert.equal(f.session.stopTimer, null);
  assert.equal(f.timers.size, 1);
});
