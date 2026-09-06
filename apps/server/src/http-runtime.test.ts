import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a TCP port.');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('real HTTP runtime exposes distinct liveness and readiness metadata', async () => {
  const distDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = await mkdtemp(path.join(tmpdir(), 'machine-http-runtime-'));
  const port = await reservePort();
  const child = spawn(process.execPath, [
    path.join(distDirectory, 'index.js'),
    '--http', '--http-host', '127.0.0.1', '--http-port', String(port), '--root', root,
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`HTTP runtime did not become ready: ${stderr}`)), 8_000);
      const check = () => {
        if (stderr.includes('listening at')) {
          clearTimeout(deadline);
          resolve();
        } else if (child.exitCode !== null) {
          clearTimeout(deadline);
          reject(new Error(`HTTP runtime exited early: ${stderr}`));
        } else {
          setTimeout(check, 25);
        }
      };
      check();
    });

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    const healthBody = await health.json() as Record<string, unknown>;
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.status, 'alive');
    assert.equal(healthBody.version, '1.0.0');
    assert.equal(healthBody.contractVersion, 8);

    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(ready.status, 200);
    const readyBody = await ready.json() as Record<string, unknown>;
    assert.equal(readyBody.ok, true);
    assert.equal(readyBody.status, 'ready');
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => resolve(), 2_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
