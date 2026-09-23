import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { redactSecrets } from './audit.js';
import { describeError, ToolError } from './errors.js';
import { listDirectory, readMachineFile } from './file-tools.js';
import { gitStatus } from './git-tools.js';
import { AtomicJsonStore } from './persistent-state.js';
import { type MachineAccess } from './shell-tools.js';
import { verifyChanges, type VerificationProfile } from './verification.js';
import type { ToolSpec } from './tools.js';

export type GoalStatus = 'active' | 'blocked' | 'done' | 'cancelled';
export type GoalPhase = 'inspect' | 'execute' | 'verify' | 'review' | 'done';
export type GoalActionKind = 'inspect' | 'change' | 'verify' | 'review';
export type GoalActionStatus = 'pending' | 'done' | 'skipped' | 'failed';
export type GoalReportOutcome = 'success' | 'failure' | 'blocked' | 'skipped';

export interface GoalProjectSnapshot {
  path: string;
  projectTypes: string[];
  topLevel: string[];
  scripts: Record<string, string>;
  instructionFiles: string[];
  git?: Awaited<ReturnType<typeof gitStatus>>;
  gitError?: ReturnType<typeof describeError>;
  baselineDirtyPaths: string[];
}

export interface GoalAttempt {
  at: string;
  outcome: GoalReportOutcome;
  summary: string;
  evidence: string[];
}

export interface GoalAction {
  id: string;
  kind: GoalActionKind;
  status: GoalActionStatus;
  instruction: string;
  createdAt: string;
  completedAt?: string;
  attempts: GoalAttempt[];
}

export interface GoalRecord {
  id: string;
  goal: string;
  path: string;
  completion: string[];
  verificationProfile: VerificationProfile;
  status: GoalStatus;
  phase: GoalPhase;
  currentActionId?: string;
  project: GoalProjectSnapshot;
  actions: GoalAction[];
  verificationRuns: Array<{ at: string; ok: boolean; result: GoalVerificationResult }>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface GoalState {
  version: 1;
  goals: GoalRecord[];
}

export interface GoalVerificationResult {
  ok: boolean;
  [key: string]: unknown;
}

export interface GoalRuntimeOptions extends MachineAccess {
  maxTimeoutMs: number;
  inspect?: (requestedPath?: string) => Promise<GoalProjectSnapshot>;
  verify?: (input: {
    path: string;
    profile: VerificationProfile;
    timeoutMs: number;
    totalTimeoutMs?: number;
  }) => Promise<GoalVerificationResult>;
  now?: () => string;
  id?: () => string;
}

export interface GoalStartInput {
  goal: string;
  path?: string;
  completion?: string[];
  verificationProfile?: VerificationProfile;
}

function cleanString(value: string, name: string, max: number): string {
  const cleaned = redactSecrets(value).trim();
  if (!cleaned) throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a non-empty string.`);
  if (cleaned.length > max) throw new ToolError('INVALID_ARGUMENT', `"${name}" must not exceed ${max} characters.`);
  return cleaned;
}

function cleanStringArray(value: string[] | undefined, name: string, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must contain at most ${maxItems} strings.`);
  }
  const cleaned = value.map((entry) => {
    if (typeof entry !== 'string') throw new ToolError('INVALID_ARGUMENT', `"${name}" must contain only strings.`);
    return cleanString(entry, name, maxLength);
  });
  return [...new Set(cleaned)];
}

function inferProjectTypes(names: string[]): string[] {
  const set = new Set(names);
  const types = [
    set.has('package.json') ? 'node' : undefined,
    set.has('pyproject.toml') || set.has('requirements.txt') || set.has('setup.py') || set.has('Pipfile') ? 'python' : undefined,
    set.has('go.mod') ? 'go' : undefined,
    set.has('Cargo.toml') ? 'rust' : undefined,
    names.some((name) => name.endsWith('.sln') || name.endsWith('.csproj')) ? 'dotnet' : undefined,
    set.has('CMakeLists.txt') || names.some((name) => name.endsWith('.vcxproj')) ? 'cpp' : undefined,
  ].filter((value): value is string => Boolean(value));
  return types.length ? types : ['unknown'];
}

