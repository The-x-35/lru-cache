'use strict';

/*
 * rebuild-worker.js — runs on a real Web Worker thread.
 *
 * Its job is the expensive part of a cache miss: materialising a page. This is
 * genuine PBKDF2 key derivation through WebCrypto, not a setTimeout pretending
 * to be slow — the worker really is busy, and the timings the UI shows are
 * measured. Which is the whole point: a demo that fakes the cost of a miss
 * cannot honestly show you what the cache is worth.
 *
 * Cost is split into chunks so progress can be reported without changing the
 * total work: each chunk's output seeds the next, which keeps the result
 * deterministic for a given key. Determinism matters — the same key must
 * always produce the same page, or "was that a hit?" is unanswerable.
 */

const SALT = 'lru-cache-demo/v1';
const CHUNKS = 8;
const enc = new TextEncoder();

async function deriveChunk(seedBytes, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', seedBytes, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/* Expand a 32-byte seed into `bytes` of page content. AES-CTR is hardware
   accelerated, so expansion stays negligible next to the derivation we
   actually want to measure. */
async function expand(seed, bytes) {
  const key = await crypto.subtle.importKey('raw', seed, 'AES-CTR', false, ['encrypt']);
  const out = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: seed.slice(0, 16), length: 64 },
    key,
    new Uint8Array(bytes),
  );
  return out;
}

async function digestOf(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type !== 'materialize') return;

  const started = performance.now();
  const per = Math.max(1, Math.floor(msg.iterations / CHUNKS));
  let seed = enc.encode(msg.key);
  let lastReport = 0;

  for (let i = 0; i < CHUNKS; i++) {
    seed = await deriveChunk(seed, SALT + ':' + i, per);
    const now = performance.now() - started;
    if (now - lastReport > 12 || i === CHUNKS - 1) {
      lastReport = now;
      self.postMessage({ type: 'progress', id: msg.id, frac: (i + 1) / CHUNKS });
    }
  }

  const page = await expand(seed, msg.pageSize);
  const digest = await digestOf(page);

  // Hand the payload over by transfer, not by copy.
  self.postMessage(
    { type: 'done', id: msg.id, key: msg.key, computeMs: performance.now() - started, digest, page },
    [page],
  );
};

self.postMessage({ type: 'ready' });
