import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GoalRunner, isDeclarationOf, parseIncludePath, parseRelativeImports, planContextWindows, resolveRelativeImport, selectTargetedCommand, termWeight, testSiblingCandidates } from './goal-runner.js';
import { GoalRuntime, type GoalProjectSnapshot, type GoalVerificationResult } from './goal-runtime.js';

async function fixture(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'math.ts'), 'export const add = (a: number, b: number) => a - b;\n', 'utf8');
  await writeFile(path.join(root, 'src', 'other.ts'), 'export const untouched = true;\n', 'utf8');
  return root;
}

function snapshot(root: string): GoalProjectSnapshot {
  return {
    path: root,
    projectTypes: ['node'],
    topLevel: ['src'],
    scripts: { test: 'node --test' },
    instructionFiles: [],
    baselineDirtyPaths: ['src/preexisting.ts'],
  };
}

function createRunner(root: string, verification: GoalVerificationResult[], targetedCheck?: (input: { files: string[]; cwd: string; timeoutMs: number }) => Promise<{ ran: boolean; files: string[]; ok: boolean; durationMs: number; diagnostics?: Array<{ file: string; line: number; message: string }> }>) {
  let verifyIndex = 0;
  const runtime = new GoalRuntime({
    root,
    unrestricted: false,
    maxTimeoutMs: 60_000,
    inspect: async () => snapshot(root),
    verify: async () => verification[Math.min(verifyIndex++, verification.length - 1)]!,
  });
  return new GoalRunner({
    root,
    unrestricted: false,
    maxTimeoutMs: 60_000,
  }, { runtime, ...(targetedCheck ? { targetedCheck } : {}) });
}

const fixPatch = [
  '*** Begin Patch',
  '*** Update File: src/math.ts',
  '@@',
  '-export const add = (a: number, b: number) => a - b;',
  '+export const add = (a: number, b: number) => a + b;',
  '*** End Patch',
].join('\n');

