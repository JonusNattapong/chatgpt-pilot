import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LearningLoop } from './learning-tools.js';
import { TodoLedger } from './todo-tools.js';

test('learning loop promotes evidence-backed lessons to existing memory and can roll them back', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pilot-learning-memory-'));
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  try {
    const todos = new TodoLedger(root);
    const todo = await todos.add({ title: 'Implement safe learning' });
    const loop = new LearningLoop(root, todos, async (name, args) => { calls.push({ name, args }); return { external: name }; });
    const observed = await loop.observe({
      todoId: todo.id,
      task: 'Implement safe learning',
      outcome: 'success',
      summary: 'Verification passed',
      evidence: ['160/160 tests passed'],
      skillsUsed: ['codebase-design'],
      lessons: [{ lesson: 'Use evidence thresholds before persisting reusable lessons.', confidence: 0.9, reusePotential: 0.85, target: 'memory' }],
    });
    const candidate = observed.candidates[0]!;
    const promoted = await loop.promote(candidate.id);
    assert.equal(promoted.candidate.status, 'promoted');
    assert.equal(calls[0]?.name, 'memory_drawer_put');
    assert.equal(calls[0]?.args.drawer, 'lessons');

    const reopened = new LearningLoop(root, todos, async (name, args) => { calls.push({ name, args }); return { external: name }; });
    const promotedHistory = await reopened.history({ status: 'promoted', limit: 10 });
    assert.equal(promotedHistory.candidates.length, 1);
    assert.equal(promotedHistory.metrics.outcomes.success, 1);
    assert.equal(promotedHistory.metrics.statuses.promoted, 1);
    assert.equal(promotedHistory.metrics.targets.memory, 1);
    assert.equal(promotedHistory.metrics.promotionRate, 1);
    const rolled = await reopened.rollback(candidate.id);
    assert.equal(rolled.candidate.status, 'rolled_back');
    assert.equal(calls[1]?.name, 'memory_drawer_delete');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('skill, capability, and GPT learnings remain proposal-only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pilot-learning-proposal-'));
  let externalCalls = 0;
  try {
    const todos = new TodoLedger(root);
    const loop = new LearningLoop(root, todos, async () => { externalCalls++; return {}; });
    const observed = await loop.observe({
      task: 'Improve routing', outcome: 'partial', summary: 'Skill routing selected a weak match', evidence: ['codebase-design ranked below diagnosing-bugs'], skillsUsed: [],
      lessons: [
        { lesson: 'Tune routing for architecture phrases.', confidence: 0.8, reusePotential: 0.9, target: 'skill' },
        { lesson: 'Add a structured sync capability.', confidence: 0.8, reusePotential: 0.8, target: 'capability' },
        { lesson: 'Prefer Skill Hub before non-trivial coding.', confidence: 0.9, reusePotential: 0.9, target: 'gpt' },
      ],
    });
    for (const candidate of observed.candidates) {
      const promoted = await loop.promote(candidate.id);
      assert.equal(promoted.candidate.status, 'proposed');
      assert.equal(promoted.applied, false);
      assert.equal(promoted.selfModification, false);
      assert.equal(promoted.proposal.target, candidate.target);
    }
    assert.equal(externalCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('learning loop requires evidence threshold and redacts common secrets before persistence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pilot-learning-threshold-'));
  try {
    const todos = new TodoLedger(root);
    const loop = new LearningLoop(root, todos, async () => ({}));
    const fakeSecret = ['sk', 'proj', 'abcdefghijklmnop1234567890'].join('-');
    const observed = await loop.observe({
      task: 'Investigate provider', outcome: 'failure', evidence: [`token ${fakeSecret} leaked in output`], skillsUsed: [],
      lessons: [{ lesson: 'Maybe change the provider.', confidence: 0.3, reusePotential: 0.4, target: 'memory' }],
    });
    const history = await loop.history({ limit: 10 });
    const persistedEvidence = history.candidates[0]!.observation!.evidence[0]!;
    assert.notEqual(persistedEvidence, `token ${fakeSecret} leaked in output`);
    assert.equal(persistedEvidence.includes(fakeSecret), false);
    await assert.rejects(() => loop.promote(observed.candidates[0]!.id), /promotion evidence threshold/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
