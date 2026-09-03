'use strict';

// Wrapped so this file's top-level names stay private: these load as classic
// scripts sharing one global scope, and only the globalThis export below is
// meant to be visible to the others.
(function () {

/*
 * app.js — the browser build's UI and orchestration.
 *
 * Two modes are two independent caches, each with its own storage namespace,
 * its own request feed and its own counters. Start, Step and Empty therefore
 * only ever affect the mode on screen; the other keeps running, or keeps
 * sitting idle, exactly as it was left.
 */

const $ = (id) => document.getElementById(id);
const { PageStore } = globalThis.LRUStore;
const { WorkerPool } = globalThis.LRUPool;
const { BrowserLRUCache } = globalThis.LRUBrowserCache;
const { DeviceSource, Feed, SAMPLE_INFO } = globalThis.LRUFeed;

const ms = (v) => (v >= 100 ? Math.round(v) + ' ms' : v >= 10 ? v.toFixed(0) + ' ms' : v.toFixed(1) + ' ms');
const kb = (b) => (b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');

/* Keys arrive as `Browser[74821]:0x001`. */
function split(key) {
  const m = /^(.*?)(?:\[([^\]]+)\])?:(0x[0-9a-f]+)$/.exec(String(key));
  return m ? { name: m[1], id: m[2], page: m[3] } : { name: String(key), page: '' };
}

let mode = 'sample';
const modes = {};
let pool = null;
let device = null;
let files = null;

const cur = () => modes[mode];

// ------------------------------------------------------------------- chain
let els = new Map();
let elsMode = null;
let prevOrder = '';
let prevUse = new Map();

function drawChain(c) {
  const chain = $('chain');
  if (elsMode !== mode) { els = new Map(); elsMode = mode; prevOrder = ''; prevUse = new Map(); }

  const list = c.entries;
  if (!list.length) {
    chain.innerHTML = '<div class="none">Empty.</div>';
    els.clear(); prevOrder = '';
    return;
  }

  const order = list.map((e) => e.key).join(',');
  const moved = order !== prevOrder;

  // measure -> reorder -> animate the difference, so a page moving back to the
  // front reads as movement rather than a silent redraw
  const was = new Map();
  if (moved) {
    for (const [k, el] of els) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      was.set(k, { x: r.left, y: r.top });
    }
  }

  const frag = document.createDocumentFragment();
  const keep = new Set();

  list.forEach((e, i) => {
    keep.add(e.key);
    let el = els.get(e.key);
    if (!el) {
      const { name, page } = split(e.key);
      el = document.createElement('div');
      el.className = 'pg arrive';
      el.innerHTML = '<div class="nm"></div><div class="pp"></div>';
      el.querySelector('.nm').textContent = name;
      el.querySelector('.pp').textContent = page;
      el.title = e.key;
      // Let the entrance animation play once. Leaving the class on means a
      // later DOM re-insertion replays it, which makes a fast-turnover
      // workload look like an empty cache.
      el.addEventListener('animationend', function drop(ev) {
        if (ev.animationName === 'arrive') { el.classList.remove('arrive'); el.removeEventListener('animationend', drop); }
      });
      els.set(e.key, el);
    }
    el.classList.toggle('newest', i === 0);
    el.classList.toggle('oldest', i === list.length - 1 && list.length >= c.config.capacity);

    const p = prevUse.get(e.key);
    if (p !== undefined && e.hits > p) {
      el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    }
    frag.appendChild(el);
  });

  for (const [k, el] of els) if (!keep.has(k)) { el.remove(); els.delete(k); }

  // Only touch the DOM when the order actually changed: re-inserting nodes
  // restarts their CSS animations.
  if (moved || chain.childElementCount !== list.length) chain.replaceChildren(frag);

  if (moved) {
    for (const [k, el] of els) {
      const w = was.get(k);
      if (!w) continue;
      const r = el.getBoundingClientRect();
      const dx = w.x - r.left;
      const dy = w.y - r.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.style.transition = 'none';
      el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      requestAnimationFrame(() => { el.style.transition = ''; el.style.transform = ''; });
    }
  }

  prevOrder = order;
  prevUse = new Map(list.map((e) => [e.key, e.hits]));
}

function drawSays(c) {
  const a = c.lastAccess;
  if (!a) {
    $('says').innerHTML = 'Press <b>Start</b> to send pages through this cache.';
    return;
  }
  const { name, page } = split(a.key);
  const who = '<b>' + name + ' ' + page + '</b>';

  if (a.hit) {
    $('says').innerHTML = '<span class="pill hit">Found</span> ' + who
      + ' was already cached — read from storage in <b>' + ms(a.latencyMs) + '</b>, and moved to the front.';
  } else if (a.merged) {
    $('says').innerHTML = '<span class="pill miss">Merged</span> ' + who
      + ' was already being rebuilt, so this request waited for that one instead of burning a second thread.';
  } else {
    const ev = (a.evicted || []).map((k) => { const s = split(k); return s.name + ' ' + s.page; });
    $('says').innerHTML = '<span class="pill miss">Rebuilt</span> ' + who
      + " wasn't cached — a CPU thread rebuilt it in <b>" + ms(a.latencyMs) + '</b>'
      + (ev.length ? ', and <b>' + ev.join(', ') + '</b> was dropped to make room.' : '.');
  }
}

// ------------------------------------------------------------------ details
const LABELS = { CLOCK: 'Second chance', FIFO: 'Oldest added', RANDOM: 'At random', MRU: 'Newest used' };

function drawDetails(c) {
  const m = c.metrics;
  $('m-hit').style.width = (m.accesses ? m.hitRate * 100 : 0).toFixed(1) + '%';
  $('n-hit').textContent = m.hits.toLocaleString();
  $('n-miss').textContent = m.misses.toLocaleString();

  const rows = [
    ['Pages held', c.resident + ' of ' + c.config.capacity],
    ['Dropped so far', m.evictions.toLocaleString()],
    ['CPU time saved', m.cpuMsSaved > 1000 ? (m.cpuMsSaved / 1000).toFixed(1) + ' s' : ms(m.cpuMsSaved)],
  ];
  if (files) rows.push(['Records in storage', files.count + ' · ' + kb(files.bytes)]);
  if (m.coalesced) rows.push(['Duplicate requests merged', m.coalesced.toLocaleString()]);
  if (m.phantoms) rows.push(['Records vanished', m.phantoms.toLocaleString()]);
  $('dl-counts').innerHTML = rows.map((r) => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('');

  const p = pool.snapshot();
  $('lanes').innerHTML = p.threads.map((t) => {
    const s = t.busy ? split(t.key) : null;
    return '<div class="lane"><div class="t">'
      + '<div class="f" style="width:' + (t.busy ? (t.progress * 100).toFixed(0) : 0) + '%"></div>'
      + '<div class="x ' + (t.busy ? '' : 'i') + '">'
      + (s ? 'rebuilding ' + s.name + ' ' + s.page : 'idle') + '</div></div></div>';
  }).join('');
  $('hint-threads').textContent = p.queueDepth
    ? p.queueDepth + ' waiting — every thread is busy.'
    : 'Rebuilding one page costs about ' + p.faultCostMs + ' ms of real CPU work on this device'
      + ' (' + p.iterations.toLocaleString() + ' PBKDF2 iterations). Both modes share these threads.';

  const alts = [{ n: 'Least recently used', r: m.hitRate, me: true }].concat(
    c.shadows.filter((s) => s.name !== 'LRU').map((s) => ({ n: LABELS[s.name] || s.name, r: s.hitRate })));
  $('policies').innerHTML = alts.map((a) => '<div class="pol ' + (a.me ? 'me' : '') + '">'
    + '<div class="n">' + a.n + '</div>'
    + '<div class="t"><div class="f" style="width:' + (a.r * 100).toFixed(1) + '%"></div></div>'
    + '<div class="v">' + (m.accesses ? Math.round(a.r * 100) + '%' : '—') + '</div></div>').join('');
  $('hint-pol').textContent = m.accesses > 20
    ? 'Every rule above saw exactly the same requests. Only the choice of what to drop differs.'
    : '';
}

// ------------------------------------------------------------------- render
function render() {
  const m = cur();
  if (!m) return;
  const c = m.cache.snapshot();
  const met = c.metrics;

  $('s-rate').textContent = met.accesses ? Math.round(met.hitRate * 100) + '%' : '—';
  $('s-fast').textContent = met.hits ? ms(met.avgHitMs) : '—';
  $('s-slow').textContent = met.misses ? ms(met.avgMissMs) : '—';

  const line = $('srcline');
  if (m.feed.pattern) {
    line.textContent = 'Synthetic request order.';
    line.classList.remove('warn');
  } else if (mode === 'device') {
    const info = device.info();
    line.textContent = info.error || info.detail;
    line.classList.toggle('warn', !!info.error);
  } else {
    line.textContent = SAMPLE_INFO.detail;
    line.classList.remove('warn');
  }

  $('pats').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', (b.dataset.p || null) === (m.feed.pattern || null));
  });

  drawChain(c);
  drawSays(c);
  if ($('more').open) drawDetails(c);

  const play = $('b-play');
  play.textContent = m.feed.running ? 'Pause' : 'Start';
  play.classList.toggle('on', !!m.feed.running);

  const cap = $('i-cap');
  if (document.activeElement !== cap && Number(cap.value) !== c.config.capacity) {
    cap.value = c.config.capacity;
    $('v-cap').textContent = c.config.capacity;
  }
}

