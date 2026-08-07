# BetterWright 1.7.0 vs 1.6.3 — Benchmark Report

**Verdict: UPGRADE (with one caveat).** For Beckett's persistent-daemon browser lane, 1.7.0 uses **~18× less memory** (40 MiB vs 741 MiB), is **faster on every warm per-op metric and on daemon cold-start**, produces smaller structured reads, had **zero failures**, and introduces **no client-API or MCP breaking change** — *provided its Obscura backend is installed* (`betterwright update`); the only regression is that one-shot `--no-daemon` invocations get ~3× slower.

> The global install was upgraded to 1.7.0 after measurement — see [§7](#7-global-install-change-done).

---

## 1. What was tested

| | |
|---|---|
| Tool | BetterWright — persistent, policy-guarded Playwright browser for AI agents; the driver behind `beckett browser` / `beckett browser exec`. |
| Versions | `1.6.3` (previous global) vs `1.7.0` (npm `latest`). |
| Install | Side-by-side scratch prefixes, invoked by absolute path. Global install **left at 1.6.3 for the entire measurement**; swapped only afterward. |
| Backend selected | 1.6.3 → **CloakBrowser** (Chromium 146, 8 processes). 1.7.0 → **Obscura 0.1.11** resident DOM engine (1 process). This is each version's *default* backend on this box after a standard `install` + `update`. |
| Workload page | `https://example.com/` — a stable, static public page (identical bytes each load, so a page change can't be mistaken for a version effect). |
| Iterations | N = 12 measured iterations per metric (cold + warm), **interleaved A/B/A/B** so machine/network drift is shared by both versions. Reliability counted over all 24 measured runs/version. |
| Box | Intel Core i7-4790 (8 threads, 3.6 GHz), 31 GiB RAM, Linux 7.1.4-arch1. GPU: **Intel integrated (4th-gen HD Graphics)** — no discrete GPU (see [§6](#6-what-was-not-measured)). |
| Harness | [`bench/run-bench.mjs`](bench/run-bench.mjs) (committed). Raw output: [`bench/results/raw.json`](bench/results/raw.json). |

---

## 2. Comparison table (median / p90)

All times in **ms** unless noted. Lower is better for every row.

| Metric | 1.6.3 (median / p90) | 1.7.0 (median / p90) | Δ median | Winner |
|---|---|---|---|---|
| **Cold start — daemon boot** (launch → live session → first page)¹ | 1220 / 1237 | **1003 / 1016** | **−18%** | **1.7.0** |
| **Cold start — `--no-daemon` one-shot** (launch → nav → teardown) | **1278 / 1357** | 3855 / 3887 | **+201% (≈3× slower)** | 1.6.3 |
| **Warm navigation** (`page.goto`, live session) | 44 / 53 | **36 / 40** | **−18%** | **1.7.0** |
| **Warm DOM read** (`title` + `locator('a').count()`) | 16 / 21 | **6 / 7** | **−63% (≈2.7×)** | **1.7.0** |
| **Structured snapshot** (`snapshot({interactive:true})`) time | 9 / 13 | **7 / 8** | **−22%** | **1.7.0** |
| **Snapshot output size** (bytes) | 93 / 93 | **78 / 78** | **−16%** | **1.7.0** |
| **Reliability** (failures / 24 runs) | **0** | **0** | — | tie |
| **Peak RSS** — driver + browser tree, one identical run (MiB) | 741.2 | **39.9** | **−94.6% (≈18.6×)** | **1.7.0** |
| **Resident processes** during an active run | 8 (chrome) | **1 (obscura)** | −7 | **1.7.0** |

¹ Cold start is reported two ways because they diverge sharply and mean different things. **Daemon boot** is the number Beckett actually experiences — `beckett browser` runs a persistent daemon, so the boot cost is paid once and then every op is warm. **`--no-daemon` one-shot** is the worst case for Obscura: it spins the resident engine up and tears it down inline for a single call. The whole one-shot penalty is engine boot, *not* page load — 1.7.0's cold *navigation* is actually faster (median 151 ms vs 213 ms); it's the ~3.7 s Obscura inline boot (vs ~1.1 s for Cloak) that dominates.

---

## 3. Raw per-iteration numbers

Full machine-readable data: [`bench/results/raw.json`](bench/results/raw.json), [`bench/results/summary.json`](bench/results/summary.json), [`bench/results/daemon-cold.json`](bench/results/daemon-cold.json).

**Cold start — `--no-daemon` one-shot, wall ms**
```
1.6.3: 1356.6 1303.0 1327.4 1327.1 1244.9 1268.5 1260.6 1248.2 1403.7 1281.6 1277.8 1234.2
1.7.0: 3855.3 3835.7 3862.4 3887.1 3855.0 3838.1 3859.9 3853.1 3873.0 3946.0 3849.5 3843.7
```

**Cold start — daemon boot, wall ms (6 interleaved iters)**
```
1.6.3: 1220 1235 1204 1237 1179 1233
1.7.0: 1016 1004 1013 1003  979  977
```

**Warm navigation, ms**
```
1.6.3: 48 41 50 44 40 53 42 42 55 46 43 50
1.7.0: 41 37 36 37 40 33 34 36 40 36 40 33
```

**Warm DOM read, ms**
```
1.6.3: 16 16 24 18 20 15 15 21 12 16 14 14
1.7.0:  9  5  7  6  6  5  6  5  6  5  6  5
```

**Snapshot time, ms**
```
1.6.3: 7 11 13 13 9 7 11 11 10 9 7 8
1.7.0: 7  8  8  7 7 6  7  7  6 9 6 7
```

**Snapshot output size, bytes** (constant per version on this page)
```
1.6.3: 93 (×12)      1.7.0: 78 (×12)
```

**Peak RSS breakdown, one active run** (summed RSS of all processes referencing the isolated home)
```
1.6.3: 8 chrome procs  → 208.1 + 117.4 + 89.5 + 86.8 + 63.3 + 62.1 + 61.8 + 43.3  ≈ 741 MiB
1.7.0: 1 obscura proc  → 39.6 MiB
```
> Caveat on RSS: summed RSS over-counts shared/copy-on-write pages, so 741 MiB is an upper bound for 1.6.3's true footprint. It is directionally correct and the two versions are measured identically, so the ~18× gap is real regardless.

---

## 4. Methodology

- **Isolation.** Each version ran under its own `BETTERWRIGHT_HOME` (`bench/home163`, `bench/home170`) so their daemons/profiles never collided, and neither touched the live global `~/.betterwright` profile during measurement.
- **Interleaving.** Every iteration runs `1.6.3` then `1.7.0` back-to-back before advancing. Any drift (network, CPU contention) lands on both versions in the same iteration and cannot be attributed to one version.
- **Where each timer lives.** Per-op latencies (`nav`, `dom`, `snap`) are measured *inside* the browser worker with `Date.now()` around the exact call, so Node process-startup overhead (identical for both, same Node v26.4.0) is excluded. Cold-start numbers are outer wall-clock (`process.hrtime`) because "process launch → usable session" is the thing being measured.
- **Warm vs cold.** Warm metrics run against an already-primed persistent daemon session (one un-counted priming call first). Cold metrics start from no daemon.
- **Percentiles.** Median = p50, p90 = nearest-rank, computed over the 12 measured iterations.
- **Reliability.** A run counts as a failure if the process exits non-zero, emits no parseable JSON, or returns `ok:false`/an `error`. 0/24 for both versions.
- **Peak RSS.** Measured in isolation (other version's daemon closed first), sampling `ps -eo rss,args` every 100 ms for ~4 s during an identical 4-navigation active run, summing every process whose args reference that version's home, and taking the peak.
- **Reproduce:** `cd` to the repo and run `node bench/run-bench.mjs` (both scratch prefixes must be installed; see [`bench/run-bench.mjs`](bench/run-bench.mjs) header).

---

## 5. Changelog & dist diff — and the breaking-change analysis

Both packages were `npm pack`-installed and their `dist/`, `types/`, `package.json`, and `CHANGELOG.md` compared directly.

### What changed
- **Dependencies: identical.** Both pin `cloakbrowser@0.4.10`, `playwright-core@1.61.1`, `tldts@7.4.9`, optional `patchright-core@1.61.1`. No dependency bump.
- **New `dist` files in 1.7.0:** `obscura.js`, `obscura-runtime.js`, `obscura-install.js` (the resident DOM engine), plus `site-request.js`, `site-tools.js` (a new frozen same-origin `site` surface for app/puzzle tooling).
- **Backend model.** Ordinary headless work moves from a multi-process Chromium/Cloak renderer to Obscura's resident DOM runtime. Normal proof PNGs render via one bounded Obscura canvas call — **no Chromium launch** for normal proofs.
- **Agent skill shrank:** `SKILL.md` 1421 → 647 words (release notes: 23.1% fewer tokens, 19.9% less wall time in their eval). Cheaper agent loops.
- **Live view** became a full browser (address bar, back/forward/reload, tabs) — UI only.
- 1.6.3 itself was a guard-RPC caching release (95 guard RPCs → 1 on a 50-subresource load); that work carries into 1.7.0.

### Breaking changes affecting Beckett's browser lane — **NONE in the API surface**
This is the most important finding for live infrastructure, and it is verified, not assumed:

- **`types/*.d.ts` are byte-identical between 1.6.3 and 1.7.0** (`diff -rq` → no differences). The public BetterWright client/exports contract did not change.
- **MCP tool names are identical:** `browser`, `browser_login`, `browser_download`, `browser_handoff`, `browser_doctor`. The MCP surface Beckett consumes is unchanged.
- **CLI top-level commands unchanged.** (`run`, `exec`, `repl`, `sessions`, `mcp`, etc.)
- The `run`/MCP globals Beckett's lane uses (`page`, `snapshot`, `screenshot`, locators, `credentials`, `human`) all work on 1.7.0 — measured: `page.goto`, `page.title`, `locator('a').count()`, and `snapshot({interactive:true})` all returned correctly against Obscura, and the upgraded global lane was smoke-tested end-to-end ([§7](#7-global-install-change-done)).

### The one behavioral caveat to know
1.7.0's default headless backend is Obscura, a DOM runtime — **not** full Chromium. The changelog states that APIs needing full-browser subsystems — **downloads, uploads, service workers, multiple pages/frames, explicit page-network calls, manual credential entry, and any headed / live-view session** — **"promote once without client-side changes"** to the Cloak/Chromium compatibility backend and stay resident for that session. So:
- **Functionally nothing breaks** — those paths transparently fall back to the same Chromium/Cloak engine 1.6.3 used.
- **But** the *first* use of such a feature in a session pays a one-time promotion cost (Chromium launch: RAM + latency jump back toward the 1.6.3 numbers). A lane that immediately needs downloads/uploads/multi-page/headed will not see the memory win.
- **The win is contingent on Obscura being installed.** If `betterwright update` has *not* fetched Obscura, 1.7.0 silently falls back to Cloak and its gains disappear — you'd be running 1.6.3's engine under a 1.7.0 label. On this box Obscura installed cleanly (checksum-pinned `0.1.11`) and `doctor` reports `In use: obscura`.

---

## 6. What was NOT measured (stated, not estimated)

- **GPU / WebGPU rendering.** This box has only Intel integrated graphics (no discrete GPU); WebGPU would run on SwiftShader software. These workloads are DOM/headless and GPU-independent, so no GPU-bound number is meaningful here and none was produced.
- **Proof/painted screenshot latency.** The structured-read cost was measured via `snapshot()` (the read Beckett's agent loop uses). `screenshot({kind:'proof'})` timing was not separately benchmarked in this run; 1.7.0 changes how proofs render (bounded Obscura canvas vs Chromium), so that is a known-different path left unmeasured rather than guessed.
- **`--no-daemon` promotion internals.** The ~3.7 s Obscura inline boot in one-shot mode was measured as wall time but not decomposed further.
- **Long-session drift / many-tab / cross-site challenge-scan** workloads (1.6.3's own perf harness targets these). Out of scope for this single-page A/B.

---

## 7. Global install change (DONE)

The global install was **left at 1.6.3 for the entire measurement**. Only after all numbers were collected, and because 1.7.0 is a clear win for Beckett's daemon-based lane with no API/MCP breaking change, the global was upgraded:

```
npm i -g betterwright@1.7.0        # global: 1.6.3 → 1.7.0
```

Verified after the swap:
- `betterwright --version` → `1.7.0`
- `betterwright doctor` → `Browser … In use: obscura` (Obscura 0.1.11 resident engine)
- End-to-end smoke on the **default** home/daemon: `page.goto` + `snapshot()` returned `ok:true`, daemon reported `v1.7.0`. Beckett's browser lane is functional on 1.7.0.

**Note on the Obscura binary:** `betterwright update` installed Obscura to the shared `~/.betterwright/obscura/` (it ignores `BETTERWRIGHT_HOME` for the engine binary). This adds a browser binary to the shared home but does **not** alter the betterwright package version, and 1.6.3 has no Obscura code path, so the previously-running global (1.6.3) was unaffected throughout measurement.

**Rollback** if the lane ever misbehaves: `npm i -g betterwright@1.6.3` (1.6.3 remains fully functional on this box; its Cloak backend is still installed).

---

## 8. One-line verdict

**Upgrade to 1.7.0** — large memory win (~18×), faster warm ops and daemon cold-start, zero failures, and no client/MCP API break — **with the caveat** that the gains require Obscura to be installed and that one-shot `--no-daemon` invocations get ~3× slower.
