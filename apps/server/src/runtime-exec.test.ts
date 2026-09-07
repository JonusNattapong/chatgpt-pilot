import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PersistentIpythonRuntime, type RuntimeCapability } from './runtime-exec.js';
import { ToolError } from './errors.js';

const capabilities: RuntimeCapability[] = [
  {
    name: 'read_file',
    description: 'Read a fixture file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'write_file',
    description: 'Mutating fixture capability.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
];

const kernelProbe = spawnSync('python', ['-c', 'import IPython, ipykernel, jupyter_client'], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 5_000,
});
const hasKernel = kernelProbe.status === 0;

async function withRuntime(fn: (runtime: PersistentIpythonRuntime) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-ipython-runtime-'));
  const runtime = new PersistentIpythonRuntime(root);
  try {
    await fn(runtime);
  } finally {
    await runtime.disposeAll();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

function invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'read_file') return Promise.resolve({ content: `content:${String(args.path ?? '')}` });
  if (name === 'write_file') return Promise.resolve({ written: String(args.path ?? '') });
  throw new ToolError('UNKNOWN_TOOL', `Unknown test capability: ${name}`);
}

const kernelTest = hasKernel ? test : test.skip;

kernelTest('persistent IPython keeps variables, imports, and generated helpers across runtime_exec calls', async () => {
  await withRuntime(async (runtime) => {
    const first = await runtime.execute({
      code: [
        'import math',
        'seed = 41',
        'async def inspect(path):',
        '    return await tools.read_file(path=path)',
        "doc = await inspect('alpha.txt')",
        "result({'seed': seed, 'sqrt': math.sqrt(81), 'content': doc['content']})",
      ].join('\n'),
      sessionId: 'persist',
      timeoutMs: 10_000,
      maxCalls: 8,
      maxOutputBytes: 128 * 1024,
      capabilities,
      allowedTools: new Set(['read_file']),
      invoke,
    });
    assert.deepEqual(first.result, { seed: 41, sqrt: 9, content: 'content:alpha.txt' });
    assert.equal(first.runtime, 'ipython');
    assert.equal(first.persistent, true);
    assert.equal(first.calls.length, 1);

    const second = await runtime.execute({
      code: [
        "doc = await inspect('beta.txt')",
        "result({'seed': seed + 1, 'sqrt': math.sqrt(16), 'content': doc['content']})",
      ].join('\n'),
      sessionId: 'persist',
      timeoutMs: 10_000,
      maxCalls: 8,
      maxOutputBytes: 128 * 1024,
      capabilities,
      allowedTools: new Set(['read_file']),
      invoke,
    });
    assert.deepEqual(second.result, { seed: 42, sqrt: 4, content: 'content:beta.txt' });
    assert.ok(second.executionCount > first.executionCount);
    assert.equal(runtime.status()[0]?.sessionId, 'persist');
  });
});

kernelTest('persistent IPython describe exposes schemas independently from execution authorization', async () => {
  await withRuntime(async (runtime) => {
    const result = await runtime.execute({
      code: "catalog = await describe(); result([(item['name'], item['authorized']) for item in catalog])",
      sessionId: 'catalog',
      timeoutMs: 10_000,
      maxCalls: 4,
      maxOutputBytes: 128 * 1024,
      capabilities,
      allowedTools: new Set(['read_file']),
      invoke,
    });
    assert.deepEqual(result.result, [['read_file', true], ['write_file', false]]);
    assert.equal(result.calls.length, 0);
  });
});

kernelTest('persistent IPython describe accepts a batch of capability names', async () => {
  await withRuntime(async (runtime) => {
    const result = await runtime.execute({
      code: "result(await describe(names=['write_file', 'read_file']))", sessionId: 'catalog-batch', timeoutMs: 10_000, maxCalls: 4, maxOutputBytes: 128 * 1024, capabilities, allowedTools: new Set(['read_file']), invoke,
    });
    assert.deepEqual((result.result as Array<Record<string, unknown>>).map((item) => item.name), ['write_file', 'read_file']);
  });
});

kernelTest('persistent IPython preserves Unicode and omits empty duplicate output fields', async () => {
  await withRuntime(async (runtime) => {
    const output = await runtime.execute({
      code: "result({'thai': 'สวัสดี', 'emoji': '🚀', 'mixed': 'ไทย-UTF8-✅'})",
      sessionId: 'unicode',
      timeoutMs: 10_000,
      maxCalls: 2,
      maxOutputBytes: 128 * 1024,
      capabilities,
      allowedTools: new Set(['read_file']),
      invoke,
    });
    assert.deepEqual(output.result, { thai: 'สวัสดี', emoji: '🚀', mixed: 'ไทย-UTF8-✅' });
    assert.equal('stdout' in output, false);
    assert.equal('stderr' in output, false);
    assert.equal('displays' in output, false);
    assert.equal('outputTruncated' in output, false);
  });
});

kernelTest('persistent IPython rejects capability calls not declared in allow_tools', async () => {
  await withRuntime(async (runtime) => {
    await assert.rejects(
      () => runtime.execute({
        code: "await tools.write_file(path='x.txt')",
        sessionId: 'deny',
        timeoutMs: 10_000,
        maxCalls: 4,
        maxOutputBytes: 128 * 1024,
        capabilities,
        allowedTools: new Set(['read_file']),
        invoke,
      }),
      (error: unknown) => error instanceof ToolError && error.code === 'INTERNAL' && /not declared in allow_tools/.test(JSON.stringify(error.details ?? {})),
    );
  });
});

kernelTest('persistent IPython reset_session starts a fresh namespace', async () => {
  await withRuntime(async (runtime) => {
    await runtime.execute({
      code: 'kept = 123; result(kept)',
      sessionId: 'reset-me',
      timeoutMs: 10_000,
      maxCalls: 2,
      maxOutputBytes: 128 * 1024,
      capabilities,
      allowedTools: new Set(['read_file']),
      invoke,
    });
    const reset = await runtime.execute({
      code: "result('kept' in globals())",
      sessionId: 'reset-me',
      resetSession: true,
      timeoutMs: 10_000,
      maxCalls: 2,
      maxOutputBytes: 128 * 1024,
      capabilities,
      allowedTools: new Set(['read_file']),
      invoke,
    });
    assert.equal(reset.result, false);
  });
});

kernelTest('persistent IPython bounds capability calls per cell', async () => {
  await withRuntime(async (runtime) => {
    await assert.rejects(
      () => runtime.execute({
        code: [
          "await tools.read_file(path='a')",
          "await tools.read_file(path='b')",
        ].join('\n'),
        sessionId: 'call-budget',
        timeoutMs: 10_000,
        maxCalls: 1,
        maxOutputBytes: 128 * 1024,
        capabilities,
        allowedTools: new Set(['read_file']),
        invoke,
      }),
      (error: unknown) => error instanceof ToolError && error.code === 'INTERNAL' && /max_calls/.test(JSON.stringify(error.details ?? {})),
    );
  });
});
