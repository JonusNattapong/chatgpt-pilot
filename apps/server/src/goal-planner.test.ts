import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FlowStore } from '@chatgpt-pilot/flow';
import { GoalPlanner, type GoalPatchCycleInput } from './goal-planner.js';

function input(): GoalPatchCycleInput {
  return {
    goalId: 'goal-1',
    actionId: 'change-2',
    patch: '*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch',
    summary: 'add a file',
    timeoutMs: 10_000,
  };
}

function flowDb(root: string): string {
  return path.join(root, '.pilot', 'goal-flow', 'runs.db');
}

test('goal planner executes patch -> verify as one durable flow and reuses the completed run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'goal-planner-complete-'));
  try {
    let applyCalls = 0;
    let verifyCalls = 0;
    const planner = new GoalPlanner({ root }, {
      applyPatch: async () => { applyCalls++; return { changed: ['a.txt'] }; },
      verify: async () => { verifyCalls++; return { verification: { ok: true } }; },
    });

    const first = await planner.executePatchCycle(input());
    assert.equal(first.flow.state, 'completed');
    assert.deepEqual(first.flow.steps.map((step) => [step.stage, step.status]), [
      ['apply_patch', 'succeeded'],
      ['verify', 'succeeded'],
    ]);
    assert.equal(first.recoveryRequired, false);
    assert.equal(applyCalls, 1);
    assert.equal(verifyCalls, 1);

    const replay = await planner.executePatchCycle(input());
    assert.equal(replay.flow.runId, first.flow.runId);
    assert.equal(replay.flow.state, 'completed');
    assert.equal(applyCalls, 1);
    assert.equal(verifyCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('goal planner never replays an interrupted patch mutation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'goal-planner-uncertain-apply-'));
  try {
    let applyCalls = 0;
    const planner = new GoalPlanner({ root }, {
      applyPatch: async () => { applyCalls++; return {}; },
      verify: async () => ({}),
    });
    const cycle = input();
    const plan = planner.planPatchCycle(cycle);
    const store = new FlowStore(flowDb(root));
    store.createRun({
      id: plan.id,
      goal: 'test interrupted apply',
      steps: [
        { id: 'apply', capability: 'goal.internal.apply_patch', input: cycle, maxAttempts: 1 },
        { id: 'verify', capability: 'goal.internal.verify', input: { goalId: cycle.goalId }, dependsOn: ['apply'], maxAttempts: 2 },
      ],
    }, [
      { id: 'apply', capability: 'goal.internal.apply_patch', input: cycle, dependsOn: [], maxAttempts: 1 },
      { id: 'verify', capability: 'goal.internal.verify', input: { goalId: cycle.goalId }, dependsOn: ['apply'], maxAttempts: 2 },
    ], 1);
    store.setRunState(plan.id, 'running', 'test.running');
    store.beginStep(plan.id, 'apply');
    store.close();

    const recovered = await planner.executePatchCycle(cycle);
    assert.equal(recovered.recoveryRequired, true);
    assert.match(recovered.recoveryReason ?? '', /not replayed|uncertain/i);
    assert.equal(recovered.flow.steps.find((step) => step.id === 'apply')?.status, 'uncertain');
    assert.equal(applyCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('goal planner safely retries an interrupted verification without replaying patch apply', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'goal-planner-retry-verify-'));
  try {
    let applyCalls = 0;
    let verifyCalls = 0;
    const planner = new GoalPlanner({ root }, {
      applyPatch: async () => { applyCalls++; return {}; },
      verify: async () => { verifyCalls++; return { verification: { ok: true } }; },
    });
    const cycle = input();
    const plan = planner.planPatchCycle(cycle);
    const store = new FlowStore(flowDb(root));
    store.createRun({
      id: plan.id,
      goal: 'test interrupted verify',
      steps: [
        { id: 'apply', capability: 'goal.internal.apply_patch', input: cycle, maxAttempts: 1 },
        { id: 'verify', capability: 'goal.internal.verify', input: { goalId: cycle.goalId }, dependsOn: ['apply'], maxAttempts: 2 },
      ],
    }, [
      { id: 'apply', capability: 'goal.internal.apply_patch', input: cycle, dependsOn: [], maxAttempts: 1 },
      { id: 'verify', capability: 'goal.internal.verify', input: { goalId: cycle.goalId }, dependsOn: ['apply'], maxAttempts: 2 },
    ], 1);
    store.setRunState(plan.id, 'running', 'test.running');
    store.beginStep(plan.id, 'apply');
    store.completeStep(plan.id, 'apply', { changed: ['a.txt'] });
    store.beginStep(plan.id, 'verify');
    store.close();

    const recovered = await planner.executePatchCycle(cycle);
    assert.equal(recovered.recoveryRequired, false);
    assert.equal(recovered.flow.state, 'completed');
    assert.equal(recovered.flow.steps.find((step) => step.id === 'verify')?.status, 'succeeded');
    assert.equal(applyCalls, 0);
    assert.equal(verifyCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
