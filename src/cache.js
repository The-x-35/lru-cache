'use strict';

/*
 * cache.js — composes the pure LRU policy with the disk store and the
 * thread pool into the thing the demo actually exercises.
 *
 * The read path:
 *
 *   access(key)
 *     |
 *     +-- lru.touch(key) ---- present? --> read pages/<sha1>.page from disk
 *     |                                      |
 *     |                                      +-- file there  -> HIT   (~1ms)
 *     |                                      +-- file gone   -> fall through
 *     |                                          (index/disk divergence;
 *     |                                           counted as a "phantom")
 *     |
 *     +-- absent ---------------------> PAGE FAULT
 *                                        |
 *                                        +-- already being materialized?
 *                                        |     -> join that promise
 *                                        |        (coalesced; no duplicate CPU)
 *                                        |
 *                                        +-- pool.submit(key)   [worker thread]
 *                                            write page to disk (atomic)
 *                                            lru.admit(key, bytes)
 *                                            delete each evicted page file
 *
 * Two correctness points that a naive async cache gets wrong:
 *
 *  - Single-flight. Without the `inflight` map, N concurrent misses on the
 *    same key each burn a thread computing the identical page. This is the
 *    cache stampede, and it is the most common real bug in this shape of
 *    code. Coalesced requests are counted separately so the UI can show it.
 *
 *  - Eviction is not just a map delete. An entry leaving the LRU index must
 *    take its file with it, or the directory grows without bound and
 *    "capacity" becomes a lie. Every eviction here is followed by an unlink,
 *    and the UI lists the real directory so you can watch it hold the line.
 */

const { EventEmitter } = require('node:events');
const { LRUIndex } = require('./lru.js');
const { DiskStore, fileNameFor } = require('./diskstore.js');
const { makeShadowSet, beladyOptimal } = require('./policies.js');

const LAT_WINDOW = 300;    // latency samples kept per class
const TRACE_MAX = 20000;   // accesses retained for offline OPT
const LOG_MAX = 300;       // journal lines held in memory for the UI

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

class Ring {
  constructor(n) { this.n = n; this.a = []; }
  push(v) { this.a.push(v); if (this.a.length > this.n) this.a.shift(); }
  get length() { return this.a.length; }
  avg() { return this.a.length ? this.a.reduce((s, x) => s + x, 0) / this.a.length : 0; }
  pct(p) { return percentile([...this.a].sort((x, y) => x - y), p); }
  clear() { this.a.length = 0; }
}

class DiskLRUCache extends EventEmitter {
  constructor({ root, capacity = 12, maxBytes = Infinity, pool }) {
    super();
    this.lru = new LRUIndex({ capacity, maxBytes });
    this.disk = new DiskStore(root);
    this.pool = pool;

    this.inflight = new Map();     // key -> Promise (single-flight)
    this.shadows = makeShadowSet(capacity);
    this.trace = [];               // access history for OPT
    this.keyStats = new Map();     // key -> {accesses, hits, misses}
    this.log = [];                 // recent events for the UI
    this.logSeq = 0;

    this.metrics = this._freshMetrics();
    this.hitLat = new Ring(LAT_WINDOW);
    this.missLat = new Ring(LAT_WINDOW);
    this.computeMs = new Ring(LAT_WINDOW);
    this.timeline = [];            // one sample per second
    this._lastSample = { t: Date.now(), accesses: 0 };

    this.restoreReport = null;
    this.lastAccess = null;

    // Bumped by clear(). A page fault captures the generation it started in
    // and refuses to admit its result if the cache was emptied while it was
    // still computing — otherwise a fault dispatched just before a flush
    // lands just after it, quietly reviving a page that should be gone.
    this.generation = 0;
  }

  _freshMetrics() {
    return {
      accesses: 0, hits: 0, misses: 0, coalesced: 0,
      evictions: 0, phantoms: 0, admissions: 0,
      bytesEvicted: 0, cpuMsSpent: 0, startedAt: Date.now(),
    };
  }

