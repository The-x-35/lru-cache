'use strict';

/* Correctness tests for the pure LRU index. Every mutation is followed by a
 * structural validate(), so a broken pointer fails here and not in the UI. */

const assert = require('node:assert/strict');
const { LRUIndex } = require('../src/lru.js');
const { LRUPolicy, FIFOPolicy, MRUPolicy, ClockPolicy, beladyOptimal } = require('../src/policies.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const healthy = (l) => assert.deepEqual(l.validate(), [], `structure: ${l.validate().join('; ')}`);

test('evicts the least recently used, not the oldest', () => {
  const l = new LRUIndex({ capacity: 3 });
  l.admit('a', 1); l.admit('b', 1); l.admit('c', 1);
  l.touch('a');                          // a is oldest by insertion, newest by use
  const ev = l.admit('d', 1);
  assert.deepEqual(ev.map((e) => e.key), ['b']);
  assert.deepEqual(l.keys(), ['d', 'a', 'c']);
  healthy(l);
});

test('touch on a miss returns null and changes nothing', () => {
  const l = new LRUIndex({ capacity: 2 });
  l.admit('a', 1); l.admit('b', 1);
  assert.equal(l.touch('zzz'), null);
  assert.deepEqual(l.keys(), ['b', 'a']);
  healthy(l);
});

test('touching the head is a no-op that keeps the list intact', () => {
  const l = new LRUIndex({ capacity: 3 });
  l.admit('a', 1); l.admit('b', 1);
  l.touch('b'); l.touch('b'); l.touch('b');
  assert.deepEqual(l.keys(), ['b', 'a']);
  assert.equal(l.peek('b').hits, 3);
  healthy(l);
});

test('touching the tail moves it to the head', () => {
  const l = new LRUIndex({ capacity: 3 });
  l.admit('a', 1); l.admit('b', 1); l.admit('c', 1);
  assert.equal(l.tail.key, 'a');
  l.touch('a');
  assert.equal(l.head.key, 'a');
  assert.equal(l.tail.key, 'b');
  healthy(l);
});

test('re-admitting an existing key replaces without growing', () => {
  const l = new LRUIndex({ capacity: 3 });
  l.admit('a', 10); l.admit('b', 10);
  const ev = l.admit('a', 25);
  assert.deepEqual(ev, []);
  assert.equal(l.size, 2);
  assert.equal(l.bytes, 35, 'byte total must follow the replacement delta');
  assert.deepEqual(l.keys(), ['a', 'b']);
  healthy(l);
});

test('byte budget evicts independently of entry count', () => {
  const l = new LRUIndex({ capacity: 100, maxBytes: 30 });
  l.admit('a', 10); l.admit('b', 10); l.admit('c', 10);
  assert.equal(l.size, 3);
  const ev = l.admit('d', 10);
  assert.deepEqual(ev.map((e) => e.key), ['a']);
  assert.equal(l.bytes, 30);
  healthy(l);
});

test('an entry larger than the whole budget is never self-evicted', () => {
  const l = new LRUIndex({ capacity: 5, maxBytes: 100 });
  l.admit('a', 10);
  const ev = l.admit('huge', 500);
  assert.deepEqual(ev.map((e) => e.key), ['a']);
  assert.ok(l.peek('huge'), 'the key just admitted must survive its own trim');
  assert.equal(l.size, 1);
});

test('single-entry cache degenerates correctly', () => {
  const l = new LRUIndex({ capacity: 1 });
  l.admit('a', 1);
  const ev = l.admit('b', 1);
  assert.deepEqual(ev.map((e) => e.key), ['a']);
  assert.deepEqual(l.keys(), ['b']);
  assert.equal(l.head, l.tail);
  healthy(l);
});

test('delete unlinks head, middle and tail', () => {
  for (const target of ['c', 'b', 'a']) {
    const l = new LRUIndex({ capacity: 3 });
    l.admit('a', 1); l.admit('b', 1); l.admit('c', 1);   // order: c b a
    l.delete(target);
    assert.equal(l.size, 2);
    assert.ok(!l.keys().includes(target));
    healthy(l);
  }
});

test('shrinking capacity evicts from the tail immediately', () => {
  const l = new LRUIndex({ capacity: 5 });
  for (const k of ['a', 'b', 'c', 'd', 'e']) l.admit(k, 1);   // order: e d c b a
  const ev = l.resize({ capacity: 2 });
  assert.deepEqual(ev.map((x) => x.key), ['a', 'b', 'c']);
  assert.deepEqual(l.keys(), ['e', 'd']);
  healthy(l);
});

test('clear resets list, map and byte total together', () => {
  const l = new LRUIndex({ capacity: 3 });
  l.admit('a', 5); l.admit('b', 5);
  l.clear();
  assert.equal(l.size, 0); assert.equal(l.bytes, 0);
  assert.equal(l.head, null); assert.equal(l.tail, null);
  healthy(l);
});

test('survives a randomized workload with the invariants held', () => {
  const l = new LRUIndex({ capacity: 7 });
  const ref = new Map();   // independent oracle: Map insertion order == LRU order
  for (let i = 0; i < 4000; i++) {
    const k = 'k' + Math.floor(Math.random() * 25);
    if (Math.random() < 0.5) {
      if (l.touch(k)) { ref.delete(k); ref.set(k, 1); }
    } else {
      l.admit(k, 1);
      ref.delete(k); ref.set(k, 1);
      while (ref.size > 7) ref.delete(ref.keys().next().value);
    }
    if (i % 250 === 0) healthy(l);
  }
  healthy(l);
  // The oracle is newest-last; our list is newest-first.
  assert.deepEqual(l.keys(), [...ref.keys()].reverse(), 'order diverged from the Map oracle');
});

test('scan one page larger than the cache hits nothing (LRU pathology)', () => {
  const l = new LRUIndex({ capacity: 4 });
  let hits = 0;
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 5; i++) {                 // keyspace 5, capacity 4
      const k = 'p' + i;
      if (l.touch(k)) hits++; else l.admit(k, 1);
    }
  }
  assert.equal(hits, 0, 'a scan just past capacity should defeat LRU entirely');

  // Same loop, one page smaller than the cache: nearly everything hits.
  const l2 = new LRUIndex({ capacity: 4 });
  let hits2 = 0;
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 3; i++) {
      const k = 'p' + i;
      if (l2.touch(k)) hits2++; else l2.admit(k, 1);
    }
  }
  assert.equal(hits2, 12, 'a scan inside capacity should hit after the first round');
});

