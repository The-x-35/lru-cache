'use strict';

/*
 * sources.js — where the access stream comes from.
 *
 *   sample : a bundled, deterministic trace. Same every run, so a demo is
 *            repeatable and needs nothing from the host machine.
 *   live   : the real process table of this machine, read with ps(1).
 *            Processes burning more CPU are touched more often, so the
 *            access stream reflects what the box is actually doing.
 *
 * Both produce keys shaped `name[pid]:0xNNN` — a process and a page within
 * it — so the cache, the disk layout and the UI treat them identically.
 */

const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');

const PAGES_PER_PROC = 8;

const pageKey = (name, pid, page) =>
  `${name}[${pid}]:0x${page.toString(16).padStart(3, '0')}`;

// ------------------------------------------------------------ sample source

/* A small deterministic PRNG so the bundled trace is byte-identical on every
 * machine and every run. Math.random() would make the demo unrepeatable. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* A plausible desktop: a couple of heavy apps doing most of the work, a few
 * quieter ones, and one process that sweeps a lot of pages (the kind of thing
 * that evicts everyone else's working set).
 *
 * These are deliberately ORDINARY APP names, never real system-process names
 * like kernel_task, launchd, WindowServer or mds_stores. The live source is
 * full of those, so keeping them out of here is what lets you tell the two
 * modes apart at a glance. The PIDs are in a high, obviously-synthetic band
 * for the same reason. */
const SAMPLE_PROCS = [
  { name: 'Browser',   pid: 74821, weight: 30, pages: 6,  kind: 'hot' },
  { name: 'Editor',    pid: 71207, weight: 24, pages: 5,  kind: 'hot' },
  { name: 'Chat',      pid: 76633, weight: 12, pages: 8,  kind: 'warm' },
  { name: 'Music',     pid: 73390, weight: 8,  pages: 6,  kind: 'warm' },
  { name: 'Mail',      pid: 70872, weight: 5,  pages: 4,  kind: 'warm' },
  { name: 'Backup',    pid: 70419, weight: 13, pages: 24, kind: 'scan' },
  { name: 'Photos',    pid: 70001, weight: 8,  pages: 3,  kind: 'hot' },
];

/** Build the bundled trace once, deterministically. */
function buildSampleTrace(length = 1200) {
  const rnd = mulberry32(20260903);
  const total = SAMPLE_PROCS.reduce((s, p) => s + p.weight, 0);
  const scanCursor = new Map();
  const trace = [];

  for (let i = 0; i < length; i++) {
    let r = rnd() * total;
    const proc = SAMPLE_PROCS.find((p) => (r -= p.weight) < 0) || SAMPLE_PROCS[0];

    let page;
    if (proc.kind === 'scan') {
      // Walks straight through its pages — the classic cache-polluting sweep.
      const c = (scanCursor.get(proc.name) || 0) % proc.pages;
      scanCursor.set(proc.name, c + 1);
      page = c;
    } else if (proc.kind === 'hot') {
      // Strong locality: mostly the first two pages.
      page = rnd() < 0.75 ? Math.floor(rnd() * 2) : Math.floor(rnd() * proc.pages);
    } else {
      page = Math.floor(rnd() * proc.pages);
    }

    trace.push(pageKey(proc.name, proc.pid, page));
  }
  return trace;
}

const SAMPLE_TRACE = buildSampleTrace();

const SAMPLE_INFO = {
  kind: 'sample',
  label: 'Sample data',
  detail: `${SAMPLE_TRACE.length} pre-recorded page requests from ${SAMPLE_PROCS.length} processes`,
  distinctPages: new Set(SAMPLE_TRACE).size,
  processes: SAMPLE_PROCS.map((p) => ({
    name: p.name, pid: p.pid, pages: p.pages, share: p.weight,
  })),
};

// -------------------------------------------------------------- live source

/*
 * Reading the process table is the only host-specific thing in this project,
 * so it is done with a list of probes tried in order. The first one that
 * yields usable rows wins; if none do, LiveSource falls back to the sample
 * process set and says so in the UI rather than failing.
 *
 *   unix-ps    macOS, Linux, BSD — ps(1) with CPU%, RSS and command
 *   linux-proc pure Node read of /proc, for minimal containers with no ps
 *   win-ps     Windows PowerShell Get-Process (has CPU seconds)
 *   win-tasklist  Windows fallback; no CPU, so weight by memory
 *
 * Every probe is capped by a timeout: a wedged command must not wedge the
 * demo. Note the server is what reads the process table, so viewing the page
 * from a phone works regardless of the phone's OS.
 */

const EXEC_TIMEOUT = 2500;

function run(cmd, args) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = execFile(cmd, args, { maxBuffer: 8 << 20, timeout: EXEC_TIMEOUT, windowsHide: true },
        (err, stdout) => finish(err && !stdout ? '' : String(stdout || '')));
      child.on('error', () => finish(''));
    } catch { finish(''); }
  });
}

const clean = (name) =>
  String(name || '').split(/[\\/]/).pop().replace(/^\(|\)$/g, '').replace(/\.exe$/i, '').trim();

function normalize(rows) {
  const out = [];
  for (const r of rows) {
    const name = clean(r.name);
    if (!name || name.length > 24 || !Number.isFinite(r.pid)) continue;
    out.push({
      pid: r.pid,
      name,
      cpu: Number.isFinite(r.cpu) ? r.cpu : 0,
      rssKb: Number.isFinite(r.rssKb) ? r.rssKb : 0,
    });
  }
  return out;
}

