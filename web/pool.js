'use strict';

// Wrapped so this file's top-level names stay private: these load as classic
// scripts sharing one global scope, and only the globalThis export below is
// meant to be visible to the others.
(function () {

/*
 * pool.js — a pool of real Web Workers with a job queue.
 *
 * The pool exists because rebuilding a page blocks a thread outright. With one
 * worker, concurrent misses serialise; with N, N proceed at once. That
 * relationship is why a miss is expensive in wall-clock and not just CPU, and
 * it is what the thread lanes in the UI are showing.
 *
 * The pool is deliberately dumb: it does not know what a cache is. It takes
 * "rebuild this key" jobs and reports when they finish. The cache decides
 * which keys ever get here — that is the cache's job.
 */

const WORKER_URL = './rebuild-worker.js';

class WorkerPool {
  constructor({ size, pageSize = 64 * 1024, faultCostMs = 90 } = {}) {
    this.maxSize = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
    this.pageSize = pageSize;
    this.faultCostMs = faultCostMs;
    this.itersPerMs = 3000;       // replaced by a real measurement in calibrate()

    this.workers = [];
    this.queue = [];
    this.jobs = new Map();
    this.nextId = 1;
    this.peakQueue = 0;
    this._rr = 0;

    this.resize(size || Math.min(4, this.maxSize));
  }

  get iterations() {
    return Math.max(1000, Math.round(this.faultCostMs * this.itersPerMs));
  }

  /* Measure this device's PBKDF2 throughput, so the UI can ask for a rebuild
     "costing ~90ms" and get it on a phone as well as a laptop. */
  async calibrate() {
    const probe = 30000;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode('calibration'), 'PBKDF2', false, ['deriveBits']);
    const t = performance.now();
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode('salt'), iterations: probe, hash: 'SHA-256' }, key, 256,
    );
    const ms = performance.now() - t;
    if (ms > 0.5) this.itersPerMs = Math.max(200, probe / ms);
    return this.itersPerMs;
  }

  // ------------------------------------------------------------------ sizing

  resize(size) {
    const target = Math.max(1, Math.min(this.maxSize, size | 0));
    while (this.workers.length < target) this._spawn();
    while (this.workers.length > target) {
      let i = this.workers.findIndex((w) => !w.busy);
      if (i === -1) i = this.workers.length - 1;
      const w = this.workers.splice(i, 1)[0];
      if (w.job) this.queue.unshift(w.job);   // never drop a request on the floor
      w.worker.terminate();
    }
    this._dispatch();
    return this.workers.length;
  }

  _spawn() {
    const slot = {
      id: this.workers.length, busy: false, job: null,
      progress: 0, startedAt: 0, completed: 0,
    };
    slot.worker = new Worker(WORKER_URL);
    slot.worker.onmessage = (ev) => this._onMessage(slot, ev.data);
    slot.worker.onerror = (err) => {
      if (slot.job) { slot.job.reject(err); this.jobs.delete(slot.job.id); }
      slot.busy = false; slot.job = null;
      this._dispatch();
    };
    this.workers.push(slot);
  }

  _onMessage(slot, msg) {
    if (msg.type === 'progress') {
      if (slot.job && slot.job.id === msg.id) slot.progress = msg.frac;
      return;
    }
    if (msg.type !== 'done') return;

    const job = this.jobs.get(msg.id);
    this.jobs.delete(msg.id);

    slot.busy = false;
    slot.job = null;
    slot.progress = 0;
    slot.completed += 1;

    if (job) {
      job.resolve({
        page: msg.page,
        computeMs: msg.computeMs,
        digest: msg.digest,
        thread: slot.id,
        queuedMs: job.startedAt - job.enqueuedAt,
      });
    }
    this._dispatch();
  }

  // ---------------------------------------------------------------- dispatch

  submit(key) {
    return new Promise((resolve, reject) => {
      const job = { id: this.nextId++, key, resolve, reject, enqueuedAt: performance.now(), startedAt: 0 };
      this.jobs.set(job.id, job);
      this.queue.push(job);
      this.peakQueue = Math.max(this.peakQueue, this.queue.length);
      this._dispatch();
    });
  }

  _dispatch() {
    // Start the scan at a rotating offset. Without this, a workload needing
    // less than one worker always lands on worker 0 and the pool looks broken
    // even though it is behaving correctly.
    const n = this.workers.length;
    for (let i = 0; i < n; i++) {
      const slot = this.workers[(this._rr + i) % n];
      if (slot.busy || this.queue.length === 0) continue;

      const job = this.queue.shift();
      job.startedAt = performance.now();
      this._rr = (slot.id + 1) % n;

      slot.busy = true;
      slot.job = job;
      slot.progress = 0;
      slot.startedAt = job.startedAt;

      slot.worker.postMessage({
        type: 'materialize', id: job.id, key: job.key,
        iterations: this.iterations, pageSize: this.pageSize,
      });
    }
  }

  snapshot() {
    return {
      size: this.workers.length,
      maxSize: this.maxSize,
      queueDepth: this.queue.length,
      peakQueue: this.peakQueue,
      faultCostMs: this.faultCostMs,
      iterations: this.iterations,
      threads: this.workers.map((w) => ({
        id: w.id,
        busy: w.busy,
        key: w.job ? w.job.key : null,
        progress: w.progress,
        elapsedMs: w.busy ? performance.now() - w.startedAt : 0,
        completed: w.completed,
      })),
    };
  }
}

globalThis.LRUPool = { WorkerPool };
}());
