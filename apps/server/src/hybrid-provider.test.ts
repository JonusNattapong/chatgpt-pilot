import assert from 'node:assert/strict';
import test from 'node:test';
import { createHybridProvider } from './hybrid-provider.js';
import type { ToolSpec } from './tools.js';

function spec(name: string, readOnlyHint = true): ToolSpec {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint, destructiveHint: !readOnlyHint, openWorldHint: false },
    handler: async (args) => ({ name, args }),
  };
}

test('hybrid provider exposes a compact ChatGPT-facing surface', () => {
  const runtime = spec('runtime_exec', false);
  const provider = createHybridProvider({ capabilities: [spec('read_file'), spec('git_diff'), runtime] });
  assert.equal(provider.id, 'hybrid');
  assert.deepEqual(provider.tools().map((tool) => tool.name), ['toolpy', 'capability_registry']);
  assert.equal(provider.tools()[0]?.handler, runtime.handler);
  assert.equal(provider.tools()[0]?.annotations.destructiveHint, true);
});

test('capability registry groups hidden primitives without exposing handlers', async () => {
  const provider = createHybridProvider({
    capabilities: [
      spec('read_file'),
      spec('thinkforge_challenge_idea'),
      spec('skills_skill_search'),
      spec('memory_recall'),
      spec('flow_create', false),
      spec('runtime_exec', false),
    ],
  });
  const registry = provider.tools().find((tool) => tool.name === 'capability_registry');
  assert.ok(registry);
  const result = await registry.handler({});
  assert.deepEqual(result, {
    mode: 'hybrid',
    groups: [
      { id: 'coding', description: 'Machine, filesystem, process, Git, verification, network, and developer operations.', tools: ['read_file'] },
      { id: 'think', description: 'Reasoning accelerators supplied by ThinkForge-compatible capability providers.', tools: ['thinkforge_challenge_idea'] },
      { id: 'skills', description: 'Reusable procedures and workflow knowledge supplied by Skill Hub-compatible providers.', tools: ['skills_skill_search'] },
      { id: 'memory', description: 'Persistent recall and write-back supplied by memory capability providers.', tools: ['memory_recall'] },
      { id: 'flow', description: 'Durable DAG orchestration, checkpoints, resume, and bounded parallel capability execution.', tools: ['flow_create'] },
    ],
    capabilityCount: 5,
  });
});

test('capability registry supports a bounded group filter', async () => {
  const provider = createHybridProvider({ capabilities: [spec('read_file'), spec('memory_recall'), spec('runtime_exec', false)] });
  const registry = provider.tools()[1]!;
  const result = await registry.handler({ group: 'memory' }) as { groups: Array<{ id: string; tools: string[] }> };
  assert.deepEqual(result.groups, [{ id: 'memory', description: 'Persistent recall and write-back supplied by memory capability providers.', tools: ['memory_recall'] }]);
  await assert.rejects(() => registry.handler({ group: 'other' }), /must be one of/);
});

test('hybrid provider fails fast without runtime_exec', () => {
  assert.throws(() => createHybridProvider({ capabilities: [spec('read_file')] }), /requires the runtime_exec capability/);
});
