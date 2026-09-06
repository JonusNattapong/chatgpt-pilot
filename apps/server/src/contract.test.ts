import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CONTRACT_VERSION, createContractManifest } from './contract.js';
import { createToolSpecs } from './tools.js';

test('v7 contract manifest is deterministic and covers the 53 public tools', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-contract-'));
  try {
    const specs = createToolSpecs({ root, unrestricted: false, maxTimeoutMs: 60_000 });
    const first = createContractManifest(specs);
    const second = createContractManifest(specs);
    assert.equal(CONTRACT_VERSION, 7);
    assert.equal(first.contractVersion, 7);
    assert.equal(first.tools.length, 53);
    assert.equal(first.fingerprint, second.fingerprint);
    assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(new Set(first.tools.map((tool) => tool.name)).size, 53);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

