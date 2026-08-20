#!/usr/bin/env node
/**
 * Interleaved A/B benchmark: betterwright 1.9.9 vs 1.10.0 on WebAgents + semantic UI.
 *
 * Metrics (per trial, then median + spread across N):
 *   turns          — number of `betterwright run` invocations (one model↔tool round trip each)
 *   wallMs         — end-to-end wall clock for the whole task
 *   contextTokens  — estimated tokens of page context fed to the model (chars/4),
 *                    summing snapshot / webagents / result.ui payloads across turns
 *   toolCalls      — same as turns here (each run is one browser tool call)
 *   success        — verified on-page (not merely ok:true from the tool)
 *
 * Paths:
 *   1.10.0 — documented fast path: open → webagents.batch / controls.batch
 *   1.9.9  — inspect-then-act loop (snapshot + one interaction per turn) because
 *            it has no webagents / controls.batch APIs
 *
 * Arms alternate 1.9.9 → 1.10.0 each iteration. Isolated BETTERWRIGHT_HOME per version.
 */
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const N = Number(process.env.BENCH_N || 7);
const SITE_PORT = Number(process.env.WEBAGENTS_PORT || 8765);
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const SESSION = 'webagents-bench';

const VERSIONS = [
  {
    key: 'v199',
    label: '1.9.9',
    bin: join(ROOT, 'bench/pkg/bw199/node_modules/.bin/betterwright'),
    home: join(ROOT, 'bench/home199'),
  },
  {
    key: 'v1100',
    label: '1.10.0',
    bin: join(ROOT, 'bench/pkg/bw1100/node_modules/.bin/betterwright'),
    home: join(ROOT, 'bench/home1100'),
  },
];

function nowMs() {
  const [s, n] = process.hrtime();
  return s * 1000 + n / 1e6;
}

function estTokens(text) {
  if (text == null) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(s.length / 4);
}

function bwRun(v, snippet, { session = SESSION, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const args = ['run', '--session', session, '-c', snippet];
    const t0 = nowMs();
    const child = spawn(v.bin, args, {
      env: { ...process.env, BETTERWRIGHT_HOME: v.home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      const wallMs = nowMs() - t0;
      let json = null;
      try { json = JSON.parse(out); } catch { /* keep null */ }
      const ok = code === 0 && json && json.ok === true && !json.error;
      resolve({ ok, wallMs, json, stderr: err.trim(), code, rawOut: out });
    });
  });
}

