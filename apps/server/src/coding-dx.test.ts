import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createToolSpecs } from './tools.js';

async function withRoot(prefix: string, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('read_files batches bounded reads and preserves per-file failures', async () => {
  await withRoot('machine-mcp-read-files-', async (root) => {
    await writeFile(path.join(root, 'a.txt'), 'alpha\n', 'utf8');
    await writeFile(path.join(root, 'b.txt'), 'beta\n', 'utf8');
    const specs = createToolSpecs({ root, unrestricted: false, maxTimeoutMs: 60_000 });
    const readFiles = specs.find((spec) => spec.name === 'read_files')!;
    const result = await readFiles.handler({
      files: [
        { path: 'a.txt', line_numbers: true },
        { path: 'missing.txt' },
        { path: 'b.txt' },
      ],
      max_total_bytes: 4096,
    }) as {
      files: Array<{ path: string; content?: string; sha256?: string; error?: { code: string } }>;
      totalBytes: number;
      maxTotalBytes: number;
    };

    assert.equal(result.files.length, 3);
    assert.match(result.files[0]!.content ?? '', /^1\talpha/);
    assert.match(result.files[0]!.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(result.files[1]!.error?.code, 'NOT_FOUND');
    assert.equal(result.files[2]!.content, 'beta');
    assert.ok(result.totalBytes <= result.maxTotalBytes);
  });
});

test('project_snapshot returns package, scripts, tree, project type, and bounded instructions', async () => {
  await withRoot('machine-mcp-project-snapshot-', async (root) => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'snapshot-fixture', version: '1.2.3', scripts: { build: 'tsc', test: 'node --test' } }, null, 2), 'utf8');
    await writeFile(path.join(root, 'AGENTS.md'), '# Instructions\nKeep changes bounded.\n', 'utf8');
    await writeFile(path.join(root, 'GPT.md'), '# Pilot\nUse project context.\n', 'utf8');
    const pilotHome = path.join(root, '.test-pilot-home');
    await mkdir(pilotHome, { recursive: true });
    await writeFile(path.join(pilotHome, 'GPT.md'), '# Global\nPrefer structured tools.\n', 'utf8');
    await writeFile(path.join(root, 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');

    const specs = createToolSpecs({ root, unrestricted: false, maxTimeoutMs: 60_000, pilotHome });
    const snapshotTool = specs.find((spec) => spec.name === 'project_snapshot')!;
    const snapshot = await snapshotTool.handler({ include: ['tree', 'package', 'scripts', 'instructions'] }) as {
      projectTypes: string[];
      tree: { entries: Array<{ name: string }> };
      package: { name: string; version: string };
      scripts: Record<string, string>;
      instructions: Array<{ path: string; content: string; sha256: string }>;
      pilotContext: { sources: Array<{ id: string; exists: boolean; content?: string }> };
    };

    assert.deepEqual(snapshot.projectTypes, ['node']);
    assert.ok(snapshot.tree.entries.some((entry) => entry.name === 'src'));
    assert.equal(snapshot.package.name, 'snapshot-fixture');
    assert.equal(snapshot.package.version, '1.2.3');
    assert.equal(snapshot.scripts.build, 'tsc');
    assert.equal(snapshot.instructions.length, 2);
    assert.match(snapshot.instructions[0]!.content, /Keep changes bounded/);
    assert.match(snapshot.instructions[0]!.sha256, /^[a-f0-9]{64}$/);
    assert.equal(snapshot.pilotContext.sources.find((source) => source.id === 'global_gpt')?.exists, true);
    assert.equal(snapshot.pilotContext.sources.find((source) => source.id === 'repo_gpt')?.exists, true);
  });
});

test('machine_status derives restartRequired from live workerRoot versus configuredRoot', async () => {
  await withRoot('machine-mcp-status-semantics-', async (root) => {
    const runtimeRoot = path.join(root, 'runtime');
    const configuredRoot = path.join(root, 'configured');
    const stateDir = path.join(root, 'state');
    await mkdir(runtimeRoot, { recursive: true });
    await mkdir(configuredRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const stateFile = path.join(stateDir, 'supervisor.json');
    const configFile = path.join(stateDir, 'config.json');
    await writeFile(stateFile, JSON.stringify({ health: 'healthy', circuit: 'closed', workerRoot: runtimeRoot, restarts: 0 }), 'utf8');
    await writeFile(configFile, JSON.stringify({ workspaceRoot: configuredRoot }), 'utf8');

    const savedStateFile = process.env.MCP_SUPERVISOR_STATE_FILE;
    const savedSupervised = process.env.MCP_SUPERVISED;
    process.env.MCP_SUPERVISOR_STATE_FILE = stateFile;
    process.env.MCP_SUPERVISED = '1';
    try {
      const specs = createToolSpecs({ root: runtimeRoot, unrestricted: false, maxTimeoutMs: 60_000 });
      const statusTool = specs.find((spec) => spec.name === 'machine_status')!;
      const mismatch = await statusTool.handler({}) as {
        workspace: { runtimeRoot: string; configuredRoot: string; configApplied: boolean };
        diagnostics: { restartRequired: boolean; configApplied: boolean };
      };
      assert.equal(path.resolve(mismatch.workspace.runtimeRoot), path.resolve(runtimeRoot));
      assert.equal(path.resolve(mismatch.workspace.configuredRoot), path.resolve(configuredRoot));
      assert.equal(mismatch.workspace.configApplied, false);
      assert.equal(mismatch.diagnostics.configApplied, false);
      assert.equal(mismatch.diagnostics.restartRequired, true);

      await writeFile(configFile, JSON.stringify({ workspaceRoot: runtimeRoot }), 'utf8');
      const applied = await statusTool.handler({}) as { workspace: { configApplied: boolean }; diagnostics: { restartRequired: boolean } };
      assert.equal(applied.workspace.configApplied, true);
      assert.equal(applied.diagnostics.restartRequired, false);
    } finally {
      if (savedStateFile === undefined) delete process.env.MCP_SUPERVISOR_STATE_FILE;
      else process.env.MCP_SUPERVISOR_STATE_FILE = savedStateFile;
      if (savedSupervised === undefined) delete process.env.MCP_SUPERVISED;
      else process.env.MCP_SUPERVISED = savedSupervised;
    }
  });
});
