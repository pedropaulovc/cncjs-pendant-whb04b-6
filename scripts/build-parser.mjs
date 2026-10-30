import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = require.resolve('esprima');
const packageRoot = dirname(require.resolve('esprima/package.json'));
const destination = resolve(root, 'web/widget/vendor');
await mkdir(destination, { recursive: true });
const distribution = await readFile(source, 'utf8');
// Esprima's official UMD build takes the CommonJS branch without browser globals.
await writeFile(resolve(destination, 'esprima.js'),
  `// Generated from esprima 4.0.1; see esprima.LICENSE.BSD.\nconst module = { exports: {} };\nconst exports = module.exports;\n${distribution}\nexport const parseScript = module.exports.parseScript;\n`);
await writeFile(resolve(destination, 'esprima.LICENSE.BSD'), await readFile(resolve(packageRoot, 'LICENSE.BSD')));