async function pollStorage() {
  try {
    const list = await modes[mode].cache.store.list(mode);
    files = { count: list.length, bytes: list.reduce((s, f) => s + f.bytes, 0) };
  } catch { files = null; }
}

// -------------------------------------------------------------------- setup
const PATTERNS = [
  ['', 'Real order'],
  ['hotset', 'A few popular pages'],
  ['uniform', 'All pages equally'],
  ['scan', 'Every page in turn'],
  ['stampede', 'All at once, same page'],
];

/* A pattern changes the key space, so that mode restarts clean — but only
   that mode. */
async function setPattern(m, pattern) {
  const next = pattern || null;
  if (m.feed.pattern === next) return;
  const wasRunning = m.feed.running;
  m.feed.stop();
  m.feed.pattern = next;
  m.feed.cursor = 0;
  await m.cache.clear();
  m.cache.resetMetrics();
  await pollStorage();
  if (wasRunning) m.feed.start();
}

function wire() {
  document.querySelectorAll('.seg button').forEach((b) => {
    b.onclick = async () => {
      if (mode === b.dataset.source) return;
      mode = b.dataset.source;
      document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      // Switching only changes which cache we look at. Nothing is cleared,
      // nothing is started or stopped.
      if (mode === 'device') device.refresh();
      files = null;
      await pollStorage();
      render();
    };
  });

  $('pats').innerHTML = PATTERNS
    .map((p, i) => '<button data-p="' + p[0] + '" class="' + (i === 0 ? 'on' : '') + '">' + p[1] + '</button>')
    .join('');
  $('pats').querySelectorAll('button').forEach((b) => {
    b.onclick = () => setPattern(cur(), b.dataset.p || null);
  });

  $('b-play').onclick = () => {
    const m = cur();
    if (m.feed.running) m.feed.stop(); else m.feed.start();
    render();
  };
  $('b-step').onclick = () => cur().feed.step().then(pollStorage);
  $('b-clear').onclick = async () => {
    const m = cur();
    m.feed.stop();
    await m.cache.clear();
    m.cache.resetMetrics();
    await pollStorage();
    render();
  };

  const cap = $('i-cap');
  cap.oninput = () => { $('v-cap').textContent = cap.value; };
  cap.onchange = async () => {
    // Capacity describes the experiment, not the data, so it applies to both
    // modes — comparing them is only meaningful if they are bounded alike.
    const v = Number(cap.value);
    for (const n of Object.keys(modes)) await modes[n].cache.reconfigure(v);
    await pollStorage();
  };

  $('more').ontoggle = () => { if ($('more').open) pollStorage().then(render); };
}

async function boot() {
  const store = await new PageStore().open();
  pool = new WorkerPool({ pageSize: 64 * 1024, faultCostMs: 90 });
  await pool.calibrate();

  device = new DeviceSource();
  device.refresh();

  for (const name of ['sample', 'device']) {
    const cache = new BrowserLRUCache({ mode: name, store, pool, capacity: 12 });
    await cache.init();
    const feed = new Feed(cache, name);
    feed.device = device;
    modes[name] = { cache, feed };
  }

  wire();
  await pollStorage();
  render();
  setInterval(render, 200);
  setInterval(() => { if ($('more').open) pollStorage(); }, 2000);
}

boot().catch((err) => {
  // Storage can be blocked outright (private windows, cookies disabled). Say
  // so plainly rather than leaving a dead page.
  $('srcline').textContent = 'Could not start: ' + (err && err.message ? err.message : err)
    + '. This demo needs IndexedDB, which some private-browsing modes block.';
  $('srcline').classList.add('warn');
});
}());
