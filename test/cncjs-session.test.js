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

test('GRBL settings arriving after state request a redraw with the new report units', () => {
  const f = fixture();
  f.join();
  const state = { parserstate: { modal: { units: 'G20' } }, status: { wpos: { x: '25.4' } } };
  f.socket.receive('controller:state', 'Grbl', state);
  f.states.length = 0;
  f.socket.receive('controller:settings', 'Grbl', { settings: { $13: '0' } });
  assert.equal(f.session.settings.settings.$13, '0');
  assert.deepEqual(f.states, [['Grbl', state]]);
});

function report(f, state) {
  f.socket.receive('serialport:read', `<${state}|MPos:0,0,0|FS:0,0>`);
}

test('Stop delegates cancellation to the joined session', () => {
  let stops = 0;
  new Grbl({ stop() { stops++; } }).stop();
  assert.equal(stops, 1);
});

test('Stop reports refusal without sending commands when disconnected or unsupported', () => {
  const f = fixture();
  f.session.stop();
  assert.equal(f.session.status.detail, 'Stop dropped: no joined GRBL controller.');
  f.join('COM1', 'Marlin'); f.session.stop();
  assert.equal(f.session.status.detail, 'Stop dropped: no joined GRBL controller.');
  assert.equal(stopCommands(f).length, 0);
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

for (const workflow of ['running', 'paused']) test(`Stop holds and resets a ${workflow} program even when GRBL reports Idle during dwell`, () => {
  const f = fixture(); f.join();
  f.socket.receive('workflow:state', workflow);
  f.session.stop();
  assert.equal(stopCommands(f).some(([name]) => name === 'feedhold'), true);
  f.socket.receive('workflow:state', 'idle'); // gcode:stop changes sender state immediately.
  report(f, 'Idle'); report(f, 'Idle');
  assert.equal(f.session.stopIntent, 'program');
  assert.notEqual(f.session.stopPhase, 'idle');
  assert.equal(stopCommands(f).filter(([name]) => name === 'feedhold').length, 1);
  report(f, 'Hold:1');
  for (let tick = 0; tick < 20; tick++) for (const timer of f.timers) timer();
  assert.equal(stopCommands(f).some(([name]) => name === 'reset'), false);
  report(f, 'Hold:0');
  assert.equal(stopCommands(f).some(([name]) => name === 'reset'), false);
  report(f, 'Hold:0');
  assert.equal(stopCommands(f).filter(([name]) => name === 'reset').length, 1);
  f.socket.receive('serialport:read', "Grbl 1.1h ['$' for help]");
  report(f, 'Idle'); report(f, 'Idle');
  assert.equal(f.session.stopPhase, 'idle');
  assert.equal(f.session.stopIntent, 'motion');
});

test('interrupted program cancellation retains its intent after workflow becomes Idle', () => {
  const f = fixture(); f.join();
  f.socket.receive('workflow:state', 'running'); f.session.stop();
  f.socket.receive('workflow:state', 'idle');
  f.socket.disconnect(); f.socket.connect(); f.join();
  f.socket.receive('workflow:state', 'idle');
  f.session.stop(); report(f, 'Idle'); report(f, 'Idle');
  assert.equal(f.session.stopIntent, 'program');
  assert.notEqual(f.session.stopPhase, 'idle');
  report(f, 'Hold:0');
  report(f, 'Hold:0');
  assert.equal(stopCommands(f).at(-1)[0], 'reset');
});

test('interrupted program cancellation cannot reset a different idle port', () => {
  const f = fixture(); f.join('COM1');
  f.socket.receive('workflow:state', 'running'); f.session.stop();
  f.session.selectPort('COM2'); f.join('COM2');
  f.socket.receive('workflow:state', 'idle');
  const count = stopCommands(f).length;
  f.session.stop(); report(f, 'Idle'); report(f, 'Idle');
  assert.equal(f.session.stopPhase, 'idle');
  assert.equal(f.session.stopPort, null);
  assert.equal(stopCommands(f).slice(count).some(([name]) => name === 'feedhold' || name === 'reset'), false);
});

test('workflow state from a previous port cannot make a new idle port reset', () => {
  const f = fixture(); f.join(); f.socket.receive('workflow:state', 'running');
  f.session.selectPort('COM2'); f.join('COM2'); f.session.stop();
  report(f, 'Idle'); report(f, 'Idle');
  assert.equal(f.session.stopPhase, 'idle');
  assert.equal(stopCommands(f).some(([name]) => name === 'reset' || name === 'feedhold'), false);
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
  assert.match(f.session.status.detail, /press Stop or Reset to recover/);
  f.session.stop(); report(f, 'Hold:0'); report(f, 'Hold:0');
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
  const grbl = new Grbl({ command: (...args) => commands.push(args), status: { phase: 'joined' },
    jog: code => { commands.push(['gcode', code]); return { state: 'queued' }; },
    stopPhase: 'idle', workflowState: 'idle', activeState: 'Idle', settings: { settings: { $110: '3000' } } }, () => 12.5);
  grbl.jog('X', -0.2, 250);
  assert.deepEqual(commands.pop(), ['gcode', '$J=G21 G91 X-0.2000 F250.000']);
  grbl.wcsHome();
  assert.deepEqual(commands.splice(0), [['gcode', ['G21 G53 G0 G90 Z-5', 'G21 G54 G0 G90 X0 Y0']]]);
  grbl.probeZ();
  assert.equal(commands[0][1][0], 'G21 G91');
  assert.equal(commands[0][1][2], 'G10 L20 P1 Z12.501');
  grbl.clearJog();
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

test('one stale completed-hold report cannot reset a running or decelerating machine', () => {
  const f = fixture(); f.join(); f.session.stop();
  report(f, 'Hold:0'); report(f, 'Run'); report(f, 'Run');
  assert.equal(stopCommands(f).filter(([name]) => name === 'feedhold').length, 1);
  report(f, 'Hold:0'); report(f, 'Hold:1'); report(f, 'Hold:0');
  assert.equal(stopCommands(f).some(([name]) => name === 'reset'), false);
  report(f, 'Hold:0'); report(f, 'Hold:0');
  assert.equal(stopCommands(f).filter(([name]) => name === 'reset').length, 1);
});

test('explicit Reset after interruption sends no Stop or hold preamble', () => {
  const f = fixture(); f.join();
  f.socket.receive('workflow:state', 'running'); f.session.stop();
  f.socket.disconnect(); f.socket.connect(); f.join();
  f.socket.receive('workflow:state', 'idle');
  const count = stopCommands(f).length;
  f.session.command('reset');
  assert.deepEqual(stopCommands(f).slice(count).map(([name]) => name), ['reset']);
  assert.equal(f.timers.size, 2);
  report(f, 'Idle'); report(f, 'Hold:0'); report(f, 'Hold:0');
  assert.equal(f.session.stopPhase, 'resetting');
  f.socket.receive('serialport:read', "Grbl 1.1h ['$' for help]");
  report(f, 'Idle'); report(f, 'Idle');
  assert.equal(f.session.stopPhase, 'idle');
  assert.equal(f.timers.size, 1);
});

test('failed joins clear workflow state before trying another port', () => {
  const f = fixture();
  f.list([{ port: 'COM1', inuse: true }]);
  f.socket.receive('workflow:state', 'running');
  f.emitted.findLast(([event]) => event === 'open')[3]('join failed');
  assert.equal(f.session.workflowState, 'unknown');
  f.join('COM2'); f.session.stop(); report(f, 'Idle'); report(f, 'Idle');
  assert.equal(stopCommands(f).some(([name]) => name === 'feedhold' || name === 'reset'), false);
});

test('changing a pending join clears workflow state and ignores its old callback', () => {
  const f = fixture();
  f.list([{ port: 'COM1', inuse: true }]);
  const oldJoin = f.emitted.findLast(([event]) => event === 'open')[3];
  f.socket.receive('workflow:state', 'running');
  f.list([{ port: 'COM2', inuse: true }]);
  assert.equal(f.session.workflowState, 'unknown');
  oldJoin(null);
  assert.equal(f.session.status.port, null);
  f.socket.receive('serialport:open', { port: 'COM2', controllerType: 'Grbl' });
  f.emitted.findLast(([event]) => event === 'open')[3](null);
  f.session.stop(); report(f, 'Idle'); report(f, 'Idle');
  assert.equal(stopCommands(f).some(([name]) => name === 'feedhold' || name === 'reset'), false);
});

test('state/settings and raw status caches are isolated per controller generation', () => {
  const f = fixture(); f.join();
  f.socket.receive('controller:settings', 'Grbl', {settings: {$110:'3000'}});
  f.socket.receive('controller:state', 'Grbl', {status:{ov:[100,100,100]}});
  f.socket.receive('serialport:read', '<Idle|MPos:0,0,0|Ov:101,100,99>');
  assert.equal(f.session.settings.settings.$110,'3000');
  assert.deepEqual(f.session.overrides,[101,100,99]);
  assert.equal(f.session.overrideSequence,1);
  assert.equal(f.session.idleReports,1);
  report(f,'Jog'); assert.equal(f.session.idleReports,0);
  f.session.selectPort('COM2');
  assert.deepEqual(f.session.state,{}); assert.deepEqual(f.session.settings,{});
  assert.deepEqual(f.session.overrides,[]); assert.equal(f.session.activeState,'');
});

function gatedJogFixture(acknowledgements = 'immediate') {
  const f=fixture(); f.join();
  f.socket.receive('workflow:state','idle');
  f.socket.receive('serialport:read','Grbl 1.1h');
  f.socket.receive('controller:settings','Grbl',{settings:{$13:'0',$110:'3000',$111:'3000',$112:'1000'}});
  const machine={state:'Idle',x:0,y:0,z:0};
  const broadcast=()=>f.socket.receive('controller:state','Grbl',{status:{activeState:machine.state,mpos:Object.fromEntries(['x','y','z'].map(axis=>[axis,machine[axis].toFixed(3)]))}});
  broadcast();
  const jobs=new Set(), logs=[];
  const grbl=new Grbl(f.session,()=>20,message=>logs.push(message), {schedule:fn=>{jobs.add(fn);return fn;},cancel:fn=>jobs.delete(fn)});
  const emit=f.socket.emit.bind(f.socket);
  f.socket.emit=(...args)=>{
    emit(...args);
    if(acknowledgements==='immediate' && args[0]==='command' && args[2]==='gcode') {
      f.socket.receive('serialport:write',`${args[3]}\n`,{...args[4],source:'feeder'});
      f.socket.receive('serialport:read','ok');
    }
    // Match CNCjs: its automatic status polls never forward serialport:read.
    if(args[0]==='command' && args[2]==='statusreport') f.socket.receive('serialport:read',`<${machine.state}|MPos:${machine.x.toFixed(3)},${machine.y.toFixed(3)},${machine.z.toFixed(3)}|FS:0,0>`);
    return f.socket;
  };
  const tick=()=>{for(const fn of [...jobs]) { jobs.delete(fn); fn(); }};
  return {...f,grbl,machine,broadcast,jobs,tick,logs};
}

test('automatic controller-state endpoint releases completed Step before a raw poll arrives',()=>{
  const f=gatedJogFixture();
  f.grbl.jog('X',0.04,250);
  assert.equal(f.session.reportSequence,0);
  f.machine.x=0.04; f.broadcast();
  f.grbl.cancelJog();
  assert.equal(stopCommands(f).some(([name])=>name==='jogCancel'),false);
  assert.equal(f.grbl.jog('Y',0.04,250),'sent');
  assert.equal(f.session.reportSequence,0);
  assert.equal(f.jobs.size,1);
  f.grbl.clearJog();
});

test('Step actively requests raw completion reports and stops its only poller on completion',()=>{
  const f=gatedJogFixture(); f.grbl.jog('X',0.04,250);
  f.machine.x=0.04;
  f.tick(); assert.equal(f.session.reportSequence,1);
  f.tick(); assert.equal(f.jobs.size,0); assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(stopCommands(f).filter(([name])=>name==='statusreport').length,1);
});

test('jog cancellation requests both raw Idle reports without an unrelated query',()=>{
  const f=gatedJogFixture(); f.grbl.jog('X',1,250);
  f.machine.state='Jog'; f.broadcast(); f.grbl.cancelJog();
  assert.equal(f.session.reportSequence,1);
  f.machine.state='Idle'; f.machine.x=0.02;
  f.tick(); assert.equal(f.grbl.jogPhase,'canceling');
  f.tick(); f.tick();
  assert.equal(f.session.idleReports,2);
  assert.equal(f.jobs.size,0); assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.grbl.jog('Y',0.04,250),'sent');
  f.grbl.clearJog();
});

for(const event of ['disconnect','reset','stop']) test(`jog poller is discarded on ${event}`,()=>{
  const f=gatedJogFixture(); f.grbl.jog('X',1,250);
  if(event==='disconnect') f.session.disconnect();
  if(event==='reset') f.grbl.reset();
  if(event==='stop') f.grbl.stop();
  const count=stopCommands(f).length;
  f.tick(); assert.equal(f.jobs.size,0);
  assert.equal(stopCommands(f).length,count);
});

test('external controller reset discards the jog target without changing the Stop generation',()=>{
  const f=gatedJogFixture(); f.grbl.jog('X',1,250);
  const generation=f.session.generation;
  const epoch=f.session.motionEpoch;
  f.socket.receive('serialport:read','Grbl 1.1h [\'$\' for help]');
  assert.equal(f.session.generation,generation);
  assert.equal(f.session.motionEpoch,epoch+1);
  f.tick(); assert.equal(f.jobs.size,0); assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.session.positionReport,null);
  f.broadcast();
  assert.equal(f.grbl.jogPulse('X',0.2,60),'sent');
  f.grbl.clearJog();
});

test('a Step below physical/report resolution completes after two requested Idle reports',()=>{
  const f=gatedJogFixture(); f.session.settings.settings.$100='200';
  f.grbl.jog('X',0.001,250);
  f.tick(); f.tick(); f.tick();
  assert.equal(f.jobs.size,0); assert.equal(f.grbl.jogPhase,'idle');
});

test('queued out-and-back Steps require the final jog ACK and two later Idle reports',()=>{
  const f=gatedJogFixture('delayed');
  f.socket.receive('serialport:write','G4 P2\n',{source:'feeder'});
  f.grbl.jog('X',0.04,250); f.grbl.jog('X',-0.04,250);
  const commands=stopCommands(f).filter(([name])=>name==='gcode');
  f.tick(); f.tick(); f.tick();
  assert.equal(f.grbl.jogCompleted(),false);
  assert.equal(f.grbl.jogPhase,'active');
  f.socket.receive('serialport:read','ok'); // Earlier dwell, not a jog.
  for(const [,code,context] of commands) f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  f.socket.receive('serialport:read','ok');
  f.tick(); f.tick();
  assert.equal(f.grbl.jogCompleted(),false,'The first jog ACK cannot acknowledge the second');
  f.socket.receive('serialport:read','ok');
  assert.equal(f.grbl.jogCompleted(),false,'Old Idle reports cannot complete an acknowledged jog');
  f.tick(); assert.equal(f.grbl.jogCompleted(),false);
  f.tick(); assert.equal(f.grbl.jogCompleted(),true);
  f.tick(); assert.equal(f.jobs.size,0);
});

test('mode cancellation remains armed while net-zero Steps are still queued',()=>{
  const f=gatedJogFixture('delayed');
  f.grbl.jog('X',0.04,250); f.grbl.jog('X',-0.04,250);
  f.tick(); f.tick(); f.tick();
  f.grbl.cancelJog();
  assert.ok(stopCommands(f).some(([name])=>name==='feeder:stop'));
  assert.ok(stopCommands(f).some(([name])=>name==='jogCancel'));
  assert.equal(f.session.jogReceipts.size,0);
  f.tick(); f.tick();
  assert.equal(f.grbl.jogPhase,'idle');
});

test('unrelated MDI and manual parser-query replies cannot acknowledge a pendant jog',()=>{
  const f=gatedJogFixture('delayed');
  f.socket.receive('serialport:write','G21\n',{source:'client'});
  f.socket.receive('serialport:write','$G\n',{source:'client'});
  f.grbl.jog('X',0.001,250);
  const [,code,context]=stopCommands(f).findLast(([name])=>name==='gcode');
  f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  f.socket.receive('serialport:read','ok');
  f.socket.receive('serialport:read','[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]');
  f.socket.receive('serialport:read','ok');
  f.tick(); f.tick();
  assert.equal(f.grbl.jogReceipt.state,'written');
  assert.equal(f.grbl.jogCompleted(),false);
  f.socket.receive('serialport:read','ok');
  f.tick(); f.tick();
  assert.equal(f.grbl.jogCompleted(),true);
  f.grbl.clearJog();
});

test('feeder parser-query writes do not consume a later jog ACK',()=>{
  const f=gatedJogFixture('delayed');
  // CNCjs suppresses both the parser response and its ACK for a feeder $G.
  f.socket.receive('serialport:write','$G\n',{source:'feeder'});
  f.grbl.jog('X',0.001,250);
  const [,code,context]=stopCommands(f).findLast(([name])=>name==='gcode');
  f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  f.socket.receive('serialport:read','ok');
  assert.equal(f.grbl.jogReceipt.state,'acknowledged');
  f.grbl.clearJog();
});

test('joining mid-flight cannot mistake an unseen old ACK for tiny-Step completion',()=>{
  const f=gatedJogFixture('delayed');
  f.session.clear(); f.join(); f.socket.receive('workflow:state','idle');
  f.socket.receive('controller:settings','Grbl',{settings:{$13:'0',$110:'3000'}});
  f.broadcast();
  assert.equal(f.session.replyTracking,'unknown');
  f.grbl.jog('X',0.001,250);
  const [,code,context]=stopCommands(f).findLast(([name])=>name==='gcode');
  f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  f.socket.receive('serialport:read','ok'); // Could belong to a pre-join dwell.
  f.tick(); f.tick(); f.tick(); f.tick();
  assert.equal(f.grbl.jogCompleted(),false);
  assert.equal(f.grbl.jogPhase,'armed');
  assert.equal(f.jobs.size,0);
  assert.equal(f.logs.filter(line=>line.includes('cannot be confirmed')).length,1);
  f.grbl.cancelJog();
  assert.ok(stopCommands(f).some(([name])=>name==='jogCancel'));
  f.grbl.clearJog();
});

test('reset and program activity invalidate outstanding jog receipts',()=>{
  const f=gatedJogFixture('delayed');
  f.grbl.jog('X',0.001,250);
  const receipt=f.grbl.jogReceipt;
  f.socket.receive('workflow:state','running');
  assert.equal(receipt.state,'discarded');
  assert.equal(f.session.replyTracking,'unknown');
  f.socket.receive('workflow:state','idle');
  assert.equal(f.session.replyTracking,'unknown');
  f.socket.receive('serialport:read','Grbl 1.1h');
  assert.equal(f.session.replyTracking,'synchronized');
  f.grbl.clearJog();
});

test('unanswered serial writes have bounded bookkeeping and lose correlation conservatively',()=>{
  const f=gatedJogFixture('delayed');
  f.grbl.jog('X',0.001,250);
  const receipt=f.grbl.jogReceipt;
  for(let n=0;n<300;n++) f.socket.receive('serialport:write','G21\n',{source:'client'});
  assert.ok(f.session.serialReplies.length<=256);
  assert.equal(f.session.replyTracking,'unknown');
  assert.equal(receipt.state,'discarded');
  f.grbl.clearJog();
});

test('unwritten jog receipts are bounded without emitting an untracked command',()=>{
  const f=gatedJogFixture('delayed');
  for(let n=0;n<256;n++) assert.equal(f.session.jog('$J=G21 G91 X0.001 F250').state,'queued');
  const count=stopCommands(f).length;
  assert.equal(f.session.jog('$J=G21 G91 X0.001 F250').state,'dropped');
  assert.equal(stopCommands(f).length,count);
  assert.equal(f.session.jogReceipts.size,256);
});

test('raw partial writes invalidate ACK correlation while realtime bytes do not',()=>{
  const f=gatedJogFixture('delayed');
  f.socket.receive('serialport:write','?\x85!',{source:'client'});
  assert.equal(f.session.replyTracking,'synchronized');
  f.socket.receive('serialport:write','G4 P2',{source:'client'});
  assert.equal(f.session.replyTracking,'unknown');
  f.socket.receive('serialport:read','Grbl 1.1h');
  f.socket.receive('serialport:write','G21\r',{source:'client'});
  assert.equal(f.session.replyTracking,'unknown');
});

for(const command of ['$g','$ G']) test(`normalized parser query ${command} cannot misalign jog acknowledgements`,()=>{
  const f=gatedJogFixture('delayed');
  f.socket.receive('serialport:write',`${command}\n`,{source:'client'});
  f.grbl.jog('X',0.001,250);
  const [,code,context]=stopCommands(f).findLast(([name])=>name==='gcode');
  f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  f.socket.receive('serialport:read','ok');
  assert.equal(f.grbl.jogReceipt.state,'acknowledged');
  f.tick(); f.tick(); f.tick();
  assert.equal(f.grbl.jogPhase,'idle');
});

for(const position of ['known','missing']) test(`uncertain ${position}-position jog becomes passive without discarding later MDI`,()=>{
  const f=gatedJogFixture();
  f.socket.receive('workflow:state','running'); f.socket.receive('workflow:state','idle');
  if(position==='missing') { f.session.positionReport=null; f.session.positionReports={}; }
  f.grbl.jog('X',position==='known'?0.001:1,250);
  assert.equal(f.grbl.jogReceipt.state,'uncertain');
  assert.equal(f.grbl.jogReceipt.transmission,'written');
  for(let n=0;n<600;n++) f.tick();
  assert.equal(f.grbl.jogPhase,'armed');
  assert.equal(f.jobs.size,0);
  assert.equal(stopCommands(f).filter(([name])=>name==='statusreport').length,2);
  f.socket.receive('serialport:write','G4 P2\n',{source:'feeder'});
  f.grbl.cancelJog();
  assert.equal(stopCommands(f).some(([name])=>name==='feeder:stop'),false);
  assert.equal(stopCommands(f).some(([name])=>name==='jogCancel'),true);
  f.tick(); f.tick();
  assert.equal(f.grbl.jogPhase,'idle');
});

test('passive queued jogs still clear owned feeder commands and resume wheel input with the same target',()=>{
  const f=gatedJogFixture('delayed');
  f.socket.receive('workflow:state','running'); f.socket.receive('workflow:state','idle');
  f.grbl.jog('X',0.001,250);
  f.tick(); f.tick(); f.tick();
  assert.equal(f.grbl.jogPhase,'armed');
  assert.equal(f.grbl.jog('X',0.04,250),'sent');
  assert.equal(f.grbl.jogPhase,'active');
  assert.equal(f.grbl.jogTarget.value,0.041);
  f.grbl.cancelJog();
  assert.equal(stopCommands(f).some(([name])=>name==='feeder:stop'),true);
  f.grbl.clearJog();
});

test('a program invalidates a passive target without changing the Stop generation',()=>{
  const f=gatedJogFixture();
  f.socket.receive('workflow:state','running'); f.socket.receive('workflow:state','idle');
  f.grbl.jog('X',0.001,250); f.tick(); f.tick(); f.tick();
  assert.equal(f.grbl.jogPhase,'armed');
  const generation=f.session.generation, epoch=f.session.workflowEpoch, motionEpoch=f.session.motionEpoch;
  f.socket.receive('workflow:state','running');
  assert.ok(f.session.workflowEpoch>epoch);
  assert.equal(f.session.motionEpoch,motionEpoch);
  assert.equal(f.session.generation,generation);
  f.machine.x=10; f.broadcast(); f.socket.receive('workflow:state','idle');
  assert.equal(f.grbl.jog('X',1,250),'sent');
  assert.equal(f.grbl.jogTarget.value,11);
  f.machine.x=11; f.broadcast(); f.tick();
  assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.jobs.size,0);
});

test('fresh external motion replaces a written passive target before the next Step',()=>{
  const f=gatedJogFixture();
  f.socket.receive('workflow:state','running'); f.socket.receive('workflow:state','idle');
  f.grbl.jog('X',0.001,250); f.tick(); f.tick(); f.tick();
  assert.equal(f.grbl.jogPhase,'armed');
  f.machine.x=5; f.broadcast();
  assert.equal(f.grbl.jog('X',1,250),'sent');
  assert.equal(f.grbl.jogTarget.value,6);
  f.machine.x=6; f.broadcast(); f.tick();
  assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.jobs.size,0);
});

