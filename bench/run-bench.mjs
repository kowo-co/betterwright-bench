#!/usr/bin/env node
// Interleaved A/B/A/B benchmark: betterwright 1.6.3 vs 1.7.0 on one fixed workload.
// Every number here is measured on this box. Nothing is estimated.
//
// Metrics:
//   1. cold start   - wall time: process launch -> usable session -> first page loaded (no daemon)
//   2. warm nav     - navigation ms on a live (daemon) session
//   3. warm dom     - DOM read ms (title + link count) on the loaded page
//   4. snapshot     - structured page-read (snapshot({interactive:true})) ms + output bytes
//   5. reliability  - failures out of N per version
//   6. peak RSS     - summed RSS (driver + browser tree) during an identical active run
//
// Interleaving: for every iteration we run A then B back-to-back, so any machine/network
// drift over the run is shared by both versions and cannot be charged to one version.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const URL = 'https://example.com/';
const N = 12;          // measured iterations per metric (>= 10 required)
const SESSION = 'bench';

const VERSIONS = [
  { key: 'v163', label: '1.6.3', bin: `${ROOT}/bench/pkg/bw163/node_modules/.bin/betterwright`, home: `${ROOT}/bench/home163` },
  { key: 'v170', label: '1.7.0', bin: `${ROOT}/bench/pkg/bw170/node_modules/.bin/betterwright`, home: `${ROOT}/bench/home170` },
];

function nowMs() { const [s, n] = process.hrtime(); return s * 1000 + n / 1e6; }

