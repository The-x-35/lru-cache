'use strict';

/*
 * The two modes are two independent caches on the server. This client just
 * decides which one it is looking at (`mode`) and sends that with every
 * request. Start, Step and Empty therefore only ever affect the mode on
 * screen — the other one keeps its own pages and its own counters.
 */

const $ = (id) => document.getElementById(id);

let mode = 'sample';          // which cache we are looking at
let state = null;
let disk = null;

const post = (p, b) => fetch(p, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mode, ...(b || {}) }),
}).then((r) => r.json());

const ms = (v) => (v >= 100 ? Math.round(v) + ' ms' : v >= 10 ? v.toFixed(0) + ' ms' : v.toFixed(1) + ' ms');
const kb = (b) => (b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');

/* Keys arrive as `Browser[74821]:0x001`. */
function split(key) {
  const m = /^(.*?)(?:\[(\d+)\])?:(0x[0-9a-f]+)$/.exec(String(key));
  return m ? { name: m[1], pid: m[2], page: m[3] } : { name: String(key), page: '' };
}

const cur = () => (state && state.modes ? state.modes[mode] : null);

// ------------------------------------------------------------------ the cache
/* Chain rendering is keyed per mode: switching modes shows a different set of
 * pages entirely, so the old nodes are dropped rather than animated across. */
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
      // later DOM re-insertion replays it, which is what made a fast-turnover
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

  // Only touch the DOM when the order actually changed. Re-inserting nodes
  // restarts their CSS animations, so doing it on every state push (5x a
  // second) left every card permanently mid-fade.
  if (moved || chain.childElementCount !== list.length) chain.replaceChildren(frag);

  if (moved) {
    for (const [k, el] of els) {
      const w = was.get(k);
      if (!w) continue;
      const r = el.getBoundingClientRect();
      const dx = w.x - r.left, dy = w.y - r.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px,${dy}px)`;
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
  const who = `<b>${name} ${page}</b>`;

  if (a.hit) {
    $('says').innerHTML = '<span class="pill hit">Found</span> ' + who
      + ` was already cached — read from disk in <b>${ms(a.latencyMs)}</b>, and moved to the front.`;
  } else {
    const ev = (a.evicted || []).map((k) => { const s = split(k); return `${s.name} ${s.page}`; });
    $('says').innerHTML = '<span class="pill miss">Rebuilt</span> ' + who
      + ` wasn't cached — a CPU thread rebuilt it in <b>${ms(a.latencyMs)}</b>`
      + (ev.length ? `, and <b>${ev.join(', ')}</b> was dropped to make room.` : '.');
  }
}

// -------------------------------------------------------------------- details
const LABELS = {
  CLOCK: 'Second chance', FIFO: 'Oldest added',
  RANDOM: 'At random', MRU: 'Newest used',
};

function drawDetails(c, pool) {
  const m = c.metrics;

  $('m-hit').style.width = (m.accesses ? m.hitRate * 100 : 0).toFixed(1) + '%';
  $('n-hit').textContent = m.hits.toLocaleString();
  $('n-miss').textContent = m.misses.toLocaleString();

  const rows = [
    ['Pages held', `${c.resident} of ${c.config.capacity}`],
    ['Dropped so far', m.evictions.toLocaleString()],
    ['CPU time saved', m.cpuMsSaved > 1000 ? (m.cpuMsSaved / 1000).toFixed(1) + ' s' : ms(m.cpuMsSaved)],
  ];
  if (disk && disk.mode === mode) rows.push(['Files on disk', `${disk.files.length} · ${kb(disk.bytesOnDisk)}`]);
  if (m.coalesced) rows.push(['Duplicate requests merged', m.coalesced.toLocaleString()]);
  $('dl-counts').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  $('lanes').innerHTML = pool.threads.map((t) => {
    const s = t.busy ? split(t.key) : null;
    return `<div class="lane"><div class="t">
      <div class="f" style="width:${t.busy ? (t.progress * 100).toFixed(0) : 0}%"></div>
      <div class="x ${t.busy ? '' : 'i'}">${s ? `rebuilding ${s.name} ${s.page}` : 'idle'}</div>
    </div></div>`;
  }).join('');
  $('hint-threads').textContent = pool.queueDepth
    ? `${pool.queueDepth} waiting — every thread is busy.`
    : `Rebuilding one page costs about ${pool.faultCostMs} ms of real CPU work. `
      + 'The threads are the machine’s cores, so both modes share them.';

  const alts = [{ n: 'Least recently used', r: m.hitRate, me: true }].concat(
    c.shadows.filter((s) => s.name !== 'LRU').map((s) => ({ n: LABELS[s.name] || s.name, r: s.hitRate })));
  $('policies').innerHTML = alts.map((a) => `
    <div class="pol ${a.me ? 'me' : ''}">
      <div class="n">${a.n}</div>
      <div class="t"><div class="f" style="width:${(a.r * 100).toFixed(1)}%"></div></div>
      <div class="v">${m.accesses ? Math.round(a.r * 100) + '%' : '—'}</div>
    </div>`).join('');
  $('hint-pol').textContent = m.accesses > 20
    ? 'Every rule above saw exactly the same requests. Only the choice of what to drop differs.'
    : '';
}

