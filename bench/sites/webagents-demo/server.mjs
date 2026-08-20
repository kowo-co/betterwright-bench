#!/usr/bin/env node
/**
 * Synthetic WebAgents demo site for the 1.10.0 vs 1.9.9 bench.
 * Serves /webagents.md + /.well-known/webagents.json and a same-origin
 * POST /api/agent/workflow endpoint. Also exposes a multi-field form page
 * (no WebAgents) for the generic semantic-directory arm.
 *
 * SYNTHETIC — not a public participating site. Bound to 127.0.0.1 only.
 */
import http from 'node:http';
import { URL } from 'node:url';

const HOST = process.env.WEBAGENTS_HOST || '127.0.0.1';
const PORT = Number(process.env.WEBAGENTS_PORT || 8765);

const CATALOG = [
  { id: 'kb-1', name: 'Wireless Keyboard', price: 49.99, stock: 12, category: 'peripherals' },
  { id: 'ms-2', name: 'Ergonomic Mouse', price: 29.5, stock: 40, category: 'peripherals' },
  { id: 'hd-3', name: 'USB-C Hub', price: 39.0, stock: 8, category: 'adapters' },
  { id: 'mn-4', name: '27-inch Monitor', price: 249.0, stock: 5, category: 'displays' },
  { id: 'cb-5', name: 'Braided Cable', price: 12.0, stock: 100, category: 'adapters' },
];

const MANIFEST = {
  version: '0.1',
  workflow: {
    endpoint: '/api/agent/workflow',
    maxOperations: 16,
    parallel: true,
    references: true,
    pacing: { minIntervalMs: 50, maxConcurrency: 2 },
  },
  actions: {
    search: {
      description: 'Search the product catalog by query string',
      effect: 'read',
      pathPrefixes: ['/catalog'],
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                price: { type: 'number' },
              },
            },
          },
        },
      },
    },
    get_product: {
      description: 'Fetch one product by id',
      effect: 'read',
      pathPrefixes: ['/catalog'],
      inputSchema: {
        type: 'object',
        properties: { productId: { type: 'string' } },
        required: ['productId'],
      },
    },
    set_highlight: {
      description: 'Highlight a product on the page (write; refreshes UI)',
      effect: 'write',
      pathPrefixes: ['/catalog'],
      inputSchema: {
        type: 'object',
        properties: { productId: { type: 'string' } },
        required: ['productId'],
      },
    },
  },
};

/** In-memory highlight for UI verification after write+reload. */
let highlightId = null;

function resolveRef(value, outputs) {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.$ref === 'string') {
    const path = value.$ref.split('.');
    let cur = outputs[path[0]];
    for (let i = 1; i < path.length; i++) {
      if (cur == null) return undefined;
      cur = cur[path[i]];
    }
    return cur;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveRef(v, outputs);
    return out;
  }
  return value;
}

