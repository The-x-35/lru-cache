'use strict';

// Wrapped so this file's top-level names stay private: these load as classic
// scripts sharing one global scope, and only the globalThis export below is
// meant to be visible to the others.
(function () {

/*
 * store.js — the browser's stand-in for the disk.
 *
 * The server build writes one file per page under .pagecache/pages/. Here each
 * page is one IndexedDB record, which keeps the properties that matter:
 *
 *   - it is real storage, outside the JS heap, with a real size on the device
 *   - writes and deletes are transactional
 *   - it survives a reload, so "warm start" still means something
 *   - evicting a page really does reclaim the space
 *
 * Records are namespaced by mode, so the two modes never share storage — the
 * same separation the server gets from two directories.
 */

const DB_NAME = 'lru-pagecache';
const DB_VERSION = 1;
const PAGES = 'pages';
const META = 'meta';

const idOf = (mode, key) => mode + '::' + key;

class PageStore {
  constructor() {
    this.db = null;
    this.stats = { reads: 0, writes: 0, deletes: 0, bytesWritten: 0, bytesRead: 0 };
  }

  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PAGES)) {
          const s = db.createObjectStore(PAGES, { keyPath: 'id' });
          s.createIndex('mode', 'mode');
        }
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'mode' });
      };
      req.onsuccess = () => { this.db = req.result; resolve(this); };
      req.onerror = () => reject(req.error);
    });
  }

  _store(name, mode) {
    return this.db.transaction(name, mode).objectStore(name);
  }

  static _wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ------------------------------------------------------------ page records

  async writePage(mode, key, buf) {
    await PageStore._wrap(this._store(PAGES, 'readwrite').put({
      id: idOf(mode, key), mode, key, bytes: buf.byteLength, data: buf, at: Date.now(),
    }));
    this.stats.writes += 1;
    this.stats.bytesWritten += buf.byteLength;
    return buf.byteLength;
  }

  /** @returns {ArrayBuffer|null} null means the record is gone. */
  async readPage(mode, key) {
    const rec = await PageStore._wrap(this._store(PAGES, 'readonly').get(idOf(mode, key)));
    if (!rec) return null;
    this.stats.reads += 1;
    this.stats.bytesRead += rec.bytes;
    return rec.data;
  }

  async deletePage(mode, key) {
    await PageStore._wrap(this._store(PAGES, 'readwrite').delete(idOf(mode, key)));
    this.stats.deletes += 1;
  }

  /** Everything actually stored for one mode — the equivalent of readdir. */
  async list(mode) {
    const out = [];
    const idx = this._store(PAGES, 'readonly').index('mode');
    await new Promise((resolve, reject) => {
      const req = idx.openCursor(IDBKeyRange.only(mode));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve();
        out.push({ key: c.value.key, bytes: c.value.bytes, at: c.value.at });
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return out.sort((a, b) => b.at - a.at);
  }

  async clear(mode) {
    const files = await this.list(mode);
    for (const f of files) await this.deletePage(mode, f.key);
    await PageStore._wrap(this._store(META, 'readwrite').delete(mode));
  }

  // ------------------------------------------------------------------- index
  /* Recency order has to be persisted separately: IndexedDB can tell us which
     pages exist, never in what order they were last used. */

  async saveIndex(mode, entries, config) {
    await PageStore._wrap(this._store(META, 'readwrite').put({
      mode, savedAt: Date.now(), config,
      entries: entries.map((e) => ({
        key: e.key, bytes: e.bytes, hits: e.hits, insertedAt: e.insertedAt, usedAt: e.usedAt,
      })),
    }));
  }

  /**
   * Load the saved order and reconcile it against what is really stored.
   * Storage decides what exists; the index only decides order.
   */
  async loadIndex(mode) {
    const doc = await PageStore._wrap(this._store(META, 'readonly').get(mode));
    const present = new Map((await this.list(mode)).map((f) => [f.key, f]));

    if (!doc || !Array.isArray(doc.entries)) {
      // No saved order, but records may still exist — adopt them newest-first.
      const found = [...present.values()];
      return {
        entries: found.map((f) => ({
          key: f.key, bytes: f.bytes, hits: 0, insertedAt: f.at, usedAt: f.at,
        })),
        dropped: 0,
      };
    }

    const entries = [];
    let dropped = 0;
    const claimed = new Set();

    for (const e of doc.entries) {
      const f = present.get(e.key);
      if (!f || f.bytes !== e.bytes) { dropped += 1; continue; }
      claimed.add(e.key);
      entries.push(e);
    }

    // Records no surviving index entry points at are unreachable; drop them.
    for (const key of present.keys()) {
      if (!claimed.has(key)) { await this.deletePage(mode, key); dropped += 1; }
    }

    return { entries, dropped };
  }

  /** What the browser reports this origin is using overall. */
  static async quota() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      const { usage, quota } = await navigator.storage.estimate();
      return { usage, quota };
    } catch { return null; }
  }
}

globalThis.LRUStore = { PageStore };
}());