// Run one `betterwright run` invocation. Returns { ok, wallMs, json, stderr, code }.
function bwRun(v, { snippet, noDaemon = false, session = SESSION }) {
  return new Promise((resolve) => {
    const args = ['run'];
    if (noDaemon) args.push('--no-daemon');
    else args.push('--session', session);
    args.push('-c', snippet);
    const t0 = nowMs();
    const child = spawn(v.bin, args, {
      env: { ...process.env, BETTERWRIGHT_HOME: v.home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      const wallMs = nowMs() - t0;
      let json = null;
      try { json = JSON.parse(out); } catch { /* keep null */ }
      const res = json && json.result ? json.result : {};
      const ok = code === 0 && json && json.ok === true && !json.error;
      resolve({ ok, wallMs, json, res, stderr: err.trim(), code });
    });
  });
}

const COLD_SNIPPET =
  `const t0=Date.now(); await page.goto('${URL}',{waitUntil:'load'}); const t1=Date.now(); const title=await page.title(); return {title, navMs:t1-t0};`;

const WARM_SNIPPET =
  `const t0=Date.now(); await page.goto('${URL}',{waitUntil:'load'}); const t1=Date.now();` +
  `const title=await page.title(); const links=await page.locator('a').count(); const t2=Date.now();` +
  `const snap=await snapshot({interactive:true}); const t3=Date.now();` +
  `const bytes=(typeof snap==='string'?snap:JSON.stringify(snap)).length;` +
  `return {navMs:t1-t0, domMs:t2-t1, snapMs:t3-t2, snapBytes:bytes, links, title};`;

// RSS sampler: sum resident set size (KB) of every process whose args reference this home.
function sampleRssKB(homePath) {
  try {
    const out = execSync(`ps -eo rss=,args= 2>/dev/null`, { encoding: 'utf8' });
    let sum = 0;
    for (const line of out.split('\n')) {
      if (!line.includes(homePath)) continue;
      const m = line.trim().match(/^(\d+)\s/);
      if (m) sum += parseInt(m[1], 10);
    }
    return sum; // KB
  } catch { return 0; }
}

function closeAll(v) {
  try { execSync(`${v.bin} close --all`, { env: { ...process.env, BETTERWRIGHT_HOME: v.home }, stdio: 'ignore' }); } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const raw = { url: URL, N, iso: new Date().toISOString(), versions: {} };
  for (const v of VERSIONS) raw.versions[v.key] = { label: v.label, cold: [], warm: [], failures: { cold: 0, warm: 0 }, peakRssKB: null };

  // ---- 1. COLD START (no daemon), interleaved A/B ----
  console.error(`\n== cold start, N=${N}, interleaved ==`);
  for (const v of VERSIONS) closeAll(v);
  for (let i = 0; i < N; i++) {
    for (const v of VERSIONS) {
      const r = await bwRun(v, { snippet: COLD_SNIPPET, noDaemon: true });
      if (!r.ok) { raw.versions[v.key].failures.cold++; console.error(`  ! ${v.label} cold #${i} FAIL code=${r.code} ${r.stderr.slice(0,120)}`); }
      raw.versions[v.key].cold.push({ i, ok: r.ok, wallMs: +r.wallMs.toFixed(2), navMs: r.res?.navMs ?? null });
      process.stderr.write(`  ${v.label} cold #${i} wall=${r.wallMs.toFixed(0)}ms nav=${r.res?.navMs ?? 'x'}\n`);
    }
  }

  // ---- warm daemon: prime each session once (not counted) ----
  console.error(`\n== priming warm daemons ==`);
  for (const v of VERSIONS) {
    const r = await bwRun(v, { snippet: WARM_SNIPPET });
    console.error(`  ${v.label} prime ok=${r.ok} nav=${r.res?.navMs ?? 'x'}`);
  }

  // ---- 2/3/4. WARM nav + DOM + snapshot, interleaved A/B ----
  console.error(`\n== warm nav/dom/snapshot, N=${N}, interleaved ==`);
  for (let i = 0; i < N; i++) {
    for (const v of VERSIONS) {
      const r = await bwRun(v, { snippet: WARM_SNIPPET });
      if (!r.ok) { raw.versions[v.key].failures.warm++; console.error(`  ! ${v.label} warm #${i} FAIL code=${r.code} ${r.stderr.slice(0,120)}`); }
      raw.versions[v.key].warm.push({
        i, ok: r.ok, wallMs: +r.wallMs.toFixed(2),
        navMs: r.res?.navMs ?? null, domMs: r.res?.domMs ?? null,
        snapMs: r.res?.snapMs ?? null, snapBytes: r.res?.snapBytes ?? null,
      });
      process.stderr.write(`  ${v.label} warm #${i} nav=${r.res?.navMs ?? 'x'} dom=${r.res?.domMs ?? 'x'} snap=${r.res?.snapMs ?? 'x'} bytes=${r.res?.snapBytes ?? 'x'}\n`);
    }
  }

  // ---- 6. PEAK RSS: one identical active run per version, sampled in isolation ----
  console.error(`\n== peak RSS (isolated, sampled) ==`);
  for (const v of VERSIONS) {
    for (const other of VERSIONS) closeAll(other); // ensure only this home has live procs
    // background: 4 sequential navigations to keep the browser resident & busy ~2-3s
    const busy = bwRun(v, { snippet:
      `for(let k=0;k<4;k++){await page.goto('${URL}',{waitUntil:'load'}); await snapshot({interactive:true});} return {done:true};` });
    let peak = 0;
    for (let s = 0; s < 40; s++) { // ~4s of sampling @100ms
      const kb = sampleRssKB(v.home);
      if (kb > peak) peak = kb;
      await sleep(100);
    }
    await busy;
    raw.versions[v.key].peakRssKB = peak;
    console.error(`  ${v.label} peak RSS = ${(peak/1024).toFixed(1)} MiB`);
    closeAll(v);
  }

  writeFileSync(`${ROOT}/bench/results/raw.json`, JSON.stringify(raw, null, 2));
  console.error(`\nwrote bench/results/raw.json`);

  // ---- summary stats ----
  const pct = (arr, p) => { const a = arr.filter((x) => x != null).slice().sort((x, y) => x - y); if (!a.length) return null; const idx = Math.ceil(p / 100 * a.length) - 1; return a[Math.max(0, Math.min(idx, a.length - 1))]; };
  const med = (a) => pct(a, 50);
  const fmt = (x) => x == null ? 'n/a' : x.toFixed(1);
  const summary = {};
  for (const v of VERSIONS) {
    const c = raw.versions[v.key];
    const cold = c.cold.map((x) => x.wallMs);
    const nav = c.warm.map((x) => x.navMs);
    const dom = c.warm.map((x) => x.domMs);
    const snap = c.warm.map((x) => x.snapMs);
    const bytes = c.warm.map((x) => x.snapBytes);
    summary[v.label] = {
      coldWall_med: med(cold), coldWall_p90: pct(cold, 90),
      nav_med: med(nav), nav_p90: pct(nav, 90),
      dom_med: med(dom), dom_p90: pct(dom, 90),
      snap_med: med(snap), snap_p90: pct(snap, 90),
      snapBytes_med: med(bytes),
      failures: c.failures.cold + c.failures.warm,
      peakRssMiB: c.peakRssKB != null ? +(c.peakRssKB / 1024).toFixed(1) : null,
    };
  }
  writeFileSync(`${ROOT}/bench/results/summary.json`, JSON.stringify(summary, null, 2));
  console.error('\n== SUMMARY (median / p90) ==');
  for (const [label, s] of Object.entries(summary)) {
    console.error(`${label}: cold ${fmt(s.coldWall_med)}/${fmt(s.coldWall_p90)}  nav ${fmt(s.nav_med)}/${fmt(s.nav_p90)}  dom ${fmt(s.dom_med)}/${fmt(s.dom_p90)}  snap ${fmt(s.snap_med)}/${fmt(s.snap_p90)}ms  bytes ${fmt(s.snapBytes_med)}  fails ${s.failures}  rss ${fmt(s.peakRssMiB)}MiB`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
