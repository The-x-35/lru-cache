'use strict';

/*
 * lru.js — the algorithm, and nothing else.
 *
 * A textbook LRU index: a hash map for O(1) lookup, plus an intrusive
 * doubly linked list that maintains recency order.
 *
 *        head                                            tail
 *   (most recently used)                        (least recently used)
 *        [A] <-> [B] <-> [C] <-> [D] <-> [E] <-> [F]
 *         ^                                       ^
 *      promoted here                        evicted from here
 *
 * Every operation is O(1):
 *   - lookup      : Map.get
 *   - promote      : unlink node, push to head   (pointer surgery, no scan)
 *   - admit        : push to head, then trim tail while over budget
 *   - evict        : take this.tail
 *
 * The list is *intrusive*: the prev/next pointers live on the entry itself,
 * so promoting a node never allocates and never touches the map.
 *
 * This file deliberately knows nothing about disk, async, or bytes-on-media.
 * It only tracks a declared `bytes` cost per entry so it can enforce a byte
 * budget. Disk persistence lives in diskstore.js; the two are composed by
 * cache.js. Keeping the policy pure is what makes it testable.
 */

let SEQ = 0;

class Entry {
  constructor(key, bytes, meta) {
    this.key = key;
    this.bytes = bytes;
    this.meta = meta || {};

    this.seq = ++SEQ;          // insertion order (used by the FIFO shadow policy)
    this.hits = 0;             // times promoted since admission
    this.insertedAt = Date.now();
    this.usedAt = this.insertedAt;

    // intrusive list pointers
    this.prev = null;
    this.next = null;
  }

  toJSON() {
    return {
      key: this.key,
      bytes: this.bytes,
      hits: this.hits,
      insertedAt: this.insertedAt,
      usedAt: this.usedAt,
      seq: this.seq,
      meta: this.meta,
    };
  }
}

class LRUIndex {
  /**
   * @param {number} capacity  max number of entries  (the classic LRU bound)
   * @param {number} maxBytes  max total declared bytes (a second, independent bound)
   */
  constructor({ capacity = 8, maxBytes = Infinity } = {}) {
    this.capacity = Math.max(1, capacity | 0);
    this.maxBytes = maxBytes;

    this.map = new Map();   // key -> Entry
    this.head = null;       // MRU
    this.tail = null;       // LRU
    this.bytes = 0;
  }

  get size() { return this.map.size; }

  // ---------------------------------------------------------------- list ops

  /** Detach an entry from the list. O(1). */
  _unlink(e) {
    if (e.prev) e.prev.next = e.next;
    else this.head = e.next;          // e was the head

    if (e.next) e.next.prev = e.prev;
    else this.tail = e.prev;          // e was the tail

    e.prev = null;
    e.next = null;
  }

  /** Attach an entry at the head (MRU position). O(1). */
  _pushFront(e) {
    e.prev = null;
    e.next = this.head;
    if (this.head) this.head.prev = e;
    this.head = e;
    if (!this.tail) this.tail = e;    // list was empty
  }

  // ------------------------------------------------------------- public ops

  /** Look at an entry WITHOUT affecting recency. Used by the UI and tests. */
  peek(key) {
    return this.map.get(key) || null;
  }

  /**
   * Record a use of `key`: this is the "R" in LRU.
   * Promotes the entry to the head and returns it, or null on a miss. O(1).
   */
  touch(key) {
    const e = this.map.get(key);
    if (!e) return null;

    e.hits += 1;
    e.usedAt = Date.now();

    if (this.head !== e) {          // already MRU? nothing to do
      this._unlink(e);
      this._pushFront(e);
    }
    return e;
  }

  /**
   * Admit (or replace) `key` at the MRU position, then enforce the budget.
   * @returns {Entry[]} entries evicted to make room, in eviction order.
   */
  admit(key, bytes, meta) {
    let e = this.map.get(key);

    if (e) {
      // Replacing an existing entry: adjust the byte total by the delta.
      this.bytes += bytes - e.bytes;
      e.bytes = bytes;
      if (meta) e.meta = meta;
      e.usedAt = Date.now();
      this._unlink(e);
      this._pushFront(e);
    } else {
      e = new Entry(key, bytes, meta);
      this.map.set(key, e);
      this._pushFront(e);
      this.bytes += bytes;
    }

    return this.trim(key);
  }

  /**
   * Evict from the tail until we are inside both budgets.
   * `protectKey` is never chosen as a victim — without this, admitting an
   * entry larger than maxBytes would immediately evict the thing we just
   * inserted, and the caller would delete a file it still needs.
   * @returns {Entry[]}
   */
  trim(protectKey = null) {
    const evicted = [];

    while (this.map.size > this.capacity || this.bytes > this.maxBytes) {
      let victim = this.tail;
      if (victim && victim.key === protectKey) victim = victim.prev;
      if (!victim) break;   // only the protected entry is left; give up

      this._remove(victim);
      evicted.push(victim);
    }
    return evicted;
  }

  _remove(e) {
    this._unlink(e);
    this.map.delete(e.key);
    this.bytes -= e.bytes;
  }

  /** Explicit invalidation. Returns the removed entry or null. O(1). */
  delete(key) {
    const e = this.map.get(key);
    if (!e) return null;
    this._remove(e);
    return e;
  }

  clear() {
    this.map.clear();
    this.head = null;
    this.tail = null;
    this.bytes = 0;
  }

  /** Re-bound the cache at runtime; returns anything that had to go. */
  resize({ capacity, maxBytes }) {
    if (Number.isFinite(capacity)) this.capacity = Math.max(1, capacity | 0);
    if (Number.isFinite(maxBytes)) this.maxBytes = maxBytes;
    return this.trim();
  }

  /** Entries from MRU to LRU. O(n) — for display only, never on the hot path. */
  order() {
    const out = [];
    for (let e = this.head; e; e = e.next) out.push(e);
    return out;
  }

  keys() {
    return this.order().map((e) => e.key);
  }

  /** The next entry that would be evicted, without evicting it. */
  victimPreview() {
    return this.tail;
  }

  /**
   * Structural self-check. Cheap insurance that the pointer surgery above is
   * correct; called by the test suite after every mutation.
   * @returns {string[]} list of problems (empty means healthy)
   */
  validate() {
    const problems = [];
    let n = 0;
    let bytes = 0;
    let prev = null;

    for (let e = this.head; e; e = e.next) {
      if (++n > this.map.size + 1) { problems.push('list is cyclic or longer than map'); break; }
      if (e.prev !== prev) problems.push(`bad prev pointer at ${e.key}`);
      if (this.map.get(e.key) !== e) problems.push(`${e.key} in list but not in map`);
      bytes += e.bytes;
      prev = e;
    }

    if (n !== this.map.size) problems.push(`list length ${n} != map size ${this.map.size}`);
    if (prev !== this.tail) problems.push('tail pointer does not match last node');
    if (this.head && this.head.prev !== null) problems.push('head.prev is not null');
    if (bytes !== this.bytes) problems.push(`byte total ${this.bytes} != sum ${bytes}`);
    if (this.map.size > this.capacity) problems.push(`over capacity: ${this.map.size}/${this.capacity}`);

    return problems;
  }
}

// Usable from Node (require) and from a plain browser <script>. The browser
// build runs this exact file, so the deployed page and the test suite are
// exercising one implementation, not two that resemble each other.
if (typeof module === 'object' && module.exports) {
  module.exports = { LRUIndex, Entry };
} else {
  globalThis.LRUCore = { LRUIndex, Entry };
}