const PROBES = [
  {
    id: 'unix-ps',
    ok: () => process.platform !== 'win32',
    read: async () => {
      const out = await run('ps', ['-Ao', 'pid=,pcpu=,rss=,comm=']);
      const rows = [];
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
        if (m) rows.push({ pid: +m[1], cpu: +m[2], rssKb: +m[3], name: m[4] });
      }
      return normalize(rows);
    },
  },
  {
    id: 'linux-proc',
    ok: () => process.platform === 'linux',
    read: async () => {
      // No child process at all: just read /proc. Works where ps is absent.
      const pageKb = 4;
      const names = await fsp.readdir('/proc').catch(() => []);
      const rows = [];
      for (const d of names) {
        if (!/^\d+$/.test(d)) continue;
        const stat = await fsp.readFile(`/proc/${d}/stat`, 'utf8').catch(() => null);
        if (!stat) continue;
        // comm is parenthesised and may itself contain spaces or brackets.
        const open = stat.indexOf('(');
        const close = stat.lastIndexOf(')');
        if (open < 0 || close < 0) continue;
        const name = stat.slice(open + 1, close);
        const f = stat.slice(close + 2).split(/\s+/);
        // after comm and state: utime is field 11, stime 12, rss 21 (0-based)
        const utime = Number(f[11]) || 0;
        const stime = Number(f[12]) || 0;
        const rssPages = Number(f[21]) || 0;
        rows.push({ pid: +d, cpu: (utime + stime) / 100, rssKb: rssPages * pageKb, name });
      }
      return normalize(rows);
    },
  },
  {
    id: 'win-powershell',
    ok: () => process.platform === 'win32',
    read: async () => {
      const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-Process | Select-Object Name,Id,CPU,WorkingSet | ConvertTo-Csv -NoTypeInformation']);
      const rows = [];
      for (const line of out.split('\n').slice(1)) {
        const c = line.trim().replace(/^"|"$/g, '').split('","');
        if (c.length < 4) continue;
        rows.push({
          name: c[0], pid: Number(c[1]),
          cpu: Number(c[2]) || 0,                 // total CPU seconds, fine as a weight
          rssKb: (Number(c[3]) || 0) / 1024,
        });
      }
      return normalize(rows);
    },
  },
  {
    id: 'win-tasklist',
    ok: () => process.platform === 'win32',
    read: async () => {
      const out = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const rows = [];
      for (const line of out.split('\n')) {
        const c = line.trim().replace(/^"|"$/g, '').split('","');
        if (c.length < 5) continue;
        rows.push({
          name: c[0], pid: Number(c[1]), cpu: 0,
          rssKb: Number(String(c[4]).replace(/[^\d]/g, '')) || 0,   // "12,345 K"
        });
      }
      return normalize(rows);
    },
  },
];

/**
 * Try each applicable probe until one returns rows.
 * @returns {{procs: Array, via: string|null}}
 */
async function readProcesses() {
  for (const probe of PROBES) {
    if (!probe.ok()) continue;
    let procs = [];
    try { procs = await probe.read(); } catch { procs = []; }
    if (procs.length < 2) continue;

    // Weight by CPU where we have it, else by memory: either way, the
    // processes doing the most work get touched most often. A floor keeps
    // quiet processes in the mix so the working set still shifts.
    const anyCpu = procs.some((p) => p.cpu > 0);
    for (const p of procs) {
      p.weight = (anyCpu ? p.cpu : p.rssKb / 8192) + 0.4;
    }
    procs.sort((a, b) => b.weight - a.weight);
    return { procs: procs.slice(0, 40), via: probe.id };
  }
  return { procs: [], via: null };
}

class LiveSource {
  constructor() {
    this.procs = [];
    this.refreshedAt = 0;
    this.error = null;
    this.via = null;
    this.available = null;   // null = not tried yet
  }

  async refresh() {
    const { procs, via } = await readProcesses();
    if (procs.length) {
      this.procs = procs;
      this.via = via;
      this.error = null;
      this.available = true;
    } else {
      // Never throw and never leave the demo empty: fall back to the sample
      // process set and be explicit that this is what happened.
      this.available = false;
      this.via = null;
      this.error = `Could not read the process list on ${process.platform}. `
        + 'Showing the sample processes instead — everything else is still live.';
      this.procs = SAMPLE_PROCS.map((p) => ({
        pid: p.pid, name: p.name, cpu: p.weight, rssKb: 0, weight: p.weight,
      }));
    }
    this.refreshedAt = Date.now();
    return this.procs;
  }

  /** Pick a page, weighted by real CPU usage. */
  nextKey() {
    if (!this.procs.length) return pageKey('idle', 0, 0);
    const total = this.procs.reduce((s, p) => s + p.weight, 0);
    let r = Math.random() * total;
    const proc = this.procs.find((p) => (r -= p.weight) < 0) || this.procs[0];
    // Locality within a process: the first couple of pages dominate.
    const page = Math.random() < 0.7
      ? Math.floor(Math.random() * 2)
      : Math.floor(Math.random() * PAGES_PER_PROC);
    return pageKey(proc.name, proc.pid, page);
  }

  info() {
    const how = this.via === 'win-tasklist' ? 'memory use' : 'CPU use';
    return {
      kind: 'live',
      label: 'Live system',
      detail: this.procs.length
        ? `${this.procs.length} processes running on this ${os.type()} machine, sampled by ${how}`
        : 'reading the process list…',
      error: this.error,
      available: this.available,
      via: this.via,
      platform: process.platform,
      refreshedAt: this.refreshedAt,
      processes: this.procs.slice(0, 12).map((p) => ({
        name: p.name, pid: p.pid, cpu: p.cpu, rssKb: p.rssKb,
      })),
    };
  }
}

module.exports = { SAMPLE_TRACE, SAMPLE_INFO, SAMPLE_PROCS, LiveSource, pageKey, PAGES_PER_PROC };
