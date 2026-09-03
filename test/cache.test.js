'use strict';

/* Integration tests: real worker threads, real files, real eviction.
 * These are the claims the demo makes on screen, asserted. */

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { ThreadPool } = require('../src/pool.js');
const { DiskLRUCache } = require('../src/cache.js');

let passed = 0;
const results = [];

async function test(name, fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lru-test-'));
  const pool = new ThreadPool({ size: 3, pageSize: 4096, faultCostMs: 8 });
  try {
    await fn({ root, pool, make: async (opts = {}) => {
      const c = new DiskLRUCache({ root, pool, capacity: 4, ...opts });
      await c.init();
      return c;
    } });
    passed++; results.push(`  ok  ${name}`);
  } catch (e) {
    results.push(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  } finally {
    await pool.destroy();
    await fsp.rm(root, { recursive: true, force: true });
  }
}

const pageFiles = (root) =>
  fsp.readdir(path.join(root, 'pages')).then((f) => f.filter((n) => n.endsWith('.page'))).catch(() => []);

(async () => {

  await test('first access faults, second is a hit served from disk', async ({ make }) => {
    const c = await make();
    const miss = await c.access('page:1');
    assert.equal(miss.hit, false);
    assert.equal(miss.source, 'computed');
    assert.equal(miss.bytes, 4096);

    const hit = await c.access('page:1');
    assert.equal(hit.hit, true);
    assert.equal(hit.source, 'disk');
    assert.ok(hit.latencyMs < miss.latencyMs, 'a hit must be faster than the fault it avoided');
    await c.close();
  });

  await test('the same key always materializes to the same bytes', async ({ make }) => {
    const c = await make();
    const a = await c.access('page:deterministic');
    await c.invalidate('page:deterministic');
    const b = await c.access('page:deterministic');
    assert.equal(a.digest, b.digest, 'page content must be reproducible for a given key');
    await c.close();
  });

  await test('eviction deletes the page file, so the directory obeys capacity', async ({ root, make }) => {
    const c = await make({ capacity: 3 });
    for (let i = 0; i < 10; i++) await c.access(`page:${i}`);

    assert.equal(c.lru.size, 3, 'index holds capacity');
    const files = await pageFiles(root);
    assert.equal(files.length, 3, `disk holds capacity, found ${files.length} files`);
    assert.equal(c.metrics.evictions, 7);
    assert.deepEqual(c.lru.keys(), ['page:9', 'page:8', 'page:7']);
    await c.close();
  });

  await test('a hit protects an entry from the next eviction', async ({ make }) => {
    const c = await make({ capacity: 3 });
    await c.access('a'); await c.access('b'); await c.access('c');
    await c.access('a');                 // a becomes MRU; b is now the victim
    await c.access('d');
    assert.deepEqual(c.lru.keys(), ['d', 'a', 'c']);
    assert.ok(!c.lru.peek('b'), 'b was the least recently used and should be gone');
    await c.close();
  });

  await test('concurrent misses on one key are coalesced into a single fault', async ({ make }) => {
    const c = await make();
    const N = 12;
    const rs = await Promise.all(Array.from({ length: N }, () => c.access('page:hot')));

    assert.equal(rs.filter((r) => r.hit).length, 0, 'all N started cold');
    assert.equal(c.metrics.admissions, 1, 'exactly one page should have been computed');
    assert.equal(c.metrics.coalesced, N - 1, `${N - 1} requests should have ridden along`);
    assert.equal(new Set(rs.map((r) => r.digest)).size, 1, 'every caller gets the same page');
    await c.close();
  });

  await test('index and page files survive a restart, in recency order', async ({ root, pool, make }) => {
    const c1 = await make({ capacity: 4 });
    for (const k of ['w', 'x', 'y', 'z']) await c1.access(k);
    await c1.access('w');                        // w back to the head
    const orderBefore = c1.lru.keys();
    await c1.close();

    const c2 = new DiskLRUCache({ root, pool, capacity: 4 });
    await c2.init();
    assert.deepEqual(c2.lru.keys(), orderBefore, 'recency order must survive the restart');
    assert.equal(c2.restoreReport.restored, 4);

    const warm = await c2.access('w');
    assert.equal(warm.hit, true, 'a restored page should hit without recomputing');
    assert.equal(c2.metrics.misses, 0);
    await c2.close();
  });

  await test('a page file deleted behind the cache is detected, not served', async ({ root, make }) => {
    const c = await make();
    await c.access('page:fragile');
    await fsp.unlink(c.disk.pathFor('page:fragile'));      // simulate outside interference

    const r = await c.access('page:fragile');
    assert.equal(r.hit, false, 'a missing file must not be reported as a hit');
    assert.equal(c.metrics.phantoms, 1);
    assert.ok(await pageFiles(root).then((f) => f.length === 1), 'it should have been rewritten');
    await c.close();
  });

  await test('stale index entries and orphan files are reconciled on load', async ({ root, pool, make }) => {
    const c1 = await make({ capacity: 4 });
    for (const k of ['p', 'q'] ) await c1.access(k);
    await c1.close();

    // A crash can leave the index describing a file that is gone...
    await fsp.unlink(c1.disk.pathFor('p'));
    // ...and a file the index never got to mention.
    await fsp.writeFile(path.join(root, 'pages', 'deadbeef'.repeat(5) + '.page'), Buffer.alloc(4096));

    const c2 = new DiskLRUCache({ root, pool, capacity: 4 });
    await c2.init();
    assert.equal(c2.restoreReport.restored, 1, 'only q is usable');
    assert.equal(c2.restoreReport.dropped, 1, 'p must be dropped, its file is missing');
    assert.equal(c2.restoreReport.orphansDeleted, 1, 'the unreferenced file must be unlinked');
    assert.deepEqual(await pageFiles(root), [c2.disk.pathFor('q').split('/').pop()]);
    await c2.close();
  });

  await test('shrinking capacity at runtime reclaims disk immediately', async ({ root, make }) => {
    const c = await make({ capacity: 8 });
    for (let i = 0; i < 8; i++) await c.access(`page:${i}`);
    assert.equal((await pageFiles(root)).length, 8);

    await c.reconfigure({ capacity: 3 });
    assert.equal(c.lru.size, 3);
    assert.equal((await pageFiles(root)).length, 3, 'evicted files must be gone from disk');
    await c.close();
  });

  await test('flush empties both the index and the directory', async ({ root, make }) => {
    const c = await make();
    for (let i = 0; i < 4; i++) await c.access(`page:${i}`);
    await c.clear();
    assert.equal(c.lru.size, 0);
    assert.equal((await pageFiles(root)).length, 0);
    await c.close();
  });

  await test('a flush cancels the faults already in flight', async ({ root, make }) => {
    const c = await make({ capacity: 4 });

    // Start a fault, then empty the cache before it can finish.
    const inflight = c.access('page:racy');
    await new Promise((r) => setTimeout(r, 1));
    await c.clear();

    const r = await inflight;
    assert.equal(r.hit, false);
    assert.equal(r.cached, false, 'a fault that lands after a flush must not insert itself');
    assert.ok(r.bytes > 0, 'the caller is still served its page');

    assert.equal(c.lru.size, 0, 'the cache must stay empty');
    assert.equal((await pageFiles(root)).length, 0, 'and nothing may be written to disk');
    await c.close();
  });

  await test('an emptied cache reports nothing about its last access', async ({ make }) => {
    const c = await make();
    await c.access('page:1');
    assert.ok(c.lastAccess, 'an access is recorded');

    await c.clear();
    assert.equal(c.lastAccess, null, 'an empty cache must not describe a page it no longer holds');

    await c.access('page:2');
    c.resetMetrics();
    assert.equal(c.lastAccess, null, 'resetting counters clears it too');
    await c.close();
  });

  await test('hit rate and cpu-saved accounting add up', async ({ make }) => {
    const c = await make({ capacity: 2 });
    for (const k of ['a', 'b', 'a', 'b', 'a', 'c', 'a']) await c.access(k);

    const m = c.snapshot().metrics;
    assert.equal(m.accesses, 7);
    assert.equal(m.hits + m.misses, m.accesses, 'every access is exactly one of hit or miss');
    assert.ok(Math.abs(m.hitRate - m.hits / m.accesses) < 1e-9);
    assert.ok(m.cpuMsSaved > 0, 'hits should register avoided CPU');
    assert.equal(c.shadows.find((s) => s.name === 'LRU').hits, m.hits,
      'the shadow LRU must agree with the real cache it mirrors');
    await c.close();
  });

  console.log(results.join('\n'));
  console.log(`\n${passed} cache integration tests passed\n`);
})();
