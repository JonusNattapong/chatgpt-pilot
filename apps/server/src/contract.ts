import { createHash } from 'node:crypto';
import type { ToolSpec } from './tools.js';

export const CONTRACT_VERSION = 7;

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function createContractManifest(specs: ToolSpec[]) {
  const tools = specs.map((spec) => ({
    name: spec.name,
    inputSchema: canonicalize(spec.inputSchema),
    annotations: canonicalize(spec.annotations),
  }));
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(canonicalize({ contractVersion: CONTRACT_VERSION, tools })))
    .digest('hex');
  return { contractVersion: CONTRACT_VERSION, fingerprint, tools };
}

