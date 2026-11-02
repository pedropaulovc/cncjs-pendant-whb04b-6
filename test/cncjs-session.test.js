import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CncjsSession, isParentMessage } from '../web/widget/cncjs-session.js';
import { Grbl } from '../web/widget/grbl.js';


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

// CNCjs sends stored settings, state, and workflow before the open callback.
function joinWithController(f, settings) {
  f.list([{ port: 'COM5', inuse: true }]);
  f.socket.receive('serialport:open', { port: 'COM5', controllerType: 'Grbl' });
  f.socket.receive('controller:settings', 'Grbl', { version: '', parameters: {}, settings });
  f.socket.receive('controller:state', 'Grbl', { parserstate: { modal: { units: 'G21' } }, status: { activeState: 'Idle', mpos: { x: '0.000', y: '0.000', z: '0.000' } } });
  f.socket.receive('workflow:state', 'idle');
  f.emitted.findLast(([event]) => event === 'open')[3](null);
}

test('FluidNC config supplies the report units and maximum rates its $$ omits', () => {
  const f = fixture();
  joinWithController(f, { $10: '1' });
  assert.deepEqual(stopCommands(f), [['gcode', '$I']]);
  f.socket.receive('serialport:read', '[VER:3.7 FluidNC v3.7.8:]');
  const queries = stopCommands(f)[1][1].split('\n');
  assert.ok(queries.includes('$/report_inches') && queries.includes('$/axes/z/max_rate_mm_per_min'));
  // CNCjs records each `$path=value` reply as a setting and rebroadcasts.
  f.socket.receive('controller:settings', 'Grbl', { settings: { $10: '1', '$/report_inches': 'false',
    '$/axes/x/steps_per_mm': '160.000', '$/axes/x/max_rate_mm_per_min': '3000.000',
    '$/axes/y/max_rate_mm_per_min': '3000.000', '$/axes/z/max_rate_mm_per_min': '2000.000' } });
  const grbl = new Grbl(f.session);
  assert.deepEqual(['X', 'Y', 'Z'].map(axis => grbl.maxRate(axis)), [3000, 3000, 2000]);
  assert.equal(f.session.settings.settings.$13, '0');
  assert.equal(f.session.settings.settings.$100, '160.000');
  f.socket.receive('serialport:read', '[VER:3.7 FluidNC v3.7.8:]');
  assert.equal(stopCommands(f).length, 2);
});

test('GRBL controllers never receive FluidNC config queries', () => {
  const complete = fixture();
  joinWithController(complete, { $13: '0', $110: '500', $111: '500', $112: '300' });
  assert.deepEqual(stopCommands(complete), []);
  const pending = fixture();
  joinWithController(pending, {});
  pending.socket.receive('serialport:read', '[VER:1.1h.20190825:]');
  assert.deepEqual(stopCommands(pending), [['gcode', '$I']]);
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

test('fixed SafeZ, WHome, and probe macros remain G21 with millimetre plate thickness under G20', (t) => {
  const commands = [];
  const grbl = new Grbl({ command: (...args) => commands.push(args), status: { phase: 'joined' }, subscribeMotion: () => () => {},
    jog: code => { commands.push(['gcode', code]); return { state: 'queued' }; },
    state: { parserstate: { modal: { units: 'G20' } } },
    stopPhase: 'idle', workflowState: 'idle', activeState: 'Idle', settings: { settings: { $110: '3000' } } }, () => 12.5);
  t.after(() => grbl.clearJog());
  grbl.safeZ();
  assert.deepEqual(commands.pop(), ['gcode', 'G21 G53 G0 G90 Z-5']);
  grbl.wcsHome();
  assert.deepEqual(commands.splice(0), [['gcode', ['G21 G53 G0 G90 Z-5', 'G21 G54 G0 G90 X0 Y0']]]);
  grbl.probeZ();
  assert.deepEqual(commands[0][1], ['G21 G91', 'G38.2 Z-50 F120', 'G10 L20 P1 Z12.501', 'G0 Z3', 'G90']);
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
  let lastStatus, parserstate={modal:{units:'G21'}};
  const broadcast=(nextParserstate)=>{
    if(nextParserstate) parserstate=nextParserstate;
    const status={activeState:machine.state,mpos:Object.fromEntries(['x','y','z'].map(axis=>[axis,machine[axis].toFixed(3)]))};
    const serialized=JSON.stringify(status);
    if(serialized===lastStatus && !nextParserstate && f.session.positionReport) return;
    lastStatus=serialized;
    f.socket.receive('controller:state','Grbl',{status,parserstate});
  };
  broadcast();
  const jobs=new Set(), deadlines=new Map(), logs=[], deliveries=[];
  let time=0, sending=0, delivering=false;
  const drain=()=>{
    if(sending || delivering) return;
    delivering=true;
    try { while(deliveries.length) deliveries.shift()(); } finally { delivering=false; }
  };
  const motionListeners=new Set(), subscribe=f.session.subscribeMotion.bind(f.session);
  f.session.subscribeMotion=listener=>{
    motionListeners.add(listener);
    const unsubscribe=subscribe(listener);
    return ()=>{motionListeners.delete(listener);unsubscribe();};
  };
  const grbl=new Grbl(f.session,()=>20,message=>logs.push(message), {
    now:()=>time,
    schedule:(fn,ms)=>{jobs.add(fn);deadlines.set(fn,time+ms);return fn;},
    cancel:fn=>{jobs.delete(fn);deadlines.delete(fn);},
  });
  // Real socket feedback arrives after the command stack unwinds. Preserve that
  // boundary even though this deterministic fixture uses synchronous listeners.
  for(const name of ['jog','jogPulse','cancelJog']) {
    const method=grbl[name].bind(grbl);
    grbl[name]=(...args)=>{
      sending++;
      try { return method(...args); } finally { sending--; drain(); }
    };
  }
  const emit=f.socket.emit.bind(f.socket);
  let rawResponses=true;
  f.socket.emit=(...args)=>{
    emit(...args);
    if(acknowledgements==='immediate' && args[0]==='command' && args[2]==='gcode') deliveries.push(()=>{
      f.socket.receive('serialport:write',`${args[3]}\n`,{...args[4],source:'feeder'});
      f.socket.receive('serialport:read','ok');
    });
    // Native CNCjs status is changed-state-only; only an explicit pendant query
    // forwards a raw response, including repeated identical Idle reports.
    if(rawResponses && args[0]==='command' && args[2]==='statusreport') deliveries.push(()=>
      f.socket.receive('serialport:read',`<${machine.state}|MPos:${machine.x.toFixed(3)},${machine.y.toFixed(3)},${machine.z.toFixed(3)}|FS:0,0>`));
    return f.socket;
  };
  const tick=(delay)=>{
    const next=[...jobs].filter(fn=>delay===undefined || deadlines.get(fn)-time===delay)
      .sort((a,b)=>deadlines.get(a)-deadlines.get(b))[0];
    if(!next) { if(delay!==undefined) assert.fail(`No timer scheduled in ${delay} ms`); return; }
    time=deadlines.get(next); jobs.delete(next); deadlines.delete(next); next(); drain();
  };
  const advance=ms=>{
    const end=time+ms;
    while([...jobs].some(fn=>deadlines.get(fn)<=end)) tick();
    time=end;
  };
  return {...f,grbl,machine,broadcast,jobs,tick,advance,logs,drain,motionListeners,
    rawResponses:enabled=>{rawResponses=enabled;},
    queries:()=>stopCommands(f).filter(([name])=>name==='statusreport').length};
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
  f.grbl.clearJog();
});

test('an ambiguous Idle starts only a delayed bounded raw confirmation burst',()=>{
  const f=gatedJogFixture(); f.grbl.jog('X',0.04,250);
  assert.equal(f.queries(),0);
  f.machine.x=0.04;
  f.tick(750);
  assert.equal(f.session.reportSequence,1);
  assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.queries(),1);
  assert.equal(f.jobs.size,0);
  assert.equal(f.motionListeners.size,0);
});

test('jog cancellation requests both raw Idle reports without an unrelated query',()=>{
  const f=gatedJogFixture(); f.grbl.jog('X',1,250);
  f.machine.state='Jog'; f.broadcast(); f.grbl.cancelJog();
  assert.equal(f.session.reportSequence,0,'Cancel must not query immediately');
  f.machine.state='Idle'; f.machine.x=0.02; f.broadcast();
  assert.equal(f.grbl.jogPhase,'canceling','Native Idle cannot replace two raw confirmations');
  f.tick(750); assert.equal(f.grbl.jogPhase,'canceling');
  f.tick(250);
  assert.equal(f.session.idleReports,2);
  assert.equal(f.jobs.size,0); assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.grbl.jog('Y',0.04,250),'sent');
  f.grbl.clearJog();
});