test('a passive out-and-back target is retained while its owned motion is underway',()=>{
  const f=gatedJogFixture();
  f.socket.receive('workflow:state','running'); f.socket.receive('workflow:state','idle');
  f.grbl.jog('X',0.04,250); f.grbl.jog('X',-0.04,250);
  f.tick(); f.tick(); f.tick();
  assert.equal(f.grbl.jogPhase,'armed');
  f.machine.state='Jog'; f.machine.x=0.02; f.broadcast();
  assert.equal(f.grbl.jog('X',1,250),'sent');
  assert.equal(f.grbl.jogTarget.value,1,'Do not add the next Step to the out-leg midpoint');
  f.machine.state='Idle'; f.machine.x=1; f.broadcast(); f.tick();
  assert.equal(f.grbl.jogPhase,'idle');
});

test('program transitions invalidate jog ownership without discarding pending feed overrides',()=>{
  const f=gatedJogFixture();
  f.socket.receive('serialport:read','<Idle|MPos:0.000,0.000,0.000|Ov:100,100,100>');
  assert.equal(f.grbl.override('feed',20),'sent');
  assert.equal(f.grbl.pendingOverrides.get('feed').target,120);
  f.socket.receive('workflow:state','running');
  f.socket.receive('serialport:read','<Run|MPos:0.000,0.000,0.000|Ov:110,100,100>');
  f.grbl.flushOverrides();
  assert.equal(f.grbl.pendingOverrides.get('feed').target,120);
  assert.equal(stopCommands(f).filter(([name])=>name==='feedOverride').length,2);
  f.socket.receive('serialport:read','<Run|MPos:0.000,0.000,0.000|Ov:120,100,100>');
  f.grbl.flushOverrides();
  assert.equal(f.grbl.pendingOverrides.size,0);
});

