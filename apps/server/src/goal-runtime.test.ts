import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createGoalToolSpecs,
  GoalRuntime,
  type GoalProjectSnapshot,
  type GoalVerificationResult,
} from './goal-runtime.js';

function snapshot(root: string): GoalProjectSnapshot {
  return {
    path: root,
    projectTypes: ['node'],
    topLevel: ['package.json', 'src', 'AGENTS.md'],
    scripts: { test: 'node --test' },
    instructionFiles: ['AGENTS.md'],
    baselineDirtyPaths: ['src/preexisting.ts'],
  };
}

function runtimeFor(
  root: string,
  results: GoalVerificationResult[] = [{ ok: true, checks: [{ name: 'test', ok: true }] }],
) {
  let idCounter = 0;
  let nowCounter = 0;
  let verifyCounter = 0;
  return new GoalRuntime({
    root,
    unrestricted: false,
    maxTimeoutMs: 60_000,
    inspect: async () => snapshot(root),
    verify: async () => results[Math.min(verifyCounter++, results.length - 1)]!,
    id: () => `goal-${++idCounter}`,
    now: () => new Date(Date.UTC(2026, 8, 21, 9, 0, nowCounter++)).toISOString(),
  });
}

test('goal runtime persists a started goal with repository baseline and next action', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'goal-runtime-start-'));
  try {
    const runtime = runtimeFor(root);
    const started = await runtime.start({
      goal: 'Fix the broken request path',
      completion: ['Request succeeds', 'Tests pass'],
      verificationProfile: 'normal',
    });

    assert.equal(started.goal.status, 'active');
    assert.equal(started.goal.phase, 'inspect');
    assert.deepEqual(started.goal.project.baselineDirtyPaths, ['src/preexisting.ts']);
    assert.equal(started.goal.actions.length, 1);
    assert.equal(started.next.action!.kind, 'inspect');

    const reopened = runtimeFor(root);
    const resumed = await reopened.status(started.goal.id);
    assert.equal(resumed.goal!.id, started.goal.id);
    assert.equal(resumed.goal!.currentActionId, started.goal.currentActionId);
    assert.equal(resumed.next!.action!.kind, 'inspect');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('goal runtime advances inspect -> change -> verify -> review -> done', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'goal-runtime-success-'));
  try {
    const runtime = runtimeFor(root, [{ ok: true, checks: [{ name: 'npm test', ok: true }] }]);
    const started = await runtime.start({ goal: 'Implement feature A' });

    const afterInspect = await runtime.report({
      id: started.goal.id,
      actionId: started.goal.currentActionId!,
      outcome: 'success',
      summary: 'Found the implementation seam.',
      evidence: ['src/a.ts:10'],
    });
    assert.equal(afterInspect.goal.phase, 'execute');
    assert.equal(afterInspect.next.action!.kind, 'change');

    const afterChange = await runtime.report({
      id: started.goal.id,
      actionId: afterInspect.goal.currentActionId!,
      outcome: 'success',
      summary: 'Implemented the scoped change.',
      evidence: ['src/a.ts'],
    });
    assert.equal(afterChange.goal.phase, 'verify');
    assert.equal(afterChange.next.reportWith, 'goal_verify');

    const verified = await runtime.verify(started.goal.id);
    assert.equal(verified.verification.ok, true);
    assert.equal(verified.goal.phase, 'review');
    assert.equal(verified.next.action!.kind, 'review');

    const done = await runtime.report({
      id: started.goal.id,
      actionId: verified.goal.currentActionId!,
      outcome: 'success',
      summary: 'Diff matches the requested behavior and preserves unrelated work.',
      evidence: ['tests pass', 'diff reviewed'],
    });
    assert.equal(done.goal.status, 'done');
    assert.equal(done.goal.phase, 'done');
    assert.equal(done.goal.currentActionId, undefined);
    assert.equal(done.next.state, 'done');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed verification schedules a repair action and a new verify cycle', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'goal-runtime-repair-'));
  try {
    const runtime = runtimeFor(root, [
      {
        ok: false,
        checks: [{
          name: 'npm test',
          ok: false,
          stdout: 'large stdout should not be persisted',
          stderr: 'large stderr should not be persisted',
          diagnostics: [{ message: 'expected 200, got 500' }],
        }],
      },
      { ok: true, checks: [{ name: 'npm test', ok: true }] },
    ]);
    const started = await runtime.start({ goal: 'Fix API regression' });
    const inspected = await runtime.report({
      id: started.goal.id,
      actionId: started.goal.currentActionId!,
      outcome: 'success',
      summary: 'Root cause found.',
    });
    const changed = await runtime.report({
      id: started.goal.id,
      actionId: inspected.goal.currentActionId!,
      outcome: 'success',
      summary: 'Applied fix.',
    });

    const failed = await runtime.verify(started.goal.id);
    assert.equal(failed.verification.ok, false);
    assert.equal(failed.goal.phase, 'execute');
    assert.equal(failed.next.action!.kind, 'change');
    assert.match(failed.next.action!.instruction, /expected 200, got 500/);
    assert.doesNotMatch(JSON.stringify(failed.goal.verificationRuns), /large stdout should not be persisted|large stderr should not be persisted/);

    const repaired = await runtime.report({
      id: started.goal.id,
      actionId: failed.goal.currentActionId!,
      outcome: 'success',
      summary: 'Repaired the test failure.',
    });
    assert.equal(repaired.goal.phase, 'verify');
    assert.equal(repaired.next.action!.kind, 'verify');

    const passed = await runtime.verify(started.goal.id);
    assert.equal(passed.verification.ok, true);
    assert.equal(passed.goal.phase, 'review');
    assert.equal(passed.goal.verificationRuns.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('goal_report rejects stale action ids and manual verify success', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'goal-runtime-stale-'));
  try {
    const runtime = runtimeFor(root);
    const started = await runtime.start({ goal: 'Change one thing' });

    await assert.rejects(
      runtime.report({
        id: started.goal.id,
        actionId: 'inspect-stale',
        outcome: 'success',
        summary: 'stale',
      }),
      /Stale goal action/,
    );

    const inspected = await runtime.report({
      id: started.goal.id,
      actionId: started.goal.currentActionId!,
      outcome: 'success',
      summary: 'Inspection complete.',
    });
    const changed = await runtime.report({
      id: started.goal.id,
      actionId: inspected.goal.currentActionId!,
      outcome: 'success',
      summary: 'Change complete.',
    });

    await assert.rejects(
      runtime.report({
        id: started.goal.id,
        actionId: changed.goal.currentActionId!,
        outcome: 'success',
        summary: 'Pretend verification passed.',
      }),
      /goal_verify/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('goal tool surface stays compact at four task-level tools', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'goal-runtime-specs-'));
  try {
    const runtime = runtimeFor(root);
    const specs = createGoalToolSpecs({
      root,
      unrestricted: false,
      maxTimeoutMs: 60_000,
      inspect: async () => snapshot(root),
      verify: async () => ({ ok: true }),
    }, runtime);
    assert.deepEqual(specs.map((spec) => spec.name), [
      'goal_start',
      'goal_status',
      'goal_report',
      'goal_verify',
    ]);
    assert.equal(specs[0]!.annotations.destructiveHint, false);
    assert.equal(specs[3]!.annotations.destructiveHint, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
