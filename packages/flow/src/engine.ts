import { normalizeConcurrency, normalizeSteps, readySteps, validateDag } from "./graph.js";
import { FlowStore } from "./store.js";
import type { CapabilityExecutor, CreateRunInput, ResumeOptions, RunSnapshot, StepRecord } from "./types.js";

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

type StepOutcome = { kind: "succeeded" | "retry" | "exhausted"; step: StepRecord };

export class FlowEngine {
  readonly #activeRuns = new Set<string>();
  constructor(readonly store: FlowStore, readonly executor: CapabilityExecutor) {}

  create(input: CreateRunInput): RunSnapshot {
    const steps = normalizeSteps(input.steps);
    validateDag(steps);
    return this.store.createRun(input, steps, normalizeConcurrency(input.concurrency));
  }
  get(runId: string): RunSnapshot { return this.store.getSnapshot(runId); }

  async run(runId: string): Promise<RunSnapshot> {
    if (this.#activeRuns.has(runId)) throw new Error(`Flow '${runId}' is already executing in this process.`);
    const initial = this.store.getSnapshot(runId);
    if (initial.run.state === "completed" || initial.run.state === "cancelled") return initial;
    if (initial.run.state === "running") throw new Error(`Flow '${runId}' is already marked running. Use flow_resume only after confirming the previous executor stopped.`);
    if (initial.run.state === "failed") throw new Error(`Flow '${runId}' is failed. Use flow_resume to start a new recovery cycle.`);
    if (initial.steps.some((step) => step.status === "uncertain")) throw new Error(`Flow '${runId}' has uncertain steps. Use flow_resume with retry_uncertain only after checking side effects.`);
    return this.#withActive(runId, async () => {
      this.store.setRunState(runId, "running", "run.started");
      return this.#drive(runId);
    });
  }

  async resume(runId: string, options: ResumeOptions = {}): Promise<RunSnapshot> {
    if (this.#activeRuns.has(runId)) throw new Error(`Flow '${runId}' is still executing in this process.`);
    const initial = this.store.getSnapshot(runId);
    if (initial.run.state === "completed" || initial.run.state === "cancelled") return initial;
    const interrupted = this.store.markRunningAsUncertain(runId);
    const uncertain = this.store.getSnapshot(runId).steps.filter((step) => step.status === "uncertain");
    if (uncertain.length > 0 && options.retryUncertain !== true) {
      this.store.setRunState(runId, "failed", "run.recovery_blocked", { uncertainSteps: uncertain.map((step) => step.id), newlyUncertainSteps: interrupted });
      this.store.createCheckpoint(runId, "recovery-blocked-uncertain");
      return this.store.getSnapshot(runId);
    }
    this.store.prepareResume(runId, options.retryUncertain === true);
    return this.#withActive(runId, async () => {
      this.store.setRunState(runId, "running", "run.resumed", { retryUncertain: options.retryUncertain === true });
      return this.#drive(runId);
    });
  }

  cancel(runId: string): RunSnapshot { return this.store.cancel(runId); }

  async #withActive<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    this.#activeRuns.add(runId);
    try { return await operation(); } finally { this.#activeRuns.delete(runId); }
  }

  async #executeStep(runId: string, candidate: StepRecord): Promise<StepOutcome> {
    const running = this.store.beginStep(runId, candidate.id);
    try {
      const output = await this.executor.execute(running.capability, running.input, { runId, stepId: running.id, attempt: running.attempts });
      this.store.completeStep(runId, running.id, output);
      return { kind: "succeeded", step: this.store.getSnapshot(runId).steps.find((step) => step.id === running.id)! };
    } catch (error) {
      const failed = this.store.failStep(runId, running.id, errorMessage(error));
      if (failed.attempts < failed.maxAttempts) {
        this.store.scheduleRetry(runId, failed.id);
        return { kind: "retry", step: failed };
      }
      return { kind: "exhausted", step: failed };
    }
  }

  async #drive(runId: string): Promise<RunSnapshot> {
    while (true) {
      const snapshot = this.store.getSnapshot(runId);
      if (snapshot.run.state === "cancelled") return snapshot;
      if (snapshot.steps.every((step) => step.status === "succeeded")) {
        this.store.setRunState(runId, "completed", "run.completed");
        this.store.createCheckpoint(runId, "run:completed");
        return this.store.getSnapshot(runId);
      }
      if (snapshot.steps.some((step) => step.status === "uncertain")) {
        this.store.setRunState(runId, "failed", "run.failed", { reason: "uncertain_step" });
        this.store.createCheckpoint(runId, "run:failed:uncertain");
        return this.store.getSnapshot(runId);
      }

      const ready = readySteps(snapshot.steps).slice(0, snapshot.run.concurrency);
      if (ready.length === 0) {
        this.store.setRunState(runId, "failed", "run.failed", { reason: "no_runnable_steps" });
        this.store.createCheckpoint(runId, "run:failed:no-runnable-steps");
        return this.store.getSnapshot(runId);
      }

      this.store.createCheckpoint(runId, `batch:${ready.map((step) => step.id).join(",")}:starting`);
      const outcomes = await Promise.all(ready.map((step) => this.#executeStep(runId, step)));
      const exhausted = outcomes.find((outcome) => outcome.kind === "exhausted");
      if (exhausted) {
        this.store.setRunState(runId, "failed", "run.failed", { reason: "step_exhausted_attempts", stepId: exhausted.step.id, attempts: exhausted.step.attempts });
        this.store.createCheckpoint(runId, `run:failed:${exhausted.step.id}`);
        return this.store.getSnapshot(runId);
      }
    }
  }
}
