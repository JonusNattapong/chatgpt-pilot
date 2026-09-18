import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyFilePatch, runShellCommand } from './shell-tools.js';
import { processStatus, readProcessOutput, startProcess, stopProcess } from './process-tools.js';
import { gitAdd, gitBranch, gitCheckout, gitCommit, gitDiff, gitLog, gitShow, gitStatus } from './git-tools.js';

test('safe mode keeps shell commands inside the configured root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-'));
  try {
    await assert.rejects(
      runShellCommand({ command: 'node --version', root, unrestricted: false, workdir: '..' }),
      /outside the configured root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unrestricted mode accepts an absolute working directory outside root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-root-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'machine-mcp-outside-'));
  try {
    const result = await runShellCommand({
      command: 'node -e "process.stdout.write(process.cwd())"',
      root,
      unrestricted: true,
      workdir: outside,
      // Other integration tests may launch child processes in parallel on Windows CI,
      // where a cold Node child can take longer than ten seconds to start.
      timeoutMs: 30_000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(await realpath(path.resolve(result.stdout)), await realpath(path.resolve(outside)));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('apply_patch adds and updates a file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-patch-'));
  try {
    await applyFilePatch({ root, unrestricted: false }, [
      '*** Begin Patch',
      '*** Add File: example.txt',
      '+hello',
      '*** End Patch',
    ].join('\n'));
    await applyFilePatch({ root, unrestricted: false }, [
      '*** Begin Patch',
      '*** Update File: example.txt',
      '@@',
      '-hello',
      '+hello world',
      '*** End Patch',
    ].join('\n'));
    assert.equal(await readFile(path.join(root, 'example.txt'), 'utf8'), 'hello world\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shell preserves UTF-8 output and returns execution metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-utf8-'));
  try {
    const result = await runShellCommand({
      command: 'node -e "process.stdout.write(\'สวัสดีครับ\')"',
      root,
      unrestricted: false,
      timeoutMs: 10_000,
    });
    assert.equal(result.stdout, 'สวัสดีครับ');
    assert.equal(result.outputTruncated, false);
    assert.ok(result.durationMs >= 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PowerShell non-terminating errors are converted into a failed shell result', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows PowerShell behavior is Windows-only');
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-powershell-error-'));
  try {
    const result = await runShellCommand({
      command: "Write-Error 'intentional failure'; Write-Output 'should-not-continue'",
      root,
      unrestricted: false,
      shell: 'powershell',
      timeoutMs: 10_000,
    });
    assert.equal(result.success, false);
    assert.equal(result.hadPowerShellError, true);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /intentional failure/i);
    assert.doesNotMatch(result.stderr, /__CHATGPT_MACHINE_POWERSHELL_ERROR__/);
    assert.equal(result.stdout.includes('should-not-continue'), false);
    assert.ok(result.stderrBytes > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PowerShell shell preserves Thai UTF-8 output', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows PowerShell behavior is Windows-only');
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-powershell-utf8-'));
  try {
    const result = await runShellCommand({
      command: "Write-Output 'ภาษาไทย สวัสดีครับ'",
      root,
      unrestricted: false,
      shell: 'powershell',
      timeoutMs: 10_000,
    });
    assert.equal(result.success, true);
    assert.equal(result.stdout.trim(), 'ภาษาไทย สวัสดีครับ');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cmd shell preserves Thai UTF-8 output', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows cmd behavior is Windows-only');
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-cmd-utf8-'));
  try {
    const result = await runShellCommand({
      // Keep the command line ASCII; the child still emits real Thai UTF-8.
      command: 'node -e process.stdout.write(String.fromCodePoint(0xe20,0xe32,0xe29,0xe32,0xe44,0xe17,0xe22,32,0xe2a,0xe27,0xe31,0xe2a,0xe14,0xe35,0xe04,0xe23,0xe31,0xe1a))',
      root,
      unrestricted: false,
      shell: 'cmd',
      timeoutMs: 10_000,
    });
    assert.equal(result.success, true);
    assert.equal(result.stdout.trim(), 'ภาษาไทย สวัสดีครับ');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shell stops when the configured output limit is reached', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-output-'));
  try {
    const result = await runShellCommand({
      command: 'node -e "process.stdout.write(\'x\'.repeat(4096))"',
      root,
      unrestricted: false,
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    });
    assert.equal(result.outputTruncated, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply_patch dry_run validates without writing files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-dry-run-'));
  try {
    const changed = await applyFilePatch({ root, unrestricted: false }, [
      '*** Begin Patch',
      '*** Add File: preview.txt',
      '+preview',
      '*** End Patch',
    ].join('\n'), true);
    assert.deepEqual(changed, ['added preview.txt']);
    await assert.rejects(access(path.join(root, 'preview.txt')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('process tools start, inspect output, and stop a background process', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-process-'));
  let pid: number | undefined;
  try {
    const started = await startProcess({
      root,
      unrestricted: false,
      command: "node -e \"console.log('process-ok'); setTimeout(() => {}, 10000)\"",
    });
    pid = started.pid;
    assert.ok(started.pid > 0);
    const output = await readProcessOutput({ root, unrestricted: false, pid: started.pid, waitMs: 5_000 });
    assert.match(output.stdout, /process-ok/);
    assert.equal((await processStatus({ root, unrestricted: false, pid: started.pid })).running, true);
    assert.equal((await stopProcess({ root, unrestricted: false, pid: started.pid })).stopped, true);
    pid = undefined;
  } finally {
    if (pid !== undefined) await stopProcess({ root, unrestricted: false, pid }).catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('git tools return structured status and diff without shell interpolation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-git-'));
  try {
    await runShellCommand({ root, unrestricted: false, workdir: root, command: 'git init -q; git config user.email test@example.com; git config user.name test; node -e "require(\'fs\').writeFileSync(\'tracked.txt\', \'one\\n\')"; git add tracked.txt; git commit -qm initial; node -e "require(\'fs\').appendFileSync(\'tracked.txt\', \'two\\n\')"' });
    const status = await gitStatus({ root, unrestricted: false, path: root });
    assert.equal(status.clean, false);
    assert.equal(status.files[0].path, 'tracked.txt');
    const diff = await gitDiff({ root, unrestricted: false, path: root });
    assert.match(diff.diff, /two/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('structured git write tools stage, commit, inspect, and switch branches', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-git-write-'));
  const machine = { root, unrestricted: false };
  try {
    await runShellCommand({
      ...machine,
      workdir: root,
      command: 'git init -q; git config user.email test@example.com; git config user.name test; node -e "require(\'fs\').writeFileSync(\'tracked.txt\', \'one\\n\')"',
    });

    const staged = await gitAdd({ ...machine, path: root, paths: ['tracked.txt'] });
    assert.equal(staged.status.summary.staged, 1);

    const committed = await gitCommit({ ...machine, path: root, message: 'initial' });
    assert.match(committed.commit, /^[a-f0-9]{40}$/);

    const log = await gitLog({ ...machine, path: root, maxCount: 5 });
    assert.equal(log.commits[0]?.subject, 'initial');

    const shown = await gitShow({ ...machine, path: root, ref: 'HEAD', statOnly: true });
    assert.match(shown.output, /initial/);

    const switched = await gitCheckout({ ...machine, path: root, branch: 'feature/test', create: true });
    assert.equal(switched.branch, 'feature/test');
    const branches = await gitBranch({ ...machine, path: root });
    assert.equal(branches.branches.find((branch) => branch.name === 'feature/test')?.current, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('catastrophic commands are blocked in safe workspace mode', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-guardrail-'));
  try {
    await assert.rejects(
      runShellCommand({ command: 'rmdir /s /q C:\\', root, unrestricted: false }),
      (error: unknown) => (error as { code?: string }).code === 'POLICY_DENIED',
    );
    await assert.rejects(
      runShellCommand({ command: 'rm -rf /*', root, unrestricted: false }),
      (error: unknown) => (error as { code?: string }).code === 'POLICY_DENIED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