for(const event of ['disconnect','reset','stop','program']) test(`jog observation is discarded on ${event}`,()=>{
  const f=gatedJogFixture(); f.grbl.jog('X',1,250);
  if(event==='disconnect') f.session.disconnect();
  if(event==='reset') f.grbl.reset();
  if(event==='stop') f.grbl.stop();
  if(event==='program') f.socket.receive('workflow:state','running');
  assert.equal(f.jobs.size,0);
  assert.equal(f.motionListeners.size,0);
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
  assert.equal(f.queries(),0);
  f.tick(750); assert.equal(f.grbl.jogPhase,'active');
  f.tick(250);
  assert.equal(f.queries(),2);
  assert.equal(f.jobs.size,0); assert.equal(f.grbl.jogPhase,'idle');
});

test('out-and-back Steps merge until the controller acknowledges the first and complete after its ACK and two Idle reports',()=>{
  const f=gatedJogFixture('delayed');
  f.socket.receive('serialport:write','G4 P2\n',{source:'feeder'});
  assert.equal(f.grbl.jog('X',0.04,250),'sent');
  assert.equal(f.grbl.jog('X',-0.03,250),'buffered');
  assert.equal(f.grbl.jog('X',-0.01,250),'buffered');
  report(f,'Idle'); report(f,'Idle');
  assert.equal(f.queries(),0,'A queued jog behind a dwell cannot query its way into completion');
  const gcode=()=>stopCommands(f).filter(([name])=>name==='gcode');
  const write=([,code,context])=>f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  f.tick(50); f.tick(50); f.tick(50);
  assert.equal(gcode().length,1,'Merged input waits while the first line is unsent');
  assert.equal(f.grbl.jogCompleted(),false);
  assert.equal(f.grbl.jogPhase,'active');
  write(gcode()[0]);
  f.socket.receive('serialport:read','ok'); // Earlier dwell, not a jog.
  f.tick();
  assert.equal(gcode().length,1,'A written line the controller has not acknowledged still holds merged input');
  f.socket.receive('serialport:read','ok');
  f.tick();
  assert.deepEqual(gcode().map(([,code])=>code),['$J=G21 G91 X0.0400 F250.000','$J=G21 G91 X-0.0400 F250.000']);
  write(gcode()[1]);
  report(f,'Idle'); report(f,'Idle');
  assert.equal(f.grbl.jogCompleted(),false,'The first jog ACK cannot acknowledge the merged line');
  f.socket.receive('serialport:read','ok');
  assert.equal(f.grbl.jogCompleted(),false,'Old Idle reports cannot complete an acknowledged jog');
  f.tick(750); assert.equal(f.grbl.jogCompleted(),false);
  f.tick(250); assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.jobs.size,0);
});

test('a fast wheel keeps one unacknowledged jog line in flight and preserves every detent',()=>{
  const f=gatedJogFixture('delayed');
  const gcode=()=>stopCommands(f).filter(([name])=>name==='gcode');
  const write=([,code,context])=>f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  // CNCjs writes a lone line immediately; the controller's ok is the only backpressure.
  for(let i=0;i<20;i++) { f.grbl.jog('X',0.1,250); if(i===0) write(gcode()[0]); }
  f.tick();
  assert.equal(gcode().length,1);
  f.socket.receive('serialport:read','ok');
  // The first detent after the ok sends the merge at once; later ones wait again.
  for(let i=0;i<5;i++) f.grbl.jog('X',0.1,250);
  f.tick();
  assert.deepEqual(gcode().map(([,code])=>code),['$J=G21 G91 X0.1000 F250.000','$J=G21 G91 X2.0000 F250.000']);
  write(gcode()[1]); f.tick();
  assert.equal(gcode().length,2);
  f.socket.receive('serialport:read','ok'); f.tick();
  assert.equal(gcode().at(-1)[1],'$J=G21 G91 X0.4000 F250.000');
  assert.equal(f.grbl.jogTarget.value,2.5,'Every detent travels: 25 x 0.1 mm');
  for(let i=0;i<3;i++) f.grbl.jog('X',0.1,250);
  f.grbl.cancelJog();
  f.tick();
  assert.equal(gcode().length,3,'Cancellation discards merged input that was never sent');
  assert.equal(f.grbl.jogBacklog,null);
  assert.ok(stopCommands(f).some(([name])=>name==='feeder:stop'));
});

for(const [event,trigger] of [
  ['a controller reset',f=>{ f.socket.receive('serialport:read','Grbl 1.1h'); f.broadcast(); }],
  ['program activity',f=>{ f.socket.receive('workflow:state','running'); f.socket.receive('workflow:state','idle'); }],
]) test(`merged Step detents are discarded, never sent, after ${event}`,()=>{
  const f=gatedJogFixture('delayed');
  const gcode=()=>stopCommands(f).filter(([name])=>name==='gcode');
  f.grbl.jog('X',0.1,250);
  const [,code,context]=gcode()[0];
  f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  for(let i=0;i<20;i++) assert.equal(f.grbl.jog('X',0.1,250),'buffered');
  const backlogTimer=f.grbl.backlogTimer;
  trigger(f);
  // Even a captured callback canceled by the subscription must stay harmless.
  backlogTimer();
  for(let i=0;i<4;i++) f.tick();
  assert.equal(gcode().length,1,'No motion may start without new wheel input');
  assert.equal(f.grbl.jogBacklog,null);
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
  report(f,'Idle'); report(f,'Idle');
  assert.equal(f.grbl.jogReceipt.state,'written');
  assert.equal(f.grbl.jogCompleted(),false);
  f.socket.receive('serialport:read','ok');
  f.tick(); f.tick();
  assert.equal(f.grbl.jogPhase,'idle');
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
  f.tick(750); f.tick(250);
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
  f.tick(750); f.tick(250);
  assert.equal(f.grbl.jogPhase,'idle');
});

