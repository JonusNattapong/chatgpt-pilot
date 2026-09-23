import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CONTRACT_VERSION, createContractManifest } from './contract.js';
import { createToolSpecs } from './tools.js';

test('v13 contract manifest is deterministic and covers the 74 public tools', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-contract-'));
  try {
    const specs = createToolSpecs({ root, unrestricted: false, maxTimeoutMs: 60_000 });
    const first = createContractManifest(specs);
    const second = createContractManifest(specs);
    assert.equal(CONTRACT_VERSION, 13);
    assert.equal(first.contractVersion, 13);
    assert.equal(first.tools.length, 74);
    assert.equal(first.fingerprint, second.fingerprint);
    assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(new Set(first.tools.map((tool) => tool.name)).size, 74);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
