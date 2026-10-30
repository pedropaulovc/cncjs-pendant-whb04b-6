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
    // CNCjs strips semicolon comments before matching %msg/%wait or assignments.
    const code = line.split(';')[0];
    if (/^%wait\b/i.test(code)) continue;
    if (/^%msg\b/i.test(code)) {
      for (const match of code.matchAll(/\[([^\]]+)\]/g)) validateExpression(match[1], index + 1);
      continue;
    }
    if (code.slice(1).trim()) validateExpression(code.slice(1), index + 1);
  }
  return content;
}

function validateExpression(expression, line) {
  let ast;
  try { ast = parseScript(expression); }
  catch { throw new Error(`Macro line ${line}: invalid CNCjs expression.`); }
  const name = findBounds(ast);
  if (name) throw new Error(`Macro line ${line} uses ${name}, a program-bound variable unavailable to the pendant. Run this macro from the CNCjs Macro widget.`);
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