test('a fresh coordinate-frame change replaces a written passive target',()=>{
  const f=gatedJogFixture();
  f.socket.receive('workflow:state','running'); f.socket.receive('workflow:state','idle');
  f.grbl.jog('X',0.001,250); f.tick(); f.tick(); f.tick();
  f.socket.receive('serialport:read','<Idle|WPos:10.000,0.000,0.000|FS:0,0>');
  assert.equal(f.grbl.jog('X',1,250),'sent');
  assert.equal(f.grbl.jogTarget.kind,'WPos');
  assert.equal(f.grbl.jogTarget.value,11);
  f.socket.receive('serialport:read','<Idle|WPos:11.000,0.000,0.000|FS:0,0>');
  f.tick(); assert.equal(f.grbl.jogPhase,'idle');
});

test('an unrelated MDI error after passive acknowledgement does not refuse the next Step',()=>{
  const f=gatedJogFixture();
  f.socket.receive('workflow:state','running'); f.socket.receive('workflow:state','idle');
  f.grbl.jog('X',0.001,250); f.tick(); f.tick(); f.tick();
  f.socket.receive('serialport:write','G1\n',{source:'client'});
  f.socket.receive('serialport:read','error:22 (Undefined feed rate)');
  assert.equal(f.grbl.jog('Y',1,250),'sent');
  assert.equal(stopCommands(f).some(([name])=>name==='jogCancel'||name==='feeder:stop'),false);
  assert.equal(f.logs.some(line=>line.includes('error:22')),false);
  f.grbl.clearJog();
});

