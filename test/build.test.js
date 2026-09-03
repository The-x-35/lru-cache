'use strict';

/*
 * Tests for the static build that gets hosted.
 *
 * Two things matter here and neither is cosmetic:
 *
 *  1. The deployed page must run the SAME algorithm the other suites test. If
 *     dist/lru.js ever drifts from src/lru.js, every guarantee the test suite
 *     provides stops applying to the thing users actually load.
 *
 *  2. The browser modules load as classic <script> tags sharing one global
 *     scope, so a top-level `const { LRUIndex } = ...` in one file collides
 *     with `class LRUIndex` in another and the page dies with a SyntaxError
 *     before it renders. That happened. Each module must stay wrapped.
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

let passed = 0;
const log = [];

function test(name, fn) {
  try { fn(); passed++; log.push(`  ok  ${name}`); }
  catch (e) { log.push(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// Build from scratch so the test reflects a clean deploy, not leftovers.
fs.rmSync(DIST, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-web.js')], { stdio: 'pipe' });

test('the build produces a dist/ with an entry point', () => {
  assert.ok(fs.existsSync(DIST), 'dist/ exists');
  assert.ok(fs.existsSync(path.join(DIST, 'index.html')), 'index.html exists');
});

test('every script index.html references is present', () => {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/<script src="\.\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 5, `expected several scripts, found ${refs.length}`);

  const missing = refs.filter((f) => !fs.existsSync(path.join(DIST, f)));
  assert.deepEqual(missing, [], 'referenced but not built');

  const css = [...html.matchAll(/href="\.\/([^"]+\.css)"/g)].map((m) => m[1]);
  assert.deepEqual(css.filter((f) => !fs.existsSync(path.join(DIST, f))), [], 'missing stylesheet');
});

test('the worker the pool spawns is in the build', () => {
  const pool = fs.readFileSync(path.join(DIST, 'pool.js'), 'utf8');
  const m = /new Worker\((\w+)\)/.exec(pool);
  assert.ok(m, 'pool spawns a Worker');
  const url = /WORKER_URL = '\.\/([^']+)'/.exec(pool);
  assert.ok(url, 'worker url is declared');
  assert.ok(fs.existsSync(path.join(DIST, url[1])), `${url[1]} must be built`);
});

test('the deployed algorithm is byte-identical to the tested one', () => {
  // This is the whole reason the build copies rather than re-implements.
  for (const f of ['lru.js', 'policies.js', 'sample-trace.js']) {
    const a = fs.readFileSync(path.join(ROOT, 'src', f));
    const b = fs.readFileSync(path.join(DIST, f));
    assert.ok(a.equals(b), `dist/${f} differs from src/${f} — the hosted page would run untested code`);
  }
});

test('the shared modules really are platform-free', () => {
  // A require('node:...') in any of these would throw in the browser.
  for (const f of ['lru.js', 'policies.js', 'sample-trace.js']) {
    const src = fs.readFileSync(path.join(DIST, f), 'utf8');
    assert.ok(!/require\(['"]node:/.test(src), `${f} must not require a node builtin`);
    assert.ok(!/\bprocess\.(?!env\b)/.test(src), `${f} must not touch process`);
  }
});

test('each browser module is scope-isolated', () => {
  // Without the wrapper these collide in the shared global scope and the page
  // fails to boot at all.
  for (const f of ['store.js', 'pool.js', 'cache.js', 'sources.js', 'app.js']) {
    const src = fs.readFileSync(path.join(DIST, f), 'utf8');
    assert.ok(/^\(function \(\) \{$/m.test(src), `${f} is not wrapped in an IIFE`);
    assert.ok(/\}\(\)\);\s*$/.test(src), `${f} does not close its IIFE`);
  }
});

test('the unwrapped shared modules do not collide with each other', () => {
  // Only files WITHOUT an IIFE actually share the global scope. Those are the
  // three shared modules, and a duplicate name between them would kill the
  // page with a SyntaxError before it rendered — which is exactly what
  // happened before the browser modules were wrapped.
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/<script src="\.\/([^"]+)"/g)].map((m) => m[1]);
  const owner = new Map();
  let checked = 0;

  for (const f of refs) {
    const src = fs.readFileSync(path.join(DIST, f), 'utf8');
    if (/^\(function \(\) \{$/m.test(src)) continue;   // scoped; cannot collide
    checked++;

    for (const m of src.matchAll(/^(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1];
      if (owner.has(name)) {
        assert.fail(`${name} is declared at global scope in both ${owner.get(name)} and ${f}`);
      }
      owner.set(name, f);
    }
  }

  assert.equal(checked, 3, 'exactly the three shared modules should be unwrapped');
  assert.ok(owner.size > 5, `found ${owner.size} global declarations to check`);
});

test('each shared module publishes itself under its own global', () => {
  const globals = { 'lru.js': 'LRUCore', 'policies.js': 'LRUPolicies', 'sample-trace.js': 'LRUSample' };
  for (const [f, g] of Object.entries(globals)) {
    const src = fs.readFileSync(path.join(DIST, f), 'utf8');
    assert.ok(src.includes('globalThis.' + g), `${f} must export globalThis.${g} for the browser`);
    assert.ok(src.includes('module.exports'), `${f} must still export for Node`);
  }
});

test('the page declares no external dependencies', () => {
  // A strict host or an offline demo must not need a CDN.
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const external = [...html.matchAll(/(?:src|href)="(https?:)?\/\/[^"]+"/g)].map((m) => m[0]);
  assert.deepEqual(external, [], 'the build must be self-contained');
});

console.log(log.join('\n'));
console.log(`\n${passed} build tests passed\n`);