for(const position of ['known','missing']) test(`uncertain ${position}-position jog becomes passive without discarding later MDI`,()=>{
  const f=gatedJogFixture();
  f.socket.receive('workflow:state','running'); f.socket.receive('workflow:state','idle');
  if(position==='missing') { f.session.positionReport=null; f.session.positionReports={}; }
  f.grbl.jog('X',position==='known'?0.001:1,250);
  assert.equal(f.grbl.jogReceipt.state,'uncertain');
  assert.equal(f.grbl.jogReceipt.transmission,'written');
  f.tick(750); f.tick(250);
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
  assert.equal(f.grbl.jog('X',0.04,250),'buffered');
  const [,code,context]=stopCommands(f).findLast(([name])=>name==='gcode');
  f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  f.tick(); assert.equal(f.grbl.jogPhase,'armed');
  f.socket.receive('serialport:read','ok');
  f.tick();
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
  const broadcast=x=>f.socket.receive('controller:state','Grbl',{parserstate:{modal:{units:'G21'}},status:{activeState:'Idle',
    mpos:{x:(x+(kind==='WPos'?10:0)).toFixed(3),y:'0.000',z:'0.000'},
    wpos:{x:(x-(kind==='MPos'?10:0)).toFixed(3),y:'0.000',z:'0.000'}}});
  const raw=x=>f.socket.receive('serialport:read',`<Idle|${kind}:${x.toFixed(3)},0.000,0.000|FS:0,0>`);
  broadcast(0); raw(0);
  assert.equal(f.grbl.jog('X',0.04,250),'sent');
  assert.equal(f.grbl.jogTarget.kind,kind);
  if(order==='raw-first') { raw(0.04); broadcast(0.04); }
  if(order==='broadcast-first') { broadcast(0.04); raw(0.04); }
  assert.equal(f.grbl.jogPhase,'idle');
  f.grbl.cancelJog();
  assert.equal(stopCommands(f).some(([name])=>name==='jogCancel'),false);
  assert.equal(f.grbl.jog('Y',0.04,250),'sent');
  f.grbl.clearJog();
});

