import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './audit.js';
import { ToolError } from './errors.js';
import { AtomicJsonStore } from './persistent-state.js';
import type { ToolSpec } from './tools.js';
import type { TodoLedger } from './todo-tools.js';

export type LearningTarget = 'memory' | 'skill' | 'capability' | 'gpt';
export type LearningCandidateStatus = 'candidate' | 'proposed' | 'promoted' | 'rolled_back';
export type LearningOutcome = 'success' | 'partial' | 'failure';

interface LearningObservation {
  id: string;
  todoId?: string;
  task: string;
  outcome: LearningOutcome;
  summary?: string;
  evidence: string[];
  skillsUsed: string[];
  createdAt: string;
}

interface LearningCandidate {
  id: string;
  observationId: string;
  lesson: string;
  confidence: number;
  reusePotential: number;
  target: LearningTarget;
  status: LearningCandidateStatus;
  createdAt: string;
  updatedAt: string;
  memoryItem?: string;
}

interface LearningState { version: 1; observations: LearningObservation[]; candidates: LearningCandidate[] }
type ExternalInvoker = (name: 'memory_drawer_put' | 'memory_drawer_delete', args: Record<string, unknown>) => Promise<unknown>;

function boundedString(value: unknown, name: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new ToolError('INVALID_ARGUMENT', `"${name}" is required.`);
    return undefined;
  }
  if (typeof value !== 'string' || (required && !value.trim())) throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a${required ? ' non-empty' : ''} string.`);
  if (value.length > max) throw new ToolError('INVALID_ARGUMENT', `"${name}" must not exceed ${max} characters.`);
  return redactSecrets(value.trim());
}

function boundedStrings(value: unknown, name: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems || value.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > maxLength)) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must contain at most ${maxItems} non-empty strings up to ${maxLength} characters each.`);
  }
  return value.map((entry) => redactSecrets((entry as string).trim()));
}

function unitNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a number between 0 and 1.`);
  return value;
}

function parseLessons(value: unknown): Array<{ lesson: string; confidence: number; reusePotential: number; target: LearningTarget }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) throw new ToolError('INVALID_ARGUMENT', '"lessons" must be an array with at most 20 items.');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ToolError('INVALID_ARGUMENT', `lessons[${index}] must be an object.`);
    const item = entry as Record<string, unknown>;
    const lesson = boundedString(item.lesson, `lessons[${index}].lesson`, 4000, true)!;
    const target = item.target;
    if (typeof target !== 'string' || !['memory', 'skill', 'capability', 'gpt'].includes(target)) throw new ToolError('INVALID_ARGUMENT', `lessons[${index}].target must be memory, skill, capability, or gpt.`);
    return { lesson, confidence: unitNumber(item.confidence, `lessons[${index}].confidence`), reusePotential: unitNumber(item.reuse_potential, `lessons[${index}].reuse_potential`), target: target as LearningTarget };
  });
}

export class LearningLoop {
  readonly store: AtomicJsonStore<LearningState>;
  readonly #todos: TodoLedger;
  readonly #invokeExternal: ExternalInvoker;

  constructor(root: string, todos: TodoLedger, invokeExternal: ExternalInvoker) {
    this.store = new AtomicJsonStore(path.join(path.resolve(root), '.pilot', 'learning.json'), () => ({ version: 1, observations: [], candidates: [] }));
    this.#todos = todos;
    this.#invokeExternal = invokeExternal;
  }

  async observe(input: { todoId?: string; task: string; outcome: LearningOutcome; summary?: string; evidence: string[]; skillsUsed: string[]; lessons: Array<{ lesson: string; confidence: number; reusePotential: number; target: LearningTarget }> }) {
    if (input.todoId && !(await this.#todos.get(input.todoId))) throw new ToolError('NOT_FOUND', `Linked todo not found: ${input.todoId}`);
    return this.store.update((state) => {
      if (state.observations.length >= 5000) throw new ToolError('TOO_LARGE', 'Learning history reached the 5000-observation safety limit.');
      const now = new Date().toISOString();
      const observation: LearningObservation = {
        id: randomUUID(), todoId: input.todoId, task: redactSecrets(input.task.trim()), outcome: input.outcome,
        summary: input.summary === undefined ? undefined : redactSecrets(input.summary.trim()),
        evidence: input.evidence.map((item) => redactSecrets(item.trim())),
        skillsUsed: input.skillsUsed.map((item) => redactSecrets(item.trim())),
        createdAt: now,
      };
      state.observations.push(observation);
      const candidates = input.lessons.map((lesson) => ({
        id: randomUUID(), observationId: observation.id, ...lesson, lesson: redactSecrets(lesson.lesson.trim()),
        status: 'candidate' as const, createdAt: now, updatedAt: now,
      }));
      state.candidates.push(...candidates);
      return { observation, candidates };
    });
  }

  async history(input: { status?: LearningCandidateStatus; target?: LearningTarget; limit: number }) {
    const state = await this.store.read();
    const candidates = state.candidates.filter((candidate) => (!input.status || candidate.status === input.status) && (!input.target || candidate.target === input.target)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, input.limit);
    const byObservation = new Map(state.observations.map((observation) => [observation.id, observation]));
    const countBy = <K extends string>(values: K[]): Record<K, number> => values.reduce((counts, value) => {
      counts[value] = (counts[value] ?? 0) + 1;
      return counts;
    }, {} as Record<K, number>);
    const promotedCount = state.candidates.filter((candidate) => candidate.status === 'promoted').length;
    return {
      observationCount: state.observations.length,
      candidateCount: state.candidates.length,
      metrics: {
        outcomes: countBy(state.observations.map((observation) => observation.outcome)),
        statuses: countBy(state.candidates.map((candidate) => candidate.status)),
        targets: countBy(state.candidates.map((candidate) => candidate.target)),
        promotionRate: state.candidates.length === 0 ? 0 : promotedCount / state.candidates.length,
      },
      candidates: candidates.map((candidate) => ({ ...candidate, observation: byObservation.get(candidate.observationId) })),
    };
  }

  async promote(candidateId: string) {
    const state = await this.store.read();
    const candidate = state.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new ToolError('NOT_FOUND', `Learning candidate not found: ${candidateId}`);
    if (candidate.status !== 'candidate') throw new ToolError('INVALID_ARGUMENT', `Candidate is already ${candidate.status}.`);
    if (candidate.confidence < 0.6 || candidate.reusePotential < 0.5) throw new ToolError('INVALID_ARGUMENT', 'Candidate does not meet the promotion evidence threshold.', 'Collect more evidence before promoting: confidence >= 0.6 and reuse_potential >= 0.5.');

    if (candidate.target === 'memory') {
      const observation = state.observations.find((item) => item.id === candidate.observationId)!;
      const memoryItem = `pilot-learning-${candidate.id}`;
      const content = [
        `# ${candidate.lesson.slice(0, 120)}`,
        '',
        `*Tags: pilot-learning, evidence-based, ${observation.outcome}*`,
        '',
        candidate.lesson,
        '',
        `- Confidence: ${candidate.confidence}`,
        `- Reuse potential: ${candidate.reusePotential}`,
        `- Source observation: ${observation.id}`,
        ...(observation.todoId ? [`- Todo: ${observation.todoId}`] : []),
        ...(observation.evidence.length ? ['', '## Evidence', ...observation.evidence.map((item) => `- ${item}`)] : []),
      ].join('\n');
      const external = await this.#invokeExternal('memory_drawer_put', { drawer: 'lessons', item: memoryItem, title: candidate.lesson.slice(0, 120), content, tags: ['pilot-learning', 'evidence-based', observation.outcome] });
      return this.store.update((fresh) => {
        const current = fresh.candidates.find((item) => item.id === candidateId);
        if (!current || current.status !== 'candidate') throw new ToolError('PRECONDITION_FAILED', 'Learning candidate changed while memory promotion was running.');
        current.status = 'promoted'; current.memoryItem = memoryItem; current.updatedAt = new Date().toISOString();
        return { candidate: current, external, applied: 'memory', selfModification: false };
      });
    }

    return this.store.update((fresh) => {
      const current = fresh.candidates.find((item) => item.id === candidateId);
      if (!current || current.status !== 'candidate') throw new ToolError('PRECONDITION_FAILED', 'Learning candidate changed before proposal creation.');
      current.status = 'proposed'; current.updatedAt = new Date().toISOString();
      return { candidate: current, applied: false, selfModification: false, proposal: { target: current.target, lesson: current.lesson, reason: 'Persistent Skill/Capability/GPT changes are proposal-only by default. Review, implement, verify, and approve through the normal Pilot workflow.' } };
    });
  }

  async rollback(candidateId: string) {
    const state = await this.store.read();
    const candidate = state.candidates.find((item) => item.id === candidateId);
    if (!candidate) throw new ToolError('NOT_FOUND', `Learning candidate not found: ${candidateId}`);
    if (candidate.status === 'proposed') {
      return this.store.update((fresh) => {
        const current = fresh.candidates.find((item) => item.id === candidateId)!;
        current.status = 'rolled_back'; current.updatedAt = new Date().toISOString();
        return { candidate: current, external: undefined };
      });
    }
    if (candidate.status !== 'promoted' || !candidate.memoryItem) throw new ToolError('INVALID_ARGUMENT', 'Only proposed candidates or promoted memory lessons can be rolled back.');
    const external = await this.#invokeExternal('memory_drawer_delete', { drawer: 'lessons', item: candidate.memoryItem });
    return this.store.update((fresh) => {
      const current = fresh.candidates.find((item) => item.id === candidateId);
      if (!current || current.status !== 'promoted') throw new ToolError('PRECONDITION_FAILED', 'Learning candidate changed while rollback was running.');
      current.status = 'rolled_back'; current.updatedAt = new Date().toISOString();
      return { candidate: current, external };
    });
  }
}

