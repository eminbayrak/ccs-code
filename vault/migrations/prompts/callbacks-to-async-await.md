# Migration: Callbacks → Async/Await

## Trigger Keywords
callback, async, await, promise, then, catch, promisify, node-style callback, cb, err-first

## Languages
TypeScript, JavaScript

## What to Change
1. Convert Node-style error-first callbacks `(err, result) => {}` to `try/catch` with `await`
2. Wrap callback-based APIs with `util.promisify()` or manual Promise wrappers where needed
3. Replace `.then().catch()` chains with `async/await` + `try/catch`
4. Mark the enclosing function as `async`
5. Replace `callback(null, result)` return style with `return result`
6. Replace `callback(err)` with `throw err`
7. Remove explicit `new Promise((resolve, reject) => {...})` wrappers where `util.promisify` applies
8. Convert `Promise.all([...])` to `await Promise.all([...])` if not already awaited

## Before
```javascript
function readConfig(filePath, callback) {
  fs.readFile(filePath, 'utf-8', (err, data) => {
    if (err) return callback(err);
    try {
      callback(null, JSON.parse(data));
    } catch (parseErr) {
      callback(parseErr);
    }
  });
}

getUser(id)
  .then(user => enrichUser(user))
  .then(enriched => saveUser(enriched))
  .catch(err => console.error(err));
```

## After
```javascript
async function readConfig(filePath) {
  const data = await fs.promises.readFile(filePath, 'utf-8');
  return JSON.parse(data);
}

try {
  const user = await getUser(id);
  const enriched = await enrichUser(user);
  await saveUser(enriched);
} catch (err) {
  console.error(err);
}
```

## Edge Cases
- Callbacks called multiple times (event emitters, streams): do NOT convert — these are not one-shot callbacks. Add comment `// NOTE: multi-call callback — not converted to async/await`
- Parallel callbacks: convert to `await Promise.all([...])`
- Callbacks in loops: use `for...of` with `await` instead of `forEach`
- Express/Koa middleware with `next()`: convert body to async but keep `next()` signature — make function `async (req, res, next) => {}`
- Error-first callbacks where success value is ignored: `await fn()` without storing result

## Forbidden Patterns
- `(err, result) =>` (Node-style error-first callback signature inside async functions)
- `.then(` (promise chain that can be replaced with await)
- `.catch(` (standalone catch chain — use try/catch instead)

## Acceptance Criteria
- [ ] No error-first callback signatures in new async functions
- [ ] All `.then().catch()` chains replaced with async/await
- [ ] All enclosing functions marked async
- [ ] No unhandled promise rejections introduced
- [ ] Build passes
- [ ] All existing tests pass
