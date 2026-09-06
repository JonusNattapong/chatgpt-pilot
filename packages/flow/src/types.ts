export const RUN_STATES = ["planned", "running", "failed", "completed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const STEP_STATES = ["pending", "running", "succeeded", "failed", "uncertain", "skipped"] as const;
export type StepState = (typeof STEP_STATES)[number];

export interface StepSpec {
  id: string;
  capability: string;
  input: unknown;
  dependsOn: string[];
  maxAttempts: number;
}

export interface CreateRunInput {
  id?: string;
  goal: string;
  concurrency?: number;
  steps: Array<{
    id: string;
    capability: string;
    input?: unknown;
    dependsOn?: string[];
    maxAttempts?: number;
  }>;
  metadata?: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  goal: string;
  state: RunState;
  concurrency: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface StepRecord extends StepSpec {
  runId: string;
  status: StepState;
  output: unknown;
  attempts: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunSnapshot {
  run: RunRecord;
  steps: StepRecord[];
}

export interface FlowEvent {
  seq: number;
  runId: string;
  stepId: string | null;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export interface Checkpoint {
  id: string;
  runId: string;
  reason: string;
  createdAt: string;
  snapshot: RunSnapshot;
}

export interface CapabilityExecutionContext {
  runId: string;
  stepId: string;
  attempt: number;
}

export interface CapabilityExecutor {
  execute(capability: string, input: unknown, context: CapabilityExecutionContext): Promise<unknown>;
}

export interface ResumeOptions {
  retryUncertain?: boolean;
}
