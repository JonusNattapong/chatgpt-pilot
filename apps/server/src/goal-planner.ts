import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  FlowEngine,
  FlowStore,
  type CapabilityExecutor,
  type RunSnapshot,
} from '@chatgpt-pilot/flow';
import { describeError, ToolError } from './errors.js';

const APPLY_CAPABILITY = 'goal.internal.apply_patch';
const VERIFY_CAPABILITY = 'goal.internal.verify';
const PLAN_VERSION = 1;

export interface GoalPlannerOptions {
  root: string;
  dbPath?: string;
}

export interface GoalPatchStageInput {
  goalId: string;
  actionId: string;
  patch: string;
  summary?: string;
}

export interface GoalVerifyStageInput {
  goalId: string;
  timeoutMs?: number;
  totalTimeoutMs?: number;
}

export interface GoalPlannerHandlers {
  applyPatch(input: GoalPatchStageInput): Promise<unknown>;
  verify(input: GoalVerifyStageInput): Promise<unknown>;
}

export interface GoalPatchCycleInput extends GoalPatchStageInput, GoalVerifyStageInput {}

export interface GoalPlanStep {
  id: string;
  stage: 'apply_patch' | 'verify';
  dependsOn: string[];
  replay: 'never_if_uncertain' | 'safe';
}

export interface GoalPlan {
  version: typeof PLAN_VERSION;
  id: string;
  kind: 'patch_verify';
  goalId: string;
  actionId: string;
  patchHash: string;
  steps: GoalPlanStep[];
}

export interface GoalFlowSummary {
  runId: string;
  state: RunSnapshot['run']['state'];
  steps: Array<{
    id: string;
    stage: 'apply_patch' | 'verify' | 'unknown';
    status: RunSnapshot['steps'][number]['status'];
    attempts: number;
    error: string | null;
  }>;
}

export interface GoalPlanExecution {
  plan: GoalPlan;
  flow: GoalFlowSummary;
  recoveryRequired: boolean;
  recoveryReason?: string;
  stageError?: ReturnType<typeof describeError>;
}

interface EncodedStageError {
  goalPlannerStageError: true;
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
}

function stableHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function runIdFor(goalId: string, actionId: string, patchHash: string): string {
  return `goal-${stableHash(`${PLAN_VERSION}:${goalId}:${actionId}:${patchHash}`).slice(0, 40)}`;
}

function encodeStageError(error: unknown): Error {
  const described = describeError(error);
  const encoded: EncodedStageError = {
    goalPlannerStageError: true,
    code: described.code,
    message: described.message,
    ...(described.hint ? { hint: described.hint } : {}),
    ...(described.details !== undefined ? { details: described.details } : {}),
  };
  return new Error(JSON.stringify(encoded));
}