test('reproduces the textbook reference string: LRU 10 faults, FIFO 9, OPT 7', () => {
  const trace = [1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5].map(String);

  const lru = new LRUPolicy(3);
  const fifo = new FIFOPolicy(3);
  for (const k of trace) { lru.access(k); fifo.access(k); }

  assert.equal(lru.misses, 10, 'LRU faults on the classic trace');
  assert.equal(fifo.misses, 9, "FIFO beats LRU here — that is Belady's anomaly");
  assert.equal(beladyOptimal(trace, 3).misses, 7, 'optimal faults');
});

test('the independent LRU implementations agree on a random trace', () => {
  // lru.js uses an explicit linked list; LRUPolicy uses Map insertion order.
  const l = new LRUIndex({ capacity: 6 });
  const sim = new LRUPolicy(6);
  let hits = 0;
  for (let i = 0; i < 3000; i++) {
    const k = 'k' + Math.floor(Math.random() * 20);
    sim.access(k);
    if (l.touch(k)) hits++; else l.admit(k, 1);
  }
  assert.equal(hits, sim.hits, 'two independent LRU implementations must agree exactly');
});

test('MRU evicts what it just touched', () => {
  const mru = new MRUPolicy(2);
  ['a', 'b', 'c', 'b'].forEach((k) => mru.access(k));
  assert.equal(mru.misses, 4, 'MRU evicts what it just used, so nothing survives');
});

test("CLOCK's reference bit saves a page that FIFO would evict", () => {
  // a b c fill the cache; d evicts a; b is then referenced; e needs a frame.
  // FIFO takes b next regardless. CLOCK finds b's reference bit set, clears
  // it, gives b a second chance and takes the unreferenced c instead.
  const trace = ['a', 'b', 'c', 'd', 'b', 'e'];
  const clock = new ClockPolicy(3);
  const fifo = new FIFOPolicy(3);
  for (const k of trace) { clock.access(k); fifo.access(k); }

  assert.ok(clock.pos.has('b'), 'CLOCK should have spared the referenced page');
  assert.ok(!fifo.m.has('b'), 'FIFO ignores the reference and evicts b');
  assert.ok(!clock.pos.has('c'), 'CLOCK took the unreferenced page instead');
});

console.log(`\n${passed} lru assertions passed\n`);