// --------------------------------------------------------------------- render
function render() {
  const m = cur();
  if (!m) return;
  const c = m.cache;
  const met = c.metrics;

  $('s-rate').textContent = met.accesses ? Math.round(met.hitRate * 100) + '%' : '—';
  $('s-fast').textContent = met.hits ? ms(met.avgHitMs) : '—';
  $('s-slow').textContent = met.misses ? ms(met.avgMissMs) : '—';

  const pat = m.workload.spec && m.workload.spec.pattern;
  const line = $('srcline');
  line.textContent = pat ? 'Synthetic request order.' : (m.source.error || m.source.detail || '');
  line.classList.toggle('warn', !pat && !!m.source.error);

  // keep the pattern buttons showing THIS mode's choice
  $('pats').querySelectorAll('button')
    .forEach((b) => b.classList.toggle('on', (b.dataset.p || null) === (pat || null)));

  drawChain(c);
  drawSays(c);
  if ($('more').open) drawDetails(c, state.pool);

  const play = $('b-play');
  play.textContent = m.workload.running ? 'Pause' : 'Start';
  play.classList.toggle('on', !!m.workload.running);

  // Follow the server's real capacity unless the user is mid-drag.
  const cap = $('i-cap');
  if (document.activeElement !== cap && Number(cap.value) !== c.config.capacity) {
    cap.value = c.config.capacity;
    $('v-cap').textContent = c.config.capacity;
  }
}

async function pollDisk() {
  try { disk = await fetch(`/api/disk?mode=${mode}`).then((r) => r.json()); } catch { /* transient */ }
}

// -------------------------------------------------------------------- wiring
function run() {
  // Concurrency is decided server-side from the active pattern, so it stays
  // correct however the workload is (re)started.
  return post('/api/workload', { action: 'start' });
}

const PATTERNS = [
  ['', 'Real order'],
  ['hotset', 'A few popular pages'],
  ['uniform', 'All pages equally'],
  ['scan', 'Every page in turn'],
  ['stampede', 'All at once, same page'],
];

function wire() {
  document.querySelectorAll('.seg button').forEach((b) => {
    b.onclick = () => {
      if (mode === b.dataset.source) return;
      mode = b.dataset.source;
      document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      disk = null;
      // Switching only changes which cache we look at. Nothing is cleared,
      // nothing is started or stopped — each mode keeps running or sitting
      // idle exactly as it was.
      post('/api/select').then(() => { render(); if ($('more').open) pollDisk(); });
    };
  });

  $('pats').innerHTML = PATTERNS
    .map(([v, l], i) => `<button data-p="${v}" class="${i === 0 ? 'on' : ''}">${l}</button>`).join('');
  $('pats').querySelectorAll('button').forEach((b) => {
    // A pattern changes the key space, so that mode restarts clean — but
    // only that mode.
    b.onclick = () => post('/api/pattern', { pattern: b.dataset.p || null });
  });

  $('b-play').onclick = () => {
    const m = cur();
    return (m && m.workload.running) ? post('/api/workload', { action: 'stop' }) : run();
  };
  $('b-step').onclick = () => post('/api/step');
  $('b-clear').onclick = () => post('/api/clear');

  const cap = $('i-cap');
  cap.oninput = () => { $('v-cap').textContent = cap.value; };
  cap.onchange = () => post('/api/config', { capacity: Number(cap.value) });

  $('more').ontoggle = () => {
    if ($('more').open) pollDisk().then(() => { if (cur()) drawDetails(cur().cache, state.pool); });
  };

  // adopt the server's real capacity rather than imposing the slider default
  fetch('/api/state').then((r) => r.json()).then((s) => {
    const c = s.modes[mode].cache.config.capacity;
    cap.value = c;
    $('v-cap').textContent = c;
  });
}

const es = new EventSource('/api/events');
es.addEventListener('state', (e) => { state = JSON.parse(e.data); render(); });

wire();
setInterval(() => { if ($('more').open) pollDisk(); }, 2500);
