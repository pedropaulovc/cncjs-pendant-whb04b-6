import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Grbl } from '../web/widget/grbl.js';
import { PendantControls, SELECTORS, parseConfig } from '../web/widget/pendant-controls.js';
import { RightDial } from '../web/whb04b-webhid.js';

function clock() {
  let time = 0;
  const timers = new Map();
  return { now: () => time, schedule: (fn, ms) => { timers.set(fn, time + ms); return fn; }, cancel: fn => timers.delete(fn),
    advance(ms) { time += ms; for (const [fn, due] of [...timers]) { if (due <= time) { timers.delete(fn); fn(); } } }, timers };
}
function fixture() {
  const commands = [], logs = [], timer = clock(), listeners = new Set();
  const session = { status: { phase: 'joined' }, stopPhase: 'idle', workflowState: 'idle', activeState: 'Idle', generation: 1,
    subscribeMotion(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    positionReport: { kind: 'MPos', values: [0,0,0], sequence: 1, units: '0', resolution: 0.001 },
    reportSequence: 1, idleReports: 2, overrideSequence: 1, overrides: [100, 100, 100],
    state: { parserstate: { spindle: '500', modal: { units: 'G21', spindle: 'M5', coolant: 'M9' } } },
    settings: { settings: { $110: '3000', $111: '3000', $112: '1000', $30: '1000', $31: '0' } },
    command: (...args) => { commands.push(args); return 'sent'; }, stop: () => commands.push(['stop']) };
  Object.defineProperty(session, 'positionReports', { get: () => ({ [session.positionReport.kind]: session.positionReport }) });
  session.jog = code => {
    session.command('gcode', code);
    return { state: 'acknowledged', transmission: 'written', reportSequence: session.reportSequence };
  };
  const grbl = new Grbl(session, message => logs.push(message), timer);
  const controls = new PendantControls(grbl, { ...timer, log: message => logs.push(message) });
  let current = { firstKeyCode: 0, secondKeyCode: 0, leftDialCode: 0x11, rightDialCode: 0x0f, jog: 0 };
  const input = report => { current = { ...current, firstKeyCode: 0, secondKeyCode: 0, jog: 0, ...report }; controls.handleInput(current); };
  const press = (code, modifier = 0) => { input({ firstKeyCode: modifier || code, secondKeyCode: modifier ? code : 0 }); input({}); };
  const ack = (feed, spindle) => { session.overrides = [feed, 100, spindle]; session.overrideSequence++; timer.advance(250); };
  return { session, grbl, controls, commands, logs, timer, input, press, ack,
    notify: (progress = false) => { for (const listener of [...listeners]) listener(progress); } };
}

test('startup Step is idle until input and the first detent jogs the selected distance', () => {
  const f = fixture();
  assert.equal(f.controls.mode, 'step');
  assert.deepEqual(f.commands, []);
  assert.equal(f.grbl.pendingOverrides.size, 0);
  f.timer.advance(3000);
  assert.deepEqual(f.commands, []);
  f.input({ rightDialCode: 0x0e, jog: -1 });
  assert.equal(f.controls.mode, 'step');
  assert.deepEqual(f.commands, [['gcode', '$J=G21 G91 X-0.0100 F3000.000']]);
  assert.equal(f.grbl.pendingOverrides.size, 0);
});

test('a fresh normal selector report preserves Step without sending commands or overrides', () => {
  const f = fixture();
  f.input({ rightDialCode: 0x0d });
  assert.equal(f.controls.mode, 'step');
  assert.deepEqual(f.commands, []);
  assert.equal(f.grbl.pendingOverrides.size, 0);
  f.input({ rightDialCode: 0x0e });
  assert.equal(f.controls.mode, 'step');
  assert.deepEqual(f.commands, []);
  assert.equal(f.grbl.pendingOverrides.size, 0);
});

test('both initial Lead hardware codes adjust spindle and leaving Lead enables MPG feed adjustment', () => {
  for (const rightDialCode of [0x1c, 0x9b]) {
    const f = fixture(); f.input({ rightDialCode, jog: 3 });
    assert.equal(RightDial[rightDialCode], 'Lead');
    assert.equal(f.controls.mode, 'lead');
    assert.deepEqual(f.commands[0], ['spindleOverride', 1]);
    f.ack(100, 101); f.ack(100, 102); f.ack(100, 103);
    assert.deepEqual(f.commands.filter(([c]) => c === 'spindleOverride'), [['spindleOverride', 1], ['spindleOverride', 1], ['spindleOverride', 1]]);
    assert.equal(f.commands.some(([c]) => c === 'gcode'), false);
    f.input({ rightDialCode: 0x1b });
    assert.equal(f.controls.mode, 'mpg');
    f.input({ jog: -1 });
    assert.deepEqual(f.commands.filter(([c]) => c === 'feedOverride'), [['feedOverride', -1]]);
    assert.equal(f.commands.some(([c]) => c === 'gcode'), false);
  }
});

test('explicit modes survive a normal report and pendant reconnect', () => {
  for (const [key, mode] of [[0x0e, 'continuous'], [0x0f, 'step']]) {
    const f = fixture();
    f.press(key);
    assert.equal(f.controls.mode, mode);
    f.controls.suspend(); f.grbl.clearOverrides(); f.controls.keys.clear();
    f.input({});
    assert.equal(f.controls.mode, mode);
    assert.deepEqual(f.commands, []);
  }
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

test('selector changes in MPG set feed percentages and clamp to the minimum', () => {
  const f = fixture(); f.input({ rightDialCode: 0x9b }); assert.deepEqual(f.commands, []);
  f.input({ rightDialCode: 0x0e });
  assert.equal(f.controls.mode, 'mpg'); assert.equal(f.grbl.pendingOverrides.get('feed').target, 10);
  assert.match(f.logs.at(-1), /minimum is 10/);
  f.input({ rightDialCode: 0x1b });
  assert.equal(f.controls.mode, 'mpg'); assert.equal(f.grbl.pendingOverrides.get('feed').target, 100);
});

test('Step counts exact millimetres; large steps opt in; unknown selectors and ABC never move', () => {
  const f = fixture(); f.press(0x0f); f.input({ rightDialCode: 0x0e, jog: 4 });
  assert.deepEqual(f.commands.at(-1), ['gcode', '$J=G21 G91 X0.0400 F3000.000']);
  f.session.reportSequence+=2; f.session.activeState='Idle'; f.session.positionReport={...f.session.positionReport,values:[0.04,0,0],sequence:f.session.reportSequence};
  f.input({ rightDialCode: 0x1b, jog: 1 });
  assert.equal(f.commands.filter(([c]) => c === 'gcode').length, 1);
  f.controls.setConfig({ largeSteps: 'enabled' }); f.session.reportSequence+=2;
  f.input({ jog: 1 }); assert.match(f.commands.at(-1)[1], /X10.0000/);
  for (const report of [{ leftDialCode: 0x14 }, { leftDialCode: 0x15 }, { leftDialCode: 0x16 }, { leftDialCode: 0x06 }, { leftDialCode: 0x11, rightDialCode: 0xff }]) f.input({ ...report, jog: 1 });
  assert.equal(f.commands.filter(([c]) => c === 'gcode').length, 2);
});

test('Step selects each axis maximum rate independently of program Feed % and distance selector', () => {
  for (const [leftDialCode, axis, setting, max] of [
    [0x11, 'X', '$110', '4321'], [0x12, 'Y', '$111', '2345'], [0x13, 'Z', '$112', '678'],
  ]) {
    for (const feedOverride of [20, 100, 175]) {
      for (const [rightDialCode, distance] of [[0x0e, '0.0300'], [0x10, '3.0000']]) {
        const f = fixture();
        f.session.settings.settings[setting] = max;
        f.session.overrides[0] = feedOverride;
        f.input({ leftDialCode, rightDialCode, jog: 3 });
        assert.deepEqual(f.commands, [['gcode', `$J=G21 G91 ${axis}${distance} F${max}.000`]]);
        assert.equal(f.grbl.pendingOverrides.size, 0);
      }
    }
  }
});

test('Step converts every numeric selector in current program units to internal mm for XYZ in both directions', () => {
  for (const [units, scale] of [['G21', 1], ['G20', 25.4]]) {
    for (const [leftDialCode, axis, max] of [[0x11, 'X', 3000], [0x12, 'Y', 3000], [0x13, 'Z', 1000]]) {
      for (const [code, selection] of Object.entries(SELECTORS)) {
        for (const jog of [-3, 3]) {
          const f = fixture(), requests = [];
          f.session.state.parserstate.modal.units = units;
          f.controls.setConfig({ largeSteps: 'enabled' });
          f.grbl.jog = (...args) => requests.push(args);
          f.input({ leftDialCode, rightDialCode: Number(code), jog });
          assert.deepEqual(requests, [[axis, jog * selection.step * scale, max]], `${units} ${axis} selector ${code} jog ${jog}`);
          assert.equal(f.grbl.pendingOverrides.size, 0);
        }
      }
    }
  }
});

test('large Step opt-in applies only to numeric 5/10, allowing one inch without opt-in', () => {
  for (const units of ['G20', 'G21']) {
    const f = fixture(), requests = [];
    f.session.state.parserstate.modal.units = units;
    f.grbl.jog = (...args) => requests.push(args);
    f.input({ rightDialCode: 0x10, jog: 1 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0][1], units === 'G20' ? 25.4 : 1);
    for (const rightDialCode of [0x1a, 0x1b]) {
      f.input({ rightDialCode, jog: 1 });
      assert.equal(requests.length, 1);
      assert.match(f.logs.at(-1), new RegExp(`5/10 ${units === 'G20' ? 'in' : 'mm'} steps are disabled`));
    }
  }
});

test('unknown Step units refuse wheel input clearly and recovery uses only the next detent', () => {
  for (const units of [undefined, null, '', 'G22', 'g20', 20]) {
    const f = fixture(), requests = [];
    f.session.state.parserstate.modal.units = units;
    f.grbl.jog = (...args) => requests.push(args);
    f.input({ jog: 4 });
    assert.deepEqual(requests, []);
    assert.match(f.logs.at(-1), /Step: waiting for known GRBL G20\/G21 program units; wheel input ignored/);
    f.session.state.parserstate.modal.units = 'G20';
    f.input({ jog: -1 });
    assert.deepEqual(requests, [['X', -0.1 * 25.4, 3000]]);
    f.session.state.parserstate.modal.units = 'G21';
    f.input({ jog: 2 });
    assert.deepEqual(requests.at(-1), ['X', 0.2, 3000]);
  }
});

test('Step inch input reaches the wire in current program units without changing report units', () => {
  const f = fixture();
  f.session.state.parserstate.modal.units = 'G20';
  f.input({ rightDialCode: 0x10, jog: -1 });
  assert.deepEqual(f.commands, [['gcode', '$J=G20 G91 X-1.000000 F118.110236']]);
  assert.equal(f.session.positionReport.units, '0');
});

test('Continuous input keeps physical mm and mm/min independent of program modal units', () => {
  for (const units of ['G20', 'G21']) {
    const f = fixture(), requests = [];
    f.session.state.parserstate.modal.units = units;
    f.grbl.jogPulse = (...args) => { requests.push(args); return 'sent'; };
    f.input({ rightDialCode: 0x0d });
    f.press(0x0e);
    f.input({ jog: -1 });
    assert.deepEqual(requests, [['X', -0.2, 60]]);
  }
});

test('readout follows program units and known mode without presenting Step as a feed percentage', () => {
  const f = fixture();
  f.input({ rightDialCode: 0x0f });
  assert.deepEqual(f.controls.readout, { mode: 'step (mm)', rate: '0.1 mm', largeSteps: '5/10 mm steps' });
  f.session.state.parserstate.modal.units = 'G20';
  assert.deepEqual(f.controls.readout, { mode: 'step (in)', rate: '0.1 in', largeSteps: '5/10 in steps (127/254 mm)' });
  f.session.state.parserstate.modal.units = undefined;
  assert.deepEqual(f.controls.readout, {
    mode: 'step (waiting for G20/G21)', rate: '0.1 (waiting for G20/G21)', largeSteps: '5/10 steps (waiting for G20/G21)',
  });
  f.session.state.parserstate.modal.units = 'G21';
  f.press(0x0e);
  assert.equal(f.controls.readout.mode, 'continuous (mm)');
  assert.equal(f.controls.readout.rate, '10% feed');
  f.input({ rightDialCode: 0x9b });
  assert.equal(f.controls.readout.mode, 'lead');
  assert.equal(f.controls.readout.rate, 'Spindle override');
  f.input({ rightDialCode: 0x0e });
  assert.equal(f.controls.readout.mode, 'mpg');
  assert.equal(f.controls.readout.rate, '5% feed');
  f.press(0x0f);
  f.input({ rightDialCode: 0xff });
  assert.equal(f.controls.readout.rate, '—');
});

test('the next Step uses the latest maximum-rate setting for the same axis', () => {
  for (const [leftDialCode, axis, setting, index] of [
    [0x11, 'X', '$110', 0], [0x12, 'Y', '$111', 1], [0x13, 'Z', '$112', 2],
  ]) {
    const f = fixture();
    f.session.settings.settings[setting] = '1234';
    f.input({ leftDialCode, jog: 1 });
    assert.deepEqual(f.commands.at(-1), ['gcode', `$J=G21 G91 ${axis}0.1000 F1234.000`]);
    const values = [0, 0, 0]; values[index] = 0.1;
    f.session.reportSequence++;
    f.session.positionReport = { ...f.session.positionReport, values, sequence: f.session.reportSequence };
    f.notify(true);
    f.session.settings.settings[setting] = '567';
    f.input({ jog: -2 });
    assert.deepEqual(f.commands.filter(([command]) => command === 'gcode'), [
      ['gcode', `$J=G21 G91 ${axis}0.1000 F1234.000`],
      ['gcode', `$J=G21 G91 ${axis}-0.2000 F567.000`],
    ]);
  }
});

test('Step refuses missing or invalid selected-axis limits rather than guessing a feed', () => {
  for (const [leftDialCode, axis, setting] of [[0x11, 'X', '$110'], [0x12, 'Y', '$111'], [0x13, 'Z', '$112']]) {
    for (const value of [undefined, null, '', '0', '-1', 'invalid', 'Infinity', NaN]) {
      const f = fixture();
      if (value === undefined) delete f.session.settings.settings[setting];
      else f.session.settings.settings[setting] = value;
      f.input({ leftDialCode, jog: 1 });
      assert.deepEqual(f.commands, []);
      assert.equal(f.logs.at(-1), `Step: waiting for GRBL ${axis} maximum-rate setting.`);
      f.session.settings.settings[setting] = '876';
      f.input({ jog: 1 });
      assert.deepEqual(f.commands, [['gcode', `$J=G21 G91 ${axis}0.1000 F876.000`]]);
    }
  }
});

test('legacy Step feed is ignored and excluded from saved config without losing other settings', () => {
  for (const stepFeed of [0, 17, 99999, 'invalid']) {
    const f = fixture();
    const settings = { largeSteps: 'enabled', spindleIncrement: 321,
      macros: { 1: 'M3', 2: { source: 'cncjs', id: 'saved', name: 'Saved macro' } } };
    const stored = JSON.stringify({ ...settings, stepFeed });
    f.controls.setConfig(parseConfig(JSON.parse(stored)));
    const saved = JSON.parse(JSON.stringify(f.controls.config));
    assert.deepEqual(saved, settings);
    assert.equal(Object.hasOwn(saved, 'stepFeed'), false);
    f.controls.setConfig(parseConfig(saved));
    f.input({ leftDialCode: 0x13, rightDialCode: 0x1a, jog: -1 });
    assert.deepEqual(f.commands, [['gcode', '$J=G21 G91 Z-5.0000 F1000.000']]);
    f.grbl.clearJog();
    f.press(6, 0x0c);
    assert.deepEqual(f.commands.at(-1), ['gcode', 'S821']);
    f.press(4, 0x0c);
    assert.deepEqual(f.commands.at(-1), ['gcode', ['M3']]);
    const selected = [];
    f.controls.onSavedMacro = id => selected.push(id);
    f.press(5, 0x0c);
    assert.deepEqual(selected, ['saved']);
  }
});

test('Continuous uses axis max-rate percentage, bounds pulses, cancels after silence, and waits for fresh Idle', () => {
  const f = fixture(); f.input({ rightDialCode: 0x0d }); f.press(0x0e); f.input({ jog: 1 });
  assert.deepEqual(f.commands.at(-1), ['gcode', '$J=G21 G91 X0.2000 F60.000']);
  f.timer.advance(100); f.input({ jog: 5 });
  assert.equal(f.commands.filter(([c]) => c === 'gcode').length, 1);
  f.timer.advance(180);
  assert.equal(f.commands.at(-1)[0],'jogCancel');
  assert.equal(f.commands.some(([c])=>c==='statusreport'),false,'Cancellation confirmation is delayed');
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

test('clearance and probe actions dispatch once per physical press', () => {
  const f = fixture(), actions = [];
  f.controls.onClearance = workHome => actions.push(['clearance', workHome]);
  f.controls.onProbe = () => actions.push(['probe']);
  for (const code of [9, 10, 13]) {
    f.input({ firstKeyCode: code });
    f.input({ firstKeyCode: code });
    f.input({});
  }
  assert.deepEqual(actions, [['clearance', false], ['clearance', true], ['probe']]);
  assert.deepEqual(f.commands, []);
});

test('Fn uses macros, spindle RPM/direction, coolant, and Macro10 toggles coordinates', () => {
  const f=fixture(); f.press(6,0x0c); assert.deepEqual(f.commands.at(-1),['gcode','S600']);
  f.press(7,0x0c); assert.deepEqual(f.commands.at(-1),['gcode','S400']);
  f.press(11,0x0c); f.press(11); assert.deepEqual(f.commands.at(-1),['gcode','M4']);
  f.press(14,0x0c); assert.deepEqual(f.commands.at(-1),['gcode','M8']);
  f.press(15,0x0c); assert.deepEqual(f.commands.at(-1),['gcode','M7']);
  f.press(16); assert.equal(f.controls.coordinates,'machine');
  f.press(16); assert.equal(f.controls.coordinates,'work');
  f.press(9,0x0c); assert.match(f.logs.at(-1),/Macro-6 \(Fn\+Safe-Z\) is not configured/);
});

test('explicitly disabled macros persist and never run, distinct from missing assignments, under unchanged slot IDs', () => {
  const f = fixture(), selected = [];
  f.controls.onSavedMacro = id => selected.push(id);
  const config = parseConfig(JSON.parse(JSON.stringify({ macros: { 14: { source: 'disabled' }, 11: 'G0 X0' } })));
  assert.deepEqual(config.macros, { 11: 'G0 X0', 14: { source: 'disabled' } });
  f.controls.setConfig(config);
  f.press(16, 0x0c);
  assert.deepEqual(f.commands, []);
  assert.match(f.logs.at(-1), /Macro-10 \(Fn\+Macro-10\) is disabled/);
  f.press(2, 0x0c);
  assert.match(f.logs.at(-1), /Fn\+Stop is not configured/);
  f.press(1, 0x0c);
  assert.deepEqual(f.commands, [['gcode', ['G0 X0']]]);
  assert.deepEqual(selected, []);
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
  for (const value of [{largeSteps:true},{spindleIncrement:NaN},{macros:[]},{macros:{3:'M3'}},{macros:{1:()=>{}}}]) assert.throws(()=>parseConfig(value));
});

test('configured custom macros refuse unavailable bounds while ordinary commands still run', () => {
  const f = fixture();
  f.controls.setConfig({ macros: { 1: 'G0 X[xmax]', 2: 'G21\nG0 X0' } });
  f.press(4, 0x0c);
  assert.deepEqual(f.commands, []);
  assert.match(f.logs.at(-1), /uses xmax/);
  f.press(5, 0x0c);
  assert.deepEqual(f.commands, [['gcode', ['G21', 'G0 X0']]]);
});

test('saved macro references dispatch their ID once per physical press and reject malformed assignments', () => {
  const f = fixture(), selected = [];
  f.controls.onSavedMacro = id => selected.push(id);
  f.controls.setConfig({ macros: { 1: { source: 'cncjs', id: 'saved', name: 'A macro' } } });
  f.input({ firstKeyCode: 0x0c, secondKeyCode: 4 });
  f.input({ firstKeyCode: 0x0c, secondKeyCode: 4 });
  assert.deepEqual(selected, ['saved']);
  assert.deepEqual(f.commands, []);
  for (const assignment of [{ source: 'cncjs', id: '' }, { source: 'cncjs', id: 1 }, { source: 'other', id: 'x' }]) {
    assert.throws(() => parseConfig({ macros: { 1: assignment } }));
  }
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
  assert.equal(f.commands.filter(([c])=>c==='statusreport').length,0,'Native motion never needs a pendant poll');
  f.session.activeState='Idle'; f.session.idleReports=2; f.session.reportSequence+=2; f.session.positionReport={...f.session.positionReport,values:[1,0,0],sequence:f.session.reportSequence};
  f.timer.advance(100);
  assert.equal(f.commands.filter(([c])=>c==='gcode').length,1);
  f.input({jog:1});
  assert.equal(f.commands.filter(([c])=>c==='gcode').length,2);
  f.timer.advance(180);
  f.session.reportSequence+=2; f.session.idleReports=2; f.notify();
  assert.equal(f.timer.timers.size,0);
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

test('clipped and uncertain jogs use distinct raw Idle evidence thresholds', () => {
  for (const [replyTracking, receiptState, count, phase, notice] of [
    ['synchronized', 'acknowledged', 5, 'idle', /Z jog ended short of its target/],
    ['unknown', 'uncertain', 2, 'armed', /Jog completion cannot be confirmed/],
  ]) {
    const f=fixture(); f.session.replyTracking=replyTracking; f.session.positionReport={...f.session.positionReport,values:[0,0,-356]};
    f.session.jog=code=>{ f.session.command('gcode',code); return {state:receiptState,transmission:'written',reportSequence:f.session.reportSequence}; };
    assert.equal(f.grbl.jog('Z',-1,100),'sent');
    for(let i=0;i<count;i++) {
      f.session.reportSequence++; f.session.idleReports++;
      f.session.positionReport={...f.session.positionReport,sequence:f.session.reportSequence};
      f.notify();
      assert.equal(f.grbl.jogPhase,i===count-1?phase:'active',replyTracking);
    }
    assert.equal(f.timer.timers.size,0,replyTracking);
    assert.match(f.logs.at(-1),notice);
    assert.equal(f.grbl.jog('Z',1,100),'sent',replyTracking);
    assert.equal(f.commands.filter(([c])=>c==='gcode').length,2,replyTracking);
    f.grbl.clearJog();
  }
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
