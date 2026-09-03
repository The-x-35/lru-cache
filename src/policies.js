'use strict';

/*
 * policies.js — shadow simulators, so LRU can be judged against alternatives.
 *
 * These run alongside the real cache on the exact same access stream, but
 * they only track keys: no disk, no threads, no payloads. That makes them
 * nearly free, and it means every policy sees an identical trace, which is
 * the only fair way to compare hit rates.
 *
 * The point of showing these next to the real LRU:
 *   - FIFO   : same memory, no recency tracking. Shows what promotion buys.
 *   - MRU    : evicts the newest. Pathological on purpose — proves the demo
 *              is actually measuring policy and not just cache size.
 *   - RANDOM : the surprisingly-hard-to-beat baseline.
 *   - CLOCK  : what real kernels use — LRU's accuracy at FIFO's cost.
 *   - OPT    : Belady's optimal. Unimplementable online (it needs the
 *              future), computed offline from the recorded trace. It is the
 *              ceiling, so "LRU 72% / OPT 81%" tells you how much of the
 *              achievable benefit LRU actually captured.
 */

class Policy {
  constructor(name, capacity) {
    this.name = name;
    this.capacity = Math.max(1, capacity | 0);
    this.hits = 0;
    this.misses = 0;
  }
  get total() { return this.hits + this.misses; }
  get hitRate() { return this.total ? this.hits / this.total : 0; }
  resize(capacity) { this.capacity = Math.max(1, capacity | 0); this._trim(); }
  reset() { this.hits = 0; this.misses = 0; this._clear(); }
  _trim() {}
  _clear() {}
}

/** LRU via Map insertion order: delete+set moves a key to the newest slot.
 *  Same behaviour as lru.js — kept separate as an independent cross-check. */
class LRUPolicy extends Policy {
  constructor(capacity) { super('LRU', capacity); this.m = new Map(); }
  access(key) {
    if (this.m.has(key)) { this.m.delete(key); this.m.set(key, 1); this.hits++; return null; }
    this.misses++;
    this.m.set(key, 1);
    return this._trim();
  }
  _trim() {
    let victim = null;
    while (this.m.size > this.capacity) { victim = this.m.keys().next().value; this.m.delete(victim); }
    return victim;
  }
  _clear() { this.m.clear(); }
}

/** FIFO: insertion order only. A hit does not extend an entry's life. */
class FIFOPolicy extends Policy {
  constructor(capacity) { super('FIFO', capacity); this.m = new Map(); }
  access(key) {
    if (this.m.has(key)) { this.hits++; return null; }
    this.misses++;
    this.m.set(key, 1);
    return this._trim();
  }
  _trim() {
    let victim = null;
    while (this.m.size > this.capacity) { victim = this.m.keys().next().value; this.m.delete(victim); }
    return victim;
  }
  _clear() { this.m.clear(); }
}

/** MRU: evicts the most recently used. Included as a deliberate worst case. */
class MRUPolicy extends Policy {
  constructor(capacity) { super('MRU', capacity); this.stack = []; this.set = new Set(); }
  access(key) {
    if (this.set.has(key)) {
      this.hits++;
      this.stack.splice(this.stack.indexOf(key), 1);
      this.stack.push(key);
      return null;
    }
    this.misses++;
    if (this.set.size >= this.capacity) {
      const victim = this.stack.pop();
      this.set.delete(victim);
      this.stack.push(key); this.set.add(key);
      return victim;
    }
    this.stack.push(key); this.set.add(key);
    return null;
  }
  _trim() { while (this.set.size > this.capacity) { const v = this.stack.pop(); this.set.delete(v); } return null; }
  _clear() { this.stack.length = 0; this.set.clear(); }
}

