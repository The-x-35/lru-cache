'use strict';

/*
 * server.js — HTTP + Server-Sent-Events front door.
 *
 * The two data sources are kept as two completely independent caches, each
 * with its own directory on disk, its own workload generator and its own
 * counters:
 *
 *     .pagecache/sample/pages/...      sample trace
 *     .pagecache/live/pages/...        this machine's processes
 *
 * That is deliberate. Sharing one cache between the sources meant Start,
 * Step and Empty acted on whichever mode you happened to be looking at,
 * pages from one source stayed resident after switching to the other, and
 * the hit rate averaged two unrelated workloads together. With one cache per
 * source, switching modes just changes which cache you are looking at —
 * each keeps its own pages and its own statistics, and neither can affect
 * the other.
 *
 * The CPU thread pool is the one shared resource, which is correct: it
 * represents the machine's cores, and there is only one machine.
 */

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { ThreadPool } = require('./src/pool.js');
const { DiskLRUCache } = require('./src/cache.js');
const { WorkloadRunner } = require('./src/workload.js');
const { SAMPLE_INFO } = require('./src/sources.js');

const PORT = Number(process.env.PORT || 7070);
const STORE = process.env.STORE_DIR || path.join(__dirname, '.pagecache');
const PUBLIC = path.join(__dirname, 'public');
const MODES = ['sample', 'live'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

async function main() {
  const pool = new ThreadPool({ size: 4, pageSize: 64 * 1024, faultCostMs: 90 });

  /** One self-contained cache + workload per data source. */
  async function makeMode(name) {
    const cache = new DiskLRUCache({ root: path.join(STORE, name), capacity: 12, pool });
    await cache.init();
    const workload = new WorkloadRunner(cache);
    // The source is fixed by the mode; only the pattern override can change.
    workload.spec = {
      source: name, pattern: null, rate: 12, keyspace: 40,
      hotFraction: 0.2, alpha: 1.1, limit: 0, concurrency: 6,
    };
    return { name, cache, workload };
  }

  const modes = {};
  for (const name of MODES) modes[name] = await makeMode(name);

  const pick = (v) => modes[MODES.includes(v) ? v : 'sample'];

  // ---- state -------------------------------------------------------------
  function modeState(m) {
    return {
      cache: m.cache.snapshot(),
      workload: m.workload.status,
      source: m.name === 'live' ? m.workload.live.info() : SAMPLE_INFO,
    };
  }

  function buildState() {
    const out = { pool: pool.snapshot(), modes: {} };
    for (const name of MODES) out.modes[name] = modeState(modes[name]);
    out.host = { cores: pool.maxSize, platform: `${os.platform()} ${os.arch()}`, node: process.version };
    return out;
  }

  // ---- SSE ---------------------------------------------------------------
  const clients = new Set();
  setInterval(() => {
    if (!clients.size) return;
    const frame = `event: state\ndata: ${JSON.stringify(buildState())}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  }, 200).unref();

  setInterval(() => { for (const n of MODES) modes[n].cache.sample(); }, 1000).unref();

  // ---- helpers -----------------------------------------------------------
  const json = (res, code, body) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });

  async function serveStatic(res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }
    try {
      const buf = await fsp.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  }

  /**
   * Apply a pattern override within one mode. The key space changes when the
   * pattern changes, so that mode starts clean — but only that mode.
   */
  /* Concurrency is a property of the request pattern, not a UI preference:
   *  - stampede needs heavy overlap or there is nothing to coalesce;
   *  - scan and textbook must be strictly serial, because their results are
   *    theoretical claims that only hold for a serial order. With faults in
   *    flight, pages are admitted in completion order and the pathological
   *    alignment breaks, quietly lifting the hit rate off zero;
   *  - anything else models a normal concurrent service.
   * Deciding it here means it is right no matter how the workload restarts. */
  function concurrencyFor(pattern) {
    if (pattern === 'stampede') return 24;
    if (pattern === 'scan' || pattern === 'textbook') return 1;
    return 6;
  }

  /* A stampede also needs a high request rate. Callers only pile onto the
   * same cold page if they arrive inside the window where it is still being
   * rebuilt (~90ms). At the ordinary 12/s, the first request finishes long
   * before the second arrives and there is nothing to merge. */
  function rateFor(pattern) {
    return pattern === 'stampede' ? 120 : 12;
  }

  async function setPattern(m, pattern) {
    const next = pattern || null;
    if (m.workload.spec.pattern === next) return false;

    const wasRunning = m.workload.running;
    if (wasRunning) m.workload.stop();
    m.workload.spec.pattern = next;
    m.workload.spec.source = next ? 'pattern' : m.name;
    m.workload.spec.concurrency = concurrencyFor(next);
    m.workload.spec.rate = rateFor(next);
    await m.cache.clear();          // also invalidates faults still in flight
    m.cache.resetMetrics();
    return wasRunning;
  }

  // ---- routes ------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    try {
      if (p === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write('retry: 1000\n\n');
        res.write(`event: state\ndata: ${JSON.stringify(buildState())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (p === '/api/state') return json(res, 200, buildState());

      if (p === '/api/disk') {
        const m = pick(url.searchParams.get('mode'));
        return json(res, 200, {
          mode: m.name,
          root: m.cache.disk.root,
          files: await m.cache.disk.listPages(),
          bytesOnDisk: await m.cache.disk.duBytes(),
        });
      }

      // --- everything below acts on exactly one mode ---
      if (req.method === 'POST') {
        const body = await readBody(req);
        const m = pick(body.mode);

        if (p === '/api/select') {
          // Selecting the live mode needs its process table read once.
          if (m.name === 'live') await m.workload.live.refresh();
          return json(res, 200, modeState(m));
        }

        if (p === '/api/step') {
          if (m.name === 'live' && !m.workload.live.procs.length) await m.workload.live.refresh();
          const key = m.workload.nextKey();
          return json(res, 200, await m.cache.access(key));
        }

        if (p === '/api/workload') {
          if (body.action === 'stop') return json(res, 200, m.workload.stop());
          // Starting must not touch the pattern. It is owned by /api/pattern
          // alone — routing it through here meant pressing Start reverted the
          // chosen pattern and flushed the cache as a side effect.
          return json(res, 200, m.workload.start({
            ...m.workload.spec,
            rate: body.rate || m.workload.spec.rate,
            keyspace: body.keyspace || m.workload.spec.keyspace,
            concurrency: body.concurrency || m.workload.spec.concurrency,
          }));
        }

        if (p === '/api/pattern') {
          const wasRunning = await setPattern(m, body.pattern);
          if (wasRunning) m.workload.start(m.workload.spec);
          return json(res, 200, modeState(m));
        }

        if (p === '/api/clear') {
          m.workload.stop();
          await m.cache.clear();
          m.cache.resetMetrics();
          return json(res, 200, { ok: true, mode: m.name });
        }

        if (p === '/api/config') {
          // Capacity and thread count describe the experiment, not the data,
          // so they apply to both modes. Comparing them is only meaningful
          // if they are bounded the same way.
          if (Number.isFinite(body.threads)) pool.resize(body.threads);
          if (Number.isFinite(body.faultCostMs)) pool.faultCostMs = Math.max(1, body.faultCostMs);
          if (Number.isFinite(body.capacity)) {
            for (const n of MODES) await modes[n].cache.reconfigure({ capacity: body.capacity });
          }
          return json(res, 200, { ok: true });
        }

        res.writeHead(404).end('no such endpoint');
        return;
      }

      if (req.method === 'GET') return serveStatic(res, p);
      res.writeHead(405).end('method not allowed');
    } catch (err) {
      json(res, 500, { error: String((err && err.message) || err) });
    }
  });

  server.listen(PORT, () => {
    console.log(`\n  LRU cache demo — http://localhost:${PORT}`);
    console.log(`  two independent caches: ${MODES.map((n) => `.pagecache/${n}`).join('  ')}`);
    console.log(`  ${pool.workers.length} worker threads on ${pool.maxSize} cores, ` +
                `page fault ~${pool.faultCostMs}ms\n`);
  });

  const shutdown = async () => {
    for (const n of MODES) { modes[n].workload.stop(); await modes[n].cache.close(); }
    await pool.destroy();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
