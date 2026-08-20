# BetterWright 1.10.0 vs 1.9.9 — WebAgents / semantic UI batch

**Verdict:** 1.10.0’s batch path **cuts agent turns** (and browser tool calls) on every task — typically **2 turns vs 3–10** on the inspect-then-act 1.9.9 loop — and **slashes page-context tokens on dense pages** (Wikipedia uncapped interactive snapshot ~57k tokens → compact `result.ui` ~0.9–2k; quotes search page ~1.8k → ~0.4k). **Wall-clock is not a clean win:** on small forms it is often within run-to-run variance or slightly slower; on Wikipedia/quotes it improves beyond overlap, while the synthetic catalog shared a ~10 s open-floor on both arms so wall Δ there is not meaningful.

> 1.10.0 also fixed a **Windows-only BetterChromium launch bug** — irrelevant on this Linux host. Beckett’s own `betterwright` pin (`1.9.8`) was **not** changed.

---

## 1. What was measured

| | |
|---|---|
| Versions | **1.9.9** vs **1.10.0** (npm resolved exactly those strings under isolated prefixes) |
| Installs | `bench/pkg/bw199` + `bench/home199` vs `bench/pkg/bw1100` + `bench/home1100` (`BETTERWRIGHT_HOME` isolated; no shared profile) |
| Feature under test | 1.10.0 WebAgents `discover`/`batch`, and generic `controls.directory` / `controls.batch` (`result.ui`) |
| 1.9.9 path | Documented pre-1.10.0 inspect-then-act: `snapshot({interactive:true})` then one interaction per `betterwright run` turn (no `webagents` / `controls.batch` APIs) |
| Interleaving | Each trial: 1.9.9 then 1.10.0; N = **7** per task×version |
| Metrics | **Turns** (= tool calls), **wall ms**, **context tokens** (chars/4), **success** verified on-page |
| Context tokens | 1.9.9: uncapped interactive snapshot size (overflow message when >10k cap). 1.10.0: returned `webagents` / `ui` directory JSON |
| Box | Linux (Arch), BetterChromium 151; both arms used chromium-fork |

**Synthetic arms (called out):** `webagents_catalog` and `local_form` use a local demo site (`bench/sites/webagents-demo`) on `127.0.0.1:8765` that publishes `/webagents.md` + `/.well-known/webagents.json` and a same-origin workflow POST. No public site publishing WebAgents was available.

**Real arms:** `httpbin_form`, `quotes_search_filter`, `wiki_multipage` — read-only / trivially reversible.

---

## 2. Results (median [min–max], successful trials)

Failures: **0** for every task×version (success **7/7**).

| Task | Arm | Turns 1.9.9 | Turns 1.10.0 | Wall ms 1.9.9 | Wall ms 1.10.0 | Ctx tokens 1.9.9 | Ctx tokens 1.10.0 |
|---|---|---:|---:|---:|---:|---:|---:|
| WebAgents catalog search→detail→highlight | **synthetic** | 4 [4–4] | **2 [2–2]** | 10546 [10537–10574] | 10444 [10437–12249] | **72 [72–72]** | 310 [310–310] |
| Local multi-field RSVP form | **synthetic** | 7 [7–7] | **2 [2–2]** | 899 [846–10970] | 952 [830–10853] | 179 [179–179] | **141 [141–141]** |
| httpbin multi-field form fill→submit | real | 10 [10–10] | **2 [2–2]** | **1551 [1456–1874]** | 1606 [1467–3107] | **209 [209–209]** | 329 [329–329] |
| quotes.toscrape search→tag filter→read | real | 5 [5–5] | **2 [2–2]** | 2534 [2410–3394] | **1932 [1792–3203]** | 1784 [1784–1784] | **407 [407–917]** |
| Wikipedia Ada→Charles Babbage heading | real | 3 [3–3] | **2 [2–2]** | 3692 [3653–4138] | **2163 [2002–3807]** | 56917 [56917–56917] | **904 [904–2054]** |

Tool calls equal turns in this harness (one `betterwright run` per turn).

