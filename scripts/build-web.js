'use strict';

/*
 * build-web.js — assemble the static site for hosting.
 *
 * There is no bundler and there are no dependencies. The build copies web/
 * into dist/ and then copies the three *pure* modules out of src/ alongside
 * them, so the deployed page runs the same lru.js, policies.js and
 * sample-trace.js that the Node server and the test suite use.
 *
 * That copy is the whole point: the hosted demo must not be a second
 * implementation of the algorithm that merely resembles the tested one.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');

// Pure, platform-free modules that the browser loads verbatim.
const SHARED = ['lru.js', 'policies.js', 'sample-trace.js'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let n = 0;
for (const f of fs.readdirSync(path.join(ROOT, 'web'))) {
  fs.copyFileSync(path.join(ROOT, 'web', f), path.join(OUT, f));
  n++;
}
for (const f of SHARED) {
  const from = path.join(ROOT, 'src', f);
  if (!fs.existsSync(from)) {
    console.error(`build failed: src/${f} is missing`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(OUT, f));
  n++;
}

// Fail loudly if a script the page loads did not make it into dist/.
const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
const missing = [...html.matchAll(/<script src="\.\/([^"]+)"/g)]
  .map((m) => m[1])
  .filter((f) => !fs.existsSync(path.join(OUT, f)));

if (missing.length) {
  console.error('build failed: index.html references files not in dist/: ' + missing.join(', '));
  process.exit(1);
}

console.log(`built dist/ — ${n} files, ${missing.length === 0 ? 'all scripts present' : ''}`);