test('a passive queued jog still recovers when a controller error precedes its write',()=>{
  const f=gatedJogFixture('delayed');
  f.socket.receive('workflow:state','running'); f.socket.receive('workflow:state','idle');
  f.grbl.jog('X',0.001,250); f.tick(); f.tick(); f.tick();
  assert.equal(f.grbl.jogPhase,'armed');
  f.socket.receive('serialport:read','error:22 (Undefined feed rate)');
  assert.equal(f.grbl.jog('Y',1,250),'dropped');
  assert.equal(stopCommands(f).some(([name])=>name==='feeder:stop'),true);
  f.grbl.clearJog();
});

test('a passive written jog with a new rejection still recovers before accepting input',()=>{
  const f=gatedJogFixture('delayed');
  f.socket.receive('workflow:state','running'); f.socket.receive('workflow:state','idle');
  f.grbl.jog('X',0.001,250);
  const [,code,context]=stopCommands(f).findLast(([name])=>name==='gcode');
  f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  f.tick(); f.tick(); f.tick();
  f.socket.receive('serialport:read','error:15 (Travel exceeded)');
  assert.equal(f.grbl.jog('Y',1,250),'dropped');
  assert.equal(stopCommands(f).some(([name])=>name==='jogCancel'),true);
  assert.equal(stopCommands(f).some(([name])=>name==='feeder:stop'),false);
  f.grbl.clearJog();
});

