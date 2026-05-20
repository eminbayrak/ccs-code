# Migration: CommonJS → ESM

## Trigger Keywords
commonjs, cjs, require, module.exports, esm, es modules, import, mjs

## Languages
TypeScript, JavaScript

## What to Change
1. Replace `require()` calls with `import` statements at the top of the file
2. Replace `module.exports = X` with `export default X`
3. Replace `module.exports = { a, b }` with named `export { a, b }` or `export const a = ...`
4. Replace `exports.foo = bar` with `export const foo = bar` or `export { bar as foo }`
5. Replace `__dirname` with `import.meta.dirname` (Node 21.2+) or use `fileURLToPath(import.meta.url)`
6. Replace `__filename` with `import.meta.filename` or `fileURLToPath(import.meta.url)`
7. Add `.js` extension to all relative imports (ESM requires explicit extensions)
8. Replace dynamic `require()` in function bodies with `await import()`

## Before
```javascript
const fs = require('fs');
const path = require('path');
const { helper } = require('./utils');
const config = require('../config.json');

function main() {
  const dir = __dirname;
  console.log(dir);
}

module.exports = { main };
module.exports.helper = helper;
```

## After
```javascript
import fs from 'fs';
import path from 'path';
import { helper } from './utils.js';
import config from '../config.json' assert { type: 'json' };
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function main() {
  const dir = __dirname;
  console.log(dir);
}

export { main };
export { helper };
```

## Edge Cases
- Dynamic `require()` inside a function: convert to `const mod = await import('./path.js')` and make the function async
- Conditional requires (`if (condition) require(...)`) → move to top-level with a dynamic import
- `require.resolve()` → `import.meta.resolve()` in Node 20.6+
- JSON imports need `assert { type: 'json' }` in some Node versions
- Circular dependencies: flag them with a comment `// TODO: circular dep — review after migration`
- `module.exports = function(){}` default export: `export default function(){}`
- Re-exports: `module.exports = require('./other')` → `export * from './other.js'`

## Forbidden Patterns
- `require(`
- `module.exports`
- `exports.`
- `__dirname` (unless replaced with import.meta.dirname)
- `__filename` (unless replaced with import.meta.filename)

## Acceptance Criteria
- [ ] No `require(` calls remain
- [ ] No `module.exports` or `exports.` assignments remain
- [ ] All relative imports have `.js` extension
- [ ] `__dirname` and `__filename` replaced with ESM equivalents
- [ ] Build passes (tsc --noEmit or equivalent)
- [ ] All existing tests pass
