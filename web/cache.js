'use strict';

// Wrapped so this file's top-level names stay private: these load as classic
// scripts sharing one global scope, and only the globalThis export below is
// meant to be visible to the others.
(function () {

/*
 * cache.js — composes the LRU policy with browser storage and the worker pool.
 *
 * This is the browser counterpart of the server's src/cache.js, and it uses
 * the *same* policy object: src/lru.js is loaded verbatim, so the deployed
 * page runs the implementation the test suite covers.
 *
 * The read path:
 *
 *   access(key)
 *     |
 *     +-- lru.touch(key) --- present? --> read the record from IndexedDB
 *     |                                     |
 *     |                                     +-- found   -> HIT
 *     |                                     +-- missing -> fall through
 *     |                                         (counted as a "phantom")
 *     |
 *     +-- absent --------------------> REBUILD
 *                                       |
 *                                       +-- already being rebuilt?
 *                                       |     -> join that promise
 *                                       |        (merged; no duplicate CPU)
 *                                       |
 *                                       +-- pool.submit(key)   [worker thread]
 *                                           write the record
 *                                           lru.admit(key, bytes)
 *                                           delete each evicted record
 *
 * The two guards worth pointing at, both of which exist because the server
 * version was wrong without them:
 *
 *  - Single-flight. Without `inflight`, N concurrent misses on one key each
 *    burn a worker computing identical bytes. This is the cache stampede.
 *  - A generation counter. Emptying the cache must cancel the rebuilds already
 *    running, or one dispatched just before the flush lands just after it and
 *    quietly revives a page that should be gone.
 */

const { LRUIndex } = globalThis.LRUCore;
const { makeShadowSet } = globalThis.LRUPolicies;

const LAT_WINDOW = 300;

class Ring {
  constructor(n) { this.n = n; this.a = []; }
  push(v) { this.a.push(v); if (this.a.length > this.n) this.a.shift(); }
  avg() { return this.a.length ? this.a.reduce((s, x) => s + x, 0) / this.a.length : 0; }
  pct(p) {
    if (!this.a.length) return 0;
    const s = [...this.a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  }
  clear() { this.a.length = 0; }
}

class BrowserLRUCache {
  constructor({ mode, store, pool, capacity = 12 }) {
    this.mode = mode;
    this.store = store;
    this.pool = pool;
    this.lru = new LRUIndex({ capacity });

    this.inflight = new Map();
    this.shadows = makeShadowSet(capacity);
    this.generation = 0;
    this.lastAccess = null;
    this.restored = 0;

    this.metrics = this._fresh();
    this.hitLat = new Ring(LAT_WINDOW);
    this.missLat = new Ring(LAT_WINDOW);
    this.computeMs = new Ring(LAT_WINDOW);
  }

  _fresh() {
    return {
      accesses: 0, hits: 0, misses: 0, coalesced: 0,
      evictions: 0, phantoms: 0, admissions: 0, startedAt: Date.now(),
    };
  }

  /** Rebuild the recency list from whatever survived in storage. */
  async init() {
    const { entries, dropped } = await this.store.loadIndex(this.mode);
    // Admit in reverse so each admit pushes to the head and the saved order
    // comes back intact.
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      this.lru.admit(e.key, e.bytes, {});
      const node = this.lru.peek(e.key);
      if (node) {
        node.hits = e.hits || 0;
        node.insertedAt = e.insertedAt || Date.now();
        node.usedAt = e.usedAt || Date.now();
      }
    }
    this.restored = this.lru.size;
    this.droppedOnLoad = dropped;
    return this;
  }

  async reconfigure(capacity) {
    const evicted = this.lru.resize({ capacity });
    for (const p of this.shadows) p.resize(this.lru.capacity);
    await this._reap(evicted);
    await this._persist();
  }

  // -------------------------------------------------------------- hot path

  async access(key) {
    const t0 = performance.now();
    this.metrics.accesses += 1;
    for (const p of this.shadows) p.access(key);

    const node = this.lru.touch(key);      // promotes to MRU on the spot
    if (node) {
      const buf = await this.store.readPage(this.mode, key);
      if (buf) {
        const ms = performance.now() - t0;
        this.metrics.hits += 1;
        this.hitLat.push(ms);
        this.lastAccess = { key, hit: true, latencyMs: ms };
        return { key, hit: true, latencyMs: ms, bytes: buf.byteLength };
      }
      // Indexed but not stored — someone cleared site data underneath us.
      this.lru.delete(key);
      this.metrics.phantoms += 1;
    }

    return this._rebuild(key, t0);
  }

  async _rebuild(key, t0) {
    this.metrics.misses += 1;

    const pending = this.inflight.get(key);
    if (pending) {
      this.metrics.coalesced += 1;
      const shared = await pending;
      const ms = performance.now() - t0;
      this.missLat.push(ms);
      this.lastAccess = { key, hit: false, latencyMs: ms, merged: true, evicted: [] };
      return { ...shared, key, hit: false, coalesced: true, latencyMs: ms };
    }

    const bornIn = this.generation;
    const work = (async () => {
      const res = await this.pool.submit(key);

      // The cache was emptied while this was rebuilding. Serve the caller,
      // but do not resurrect the entry.
      if (this.generation !== bornIn) {
        return { bytes: res.page.byteLength, thread: res.thread, computeMs: res.computeMs, evicted: [], cached: false };
      }

      const bytes = await this.store.writePage(this.mode, key, res.page);
      const evicted = this.lru.admit(key, bytes, { digest: res.digest });

      this.metrics.admissions += 1;
      this.computeMs.push(res.computeMs);
      await this._reap(evicted);
      this._schedulePersist();

      return {
        bytes, thread: res.thread, computeMs: res.computeMs,
        digest: res.digest, evicted: evicted.map((e) => e.key), cached: true,
      };
    })();

    this.inflight.set(key, work);
    try {
      const out = await work;
      const ms = performance.now() - t0;
      this.missLat.push(ms);
      this.lastAccess = { key, hit: false, latencyMs: ms, thread: out.thread, evicted: out.evicted };
      return { ...out, key, hit: false, coalesced: false, latencyMs: ms };
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Eviction from the index must take the stored record with it. */
  async _reap(evicted) {
    for (const e of evicted) {
      await this.store.deletePage(this.mode, e.key);
      this.metrics.evictions += 1;
    }
  }

  async clear() {
    this.generation += 1;        // cancel every rebuild currently in flight
    this.lastAccess = null;      // nothing to narrate about an empty cache
    this.lru.clear();
    this.inflight.clear();
    await this.store.clear(this.mode);
  }

  resetMetrics() {
    this.metrics = this._fresh();
    this.lastAccess = null;
    this.hitLat.clear();
    this.missLat.clear();
    this.computeMs.clear();
    this.pool.peakQueue = 0;
    for (const p of this.shadows) p.reset();
  }

  _schedulePersist() {
    if (this._timer) return;
    // Debounced: a burst of admissions writes one index snapshot, not fifty.
    this._timer = setTimeout(() => { this._timer = null; this._persist(); }, 250);
  }

  _persist() {
    return this.store.saveIndex(this.mode, this.lru.order(), { capacity: this.lru.capacity })
      .catch(() => { /* storage may be full or blocked; the cache still works */ });
  }

  snapshot() {
    const m = this.metrics;
    const avgHit = this.hitLat.avg();
    const avgMiss = this.missLat.avg();
    const avgCompute = this.computeMs.avg();

    return {
      config: { capacity: this.lru.capacity },
      entries: this.lru.order().map((e, i) => ({
        key: e.key, bytes: e.bytes, hits: e.hits, rank: i,
        idleMs: Date.now() - e.usedAt,
      })),
      resident: this.lru.size,
      bytes: this.lru.bytes,
      lastAccess: this.lastAccess,
      metrics: {
        ...m,
        hitRate: m.accesses ? m.hits / m.accesses : 0,
        avgHitMs: avgHit,
        avgMissMs: avgMiss,
        p95HitMs: this.hitLat.pct(95),
        p95MissMs: this.missLat.pct(95),
        avgComputeMs: avgCompute,
        speedup: avgHit > 0 ? avgMiss / avgHit : 0,
        cpuMsSaved: m.hits * avgCompute,
      },
      shadows: this.shadows.map((p) => ({ name: p.name, hits: p.hits, misses: p.misses, hitRate: p.hitRate })),
      storeStats: this.store.stats,
    };
  }
}

globalThis.LRUBrowserCache = { BrowserLRUCache };
}());