function runOperations(operations) {
  const outputs = {};
  const results = [];
  for (const op of operations) {
    const input = resolveRef(op.input || {}, outputs);
    let output;
    if (op.action === 'search') {
      const q = String(input.query || '').toLowerCase();
      const hits = CATALOG.filter(
        (p) => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q) || p.id.includes(q),
      );
      output = { results: hits.map(({ id, name, price, category }) => ({ id, name, price, category })) };
    } else if (op.action === 'get_product') {
      const product = CATALOG.find((p) => p.id === input.productId) || null;
      output = { product };
    } else if (op.action === 'set_highlight') {
      highlightId = input.productId || null;
      output = { ok: true, highlightId };
    } else {
      throw new Error(`Unknown action: ${op.action}`);
    }
    outputs[op.id] = output;
    results.push({ id: op.id, action: op.action, output });
  }
  return { ok: true, results };
}

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function catalogPage() {
  const rows = CATALOG.map((p) => {
    const hl = p.id === highlightId ? ' class="highlight"' : '';
    return `<tr${hl} data-id="${htmlEscape(p.id)}"><td>${htmlEscape(p.name)}</td><td>$${p.price.toFixed(2)}</td><td>${htmlEscape(p.category)}</td><td>${p.stock}</td></tr>`;
  }).join('');
  const hlName = CATALOG.find((p) => p.id === highlightId)?.name || '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>WebAgents Demo Catalog</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem}
  .highlight{background:#ffe08a}
  #status{margin:1rem 0;padding:.75rem;border:1px solid #ccc}
  label{display:block;margin:.5rem 0 .15rem}
  input,select,button{font:inherit;padding:.35rem .5rem}
</style></head><body>
<h1>WebAgents Demo Catalog</h1>
<p>Synthetic site publishing <code>/webagents.md</code> for BetterWright batch workflows.</p>
<div id="status" role="status">Highlighted: <span id="highlight-name">${htmlEscape(hlName || '(none)')}</span></div>
<table id="catalog"><thead><tr><th>Name</th><th>Price</th><th>Category</th><th>Stock</th></tr></thead>
<tbody>${rows}</tbody></table>
<form id="dom-search" action="/catalog" method="get" style="margin-top:1.5rem">
  <label for="q">Search</label>
  <input id="q" name="q" type="search" placeholder="Search products">
  <button type="submit">Search</button>
</form>
</body></html>`;
}

function formPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Local Multi-field Form</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:520px;margin:2rem auto;padding:0 1rem}
  label{display:block;margin:.75rem 0 .2rem}
  input,select,textarea,button{font:inherit;width:100%;padding:.4rem}
  button{margin-top:1rem;width:auto}
  #result{margin-top:1.5rem;padding:1rem;border:1px solid #2a7;display:none}
</style></head><body>
<h1>Event RSVP (synthetic)</h1>
<p>Ordinary page — no WebAgents contract. For semantic UI batch testing.</p>
<form id="rsvp" action="/form" method="get">
  <label for="full-name">Full name</label>
  <input id="full-name" name="fullName" required>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required>
  <label for="guests">Guest count</label>
  <select id="guests" name="guests">
    <option value="1">1</option>
    <option value="2">2</option>
    <option value="3">3</option>
  </select>
  <label for="notes">Notes</label>
  <textarea id="notes" name="notes" rows="3"></textarea>
  <button type="submit">Submit RSVP</button>
</form>
<div id="result" role="status"></div>
<script>
  const params = new URLSearchParams(location.search);
  if (params.has('fullName')) {
    const el = document.getElementById('result');
    el.style.display = 'block';
    el.textContent = 'RSVP recorded for ' + params.get('fullName') +
      ' (' + (params.get('email') || '') + '), guests=' + (params.get('guests') || '') +
      ', notes=' + (params.get('notes') || '');
  }
</script>
</body></html>`;
}

const WEBAGENTS_MD = `# Agent actions

This prose is documentation only and must never enter model context.

\`\`\`webagents
${JSON.stringify(MANIFEST)}
\`\`\`
`;

function send(res, status, body, headers = {}) {
  const buf = Buffer.from(body);
  res.writeHead(status, {
    'content-length': buf.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/webagents.md') {
    return send(res, 200, WEBAGENTS_MD, { 'content-type': 'text/markdown; charset=utf-8' });
  }
  if (req.method === 'GET' && url.pathname === '/.well-known/webagents.json') {
    return send(res, 200, JSON.stringify(MANIFEST, null, 2), { 'content-type': 'application/json; charset=utf-8' });
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/workflow') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 200_000) req.destroy(); });
    req.on('end', () => {
      try {
        const body = JSON.parse(raw || '{}');
        const out = runOperations(body.operations || []);
        send(res, 200, JSON.stringify(out), { 'content-type': 'application/json; charset=utf-8' });
      } catch (e) {
        send(res, 400, JSON.stringify({ error: String(e.message || e) }), { 'content-type': 'application/json' });
      }
    });
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/catalog')) {
    if (url.pathname === '/') {
      res.writeHead(302, { location: '/catalog' });
      return res.end();
    }
    if (url.searchParams.has('q')) {
      // DOM search path for 1.9.9: filter table client-side via query echo
      const q = url.searchParams.get('q') || '';
      const hits = CATALOG.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
      const list = hits.map((p) => `<li data-id="${htmlEscape(p.id)}">${htmlEscape(p.name)} — $${p.price.toFixed(2)}</li>`).join('');
      return send(res, 200, `<!doctype html><html><head><title>Search: ${htmlEscape(q)}</title></head><body>
        <h1>Search results for ${htmlEscape(q)}</h1>
        <ul id="results">${list}</ul>
        <p id="first-price">${hits[0] ? '$' + hits[0].price.toFixed(2) : 'none'}</p>
        <a href="/catalog">Back</a></body></html>`, { 'content-type': 'text/html; charset=utf-8' });
    }
    return send(res, 200, catalogPage(), { 'content-type': 'text/html; charset=utf-8' });
  }
  if (req.method === 'GET' && url.pathname === '/form') {
    return send(res, 200, formPage(), { 'content-type': 'text/html; charset=utf-8' });
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, 'ok', { 'content-type': 'text/plain' });
  }
  send(res, 404, 'not found', { 'content-type': 'text/plain' });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`webagents-demo listening on http://${HOST}:${PORT}\n`);
});