test('an offset-only WPos broadcast refreshes its own sample without refreshing MPos',()=>{
  const f=gatedJogFixture();
  const broadcast=x=>f.socket.receive('controller:state','Grbl',{parserstate:{modal:{units:'G21'}},status:{activeState:'Idle',
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

for(const travel of ['sub-resolution','out-and-back']) test(`unchanged dual-frame ${travel} needs bounded raw Idle confirmation`,()=>{
  const f=gatedJogFixture(); f.session.settings.settings.$100='200';
  const broadcast=()=>f.socket.receive('controller:state','Grbl',{parserstate:{modal:{units:'G21'}},status:{activeState:f.machine.state,
    mpos:{x:f.machine.x.toFixed(3),y:'0.000',z:'0.000'},
    wpos:{x:(f.machine.x-10).toFixed(3),y:'0.000',z:'0.000'}}});
  broadcast();
  assert.equal(f.session.positionReport.kind,'WPos');
  if(travel==='sub-resolution') f.grbl.jog('X',0.001,250);
  if(travel==='out-and-back') {
    f.grbl.jog('X',0.1,250); f.grbl.jog('X',-0.1,250);
    f.machine.x=0.1; f.machine.state='Jog'; broadcast();
    f.machine.x=0; f.machine.state='Idle'; broadcast();
  }
  // Changed frames establish motion; unchanged cached frames cannot prove that
  // an out-and-back or sub-resolution command executed after its last ACK.
  assert.equal(f.queries(),0);
  f.tick(750); broadcast(); assert.equal(f.grbl.jogPhase,'active');
  f.tick(250);
  assert.equal(f.grbl.jogPhase,'idle'); assert.equal(f.jobs.size,0);
});

test('a rejected Step drops merged input, confirms Idle, and recovers without endless polling',()=>{
  const f=gatedJogFixture('delayed'); f.grbl.jog('X',1,250);
  const [,code,context]=stopCommands(f).findLast(([name])=>name==='gcode');
  f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  assert.equal(f.grbl.jog('X',1,250),'buffered'); // Held in the pendant until the first line's reply.
  f.socket.receive('serialport:read','error:15 (Jog target exceeds machine travel)');
  for(let i=0;i<5;i++) f.tick();
  assert.equal(f.grbl.jogPhase,'idle'); assert.equal(f.jobs.size,0);
  assert.equal(f.grbl.jogBacklog,null);
  assert.equal(stopCommands(f).filter(([name])=>name==='gcode').length,1,'The merged Step after a rejection is never sent');
  assert.equal(stopCommands(f).filter(([name])=>name==='feeder:stop').length,0,'No owned line remains in the CNCjs feeder');
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
  assert.ok(f.logs.some(line=>/error:15.*canceling queued jogs/.test(line)));
  for(let i=0;i<3;i++) f.tick();
  assert.equal(stopCommands(f).filter(([name])=>name==='gcode').length,1);
  assert.equal(f.grbl.jogPhase,'canceling');
  f.machine.state='Idle'; f.machine.x=0.25; f.broadcast();
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
  f.grbl.jog('X',0.04,250);
  assert.equal(f.grbl.jogPhase,'active');
  assert.equal(stopCommands(f).some(([name])=>name==='jogCancel'),false);
  f.grbl.clearJog();
});

for(const distances of [[1],[7,-1]]) test(`native ${distances.join('/')} mm F250 motion completes without extra status queries`,()=>{
  const f=gatedJogFixture();
  assert.equal(f.motionListeners.size,0,'No listener before pendant motion');
  let endpoint=0;
  for(const distance of distances) {
    assert.equal(f.grbl.jog('X',distance,250),'sent');
    endpoint+=distance;
    for(let n=1;n<=12;n++) {
      f.machine.state='Jog'; f.machine.x=endpoint-distance+distance*n/12; f.broadcast();
      f.advance(250);
      assert.equal(f.grbl.jogPhase,'active');
      assert.equal(f.queries(),0,'Native progress must never trigger a pendant query');
    }
    f.machine.state='Idle'; f.broadcast();
    assert.equal(f.grbl.jogPhase,'idle','Fresh endpoint Idle releases ownership immediately');
    assert.equal(f.jobs.size,0);
    assert.equal(f.motionListeners.size,0);
  }
  assert.equal(f.queries(),0);
  assert.equal(f.session.reportSequence,0,'No raw feedback was needed');
  assert.equal(stopCommands(f).filter(([name])=>name==='gcode').length,distances.length);
});

test('cached and parser-only broadcasts cannot count as fresh completion evidence',()=>{
  const f=gatedJogFixture(); f.grbl.jog('X',0.001,250);
  const sequence=f.session.positionReport.sequence;
  for(let n=0;n<8;n++) f.broadcast({modal:{units:n%2?'G20':'G21'}});
  assert.equal(f.session.positionReport.sequence,sequence);
  assert.equal(f.session.reportSequence,0);
  assert.equal(f.grbl.jogPhase,'active');
  assert.equal(f.queries(),0);
  f.tick(750); assert.equal(f.grbl.jogPhase,'active');
  for(let n=0;n<8;n++) f.broadcast({modal:{units:'G21'}});
  assert.equal(f.grbl.jogPhase,'active','Parser updates cannot replace the second raw Idle');
  f.tick(250);
  assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.queries(),2);
});

for(const endpoint of [0,0.25]) test(`clipped jog at ${endpoint} mm requires five post-ACK raw Idle confirmations`,()=>{
  const f=gatedJogFixture(); f.grbl.jog('X',1,250);
  if(endpoint) { f.machine.state='Jog'; f.machine.x=endpoint; f.broadcast(); }
  f.machine.state='Idle'; f.broadcast();
  assert.equal(f.queries(),0);
  for(let n=0;n<5;n++) {
    f.tick(n===0?750:250);
    assert.equal(f.queries(),n+1);
    assert.equal(f.grbl.jogPhase,n===4?'idle':'active');
  }
  assert.match(f.logs.at(-1),/ended short of its target/);
  assert.equal(f.jobs.size,0);
  assert.equal(f.motionListeners.size,0);
});

for(const order of ['raw-first','native-first','raw-only']) test(`changing raw Jog positions keep long motion observed (${order})`,()=>{
  const f=gatedJogFixture(); f.grbl.jog('X',20,250);
  for(let sample=1;sample<=20;sample++) {
    f.advance(250);
    f.machine.state='Jog'; f.machine.x=sample*0.5;
    if(order==='native-first') f.broadcast();
    f.socket.receive('serialport:read',`<Jog|MPos:${f.machine.x.toFixed(3)},0.000,0.000|FS:250,0>`);
    const positionSequence=f.session.positionSequence;
    if(order==='raw-first') {
      f.broadcast();
      assert.equal(f.session.positionSequence,positionSequence,'The native echo is still the same sample');
    }
    assert.equal(f.grbl.jogPhase,'active',`Changing feedback must retain observation at ${sample*250} ms`);
    assert.equal(f.motionListeners.size,1);
    assert.equal(f.queries(),0,'Raw/native moving feedback must not trigger pendant queries');
  }
  f.machine.state='Idle'; f.machine.x=20; f.broadcast();
  assert.equal(f.grbl.jogPhase,'idle','The fresh final endpoint releases ownership without operator input');
  assert.equal(f.motionListeners.size,0);
  assert.equal(f.jobs.size,0);
  assert.equal(f.logs.length,0);
  assert.equal(f.queries(),0);
});

test('unchanged raw Jog samples do not disguise lost position progress',()=>{
  const f=gatedJogFixture(); f.grbl.jog('X',20,250);
  f.machine.state='Jog'; f.machine.x=0.5; f.broadcast();
  for(let sample=0;sample<11;sample++) {
    f.advance(250);
    f.socket.receive('serialport:read','<Jog|MPos:0.500,0.000,0.000|FS:250,0>');
    f.broadcast();
  }
  f.advance(250);
  assert.equal(f.grbl.jogPhase,'armed');
  assert.equal(f.queries(),0);
  assert.equal(f.motionListeners.size,0);
  f.grbl.clearJog();
});

test('lost native moving feedback is bounded and never completes motion',()=>{
  const f=gatedJogFixture();
  f.grbl.jog('X',1,250);
  f.machine.state='Jog'; f.machine.x=0.2; f.broadcast();
  f.tick(3000);
  assert.equal(f.grbl.jogPhase,'armed');
  assert.equal(f.grbl.jogCompleted(),false);
  assert.equal(f.queries(),0,'A watchdog cannot query or infer Idle');
  assert.equal(f.jobs.size,0);
  assert.equal(f.motionListeners.size,0);
  assert.equal(f.logs.length,1);
  for(let n=0;n<10;n++) f.tick();
  assert.equal(f.logs.length,1);
  f.grbl.clearJog();
});

test('an unanswered Idle confirmation burst stops after five requests without completing',()=>{
  const f=gatedJogFixture(); f.rawResponses(false); f.grbl.jog('X',1,250);
  for(let n=0;n<5;n++) f.tick(n===0?750:250);
  for(let n=0;n<10;n++) f.tick();
  assert.equal(f.queries(),5);
  assert.equal(f.grbl.jogPhase,'armed');
  assert.equal(f.grbl.jogCompleted(),false);
  assert.equal(f.jobs.size,0);
  assert.equal(f.motionListeners.size,0);
  f.grbl.clearJog();
});

test('failed cancellation remains blocked and cached Idle cannot restart its bounded burst',()=>{
  const f=gatedJogFixture(); f.grbl.jog('X',1,250);
  f.grbl.cancelJog(); f.rawResponses(false);
  assert.equal(f.queries(),0);
  for(let n=0;n<5;n++) f.tick(n===0?750:250);
  for(let n=0;n<8;n++) f.broadcast({modal:{units:'G21'}});
  for(let n=0;n<10;n++) f.tick();
  assert.equal(f.queries(),5);
  assert.equal(f.grbl.jogPhase,'canceling');
  assert.equal(f.jobs.size,0);
  assert.equal(f.grbl.jog('Y',1,250),'dropped');
  f.machine.state='Jog'; f.machine.x=0.1; f.broadcast();
  assert.equal(f.queries(),5,'Fresh progress does not query while moving');
  f.rawResponses(true); f.machine.state='Idle'; f.broadcast();
  f.tick(750); assert.equal(f.grbl.jogPhase,'canceling');
  f.tick(250);
  assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.jobs.size,0);
  assert.equal(f.motionListeners.size,0);
});

test('fresh native progress interrupts a confirmation burst until a new Idle ambiguity delay',()=>{
  const f=gatedJogFixture(); f.grbl.jog('X',1,250);
  f.tick(750); assert.equal(f.queries(),1);
  f.machine.state='Jog'; f.machine.x=0.2; f.broadcast();
  assert.equal(f.queries(),1);
  f.machine.x=0.3; f.broadcast();
  f.machine.state='Idle'; f.machine.x=0.4; f.broadcast();
  f.tick(750); assert.equal(f.queries(),2);
  for(let n=0;n<4;n++) f.tick(250);
  assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.queries(),6,'Fresh motion starts a new bounded burst');
});

test('motion subscription observes mutations before notification and unsubscribe ends delivery',()=>{
  const f=fixture(); f.join(); f.socket.receive('workflow:state','idle');
  f.socket.receive('serialport:read','Grbl 1.1h');
  const observed=[];
  let receipt;
  const unsubscribe=f.session.subscribeMotion(progress=>observed.push({
    progress, state:f.session.activeState, workflow:f.session.workflowState,
    sequence:f.session.reportSequence, position:f.session.positionReport?.values[0],
    receipt:receipt?.state,
    epoch:f.session.motionEpoch,
  }));
  f.socket.receive('controller:state','Grbl',{status:{activeState:'Jog',mpos:{x:'0.500',y:'0.000',z:'0.000'}}});
  assert.equal(observed.at(-1).position,0.5);
  assert.equal(observed.at(-1).progress,true);
  report(f,'Idle');
  assert.equal(observed.at(-1).sequence,1);
  assert.equal(observed.at(-1).state,'Idle');
  receipt=f.session.jog('$J=G21 G91 X0.001 F250');
  const [,code,context]=stopCommands(f).findLast(([name])=>name==='gcode');
  f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  assert.equal(observed.at(-1).receipt,'written');
  f.socket.receive('serialport:read','ok');
  assert.equal(receipt.state,'acknowledged');
  assert.equal(observed.at(-1).receipt,'acknowledged');
  f.socket.receive('workflow:state','running');
  assert.equal(observed.at(-1).workflow,'running');
  const epoch=f.session.motionEpoch;
  f.socket.receive('serialport:read','Grbl 1.1h');
  assert.equal(observed.at(-1).epoch,epoch+1);
  unsubscribe(); unsubscribe();
  const count=observed.length;
  f.socket.receive('serialport:read','<Idle|MPos:1,0,0>');
  f.session.disconnect();
  assert.equal(observed.length,count);
});

test('a long dwell before ACK preserves every merged detent without status queries or a deadline',()=>{
  const f=gatedJogFixture('delayed');
  f.socket.receive('serialport:write','G4 P10\n',{source:'feeder'});
  f.grbl.jog('X',1,250);
  const gcode=()=>stopCommands(f).filter(([name])=>name==='gcode');
  const write=([,code,context])=>f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  write(gcode()[0]);
  assert.equal(f.grbl.jog('X',2,250),'buffered');
  f.advance(5000);
  assert.equal(f.grbl.jogPhase,'active');
  assert.equal(f.grbl.jogBacklog.distance,2);
  assert.equal(f.queries(),0);
  assert.equal(gcode().length,1);
  f.socket.receive('serialport:read','ok'); // Dwell, not the jog.
  f.advance(5000);
  assert.equal(f.grbl.jogBacklog.distance,2);
  assert.equal(f.queries(),0);
  assert.equal(gcode().length,1);
  f.socket.receive('serialport:read','ok');
  f.tick(50);
  assert.equal(gcode().length,2);
  assert.equal(gcode()[1][1],'$J=G21 G91 X2.0000 F250.000');
  assert.equal(f.grbl.jogTarget.value,3);
  write(gcode()[1]);
  f.advance(5000);
  assert.equal(f.grbl.jogCompleted(),false);
  assert.equal(f.queries(),0);
  f.socket.receive('serialport:read','ok');
  f.machine.state='Jog'; f.machine.x=3; f.broadcast();
  f.machine.state='Idle'; f.broadcast();
  assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.jobs.size,0);
  assert.equal(f.motionListeners.size,0);
});

test('zero-sum backlog after its trusted ACK re-evaluates unchanged Idle with a fresh delay',()=>{
  const f=gatedJogFixture('delayed'); f.session.settings.settings.$100='200';
  f.grbl.jog('X',0.001,250);
  const [,code,context]=stopCommands(f).findLast(([name])=>name==='gcode');
  f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  f.grbl.jog('X',0.04,250); f.grbl.jog('X',-0.04,250);
  f.advance(4000);
  assert.equal(f.grbl.jogBacklog.distance,0);
  assert.equal(f.queries(),0);
  f.socket.receive('serialport:read','ok');
  f.tick(50);
  assert.equal(f.grbl.jogBacklog,null);
  assert.equal(stopCommands(f).filter(([name])=>name==='gcode').length,1);
  assert.equal(f.queries(),0);
  f.tick(750); assert.equal(f.grbl.jogPhase,'active');
  f.tick(250);
  assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.jobs.size,0);
  assert.equal(f.motionListeners.size,0);
});

