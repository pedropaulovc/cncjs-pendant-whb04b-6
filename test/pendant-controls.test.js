import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Grbl } from '../web/widget/grbl.js';
import { PendantControls, parseConfig } from '../web/widget/pendant-controls.js';
import { RightDial } from '../web/whb04b-webhid.js';

function clock() {
  let time = 0;
  const timers = new Map();
  return { now: () => time, schedule: (fn, ms) => { timers.set(fn, time + ms); return fn; }, cancel: fn => timers.delete(fn),
    advance(ms) { time += ms; for (const [fn, due] of [...timers]) { if (due <= time) { timers.delete(fn); fn(); } } }, timers };
}
function fixture() {
  const commands = [], logs = [], timer = clock();
  const session = { status: { phase: 'joined' }, stopPhase: 'idle', workflowState: 'idle', activeState: 'Idle', generation: 1,
    positionReport: { kind: 'MPos', values: [0,0,0], sequence: 1, units: '0', resolution: 0.001 },
    reportSequence: 1, idleReports: 2, overrideSequence: 1, overrides: [100, 100, 100],
    state: { parserstate: { spindle: '500', modal: { spindle: 'M5', coolant: 'M9' } } },
    settings: { settings: { $110: '3000', $111: '3000', $112: '1000', $30: '1000', $31: '0' } },
    command: (...args) => { commands.push(args); return 'sent'; }, stop: () => commands.push(['stop']) };
  const grbl = new Grbl(session, () => 20, message => logs.push(message), timer);
  const controls = new PendantControls(grbl, { ...timer, log: message => logs.push(message) });
  let current = { firstKeyCode: 0, secondKeyCode: 0, leftDialCode: 0x11, rightDialCode: 0x0f, jog: 0 };
  const input = report => { current = { ...current, firstKeyCode: 0, secondKeyCode: 0, jog: 0, ...report }; controls.handleInput(current); };
  const press = (code, modifier = 0) => { input({ firstKeyCode: modifier || code, secondKeyCode: modifier ? code : 0 }); input({}); };
  const ack = (feed, spindle) => { session.overrides = [feed, 100, spindle]; session.overrideSequence++; timer.advance(250); };
  return { session, grbl, controls, commands, logs, timer, input, press, ack };
}

test('both Lead hardware codes adjust spindle and never jog; startup MPG adjusts feed', () => {
  for (const rightDialCode of [0x1c, 0x9b]) {
    const f = fixture(); f.input({ rightDialCode, jog: 3 });
    assert.equal(RightDial[rightDialCode], 'Lead');
    assert.equal(f.controls.mode, 'lead');
    assert.deepEqual(f.commands[0], ['spindleOverride', 1]);
    f.ack(100, 101); f.ack(100, 102); f.ack(100, 103);
    assert.deepEqual(f.commands.filter(([c]) => c === 'spindleOverride'), [['spindleOverride', 1], ['spindleOverride', 1], ['spindleOverride', 1]]);
    assert.equal(f.commands.some(([c]) => c === 'gcode'), false);
  }
  const f = fixture(); f.input({ jog: -1 });
  assert.equal(f.controls.mode, 'mpg'); assert.deepEqual(f.commands[0], ['feedOverride', -1]);
});

test('overrides wait for acknowledged Ov changes instead of flooding duplicate realtime bytes', () => {
  const f = fixture(); f.grbl.override('feed', 23);
  assert.deepEqual(f.commands.filter(([c]) => c === 'feedOverride'), [['feedOverride', 10]]);
  f.timer.advance(250); f.timer.advance(250);
  assert.equal(f.commands.filter(([c]) => c === 'feedOverride').length, 1);
  f.ack(110, 100); f.ack(120, 100); f.ack(121, 100); f.ack(122, 100); f.ack(123, 100);
  assert.deepEqual(f.commands.filter(([c]) => c === 'feedOverride').map(([,n]) => n), [10,10,1,1,1]);
  assert.equal(f.timer.timers.size, 0);
});

