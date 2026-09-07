import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserUseSpecs } from './browser-use.js';

function byName() {
  return new Map(createBrowserUseSpecs(60_000).map((spec) => [spec.name, spec]));
}

test('browser automation exposes a compact ref-first surface', () => {
  const specs = createBrowserUseSpecs(60_000);
  assert.deepEqual(specs.map((spec) => spec.name), [
    'browser_session',
    'browser_snapshot',
    'browser_find',
    'browser_screenshot',
    'browser_act',
  ]);
  assert.equal(specs.find((spec) => spec.name === 'browser_snapshot')?.annotations.readOnlyHint, true);
  assert.equal(specs.find((spec) => spec.name === 'browser_screenshot')?.annotations.readOnlyHint, true);
  assert.equal(specs.find((spec) => spec.name === 'browser_act')?.annotations.destructiveHint, true);
});

test('browser_session validates session ids and URLs before browser launch', async () => {
  const session = byName().get('browser_session')!;
  await assert.rejects(() => session.handler({ action: 'close', session_id: 'not valid' }), /session_id/);
  await assert.rejects(() => session.handler({ action: 'navigate', url: 'file:///C:/Windows/win.ini' }), /http:\/\/ and https:\/\//);
  await assert.rejects(() => session.handler({ action: 'navigate', url: 'not-a-url' }), /absolute http\(s\)/);
  await assert.rejects(() => session.handler({ action: 'start', url: 'not-a-url' }), /absolute http\(s\)/);
});

test('browser_session close is idempotent for an absent session', async () => {
  const session = byName().get('browser_session')!;
  assert.deepEqual(await session.handler({ action: 'close', session_id: 'missing' }), {
    action: 'close',
    sessionId: 'missing',
    closed: false,
    alreadyClosed: true,
  });
});

test('browser_act rejects malformed batches before browser I/O', async () => {
  const act = byName().get('browser_act')!;
  await assert.rejects(() => act.handler({ action: 'batch', steps: [] }), /steps/);
  await assert.rejects(() => act.handler({ action: 'wait' }), /duration_ms/);
});