  // ------------------------------------------------------------------ setup

  async init() {
    await this.disk.init();

    // Rebuild the recency list from the persisted index, MRU first. We admit
    // in reverse so each admit pushes to the head and the original order
    // comes out intact.
    const { entries, dropped, orphans, config } = await this.disk.loadIndex();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      const ent = this.lru.admit(e.key, e.bytes, e.meta);
      const node = this.lru.peek(e.key);
      if (node) {
        node.hits = e.hits || 0;
        node.insertedAt = e.insertedAt || Date.now();
        node.usedAt = e.usedAt || Date.now();
      }
      void ent;
    }

    this.restoreReport = {
      restored: this.lru.size,
      dropped: dropped.length,
      droppedDetail: dropped.slice(0, 8),
      orphansDeleted: orphans.length,
      savedConfig: config,
    };

    if (this.lru.size || dropped.length || orphans.length) {
      this._emit('RESTORE', `warm start: ${this.lru.size} pages recovered from disk` +
        (dropped.length ? `, ${dropped.length} dropped (stale index)` : '') +
        (orphans.length ? `, ${orphans.length} orphan files unlinked` : ''));
    } else {
      this._emit('RESTORE', 'cold start: empty page cache');
    }
    return this;
  }

  // ----------------------------------------------------------------- config

  async reconfigure({ capacity, maxBytes }) {
    const evicted = this.lru.resize({ capacity, maxBytes });
    for (const p of this.shadows) p.resize(this.lru.capacity);
    await this._reap(evicted, 'shrink');
    this._emit('CONFIG', `capacity=${this.lru.capacity} maxBytes=${
      Number.isFinite(this.lru.maxBytes) ? this.lru.maxBytes : 'unbounded'}`);
    await this._persist();
    return evicted.length;
  }

  // ------------------------------------------------------------- the hot path

  /**
   * Resolve a page, from cache if possible.
   * @returns {Promise<object>} outcome describing what the algorithm did
   */
  async access(key) {
    const t0 = process.hrtime.bigint();
    this.metrics.accesses += 1;

    // Feed the shadow simulators the same access, so comparisons are fair.
    this.trace.push(key);
    if (this.trace.length > TRACE_MAX) this.trace.shift();
    for (const p of this.shadows) p.access(key);

    const ks = this.keyStats.get(key) || { accesses: 0, hits: 0, misses: 0 };
    ks.accesses += 1;
    this.keyStats.set(key, ks);

    // ---- fast path: is it resident?
    const node = this.lru.touch(key);   // promotes to MRU on the spot
    if (node) {
      const posBefore = node.hits;
      const buf = await this.disk.readPage(key);
      if (buf) {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        this.metrics.hits += 1;
        ks.hits += 1;
        this.hitLat.push(ms);
        this._emit('HIT', `${key} promoted to MRU (${buf.length}B from disk in ${ms.toFixed(2)}ms)`);
        this.lastAccess = { key, hit: true, latencyMs: ms, at: Date.now() };
        return {
          key, hit: true, latencyMs: ms, bytes: buf.length,
          source: 'disk', promoted: true, hitsOnEntry: posBefore + 1,
          digest: node.meta && node.meta.digest,
        };
      }
      // Indexed but not on disk. Someone deleted the file underneath us.
      this.lru.delete(key);
      this.metrics.phantoms += 1;
      this._emit('PHANTOM', `${key} was indexed but the file is gone — reindexed as a fault`);
    }

    // ---- page fault
    return this._fault(key, t0, ks);
  }

  async _fault(key, t0, ks) {
    this.metrics.misses += 1;
    ks.misses += 1;

    // Single-flight: ride along with an in-progress materialization.
    const pending = this.inflight.get(key);
    if (pending) {
      this.metrics.coalesced += 1;
      this._emit('COALESCE', `${key} already being materialized — request joined, no extra CPU`);
      const shared = await pending;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      this.missLat.push(ms);
      return { ...shared, key, hit: false, coalesced: true, latencyMs: ms };
    }

    let evictedKeys = [];
    const bornIn = this.generation;
    const work = (async () => {
      this._emit('FAULT', `${key} not resident — dispatching to thread pool`);
      const res = await this.pool.submit(key);

      // The cache was emptied while this was computing. Serve the caller,
      // but do not resurrect the entry.
      if (this.generation !== bornIn) {
        this._emit('DISCARD', `${key} finished after a flush — result served but not cached`);
        return {
          bytes: res.page.length, source: 'computed', thread: res.thread,
          computeMs: res.computeMs, queuedMs: res.queuedMs,
          digest: res.digest, evicted: [], cached: false,
        };
      }

      const bytes = await this.disk.writePage(key, res.page);
      const evicted = this.lru.admit(key, bytes, { digest: res.digest, thread: res.thread });

      this.metrics.admissions += 1;
      this.metrics.cpuMsSpent += res.computeMs;
      this.computeMs.push(res.computeMs);
      this._emit('ADMIT', `${key} written to pages/${fileNameFor(key)} (${bytes}B) and inserted at MRU`);

      await this._reap(evicted, 'capacity');
      evictedKeys = evicted.map((e) => e.key);
      this._schedulePersist();

      return {
        bytes, source: 'computed', thread: res.thread,
        computeMs: res.computeMs, queuedMs: res.queuedMs,
        digest: res.digest, evicted: evicted.map((e) => e.key),
      };
    })();

    this.inflight.set(key, work);
    try {
      const out = await work;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      this.missLat.push(ms);
      this.lastAccess = {
        key, hit: false, latencyMs: ms, at: Date.now(),
        thread: out.thread, evicted: evictedKeys,
      };
      return { ...out, key, hit: false, coalesced: false, latencyMs: ms };
    } finally {
      this.inflight.delete(key);
    }
  }

  /** An eviction from the index must delete the page file too. */
  async _reap(evicted, reason) {
    for (const e of evicted) {
      await this.disk.deletePage(e.key);
      this.metrics.evictions += 1;
      this.metrics.bytesEvicted += e.bytes;
      this.disk.journal('EVICT', `${e.key} bytes=${e.bytes} hits=${e.hits} reason=${reason}`);
      this._emit('EVICT', `${key_desc(e)} evicted from LRU tail (${reason}) — page file unlinked`);
      this.emit('evicted', e);
    }
  }

  async invalidate(key) {
    const e = this.lru.delete(key);
    await this.disk.deletePage(key);
    this._emit('INVALIDATE', `${key} removed by hand${e ? '' : ' (was not resident)'}`);
    await this._persist();
    return !!e;
  }

  async clear() {
    this.generation += 1;      // invalidate every fault currently in flight
    this.lastAccess = null;    // nothing to narrate about an empty cache
    this.lru.clear();
    await this.disk.nuke();
    this.inflight.clear();
    this._emit('FLUSH', 'page cache dropped: index cleared and every page file unlinked');
    await this._persist();
  }

  resetMetrics() {
    this.metrics = this._freshMetrics();
    this.lastAccess = null;
    this.hitLat.clear(); this.missLat.clear(); this.computeMs.clear();
    this.trace.length = 0;
    this.keyStats.clear();
    this.timeline.length = 0;
    this.pool.peakQueue = 0;
    for (const p of this.shadows) p.reset();
    this._lastSample = { t: Date.now(), accesses: 0 };
    this._emit('RESET', 'counters cleared (cached pages left in place)');
  }

  // ------------------------------------------------------------- persistence

  _schedulePersist() {
    if (this._persistTimer) return;
    // Debounced: a burst of admissions writes one index snapshot, not fifty.
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persist().catch(() => {});
    }, 250);
    this._persistTimer.unref?.();
  }

  async _persist() {
    await this.disk.saveIndex(this.lru.order(), {
      capacity: this.lru.capacity,
      maxBytes: Number.isFinite(this.lru.maxBytes) ? this.lru.maxBytes : null,
      pageSize: this.pool.pageSize,
    });
  }

  // -------------------------------------------------------------- reporting

  _emit(op, detail) {
    const rec = { seq: ++this.logSeq, t: Date.now(), op, detail };
    this.log.push(rec);
    if (this.log.length > LOG_MAX) this.log.shift();
    this.disk.journal(op, detail);
    this.emit('journal', rec);
  }

  /** Sampled once a second by the server, to drive the sparkline. */
  sample() {
    const now = Date.now();
    const dt = (now - this._lastSample.t) / 1000;
    if (dt < 0.5) return;
    const delta = this.metrics.accesses - this._lastSample.accesses;
    this.timeline.push({
      t: now,
      hitRate: this.metrics.accesses ? this.metrics.hits / this.metrics.accesses : 0,
      throughput: delta / dt,
      resident: this.lru.size,
      bytes: this.lru.bytes,
    });
    if (this.timeline.length > 120) this.timeline.shift();
    this._lastSample = { t: now, accesses: this.metrics.accesses };
  }

  snapshot() {
    const m = this.metrics;
    const avgMiss = this.missLat.avg();
    const avgHit = this.hitLat.avg();
    const avgCompute = this.computeMs.avg();

    return {
      config: {
        capacity: this.lru.capacity,
        maxBytes: Number.isFinite(this.lru.maxBytes) ? this.lru.maxBytes : null,
        root: this.disk.root,
      },
      // MRU first — exactly the order the linked list is in.
      entries: this.lru.order().map((e, i) => ({
        ...e.toJSON(),
        rank: i,
        file: fileNameFor(e.key),
        isVictim: i === this.lru.size - 1,
        ageMs: Date.now() - e.insertedAt,
        idleMs: Date.now() - e.usedAt,
      })),
      resident: this.lru.size,
      bytes: this.lru.bytes,
      inflight: [...this.inflight.keys()],
      lastAccess: this.lastAccess,
      metrics: {
        ...m,
        hitRate: m.accesses ? m.hits / m.accesses : 0,
        missRate: m.accesses ? m.misses / m.accesses : 0,
        avgHitMs: avgHit,
        avgMissMs: avgMiss,
        p95HitMs: this.hitLat.pct(95),
        p95MissMs: this.missLat.pct(95),
        avgComputeMs: avgCompute,
        speedup: avgHit > 0 ? avgMiss / avgHit : 0,
        // What the cache bought us: every hit is one page fault not taken.
        cpuMsSaved: m.hits * avgCompute,
        uptimeMs: Date.now() - m.startedAt,
      },
      diskStats: this.disk.stats,
      shadows: this.shadows.map((p) => ({
        name: p.name, hits: p.hits, misses: p.misses, hitRate: p.hitRate,
      })),
      timeline: this.timeline,
      log: this.log.slice(-60),
      restoreReport: this.restoreReport,
      keyStats: [...this.keyStats.entries()]
        .map(([key, s]) => ({ key, ...s, resident: !!this.lru.peek(key) }))
        .sort((a, b) => b.accesses - a.accesses)
        .slice(0, 64),
    };
  }

  /** Offline optimum over the recorded trace — the ceiling LRU is chasing. */
  optimal() {
    return beladyOptimal(this.trace, this.lru.capacity);
  }

  async close() {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    await this._persist();
    await this.disk.close();
  }
}

function key_desc(e) {
  return `${e.key} (hits=${e.hits}, idle=${((Date.now() - e.usedAt) / 1000).toFixed(1)}s)`;
}

module.exports = { DiskLRUCache };
