# LRU cache — a working demo, not an animation

An interactive demo of the **least-recently-used** cache eviction algorithm,
where every part of it is real:

- The cache entries are **actual files on disk**, written atomically and
  deleted when evicted.
- A cache miss does **genuine CPU work** on a real `worker_threads` pool.
- The hit/miss timings on screen are **measured**, not scripted.

The result is a demo you can argue with. When it says a hit took 0.2 ms and a
miss took 90 ms, those are real numbers from your machine — a **~400×** gap,
which is the entire reason caches exist.

**Zero dependencies.** Just `node:http`, `node:worker_threads`, `node:crypto`
and `node:fs`.

```bash
npm start     # http://localhost:7070
npm test      # 50 tests
```

---

## What you're looking at

The demo frames LRU as an **operating-system page cache**. A process needs a
page of memory. Materialising that page is expensive. Once materialised it is
cached on disk, and the cache holds a fixed number of pages.

| | what happens | cost |
|---|---|---|
| **hit** | move the page to the front of the list, read its file | ~0.2 ms |
| **miss** | queue → worker thread rebuilds it → write file → insert at front → drop the last page | ~90 ms |

The screen shows three numbers, the cache itself as a row of pages ordered
from *just used* to *dropped next*, and one plain sentence describing the most
recent request. Everything else is behind **Details**.

## Two independent caches

The two modes are **not** two views of one cache. Each is a completely
separate cache with its own directory on disk, its own request generator and
its own counters:

```
.pagecache/sample/pages/...    the bundled trace
.pagecache/live/pages/...      this machine's processes
```

| | where the requests come from |
|---|---|
| **Sample** | A bundled, deterministic trace — 1,200 requests across 7 invented apps (`Browser`, `Editor`, `Chat`, `Music`, `Mail`, `Backup`, `Photos`). Seeded, so it is byte-identical on every machine and every run. Good for a demo you need to repeat. |
| **This device** | Your real process table, read live. Busier processes get requested more often, so you see actual names — `WindowServer`, `launchd`, `coreaudiod`. |

**Start, Step and Empty only ever affect the mode on screen.** Switching modes
just changes which cache you are looking at; the other keeps running, or keeps
sitting idle, exactly as you left it. Sample names are deliberately ordinary
app names and never real system-process names, so one glance at the page list
tells you which mode you are in.

The only shared thing is the CPU thread pool — correct, because it represents
the machine's cores and there is one machine. Cache size applies to both, so
comparing them stays fair.

## Try this

1. **Press Step twice on the same page.** First time it is rebuilt; second
   time it is found and jumps to the front. That is the whole algorithm.
2. **Press Start.** The hit rate settles around 50–75%. Popular pages pin
   themselves near the front and never reach the drop end.
3. **Drag the size slider down.** Pages are dropped immediately — and the file
   count on disk drops with them.
4. **Details → Request order → "Every page in turn."** The hit rate goes to
   **exactly 0%**. LRU drops pages in precisely the order they will next be
   needed. Watch the status line: *"page 0x010 wasn't cached… and page 0x004
   was dropped"* — it just threw away the page it is about to want. Make the
   cache larger than the sweep and it jumps to ~99%. That cliff, two pages
   wide, is why ARC and 2Q exist.
5. **Request order → "All at once, same page."** `Duplicate requests merged`
   climbs while pages rebuilt barely moves — 708 requests, 10 rebuilds, 110
   merged. Without single-flight this melts the thread pool recomputing bytes
   it already has.
6. **Restart the server.** The cache comes back warm, in the same recency
   order, and reconciles anything stale.

## The algorithm

`src/lru.js` is the whole thing, and it is deliberately boring: a hash map for
lookup plus an intrusive doubly linked list for recency.

```
       head                                              tail
  (most recently used)                          (least recently used)
       [A] <-> [B] <-> [C] <-> [D] <-> [E] <-> [F]
        ^                                        ^
   promoted here                          evicted from here
```

Every operation is O(1):

- **lookup** — one `Map.get`
- **promote** — unlink the node, push it to the head. Pointer surgery, no scan,
  no allocation, and the map is never touched.
- **evict** — take `this.tail`

The list is *intrusive*: the `prev`/`next` pointers live on the entry itself.
The file has no I/O and no `async`, which is what makes it testable — disk
lives in `diskstore.js`, and `cache.js` composes the two.

## Layout

