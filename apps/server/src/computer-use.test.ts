import assert from 'node:assert/strict';
import test from 'node:test';
import { createComputerUseSpecs } from './computer-use.js';

function byName() {
  return new Map(createComputerUseSpecs().map((spec) => [spec.name, spec]));
}

test('computer automation separates observation from input mutation', () => {
  const specs = createComputerUseSpecs();
  assert.deepEqual(specs.map((spec) => spec.name), ['computer_observe', 'computer_act']);
  const observe = specs[0]!;
  const act = specs[1]!;
  assert.equal(observe.annotations.readOnlyHint, true);
  assert.equal(observe.annotations.destructiveHint, false);
  assert.equal(act.annotations.destructiveHint, true);
  const schema = act.inputSchema as { properties?: Record<string, unknown> };
  assert.equal('command' in (schema.properties ?? {}), false);
  assert.equal('script' in (schema.properties ?? {}), false);
});

test('computer_act rejects malformed and unsupported input before desktop I/O', async () => {
  const act = byName().get('computer_act')!;
  await assert.rejects(() => act.handler({}), /action/);
  await assert.rejects(() => act.handler({ action: 'hotkey', keys: ['Ctrl'] }), /2-8/);
  await assert.rejects(() => act.handler({ action: 'key', key: 'DefinitelyNotAKey' }), /Unsupported key/);
  await assert.rejects(() => act.handler({ action: 'scroll', delta: 0 }), /non-zero/);
  await assert.rejects(() => act.handler({ action: 'move', y: 10 }), /"x" is required/);
  await assert.rejects(() => act.handler({ action: 'click', x: 10 }), /"y" is required/);
  await assert.rejects(() => act.handler({ action: 'scroll' }), /"delta" is required/);
  await assert.rejects(() => act.handler({ action: 'batch', steps: [] }), /steps/);
});

test('computer_observe validates zoom regions before capture', async () => {
  const observe = byName().get('computer_observe')!;
  await assert.rejects(() => observe.handler({ action: 'zoom' }), /"x" is required/);
});
