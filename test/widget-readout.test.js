import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PendantControls } from '../web/widget/pendant-controls.js';

function fixture() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', className: '' });
    return elements.get(id);
  };
  class CncjsSession {
    constructor(options) {
      this.options = options;
      this.state = { parserstate: { modal: { units: 'G21' } } };
      this.status = { phase: 'joined' };
    }
  }
  class Grbl {
    constructor(session) { this.session = session; }
    get jogUnits() {
      const code = this.session.state.parserstate.modal.units;
      return code === 'G20' ? { code, scale: 25.4, label: 'in' }
        : code === 'G21' ? { code, scale: 1, label: 'mm' } : null;
    }
    cancelJog() {}
    overrideTarget() {}
  }
  const context = vm.createContext({
    document: { getElementById: element, addEventListener() {}, hidden: false },
    window: { addEventListener() {} },
    location: { origin: 'https://cncjs.example' },
    WHB04BWebHID: class { connected = false; },
    CncjsSession, Grbl, PendantControls,
    CncjsMacros: class {}, SavedMacroRunner: class { cancel() {} },
    setTimeout, clearTimeout, performance,
  });
  const source = readFileSync(new URL('../web/widget/whb04b-widget.js', import.meta.url), 'utf8');
  // Exercise the widget's real rendering callbacks without booting browser I/O.
  vm.runInContext(source.replace(/^import\s[\s\S]*?from\s*['"][^'"]+['"];\n/gm, '')
    + '\nglobalThis.widget = { session, controls, handleInput };', context);
  return { ...context.widget, element };
}

const report = { firstKeyCode: 0, secondKeyCode: 0, leftDialCode: 0x11, rightDialCode: 0x0f,
  firstKey: 'None', secondKey: 'None', leftDial: 'X', rightDial: '10%', jog: 0 };

test('widget rerenders modal units from controller state even with the pendant disconnected', () => {
  const f = fixture();
  f.handleInput(report);
  assert.equal(f.element('mode').textContent, 'step (mm)');
  assert.equal(f.element('rd').textContent, '0.1 mm');
  assert.equal(f.element('largeStepsLabel').textContent, '5/10 mm steps');
  for (const [units, mode, rate, label] of [
    ['G20', 'step (in)', '0.1 in', '5/10 in steps'],
    [undefined, 'step (waiting for G20/G21)', '0.1 (waiting for G20/G21)', '5/10 steps (waiting for G20/G21)'],
    ['G21', 'step (mm)', '0.1 mm', '5/10 mm steps'],
  ]) {
    f.session.state.parserstate.modal.units = units;
    f.session.options.onState('Grbl', f.session.state);
    assert.equal(f.element('mode').textContent, mode);
    assert.equal(f.element('rd').textContent, rate);
    assert.equal(f.element('largeStepsLabel').textContent, label);
  }
});

test('widget renders selector values using the current mode, not raw percent input labels', () => {
  const f = fixture();
  for (const [rightDialCode, value] of [[0x0d, '0.001'], [0x0e, '0.01'], [0x0f, '0.1'], [0x10, '1'], [0x1a, '5'], [0x1b, '10']]) {
    f.handleInput({ ...report, rightDialCode });
    assert.equal(f.element('rd').textContent, `${value} mm`);
  }
  f.handleInput({ ...report, firstKeyCode: 14 });
  assert.equal(f.element('mode').textContent, 'continuous (mm)');
  assert.equal(f.element('rd').textContent, '10% feed');
  f.session.state.parserstate.modal.units = 'G20';
  f.session.options.onState('Grbl', f.session.state);
  assert.equal(f.element('mode').textContent, 'continuous (in)');
  assert.equal(f.element('rd').textContent, '10% feed');
  f.handleInput({ ...report, rightDialCode: 0x9b });
  assert.equal(f.element('mode').textContent, 'lead');
  assert.equal(f.element('rd').textContent, 'Spindle override');
  f.handleInput(report);
  assert.equal(f.element('mode').textContent, 'mpg');
  assert.equal(f.element('rd').textContent, '10% feed');
});