test('override targets clamp, expire without feedback, and cannot cross reconnections', () => {
  const f = fixture(); f.session.overrides[0] = 199; f.grbl.override('feed', 20);
  assert.deepEqual(f.commands[0], ['feedOverride', 1]);
  f.timer.advance(3000); assert.equal(f.grbl.pendingOverrides.size, 0);
  assert.match(f.logs.at(-1), /discarded/);
  f.grbl.override('spindle', 3); const sent = f.commands.length;
  f.session.generation++; f.timer.advance(250);
  assert.equal(f.commands.length, sent); assert.equal(f.grbl.pendingOverrides.size, 0);
});

test('first selector report sends no override; real changes set percentages and Lead exit restores MPG', () => {
  const f = fixture(); f.input({ rightDialCode: 0x0d }); assert.deepEqual(f.commands, []);
  f.input({ rightDialCode: 0x0e }); assert.equal(f.grbl.pendingOverrides.get('feed').target, 10);
  assert.match(f.logs.at(-1), /minimum is 10/);
  f.input({ rightDialCode: 0x9b }); f.input({ rightDialCode: 0x1b });
  assert.equal(f.controls.mode, 'mpg'); assert.equal(f.grbl.pendingOverrides.get('feed').target, 100);
});

test('Step counts exact millimetres; large steps opt in; unknown selectors and ABC never move', () => {
  const f = fixture(); f.press(0x0f); f.input({ rightDialCode: 0x0e, jog: 4 });
  assert.deepEqual(f.commands.at(-1), ['gcode', '$J=G21 G91 X0.0400 F250.000']);
  f.session.reportSequence+=2; f.session.activeState='Idle'; f.session.positionReport={...f.session.positionReport,values:[0.04,0,0],sequence:f.session.reportSequence};
  f.input({ rightDialCode: 0x1b, jog: 1 });
  assert.equal(f.commands.filter(([c]) => c === 'gcode').length, 1);
  f.controls.setConfig({ largeSteps: 'enabled' }); f.session.reportSequence+=2;
  f.input({ jog: 1 }); assert.match(f.commands.at(-1)[1], /X10.0000/);
  for (const report of [{ leftDialCode: 0x14 }, { leftDialCode: 0x15 }, { leftDialCode: 0x16 }, { leftDialCode: 0x06 }, { leftDialCode: 0x11, rightDialCode: 0xff }]) f.input({ ...report, jog: 1 });
  assert.equal(f.commands.filter(([c]) => c === 'gcode').length, 2);
});

test('Continuous uses axis max-rate percentage, bounds pulses, cancels after silence, and waits for fresh Idle', () => {
  const f = fixture(); f.input({ rightDialCode: 0x0d }); f.press(0x0e); f.input({ jog: 1 });
  assert.deepEqual(f.commands.at(-1), ['gcode', '$J=G21 G91 X0.2000 F60.000']);
  f.timer.advance(100); f.input({ jog: 5 });
  assert.equal(f.commands.filter(([c]) => c === 'gcode').length, 1);
  f.timer.advance(180);
  assert.deepEqual(f.commands.slice(-3).map(([c]) => c), ['feeder:stop', 'jogCancel', 'statusreport']);
  f.input({ jog: 1 }); assert.equal(f.commands.filter(([c]) => c === 'gcode').length, 1);
  f.session.reportSequence+=2; f.input({ jog: 1 });
  assert.equal(f.commands.filter(([c]) => c === 'gcode').length, 2);
});

test('Continuous cancels on axis/mode/direction changes and suspend; no movement without known max-rate', () => {
  for (const change of [{ leftDialCode: 0x12, jog: 1 }, { firstKeyCode: 0x0f }, { jog: -1 }]) {
    const f=fixture(); f.press(0x0e); f.input({jog:1}); f.session.activeState='Jog'; f.input(change);
    assert.ok(f.commands.some(([c])=>c==='jogCancel'));
    assert.equal(f.commands.filter(([c])=>c==='gcode').length,1);
  }
  const f=fixture(); f.session.settings={}; f.press(0x0e); f.input({jog:1});
  assert.equal(f.commands.length,0); assert.match(f.logs.at(-1),/waiting/);
});

