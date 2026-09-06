import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolSpec } from './tools.js';
import { ToolGateway, type ToolProvider } from './gateway.js';
import { createMachineProvider } from './machine-provider.js';

function tool(name: string): ToolSpec {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: async () => ({ name }),
  };
}

function provider(id: string, tools: ToolSpec[]): ToolProvider {
  return { id, tools: () => tools };
}

test('ToolGateway resolves tools to their owning provider without changing public names', () => {
  const gateway = new ToolGateway([
    provider('machine', [tool('read_file'), tool('git_status')]),
    provider('thinkforge', [tool('thinkforge_challenge')]),
  ]);

  assert.deepEqual(gateway.listTools().map((entry) => entry.name), [
    'read_file',
    'git_status',
    'thinkforge_challenge',
  ]);
  assert.equal(gateway.resolve('read_file')?.providerId, 'machine');
  assert.equal(gateway.resolve('thinkforge_challenge')?.providerId, 'thinkforge');
  assert.equal(gateway.resolve('missing'), undefined);
});

test('ToolGateway fails closed when providers expose the same public tool name', () => {
  assert.throws(
    () => new ToolGateway([
      provider('machine', [tool('read_file')]),
      provider('other', [tool('read_file')]),
    ]),
    /Duplicate tool name "read_file".*machine.*other/,
  );
});

test('ToolGateway rejects duplicate provider ids', () => {
  assert.throws(
    () => new ToolGateway([
      provider('machine', [tool('read_file')]),
      provider('machine', [tool('git_status')]),
    ]),
    /Duplicate provider id "machine"/,
  );
});

test('ToolGateway exposes bounded provider metadata without handlers', () => {
  const gateway = new ToolGateway([
    provider('machine', [tool('read_file'), tool('git_status')]),
    provider('skills', []),
  ]);

  assert.deepEqual(gateway.providers(), [
    { id: 'machine', toolCount: 2, tools: ['read_file', 'git_status'] },
    { id: 'skills', toolCount: 0, tools: [] },
  ]);
});

test('machine provider preserves the existing public tool surface', () => {
  const machine = createMachineProvider({
    root: process.cwd(),
    unrestricted: false,
    maxTimeoutMs: 60_000,
  });
  const gateway = new ToolGateway([machine]);
  const names = gateway.listTools().map((entry) => entry.name);

  assert.equal(machine.id, 'machine');
  assert.equal(names.length, 62);
  assert.ok(names.includes('machine_status'));
  assert.ok(names.includes('runtime_exec'));
  assert.equal(gateway.resolve('machine_status')?.providerId, 'machine');
});