function closeAll(v) {
  try {
    execSync(`${v.bin} close --all`, {
      env: { ...process.env, BETTERWRIGHT_HOME: v.home },
      stdio: 'ignore',
    });
  } catch { /* ignore */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startSite() {
  const child = spawn(process.execPath, [join(ROOT, 'bench/sites/webagents-demo/server.mjs')], {
    env: { ...process.env, WEBAGENTS_PORT: String(SITE_PORT), WEBAGENTS_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function waitForSite(ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${SITE}/health`);
      if (r.ok) return;
    } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error(`Synthetic site not up on ${SITE}`);
}

function contextFromEnvelope(json) {
  // Tokens of page context the model sees this turn (chars/4).
  // Prefer explicit probes in result; else envelope webagents/ui.
  let tokens = 0;
  const kind = [];
  const res = json?.result && typeof json.result === 'object' ? json.result : null;

  if (res && typeof res.snapshotCharsUncapped === 'number') {
    tokens += Math.ceil(res.snapshotCharsUncapped / 4);
    kind.push('snapshot-uncapped');
  } else if (res?.webagents != null) {
    tokens += estTokens(res.webagents);
    kind.push('result.webagents');
  } else if (res?.ui != null) {
    tokens += estTokens(res.ui);
    kind.push('result.ui');
  } else if (res?.snapshot != null) {
    const text = typeof res.snapshot === 'string' ? res.snapshot : JSON.stringify(res.snapshot);
    const overflow = text.match(/Snapshot is (\d+) chars/);
    if (overflow) {
      tokens += Math.ceil(Number(overflow[1]) / 4);
      kind.push('snapshot-overflow-reported');
    } else {
      tokens += estTokens(text);
      kind.push('snapshot');
    }
  } else if (json?.webagents) {
    tokens += estTokens(json.webagents);
    kind.push('envelope.webagents');
  } else if (json?.ui) {
    tokens += estTokens(json.ui);
    kind.push('envelope.ui');
  }

  // After a batch that navigates, a refreshed ui may attach on the envelope.
  if (res?.batch != null && json?.ui && !kind.includes('result.ui') && !kind.includes('envelope.ui')) {
    tokens += estTokens(json.ui);
    kind.push('envelope.ui-refresh');
  }

  return { tokens, kind };
}



/** Snippet fragment: measure interactive snapshot size, including overflow-reported uncapped chars. */
const SNAP_SIZE_SNIPPET = `
  const snapDefault = await snapshot({interactive:true});
  const snapText = typeof snapDefault==='string'?snapDefault:JSON.stringify(snapDefault);
  const overflow = snapText.match(/Snapshot is (\\d+) chars/);
  let snapshotCharsUncapped;
  let snapPayload;
  if (overflow) {
    snapshotCharsUncapped = Number(overflow[1]);
    snapPayload = await snapshot({interactive:true, maxChars:20000});
  } else {
    snapshotCharsUncapped = snapText.length;
    snapPayload = snapDefault;
  }
`;


async function runTurns(v, turns) {
  const t0 = nowMs();
  let contextTokens = 0;
  let toolCalls = 0;
  const turnLogs = [];
  let last = null;
  let failed = false;
  let failReason = null;

  for (const turn of turns) {
    const r = await bwRun(v, turn.snippet);
    toolCalls += 1;
    const ctx = contextFromEnvelope(r.json);
    contextTokens += ctx.tokens;
    turnLogs.push({
      name: turn.name,
      ok: r.ok,
      wallMs: +r.wallMs.toFixed(2),
      contextTokens: ctx.tokens,
      contextKinds: ctx.kind,
      error: r.ok ? null : (r.json?.error || r.stderr.slice(0, 240) || `code=${r.code}`),
    });
    last = r;
    if (!r.ok) {
      failed = true;
      failReason = turnLogs[turnLogs.length - 1].error;
      break;
    }
    if (turn.check) {
      const checkOk = turn.check(r);
      if (!checkOk) {
        failed = true;
        failReason = `check failed after ${turn.name}`;
        break;
      }
    }
  }

  return {
    ok: !failed,
    failReason,
    turns: toolCalls,
    toolCalls,
    wallMs: +(nowMs() - t0).toFixed(2),
    contextTokens,
    turnLogs,
    last,
  };
}

// ─── Task definitions ───────────────────────────────────────────────────────

function taskWebagentsCatalog(versionKey) {
  // Search "keyboard", get product detail, highlight it; verify highlight on page.
  if (versionKey === 'v1100') {
    return {
      id: 'webagents_catalog',
      synthetic: true,
      label: 'WebAgents catalog search→detail→highlight',
      turnsFor: (v) => [
        {
          name: 'open',
          snippet: `
            await page.goto('${SITE}/catalog',{waitUntil:'load'});
            const dir = await webagents.discover({refresh:true});
            return {url: page.url(), webagents: dir};
          `,
        },
        {
          name: 'batch',
          snippet: `
            const dir = await webagents.discover();
            if (!dir.available) return {fail:'no webagents', dir};
            const batch = await webagents.batch([
              {id:'find', action:'search', input:{query:'keyboard'}},
              {id:'detail', action:'get_product', dependsOn:['find'],
                input:{productId:{$ref:'find.results.0.id'}}},
              {id:'hl', action:'set_highlight', dependsOn:['detail'],
                input:{productId:{$ref:'find.results.0.id'}}},
            ], {allowWrites:true});
            const highlight = await page.locator('#highlight-name').innerText();
            const row = await page.locator('tr.highlight td').first().innerText().catch(()=>null);
            return {dirAvailable: dir.available, batch, highlight, row};
          `,
          check: (r) => {
            const res = r.json?.result;
            return res && String(res.highlight || '').includes('Wireless Keyboard');
          },
        },
      ],
    };
  }
  // 1.9.9: no webagents — DOM search form + read result (inspect-then-act).
  return {
    id: 'webagents_catalog',
    synthetic: true,
    label: 'WebAgents catalog search→detail→highlight',
    turnsFor: (v) => [
      {
        name: 'open+snapshot',
        snippet: `
          await page.goto('${SITE}/catalog',{waitUntil:'load'});
          ${SNAP_SIZE_SNIPPET}
          return {url: page.url(), snapshot, snapshotCharsUncapped};
        `,
      },
      {
        name: 'fill-search',
        snippet: `
          await page.getByLabel('Search').fill('keyboard');
          return {filled: true};
        `,
      },
      {
        name: 'submit-search',
        snippet: `
          await page.getByRole('button', {name:'Search'}).click();
          await page.waitForLoadState('load');
          ${SNAP_SIZE_SNIPPET}
          return {url: page.url(), snapshot, snapshotCharsUncapped};
        `,
      },
      {
        name: 'read-price',
        snippet: `
          const text = await page.locator('#first-price').innerText();
          const first = await page.locator('#results li').first().innerText();
          return {text, first};
        `,
        check: (r) => {
          const res = r.json?.result;
          return res && String(res.text || '').includes('49.99') && String(res.first || '').includes('Wireless Keyboard');
        },
      },
    ],
  };
}

function taskLocalForm(versionKey) {
  const expected = 'RSVP recorded for Ada Lovelace';
  if (versionKey === 'v1100') {
    return {
      id: 'local_form',
      synthetic: true,
      label: 'Local multi-field RSVP form (semantic UI batch)',
      turnsFor: () => [
        {
          name: 'open',
          snippet: `
            await page.goto('${SITE}/form',{waitUntil:'load'});
            const ui = await controls.directory();
            return {url: page.url(), ui};
          `,
        },
        {
          name: 'batch',
          snippet: `
            const batch = await controls.batch({
              operations: [
                {id:'n', action:'fill', target:{label:'Full name'}, value:'Ada Lovelace'},
                {id:'e', action:'fill', target:{label:'Email'}, value:'ada@example.com'},
                {id:'g', action:'select', target:{label:'Guest count'}, value:'2'},
                {id:'note', action:'fill', target:{label:'Notes'}, value:'Arriving late'},
                {id:'go', action:'click', target:{role:'button', name:'Submit RSVP', exact:true}},
                {id:'verify', action:'read', target:{css:'#result'}, value:'RSVP recorded for Ada Lovelace'},
              ],
              allowWrites: true,
            });
            const status = await page.locator('#result').innerText();
            return {batch, status};
          `,
          check: (r) => String(r.json?.result?.status || '').includes(expected),
        },
      ],
    };
  }
  return {
    id: 'local_form',
    synthetic: true,
    label: 'Local multi-field RSVP form (semantic UI batch)',
    turnsFor: () => [
      {
        name: 'open+snapshot',
        snippet: `
          await page.goto('${SITE}/form',{waitUntil:'load'});
          ${SNAP_SIZE_SNIPPET}
          return {snapshot, snapshotCharsUncapped};
        `,
      },
      { name: 'fill-name', snippet: `await page.getByLabel('Full name').fill('Ada Lovelace'); return {ok:1};` },
      { name: 'fill-email', snippet: `await page.getByLabel('Email').fill('ada@example.com'); return {ok:1};` },
      { name: 'select-guests', snippet: `await page.getByLabel('Guest count').selectOption('2'); return {ok:1};` },
      { name: 'fill-notes', snippet: `await page.getByLabel('Notes').fill('Arriving late'); return {ok:1};` },
      {
        name: 'submit',
        snippet: `
          await page.getByRole('button', {name:'Submit RSVP'}).click();
          await page.waitForLoadState('load');
          ${SNAP_SIZE_SNIPPET}
          return {snapshot, snapshotCharsUncapped};
        `,
      },
      {
        name: 'verify',
        snippet: `const status = await page.locator('#result').innerText(); return {status};`,
        check: (r) => String(r.json?.result?.status || '').includes(expected),
      },
    ],
  };
}

function taskHttpbinForm(versionKey) {
  // Real site, multi-field form fill + submit; verify custname echoed.
  const url = 'https://httpbin.org/forms/post';
  if (versionKey === 'v1100') {
    return {
      id: 'httpbin_form',
      synthetic: false,
      label: 'httpbin multi-field form fill→submit',
      turnsFor: () => [
        {
          name: 'open',
          snippet: `
            await page.goto('${url}',{waitUntil:'load'});
            const ui = await controls.directory();
            return {url: page.url(), ui};
          `,
        },
        {
          name: 'batch',
          snippet: `
            const batch = await controls.batch({
              operations: [
                {id:'name', action:'fill', target:{label:'Customer name:', exact:true}, value:'Grace Hopper'},
                {id:'tel', action:'fill', target:{label:'Telephone:', exact:true}, value:'555-0100'},
                {id:'mail', action:'fill', target:{label:'E-mail address:', exact:true}, value:'grace@example.com'},
                {id:'size', action:'check', target:{label:'Medium', exact:true}},
                {id:'top', action:'check', target:{label:'Bacon', exact:true}},
                {id:'del', action:'fill', target:{label:'Preferred delivery time:', exact:true}, value:'19:30'},
                {id:'cmt', action:'fill', target:{label:'Delivery instructions:', exact:true}, value:'No onions'},
                {id:'go', action:'click', target:{role:'button', name:'Submit order', exact:true}},
                {id:'verify', action:'read', target:{css:'body'}, value:'Grace Hopper'},
              ],
              allowWrites: true,
            });
            const body = await page.locator('body').innerText();
            return {batch, body: body.slice(0, 2000)};
          `,
          check: (r) => String(r.json?.result?.body || '').includes('Grace Hopper'),
        },
      ],
    };
  }
  return {
    id: 'httpbin_form',
    synthetic: false,
    label: 'httpbin multi-field form fill→submit',
    turnsFor: () => [
      {
        name: 'open+snapshot',
        snippet: `
          await page.goto('${url}',{waitUntil:'load'});
          ${SNAP_SIZE_SNIPPET}
          return {snapshot, snapshotCharsUncapped};
        `,
      },
      { name: 'fill-name', snippet: `await page.getByLabel('Customer name:').fill('Grace Hopper'); return {ok:1};` },
      { name: 'fill-tel', snippet: `await page.getByLabel('Telephone:').fill('555-0100'); return {ok:1};` },
      { name: 'fill-email', snippet: `await page.getByLabel('E-mail address:').fill('grace@example.com'); return {ok:1};` },
      { name: 'size', snippet: `await page.getByLabel('Medium').check(); return {ok:1};` },
      { name: 'topping', snippet: `await page.getByLabel('Bacon').check(); return {ok:1};` },
      { name: 'delivery', snippet: `await page.getByLabel('Preferred delivery time:').fill('19:30'); return {ok:1};` },
      { name: 'comments', snippet: `await page.getByLabel('Delivery instructions:').fill('No onions'); return {ok:1};` },
      {
        name: 'submit',
        snippet: `
          await page.getByRole('button', {name:'Submit order'}).click();
          await page.waitForLoadState('load');
          ${SNAP_SIZE_SNIPPET}
          return {snapshot, snapshotCharsUncapped};
        `,
      },
      {
        name: 'verify',
        snippet: `const body = await page.locator('body').innerText(); return {body: body.slice(0,2000)};`,
        check: (r) => String(r.json?.result?.body || '').includes('Grace Hopper'),
      },
    ],
  };
}

function taskQuotesSearchFilter(versionKey) {
  // Real site: author select (search criterion) → tag filter → Search → read quote.
  // quotes.toscrape.com/search.aspx — explicit search→filter→read with dependent tag options.
  const home = 'https://quotes.toscrape.com/search.aspx';
  const expectedSnippet = 'miracle';
  const checkResult = (r) => {
    const res = r.json?.result;
    if (!res) return false;
    return (
      String(res.quote || '').toLowerCase().includes(expectedSnippet) &&
      String(res.author || '').includes('Albert Einstein') &&
      String(res.tag || '').includes('inspirational')
    );
  };
  if (versionKey === 'v1100') {
    return {
      id: 'quotes_search_filter',
      synthetic: false,
      label: 'quotes.toscrape search→tag filter→read quote',
      turnsFor: () => [
        {
          name: 'open',
          snippet: `
            await page.goto('${home}',{waitUntil:'load'});
            const ui = await controls.directory();
            return {url: page.url(), ui};
          `,
        },
        {
          name: 'batch',
          snippet: `
            const batch = await controls.batch({
              operations: [
                {id:'author', action:'select', target:{label:'Author', exact:true}, value:'Albert Einstein'},
                {id:'tag', action:'select', target:{label:'Tag', exact:true}, value:'inspirational'},
                {id:'go', action:'click', target:{css:'input[name=submit_button]'}},
                {id:'verify', action:'read', target:{css:'.quote .content', nth:0}, value:'miracle'},
              ],
              allowWrites: true,
            });
            const quote = (await page.locator('.quote .content').first().innerText()).trim();
            const author = (await page.locator('.quote .author').first().innerText()).trim();
            const tag = (await page.locator('.quote .tag').first().innerText()).trim();
            return {batch, quote, author, tag, url: page.url()};
          `,
          check: checkResult,
        },
      ],
    };
  }
  return {
    id: 'quotes_search_filter',
    synthetic: false,
    label: 'quotes.toscrape search→tag filter→read quote',
    turnsFor: () => [
      {
        name: 'open+snapshot',
        snippet: `
          await page.goto('${home}',{waitUntil:'load'});
          ${SNAP_SIZE_SNIPPET}
          return {snapshot, snapshotCharsUncapped};
        `,
      },
      {
        name: 'select-author',
        snippet: `
          await Promise.all([
            page.waitForNavigation({waitUntil:'load'}),
            page.getByLabel('Author').selectOption('Albert Einstein'),
          ]);
          ${SNAP_SIZE_SNIPPET}
          return {snapshot, snapshotCharsUncapped};
        `,
      },
      {
        name: 'select-tag',
        snippet: `
          await page.getByLabel('Tag').selectOption('inspirational');
          return {tag: 'inspirational'};
        `,
      },
      {
        name: 'submit-search',
        snippet: `
          await Promise.all([
            page.waitForNavigation({waitUntil:'load'}),
            page.locator('input[name=submit_button]').click(),
          ]);
          ${SNAP_SIZE_SNIPPET}
          return {snapshot, snapshotCharsUncapped, url: page.url()};
        `,
      },
      {
        name: 'read-quote',
        snippet: `
          const quote = (await page.locator('.quote .content').first().innerText()).trim();
          const author = (await page.locator('.quote .author').first().innerText()).trim();
          const tag = (await page.locator('.quote .tag').first().innerText()).trim();
          return {quote, author, tag, url: page.url()};
        `,
        check: checkResult,
      },
    ],
  };
}

function taskWikiMultipage(versionKey) {
  // Multi-page: open Alan Turing → click "Princeton University" (or similar) → read heading.
  // Use a stable article with a known linked institution.
  const start = 'https://en.wikipedia.org/wiki/Ada_Lovelace';
  if (versionKey === 'v1100') {
    return {
      id: 'wiki_multipage',
      synthetic: false,
      label: 'Wikipedia multi-page nav→read heading',
      turnsFor: () => [
        {
          name: 'open',
          snippet: `
            await page.goto('${start}',{waitUntil:'domcontentloaded'});
            const ui = await controls.directory();
            return {url: page.url(), ui};
          `,
        },
        {
          name: 'batch',
          snippet: `
            const batch = await controls.batch({
              operations: [
                {id:'link', action:'click', target:{role:'link', name:'Charles Babbage', exact:true, nth:0}},
                {id:'verify', action:'read', target:{css:'#firstHeading'}, value:'Charles Babbage'},
              ],
              allowWrites: true,
            });
            const heading = await page.locator('#firstHeading').innerText();
            const url = page.url();
            return {batch, heading, url};
          `,
          check: (r) => String(r.json?.result?.heading || '').includes('Charles Babbage'),
        },
      ],
    };
  }
  return {
    id: 'wiki_multipage',
    synthetic: false,
    label: 'Wikipedia multi-page nav→read heading',
    turnsFor: () => [
      {
        name: 'open+snapshot',
        snippet: `
          await page.goto('${start}',{waitUntil:'domcontentloaded'});
          ${SNAP_SIZE_SNIPPET}
          return {snapshot, snapshotCharsUncapped};
        `,
      },
      {
        name: 'click-link',
        snippet: `
          await page.getByRole('link', {name:'Charles Babbage', exact:true}).first().click();
          await page.waitForLoadState('domcontentloaded');
          ${SNAP_SIZE_SNIPPET}
          return {snapshot, snapshotCharsUncapped, url: page.url()};
        `,
      },
      {
        name: 'read-heading',
        snippet: `
          const heading = await page.locator('#firstHeading').innerText();
          return {heading, url: page.url()};
        `,
        check: (r) => String(r.json?.result?.heading || '').includes('Charles Babbage'),
      },
    ],
  };
}

const ALL_TASK_BUILDERS = [
  taskWebagentsCatalog,
  taskLocalForm,
  taskHttpbinForm,
  taskQuotesSearchFilter,
  taskWikiMultipage,
];

/** Optional comma-separated task ids, e.g. BENCH_TASKS=quotes_search_filter */
const TASK_FILTER = (process.env.BENCH_TASKS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TASK_BUILDERS = TASK_FILTER.length
  ? ALL_TASK_BUILDERS.filter((b) => TASK_FILTER.includes(b('v1100').id))
  : ALL_TASK_BUILDERS;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(values) {
  const xs = values.filter((x) => x != null && Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!xs.length) return { n: 0, median: null, p10: null, p90: null, min: null, max: null, mean: null };
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    n: xs.length,
    median: percentile(xs, 50),
    p10: percentile(xs, 10),
    p90: percentile(xs, 90),
    min: xs[0],
    max: xs[xs.length - 1],
    mean: +(sum / xs.length).toFixed(2),
  };
}

function resolvedVersion(v) {
  try {
    return execSync(`${v.bin} --version`, {
      env: { ...process.env, BETTERWRIGHT_HOME: v.home },
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

async function main() {
  mkdirSync(join(ROOT, 'bench/results'), { recursive: true });
  const site = startSite();
  try {
    await waitForSite();
  } catch (e) {
    site.kill();
    throw e;
  }

  if (!TASK_BUILDERS.length) {
    site.kill('SIGTERM');
    throw new Error(`No tasks matched BENCH_TASKS=${process.env.BENCH_TASKS || ''}`);
  }

  const resolved = Object.fromEntries(VERSIONS.map((v) => [v.key, resolvedVersion(v)]));
  console.error('Resolved versions:', resolved);
  console.error(`Synthetic site: ${SITE}`);
  console.error(`N=${N} interleaved trials per task×version`);
  if (TASK_FILTER.length) console.error(`Task filter: ${TASK_FILTER.join(',')}`);

  for (const v of VERSIONS) closeAll(v);

  // When filtering tasks, merge into prior results so other arms stay intact.
  let priorTasks = {};
  const rawPath = join(ROOT, 'bench/results/webagents-raw.json');
  if (TASK_FILTER.length) {
    try {
      const prior = JSON.parse(readFileSync(rawPath, 'utf8'));
      priorTasks = prior.tasks || {};
    } catch { /* fresh */ }
  }

  const raw = {
    iso: new Date().toISOString(),
    N,
    site: SITE,
    resolved,
    note: '1.10.0 also fixed a Windows-only BetterChromium launch bug — irrelevant on this Linux host.',
    tasks: TASK_FILTER.length ? { ...priorTasks } : {},
  };
  // Drop superseded arms from earlier review iterations if present.
  delete raw.tasks.books_filter;
  delete raw.tasks.hockey_search_filter;

  for (const build of TASK_BUILDERS) {
    const meta = build('v1100');
    console.error(`\n== task ${meta.id}: ${meta.label} (synthetic=${meta.synthetic}) ==`);
    raw.tasks[meta.id] = {
      label: meta.label,
      synthetic: meta.synthetic,
      versions: {
        v199: { label: '1.9.9', trials: [], failures: 0 },
        v1100: { label: '1.10.0', trials: [], failures: 0 },
      },
    };

    for (let i = 0; i < N; i++) {
      for (const v of VERSIONS) {
        const task = build(v.key);
        // Fresh page state between arms: close session pages via about:blank nav in a prep call? 
        // Use dedicated session per version already; reset with goto about:blank first.
        await bwRun(v, `await page.goto('about:blank'); return true;`);
        const result = await runTurns(v, task.turnsFor(v));
        const trial = {
          i,
          ok: result.ok,
          failReason: result.failReason,
          turns: result.turns,
          toolCalls: result.toolCalls,
          wallMs: result.wallMs,
          contextTokens: result.contextTokens,
          turnLogs: result.turnLogs,
        };
        raw.tasks[meta.id].versions[v.key].trials.push(trial);
        if (!result.ok) raw.tasks[meta.id].versions[v.key].failures += 1;
        process.stderr.write(
          `  ${v.label} #${i} ok=${result.ok} turns=${result.turns} wall=${result.wallMs.toFixed(0)}ms ctxTok=${result.contextTokens}` +
            (result.ok ? '\n' : ` FAIL ${result.failReason}\n`),
        );
      }
    }
  }

  // Summaries
  const summary = { iso: raw.iso, N, resolved, note: raw.note, tasks: {} };
  for (const [tid, task] of Object.entries(raw.tasks)) {
    summary.tasks[tid] = { label: task.label, synthetic: task.synthetic, versions: {} };
    for (const [vk, vv] of Object.entries(task.versions)) {
      const okTrials = vv.trials.filter((t) => t.ok);
      summary.tasks[tid].versions[vk] = {
        label: vv.label,
        failures: vv.failures,
        successRate: `${vv.trials.length - vv.failures}/${vv.trials.length}`,
        turns: summarize(okTrials.map((t) => t.turns)),
        wallMs: summarize(okTrials.map((t) => t.wallMs)),
        contextTokens: summarize(okTrials.map((t) => t.contextTokens)),
        toolCalls: summarize(okTrials.map((t) => t.toolCalls)),
        // Include failed trials in wall spread note via allTrials wall
        wallMsAll: summarize(vv.trials.map((t) => t.wallMs)),
      };
    }
  }

  writeFileSync(join(ROOT, 'bench/results/webagents-raw.json'), JSON.stringify(raw, null, 2));
  writeFileSync(join(ROOT, 'bench/results/webagents-summary.json'), JSON.stringify(summary, null, 2));
  console.error('\nWrote bench/results/webagents-raw.json and webagents-summary.json');

  for (const v of VERSIONS) closeAll(v);
  site.kill('SIGTERM');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
