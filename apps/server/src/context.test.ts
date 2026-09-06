import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { explainPilotContext, initGlobalGpt, loadPilotContext } from './context.js';
import { createToolSpecs } from './tools.js';

async function fixture(fn: (root: string, home: string, repo: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'pilot-context-'));
  const home = path.join(root, 'home', '.pilot');
  const repo = path.join(root, 'repo');
  await mkdir(home, { recursive: true });
  await mkdir(path.join(repo, '.git'), { recursive: true });
  try { await fn(root, home, repo); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test('loads global GPT, AGENTS, and repo GPT in deterministic precedence order', async () => {
  await fixture(async (_root, home, repo) => {
    await writeFile(path.join(home, 'GPT.md'), '# Global\nPrefer Pilot.\n', 'utf8');
    await writeFile(path.join(repo, 'AGENTS.md'), '# Agents\nRun tests.\n', 'utf8');
    await writeFile(path.join(repo, 'GPT.md'), '# Repo\nUse Skill Hub first.\n', 'utf8');
    const nested = path.join(repo, 'src', 'feature');
    await mkdir(nested, { recursive: true });

    const bundle = await loadPilotContext(nested, { pilotHome: home });
    assert.equal(bundle.repoRoot, repo);
    assert.deepEqual(bundle.sources.map((source) => [source.id, source.priority, source.exists]), [
      ['global_gpt', 10, true],
      ['repo_agents', 20, true],
      ['repo_gpt', 30, true],
    ]);
    assert.ok(bundle.merged.indexOf('# Global') < bundle.merged.indexOf('# Agents'));
    assert.ok(bundle.merged.indexOf('# Agents') < bundle.merged.indexOf('# Repo'));
    assert.equal(bundle.precedence[0]?.priority, 'guardrail');
  });
});

test('context explanation reports provenance and highest-priority matching source', async () => {
  await fixture(async (_root, home, repo) => {
    await writeFile(path.join(home, 'GPT.md'), 'verification: normal\n', 'utf8');
    await writeFile(path.join(repo, 'AGENTS.md'), 'verification: strict\n', 'utf8');
    await writeFile(path.join(repo, 'GPT.md'), 'verification: strict plus context check\n', 'utf8');
    const bundle = await loadPilotContext(repo, { pilotHome: home });
    const explained = explainPilotContext(bundle, 'verification');
    assert.equal(explained.matches.length, 3);
    assert.equal(explained.effectiveMatch?.source, 'repo_gpt');
    assert.equal(explained.effectiveMatch?.priority, 30);
    assert.match(explained.note, /never overrides runtime\/system security/);
  });
});

test('restricted context discovery does not walk above the workspace boundary', async () => {
  await fixture(async (_root, home, repo) => {
    await writeFile(path.join(repo, 'GPT.md'), 'outside workspace\n', 'utf8');
    const workspace = path.join(repo, 'packages', 'feature');
    await mkdir(workspace, { recursive: true });
    const bundle = await loadPilotContext(workspace, { pilotHome: home, boundaryRoot: workspace });
    assert.equal(bundle.repoRoot, workspace);
    assert.equal(bundle.sources.find((source) => source.id === 'repo_gpt')?.exists, false);
    assert.doesNotMatch(bundle.merged, /outside workspace/);
  });
});

test('global GPT initialization is create-once and never overwrites user content', async () => {
  await fixture(async (root) => {
    const pilotHome = path.join(root, 'new-home', '.pilot');
    const first = await initGlobalGpt(pilotHome);
    assert.equal(first.created, true);
    await writeFile(first.path, 'custom user rules\n', 'utf8');
    const second = await initGlobalGpt(pilotHome);
    assert.equal(second.created, false);
    assert.equal(await readFile(first.path, 'utf8'), 'custom user rules\n');
  });
});

test('context_info and context_explain expose the context chain through ToolSpec', async () => {
  await fixture(async (_root, home, repo) => {
    await writeFile(path.join(home, 'GPT.md'), 'Prefer structured Pilot capabilities.\n', 'utf8');
    await writeFile(path.join(repo, 'AGENTS.md'), 'Always verify.\n', 'utf8');
    await writeFile(path.join(repo, 'GPT.md'), 'Use Skill Hub.\n', 'utf8');
    const specs = createToolSpecs({ root: repo, unrestricted: false, maxTimeoutMs: 60_000, pilotHome: home });
    const info = await specs.find((spec) => spec.name === 'context_info')!.handler({ include_content: false }) as {
      sources: Array<{ id: string; exists: boolean; content?: string }>;
      merged?: string;
    };
    assert.deepEqual(info.sources.map((source) => source.id), ['global_gpt', 'repo_agents', 'repo_gpt']);
    assert.equal(info.sources.every((source) => source.exists), true);
    assert.equal(info.sources.every((source) => source.content === undefined), true);
    assert.equal(info.merged, undefined);

    const explained = await specs.find((spec) => spec.name === 'context_explain')!.handler({ query: 'Skill Hub' }) as {
      effectiveMatch?: { source: string };
    };
    assert.equal(explained.effectiveMatch?.source, 'repo_gpt');
  });
});
