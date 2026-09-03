'use strict';

/*
 * End-to-end tests against a real server process.
 *
 * These cover the things unit tests cannot: that the two data sources really
 * are independent caches, that Start/Step/Empty only touch the mode they were
 * aimed at, and that the HTTP surface behaves. The server is booted on a spare
 * port with its own throwaway store directory.
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const PORT = 7799;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const log = [];

async function test(name, fn) {
  try { await fn(); passed++; log.push(`  ok  ${name}`); }
  catch (e) { log.push(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const get = (p) => fetch(BASE + p).then((r) => r.json());
const post = (p, b) => fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}),
}).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stateOf = async (mode) => (await get('/api/state')).modes[mode];

(async () => {
  const store = await fsp.mkdtemp(path.join(os.tmpdir(), 'lru-srv-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), STORE_DIR: store },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // wait for it to answer
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(120);
    try { await get('/api/state'); up = true; } catch { /* not yet */ }
  }
  if (!up) { console.error('server never came up'); child.kill('SIGKILL'); process.exit(1); }

  try {

    await test('serves the page and its assets', async () => {
      for (const [p, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css']]) {
        const r = await fetch(BASE + p);
        assert.equal(r.status, 200, `${p} status`);
        assert.ok(r.headers.get('content-type').startsWith(type), `${p} content-type`);
      }
    });

    await test('refuses to serve files outside public/', async () => {
      // encoded so the path is not normalised away before it reaches us
      const r = await fetch(`${BASE}/..%2f..%2fserver.js`);
      assert.ok(r.status === 403 || r.status === 404, `expected refusal, got ${r.status}`);
      const body = await r.text();
      assert.ok(!body.includes('createServer'), 'server source must not be readable');
    });

    await test('reports both modes, each starting empty', async () => {
      const s = await get('/api/state');
      assert.deepEqual(Object.keys(s.modes).sort(), ['live', 'sample']);
      for (const m of ['sample', 'live']) {
        assert.equal(s.modes[m].cache.resident, 0, `${m} starts empty`);
        assert.equal(s.modes[m].cache.metrics.accesses, 0, `${m} starts at zero`);
      }
      assert.ok(s.pool.size >= 1, 'a thread pool exists');
    });

    await test('an unknown mode falls back rather than crashing', async () => {
      const r = await post('/api/step', { mode: 'nonsense' });
      assert.ok(r.key, 'still served a page');
      assert.equal((await stateOf('sample')).cache.metrics.accesses, 1, 'treated as sample');
    });

    await test('step advances only the mode it names', async () => {
      const before = await get('/api/state');
      await post('/api/step', { mode: 'live' });
      const after = await get('/api/state');
      assert.equal(after.modes.live.cache.metrics.accesses,
        before.modes.live.cache.metrics.accesses + 1, 'live advanced');
      assert.equal(after.modes.sample.cache.metrics.accesses,
        before.modes.sample.cache.metrics.accesses, 'sample untouched');
    });

    await test('the two modes use different key spaces', async () => {
      for (let i = 0; i < 6; i++) await post('/api/step', { mode: 'sample' });
      for (let i = 0; i < 6; i++) await post('/api/step', { mode: 'live' });

      const s = await get('/api/state');
      const sampleKeys = s.modes.sample.cache.entries.map((e) => e.key);
      const liveKeys = s.modes.live.cache.entries.map((e) => e.key);

      assert.ok(sampleKeys.length && liveKeys.length, 'both hold pages');
      const overlap = sampleKeys.filter((k) => liveKeys.includes(k));
      assert.deepEqual(overlap, [], 'no page may appear in both caches');

      // sample uses invented apps in a high pid band; live uses real processes
      assert.ok(sampleKeys.every((k) => /\[7\d{4}\]/.test(k)),
        `sample keys should be synthetic: ${sampleKeys.slice(0, 3)}`);
    });

    await test('selecting a mode changes nothing about either cache', async () => {
      const before = await get('/api/state');
      await post('/api/select', { mode: 'live' });
      await post('/api/select', { mode: 'sample' });
      const after = await get('/api/state');
      for (const m of ['sample', 'live']) {
        assert.equal(after.modes[m].cache.resident, before.modes[m].cache.resident, `${m} pages`);
        assert.equal(after.modes[m].cache.metrics.accesses, before.modes[m].cache.metrics.accesses, `${m} counters`);
      }
    });

    await test('Empty clears only the mode it names', async () => {
      const before = await get('/api/state');
      assert.ok(before.modes.sample.cache.resident > 0, 'sample has pages to protect');

      await post('/api/clear', { mode: 'live' });
      const after = await get('/api/state');

      assert.equal(after.modes.live.cache.resident, 0, 'live emptied');
      assert.equal(after.modes.live.cache.metrics.accesses, 0, 'live counters reset');
      assert.equal(after.modes.live.cache.lastAccess, null, 'no stale status line on an empty cache');
      assert.equal(after.modes.sample.cache.resident, before.modes.sample.cache.resident,
        'sample pages survived');
      assert.equal(after.modes.sample.cache.metrics.accesses, before.modes.sample.cache.metrics.accesses,
        'sample counters survived');
    });

    await test('each mode has its own directory on disk', async () => {
      await post('/api/step', { mode: 'live' });
      const [ds, dl] = await Promise.all([get('/api/disk?mode=sample'), get('/api/disk?mode=live')]);
      assert.ok(ds.root.endsWith(path.join('', 'sample')), `sample root: ${ds.root}`);
      assert.ok(dl.root.endsWith(path.join('', 'live')), `live root: ${dl.root}`);
      assert.notEqual(ds.root, dl.root);
      assert.ok(ds.files.length > 0 && dl.files.length > 0, 'both have real files');
      const names = new Set(ds.files.map((f) => f.file));
      assert.ok(!dl.files.some((f) => names.has(f.file) && ds.root === dl.root), 'stores are separate');
    });

    await test('a running workload keeps running while the other mode is used', async () => {
      await post('/api/workload', { mode: 'sample', action: 'start', rate: 30 });
      await sleep(900);
      const mid = await stateOf('sample');
      assert.equal(mid.workload.running, true, 'sample is running');

      // hammer the other mode
      for (let i = 0; i < 4; i++) await post('/api/step', { mode: 'live' });
      await post('/api/clear', { mode: 'live' });
      await sleep(600);

      const after = await stateOf('sample');
      assert.equal(after.workload.running, true, 'sample still running');
      assert.ok(after.cache.metrics.accesses > mid.cache.metrics.accesses,
        'sample kept making progress independently');

      await post('/api/workload', { mode: 'sample', action: 'stop' });
      assert.equal((await stateOf('sample')).workload.running, false, 'stop works');
    });

    await test('a real workload produces hits faster than misses', async () => {
      await post('/api/clear', { mode: 'sample' });
      await post('/api/workload', { mode: 'sample', action: 'start', rate: 40 });
      await sleep(3000);
      await post('/api/workload', { mode: 'sample', action: 'stop' });

      const m = (await stateOf('sample')).cache.metrics;
      assert.ok(m.accesses > 20, `enough traffic (${m.accesses})`);
      assert.ok(m.hits > 0, 'the cache actually helped');
      assert.ok(m.avgHitMs < m.avgMissMs / 5,
        `a hit (${m.avgHitMs.toFixed(2)}ms) must be far cheaper than a rebuild (${m.avgMissMs.toFixed(0)}ms)`);
      assert.equal(m.hits + m.misses, m.accesses, 'every access is one or the other');
    });

    await test('choosing a request pattern resets only that mode', async () => {
      await post('/api/step', { mode: 'live' });
      const before = await get('/api/state');
      assert.ok(before.modes.sample.cache.resident > 0);

      await post('/api/pattern', { mode: 'live', pattern: 'scan' });
      const after = await get('/api/state');

      assert.equal(after.modes.live.cache.resident, 0, 'live restarted clean');
      assert.equal(after.modes.live.workload.spec.pattern, 'scan');
      assert.equal(after.modes.sample.cache.resident, before.modes.sample.cache.resident,
        'sample untouched by the other mode’s pattern');
      assert.equal(after.modes.sample.workload.spec.pattern, null, 'sample keeps its own pattern');

      await post('/api/pattern', { mode: 'live', pattern: null });
    });

    await test('the scan pattern defeats the cache exactly as documented', async () => {
      await post('/api/config', { capacity: 6 });
      await post('/api/pattern', { mode: 'live', pattern: 'scan' });
      // serial requests over a key space wider than the cache
      await post('/api/workload', { mode: 'live', action: 'start', rate: 40, keyspace: 9, concurrency: 1 });
      await sleep(2600);
      await post('/api/workload', { mode: 'live', action: 'stop' });

      const m = (await stateOf('live')).cache.metrics;
      assert.ok(m.accesses > 12, `enough traffic (${m.accesses})`);
      assert.equal(m.hits, 0,
        `a scan wider than the cache must hit nothing, got ${m.hits}/${m.accesses}`);

      await post('/api/pattern', { mode: 'live', pattern: null });
    });

    await test('the stampede pattern merges duplicate requests instead of recomputing', async () => {
      await post('/api/config', { capacity: 8 });
      await post('/api/pattern', { mode: 'live', pattern: 'stampede' });

      const spec = (await stateOf('live')).workload.spec;
      assert.equal(spec.concurrency, 24, 'a stampede needs overlapping callers');
      assert.ok(spec.rate >= 60, 'and a rate high enough for them to overlap');

      await post('/api/workload', { mode: 'live', action: 'start' });
      await sleep(3500);
      await post('/api/workload', { mode: 'live', action: 'stop' });

      const m = (await stateOf('live')).cache.metrics;
      assert.ok(m.accesses > 60, `enough traffic (${m.accesses})`);
      assert.ok(m.coalesced > 5,
        `duplicate requests should be merged, got ${m.coalesced}`);
      assert.ok(m.coalesced > m.admissions,
        `more requests merged (${m.coalesced}) than pages rebuilt (${m.admissions})`);

      await post('/api/pattern', { mode: 'live', pattern: null });
    });

    await test('cache size applies to both modes so comparison stays fair', async () => {
      await post('/api/config', { capacity: 4 });
      const s = await get('/api/state');
      assert.equal(s.modes.sample.cache.config.capacity, 4);
      assert.equal(s.modes.live.cache.config.capacity, 4);
      assert.ok(s.modes.sample.cache.resident <= 4, 'shrunk immediately');
    });

    await test('thread count is shared and clamped to the real core count', async () => {
      await post('/api/config', { threads: 2 });
      let s = await get('/api/state');
      assert.equal(s.pool.size, 2);

      await post('/api/config', { threads: 9999 });
      s = await get('/api/state');
      assert.equal(s.pool.size, s.pool.maxSize, 'clamped to available cores');
      assert.ok(s.pool.maxSize <= os.cpus().length + 1);
      await post('/api/config', { threads: 4 });
    });

    await test('the live source describes this machine, or explains why not', async () => {
      const info = (await stateOf('live')).source;
      assert.equal(info.kind, 'live');
      if (info.available) {
        assert.ok(info.processes.length > 0, 'named some processes');
        assert.ok(info.via, 'recorded which probe worked');
        assert.ok(/machine/.test(info.detail), `detail reads sensibly: ${info.detail}`);
      } else {
        assert.ok(info.error, 'an unavailable process list must say so');
      }
    });

    await test('the sample source is deterministic and self-describing', async () => {
      const info = (await stateOf('sample')).source;
      assert.equal(info.kind, 'sample');
      assert.equal(info.distinctPages, 56, 'bundled trace is fixed');
      assert.ok(info.processes.length === 7);
      // never a real system-process name, or you cannot tell the modes apart
      const real = ['kernel_task', 'launchd', 'WindowServer', 'mds_stores', 'systemd', 'svchost'];
      for (const p of info.processes) {
        assert.ok(!real.includes(p.name), `${p.name} looks like a real system process`);
      }
    });

    await test('unknown endpoints 404 instead of hanging', async () => {
      const r = await fetch(`${BASE}/api/nope`, { method: 'POST', body: '{}' });
      assert.equal(r.status, 404);
    });

    await test('the event stream opens and pushes state', async () => {
      const ctl = new AbortController();
      const r = await fetch(`${BASE}/api/events`, { signal: ctl.signal });
      assert.equal(r.headers.get('content-type'), 'text/event-stream');

      const reader = r.body.getReader();
      const chunk = await reader.read();
      const text = new TextDecoder().decode(chunk.value);
      assert.ok(text.includes('event: state'), 'first frame carries state');
      ctl.abort();
    });

  } finally {
    child.kill('SIGKILL');
    await fsp.rm(store, { recursive: true, force: true });
  }

  console.log(log.join('\n'));
  console.log(`\n${passed} server tests passed\n`);
})();
