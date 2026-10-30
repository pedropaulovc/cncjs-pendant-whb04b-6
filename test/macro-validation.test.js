import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMacroContent } from '../web/widget/macro-validation.js';

test('allows G-code and native live position, modal, global and assignment expressions', () => {
  const content = '%saved=posx\nG0 X[posx + 1] Y[mposy]\n[modal.units]\n%global.last=saved\nG1 F[Math.max(1, 100)]';
  assert.equal(validateMacroContent(content), content);
});

test('rejects all unavailable bounds, including Unicode-escaped identifiers', () => {
  for (const name of ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax']) {
    assert.throws(() => validateMacroContent(`G0 X[${name}]`), /program-bound variable/);
    assert.throws(() => validateMacroContent(`%position=${name} + 1`), /program-bound variable/);
  }
  for (const name of [String.raw`\u0078min`, String.raw`\u{78}min`, String.raw`xm\u0069n`]) {
    assert.throws(() => validateMacroContent(`G0 X[${name}]`), /uses xmin/);
  }
  assert.throws(() => validateMacroContent('%xmin=10\nG0 X[xmin]'), /uses xmin/);
  assert.throws(() => validateMacroContent('%obj={xmin}'), /uses xmin/);
});

test('does not mistake comments, string contents or property names for bounding variables', () => {
  for (const content of [
    '(xmin and xmax are comment text)\nG0 X0 ; ymin ymax',
    '%message="xmin"\n%obj={xmin: 3}\n%value=global.xmin',
    '%value=global["xmin"]',
    'G0 X[posx] (xmin)\nG0 Y[posy] ; ymin',
    'G0 X[Number("3")] (xmax)',
  ]) assert.equal(validateMacroContent(content), content);
  assert.throws(() => validateMacroContent('%value=global[xmin]'), /uses xmin/);
  assert.throws(() => validateMacroContent('(Bounds [xmin])'), /uses xmin/);
  assert.throws(() => validateMacroContent('G0 X0 ; [xmin]'), /uses xmin/);
});

test('matches native percent-command expression handling', () => {
  assert.equal(validateMacroContent('%msg literal xmin\n%wait 0.1 ; xmin\n%\nG0 X0'), '%msg literal xmin\n%wait 0.1 ; xmin\n%\nG0 X0');
  assert.throws(() => validateMacroContent('%MSG Width [xmax-xmin]'), /program-bound variable/);
  assert.equal(validateMacroContent('%saved=posx ; xmin'), '%saved=posx ; xmin');
  for (const separator of ['\r', '\u2028']) {
    assert.throws(() => validateMacroContent(`%msg Width ;${separator}[xmax]`), /uses xmax/);
    const assignment = `%saved=posx ;${separator}xmax`;
    assert.equal(validateMacroContent(assignment), assignment);
  }
});

test('reports empty content but leaves unparseable bracket text for CNCjs', () => {
  for (const content of [undefined, null, '', ' \n ']) assert.throws(() => validateMacroContent(content), /no G-code/);
  for (const content of ['G0 X0 ; go to [corner 1]', "G0 Z5 (lift [don't crash])", 'G21\nG0 X[posx + ]']) {
    assert.equal(validateMacroContent(content), content);
  }
  assert.throws(() => validateMacroContent('G21\nG0 X[xmax]'), /line 2 uses xmax/);
});