test('goal_run performs discovery, hash-locked patching, verification, and review', async () => {
  const root = await fixture('goal-runner-happy-');
  try {
    const runner = createRunner(root, [{ ok: true, checks: [{ name: 'test', ok: true }] }]);
    const started = await runner.run({ goal: 'fix add in src/math.ts', path: root }) as any;

    assert.equal(started.state, 'needs_patch');
    assert.ok(started.context.files.some((file: { path: string }) => file.path === 'src/math.ts'));
    assert.match(started.context.files.find((file: { path: string; content: string }) => file.path === 'src/math.ts')!.content, /a - b/);

    const patched = await runner.run({ id: started.goalId, patch: fixPatch, summary: 'Correct addition operator.' }) as any;
    assert.equal(patched.state, 'needs_review');
    assert.equal(await readFile(path.join(root, 'src', 'math.ts'), 'utf8'), 'export const add = (a: number, b: number) => a + b;\n');
    assert.ok(patched.review.changedPaths.includes('src/math.ts'));
    assert.match(patched.review.files.find((file: { path: string; content: string }) => file.path === 'src/math.ts')!.content, /a \+ b/);

    const done = await runner.run({ id: started.goalId, review: 'accept', summary: 'Diff is scoped and correct.' }) as any;
    assert.equal(done.state, 'done');
    assert.equal(done.goal.status, 'done');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('goal_run rejects a patch when source changed after context and refreshes context', async () => {
  const root = await fixture('goal-runner-stale-');
  try {
    const runner = createRunner(root, [{ ok: true }]);
    const started = await runner.run({ goal: 'fix add in src/math.ts', path: root }) as any;
    await writeFile(path.join(root, 'src', 'math.ts'), 'export const add = (a: number, b: number) => a * b;\n', 'utf8');

    const rejected = await runner.run({ id: started.goalId, patch: fixPatch }) as any;
    assert.equal(rejected.state, 'needs_patch');
    assert.equal(rejected.patchRejected.code, 'PRECONDITION_FAILED');
    assert.match(rejected.context.files.find((file: { path: string; content: string }) => file.path === 'src/math.ts')!.content, /a \* b/);
    assert.equal(await readFile(path.join(root, 'src', 'math.ts'), 'utf8'), 'export const add = (a: number, b: number) => a * b;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('goal_run refuses updates to source files absent from prepared context', async () => {
  const root = await fixture('goal-runner-context-');
  try {
    const runner = createRunner(root, [{ ok: true }]);
    const started = await runner.run({ goal: 'fix add in src/math.ts', path: root }) as any;
    const otherPatch = [
      '*** Begin Patch',
      '*** Update File: src/other.ts',
      '@@',
      '-export const untouched = true;',
      '+export const untouched = false;',
      '*** End Patch',
    ].join('\n');

    const rejected = await runner.run({ id: started.goalId, patch: otherPatch }) as any;
    assert.equal(rejected.state, 'needs_patch');
    assert.equal(rejected.patchRejected.code, 'CONTEXT_MISSING');
    assert.ok(rejected.context.files.some((file: { path: string }) => file.path === 'src/other.ts'));
    assert.equal(await readFile(path.join(root, 'src', 'other.ts'), 'utf8'), 'export const untouched = true;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('goal_run turns verification failure into repair context and verifies the repair again', async () => {
  const root = await fixture('goal-runner-repair-');
  try {
    const runner = createRunner(root, [
      {
        ok: false,
        checks: [{
          name: 'test',
          ok: false,
          diagnostics: [{ file: 'src/math.ts', line: 1, message: 'expected safeAdd export' }],
        }],
      },
      { ok: true, checks: [{ name: 'test', ok: true }] },
    ]);
    const started = await runner.run({ goal: 'fix add in src/math.ts', path: root }) as any;
    const failed = await runner.run({ id: started.goalId, patch: fixPatch }) as any;
    assert.equal(failed.state, 'needs_patch');
    assert.equal(failed.repair, true);
    assert.equal(failed.verification.ok, false);

    const repairPatch = [
      '*** Begin Patch',
      '*** Update File: src/math.ts',
      '@@',
      ' export const add = (a: number, b: number) => a + b;',
      '+export const safeAdd = add;',
      '*** End Patch',
    ].join('\n');
    const repaired = await runner.run({ id: started.goalId, patch: repairPatch }) as any;
    assert.equal(repaired.state, 'needs_review');
    assert.match(await readFile(path.join(root, 'src', 'math.ts'), 'utf8'), /safeAdd/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('goal_run review rejection schedules repair instead of completing the goal', async () => {
  const root = await fixture('goal-runner-review-');
  try {
    const runner = createRunner(root, [{ ok: true }]);
    const started = await runner.run({ goal: 'fix add in src/math.ts', path: root }) as any;
    const review = await runner.run({ id: started.goalId, patch: fixPatch }) as any;
    assert.equal(review.state, 'needs_review');

    const rejected = await runner.run({
      id: started.goalId,
      review: 'reject',
      summary: 'Need a named safeAdd export as well.',
    }) as any;
    assert.equal(rejected.state, 'needs_patch');
    assert.equal(rejected.reviewRejected, true);
    assert.equal(rejected.phase, 'execute');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function numberedFiller(count: number, marker: (line: number) => string | undefined): string {
  return Array.from({ length: count }, (_, index) => marker(index + 1) ?? `// filler ${index + 1}`).join('\n') + '\n';
}

test('context windows cluster anchors, keep the heaviest ranges, and respect the line budget', () => {
  assert.deepEqual(planContextWindows(new Map()), [{ startLine: 1, endLine: 180 }]);
  assert.deepEqual(planContextWindows(new Map([[10, 1], [40, 1]])), [{ startLine: 1, endLine: 100 }]);

  const spread = planContextWindows(new Map([[20, 1], [900, 5], [2000, 3], [3000, 0.5]]));
  assert.deepEqual(spread, [{ startLine: 1, endLine: 80 }, { startLine: 870, endLine: 960 }, { startLine: 1970, endLine: 2060 }]);
  assert.ok(spread.every((window, index) => index === 0 || window.startLine > spread[index - 1]!.endLine));

  const budgeted = planContextWindows(new Map([[100, 1], [500, 1], [900, 1]]), 3, 150);
  assert.equal(budgeted.reduce((sum, window) => sum + window.endLine - window.startLine + 1, 0), 150);
});

test('discovery heuristics prefer declarations, rare terms, and conventional test siblings', () => {
  assert.equal(isDeclarationOf('export function computeTotal(items: Item[]) {', 'computeTotal'), true);
  assert.equal(isDeclarationOf('  async computeTotal(items) {', 'computeTotal'), true);
  assert.equal(isDeclarationOf('def compute_total(items):', 'compute_total'), true);
  assert.equal(isDeclarationOf('const value = computeTotal(items);', 'computeTotal'), false);
  assert.equal(isDeclarationOf('if (ready) {', 'ready'), false);
  assert.ok(termWeight(1) > termWeight(4));
  assert.ok(termWeight(4) > termWeight(24));

  assert.deepEqual(testSiblingCandidates('src/billing.ts'), ['src/billing.test.ts', 'src/billing.spec.ts', 'src/__tests__/billing.test.ts']);
  assert.deepEqual(testSiblingCandidates('pkg/tax.py'), ['pkg/test_tax.py', 'pkg/tax_test.py', 'tests/test_tax.py']);
  assert.deepEqual(testSiblingCandidates('src/billing.test.ts'), []);
});

test('goal_run shows a symbol declared deep in a large file together with its test', async () => {
  const root = await fixture('goal-runner-deep-');
  try {
    await writeFile(
      path.join(root, 'src', 'billing.ts'),
      // An early mention used to pin the single context window to the top of the file.
      numberedFiller(600, (line) => {
        if (line === 3) return '// Totals are produced by computeInvoiceTotal further down.';
        if (line === 450) return 'export function computeInvoiceTotal(lines: number[]) { return lines.length; }';
        return undefined;
      }),
      'utf8',
    );
    await writeFile(path.join(root, 'src', 'billing.test.ts'), "import { computeInvoiceTotal } from './billing.js';\n", 'utf8');
    await writeFile(path.join(root, 'src', 'caller.ts'), "import { computeInvoiceTotal } from './billing.js';\nexport const total = computeInvoiceTotal([1]);\n", 'utf8');

    const runner = createRunner(root, [{ ok: true }]);
    const started = await runner.run({ goal: 'computeInvoiceTotal should sum the line amounts', path: root }) as any;
    const billing = started.context.files.find((file: { path: string }) => file.path === 'src/billing.ts');
    assert.ok(billing, 'declaring file is in context');
    assert.equal(started.context.files[0].path, 'src/billing.ts', 'declaring file ranks first');
    assert.ok(billing.windows.some((window: { startLine: number; endLine: number }) => window.startLine <= 450 && window.endLine >= 450));
    assert.match(billing.content, /^\s*450\texport function computeInvoiceTotal/m);
    assert.match(billing.content, /^\s*3\t\/\/ Totals are produced by computeInvoiceTotal/m);
    assert.match(billing.content, /\.\.\. lines \d+-\d+ omitted \.\.\.\n\s*\d+\t/);
    assert.equal(billing.windows.length, 2);
    assert.ok(billing.reasons.includes('declares "computeInvoiceTotal"'));
    assert.equal(billing.totalLines, 600);

    const sibling = started.context.files.find((file: { path: string }) => file.path === 'src/billing.test.ts');
    assert.ok(sibling, 'test sibling is in context');
    assert.ok(sibling.reasons.includes('test for src/billing.ts'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('goal_run repair context is anchored at the failing diagnostic line', async () => {
  const root = await fixture('goal-runner-diagnostic-');
  try {
    await writeFile(
      path.join(root, 'src', 'big.ts'),
      numberedFiller(800, (line) => (line === 500 ? 'export const broken: number = "nope";' : undefined)),
      'utf8',
    );
    const runner = createRunner(root, [
      {
        ok: false,
        checks: [{
          name: 'typecheck',
          ok: false,
          diagnostics: [
            { file: 'src/big.ts', line: 500, message: "Type 'string' is not assignable to type 'number'." },
            { file: 'src/big.ts', line: 5000, message: 'stale diagnostic past the end of the file' },
          ],
        }],
      },
      { ok: true },
    ]);
    const started = await runner.run({ goal: 'fix add in src/math.ts', path: root }) as any;
    const failed = await runner.run({ id: started.goalId, patch: fixPatch }) as any;
    assert.equal(failed.state, 'needs_patch');
    assert.equal(failed.repair, true);

    const big = failed.context.files.find((file: { path: string }) => file.path === 'src/big.ts');
    assert.ok(big, 'file named by the diagnostic is in context');
    assert.match(big.content, /^\s*500\texport const broken/m);
    assert.ok(big.reasons.some((reason: string) => reason.includes('line 500') && reason.includes('not assignable')));
    assert.ok(!failed.context.warnings.some((warning: string) => warning.includes('big.ts')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('include path ranges are strict and preserve the requested window', () => {
  assert.deepEqual(parseIncludePath('src/x.ts#L400-L520'), { path: 'src/x.ts', startLine: 400, endLine: 520 });
  assert.deepEqual(parseIncludePath('src/x.ts#L400'), { path: 'src/x.ts', startLine: 400, endLine: 400 });
  assert.throws(() => parseIncludePath('src/x.ts#L0'), /start line/);
  assert.throws(() => parseIncludePath('src/x.ts#L5-L4'), /end line/);
  assert.throws(() => parseIncludePath('src/x.ts#L1-L401'), /400/);
});

test('relative import helpers parse and resolve supported TypeScript and Python imports', () => {
  const imports = parseRelativeImports([
    "import { add } from './math.js';",
    "export { value } from './values';",
    "const lazy = import('./lazy');",
    "const req = require('./req');",
  ].join('\n'), 'ts');
  assert.deepEqual(imports.map((item) => item.specifier), ['./math.js', './values', './lazy', './req']);
  const available = new Set(['src/math.ts', 'src/values.tsx', 'src/lazy/index.ts', 'src/req.js']);
  assert.equal(resolveRelativeImport('src/main.ts', './math.js', available), 'src/math.ts');
  assert.equal(resolveRelativeImport('src/main.ts', './values', available), 'src/values.tsx');
  assert.equal(resolveRelativeImport('src/main.ts', './lazy', available), 'src/lazy/index.ts');
  assert.equal(resolveRelativeImport('src/main.ts', 'react', available), undefined);
  assert.equal(resolveRelativeImport('pkg/mod.py', '.helpers', new Set(['pkg/helpers.py'])), 'pkg/helpers.py');
});

test('goal_run adds bounded import neighbours with optional context', async () => {
  const root = await fixture('goal-runner-imports-');
  try {
    await writeFile(path.join(root, 'src', 'math.test.ts'), "import { add } from './math.js';\n", 'utf8');
    await writeFile(path.join(root, 'src', 'caller.ts'), "import { add } from './math.js';\nexport const result = add(1, 2);\n", 'utf8');
    const runner = createRunner(root, [{ ok: true }]);
    const started = await runner.run({ goal: 'fix add in src/math.ts', path: root }) as any;
    const paths = started.context.files.map((file: { path: string }) => file.path);
    assert.ok(paths.includes('src/caller.ts'));
    assert.ok(started.context.files.find((file: { path: string; reasons: string[] }) => file.path === 'src/caller.ts')!.reasons.includes('imports src/math.ts'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('goal_run keeps an explicit include range as an exact context window', async () => {
  const root = await fixture('goal-runner-range-');
  try {
    await writeFile(path.join(root, 'src', 'large.ts'), numberedFiller(600, (line) => line === 450 ? 'export const selected = true;' : undefined), 'utf8');
    const runner = createRunner(root, [{ ok: true }]);
    const started = await runner.run({ goal: 'inspect selected in src/large.ts', path: root, includePaths: ['src/large.ts#L450-L450'] }) as any;
    const large = started.context.files.find((file: { path: string }) => file.path === 'src/large.ts');
    assert.ok(large);
    assert.ok(large.windows.some((window: { startLine: number; endLine: number }) => window.startLine === 450 && window.endLine === 450));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('goal_run records context usefulness and applies the bounded history prior', async () => {
  const root = await fixture('goal-runner-history-');
  try {
    const now = () => '2026-01-01T00:00:00.000Z';
    const first = new GoalRunner({ root, unrestricted: false, maxTimeoutMs: 60_000 }, { now, runtime: new GoalRuntime({ root, unrestricted: false, maxTimeoutMs: 60_000, inspect: async () => snapshot(root), verify: async () => ({ ok: true }) }) });
    const started = await first.run({ goal: 'fix add in src/math.ts', path: root }) as any;
    await first.run({ id: started.goalId, patch: fixPatch });
    const second = new GoalRunner({ root, unrestricted: false, maxTimeoutMs: 60_000 }, { now, runtime: new GoalRuntime({ root, unrestricted: false, maxTimeoutMs: 60_000, inspect: async () => snapshot(root), verify: async () => ({ ok: true }) }) });
    const next = await second.run({ goal: 'fix add in src/math.ts', path: root }) as any;
    assert.ok(next.context.files.find((file: { path: string; reasons: string[] }) => file.path === 'src/math.ts')!.reasons.some((reason: string) => reason.includes('history: edited 1/1 times')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('goal_run runs a failing targeted pre-check before full verification during repair', async () => {
  const root = await fixture('goal-runner-targeted-');
  try {
    await writeFile(path.join(root, 'src', 'math.test.ts'), 'test();\n', 'utf8');
    let calls = 0;
    const runner = createRunner(root, [{ ok: false, checks: [{ name: 'test', ok: false, diagnostics: [] }] }, { ok: true }], async ({ files }) => {
      calls++;
      return { ran: true, files, ok: false, durationMs: 3, diagnostics: [{ file: 'src/math.test.ts', line: 1, message: 'targeted failure' }] };
    });
    const started = await runner.run({ goal: 'fix add in src/math.ts', path: root }) as any;
    const failed = await runner.run({ id: started.goalId, patch: fixPatch }) as any;
    assert.equal(failed.repair, true);
    const repairPatch = [
      '*** Begin Patch',
      '*** Update File: src/math.ts',
      '@@',
      '-export const add = (a: number, b: number) => a + b;',
      '+export const add = (a: number, b: number) => a + b; // repaired',
      '*** End Patch',
    ].join('\n');
    const repaired = await runner.run({ id: started.goalId, patch: repairPatch }) as any;
    assert.equal(calls, 1);
    assert.equal(repaired.verification.targetedCheck.ran, true);
    assert.equal(repaired.verification.ok, false);
    assert.equal(repaired.goal.verificationRuns.length, 1);
    const testFile = repaired.context.files.find((file: { path: string }) => file.path === 'src/math.test.ts');
    assert.ok(testFile.reasons.some((reason: string) => reason.includes('targeted failure')), 'targeted diagnostics anchor the repair context');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a passing or unavailable targeted pre-check never replaces full verification', async () => {
  for (const outcome of ['pass', 'throws'] as const) {
    const root = await fixture(`goal-runner-targeted-${outcome}-`);
    try {
      await writeFile(path.join(root, 'src', 'math.test.ts'), 'test();\n', 'utf8');
      const runner = createRunner(
        root,
        [{ ok: false, checks: [{ name: 'test', ok: false, diagnostics: [] }] }, { ok: false, checks: [{ name: 'test', ok: false, diagnostics: [] }] }],
        async ({ files }) => {
          if (outcome === 'throws') throw new Error('npx is not installed');
          return { ran: true, files, ok: true, durationMs: 1 };
        },
      );
      const started = await runner.run({ goal: 'fix add in src/math.ts', path: root }) as any;
      await runner.run({ id: started.goalId, patch: fixPatch });
      const repairPatch = [
        '*** Begin Patch',
        '*** Update File: src/math.ts',
        '@@',
        '-export const add = (a: number, b: number) => a + b;',
        '+export const add = (a: number, b: number) => a + b; // repaired',
        '*** End Patch',
      ].join('\n');
      const repaired = await runner.run({ id: started.goalId, patch: repairPatch }) as any;
      assert.equal(repaired.state, 'needs_patch', `${outcome}: full verification failure still wins`);
      assert.equal(repaired.goal.verificationRuns.length, 2, `${outcome}: full verification ran`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('targeted command selection only runs test sources it can execute as-is', () => {
  const base = { dependencies: {}, usesPytest: false, platform: 'linux' as const };
  // Mapping src/*.test.ts to stale dist/*.test.js would loop the repair forever.
  assert.equal(selectTargetedCommand({ ...base, testScript: 'node --test dist/*.test.js', files: ['src/math.test.ts'] }), undefined);
  assert.deepEqual(selectTargetedCommand({ ...base, testScript: 'node --test', files: ['test/math.test.mjs'] }), { executable: 'node', args: ['--test', 'test/math.test.mjs'] });
  assert.deepEqual(selectTargetedCommand({ ...base, testScript: 'jest', files: ['src/a.test.ts'] }), { executable: 'npx', args: ['--no-install', 'jest', '--', 'src/a.test.ts'] });
  assert.deepEqual(selectTargetedCommand({ ...base, testScript: '', dependencies: { vitest: '^2' }, files: ['src/a.test.ts'] }), { executable: 'npx', args: ['--no-install', 'vitest', 'run', 'src/a.test.ts'] });
  assert.deepEqual(selectTargetedCommand({ ...base, testScript: '', usesPytest: true, files: ['tests/test_a.py'] }), { executable: 'python', args: ['-m', 'pytest', '-q', 'tests/test_a.py'] });
  assert.equal(selectTargetedCommand({ ...base, testScript: 'make test', files: ['tests/test_a.py'] }), undefined);
  assert.equal(selectTargetedCommand({ ...base, testScript: 'jest', files: [] }), undefined);
});