async function defaultInspect(options: MachineAccess, requestedPath?: string): Promise<GoalProjectSnapshot> {
  const directory = await listDirectory({
    ...options,
    directoryPath: requestedPath ?? '.',
    maxEntries: 300,
    includeHidden: false,
  });
  const names = directory.entries.map((entry) => entry.name);
  let scripts: Record<string, string> = {};
  if (names.includes('package.json')) {
    try {
      const pkg = await readMachineFile({
        ...options,
        filePath: path.join(directory.path, 'package.json'),
        maxBytes: 256 * 1024,
      });
      const parsed = JSON.parse(pkg.content) as { scripts?: Record<string, string> };
      scripts = parsed.scripts ?? {};
    } catch {
      scripts = {};
    }
  }

  let git: Awaited<ReturnType<typeof gitStatus>> | undefined;
  let gitError: ReturnType<typeof describeError> | undefined;
  try {
    git = await gitStatus({ ...options, path: directory.path });
  } catch (error: unknown) {
    gitError = describeError(error);
  }

  const instructionCandidates = ['AGENTS.md', 'GPT.md', 'CLAUDE.md'];
  const instructionFiles = instructionCandidates.filter((name) => names.includes(name));
  const baselineDirtyPaths = git?.files.map((file) => file.path) ?? [];

  return {
    path: directory.path,
    projectTypes: inferProjectTypes(names),
    topLevel: names.slice(0, 300),
    scripts,
    instructionFiles,
    ...(git ? { git } : {}),
    ...(gitError ? { gitError } : {}),
    baselineDirtyPaths,
  };
}

function currentAction(goal: GoalRecord): GoalAction {
  if (!goal.currentActionId) throw new ToolError('PRECONDITION_FAILED', `Goal ${goal.id} has no current action.`);
  const action = goal.actions.find((candidate) => candidate.id === goal.currentActionId);
  if (!action) throw new ToolError('INTERNAL', `Goal ${goal.id} references missing action ${goal.currentActionId}.`);
  return action;
}

function actionId(goal: GoalRecord, kind: GoalActionKind): string {
  return `${kind}-${goal.actions.length + 1}`;
}

function nextPayload(goal: GoalRecord) {
  if (goal.status === 'done') {
    return { state: 'done', message: 'Goal completed. Verification and semantic review were both reported successful.' };
  }
  if (goal.status === 'cancelled') return { state: 'cancelled' };
  const action = currentAction(goal);
  return {
    state: goal.status,
    action: {
      id: action.id,
      kind: action.kind,
      instruction: action.instruction,
      attempts: action.attempts.length,
    },
    reportWith: action.kind === 'verify' ? 'goal_verify' : 'goal_report',
  };
}

function verificationFailureSummary(result: GoalVerificationResult): string {
  const checks = Array.isArray(result.checks) ? result.checks as Array<Record<string, unknown>> : [];
  const failed = checks.filter((check) => check.ok === false).map((check) => {
    const name = typeof check.name === 'string' ? check.name : 'verification check';
    const diagnostics = Array.isArray(check.diagnostics)
      ? (check.diagnostics as Array<Record<string, unknown>>).slice(0, 3).map((item) => typeof item.message === 'string' ? item.message : '').filter(Boolean)
      : [];
    return diagnostics.length ? `${name}: ${diagnostics.join('; ')}` : name;
  });
  if (failed.length) return failed.join(' | ').slice(0, 1800);
  return typeof result.reason === 'string' ? result.reason.slice(0, 1800) : 'Verification did not pass.';
}

