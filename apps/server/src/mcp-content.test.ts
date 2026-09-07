import assert from 'node:assert/strict';
import test from 'node:test';
import { isMcpImageResult, mcpImageResult } from './mcp-content.js';

test('MCP image result keeps binary payload separate from structured metadata', () => {
  const result = mcpImageResult(Buffer.from([1, 2, 3]), 'image/png', { width: 1, height: 1 });
  assert.equal(isMcpImageResult(result), true);
  assert.equal(result.data, 'AQID');
  assert.deepEqual(result.value, { width: 1, height: 1 });
  assert.equal(isMcpImageResult({ data: result.data, mimeType: 'image/png' }), false);
});
