import { parseScript } from './vendor/esprima.js';

const BOUNDS = new Set(['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax']);

// CNCjs supplies live controller variables, but its Visualizer bounds are not
// exposed to custom widgets. Refuse those identifiers, including assignments,
// rather than allowing the server to silently substitute zero bounds.
export function validateMacroContent(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('The selected macro has no G-code.');
  for (const [index, original] of content.split(/\r?\n/).entries()) {
    const line = original.trim();
    if (!line.startsWith('%')) {
      // CNCjs evaluates brackets before stripping G-code comments. Calls inside
      // comment brackets can still execute, so validate those expressions too.
      for (const match of line.matchAll(/\[([^\]]+)\]/g)) validateExpression(match[1], index + 1);
      continue;
    }
    // Match CNCjs builtin-command exactly: unlike the assignment path, this
    // regex does not consume a comment containing lone CR or U+2028 separators.
    const builtin = line.replace(/;.*$/, '').trim();
    if (/^%wait\b/i.test(builtin)) continue;
    if (/^%msg\b/i.test(builtin)) {
      for (const match of builtin.matchAll(/\[([^\]]+)\]/g)) validateExpression(match[1], index + 1);
      continue;
    }
    const code = line.split(';')[0];
    if (code.slice(1).trim()) validateExpression(code.slice(1), index + 1);
  }
  return content;
}

function validateExpression(expression, line) {
  let ast;
  try { ast = parseScript(expression); }
  // CNCjs leaves unparseable bracket text unchanged, then strips G-code
  // comments. A parse failure cannot read a bound; let CNCjs handle that text.
  catch { return; }
  const name = findBounds(ast);
  if (name) throw new Error(`Macro line ${line} uses ${name}, a program-bound variable unavailable to the pendant. Save and run this code in the CNCjs Macro widget.`);
}

function findBounds(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'Identifier' && BOUNDS.has(node.name)) return node.name;
  for (const [key, value] of Object.entries(node)) {
    // These identifiers are property names, not reads of controller variables.
    if (key === 'property' && node.type === 'MemberExpression' && !node.computed) continue;
    if (key === 'key' && node.type === 'Property' && !node.computed) continue;
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      const name = findBounds(child);
      if (name) return name;
    }
  }
  return null;
}