function compactVerificationResult(result: GoalVerificationResult): GoalVerificationResult {
  const compact: GoalVerificationResult = { ok: result.ok === true };
  for (const key of ['runId', 'totalTimeoutMs', 'verificationScope', 'profile', 'path', 'projectType', 'reason'] as const) {
    const value = result[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') compact[key] = value;
  }
  if (Array.isArray(result.checks)) {
    compact.checks = (result.checks as Array<Record<string, unknown>>).slice(0, 20).map((check) => ({
      name: typeof check.name === 'string' ? check.name : 'verification check',
      ok: check.ok === true,
      exitCode: typeof check.exitCode === 'number' || check.exitCode === null ? check.exitCode : undefined,
      durationMs: typeof check.durationMs === 'number' ? check.durationMs : undefined,
      timedOut: check.timedOut === true,
      logPath: typeof check.logPath === 'string' ? check.logPath : undefined,
      outputTruncated: check.outputTruncated === true,
      diagnostics: Array.isArray(check.diagnostics)
        ? (check.diagnostics as Array<Record<string, unknown>>).slice(0, 20).map((diagnostic) => ({
            file: typeof diagnostic.file === 'string' ? diagnostic.file : undefined,
            line: typeof diagnostic.line === 'number' ? diagnostic.line : undefined,
            column: typeof diagnostic.column === 'number' ? diagnostic.column : undefined,
            code: typeof diagnostic.code === 'string' ? diagnostic.code : undefined,
            message: typeof diagnostic.message === 'string' ? diagnostic.message.slice(0, 1000) : undefined,
          }))
        : [],
    }));
  }
  return compact;
}

export class GoalRuntime {
  readonly #store: AtomicJsonStore<GoalState>;
  readonly #options: GoalRuntimeOptions;
  readonly #inspect: (requestedPath?: string) => Promise<GoalProjectSnapshot>;
  readonly #verify: GoalRuntimeOptions['verify'];
  readonly #now: () => string;
  readonly #id: () => string;

  constructor(options: GoalRuntimeOptions) {
    this.#options = options;
    this.#store = new AtomicJsonStore(path.join(path.resolve(options.root), '.pilot', 'goals.json'), () => ({ version: 1, goals: [] }));
    this.#inspect = options.inspect ?? ((requestedPath) => defaultInspect(options, requestedPath));
    this.#verify = options.verify ?? (async (input) => verifyChanges({
      root: options.root,
      unrestricted: options.unrestricted,
      path: input.path,
      profile: input.profile,
      timeoutMs: input.timeoutMs,
      totalTimeoutMs: input.totalTimeoutMs,
    }) as Promise<GoalVerificationResult>);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#id = options.id ?? randomUUID;
  }

  async start(input: GoalStartInput) {
    const goalText = cleanString(input.goal, 'goal', 8000);
    const completion = cleanStringArray(input.completion, 'completion', 20, 500) ?? [
      'Requested behavior is implemented for the intended scope.',
      'Relevant project verification passes.',
      'Final review finds no unintended changes outside the goal.',
    ];
    const profile = input.verificationProfile ?? 'normal';
    if (!['fast', 'normal', 'strict'].includes(profile)) {
      throw new ToolError('INVALID_ARGUMENT', '"verification_profile" must be one of: fast, normal, strict.');
    }
    const project = await this.#inspect(input.path);
    const now = this.#now();
    const record: GoalRecord = {
      id: this.#id(),
      goal: goalText,
      path: project.path,
      completion,
      verificationProfile: profile,
      status: 'active',
      phase: 'inspect',
      project,
      actions: [],
      verificationRuns: [],
      createdAt: now,
      updatedAt: now,
    };
    const baselineNote = project.baselineDirtyPaths.length
      ? ` Preserve pre-existing dirty paths unless the goal requires them: ${project.baselineDirtyPaths.slice(0, 25).join(', ')}${project.baselineDirtyPaths.length > 25 ? ' …' : ''}.`
      : '';
    const inspectAction: GoalAction = {
      id: actionId(record, 'inspect'),
      kind: 'inspect',
      status: 'pending',
      instruction: `Inspect the repository for the goal: "${goalText}". Identify the relevant files/symbols, current behavior, likely root cause or implementation seam, and concrete evidence before editing.${baselineNote}`,
      createdAt: now,
      attempts: [],
    };
    record.actions.push(inspectAction);
    record.currentActionId = inspectAction.id;

    await this.#store.update((state) => {
      if (state.goals.length >= 1000) throw new ToolError('TOO_LARGE', 'Goal history reached the 1000-item safety limit.');
      state.goals.push(record);
    });
    return { goal: record, next: nextPayload(record) };
  }

  async get(idInput: string): Promise<GoalRecord> {
    const id = cleanString(idInput, 'id', 128);
    const state = await this.#store.read();
    const goal = state.goals.find((candidate) => candidate.id === id);
    if (!goal) throw new ToolError('NOT_FOUND', `Goal not found: ${id}`);
    return goal;
  }

  async status(id?: string, status?: GoalStatus, limit = 50) {
    const state = await this.#store.read();
    if (id) {
      const goal = state.goals.find((candidate) => candidate.id === id);
      if (!goal) throw new ToolError('NOT_FOUND', `Goal not found: ${id}`);
      return { goal, next: nextPayload(goal) };
    }
    const filtered = state.goals
      .filter((goal) => !status || goal.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const goals = filtered.slice(0, limit).map((goal) => ({
      id: goal.id,
      goal: goal.goal,
      path: goal.path,
      status: goal.status,
      phase: goal.phase,
      currentActionId: goal.currentActionId,
      updatedAt: goal.updatedAt,
    }));
    return { total: filtered.length, goals };
  }

  async report(input: {
    id: string;
    actionId: string;
    outcome: GoalReportOutcome;
    summary: string;
    evidence?: string[];
  }) {
    const id = cleanString(input.id, 'id', 128);
    const actionIdValue = cleanString(input.actionId, 'action_id', 128);
    const summary = cleanString(input.summary, 'summary', 8000);
    const evidence = cleanStringArray(input.evidence, 'evidence', 20, 2000) ?? [];
    if (!['success', 'failure', 'blocked', 'skipped'].includes(input.outcome)) {
      throw new ToolError('INVALID_ARGUMENT', '"outcome" must be one of: success, failure, blocked, skipped.');
    }

    return this.#store.update((state) => {
      const goal = state.goals.find((candidate) => candidate.id === id);
      if (!goal) throw new ToolError('NOT_FOUND', `Goal not found: ${id}`);
      if (goal.status === 'done' || goal.status === 'cancelled') {
        throw new ToolError('PRECONDITION_FAILED', `Goal ${id} is already ${goal.status}.`);
      }
      const action = currentAction(goal);
      if (action.id !== actionIdValue) {
        throw new ToolError('PRECONDITION_FAILED', `Stale goal action. Current action is ${action.id}, not ${actionIdValue}.`);
      }
      if (action.kind === 'verify') {
        throw new ToolError('PRECONDITION_FAILED', 'Verification actions must be completed with goal_verify so completion is backed by an actual verification run.');
      }

      const now = this.#now();
      action.attempts.push({ at: now, outcome: input.outcome, summary, evidence });
      goal.updatedAt = now;

      if (input.outcome === 'failure') {
        goal.status = 'active';
        if (action.kind === 'review') {
          action.status = 'failed';
          action.completedAt = now;
          goal.phase = 'execute';
          const repair: GoalAction = {
            id: actionId(goal, 'change'),
            kind: 'change',
            status: 'pending',
            instruction: `Final review found an issue. Repair only the reviewed problem, preserve unrelated work, then report the repair so verification runs again. Review evidence: ${summary}`,
            createdAt: now,
            attempts: [],
          };
          goal.actions.push(repair);
          goal.currentActionId = repair.id;
          return { goal, next: nextPayload(goal) };
        }
        action.status = 'pending';
        return { goal, next: nextPayload(goal) };
      }
      if (input.outcome === 'blocked') {
        goal.status = 'blocked';
        action.status = 'pending';
        return { goal, next: nextPayload(goal) };
      }

      goal.status = 'active';
      action.status = input.outcome === 'skipped' ? 'skipped' : 'done';
      action.completedAt = now;

      if (action.kind === 'inspect') {
        goal.phase = 'execute';
        const next: GoalAction = {
          id: actionId(goal, 'change'),
          kind: 'change',
          status: 'pending',
          instruction: `Implement the smallest coherent change that satisfies the goal. Preserve unrelated work and use the inspection evidence as the scope boundary. Completion criteria: ${goal.completion.join(' | ')}`,
          createdAt: now,
          attempts: [],
        };
        goal.actions.push(next);
        goal.currentActionId = next.id;
      } else if (action.kind === 'change') {
        goal.phase = 'verify';
        const next: GoalAction = {
          id: actionId(goal, 'verify'),
          kind: 'verify',
          status: 'pending',
          instruction: `Run the ${goal.verificationProfile} verification profile for ${goal.path}. Do not report this step manually; call goal_verify.`,
          createdAt: now,
          attempts: [],
        };
        goal.actions.push(next);
        goal.currentActionId = next.id;
      } else if (action.kind === 'review') {
        goal.phase = 'done';
        goal.status = 'done';
        goal.currentActionId = undefined;
        goal.completedAt = now;
      }

      return { goal, next: nextPayload(goal) };
    });
  }

  async verify(idInput: string, timeoutMs?: number, totalTimeoutMs?: number) {
    const id = cleanString(idInput, 'id', 128);
    const state = await this.#store.read();
    const before = state.goals.find((candidate) => candidate.id === id);
    if (!before) throw new ToolError('NOT_FOUND', `Goal not found: ${id}`);
    if (before.status === 'done' || before.status === 'cancelled') throw new ToolError('PRECONDITION_FAILED', `Goal ${id} is already ${before.status}.`);
    const action = currentAction(before);
    if (action.kind !== 'verify') throw new ToolError('PRECONDITION_FAILED', `Current action ${action.id} is ${action.kind}; complete it before verification.`);

    const effectiveTimeout = timeoutMs ?? this.#options.maxTimeoutMs;
    if (!Number.isInteger(effectiveTimeout) || effectiveTimeout < 1000 || effectiveTimeout > 660000) {
      throw new ToolError('INVALID_ARGUMENT', '"timeout_ms" must be an integer between 1000 and 660000.');
    }
    if (totalTimeoutMs !== undefined && (!Number.isInteger(totalTimeoutMs) || totalTimeoutMs < 1000 || totalTimeoutMs > 660000)) {
      throw new ToolError('INVALID_ARGUMENT', '"total_timeout_ms" must be an integer between 1000 and 660000.');
    }

    const result = await this.#verify!({
      path: before.path,
      profile: before.verificationProfile,
      timeoutMs: effectiveTimeout,
      totalTimeoutMs,
    });

    return this.#store.update((currentState) => {
      const goal = currentState.goals.find((candidate) => candidate.id === id);
      if (!goal) throw new ToolError('NOT_FOUND', `Goal not found: ${id}`);
      if (goal.currentActionId !== action.id) {
        throw new ToolError('PRECONDITION_FAILED', 'Goal advanced while verification was running; verification result was not attached to a stale action.');
      }
      const current = currentAction(goal);
      const now = this.#now();
      goal.verificationRuns.push({ at: now, ok: result.ok === true, result: compactVerificationResult(result) });
      goal.updatedAt = now;
      current.attempts.push({
        at: now,
        outcome: result.ok === true ? 'success' : 'failure',
        summary: result.ok === true ? 'Project verification passed.' : verificationFailureSummary(result),
        evidence: [],
      });

      if (result.ok === true) {
        current.status = 'done';
        current.completedAt = now;
        goal.phase = 'review';
        goal.status = 'active';
        const review: GoalAction = {
          id: actionId(goal, 'review'),
          kind: 'review',
          status: 'pending',
          instruction: `Review the final diff and runtime behavior against the goal and every completion criterion. Confirm that unrelated pre-existing changes were preserved. Baseline dirty paths: ${goal.project.baselineDirtyPaths.length ? goal.project.baselineDirtyPaths.join(', ') : '(none)'}.`,
          createdAt: now,
          attempts: [],
        };
        goal.actions.push(review);
        goal.currentActionId = review.id;
      } else {
        current.status = 'failed';
        goal.phase = 'execute';
        goal.status = 'active';
        const failure = verificationFailureSummary(result);
        const repair: GoalAction = {
          id: actionId(goal, 'change'),
          kind: 'change',
          status: 'pending',
          instruction: `Verification failed. Diagnose and repair the failure without broadening scope unnecessarily, then report this repair action as successful so the runtime schedules another verification pass. Failure evidence: ${failure}`,
          createdAt: now,
          attempts: [],
        };
        goal.actions.push(repair);
        goal.currentActionId = repair.id;
      }

      return { verification: result, goal, next: nextPayload(goal) };
    });
  }

  async recordTargetedFailure(idInput: string, result: GoalVerificationResult) {
    const id = cleanString(idInput, 'id', 128);
    return this.#store.update((state) => {
      const goal = state.goals.find((candidate) => candidate.id === id);
      if (!goal) throw new ToolError('NOT_FOUND', `Goal not found: ${id}`);
      const action = currentAction(goal);
      if (action.kind !== 'verify') throw new ToolError('PRECONDITION_FAILED', `Current action ${action.id} is ${action.kind}; targeted verification is stale.`);
      const now = this.#now();
      action.attempts.push({ at: now, outcome: 'failure', summary: verificationFailureSummary(result), evidence: [] });
      action.status = 'failed';
      action.completedAt = now;
      goal.phase = 'execute';
      goal.status = 'active';
      goal.updatedAt = now;
      const repair: GoalAction = {
        id: actionId(goal, 'change'),
        kind: 'change',
        status: 'pending',
        instruction: `Targeted tests failed. Repair the reported failure, then report this repair so full verification runs. Failure evidence: ${verificationFailureSummary(result)}`,
        createdAt: now,
        attempts: [],
      };
      goal.actions.push(repair);
      goal.currentActionId = repair.id;
      return { verification: result, goal, next: nextPayload(goal) };
    });
  }
}

