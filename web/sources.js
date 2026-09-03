'use strict';

// Wrapped so this file's top-level names stay private: these load as classic
// scripts sharing one global scope, and only the globalThis export below is
// meant to be visible to the others.
(function () {

/*
 * sources.js — where the request stream comes from, in the browser.
 *
 *   sample   The bundled deterministic trace, loaded from src/sample-trace.js
 *            — literally the same file the Node server uses, so "identical on
 *            every machine" means the same bytes, not two implementations that
 *            happen to agree.
 *
 *   device   Real measurements from this browser. A page cannot read the
 *            operating system's process table — no browser gives you that — so
 *            instead of inventing one, this uses what the browser genuinely
 *            knows: the assets this page actually loaded, from the Performance
 *            API, weighted by their real transfer sizes. Heavier assets get
 *            requested more often, exactly as busier processes do in the
 *            self-hosted version.
 *
 * Both produce keys shaped `name[id]:0xNNN`, so the cache, the storage layer
 * and the UI treat them identically.
 */

const { SAMPLE_TRACE, SAMPLE_INFO } = globalThis.LRUSample;

const PAGES_PER_ITEM = 8;
const keyFor = (i) => 'page:0x' + Number(i).toString(16).padStart(3, '0');
const pageKey = (name, id, page) => name + '[' + id + ']:0x' + page.toString(16).padStart(3, '0');

// ------------------------------------------------------------- device source

function shortName(url) {
  try {
    const u = new URL(url, location.href);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return (last || u.hostname).slice(0, 24);
  } catch {
    return String(url).slice(0, 24);
  }
}

class DeviceSource {
  constructor() {
    this.items = [];
    this.error = null;
    this.available = null;
    this.seen = new Set();

    // Pick up anything loaded later, so the working set really does follow
    // what the browser is doing rather than a one-time snapshot.
    try {
      this._obs = new PerformanceObserver(() => this.refresh());
      this._obs.observe({ type: 'resource', buffered: true });
    } catch { /* older browsers: the initial scan still works */ }
  }

  refresh() {
    let entries = [];
    try {
      entries = [
        ...performance.getEntriesByType('navigation'),
        ...performance.getEntriesByType('resource'),
      ];
    } catch { entries = []; }

    const items = [];
    for (const e of entries) {
      const name = shortName(e.name);
      if (!name || this.seen.has(name + items.length)) continue;
      // Real bytes over the wire where the browser exposes it, else real time.
      const size = e.transferSize || e.encodedBodySize || e.decodedBodySize || 0;
      const weight = size > 0 ? size / 1024 : Math.max(0.5, e.duration || 0.5);
      items.push({ name, id: items.length + 1, size, ms: e.duration || 0, weight: weight + 0.3 });
    }

    if (items.length >= 3) {
      this.items = items.sort((a, b) => b.weight - a.weight);
      this.available = true;
      this.error = null;
    } else {
      this.available = false;
      this.error = 'This browser exposed too few timing entries to build a live working set. '
        + 'Showing the sample data instead.';
    }
    return this.items;
  }

  nextKey() {
    if (!this.items.length) this.refresh();
    if (!this.items.length) return SAMPLE_TRACE[Math.floor(Math.random() * SAMPLE_TRACE.length)];

    const total = this.items.reduce((s, p) => s + p.weight, 0);
    let r = Math.random() * total;
    const item = this.items.find((p) => (r -= p.weight) < 0) || this.items[0];

    // Locality within an asset: the first couple of pages dominate.
    const page = Math.random() < 0.7
      ? Math.floor(Math.random() * 2)
      : Math.floor(Math.random() * PAGES_PER_ITEM);
    return pageKey(item.name, item.id, page);
  }

  info() {
    const bits = [];
    if (navigator.hardwareConcurrency) bits.push(navigator.hardwareConcurrency + ' cores');
    if (navigator.deviceMemory) bits.push(navigator.deviceMemory + ' GB RAM');
    const kb = Math.round(this.items.reduce((s, i) => s + i.size, 0) / 1024);

    return {
      kind: 'device',
      available: this.available,
      error: this.error,
      detail: this.items.length
        ? this.items.length + ' assets this page really loaded'
          + (kb ? ', ' + kb + ' KB total' : '')
          + (bits.length ? ' · ' + bits.join(' · ') : '')
        : 'reading this browser’s timing data…',
      items: this.items.slice(0, 12),
    };
  }
}

// ------------------------------------------------------------------ workload

/*
 * Synthetic request patterns. A cache's hit rate is a property of the
 * workload, not of the cache: the same LRU goes from ~99% to 0% purely by
 * changing the order the keys arrive in.
 */
class Feed {
  constructor(cache, source) {
    this.cache = cache;
    this.source = source;         // 'sample' | 'device'
    this.device = null;           // set by the app for device mode
    this.pattern = null;
    this.running = false;
    this.cursor = 0;
    this.pending = 0;
    this.keyspace = 40;
    this._timer = null;
  }

  /* Concurrency and rate are properties of the pattern, not UI preferences:
   *  - stampede needs overlapping callers, and a rate high enough that they
   *    arrive while the page is still being rebuilt, or there is nothing to
   *    merge;
   *  - scan must be strictly serial, because its 0% result only holds for a
   *    serial order. With rebuilds in flight, pages are admitted in completion
   *    order and the pathological alignment breaks, lifting the rate off zero. */
  get concurrency() {
    if (this.pattern === 'stampede') return 16;
    if (this.pattern === 'scan') return 1;
    return 4;
  }

  get rate() {
    return this.pattern === 'stampede' ? 90 : 10;
  }

  nextKey() {
    const i = this.cursor++;
    const n = Math.max(1, this.keyspace);

    if (!this.pattern) {
      if (this.source === 'device' && this.device) return this.device.nextKey();
      return SAMPLE_TRACE[i % SAMPLE_TRACE.length];
    }

    switch (this.pattern) {
      case 'uniform': return keyFor(Math.floor(Math.random() * n));
      case 'hotset': {
        const hot = Math.max(1, Math.round(n * 0.2));
        return Math.random() < 0.8
          ? keyFor(Math.floor(Math.random() * hot))
          : keyFor(hot + Math.floor(Math.random() * Math.max(1, n - hot)));
      }
      case 'scan': return keyFor(i % n);
      case 'stampede': return keyFor(900 + Math.floor(i / (this.concurrency * 3)));
      default: return keyFor(Math.floor(Math.random() * n));
    }
  }

  start() {
    this.stop();
    this.running = true;

    const tickMs = 60;
    const perTick = Math.max(1, Math.round((this.rate * tickMs) / 1000));

    this._timer = setInterval(() => {
      if (!this.running) return;
      for (let i = 0; i < perTick; i++) {
        if (this.pending >= this.concurrency) break;   // backpressure
        this.pending += 1;
        this.cache.access(this.nextKey())
          .catch(() => { /* surfaced through the cache's counters */ })
          .finally(() => { this.pending -= 1; });
      }
    }, tickMs);
  }

  stop() {
    this.running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  step() {
    return this.cache.access(this.nextKey());
  }
}

globalThis.LRUFeed = { DeviceSource, Feed, SAMPLE_INFO, keyFor };
}());
