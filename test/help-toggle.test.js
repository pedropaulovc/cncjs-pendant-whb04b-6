import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireHelpToggle } from '../web/widget/help-toggle.js';

function fixture() {
  const document = new EventTarget();
  const button = Object.assign(new EventTarget(), { ownerDocument: document, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
  const panel = Object.assign(new EventTarget(), { hidden: false });
  const timers = [];
  wireHelpToggle(button, panel, { schedule: fn => timers.push(fn), cancel: () => {} });
  const fire = (target, type, init) => target.dispatchEvent(Object.assign(new Event(type), init));
  const open = () => {
    assert.equal(button.attributes['aria-expanded'], String(!panel.hidden));
    return !panel.hidden;
  };
  return { document, button, panel, timers, fire, open };
}

test('hover previews the help and stays open while the pointer moves onto the panel', () => {
  const f = fixture();
  assert.equal(f.open(), false);
  f.fire(f.button, 'mouseenter');
  assert.equal(f.open(), true);
  f.fire(f.button, 'mouseleave');
  f.fire(f.panel, 'mouseenter');
  f.fire(f.panel, 'mouseleave');
  assert.equal(f.open(), true, 'grace period before hiding');
  f.timers.at(-1)();
  assert.equal(f.open(), false);
});

test('keyboard focus previews, click pins across blur, and Escape or a second click closes', () => {
  const f = fixture();
  f.fire(f.button, 'focus');
  assert.equal(f.open(), true);
  f.fire(f.button, 'blur');
  assert.equal(f.open(), false);
  f.fire(f.button, 'focus');
  f.fire(f.button, 'click');
  f.fire(f.button, 'blur');
  assert.equal(f.open(), true, 'pinned help survives blur');
  f.fire(f.document, 'keydown', { key: 'Escape' });
  assert.equal(f.open(), false);
  f.fire(f.button, 'blur');
  f.fire(f.button, 'focus');
  assert.equal(f.open(), true, 'returning focus previews again');
  f.fire(f.button, 'click');
  assert.equal(f.open(), true);
  f.fire(f.button, 'click');
  assert.equal(f.open(), false, 'second click closes even while focused');
});