function requiredString(args: Record<string, unknown>, name: string, max: number): string {
  const value = args[name];
  if (typeof value !== 'string') throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a string.`);
  return cleanString(value, name, max);
}

function optionalStringArg(args: Record<string, unknown>, name: string, max: number): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a string.`);
  return cleanString(value, name, max);
}

function optionalStringArrayArg(args: Record<string, unknown>, name: string, maxItems: number, maxLength: number): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ToolError('INVALID_ARGUMENT', `"${name}" must be an array.`);
  return cleanStringArray(value as string[], name, maxItems, maxLength);
}

function optionalInt(args: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must be an integer between ${min} and ${max}.`);
  }
  return value as number;
}

function enumArg<T extends string>(value: unknown, name: string, allowed: readonly T[], fallback?: T): T | undefined {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

export function createGoalToolSpecs(options: GoalRuntimeOptions, runtime = new GoalRuntime(options)): ToolSpec[] {
  return [
    {
      name: 'goal_start',
      description: 'Start a durable coding goal. Captures a bounded repository snapshot and baseline dirty paths, then returns the first structured action in the inspect→change→verify→review loop.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', minLength: 1, maxLength: 8000 },
          path: { type: 'string', description: 'Project directory; defaults to the workspace root.' },
          completion: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 500 } },
          verification_profile: { type: 'string', enum: ['fast', 'normal', 'strict'], default: 'normal' },
        },
        required: ['goal'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: async (args) => runtime.start({
        goal: requiredString(args, 'goal', 8000),
        path: optionalStringArg(args, 'path', 4000),
        completion: optionalStringArrayArg(args, 'completion', 20, 500),
        verificationProfile: enumArg(args.verification_profile, 'verification_profile', ['fast', 'normal', 'strict'] as const, 'normal'),
      }),
    },
    {
      name: 'goal_status',
      description: 'Read one durable goal with its next action, or list recent goals when id is omitted. Use this to resume work after a new turn or worker restart.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: 128 },
          status: { type: 'string', enum: ['active', 'blocked', 'done', 'cancelled'] },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => runtime.status(
        optionalStringArg(args, 'id', 128),
        enumArg(args.status, 'status', ['active', 'blocked', 'done', 'cancelled'] as const),
        optionalInt(args, 'limit', 1, 200) ?? 50,
      ),
    },
    {
      name: 'goal_report',
      description: 'Report the outcome of the current non-verification goal action. Successful inspect/change/review reports advance the state machine; failures stay retryable; blocked reports persist the blockage.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128 },
          action_id: { type: 'string', minLength: 1, maxLength: 128 },
          outcome: { type: 'string', enum: ['success', 'failure', 'blocked', 'skipped'] },
          summary: { type: 'string', minLength: 1, maxLength: 8000 },
          evidence: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
        required: ['id', 'action_id', 'outcome', 'summary'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: async (args) => runtime.report({
        id: requiredString(args, 'id', 128),
        actionId: requiredString(args, 'action_id', 128),
        outcome: enumArg(args.outcome, 'outcome', ['success', 'failure', 'blocked', 'skipped'] as const)!,
        summary: requiredString(args, 'summary', 8000),
        evidence: optionalStringArrayArg(args, 'evidence', 20, 2000),
      }),
    },
    {
      name: 'goal_verify',
      description: 'Run the goal verification profile for the current verify action and attach the real result. Passing verification advances to semantic review; failure automatically schedules a repair action followed by another verification cycle.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128 },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: 660000 },
          total_timeout_ms: { type: 'integer', minimum: 1000, maximum: 660000 },
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args) => runtime.verify(
        requiredString(args, 'id', 128),
        optionalInt(args, 'timeout_ms', 1000, 660000),
        optionalInt(args, 'total_timeout_ms', 1000, 660000),
      ),
    },
  ];
}