test('button actions fire on physical press only, with Fn in either key byte', () => {
  const f=fixture(); f.input({firstKeyCode:4}); f.input({firstKeyCode:4}); f.input({firstKeyCode:4,jog:1});
  assert.equal(f.grbl.pendingOverrides.get('feed').target,101);
  f.controls.setConfig({macros:{1:'G0 X0'}}); f.input({});
  f.input({firstKeyCode:0x0c,secondKeyCode:4});
  f.input({firstKeyCode:4,secondKeyCode:0x0c});
  f.input({firstKeyCode:4});
  assert.deepEqual(f.commands.filter(([c])=>c==='gcode'),[['gcode',['G0 X0']]]);
  f.input({}); f.input({firstKeyCode:4,secondKeyCode:0x0c});
  assert.equal(f.commands.filter(([c])=>c==='gcode').length,2);
});

test('Fn uses macros, spindle RPM/direction, coolant, and Macro10 toggles coordinates', () => {
  const f=fixture(); f.press(6,0x0c); assert.deepEqual(f.commands.at(-1),['gcode','S600']);
  f.press(7,0x0c); assert.deepEqual(f.commands.at(-1),['gcode','S400']);
  f.press(11,0x0c); f.press(11); assert.deepEqual(f.commands.at(-1),['gcode','M4']);
  f.press(14,0x0c); assert.deepEqual(f.commands.at(-1),['gcode','M8']);
  f.press(15,0x0c); assert.deepEqual(f.commands.at(-1),['gcode','M7']);
  f.press(16); assert.equal(f.controls.coordinates,'machine');
  f.press(16); assert.equal(f.controls.coordinates,'work');
  f.press(9,0x0c); assert.match(f.logs.at(-1),/Macro 6 is not configured/);
});

test('Start/Pause uses CNCjs sender start/pause/resume; Stop still cancels', () => {
  const f=fixture(); f.press(3); assert.deepEqual(f.commands.at(-1),['gcode:start',undefined]);
  f.session.workflowState='running'; f.press(3); assert.deepEqual(f.commands.at(-1),['gcode:pause',undefined]);
  f.session.workflowState='paused'; f.press(3); assert.deepEqual(f.commands.at(-1),['gcode:resume',undefined]);
  f.press(2); assert.deepEqual(f.commands.at(-1),['stop']);
});

test('manual controls refuse a running program and unknown spindle state; cooldown restores other channel', () => {
  const f=fixture(); f.session.workflowState='running';
  f.grbl.jog('X',1,100); f.grbl.spindleToggle(); f.grbl.spindleSpeed(1); f.grbl.coolantToggle('flood'); f.grbl.macro('G0 X0');
  assert.deepEqual(f.commands,[]);
  f.session.workflowState='idle'; f.session.state.parserstate.modal.spindle='M3'; f.grbl.spindleDirection(); assert.deepEqual(f.commands,[]);
  f.grbl.spindleToggle(); assert.deepEqual(f.commands.at(-1),['gcode','M5']);
  f.session.state.parserstate.modal.coolant=['M7','M8']; f.grbl.coolantToggle('flood'); assert.deepEqual(f.commands.at(-1),['gcode',['M9','M7']]);
});

test('invalid configuration fails without accepting arbitrary macro keys', () => {
  for (const value of [{largeSteps:true},{stepFeed:0},{spindleIncrement:NaN},{macros:[]},{macros:{3:'M3'}},{macros:{1:()=>{}}}]) assert.throws(()=>parseConfig(value));
});

