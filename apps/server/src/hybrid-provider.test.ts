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

test('hybrid provider exposes all capabilities directly', () => {
  const automation = [
    spec('browser_session', false),
    spec('browser_snapshot'),
    spec('browser_find'),
    spec('browser_screenshot'),
    spec('browser_act', false),
    spec('computer_observe'),
    spec('computer_act', false),
  ];
  const capabilities = [spec('read_file'), spec('git_diff'), ...automation];
  const provider = createHybridProvider({ capabilities });
  assert.equal(provider.id, 'hybrid');
  assert.deepEqual(provider.tools().map((tool) => tool.name), capabilities.map((spec) => spec.name));
});
