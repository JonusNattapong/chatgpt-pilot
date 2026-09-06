import assert from 'node:assert/strict';
import test from 'node:test';
import { createFlowProvider } from './flow-provider.js';
import type { ToolSpec } from './tools.js';

function spec(name: string, handler: ToolSpec['handler'], readOnlyHint = false): ToolSpec {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint, destructiveHint: !readOnlyHint, openWorldHint: false },
    handler,
  };
}

test('flow provider runs independent edit capabilities concurrently without a file lock', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const edit = spec('edit_file', async (args) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 35));
    inFlight--;
    return { path: args.path };
  });
  const verify = spec('verify_changes', async () => ({ ok: true }), true);
  const provider = createFlowProvider({
    root: process.cwd(),
    dbPath: ':memory:',
    capabilities: () => [edit, verify],
    policyCheck: () => ({ allowed: true, requiresApproval: false }),
  });
  try {
    const byName = new Map(provider.tools().map((tool) => [tool.name, tool]));
    const created = await byName.get('flow_create')!.handler({
      id: 'parallel-edit',
      goal: 'edit two files then verify',
      concurrency: 4,
      steps: [
        { id: 'a', capability: 'edit_file', input: { path: 'a.ts', expected_sha256: 'a'.repeat(64) } },
        { id: 'b', capability: 'edit_file', input: { path: 'b.ts', expected_sha256: 'b'.repeat(64) } },
        { id: 'verify', capability: 'verify_changes', depends_on: ['a', 'b'] },
      ],
    }) as { run: { id: string } };
    const completed = await byName.get('flow_run')!.handler({ run_id: created.run.id }) as { run: { state: string } };
    assert.equal(completed.run.state, 'completed');
    assert.equal(maxInFlight, 2);
  } finally {
    await provider.close();
  }
});

test('flow provider fails closed when a nested capability requires approval', async () => {
  let called = 0;
  const write = spec('write_file', async () => { called++; return { ok: true }; });
  const provider = createFlowProvider({
    root: process.cwd(),
    dbPath: ':memory:',
    capabilities: () => [write],
    policyCheck: () => ({ allowed: true, requiresApproval: true }),
  });
  try {
    const byName = new Map(provider.tools().map((tool) => [tool.name, tool]));
    const created = await byName.get('flow_create')!.handler({ goal: 'guard approval', steps: [{ id: 'write', capability: 'write_file' }] }) as { run: { id: string } };
    const failed = await byName.get('flow_run')!.handler({ run_id: created.run.id }) as { run: { state: string }, steps: Array<{ error: string | null }> };
    assert.equal(failed.run.state, 'failed');
    assert.match(failed.steps[0]?.error ?? '', /requires approval/);
    assert.equal(called, 0);
  } finally {
    await provider.close();
  }
});