test('completed Step releases jog ownership so changing mode does not discard the next wheel input', () => {
  const f=fixture(); f.press(0x0f); f.input({jog:1});
  f.session.reportSequence++; f.session.idleReports=1; f.session.activeState='Idle'; f.session.positionReport={...f.session.positionReport,values:[0.1,0,0],sequence:f.session.reportSequence};
  f.press(0x0e); f.input({jog:1});
  assert.equal(f.commands.filter(([c])=>c==='gcode').length,2);
  assert.equal(f.commands.some(([c])=>c==='jogCancel'),false);
});

test('Continuous never queues behind a slow segment and never starts motion from a timer', () => {
  const f=fixture(); f.press(0x0e); f.input({jog:1}); f.session.activeState='Jog';
  for(let i=0;i<20;i++) { f.timer.advance(50); f.input({jog:5}); }
  assert.equal(f.commands.filter(([c])=>c==='gcode').length,1);
  assert.ok(f.commands.filter(([c])=>c==='statusreport').length>=5);
  f.session.activeState='Idle'; f.session.idleReports=2; f.session.reportSequence+=2; f.session.positionReport={...f.session.positionReport,values:[1,0,0],sequence:f.session.reportSequence};
  f.timer.advance(100);
  assert.equal(f.commands.filter(([c])=>c==='gcode').length,1);
  f.input({jog:1});
  assert.equal(f.commands.filter(([c])=>c==='gcode').length,2);
  f.timer.advance(180); assert.equal(f.timer.timers.size,0);
});

test('invalid probe thickness refuses motion while an explicit zero remains valid', () => {
  const f=fixture(); f.grbl.getProbeThickness=()=>NaN;
  assert.equal(f.grbl.probeZ(),'dropped'); assert.deepEqual(f.commands,[]);
  assert.match(f.logs.at(-1),/valid nonnegative probe plate thickness/);
  f.grbl.getProbeThickness=()=>0; f.grbl.probeZ();
  assert.equal(f.commands[0][1][2],'G10 L20 P1 Z0.001');
});

test('two in-flight Idle reports at the old position cannot admit another Continuous segment', () => {
  const f=fixture(); f.input({rightDialCode:0x0d}); f.press(0x0e); f.input({jog:1});
  f.timer.advance(100); f.input({jog:1});
  f.session.reportSequence+=2; f.session.positionReport.sequence=f.session.reportSequence;
  f.timer.advance(100); f.input({jog:1});
  assert.equal(f.commands.filter(([c])=>c==='gcode').length,1);
  f.session.reportSequence++; f.session.positionReport={...f.session.positionReport,values:[0.2,0,0],sequence:f.session.reportSequence};
  f.input({jog:1}); assert.equal(f.commands.filter(([c])=>c==='gcode').length,2);
});

test('Continuous endpoint confirmation converts $13 inch reports to mm and supports WPos', () => {
  const f=fixture(); f.session.positionReport={kind:'WPos',values:[1,2,3],sequence:1,units:'1',resolution:0.0001};
  assert.equal(f.grbl.jogPulse('X',2.54,100),'sent');
  f.session.reportSequence=2; f.session.positionReport={...f.session.positionReport,values:[1.1,2,3],sequence:2};
  assert.equal(f.grbl.jogCompleted(),true);
  assert.equal(f.grbl.jogPulse('X',2.54,100),'sent');
  f.session.reportSequence=3; f.session.positionReport={...f.session.positionReport,values:[1.2,2,3],sequence:3,units:'0'};
  assert.equal(f.grbl.jogCompleted(),false);
});

test('endpoint confirmation tolerates GRBL step rounding but rejects a stale starting position', () => {
  const f=fixture(); f.session.settings.settings.$100='200';
  f.grbl.jogPulse('X',0.012,4);
  f.session.reportSequence=3; f.session.positionReport.sequence=3;
  assert.equal(f.grbl.jogCompleted(),false);
  f.session.positionReport.values=[0.01,0,0];
  assert.equal(f.grbl.jogCompleted(),true);
});
