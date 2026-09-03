'use strict';

/*
 * pool.js — a real worker_threads pool with a task queue.
 *
 * The pool exists because materializing a page blocks a thread outright.
 * With one thread, concurrent misses serialize; with N threads, N misses
 * proceed at once and the queue drains N times faster. That relationship is
 * the reason a cache miss is expensive in *wall clock* and not just CPU, and
 * it is what the thread-lane view in the UI is showing.
 *
 * The pool is deliberately dumb: it does not know what a cache is. It takes
 * "materialize this key" jobs and reports when they finish. cache.js decides
 * which keys ever get here — that is the cache's job.
 */

const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const WORKER_PATH = path.join(__dirname, 'worker.js');

/** Measure this machine's pbkdf2 throughput so the UI can ask for a page
 *  fault "costing ~90ms" instead of an opaque iteration count. */
function calibrate() {
  const probe = 40000;
  const t = process.hrtime.bigint();
  crypto.pbkdf2Sync('calibration-probe', 'salt', probe, 32, 'sha256');
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  return Math.max(1000, probe / ms); // iterations per millisecond
}

class ThreadPool extends EventEmitter {
  constructor({ size = 4, pageSize = 64 * 1024, faultCostMs = 90 } = {}) {
    super();
    this.maxSize = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
    this.pageSize = pageSize;
    this.faultCostMs = faultCostMs;
    this.itersPerMs = calibrate();

    this.workers = [];      // { id, worker, busy, job, progress, startedAt, completed, busyMs }
    this.queue = [];        // pending jobs
    this.jobs = new Map();  // id -> job
    this.nextJobId = 1;
    this.peakQueue = 0;
    this._rr = 0;   // round-robin cursor, so light load does not pile onto thread 0

    this.resize(size);
  }

  get iterations() {
    return Math.max(1, Math.round(this.faultCostMs * this.itersPerMs));
  }

  // ------------------------------------------------------------------ sizing

  resize(size) {
    const target = Math.max(1, Math.min(this.maxSize, size | 0));
    while (this.workers.length < target) this._spawn();
    while (this.workers.length > target) {
      // Retire an idle worker if we can; otherwise the newest busy one, whose
      // job is requeued so no request is dropped on the floor.
      let i = this.workers.findIndex((w) => !w.busy);
      if (i === -1) i = this.workers.length - 1;
      const w = this.workers.splice(i, 1)[0];
      if (w.job) this.queue.unshift(w.job);
      try { w.worker.postMessage({ type: 'shutdown' }); } catch { /* already gone */ }
      w.worker.terminate();
    }
    this._dispatch();
    return this.workers.length;
  }

  _spawn() {
    const id = this.workers.length;
    const worker = new Worker(WORKER_PATH, { workerData: { threadId: id } });
    const slot = { id, worker, busy: false, job: null, progress: 0, startedAt: 0, completed: 0, busyMs: 0 };

    worker.on('message', (msg) => this._onMessage(slot, msg));
    worker.on('error', (err) => {
      // A dead thread must not swallow its job.
      if (slot.job) { slot.job.reject(err); this.jobs.delete(slot.job.id); }
      slot.busy = false; slot.job = null;
      try { slot.worker.unref(); } catch { /* already gone */ }
      this.emit('error', err);
    });
    // Idle threads must not hold the process open; busy ones must. We
    // ref/unref around each job rather than leaving workers permanently
    // unref'd, which would let node exit with jobs still in flight.
    worker.unref();

    this.workers.push(slot);
    return slot;
  }

  _onMessage(slot, msg) {
    if (msg.type === 'progress') {
      if (slot.job && slot.job.id === msg.id) {
        slot.progress = msg.frac;
        this.emit('progress', { thread: slot.id, key: slot.job.key, frac: msg.frac });
      }
      return;
    }
    if (msg.type !== 'done') return;

    const job = this.jobs.get(msg.id);
    this.jobs.delete(msg.id);

    slot.busy = false;
    slot.job = null;
    slot.progress = 0;
    slot.completed += 1;
    slot.worker.unref();
    slot.busyMs += Date.now() - slot.startedAt;

    if (job) {
      job.resolve({
        page: Buffer.from(msg.page),
        computeMs: msg.computeMs,
        digest: msg.digest,
        thread: slot.id,
        queuedMs: job.startedAt - job.enqueuedAt,
      });
    }

    this.emit('completed', { thread: slot.id, key: msg.key, computeMs: msg.computeMs });
    this._dispatch();
  }

  // ---------------------------------------------------------------- dispatch

  /** Queue a page materialization. Resolves with the page buffer. */
  submit(key) {
    return new Promise((resolve, reject) => {
      const job = {
        id: this.nextJobId++,
        key,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        startedAt: 0,
      };
      this.jobs.set(job.id, job);
      this.queue.push(job);
      this.peakQueue = Math.max(this.peakQueue, this.queue.length);
      this._dispatch();
    });
  }

  _dispatch() {
    // Start the scan at a rotating offset. Without this, a workload whose
    // fault rate needs less than one thread would always land on worker 0
    // and the pool would look broken even though it is behaving correctly.
    const n = this.workers.length;
    for (let i = 0; i < n; i++) {
      const slot = this.workers[(this._rr + i) % n];
      if (slot.busy || this.queue.length === 0) continue;
      this._rr = (this.workers.indexOf(slot) + 1) % n;

      const job = this.queue.shift();
      job.startedAt = Date.now();

      slot.busy = true;
      slot.job = job;
      slot.progress = 0;
      slot.startedAt = job.startedAt;
      slot.worker.ref();

      slot.worker.postMessage({
        type: 'materialize',
        id: job.id,
        key: job.key,
        iterations: this.iterations,
        pageSize: this.pageSize,
      });

      this.emit('started', { thread: slot.id, key: job.key });
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
      itersPerMs: Math.round(this.itersPerMs),
      pageSize: this.pageSize,
      threads: this.workers.map((w) => ({
        id: w.id,
        busy: w.busy,
        key: w.job ? w.job.key : null,
        progress: w.progress,
        elapsedMs: w.busy ? Date.now() - w.startedAt : 0,
        completed: w.completed,
        busyMs: w.busyMs,
      })),
      queue: this.queue.slice(0, 12).map((j) => j.key),
    };
  }

  async destroy() {
    this.queue.length = 0;
    await Promise.all(this.workers.map((w) => w.worker.terminate()));
    this.workers.length = 0;
  }
}

module.exports = { ThreadPool, calibrate };
