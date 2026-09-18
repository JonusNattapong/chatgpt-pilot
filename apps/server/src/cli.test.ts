import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeCommand, preflight, resolveScript, run, usage, workspaceNeedsRestart } from './cli.js';

test('usage documents every operator command', () => {
  const text = usage();
  assert.match(text, /Usage:/);
  for (const command of ['setup', 'up', 'down', 'restart', 'status', 'doctor', 'use', 'workspace', 'machine']) {
    assert.match(text, new RegExp(`chatgpt-local ${command}`));
  }
});

test('CLI normalizes conventional help and version aliases', () => {
  assert.equal(normalizeCommand(undefined), 'help');
  assert.equal(normalizeCommand('--help'), 'help');
  assert.equal(normalizeCommand('-h'), 'help');
  assert.equal(normalizeCommand('--version'), 'version');
  assert.equal(normalizeCommand('-v'), 'version');
  assert.equal(normalizeCommand('status'), 'status');
  for (const alias of ['start', 'on', 'up']) assert.equal(normalizeCommand(alias), 'up');
  for (const alias of ['stop', 'off', 'down']) assert.equal(normalizeCommand(alias), 'down');
  assert.match(usage(), /chatgpt-local start/);
  assert.match(usage(), /chatgpt-local stop/);
});

test('workspace restart hint distinguishes persisted config from the live runtime root', () => {
  const configured = path.resolve('C:/workspace/new');
  assert.equal(workspaceNeedsRestart(configured, undefined), false);
  assert.equal(workspaceNeedsRestart(configured, { health: 'stopped', workerRoot: 'C:/workspace/old' }), false);
  assert.equal(workspaceNeedsRestart(configured, { health: 'healthy', workerRoot: configured }), false);
  assert.equal(workspaceNeedsRestart(configured, { health: 'healthy', workerRoot: 'C:/workspace/old' }), true);
});
test('resolveScript selects the platform-native launcher', () => {
  const scriptsDir = path.join('C:', 'repo', 'scripts');
  const win = resolveScript('win32', scriptsDir, 'start-tunnel');
  assert.equal(win.program, 'powershell.exe');
  assert.deepEqual(win.args, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsDir, 'start-tunnel.ps1')]);
  assert.ok(win.args[win.args.length - 1].endsWith('start-tunnel.ps1'));

  const posix = resolveScript('linux', scriptsDir, 'start-tunnel');
  assert.equal(posix.program, 'bash');
  assert.deepEqual(posix.args, [path.join(scriptsDir, 'start-tunnel.sh')]);
  assert.ok(posix.args[0].endsWith('start-tunnel.sh'));

  const darwin = resolveScript('darwin', scriptsDir, 'status-tunnel');
  assert.equal(darwin.program, 'bash');
  assert.ok(darwin.args[0].endsWith('status-tunnel.sh'));
});

test('resolveScript maps every tunnel lifecycle script', () => {
  for (const name of ['start-tunnel', 'stop-tunnel', 'status-tunnel']) {
    const win = resolveScript('win32', '/scripts', name);
    assert.ok(win.args[win.args.length - 1].endsWith(`${name}.ps1`));
    const sh = resolveScript('linux', '/scripts', name);
    assert.ok(sh.args[0].endsWith(`${name}.sh`));
  }
});

test('preflight reports a missing package.json on any platform', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'machine-mcp-preflight-'));
  try {
    const missing = preflight(root);
    assert.ok(missing.includes('package.json'), `expected package.json in ${missing.join(', ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preflight detects missing tunnel client and runtime key when provisioned with only package.json', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'machine-mcp-preflight-'));
  try {
    writeFileSync(path.join(root, 'package.json'), '{}');
    // Keep the ambient api key out of this assertion so the file check is exercised.
    const saved = process.env.CONTROL_PLANE_API_KEY;
    delete process.env.CONTROL_PLANE_API_KEY;
    try {
      const missing = preflight(root);
      assert.ok(!missing.includes('package.json'), 'package.json should be satisfied');
      assert.ok(missing.includes('tunnel-client'), `expected tunnel-client in ${missing.join(', ')}`);
      assert.ok(missing.includes('runtime key'), `expected runtime key in ${missing.join(', ')}`);
    } finally {
      if (saved !== undefined) process.env.CONTROL_PLANE_API_KEY = saved;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preflight passes when the runtime is fully provisioned', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'machine-mcp-preflight-'));
  try {
    writeFileSync(path.join(root, 'package.json'), '{}');
    const toolsDir = path.join(root, 'tools', 'tunnel-client-v0.0.13');
    mkdirSync(toolsDir, { recursive: true });
    const tunnelDir = path.join(root, '.tunnel');
    mkdirSync(tunnelDir, { recursive: true });
    if (process.platform === 'win32') {
      writeFileSync(path.join(toolsDir, 'tunnel-client.exe'), '');
      writeFileSync(path.join(tunnelDir, 'control-plane-api-key.dpapi'), 'sk-test');
    } else {
      writeFileSync(path.join(toolsDir, 'tunnel-client'), '');
      writeFileSync(path.join(tunnelDir, 'control-plane-api-key'), 'sk-test');
    }
    assert.deepEqual(preflight(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preflight accepts the monorepo root used by the lifecycle scripts', () => {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), 'machine-mcp-repo-'));
  try {
    writeFileSync(path.join(repositoryRoot, 'package.json'), '{}');
    const toolsDir = path.join(repositoryRoot, 'tools', 'tunnel-client-v0.0.13');
    mkdirSync(toolsDir, { recursive: true });
    mkdirSync(path.join(repositoryRoot, '.tunnel'), { recursive: true });
    if (process.platform === 'win32') {
      writeFileSync(path.join(toolsDir, 'tunnel-client.exe'), '');
      writeFileSync(path.join(repositoryRoot, '.tunnel', 'control-plane-api-key.dpapi'), 'sk-test');
    } else {
      writeFileSync(path.join(toolsDir, 'tunnel-client'), '');
      writeFileSync(path.join(repositoryRoot, '.tunnel', 'control-plane-api-key'), 'sk-test');
    }

    const serverProject = path.join(repositoryRoot, 'apps', 'server');
    mkdirSync(serverProject, { recursive: true });
    assert.deepEqual(preflight(repositoryRoot), []);
    assert.notDeepEqual(preflight(serverProject), []);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('preflight treats CONTROL_PLANE_API_KEY env as satisfying the runtime key', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'machine-mcp-preflight-'));
  try {
    writeFileSync(path.join(root, 'package.json'), '{}');
    const toolsDir = path.join(root, 'tools', 'tunnel-client-v0.0.13');
    mkdirSync(toolsDir, { recursive: true });
    if (process.platform === 'win32') {
      writeFileSync(path.join(toolsDir, 'tunnel-client.exe'), '');
    } else {
      writeFileSync(path.join(toolsDir, 'tunnel-client'), '');
    }
    const saved = process.env.CONTROL_PLANE_API_KEY;
    process.env.CONTROL_PLANE_API_KEY = 'sk-env-provided';
    try {
      // No .tunnel key file, but env satisfies it.
      assert.deepEqual(preflight(root), []);
    } finally {
      if (saved === undefined) delete process.env.CONTROL_PLANE_API_KEY;
      else process.env.CONTROL_PLANE_API_KEY = saved;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run rejects when the program cannot be spawned', async () => {
  await assert.rejects(run('this-program-does-not-exist-xyz-9jv', ['--flag']));
});

test('run rejects on a non-zero exit code', async () => {
  // node itself exits non-zero; the promise must reject rather than resolve.
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(2)']));
});