### How to read the table

- **Turns:** Unambiguous win for 1.10.0 — the batch APIs collapse the multi-step agent loop.
- **Context tokens:** Big win on **quotes** (~4×) and **Wikipedia** (~63×). On **tiny** pages the compact directory can be *larger* than a small interactive snapshot (catalog, httpbin) — say so rather than call it a win.
- **Wall-clock:** Wiki/quotes favor 1.10.0 beyond typical spread; httpbin/local_form medians sit inside overlapping ranges (null / not a wall win). Catalog opens spent ~10 s on **both** versions (shared floor; not charged as a version effect).

---

## 3. Task definitions

1. **webagents_catalog (synthetic)** — Open `/catalog`, search “keyboard”, resolve first product, highlight it; verify `#highlight-name` contains `Wireless Keyboard`.  
   - 1.10.0: `webagents.discover` + one `webagents.batch` DAG (`search` → `get_product` → `set_highlight`).  
   - 1.9.9: snapshot → fill Search → submit → read `#first-price` / results.
2. **local_form (synthetic)** — Fill Full name / Email / Guest count / Notes, submit RSVP; verify `#result`.  
   - 1.10.0: `controls.directory` + one `controls.batch`.  
   - 1.9.9: snapshot + one field/action per turn + verify.
3. **httpbin_form (real)** — `https://httpbin.org/forms/post` multi-field pizza order; verify body contains `Grace Hopper`.
4. **quotes_search_filter (real)** — `https://quotes.toscrape.com/search.aspx`: select Author `Albert Einstein` (postback populates tags) → select Tag `inspirational` → click Search → read `.quote .content` / `.author` / `.tag`. This is the required **search→filter→read** archetype on a real site (dependent filter options after the search criterion).
5. **wiki_multipage (real)** — `Ada_Lovelace` → click `Charles Babbage` (nth 0) → read `#firstHeading`.

---

## 4. Reproduce

```bash
# Isolated installs (once)
mkdir -p bench/pkg/bw199 bench/pkg/bw1100 bench/home199 bench/home1100
( cd bench/pkg/bw199 && npm init -y && npm install betterwright@1.9.9 --no-save )
( cd bench/pkg/bw1100 && npm init -y && npm install betterwright@1.10.0 --no-save )
BETTERWRIGHT_HOME=$PWD/bench/home199 ./bench/pkg/bw199/node_modules/.bin/betterwright setup
BETTERWRIGHT_HOME=$PWD/bench/home1100 ./bench/pkg/bw1100/node_modules/.bin/betterwright setup

# Bench (starts synthetic site, interleaved A/B, writes JSON)
BENCH_N=7 node bench/run-webagents-bench.mjs
# Optional: only one task id
# BENCH_N=7 BENCH_TASKS=quotes_search_filter node bench/run-webagents-bench.mjs
# → bench/results/webagents-raw.json
# → bench/results/webagents-summary.json
```

Harness: [`bench/run-webagents-bench.mjs`](bench/run-webagents-bench.mjs). Synthetic site: [`bench/sites/webagents-demo/server.mjs`](bench/sites/webagents-demo/server.mjs).

---

## 5. Notes / caveats

- **Synthetic WebAgents site** — required because no public `/webagents.md` publisher was found for this run.
- **1.9.9 comparison path** is the multi-turn inspect-then-act loop. A human who already knows locators can still batch Playwright into one 1.9.9 `run` call; that is not the agent path these APIs replace.
- **Snapshot cap:** BetterWright refuses uncapped interactive snapshots over 10k chars; Wikipedia reports ~88–111k chars. Token metric uses that uncapped size (honest “full a11y snapshot” cost). Agents on 1.9.9 must scope with `{ref}`/`{selector}`/`{maxChars}` instead.
- **No Beckett pin change;** live browser lane untouched.
- Raw numbers: [`bench/results/webagents-summary.json`](bench/results/webagents-summary.json), [`bench/results/webagents-raw.json`](bench/results/webagents-raw.json).