/** RANDOM: evict a uniformly chosen resident. No metadata at all. */
class RandomPolicy extends Policy {
  constructor(capacity) { super('RANDOM', capacity); this.arr = []; this.set = new Set(); }
  access(key) {
    if (this.set.has(key)) { this.hits++; return null; }
    this.misses++;
    let victim = null;
    if (this.set.size >= this.capacity) {
      const i = Math.floor(Math.random() * this.arr.length);
      victim = this.arr[i];
      this.arr[i] = key;
      this.set.delete(victim);
      this.set.add(key);
      return victim;
    }
    this.arr.push(key); this.set.add(key);
    return null;
  }
  _trim() { while (this.arr.length > this.capacity) { const v = this.arr.pop(); this.set.delete(v); } return null; }
  _clear() { this.arr.length = 0; this.set.clear(); }
}

/** CLOCK (second chance): a circular buffer of frames with one reference bit
 *  each. A hit just sets the bit — O(1) and no list surgery, which is why
 *  kernels prefer it to true LRU. */
class ClockPolicy extends Policy {
  constructor(capacity) { super('CLOCK', capacity); this.frames = []; this.pos = new Map(); this.hand = 0; }
  access(key) {
    const at = this.pos.get(key);
    if (at !== undefined) { this.frames[at].ref = 1; this.hits++; return null; }
    this.misses++;

    if (this.frames.length < this.capacity) {
      this.pos.set(key, this.frames.length);
      this.frames.push({ key, ref: 1 });
      return null;
    }
    // Sweep for a frame whose reference bit is clear, clearing bits as we go.
    for (;;) {
      this.hand %= this.frames.length;
      const f = this.frames[this.hand];
      if (f.ref === 0) {
        const victim = f.key;
        this.pos.delete(victim);
        f.key = key; f.ref = 1;
        this.pos.set(key, this.hand);
        this.hand = (this.hand + 1) % this.frames.length;
        return victim;
      }
      f.ref = 0;
      this.hand = (this.hand + 1) % this.frames.length;
    }
  }
  _trim() {
    while (this.frames.length > this.capacity) { const f = this.frames.pop(); this.pos.delete(f.key); }
    this.pos.clear();
    this.frames.forEach((f, i) => this.pos.set(f.key, i));
    this.hand = 0;
    return null;
  }
  _clear() { this.frames.length = 0; this.pos.clear(); this.hand = 0; }
}

/**
 * Belady's OPT, computed offline: evict whichever resident page is needed
 * furthest in the future. Requires the full trace, so it can only ever be a
 * yardstick, never a real policy.
 */
function beladyOptimal(trace, capacity) {
  const cap = Math.max(1, capacity | 0);

  // nextUse[i] = index of the next occurrence of trace[i] after i, or Infinity.
  const lastSeen = new Map();
  const nextUse = new Array(trace.length).fill(Infinity);
  for (let i = trace.length - 1; i >= 0; i--) {
    const k = trace[i];
    nextUse[i] = lastSeen.has(k) ? lastSeen.get(k) : Infinity;
    lastSeen.set(k, i);
  }

  const resident = new Map();   // key -> next-use index
  let hits = 0;
  let misses = 0;

  for (let i = 0; i < trace.length; i++) {
    const k = trace[i];
    if (resident.has(k)) {
      hits++;
      resident.set(k, nextUse[i]);
      continue;
    }
    misses++;
    if (resident.size >= cap) {
      let victim = null;
      let furthest = -1;
      for (const [rk, nu] of resident) {
        if (nu > furthest) { furthest = nu; victim = rk; }
      }
      resident.delete(victim);
    }
    resident.set(k, nextUse[i]);
  }

  return { name: 'OPT', hits, misses, total: trace.length, hitRate: trace.length ? hits / trace.length : 0 };
}

function makeShadowSet(capacity) {
  return [
    new LRUPolicy(capacity),
    new ClockPolicy(capacity),
    new FIFOPolicy(capacity),
    new RandomPolicy(capacity),
    new MRUPolicy(capacity),
  ];
}

module.exports = { makeShadowSet, beladyOptimal, LRUPolicy, FIFOPolicy, MRUPolicy, RandomPolicy, ClockPolicy };