for(const kind of ['MPos','WPos']) test(`a native dual-frame echo of raw ${kind} preserves sample freshness`,()=>{
  const f=gatedJogFixture();
  const native=x=>f.socket.receive('controller:state','Grbl',{parserstate:{modal:{units:'G21'}},status:{activeState:'Idle',
    mpos:{x:(x+(kind==='WPos'?10:0)).toFixed(3),y:'0.000',z:'0.000'},
    wpos:{x:(x-(kind==='MPos'?10:0)).toFixed(3),y:'0.000',z:'0.000'}}});
  native(0);
  f.socket.receive('serialport:read',`<Idle|${kind}:0.250,0.000,0.000|FS:0,0>`);
  const positionSequence=f.session.positionSequence, reportSequence=f.session.reportSequence;
  const rawSequence=f.session.positionReport.sequence;
  native(0.25);
  assert.equal(f.session.positionSequence,positionSequence);
  assert.equal(f.session.reportSequence,reportSequence);
  assert.equal(f.session.positionReports.MPos.sequence,rawSequence);
  assert.equal(f.session.positionReports.WPos.sequence,rawSequence);
});

test('a raw-first native echo cannot restart the Idle grace period',()=>{
  const f=gatedJogFixture(); f.rawResponses(false);
  f.grbl.jog('X',1,250);
  f.advance(250);
  f.socket.receive('serialport:read','<Idle|MPos:0.250,0.000,0.000|FS:0,0>');
  f.machine.x=0.25; f.broadcast();
  assert.equal(f.queries(),0);
  f.tick(500);
  assert.equal(f.queries(),1,'The original 750 ms ambiguity deadline remains in force');
  f.grbl.clearJog();
});

test('a clipped raw reply echoed natively cannot renew a failed five-query burst',()=>{
  const f=gatedJogFixture(); f.grbl.jog('X',1,250);
  f.machine.x=0.25;
  f.tick(750);
  assert.equal(f.queries(),1);
  const positionSequence=f.session.positionSequence, reportSequence=f.session.reportSequence;
  f.rawResponses(false);
  f.advance(100);
  f.broadcast();
  assert.equal(f.session.positionSequence,positionSequence);
  assert.equal(f.session.reportSequence,reportSequence);
  f.tick(150);
  assert.equal(f.queries(),2,'The native echo cannot restart the 750 ms grace period');
  for(let n=0;n<3;n++) f.tick(250);
  f.advance(5000);
  assert.equal(f.queries(),5,'A raw echo cannot reset the confirmation request budget');
  assert.equal(f.grbl.jogPhase,'armed');
  assert.equal(f.jobs.size,0);
  assert.equal(f.motionListeners.size,0);
  assert.equal(f.grbl.jogCompleted(),false);
  f.grbl.clearJog();
});

for(const [event,interrupt] of [
  ['reset',f=>f.socket.receive('serialport:read','Grbl 1.1h')],
  ['disconnect',f=>f.session.disconnect()],
  ['program',f=>f.socket.receive('workflow:state','running')],
]) test(`an inline ${event} during jog emission cannot adopt the changed motion session`,()=>{
  const f=gatedJogFixture('delayed');
  const send=f.session.jog.bind(f.session);
  f.session.jog=code=>{
    const receipt=send(code);
    interrupt(f);
    return receipt;
  };
  assert.equal(f.grbl.jog('X',1,250),'dropped');
  assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.grbl.jogTarget,null);
  assert.equal(f.grbl.jogReceipt,null);
  assert.equal(f.jobs.size,0);
  assert.equal(f.motionListeners.size,0);
  const commands=stopCommands(f).length;
  f.advance(5000);
  assert.equal(stopCommands(f).length,commands);
});

test('motion notification does not revisit observers added during the same delivery',()=>{
  const f=fixture(); f.join();
  const calls=[];
  let unsubscribeFirst, unsubscribeSecond;
  unsubscribeFirst=f.session.subscribeMotion(()=>{
    calls.push('first');
    unsubscribeFirst();
    unsubscribeSecond=f.session.subscribeMotion(()=>calls.push('second'));
  });
  report(f,'Idle');
  assert.deepEqual(calls,['first']);
  report(f,'Idle');
  assert.deepEqual(calls,['first','second']);
  unsubscribeSecond();
});