test('receipt invalidation preserves observed transmission and observes a later final write',()=>{
  const f=gatedJogFixture('delayed');
  f.grbl.jog('X',0.001,250);
  const [,code,context]=stopCommands(f).findLast(([name])=>name==='gcode');
  f.socket.receive('serialport:write','G21',{source:'client'}); // Correlation lost.
  assert.equal(f.grbl.jogReceipt.state,'discarded');
  f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  assert.equal(f.grbl.jogReceipt.transmission,'written');
  assert.equal(f.grbl.jogReceipt.state,'discarded','A write must not resurrect an invalid ACK receipt');
  f.tick(); f.tick(); f.tick();
  f.grbl.cancelJog();
  assert.equal(stopCommands(f).some(([name])=>name==='feeder:stop'),false);
  f.grbl.clearJog();
});

test('a startup banner during a running program cannot synchronize hidden sender replies',()=>{
  const f=gatedJogFixture();
  f.socket.receive('workflow:state','running');
  f.socket.receive('serialport:read','Grbl 1.1h');
  assert.equal(f.session.replyTracking,'unknown');
  f.socket.receive('workflow:state','idle');
  assert.equal(f.session.replyTracking,'unknown');
  f.socket.receive('serialport:read','Grbl 1.1h');
  assert.equal(f.session.replyTracking,'synchronized');
});

