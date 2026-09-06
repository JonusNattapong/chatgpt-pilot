import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createContractManifest } from './contract.js';
import { ToolError } from './errors.js';
import {
  diffCapabilities,
  diffManifests,
  getRuntimeInfo,
  isControlBusy,
  restartIfStale,
  selfUpdate,
  withControlLock,
  type ControlDeps,
} from './runtime-control.js';
import type { ToolSpec } from './tools.js';

function fakeSpecs(names: string[]): ToolSpec[] {
  return names.map((name) => ({
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: async () => ({}),
  }));
}

function makeGitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'control-test-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  return dir;
}

test('control lock serializes overlapping operations', async () => {
  const order: string[] = [];
  const slow = withControlLock(async () => {
    order.push('first-start');
    await new Promise((resolve) => setTimeout(resolve, 50));
    order.push('first-end');
    return 1;
  });
  const fast = withControlLock(async () => {
    order.push('second');
    return 2;
  });
  assert.deepEqual(await Promise.all([slow, fast]), [1, 2]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  assert.equal(isControlBusy(), false);
});

test('manifest diff reports added, removed, and changed tools', () => {
  const entry = (name: string, extra = {}) => ({ name, inputSchema: { type: 'object', properties: extra }, annotations: {} });
  const diff = diffManifests(
    [entry('keep'), entry('gone'), entry('tweak', { a: true })],
    [entry('keep'), entry('tweak', { a: false }), entry('fresh')],
  );
  assert.deepEqual(diff.added, ['fresh']);
  assert.deepEqual(diff.removed, ['gone']);
  assert.deepEqual(diff.changed, ['tweak']);
  assert.equal(diff.fingerprintMatch, false);
  assert.equal(diffManifests([entry('same')], [entry('same')]).fingerprintMatch, true);
});

test('runtime_info exposes the version handshake', () => {
  const specs = fakeSpecs(['alpha', 'beta']);
  const info = getRuntimeInfo(specs);
  assert.equal(info.service.capabilityCount, 2);
  assert.equal(info.service.contractFingerprint, createContractManifest([...specs]).fingerprint);
  assert.ok(info.build && typeof info.build.packageVersion === 'string');
  assert.equal(info.worker.pid, process.pid);
  assert.equal(typeof info.worker.supervised, 'boolean');
  assert.ok('owner' in info.tunnel && 'daemonPid' in info.tunnel);
});

test('restart_if_stale refuses to self-terminate when unsupervised', async () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'control-stale-'));
  try {
    mkdirSync(path.join(repoDir, '.tunnel'), { recursive: true });
    writeFileSync(
      path.join(repoDir, '.tunnel', 'runtime-owner.json'),
      JSON.stringify({ owner: repoDir, buildCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
    );
    let spawned = 0;
    const deps: ControlDeps = {
      repoDir,
      isSupervised: () => false,
      spawnRestarter: () => {
        spawned += 1;
      },
    };
    await assert.rejects(() => restartIfStale(fakeSpecs(['x']), deps), (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.code, 'PRECONDITION_FAILED');
      return true;
    });
    assert.equal(spawned, 0);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('restart_if_stale reports dist-behind-head without restarting', async () => {
  const repoDir = makeGitRepo();
  try {
    // Real dist build-info predates this temp repo HEAD, so the service must
    // report dist-behind-head and must not spawn a restarter.
    let spawned = 0;
    const deps: ControlDeps = {
      repoDir,
      isSupervised: () => true,
      spawnRestarter: () => {
        spawned += 1;
      },
      runCheck: async () => {
        throw new ToolError('INTERNAL', 'must not probe when the cause is already known');
      },
    };
    const decision = await restartIfStale(fakeSpecs(['x']), deps);
    assert.equal(decision.restarted, false);
    assert.equal(decision.stale, true);
    assert.equal(decision.cause, 'dist-behind-head');
    assert.equal(spawned, 0);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('self_update requires explicit opt-in', async () => {
  const saved = process.env.MCP_ALLOW_SELF_UPDATE;
  delete process.env.MCP_ALLOW_SELF_UPDATE;
  try {
    await assert.rejects(() => selfUpdate({}), (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.code, 'POLICY_DENIED');
      return true;
    });
  } finally {
    if (saved !== undefined) process.env.MCP_ALLOW_SELF_UPDATE = saved;
  }
});

test('self_update refuses a dirty tree', async () => {
  const repoDir = makeGitRepo();
  writeFileSync(path.join(repoDir, 'file.txt'), 'dirty\n');
  const saved = process.env.MCP_ALLOW_SELF_UPDATE;
  process.env.MCP_ALLOW_SELF_UPDATE = '1';
  try {
    await assert.rejects(() => selfUpdate({ repoDir }), (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.code, 'PRECONDITION_FAILED');
      assert.match(error.message, /dirty/);
      return true;
    });
  } finally {
    if (saved !== undefined) process.env.MCP_ALLOW_SELF_UPDATE = saved;
    else delete process.env.MCP_ALLOW_SELF_UPDATE;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('self_update refuses a non-main branch', async () => {
  const repoDir = makeGitRepo();
  execFileSync('git', ['checkout', '-b', 'feature-x'], { cwd: repoDir, stdio: 'ignore', windowsHide: true });
  const saved = process.env.MCP_ALLOW_SELF_UPDATE;
  process.env.MCP_ALLOW_SELF_UPDATE = '1';
  try {
    await assert.rejects(() => selfUpdate({ repoDir }), (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.code, 'PRECONDITION_FAILED');
      assert.match(error.message, /branch/);
      return true;
    });
  } finally {
    if (saved !== undefined) process.env.MCP_ALLOW_SELF_UPDATE = saved;
    else delete process.env.MCP_ALLOW_SELF_UPDATE;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('capability_diff against the live build is clean', { timeout: 180_000 }, async () => {
  const { createToolSpecs } = await import('./tools.js');
  const root = mkdtempSync(path.join(tmpdir(), 'control-diff-'));
  try {
    const live = createToolSpecs({ root, unrestricted: false, maxTimeoutMs: 60_000 });
    const diff = await diffCapabilities(live, { maxTimeoutMs: 60_000 });
    assert.equal(diff.fingerprintMatch, true);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
    assert.deepEqual(diff.changed, []);
    assert.ok(diff.live.count >= 62);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