| file | role |
|---|---|
| `src/lru.js` | The algorithm. Pure, synchronous, O(1). `validate()` checks the structural invariants. |
| `src/diskstore.js` | One file per page. Atomic writes via `rename(2)`, an index that survives restart, append-only journal. |
| `src/cache.js` | Composes policy + disk. Single-flight, metrics, eviction → `unlink`. |
| `src/pool.js`, `src/worker.js` | Real thread pool. Cost is calibrated at boot, so the UI asks for a fault "costing 90 ms" and gets it. |
| `src/policies.js` | Shadow simulators — FIFO, CLOCK, RANDOM, MRU, Belady's OPT — replaying the same trace. |
| `src/sources.js` | The bundled trace and the live process reader. |
| `src/workload.js` | Synthetic request patterns. |
| `server.js` | HTTP + Server-Sent Events. No framework. |
| `public/` | The UI — one HTML file, one stylesheet, one script. |

## Reading the process table

This is the only host-specific part, and the **server** does it, not the
browser — so opening the page from a phone works regardless of the phone's OS.
Probes are tried in order until one yields rows:

- **macOS / Linux / BSD** — `ps`
- **Linux without `ps`** (minimal containers) — reads `/proc` directly, no
  subprocess
- **Windows** — PowerShell `Get-Process`, falling back to `tasklist`

Each has a 2.5 s timeout. If every probe fails, the UI says so and falls back
to the sample processes. It never crashes and never hangs.

## Details worth knowing

- **Concurrency changes the answer.** "Every page in turn" runs strictly
  serially, because its 0% result is a claim that only holds for a serial
  order. With several faults in flight, pages are admitted in *completion*
  order and the pathological alignment breaks, quietly lifting the hit rate
  off zero. Concurrency and request rate are therefore derived from the
  pattern server-side, so they are right however the workload restarts.
- **An entry can't evict itself.** `trim()` protects the key just admitted;
  otherwise inserting something larger than the byte budget would drop the
  thing you just inserted and delete a file still in use.
- **Disk decides what exists; the index only decides order.** An indexed page
  whose file has vanished is counted as a phantom and rebuilt — never served
  as a hit.
- **Emptying a cache cancels the work already in flight.** `clear()` bumps a
  generation counter, and a fault that finishes afterwards serves its caller
  but refuses to insert itself. Without that, a fault dispatched just before a
  flush lands just after it and quietly revives a page that should be gone.
- **Single-flight.** Concurrent misses on one key join one computation. This is
  the cache-stampede bug, and it is the most common real defect in this shape
  of code.

## Tests

```bash
npm test
```

50 tests in three layers:

- **`test/lru.test.js`** (17) — the algorithm. Every mutation is followed by a
  structural `validate()`, plus a 4,000-operation randomized run checked
  against an independent `Map`-based oracle.
- **`test/cache.test.js`** (13) — real files, real threads. Eviction deletes
  files, restart restores recency order, stale indexes and orphan files
  reconcile, a flush cancels in-flight faults.
- **`test/server.test.js`** (20) — boots a real server on a spare port and
  asserts the two modes cannot affect each other.

Two results are asserted against published numbers. The textbook reference
string `1 2 3 4 1 2 5 1 2 3 4 5` at 3 frames gives **LRU 10 faults, FIFO 9,
OPT 7** — LRU losing to FIFO is **Belady's anomaly**, reproduced live. And a
scan one page wider than the cache hits **exactly zero**.

## Configuration

| variable | default | meaning |
|---|---|---|
| `PORT` | `7070` | HTTP port |
| `STORE_DIR` | `./.pagecache` | where page files and indexes live |

## Deployment

This is a **stateful long-running server**, and that is not incidental — the
recency list lives in memory, pages live on a real filesystem, the thread pool
is persistent, and the UI is fed by a long-lived SSE stream.

It runs unchanged on anything that gives you a persistent Node process:
Render, Railway, Fly.io, a container, or any VPS.

```bash
PORT=8080 STORE_DIR=/var/lib/pagecache node server.js
```

It will **not** work on a serverless platform such as Vercel Functions, and
not because of a missing config file — the architecture is the mismatch. Each
invocation is a fresh, isolated instance, so there is no shared cache to
promote entries in; the filesystem is read-only apart from `/tmp`, which is
per-instance and discarded; and an SSE stream would hold a function invocation
open against its timeout. A cache with no shared state is not a cache.

To put this on Vercel, the cache has to move into the browser: the same
`src/lru.js`, IndexedDB in place of the page files, and a Web Worker doing
WebCrypto for the rebuild cost. That version is a static site and deploys
anywhere — it just cannot read your process table, since browsers have no
access to it.

## License

MIT