test('a rejected written-only jog cancels motion without discarding unrelated feeder commands',()=>{
  const f=gatedJogFixture('delayed'); f.grbl.jog('X',1,250);
  const [,code,context]=stopCommands(f).findLast(([name])=>name==='gcode');
  f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  f.socket.receive('serialport:read','error:15 (Travel exceeded)');
  f.tick(); f.tick(); f.tick();
  assert.equal(stopCommands(f).some(([name])=>name==='feeder:stop'),false);
  assert.equal(stopCommands(f).some(([name])=>name==='jogCancel'),true);
  assert.equal(f.grbl.jogPhase,'idle');
});

// These dual-frame values were verified against CNCjs 1.11.5 GrblRunner:
// <Idle|WPos:0.000,0.000,0.000|WCO:10.000,0.000,0.000|FS:0,0>
// yields mpos.x='10.000', wpos.x='0.000'. No CNCjs runtime dependency is needed.
for(const kind of ['MPos','WPos']) for(const order of ['raw-first','broadcast-first']) test(`jog completion survives ${kind} reports and dual-frame broadcasts (${order})`,()=>{
  const f=gatedJogFixture();
  const broadcast=x=>f.socket.receive('controller:state','Grbl',{status:{activeState:'Idle',
    mpos:{x:(x+(kind==='WPos'?10:0)).toFixed(3),y:'0.000',z:'0.000'},
    wpos:{x:(x-(kind==='MPos'?10:0)).toFixed(3),y:'0.000',z:'0.000'}}});
  const raw=x=>f.socket.receive('serialport:read',`<Idle|${kind}:${x.toFixed(3)},0.000,0.000|FS:0,0>`);
  broadcast(0); raw(0);
  assert.equal(f.grbl.jog('X',0.04,250),'sent');
  assert.equal(f.grbl.jogTarget.kind,kind);
  if(order==='raw-first') { raw(0.04); broadcast(0.04); }
  if(order==='broadcast-first') { broadcast(0.04); raw(0.04); }
  assert.equal(f.grbl.jogCompleted(),true);
  f.grbl.cancelJog();
  assert.equal(stopCommands(f).some(([name])=>name==='jogCancel'),false);
  assert.equal(f.grbl.jog('Y',0.04,250),'sent');
  f.grbl.clearJog();
});

