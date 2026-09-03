# Session log

A written record of the conversation that produced this project — what was
asked, what was decided, and what broke along the way. Reconstructed from the
session in order; it is a summary of the exchange and the work, not a verbatim
transcript.

Date: 2026-09-03 · macOS (darwin arm64), Node v24.14.0, 15 cores

---

## 1. "Demo the LRU cache on disk"

> *"i wanna demo the LRU least recently used cache on disk, lets make a web app
> with some system process and we can demo it, you can take examples from our
> cpu tasks and threads … i want a full end to end demo implementing and
> showing the proper implementation of the lru cache algorithm"*

Started from an empty directory. Key decision: make it **real** rather than an
animation of the algorithm.

- `src/lru.js` — the algorithm on its own: hash map + intrusive doubly linked
  list, O(1) lookup/promote/evict, no I/O and no async so it stays testable.
- `src/diskstore.js` — one file per page, atomic writes via `rename(2)`, an
  index that survives restart, append-only journal.
- `src/pool.js` + `src/worker.js` — a real `worker_threads` pool. A cache miss
  does genuine CPU work, so the timings are measured rather than invented.
- `src/policies.js` — FIFO, CLOCK, RANDOM, MRU and Belady's OPT, replaying the
  same trace for comparison.

**Calibration detour.** First attempt used `pbkdf2Sync(..., 65536, ...)` for a
64 KB page and took **2.2 s** at 10k iterations — pbkdf2 reruns the full
iteration count per 32-byte output block. Fixed by deriving a 32-byte seed and
expanding it with AES-CTR. Measured ~9,200 iterations/ms, so the UI can ask for
a fault "costing 90 ms" and get it.

Validated the policies against the textbook reference string
`1 2 3 4 1 2 5 1 2 3 4 5` at 3 frames: **LRU 10 faults, FIFO 9, OPT 7** — the
published numbers, including Belady's anomaly (LRU losing to FIFO).

## 2. "Don't overthink it"

> *"hey dont overthink this, we need just a demo for the lru on a simple web app"*

Stopped extending the backend and shipped the server plus one page. First
end-to-end result: miss **82.8 ms** on a worker thread, hit **0.35 ms** from
disk.

## 3. Sample vs live data, and "the UI is too tough"

> *"i need you to add some sample data, so we can have a sample data mode and a
> live data from your system mode … you have made the ui ux too tough for a
> normal person to understand, just see mobbin for some ui references and
> simplify the ui"*

- `src/sources.js` — a bundled deterministic trace (seeded PRNG, so it is
  identical on every machine) and a live reader of the real process table.
- Rewrote the UI: three numbers instead of five, plain English instead of
  jargon, everything advanced folded into a collapsed *Details* section.

**Could not use mobbin** — the MCP server needs OAuth and this session was
non-interactive. Said so and simplified against ordinary usability principles
instead.

## 4. "Simplify further"

> *"okay i just need you to simplify the ui a lot, dont show unnecessary data
> on screen"*

Cut the raw activity log and the SHA-1 file listing entirely. Down to: three
numbers, the cache itself, and one plain sentence about the last request.

## 5. Cross-platform live data, and mobile

> *"make sure the live data works on linux windows and mobile devices too, i
> dont want it to fail on mobile also improve the ui on mobile as well"*

Replaced the single `ps` call with ordered probes: `ps` (macOS/Linux/BSD) → a
direct `/proc` read with no subprocess (minimal containers) → PowerShell
`Get-Process` → `tasklist`. Each capped at 2.5 s.

Verified what could not be run natively:
- `/proc/PID/stat` field offsets against a real stat line whose process name
  contains both spaces and parentheses.
- Total failure, by emptying `PATH`: falls back to the sample process set with
  a clear message in **2 ms** — no crash, no hang.

Mobile: real breakpoints, 44 px targets, safe-area insets, two-up page cards.
The server reads the process table, not the browser, so phones work regardless
of the phone's OS.

## 6. Apple design language, glass

> *"lets simplify the ui further, use apple's design language and use glassy ui ux"*

Dark vibrancy: frosted `backdrop-filter` panels over a faint coloured ground,
system typography, system accent colours, a proper segmented control. First
pass was too saturated and hurt contrast, so the ground was toned down and a
dark scrim added behind it. Included a `@supports not (backdrop-filter)`
fallback and `prefers-reduced-motion`.

