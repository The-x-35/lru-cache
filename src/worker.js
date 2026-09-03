'use strict';

/*
 * worker.js — runs on a real worker thread.
 *
 * Its whole job is to *materialize a page*: the expensive, CPU-bound work
 * that a cache miss forces you to redo. This is not a sleep() pretending to
 * be slow — it is a genuine key-derivation grind, so the numbers the UI
 * shows are measured CPU time and the thread really is blocked while it runs.
 *
 * Cost is split into chunks so the thread can report progress to the UI
 * without changing the total amount of work: each chunk feeds its output
 * into the next, which keeps the result deterministic for a given key.
 *
 * Determinism matters for a cache demo: the same key must always produce the
 * same page, otherwise "was that a hit?" is unanswerable.
 */

const { parentPort, workerData } = require('node:worker_threads');
const crypto = require('node:crypto');

const SALT = 'disk-lru-pagecache/v1';
const CHUNKS = 8;

/** Expand a 32-byte seed into `bytes` of deterministic page content.
 *  AES-CTR over zeros is hardware-accelerated, so the expansion stays
 *  negligible next to the derivation cost we actually want to measure. */
function expand(seed, bytes) {
  const iv = Buffer.alloc(16);
  seed.copy(iv, 0, 0, 16);
  const cipher = crypto.createCipheriv('aes-256-ctr', seed, iv);
  return Buffer.concat([cipher.update(Buffer.alloc(bytes)), cipher.final()]).subarray(0, bytes);
}

function materialize(key, iterations, pageSize, onProgress) {
  const per = Math.max(1, Math.floor(iterations / CHUNKS));
  let seed = Buffer.from(key, 'utf8');

  for (let i = 0; i < CHUNKS; i++) {
    // Chaining chunks preserves both the total cost and determinism.
    seed = crypto.pbkdf2Sync(seed, `${SALT}:${i}`, per, 32, 'sha256');
    onProgress((i + 1) / CHUNKS);
  }

  const page = expand(seed, pageSize);
  return { page, digest: crypto.createHash('sha256').update(page).digest('hex').slice(0, 16) };
}

parentPort.on('message', (msg) => {
  if (msg.type === 'shutdown') { process.exit(0); }
  if (msg.type !== 'materialize') return;

  const started = process.hrtime.bigint();
  let lastReport = 0;

  const { page, digest } = materialize(msg.key, msg.iterations, msg.pageSize, (frac) => {
    // Throttle progress chatter; the UI only needs a moving bar.
    const now = Number(process.hrtime.bigint() - started) / 1e6;
    if (now - lastReport > 12 || frac === 1) {
      lastReport = now;
      parentPort.postMessage({ type: 'progress', id: msg.id, frac });
    }
  });

  const computeMs = Number(process.hrtime.bigint() - started) / 1e6;

  // Hand the payload over by transfer, not by copy.
  const ab = page.buffer.slice(page.byteOffset, page.byteOffset + page.byteLength);
  parentPort.postMessage(
    { type: 'done', id: msg.id, key: msg.key, computeMs, digest, page: ab },
    [ab],
  );
});

parentPort.postMessage({ type: 'ready', threadId: workerData.threadId });
