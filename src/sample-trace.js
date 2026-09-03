"use strict";

/*
 * sample-trace.js — the bundled, deterministic request trace.
 *
 * Pure: no I/O, no platform calls. Loaded by the Node server and by the
 * browser build alike, so "identical on every machine and every run" means
 * the same bytes in both, not two implementations that happen to agree.
 */

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


// Usable from Node (require) and from a plain browser <script>.
if (typeof module === 'object' && module.exports) {
  module.exports = { SAMPLE_TRACE, SAMPLE_INFO, SAMPLE_PROCS, buildSampleTrace, mulberry32, pageKey, PAGES_PER_PROC };
} else {
  globalThis.LRUSample = { SAMPLE_TRACE, SAMPLE_INFO, SAMPLE_PROCS, buildSampleTrace, mulberry32, pageKey, PAGES_PER_PROC };
}