test('an offset-only WPos broadcast refreshes its own sample without refreshing MPos',()=>{
  const f=gatedJogFixture();
  const broadcast=x=>f.socket.receive('controller:state','Grbl',{status:{activeState:'Idle',
    mpos:{x:'10.000',y:'0.000',z:'0.000'},wpos:{x,y:'0.000',z:'0.000'}}});
  broadcast('0.000');
  const machineSequence=f.session.positionReports.MPos.sequence;
  const workSequence=f.session.positionReports.WPos.sequence;
  broadcast('-5.000');
  assert.equal(f.session.positionReports.MPos.sequence,machineSequence);
  assert.ok(f.session.positionReports.WPos.sequence>workSequence);
  assert.equal(f.grbl.jog('X',0.04,250),'sent');
  assert.equal(f.grbl.jogTarget.kind,'WPos');
  assert.equal(f.grbl.jogTarget.value,-4.96);
  f.grbl.clearJog();
});

test('a report in the other frame cannot make a stale target-frame endpoint fresh',()=>{
  const f=gatedJogFixture();
  f.grbl.jog('X',0.04,250);
  const machineSequence=f.session.positionReports.MPos.sequence;
  f.socket.receive('serialport:read','<Idle|WPos:0.040,0.000,0.000|FS:0,0>');
  assert.equal(f.session.positionReports.MPos.sequence,machineSequence);
  assert.equal(f.grbl.jogCompleted(),false);
  f.grbl.clearJog();
});

