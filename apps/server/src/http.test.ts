import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { parseOptions } from './index.js';
import { CONTROL_CENTER_HTML } from './control-center.js';
// ---- parseOptions gate tests ----

test('parseOptions requires token when binding off loopback', () => {
  assert.throws(() => parseOptions(['--http', '--http-host', '0.0.0.0']), /requires --http-token/);
  assert.throws(() => parseOptions(['--http', '--http-host', '192.168.1.10']), /requires --http-token/);
});

test('parseOptions allows loopback without token', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    const opts = parseOptions(['--http', '--http-host', host, '--http-port', '8787']);
    assert.equal(opts.httpHost, host);
    assert.equal(opts.http, true);
  }
});

test('parseOptions accepts token off loopback', () => {
  const opts = parseOptions(['--http', '--http-host', '0.0.0.0', '--http-token', 's3cret-token', '--http-port', '8787']);
  assert.equal(opts.httpToken, 's3cret-token');
});

test('parseOptions validates http-port range', () => {
  assert.throws(() => parseOptions(['--http-port', '0']), /between 1 and 65535/);
  assert.throws(() => parseOptions(['--http-port', '99999']), /between 1 and 65535/);
  assert.throws(() => parseOptions(['--http-port', 'not-a-number']), /between 1 and 65535/);
});

// ---- in-process HTTP server (same logic as src/index.ts, no spawn) ----

function hasValidBearerToken(req: IncomingMessage, expectedToken?: string): boolean {
  if (!expectedToken) return true;
  const value = req.headers.authorization;
  if (!value?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(value.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function addCorsHeaders(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
}

async function startTestServer(opts: { token?: string } = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    addCorsHeaders(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if ((pathname === '/healthz' || pathname === '/readyz') && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'chatgpt-machine-mcp', endpoint: '/mcp' }));
      return;
    }
    if ((pathname === '/ui' || pathname.startsWith('/ui/')) && !hasValidBearerToken(req, opts.token)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
    }
    if (pathname === '/ui' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(CONTROL_CENTER_HTML); return; }
    if (pathname === '/ui/audit' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ records: [] })); return; }
    if (pathname === '/ui/runtime' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ready: true, version: 'test', capabilityCount: 2, publicToolCount: 2 })); return; }
    if (pathname === '/ui/capabilities' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ capabilities: [] })); return; }
    if (pathname !== '/mcp') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!hasValidBearerToken(req, opts.token)) { res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    // Minimal MCP success for tests – real handler would do tools/list etc.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())),
  };
}

function httpFetch(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, string>; json: () => Promise<unknown>; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest({ hostname: u.hostname, port: Number(u.port), path: u.pathname + u.search, method: opts.method ?? 'GET', headers: { connection: 'close', ...(opts.headers ?? {}) }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
        resolve({ status: res.statusCode ?? 0, headers, json: async () => JSON.parse(body), text: async () => body });
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('HTTP healthz and readyz are unauthenticated and report service', async () => {
  const srv = await startTestServer();
  try {
    for (const p of ['/healthz', '/readyz']) {
      const res = await httpFetch(`http://127.0.0.1:${srv.port}${p}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; service: string; endpoint: string };
      assert.equal(body.ok, true);
      assert.equal(body.service, 'chatgpt-machine-mcp');
      assert.equal(body.endpoint, '/mcp');
    }
  } finally { await srv.close(); }
});

test('HTTP unknown path returns 404', async () => {
  const srv = await startTestServer();
  try {
    const res = await httpFetch(`http://127.0.0.1:${srv.port}/not-found`);
    assert.equal(res.status, 404);
  } finally { await srv.close(); }
});

test('HTTP /mcp without token is open on loopback', async () => {
  const srv = await startTestServer();
  try {
    const res = await httpFetch(`http://127.0.0.1:${srv.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.notEqual(res.status, 401);
    assert.equal(res.status, 200);
  } finally { await srv.close(); }
});

test('HTTP bearer gate protects /mcp and /ui with timingSafeEqual (same-length wrong token fails)', async () => {
  const token = 'test-bearer-token-12345678';
  const wrongSameLength = 'test-bearer-token-87654321';
  const srv = await startTestServer({ token });
  try {
    const noAuth = await httpFetch(`http://127.0.0.1:${srv.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noAuth.status, 401);
    const bad = await httpFetch(`http://127.0.0.1:${srv.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${wrongSameLength}` }, body: '{}' });
    assert.equal(bad.status, 401);
    const good = await httpFetch(`http://127.0.0.1:${srv.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(good.status, 200);
    const uiNoAuth = await httpFetch(`http://127.0.0.1:${srv.port}/ui`);
    assert.equal(uiNoAuth.status, 401);
    const uiGood = await httpFetch(`http://127.0.0.1:${srv.port}/ui`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(uiGood.status, 200);
    assert.match(await uiGood.text(), /control center/i);
    const runtimeNoAuth = await httpFetch(`http://127.0.0.1:${srv.port}/ui/runtime`);
    assert.equal(runtimeNoAuth.status, 401);
    const runtimeGood = await httpFetch(`http://127.0.0.1:${srv.port}/ui/runtime`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(runtimeGood.status, 200);
    assert.equal(((await runtimeGood.json()) as { ready: boolean }).ready, true);
    const capsGood = await httpFetch(`http://127.0.0.1:${srv.port}/ui/capabilities`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(capsGood.status, 200);
    const cors = await httpFetch(`http://127.0.0.1:${srv.port}/healthz`);
    assert.equal(cors.headers['access-control-allow-origin'], '*');
  } finally { await srv.close(); }
});

test('HTTP /mcp rejects missing Bearer prefix', async () => {
  const srv = await startTestServer({ token: 'another-secret-token-xyz' });
  try {
    const res = await httpFetch(`http://127.0.0.1:${srv.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'another-secret-token-xyz' }, body: '{}' });
    assert.equal(res.status, 401);
  } finally { await srv.close(); }
});