export function createLearningToolSpecs(root: string, todos: TodoLedger, invokeExternal: ExternalInvoker): ToolSpec[] {
  const loop = new LearningLoop(root, todos, invokeExternal);
  return [
    {
      name: 'learning_observe',
      description: 'Record an evidence-backed task outcome and reusable learning candidates. This never changes Skills, Capabilities, GPT.md, or memory by itself.',
      inputSchema: { type: 'object', properties: { todo_id: { type: 'string' }, task: { type: 'string', maxLength: 8000 }, outcome: { type: 'string', enum: ['success', 'partial', 'failure'] }, summary: { type: 'string', maxLength: 8000 }, evidence: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 4000 } }, skills_used: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 120 } }, lessons: { type: 'array', maxItems: 20, items: { type: 'object', properties: { lesson: { type: 'string', maxLength: 4000 }, confidence: { type: 'number', minimum: 0, maximum: 1 }, reuse_potential: { type: 'number', minimum: 0, maximum: 1 }, target: { type: 'string', enum: ['memory', 'skill', 'capability', 'gpt'] } }, required: ['lesson', 'confidence', 'reuse_potential', 'target'] } } }, required: ['task', 'outcome'] },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: async (args) => {
        const outcome = args.outcome;
        if (typeof outcome !== 'string' || !['success', 'partial', 'failure'].includes(outcome)) throw new ToolError('INVALID_ARGUMENT', '"outcome" must be success, partial, or failure.');
        return loop.observe({ todoId: boundedString(args.todo_id, 'todo_id', 128), task: boundedString(args.task, 'task', 8000, true)!, outcome: outcome as LearningOutcome, summary: boundedString(args.summary, 'summary', 8000), evidence: boundedStrings(args.evidence, 'evidence', 20, 4000), skillsUsed: boundedStrings(args.skills_used, 'skills_used', 20, 120), lessons: parseLessons(args.lessons) });
      },
    },
    {
      name: 'learning_history',
      description: 'Inspect bounded learning observations and candidates, including their evidence, target, confidence, and promotion status.',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['candidate', 'proposed', 'promoted', 'rolled_back'] }, target: { type: 'string', enum: ['memory', 'skill', 'capability', 'gpt'] }, limit: { type: 'integer', minimum: 1, maximum: 200 } } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => {
        const limit = args.limit ?? 50;
        if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw new ToolError('INVALID_ARGUMENT', '"limit" must be an integer between 1 and 200.');
        const status = args.status;
        if (status !== undefined && (typeof status !== 'string' || !['candidate', 'proposed', 'promoted', 'rolled_back'].includes(status))) throw new ToolError('INVALID_ARGUMENT', 'Invalid learning candidate status.');
        const target = args.target;
        if (target !== undefined && (typeof target !== 'string' || !['memory', 'skill', 'capability', 'gpt'].includes(target))) throw new ToolError('INVALID_ARGUMENT', 'Invalid learning target.');
        return loop.history({ status: status as LearningCandidateStatus | undefined, target: target as LearningTarget | undefined, limit: limit as number });
      },
    },
    {
      name: 'learning_promote',
      description: 'Promote one evidence-backed learning candidate. Memory lessons are written to the existing lessons drawer; Skill/Capability/GPT targets become proposals only and never silently self-modify Pilot.',
      inputSchema: { type: 'object', properties: { candidate_id: { type: 'string' } }, required: ['candidate_id'] },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: async (args) => loop.promote(boundedString(args.candidate_id, 'candidate_id', 128, true)!),
    },
    {
      name: 'learning_rollback',
      description: 'Roll back a learning proposal or remove a previously promoted memory lesson. Code, Skills, Capabilities, and GPT.md are never modified by this tool.',
      inputSchema: { type: 'object', properties: { candidate_id: { type: 'string' } }, required: ['candidate_id'] },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args) => loop.rollback(boundedString(args.candidate_id, 'candidate_id', 128, true)!),
    },
  ];
}
