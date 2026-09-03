'use strict';

/*
 * workload.js — access-pattern generators.
 *
 * A cache's hit rate is a property of the *workload*, not of the cache. The
 * same LRU implementation goes from 90% to 0% purely by changing what order
 * the keys arrive in, and these patterns are chosen to show that:
 *
 *   hotset     A small working set takes most of the traffic. LRU's best
 *              case: the hot pages stay pinned near the head forever.
 *
 *   zipf       Realistic skew (popularity ~ 1/rank). What real caches see.
 *
 *   uniform    Every page equally likely. Hit rate collapses to roughly
 *              capacity/keyspace, because recency carries no information.
 *
 *   scan       0,1,2,...,N-1 and repeat, with N > capacity. LRU's textbook
 *              pathology: it evicts pages in exactly the order they will
 *              next be needed, so a scan one page larger than the cache
 *              hits 0% while a scan one page smaller hits ~100%. This is
 *              the cliff that motivated ARC, 2Q and SLRU.
 *
 *   thrash     Two working sets, each nearly cache-sized, alternating.
 *              Neither ever gets to stay resident.
 *
 *   stampede   The same cold key requested by many callers at once. Tests
 *              single-flight, not the policy: without coalescing this melts
 *              the thread pool recomputing one identical page.
 *
 *   textbook   The classic 1 2 3 4 1 2 5 1 2 3 4 5 reference string. At
 *              capacity 3 it produces 10 LRU faults vs 9 FIFO and 7 optimal
 *              — Belady's anomaly, reproduced live.
 */

const { SAMPLE_TRACE, LiveSource } = require('./sources.js');

const TEXTBOOK = [1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5];

function keyFor(i) {
  return `page:0x${Number(i).toString(16).padStart(3, '0')}`;
}

function indexOfKey(key) {
  const m = /0x([0-9a-f]+)$/.exec(key);
  return m ? parseInt(m[1], 16) : -1;
}

/** Zipf CDF so sampling is O(log n) instead of O(n) per draw. */
function zipfCdf(n, alpha) {
  const cdf = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { sum += 1 / Math.pow(i + 1, alpha); cdf[i] = sum; }
  for (let i = 0; i < n; i++) cdf[i] /= sum;
  return cdf;
}

function sampleCdf(cdf) {
  const r = Math.random();
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < r) lo = mid + 1; else hi = mid;
  }
  return lo;
}

class WorkloadRunner {
  constructor(cache) {
    this.cache = cache;
    this.live = new LiveSource();
    this.running = false;
    this.spec = null;
    this.issued = 0;
    this.completed = 0;
    this.pending = 0;
    this.cursor = 0;
    this._timer = null;
    this._cdf = null;
    this.lastResults = [];
  }

  get status() {
    return {
      running: this.running,
      spec: this.spec,
      issued: this.issued,
      completed: this.completed,
      pending: this.pending,
    };
  }

  /**
   * @param {string} pattern  hotset|zipf|uniform|scan|thrash|stampede|textbook
   * @param {number} rate     target accesses per second
   * @param {number} keyspace number of distinct pages
   * @param {number} limit    stop after this many accesses (0 = unbounded)
   * @param {number} concurrency max simultaneous in-flight accesses
   */
  start({ source = 'sample', pattern = 'hotset', rate = 12, keyspace = 40,
          hotFraction = 0.2, alpha = 1.1, limit = 0, concurrency = 8 } = {}) {
    this.stop();

    this.spec = { source, pattern, rate, keyspace, hotFraction, alpha, limit, concurrency };

    if (source === 'live') {
      // Re-read the process table periodically so the stream follows what
      // the machine is really doing rather than a one-time snapshot.
      this.live.refresh();
      this._procTimer = setInterval(() => this.live.refresh(), 3000);
      this._procTimer.unref?.();
    }
    this.running = true;
    this.issued = 0;
    this.completed = 0;
    this.cursor = 0;
    this._cdf = pattern === 'zipf' ? zipfCdf(Math.max(1, keyspace), alpha) : null;

    // Fire in small batches so a 200/s rate does not need a 5ms timer.
    const tickMs = 50;
    const perTick = Math.max(1, Math.round((rate * tickMs) / 1000));

    this._timer = setInterval(() => {
      if (!this.running) return;
      for (let i = 0; i < perTick; i++) {
        if (this.spec.limit && this.issued >= this.spec.limit) { this.stop(); return; }
        if (this.pending >= this.spec.concurrency) break;   // backpressure
        this._issue();
      }
    }, tickMs);
    this._timer.unref?.();

    return this.status;
  }

  _issue() {
    const key = this.nextKey();
    this.issued += 1;
    this.pending += 1;

    this.cache.access(key)
      .then((r) => {
        this.lastResults.push(r);
        if (this.lastResults.length > 50) this.lastResults.shift();
      })
      .catch(() => { /* surfaced through cache metrics */ })
      .finally(() => { this.pending -= 1; this.completed += 1; });
  }

  nextKey() {
    const s = this.spec;
    const n = Math.max(1, s.keyspace);
    const i = this.cursor++;

    // The data source wins unless the user explicitly picked a synthetic
    // teaching pattern.
    if (s.source === 'sample') return SAMPLE_TRACE[i % SAMPLE_TRACE.length];
    if (s.source === 'live') return this.live.nextKey();

    switch (s.pattern) {
      case 'uniform':
        return keyFor(Math.floor(Math.random() * n));

      case 'hotset': {
        const hot = Math.max(1, Math.round(n * s.hotFraction));
        // 80/20: most traffic to the hot set, the rest scattered cold.
        return Math.random() < 0.8
          ? keyFor(Math.floor(Math.random() * hot))
          : keyFor(hot + Math.floor(Math.random() * Math.max(1, n - hot)));
      }

      case 'zipf':
        return keyFor(sampleCdf(this._cdf));

      case 'scan':
        return keyFor(i % n);

      case 'thrash': {
        // Alternate between two blocks, each about the size of the cache.
        const cap = this.cache.lru.capacity;
        const block = Math.max(1, cap);
        const setA = i % (block * 2) < block;
        const off = i % block;
        return keyFor(setA ? off : block + off);
      }

      case 'stampede':
        // One cold key, hammered. Rotates slowly so you can watch each
        // round: one fault, many coalesced riders.
        return keyFor(900 + Math.floor(i / Math.max(1, s.concurrency * 3)));

      case 'textbook':
        return keyFor(TEXTBOOK[i % TEXTBOOK.length]);

      default:
        return keyFor(Math.floor(Math.random() * n));
    }
  }

  stop() {
    this.running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._procTimer) { clearInterval(this._procTimer); this._procTimer = null; }
    return this.status;
  }
}

module.exports = { WorkloadRunner, keyFor, indexOfKey, TEXTBOOK };
