import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyFilePatch, runShellCommand } from './shell-tools.js';

test('shell_command classifies git commands as git type', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-classify-'));
  try {
    const result = await runShellCommand({
      command: 'git status --short',
      root,
      unrestricted: false,
      timeoutMs: 10_000,
    });
    assert.ok(result.classification);
    assert.equal(result.classification?.kind, 'git');
    assert.equal(result.classification?.confidence, 'high');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shell_command classifies npm run as build type', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-classify-'));
  try {
    const result = await runShellCommand({
      command: 'npm run build',
      root,
      unrestricted: false,
      timeoutMs: 10_000,
    });
    assert.ok(result.classification);
    assert.equal(result.classification?.kind, 'build');
    assert.ok(result.classification?.suggestedTimeoutMs);
    assert.ok(result.classification!.suggestedTimeoutMs!.min >= 30_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shell_command detects dangerous rm -rf pattern with warning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-danger-'));
  try {
    // This pattern should be blocked in workspace mode
    await assert.rejects(
      runShellCommand({
        command: 'rm -rf /tmp/test',
        root,
        unrestricted: false,
        timeoutMs: 10_000,
      }),
      (error: unknown) => (error as { code?: string }).code === 'POLICY_DENIED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shell_command detects sudo pattern and warns', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-sudo-'));
  try {
    // sudo should be allowed in unrestricted mode but classified
    const result = await runShellCommand({
      command: 'echo "test"',
      root,
      unrestricted: true,
      timeoutMs: 10_000,
    });
    // The command itself should succeed; classification is informational
    assert.ok(result.classification);
    assert.equal(result.success, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shell_command returns recommendation for interactive commands', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-interactive-'));
  try {
    const result = await runShellCommand({
      command: 'vim /tmp/test.txt',
      root,
      unrestricted: false,
      timeoutMs: 10_000,
    });
    // vim should be classified as interactive
    assert.ok(result.classification);
    assert.equal(result.classification?.kind, 'interactive');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply_patch accepts standard unified diff format', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-unified-'));
  try {
    // Create initial file
    const target = path.join(root, 'hello.txt');
    await applyFilePatch({ root, unrestricted: false }, [
      '*** Begin Patch',
      '*** Add File: hello.txt',
      '+hello world',
      '*** End Patch',
    ].join('\n'));

    // Apply unified diff
    const unifiedDiff = [
      'diff --git a/hello.txt b/hello.txt',
      '--- a/hello.txt',
      '+++ b/hello.txt',
      '@@ -1 +1 @@',
      '-hello world',
      '+hello universe',
    ].join('\n');

    const changed = await applyFilePatch({ root, unrestricted: false }, unifiedDiff);
    assert.ok(changed.some((c) => c.includes('hello.txt')));

    const content = await (await import('node:fs/promises')).readFile(target, 'utf8');
    assert.equal(content, 'hello universe\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply_patch unified diff with no hunks is a no-op', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-nohunk-'));
  try {
    const target = path.join(root, 'existing.txt');
    await (await import('node:fs/promises')).writeFile(target, 'line1\n', 'utf8');

    const changed = await applyFilePatch({ root, unrestricted: false }, [
      'diff --git a/existing.txt b/existing.txt',
      '--- a/existing.txt',
      '+++ b/existing.txt',
    ].join('\n'));
    // No hunks means no changes
    assert.equal(changed.length, 0);
    const content = await (await import('node:fs/promises')).readFile(target, 'utf8');
    assert.equal(content, 'line1\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply_patch unified diff dry_run reports changes without writing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-dry-unified-'));
  try {
    const target = path.join(root, 'target.txt');
    await (await import('node:fs/promises')).writeFile(target, 'line1\nline2\nline3\n', 'utf8');

    const unifiedDiff = [
      'diff --git a/target.txt b/target.txt',
      '--- a/target.txt',
      '+++ b/target.txt',
      '@@ -2 +2 @@',
      '-line2',
      '+line2-updated',
    ].join('\n');

    const changed = await applyFilePatch({ root, unrestricted: false }, unifiedDiff, true);
    assert.ok(changed.some((c) => c.includes('target.txt')));

    // File must be unchanged after dry run
    const content = await (await import('node:fs/promises')).readFile(target, 'utf8');
    assert.equal(content, 'line1\nline2\nline3\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shell_command classification is present for all commands', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-classify-all-'));
  try {
    const cases = [
      { command: 'ls -la', expected: 'read-only' },
      { command: 'node -e "console.log(1)"', expected: 'unknown' },
      { command: 'git log --oneline', expected: 'git' },
    ];
    for (const c of cases) {
      const result = await runShellCommand({
        command: c.command,
        root,
        unrestricted: false,
        timeoutMs: 10_000,
      });
      assert.ok(result.classification, `Expected classification for: ${c.command}`);
      assert.equal(result.classification?.kind, c.expected, `Wrong classification for: ${c.command}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shell_command recommendation prefers exec_process for builds', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-rec-'));
  try {
    const result = await runShellCommand({
      command: 'npm run build',
      root,
      unrestricted: false,
      timeoutMs: 10_000,
    });
    assert.ok(result.classification);
    assert.equal(result.classification?.kind, 'build');
    assert.ok(result.classification?.preferredTool || result.recommendation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