## 7. "Check app and run tests once"

Drove the app rather than just loading it. Step-through behaved exactly as the
algorithm should. Found one bug (see below).

## 8. "I feel you are messing up sample and this device"

Correct, and worse than it first looked. Investigating turned up two real
problems and then a third, deeper one. See the bug list.

## 9. "Start / Step / Empty are common in both modes"

> *"i think the start step and empty buttons are being common in both modes i
> need you to fix that fast"*

The right fix, and the one that also solved §8 properly: **two completely
independent caches**, one per data source, each with its own directory on
disk, its own request generator and its own counters. Switching modes now just
changes which cache you are looking at. The thread pool stays shared, which is
correct — it represents the machine's cores, and there is one machine.

## 10. "Do tests and check everything"

The rewritten server had no test coverage, so added `test/server.test.js`: 19
end-to-end tests against a real server process on a spare port with a
throwaway store. It immediately caught a live bug (§ pattern reset below).

Then checked the UI under its worst case (`scan`, where the cache turns over
constantly) and found three more problems — an invisible chain, a scan that
read 4% instead of 0%, and a stampede that merged almost nothing. All fixed
and covered.

**50 tests total** — 17 algorithm, 13 disk integration, 20 server.

---

## Bugs found and fixed

| # | Bug | Cause |
|---|---|---|
| 1 | Process exited before jobs finished | Workers were permanently `unref()`d; now ref'd only while busy |
| 2 | Thread load 703/132/3/0 | Dispatch always scanned from worker 0; added a round-robin cursor → 19/18/18/18 |
| 3 | The victim end of the chain was off-screen | Chain scrolled horizontally; made it wrap, and extended the FLIP animation to 2-D |
| 4 | Reloading the page reset server config | Sliders pushed their defaults on load; they now adopt server state |
| 5 | Stray spaces around bold values | `gap` on a flex container spaces text nodes too; switched to inline layout |
| 6 | Live data labelled "Sample" after reload | Client assumed `sample`; now adopts the server's actual source |
| 7 | Pages from both sources in one cache | Switching source cleared nothing — later solved outright by one cache per mode |
| 8 | Sample names indistinguishable from real ones | `node`, `mds_stores`, `kernel_task` are real macOS processes; sample now uses invented app names (`Browser`, `Editor`, `Chat`…) in a synthetic PID band |
| 9 | A flush could be undone by an in-flight fault | `clear()` didn't cancel running faults, so one dispatched before a flush landed after it and revived a page. Added a generation counter |
| 10 | An empty cache still described a page | `lastAccess` survived `clear()`/`resetMetrics()` |
| 11 | **Pressing Start silently reverted the chosen pattern and wiped the cache** | `/api/workload` called `setPattern(body.pattern)` with `undefined`. Caught by the new server tests |
| 12 | The page list rendered invisible under fast turnover | `replaceChildren` re-inserted every card on each state push, restarting the CSS entrance animation so nothing reached full opacity. Now the DOM is only rebuilt when the order changes, and the class is dropped after it plays once |
| 13 | Scan read 4% instead of 0% | When the server auto-resumed after a pattern change it reused the previous `concurrency: 6`. Concurrency is now derived from the pattern server-side, so it is right however the workload restarts |
| 14 | The stampede pattern merged almost nothing (2 of 118) | At 12 requests/s no two callers arrive inside the ~90 ms rebuild window, so there was nothing to coalesce. Rate is now derived from the pattern too — 708 requests, 10 rebuilds, 110 merged |
| 15 | The size label could disagree with the real capacity | The slider only read the server on page load; it now follows server state unless being dragged |

## Things deliberately left as they are

- **Concurrency changes the measured hit rate.** A scan got 33% under
  concurrency where serial LRU gets exactly 0% — because with faults in flight
  pages are admitted in *completion* order, breaking the pathological
  alignment. Not a bug. The teaching patterns (`scan`, textbook) therefore run
  strictly serially so they match theory, and the tests assert 0%.
- **`launchd[1]` appears in live data with PID 1.** Real process, real PID.
  During debugging my own sample-vs-live detector tripped on it, which is
  precisely why sample names are now unmistakable.
- **Threads often look idle.** At 12 requests/s with a ~50% hit rate the fault
  load is well under one core, so most threads genuinely have nothing to do.
  Raising the fault cost or choosing a harsher pattern fills them.