function decodeStageError(value: string | null): ReturnType<typeof describeError> | undefined {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(value) as Partial<EncodedStageError>;
    if (decoded.goalPlannerStageError !== true || typeof decoded.code !== 'string' || typeof decoded.message !== 'string') return undefined;
    return {
      code: decoded.code as ReturnType<typeof describeError>['code'],
      message: decoded.message,
      ...(typeof decoded.hint === 'string' ? { hint: decoded.hint } : {}),
      ...(decoded.details && typeof decoded.details === 'object' && !Array.isArray(decoded.details)
        ? { details: decoded.details as Record<string, unknown> }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function objectInput(input: unknown, stage: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ToolError('INTERNAL', `Goal planner stage ${stage} received invalid persisted input.`);
  }
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== 'string' || value.length === 0) throw new ToolError('INTERNAL', `Goal planner persisted input is missing ${name}.`);
  return value;
}

function optionalNumber(input: Record<string, unknown>, name: string): number | undefined {
  const value = input[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stageName(capability: string): GoalFlowSummary['steps'][number]['stage'] {
  if (capability === APPLY_CAPABILITY) return 'apply_patch';
  if (capability === VERIFY_CAPABILITY) return 'verify';
  return 'unknown';
}

function summarize(snapshot: RunSnapshot): GoalFlowSummary {
  return {
    runId: snapshot.run.id,
    state: snapshot.run.state,
    steps: snapshot.steps.map((step) => ({
      id: step.id,
      stage: stageName(step.capability),
      status: step.status,
      attempts: step.attempts,
      error: decodeStageError(step.error)?.message ?? step.error,
    })),
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && /Flow run not found/.test(error.message);
}

export class GoalPlanner {
  readonly #dbPath: string;
  readonly #handlers: GoalPlannerHandlers;

  constructor(options: GoalPlannerOptions, handlers: GoalPlannerHandlers) {
    this.#dbPath = options.dbPath ?? path.join(path.resolve(options.root), '.pilot', 'goal-flow', 'runs.db');
    this.#handlers = handlers;
  }

  planPatchCycle(input: GoalPatchCycleInput): GoalPlan {
    const patchHash = stableHash(input.patch);
    return {
      version: PLAN_VERSION,
      id: runIdFor(input.goalId, input.actionId, patchHash),
      kind: 'patch_verify',
      goalId: input.goalId,
      actionId: input.actionId,
      patchHash,
      steps: [
        { id: 'apply', stage: 'apply_patch', dependsOn: [], replay: 'never_if_uncertain' },
        { id: 'verify', stage: 'verify', dependsOn: ['apply'], replay: 'safe' },
      ],
    };
  }

  async executePatchCycle(input: GoalPatchCycleInput): Promise<GoalPlanExecution> {
    const plan = this.planPatchCycle(input);
    const store = new FlowStore(this.#dbPath);
    const executor: CapabilityExecutor = {
      execute: async (capability, persisted) => {
        try {
          const values = objectInput(persisted, capability);
          if (capability === APPLY_CAPABILITY) {
            return await this.#handlers.applyPatch({
              goalId: requiredString(values, 'goalId'),
              actionId: requiredString(values, 'actionId'),
              patch: requiredString(values, 'patch'),
              ...(typeof values.summary === 'string' ? { summary: values.summary } : {}),
            });
          }
          if (capability === VERIFY_CAPABILITY) {
            return await this.#handlers.verify({
              goalId: requiredString(values, 'goalId'),
              ...(optionalNumber(values, 'timeoutMs') !== undefined ? { timeoutMs: optionalNumber(values, 'timeoutMs') } : {}),
              ...(optionalNumber(values, 'totalTimeoutMs') !== undefined ? { totalTimeoutMs: optionalNumber(values, 'totalTimeoutMs') } : {}),
            });
          }
          throw new ToolError('INTERNAL', `Unknown goal planner capability: ${capability}`);
        } catch (error: unknown) {
          throw encodeStageError(error);
        }
      },
    };
    const engine = new FlowEngine(store, executor);

    try {
      let snapshot: RunSnapshot;
      try {
        snapshot = engine.get(plan.id);
      } catch (error: unknown) {
        if (!isNotFound(error)) throw error;
        snapshot = engine.create({
          id: plan.id,
          goal: `Goal ${input.goalId}: apply patch and verify`,
          concurrency: 1,
          metadata: {
            owner: 'goal_planner',
            version: PLAN_VERSION,
            goalId: input.goalId,
            actionId: input.actionId,
            patchHash: plan.patchHash,
          },
          steps: [
            {
              id: 'apply',
              capability: APPLY_CAPABILITY,
              input: {
                goalId: input.goalId,
                actionId: input.actionId,
                patch: input.patch,
                ...(input.summary ? { summary: input.summary } : {}),
              },
              maxAttempts: 1,
            },
            {
              id: 'verify',
              capability: VERIFY_CAPABILITY,
              input: {
                goalId: input.goalId,
                ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
                ...(input.totalTimeoutMs !== undefined ? { totalTimeoutMs: input.totalTimeoutMs } : {}),
              },
              dependsOn: ['apply'],
              maxAttempts: 2,
            },
          ],
        });
      }

      if (snapshot.run.state === 'completed' || snapshot.run.state === 'cancelled') {
        return { plan, flow: summarize(snapshot), recoveryRequired: false };
      }

      if (snapshot.run.state === 'running') {
        const runningApply = snapshot.steps.some((step) => step.capability === APPLY_CAPABILITY && step.status === 'running');
        if (runningApply) {
          snapshot = await engine.resume(plan.id, { retryUncertain: false });
          return {
            plan,
            flow: summarize(snapshot),
            recoveryRequired: true,
            recoveryReason: 'Patch application was interrupted after execution began. The mutation is not replayed automatically.',
          };
        }
        snapshot = await engine.resume(plan.id, { retryUncertain: true });
      } else if (snapshot.run.state === 'failed') {
        const apply = snapshot.steps.find((step) => step.capability === APPLY_CAPABILITY);
        if (apply?.status === 'uncertain') {
          return {
            plan,
            flow: summarize(snapshot),
            recoveryRequired: true,
            recoveryReason: 'Patch application outcome is uncertain and requires reconciliation before any retry.',
          };
        }
        if (apply?.status === 'failed') {
          return {
            plan,
            flow: summarize(snapshot),
            recoveryRequired: false,
            stageError: decodeStageError(apply.error) ?? describeError(new Error(apply.error ?? 'Patch stage failed.')),
          };
        }
        snapshot = await engine.resume(plan.id, { retryUncertain: true });
      } else {
        snapshot = await engine.run(plan.id);
      }

      const failedApply = snapshot.steps.find((step) => step.capability === APPLY_CAPABILITY && step.status === 'failed');
      if (failedApply) {
        return {
          plan,
          flow: summarize(snapshot),
          recoveryRequired: false,
          stageError: decodeStageError(failedApply.error) ?? describeError(new Error(failedApply.error ?? 'Patch stage failed.')),
        };
      }

      const uncertainApply = snapshot.steps.find((step) => step.capability === APPLY_CAPABILITY && step.status === 'uncertain');
      if (uncertainApply) {
        return {
          plan,
          flow: summarize(snapshot),
          recoveryRequired: true,
          recoveryReason: 'Patch application outcome is uncertain and requires reconciliation before any retry.',
        };
      }

      const failedVerify = snapshot.steps.find((step) => step.capability === VERIFY_CAPABILITY && step.status === 'failed');
      return {
        plan,
        flow: summarize(snapshot),
        recoveryRequired: false,
        ...(failedVerify
          ? { stageError: decodeStageError(failedVerify.error) ?? describeError(new Error(failedVerify.error ?? 'Verification stage failed.')) }
          : {}),
      };
    } finally {
      store.close();
    }
  }
}