test('both frame caches retain their own reporting units and are cleared on reset/disconnect',()=>{
  const f=gatedJogFixture();
  f.socket.receive('serialport:read','<Idle|WPos:0.000,0.000,0.000|FS:0,0>');
  f.socket.receive('controller:settings','Grbl',{settings:{$13:'1',$110:'3000'}});
  f.socket.receive('serialport:read','<Idle|MPos:1.0000,0.0000,0.0000|FS:0,0>');
  assert.equal(f.session.positionReports.WPos.units,'0');
  assert.equal(f.session.positionReports.MPos.units,'1');
  f.socket.receive('serialport:read','Grbl 1.1h');
  assert.deepEqual(f.session.positionReports,{});
  f.socket.receive('serialport:read','<Idle|WPos:1.0000,0.0000,0.0000|FS:0,0>');
  f.session.disconnect();
  assert.deepEqual(f.session.positionReports,{});
});

for(const travel of ['sub-resolution','out-and-back']) test(`unchanged dual-frame broadcasts release ${travel} Step polling`,()=>{
  const f=gatedJogFixture(); f.session.settings.settings.$100='200';
  const broadcast=()=>f.socket.receive('controller:state','Grbl',{status:{activeState:f.machine.state,
    mpos:{x:f.machine.x.toFixed(3),y:'0.000',z:'0.000'},
    wpos:{x:(f.machine.x-10).toFixed(3),y:'0.000',z:'0.000'}}});
  broadcast();
  assert.equal(f.session.positionReport.kind,'WPos');
  if(travel==='sub-resolution') f.grbl.jog('X',0.001,250);
  if(travel==='out-and-back') {
    f.grbl.jog('X',0.1,250); f.grbl.jog('X',-0.1,250);
    f.machine.x=0.1; f.machine.state='Jog'; f.tick();
    f.machine.x=0; f.machine.state='Idle';
  }
  // Only raw MPos samples advance: both broadcasts finish at the old positions.
  for(let i=0;i<4;i++) { f.tick(); broadcast(); }
  assert.equal(f.grbl.jogPhase,'idle'); assert.equal(f.jobs.size,0);
});

test('a rejected Step drains owned jogs, confirms Idle, and recovers without endless polling',()=>{
  const f=gatedJogFixture('delayed'); f.grbl.jog('X',1,250);
  const [,code,context]=stopCommands(f).findLast(([name])=>name==='gcode');
  f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  f.grbl.jog('X',1,250); // A second owned line is still in the CNCjs feeder.
  f.socket.receive('serialport:read','error:15 (Jog target exceeds machine travel)');
  for(let i=0;i<5;i++) f.tick();
  assert.equal(f.grbl.jogPhase,'idle'); assert.equal(f.jobs.size,0);
  assert.equal(stopCommands(f).filter(([name])=>name==='feeder:stop').length,1);
  assert.equal(stopCommands(f).filter(([name])=>name==='jogCancel').length,1);
  assert.equal(f.grbl.jog('Y',0.04,250),'sent');
  f.grbl.clearJog();
});

test('an error during an active segment drains motion and blocks new pulses through both Idle confirmations',()=>{
  const f=gatedJogFixture(); f.grbl.jogPulse('X',1,250);
  f.machine.state='Jog'; f.broadcast();
  f.socket.receive('serialport:read','error:15 (Travel exceeded)');
  assert.equal(f.grbl.jogPulse('X',1,250),'dropped');
  assert.equal(f.grbl.jogPhase,'canceling');
  assert.match(f.logs.at(-2),/error:15.*canceling queued jogs/);
  for(let i=0;i<3;i++) f.tick();
  assert.equal(stopCommands(f).filter(([name])=>name==='gcode').length,1);
  assert.equal(f.grbl.jogPhase,'canceling');
  f.machine.state='Idle'; f.machine.x=0.25;
  f.tick(); assert.equal(f.grbl.jogPulse('X',1,250),'dropped');
  f.tick(); f.tick(); assert.equal(f.jobs.size,0);
  assert.equal(f.grbl.jogPulse('X',1,250),'sent');
  f.grbl.clearJog();
});

for(const owner of ['program','stop']) test(`jog error recovery leaves the ${owner} interlock in control`,()=>{
  const f=gatedJogFixture(); f.grbl.jog('X',1,250);
  if(owner==='program') f.socket.receive('workflow:state','running');
  if(owner==='stop') f.session.stopPhase='holding';
  f.socket.receive('serialport:read','error:20 (Unsupported command)');
  const count=stopCommands(f).length;
  f.tick();
  assert.equal(stopCommands(f).length,count);
  assert.equal(f.jobs.size,0);
  assert.equal(f.session.workflowState,owner==='program'?'running':'idle');
  assert.equal(f.session.stopPhase,owner==='stop'?'holding':'idle');
});

test('errors outside owned motion and errors predating a jog do not cancel it',()=>{
  const f=gatedJogFixture();
  f.socket.receive('serialport:read','error:20 (Unsupported command)');
  assert.equal(f.grbl.recoverJogError(),'unchanged');
  assert.equal(f.jobs.size,0);
  f.grbl.jog('X',0.04,250); f.tick();
  assert.equal(f.grbl.jogPhase,'active');
  assert.equal(stopCommands(f).some(([name])=>name==='jogCancel'),false);
  f.grbl.clearJog();
});