test('an inline rejected jog ACK starts ordinary cancellation with exactly one observer',()=>{
  const f=gatedJogFixture('delayed');
  const send=f.session.jog.bind(f.session);
  f.session.jog=code=>{
    const receipt=send(code);
    const [,written,context]=stopCommands(f).findLast(([name])=>name==='gcode');
    f.socket.receive('serialport:write',`${written}\n`,{...context,source:'feeder'});
    f.socket.receive('serialport:read','error:15 (Travel exceeded)');
    return receipt;
  };
  f.grbl.jog('X',1,250);
  assert.equal(f.grbl.jogPhase,'canceling');
  assert.equal(f.motionListeners.size,1);
  assert.equal(f.session.motionListeners.size,1);
  assert.equal(f.jobs.size,1);
  assert.equal(f.queries(),0);
  assert.equal(stopCommands(f).filter(([name])=>name==='jogCancel').length,1);
  assert.equal(stopCommands(f).filter(([name])=>name==='feeder:stop').length,0);
  assert.equal(f.logs.filter(line=>/error:15.*canceling queued jogs/.test(line)).length,1);
  f.tick(750);
  assert.equal(f.grbl.jogPhase,'canceling');
  assert.equal(f.motionListeners.size,1);
  f.tick(250);
  assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.motionListeners.size,0);
  assert.equal(f.session.motionListeners.size,0);
  assert.equal(f.jobs.size,0);
});

function jogCommands(f) {
  return stopCommands(f).filter(([name])=>name==='gcode');
}

function acknowledgeJog(f, command=jogCommands(f).at(-1)) {
  const [,code,context]=command;
  f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
  f.socket.receive('serialport:read','ok');
}

