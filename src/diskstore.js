'use strict';

/*
 * diskstore.js — the "on disk" half of the cache.
 *
 * Layout under the store root (default ./.pagecache):
 *
 *   .pagecache/
 *     pages/<sha1(key)>.page   one file per cached page (the payload)
 *     index.json               recency order + metadata, so the cache
 *                              survives a process restart
 *     journal.log              append-only human-readable event log
 *
 * Two details worth pointing at during a demo:
 *
 *  1. Writes are atomic: payload goes to `<name>.tmp` and is then renamed
 *     into place. rename(2) is atomic within a filesystem, so a crash
 *     mid-write can never leave a torn page that the index believes is good.
 *
 *  2. The index is a *snapshot*, and it is written the same atomic way. On
 *     load we reconcile it against what is actually on disk and drop any
 *     entry whose file is missing or the wrong size, then delete any orphan
 *     file the index does not mention. Disk is the source of truth for
 *     existence; the index is only the source of truth for *order*.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const INDEX_VERSION = 1;

function fileNameFor(key) {
  return crypto.createHash('sha1').update(key).digest('hex') + '.page';
}

class DiskStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.pagesDir = path.join(this.root, 'pages');
    this.indexPath = path.join(this.root, 'index.json');
    this.journalPath = path.join(this.root, 'journal.log');

    this.journalStream = null;
    this.stats = { writes: 0, reads: 0, deletes: 0, bytesWritten: 0, bytesRead: 0 };
  }

  async init() {
    await fsp.mkdir(this.pagesDir, { recursive: true });
    this.journalStream = fs.createWriteStream(this.journalPath, { flags: 'a' });
    return this;
  }

  pathFor(key) {
    return path.join(this.pagesDir, fileNameFor(key));
  }

  // ------------------------------------------------------------- page files

  /** Atomic write: tmp file + rename. Returns bytes written. */
  async writePage(key, buf) {
    const finalPath = this.pathFor(key);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    await fsp.writeFile(tmpPath, buf);
    await fsp.rename(tmpPath, finalPath);

    this.stats.writes += 1;
    this.stats.bytesWritten += buf.length;
    return buf.length;
  }

  /** Read a page. Returns a Buffer, or null if the file is gone. */
  async readPage(key) {
    try {
      const buf = await fsp.readFile(this.pathFor(key));
      this.stats.reads += 1;
      this.stats.bytesRead += buf.length;
      return buf;
    } catch (err) {
      if (err.code === 'ENOENT') return null;   // index thought it was here; it is not
      throw err;
    }
  }

  async deletePage(key) {
    try {
      await fsp.unlink(this.pathFor(key));
      this.stats.deletes += 1;
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  /** Real directory listing — this is what proves the cache is on disk. */
  async listPages() {
    let names;
    try {
      names = await fsp.readdir(this.pagesDir);
    } catch {
      return [];
    }

    const out = [];
    for (const name of names) {
      if (!name.endsWith('.page')) continue;
      try {
        const st = await fsp.stat(path.join(this.pagesDir, name));
        out.push({ file: name, bytes: st.size, mtime: st.mtimeMs });
      } catch { /* raced with an eviction; skip */ }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  async duBytes() {
    const files = await this.listPages();
    return files.reduce((n, f) => n + f.bytes, 0);
  }

  // ----------------------------------------------------------------- index

  /**
   * @param {Array} entries  MRU-first array of {key, bytes, hits, ...}
   */
  async saveIndex(entries, config) {
    const payload = JSON.stringify({
      version: INDEX_VERSION,
      savedAt: Date.now(),
      config,
      // MRU-first. Order is the whole point of persisting this.
      entries: entries.map((e) => ({
        key: e.key,
        file: fileNameFor(e.key),
        bytes: e.bytes,
        hits: e.hits,
        insertedAt: e.insertedAt,
        usedAt: e.usedAt,
        meta: e.meta,
      })),
    }, null, 2);

    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, payload);
    await fsp.rename(tmp, this.indexPath);
  }

  /**
   * Load the index and reconcile it with the filesystem.
   * @returns {{entries: Array, dropped: Array, orphans: string[], config: object|null}}
   */
  async loadIndex() {
    let doc;
    try {
      doc = JSON.parse(await fsp.readFile(this.indexPath, 'utf8'));
    } catch {
      return { entries: [], dropped: [], orphans: [], config: null };
    }
    if (!doc || doc.version !== INDEX_VERSION || !Array.isArray(doc.entries)) {
      return { entries: [], dropped: [], orphans: [], config: null };
    }

    const onDisk = new Map((await this.listPages()).map((f) => [f.file, f]));
    const entries = [];
    const dropped = [];
    const claimed = new Set();

    for (const e of doc.entries) {
      const f = onDisk.get(e.file);
      if (!f) { dropped.push({ ...e, reason: 'file missing' }); continue; }
      if (f.bytes !== e.bytes) { dropped.push({ ...e, reason: `size ${f.bytes} != indexed ${e.bytes}` }); continue; }
      claimed.add(e.file);
      entries.push(e);
    }

    // Files on disk that no surviving index entry points at are unreachable.
    const orphans = [...onDisk.keys()].filter((name) => !claimed.has(name));
    for (const name of orphans) {
      try { await fsp.unlink(path.join(this.pagesDir, name)); } catch { /* ignore */ }
    }

    return { entries, dropped, orphans, config: doc.config || null };
  }

  // --------------------------------------------------------------- journal

  journal(op, detail) {
    if (!this.journalStream) return;
    const line = `${new Date().toISOString()} ${op.padEnd(8)} ${detail}\n`;
    this.journalStream.write(line);
  }

  async tailJournal(lines = 40) {
    try {
      const text = await fsp.readFile(this.journalPath, 'utf8');
      const all = text.split('\n').filter(Boolean);
      return all.slice(-lines);
    } catch {
      return [];
    }
  }

  /** Wipe every page file, the index and the journal. */
  async nuke() {
    await fsp.rm(this.pagesDir, { recursive: true, force: true });
    await fsp.rm(this.indexPath, { force: true });
    await fsp.mkdir(this.pagesDir, { recursive: true });
    this.stats = { writes: 0, reads: 0, deletes: 0, bytesWritten: 0, bytesRead: 0 };
  }

  async close() {
    if (this.journalStream) {
      await new Promise((res) => this.journalStream.end(res));
      this.journalStream = null;
    }
  }
}

module.exports = { DiskStore, fileNameFor };