function assertNear(actual, expected, tolerance=1e-10) {
  assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} must be within ${tolerance} of ${expected}`);
}

for(const [code,scale,label] of [['G20',25.4,'in'],['G21',1,'mm']]) {
  for(const axis of ['X','Y','Z']) for(const direction of [-1,1]) {
    test(`${code} ${axis} ${direction>0?'+':'-'} jog serializes internal millimetres in current modal units`,()=>{
      const f=gatedJogFixture();
      f.broadcast({modal:{units:code}});
      assert.equal(f.grbl.jogUnits.code,code);
      assert.equal(f.grbl.jogUnits.scale,scale);
      assert.equal(f.grbl.jogUnits.label,label);
      const parserstate=f.session.state.parserstate;
      assert.equal(f.grbl.jog(axis,direction*25.4,254),'sent');
      const distance=code==='G20'?`${direction.toFixed(6)}`:(direction*25.4).toFixed(4);
      const feed=code==='G20'?'10.000000':'254.000';
      assert.equal(jogCommands(f).at(-1)[1],`$J=${code} G91 ${axis}${distance} F${feed}`);
      assertNear(f.grbl.jogTarget.value,direction*25.4);
      assert.equal(f.session.state.parserstate,parserstate,'$J must not rewrite the program parser state');
      assert.equal(parserstate.modal.units,code);
      f.machine[axis.toLowerCase()]=direction*25.4; f.broadcast();
      assert.equal(f.grbl.jogPhase,'idle');
      f.grbl.clearJog();
    });
  }
}

for(const code of ['G20','G21']) for(const reportUnits of ['0','1']) for(const kind of ['MPos','WPos']) {
  test(`${code} wire units are independent of $13=${reportUnits} ${kind} reports`,()=>{
    const f=gatedJogFixture();
    f.broadcast({modal:{units:code}});
    f.session.settings.settings.$13=reportUnits;
    const decimals=reportUnits==='1'?4:3;
    // GRBL reports every coordinate at the configured precision. Integer zero
    // words would conservatively make this entire frame one report-unit coarse.
    const report=mm=>f.socket.receive('serialport:read',`<Idle|${kind}:${[mm/(reportUnits==='1'?25.4:1),0,0].map(value=>value.toFixed(decimals)).join(',')}|FS:0,0>`);
    report(25.4);
    assertNear(f.grbl.position('X').resolution,reportUnits==='1'?0.00254:0.001);
    assert.equal(f.grbl.jog('X',25.4,254),'sent');
    assert.equal(jogCommands(f).at(-1)[1],code==='G20'?'$J=G20 G91 X1.000000 F10.000000':'$J=G21 G91 X25.4000 F254.000');
    assert.equal(f.grbl.jogTarget.kind,kind);
    assertNear(f.grbl.jogTarget.value,50.8);
    report(50.8);
    assert.equal(f.grbl.jogPhase,'idle');
    assert.equal(f.session.settings.settings.$13,reportUnits);
    f.grbl.clearJog();
  });
}

for(const code of ['G20','G21']) for(const kind of ['MPos','WPos']) {
  test(`${code} coarse inch ${kind} reports retain the two post-ACK Idle guard`,()=>{
    const f=gatedJogFixture();
    f.broadcast({modal:{units:code}});
    f.session.settings.settings.$13='1';
    const report=inches=>f.socket.receive('serialport:read',`<Idle|${kind}:${inches.toFixed(4)},0,0|FS:0,0>`);
    report(1);
    assertNear(f.grbl.position('X').resolution,25.4);
    assert.equal(f.grbl.jog('X',25.4,254),'sent');
    assert.equal(f.grbl.jogReceipt.state,'acknowledged');
    report(2);
    assert.equal(f.grbl.jogPhase,'active','one coarse endpoint cannot bypass the raw Idle guard');
    report(2);
    assert.equal(f.grbl.jogPhase,'idle','two fresh post-ACK Idle reports confirm the ambiguous move');
    assert.equal(f.jobs.size,0);
    assert.equal(f.queries(),0);
  });
}

test('G20 lowlevel 5 mm uses the rounded wire distance for its physical target and completes near 5 mm',()=>{
  const f=gatedJogFixture();
  f.broadcast({modal:{units:'G20'}});
  assert.equal(f.grbl.jog('X',5,254),'sent');
  assert.equal(jogCommands(f).at(-1)[1],'$J=G20 G91 X0.196850 F10.000000');
  assertNear(f.grbl.jogTarget.value,4.99999);
  f.machine.x=5; f.broadcast();
  assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.queries(),0);
});

for(const code of ['G20','G21']) test(`${code} target follows actual wire rounding rather than requested distance`,()=>{
  const f=gatedJogFixture();
  f.broadcast({modal:{units:code}});
  assert.equal(f.grbl.jog('Z',-1.23456789,100),'sent');
  const wire=Number(jogCommands(f).at(-1)[1].match(/ Z(-?[\d.]+)/)[1]);
  assertNear(f.grbl.jogTarget.value,wire*(code==='G20'?25.4:1));
  assert.notEqual(f.grbl.jogTarget.value,-1.23456789);
  f.grbl.clearJog();
});

for(const units of [undefined,null,'','G22','g20',20,21]) test(`unknown modal ${String(units)} refuses motion and recovers only after explicit known units`,()=>{
  const f=gatedJogFixture();
  f.broadcast({modal:{units}});
  assert.equal(f.grbl.jogUnits,null);
  assert.equal(f.grbl.jog('X',5,254),'dropped');
  assert.equal(f.grbl.jogPulse('X',5,254),'dropped');
  assert.equal(jogCommands(f).length,0);
  assert.equal(f.grbl.jogTarget,null);
  f.broadcast({modal:{units:'G21'}});
  assert.equal(f.grbl.jogUnits.code,'G21');
  assert.equal(f.grbl.jogUnits.scale,1);
  assert.equal(f.grbl.jogUnits.label,'mm');
  assert.equal(f.grbl.jog('X',5,254),'sent');
  f.grbl.clearJog();
});

for(const [code,scale,digits] of [['G20',25.4,6],['G21',1,3]]) for(const axis of ['X','Y','Z']) {
  test(`${code} ${axis} feed conversion floors without exceeding its physical axis maximum`,()=>{
    const f=gatedJogFixture();
    f.broadcast({modal:{units:code}});
    const max=12.3456789;
    f.session.settings.settings[`$${110+['X','Y','Z'].indexOf(axis)}`]=String(max);
    assert.equal(f.grbl.jog(axis,1,1000),'sent');
    const wireFeed=Number(jogCommands(f).at(-1)[1].match(/ F([\d.]+)/)[1]);
    assert.ok(wireFeed>0);
    assert.ok(wireFeed*scale<=max);
    assert.ok(max-wireFeed*scale<=scale/10**digits+1e-12,'Feed flooring loses at most one wire precision quantum');
    f.grbl.clearJog();
  });
  test(`${code} ${axis} refuses a positive feed that floors to zero`,()=>{
    const f=gatedJogFixture();
    f.broadcast({modal:{units:code}});
    assert.equal(f.grbl.jog(axis,1,scale*10**(-digits)/4),'dropped');
    assert.equal(jogCommands(f).length,0);
    assert.equal(f.grbl.jogTarget,null);
  });
}

for(const [before,after] of [['G20','G21'],['G21','G20']]) test(`pending ACK preserves physical backlog across ${before} to ${after}`,()=>{
  const f=gatedJogFixture('delayed');
  f.broadcast({modal:{units:before}});
  assert.equal(f.grbl.jog('X',25.4,254),'sent');
  assert.equal(f.grbl.jog('X',12.7,254),'buffered');
  assertNear(f.grbl.jogBacklog.distance,12.7);
  f.broadcast({modal:{units:after}});
  f.tick(50);
  assert.equal(jogCommands(f).length,1,'Known unit changes cannot bypass pending ACK');
  assertNear(f.grbl.jogBacklog.distance,12.7);
  acknowledgeJog(f,jogCommands(f)[0]); f.tick(50);
  assert.equal(jogCommands(f).at(-1)[1],after==='G20'?'$J=G20 G91 X0.500000 F10.000000':'$J=G21 G91 X12.7000 F254.000');
  assertNear(f.grbl.jogTarget.value,38.1);
  assert.equal(f.grbl.jogBacklog,null);
  acknowledgeJog(f);
  f.machine.x=38.1; f.broadcast();
  assert.equal(f.grbl.jogPhase,'idle');
  f.grbl.clearJog();
});

for(const code of ['G20','G21']) test(`${code} backlog remains frozen in physical millimetres while modal units are unknown`,()=>{
  const f=gatedJogFixture('delayed');
  f.broadcast({modal:{units:code}});
  f.grbl.jog('X',25.4,254);
  assert.equal(f.grbl.jog('X',12.7,254),'buffered');
  f.broadcast({modal:{}});
  acknowledgeJog(f,jogCommands(f)[0]);
  f.tick(50);
  const notices=f.logs.length;
  assert.ok(notices>0,'Unknown-unit backlog refusal must explain why motion is frozen');
  for(let n=0;n<4;n++) f.tick(50);
  assert.equal(f.logs.length,notices,'Retrying frozen backlog must not repeat the refusal');
  assert.equal(jogCommands(f).length,1);
  assertNear(f.grbl.jogBacklog.distance,12.7);
  assertNear(f.grbl.jogBacklog.feed,254);
  assert.equal(f.grbl.jog('X',2,100),'dropped','Unknown-unit input must not enter the frozen backlog');
  assertNear(f.grbl.jogBacklog.distance,12.7);
  const restored=code==='G20'?'G21':'G20';
  f.broadcast({modal:{units:restored}});
  f.tick(50);
  assert.equal(jogCommands(f).length,2);
  assert.equal(jogCommands(f).at(-1)[1],restored==='G20'?'$J=G20 G91 X0.500000 F10.000000':'$J=G21 G91 X12.7000 F254.000');
  assertNear(f.grbl.jogTarget.value,38.1);
  assert.equal(f.grbl.jogBacklog,null);
  f.grbl.clearJog();
});

test('Continuous lowlevel pulses keep physical distance and speed while current wire units change',()=>{
  const f=gatedJogFixture();
  f.broadcast({modal:{units:'G20'}});
  assert.equal(f.grbl.jogPulse('Y',12.7,254),'sent');
  assert.equal(jogCommands(f).at(-1)[1],'$J=G20 G91 Y0.500000 F10.000000');
  assertNear(f.grbl.jogTarget.value,12.7);
  assert.equal(f.grbl.jogPulse('Y',12.7,254),'pending');
  f.machine.y=12.7; f.broadcast();
  assert.equal(f.grbl.jogPhase,'idle');
  f.broadcast({modal:{units:'G21'}});
  assert.equal(f.grbl.jogPulse('Y',12.7,254),'sent');
  assert.equal(jogCommands(f).at(-1)[1],'$J=G21 G91 Y12.7000 F254.000');
  assertNear(f.grbl.jogTarget.value,25.4);
  f.machine.y=25.4; f.broadcast();
  assert.equal(f.grbl.jogPhase,'idle');
});

for(const code of ['G20','G21']) test(`inline modal mutation after ${code} emission preserves the sent unit snapshot and baselines`,()=>{
  const f=gatedJogFixture('delayed');
  f.broadcast({modal:{units:code}});
  const generation=f.session.generation, epoch=f.session.motionEpoch, workflowEpoch=f.session.workflowEpoch;
  const errorSequence=f.session.errorSequence, positionSequence=f.session.positionReport.sequence, sequence=f.session.reportSequence;
  const send=f.session.jog.bind(f.session);
  f.session.jog=wire=>{
    const receipt=send(wire);
    f.session.state.parserstate.modal.units=code==='G20'?'G21':'G20';
    return receipt;
  };
  assert.equal(f.grbl.jog('X',5,254),'sent');
  assert.equal(jogCommands(f).at(-1)[1],code==='G20'?'$J=G20 G91 X0.196850 F10.000000':'$J=G21 G91 X5.0000 F254.000');
  assertNear(f.grbl.jogTarget.value,code==='G20'?4.99999:5);
  assert.equal(f.grbl.jogGeneration,generation);
  assert.equal(f.grbl.jogEpoch,epoch);
  assert.equal(f.grbl.jogWorkflowEpoch,workflowEpoch);
  assert.equal(f.grbl.jogErrorSequence,errorSequence);
  assert.equal(f.grbl.jogPositionSequence,positionSequence);
  assert.equal(f.grbl.jogSequence,sequence);
  f.grbl.clearJog();
});

for(const travel of ['tiny','out-and-back','clipped','cancel']) test(`G20 ${travel} cannot bypass post-ACK raw Idle guards`,()=>{
  const f=gatedJogFixture('delayed');
  f.broadcast({modal:{units:'G20'}});
  f.session.settings.settings.$100='200';
  const tiny=travel==='tiny';
  assert.equal(f.grbl.jog('X',tiny?0.001:1,254),'sent');
  acknowledgeJog(f);
  if(travel==='out-and-back') {
    assert.equal(f.grbl.jog('X',-1,254),'sent');
    acknowledgeJog(f);
  }
  if(travel==='cancel') {
    f.machine.state='Jog'; f.broadcast();
    f.grbl.cancelJog();
    f.machine.state='Idle'; f.machine.x=0.25; f.broadcast();
  }
  if(travel==='clipped') {
    f.machine.state='Jog'; f.machine.x=0.25; f.broadcast();
    f.machine.state='Idle'; f.broadcast();
  }
  // Parser-only and unchanged native reports are not raw completion evidence.
  f.broadcast({modal:{units:'G21'}});
  f.broadcast({modal:{units:'G20'}});
  assert.equal(f.queries(),0);
  const needed=travel==='clipped'?5:2;
  for(let n=0;n<needed;n++) {
    f.tick(n===0?750:250);
    assert.equal(f.queries(),n+1);
    assert.equal(f.grbl.jogPhase,n===needed-1?'idle':travel==='cancel'?'canceling':'active');
  }
  if(travel==='clipped') assert.match(f.logs.at(-1),/ended short of its target/);
  assert.equal(f.jobs.size,0);
  assert.equal(f.motionListeners.size,0);
  f.grbl.clearJog();
});

test('a G20 distance at six-decimal inch resolution is not rejected by the old millimetre threshold',()=>{
  const f=gatedJogFixture();
  f.broadcast({modal:{units:'G20'}});
  assert.equal(f.grbl.jog('X',0.0000254,254),'sent');
  assert.equal(jogCommands(f).at(-1)[1],'$J=G20 G91 X0.000001 F10.000000');
  assertNear(f.grbl.jogTarget.value,0.0000254);
  f.grbl.clearJog();
});

test('canceling an unknown-unit frozen backlog discards it and cannot revive motion on recovery',()=>{
  const f=gatedJogFixture('delayed');
  f.broadcast({modal:{units:'G20'}});
  f.grbl.jog('X',25.4,254); f.grbl.jog('X',12.7,254);
  acknowledgeJog(f,jogCommands(f)[0]);
  f.broadcast({modal:{}});
  f.tick(50);
  assertNear(f.grbl.jogBacklog.distance,12.7);
  const retry=f.grbl.backlogTimer;
  f.grbl.cancelJog();
  assert.equal(f.grbl.jogBacklog,null);
  f.broadcast({modal:{units:'G21'}});
  retry();
  f.advance(1500);
  assert.equal(jogCommands(f).length,1);
  assert.equal(f.grbl.jogPhase,'idle');
  f.grbl.clearJog();
});

for(const [event,interrupt] of [
  ['reset',f=>f.socket.receive('serialport:read','Grbl 1.1h')],
  ['disconnect',f=>f.session.disconnect()],
  ['program',f=>f.socket.receive('workflow:state','running')],
]) test(`inline ${event} after G20 serialization still invalidates all ownership`,()=>{
  const f=gatedJogFixture('delayed');
  f.broadcast({modal:{units:'G20'}});
  const send=f.session.jog.bind(f.session);
  f.session.jog=wire=>{
    const receipt=send(wire);
    f.session.state.parserstate.modal.units='G21';
    interrupt(f);
    return receipt;
  };
  assert.equal(f.grbl.jog('X',5,254),'dropped');
  assert.equal(jogCommands(f).at(-1)[1],'$J=G20 G91 X0.196850 F10.000000');
  assert.equal(f.grbl.jogTarget,null);
  assert.equal(f.grbl.jogReceipt,null);
  assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.jobs.size,0);
  assert.equal(f.motionListeners.size,0);
});

test('inline G20 rejection plus unit mutation uses the pre-send error baseline and cancels normally',()=>{
  const f=gatedJogFixture('delayed');
  f.broadcast({modal:{units:'G20'}});
  const send=f.session.jog.bind(f.session), prior=f.session.errorSequence;
  f.session.jog=wire=>{
    const receipt=send(wire);
    f.session.state.parserstate.modal.units='G21';
    const [,code,context]=jogCommands(f).at(-1);
    f.socket.receive('serialport:write',`${code}\n`,{...context,source:'feeder'});
    f.socket.receive('serialport:read','error:15 (Travel exceeded)');
    return receipt;
  };
  f.grbl.jog('X',5,254);
  assert.ok(f.session.errorSequence>prior);
  assert.equal(f.grbl.jogPhase,'canceling');
  assert.equal(stopCommands(f).filter(([name])=>name==='jogCancel').length,1);
  assert.equal(f.logs.filter(line=>/error:15.*canceling queued jogs/.test(line)).length,1);
  assert.equal(f.motionListeners.size,1);
  f.tick(750); assert.equal(f.grbl.jogPhase,'canceling');
  f.tick(250); assert.equal(f.grbl.jogPhase,'idle');
  assert.equal(f.motionListeners.size,0);
});

for(const residue of [0,0.00001]) test(`known-unit opposing detents with ${residue} mm residue leave no retry or phantom movement`,()=>{
  const f=gatedJogFixture('delayed');
  assert.equal(f.grbl.jog('X',1,254),'sent');
  assert.equal(f.grbl.jog('X',0.1,254),'buffered');
  assert.equal(f.grbl.jog('X',0.2,254),'buffered');
  assert.equal(f.grbl.jog('X',-0.3+residue,254),'buffered');
  assertNear(f.grbl.jogBacklog.distance,residue);
  acknowledgeJog(f,jogCommands(f)[0]);
  const notices=f.logs.length;
  f.tick(50);
  assert.equal(f.grbl.jogBacklog,null);
  assert.equal(f.grbl.backlogTimer,null);
  assert.equal(jogCommands(f).length,1,'Neither exact cancellation nor a zero wire word sends a jog');
  if(residue) assert.ok(f.logs.length>notices,'A nonzero unrepresentable residue must explain its rejection');
  else assert.equal(f.logs.length,notices,'Floating-point cancellation is not a rejected movement');
  f.machine.x=1; f.broadcast();
  f.advance(5000);
  assert.equal(f.grbl.backlogTimer,null);
  assert.equal(f.jobs.size,0);
  assert.equal(jogCommands(f).length,1);
  f.broadcast({modal:{units:'G20'}});
  f.advance(5000);
  assert.equal(jogCommands(f).length,1,'A later finer-resolution mode cannot revive discarded residue');
  f.grbl.clearJog();
});

test('G20 backlog feed that becomes zero in G21 is rejected once without a retry loop',()=>{
  const f=gatedJogFixture('delayed');
  f.broadcast({modal:{units:'G20'}});
  assert.equal(f.grbl.jog('X',25.4,254),'sent');
  assert.equal(f.grbl.jog('X',12.7,0.0001),'buffered');
  assertNear(f.grbl.jogBacklog.feed,0.0001);
  f.broadcast({modal:{units:'G21'}});
  acknowledgeJog(f,jogCommands(f)[0]);
  const notices=f.logs.length;
  f.tick(50);
  assert.equal(f.grbl.jogBacklog,null);
  assert.equal(f.grbl.backlogTimer,null);
  assert.equal(jogCommands(f).length,1);
  assert.ok(f.logs.length>notices,'A known-unit zero feed must explain its rejection');
  const rejectedNotices=f.logs.length;
  f.machine.x=25.4; f.broadcast();
  f.advance(5000);
  assert.equal(f.jobs.size,0);
  assert.equal(f.logs.length,rejectedNotices,'A rejected feed cannot keep retrying');
  f.broadcast({modal:{units:'G20'}});
  f.advance(5000);
  assert.equal(jogCommands(f).length,1,'Returning to representable units cannot revive rejected input');
  f.grbl.clearJog();
});
