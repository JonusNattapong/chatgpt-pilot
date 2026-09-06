import type { CreateRunInput, StepRecord, StepSpec } from "./types.js";

export function normalizeConcurrency(value: number | undefined): number {
  const concurrency = value ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("Flow concurrency must be an integer between 1 and 32.");
  }
  return concurrency;
}

export function normalizeSteps(steps: CreateRunInput["steps"]): StepSpec[] {
  return steps.map((step) => ({
    id: step.id.trim(),
    capability: step.capability.trim(),
    input: step.input ?? {},
    dependsOn: [...(step.dependsOn ?? [])],
    maxAttempts: step.maxAttempts ?? 1,
  }));
}

export function validateDag(steps: StepSpec[]): void {
  if (steps.length === 0) throw new Error("A flow must contain at least one step.");
  if (steps.length > 512) throw new Error("A flow may contain at most 512 steps.");

  const byId = new Map<string, StepSpec>();
  for (const step of steps) {
    if (!step.id) throw new Error("Step id cannot be empty.");
    if (!step.capability) throw new Error(`Step '${step.id}' capability cannot be empty.`);
    if (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1 || step.maxAttempts > 20) {
      throw new Error(`Step '${step.id}' maxAttempts must be an integer between 1 and 20.`);
    }
    if (byId.has(step.id)) throw new Error(`Duplicate step id: '${step.id}'.`);
    byId.set(step.id, step);
  }

  for (const step of steps) {
    const uniqueDependencies = new Set(step.dependsOn);
    if (uniqueDependencies.size !== step.dependsOn.length) {
      throw new Error(`Step '${step.id}' contains duplicate dependencies.`);
    }
    for (const dependency of step.dependsOn) {
      if (dependency === step.id) throw new Error(`Step '${step.id}' cannot depend on itself.`);
      if (!byId.has(dependency)) throw new Error(`Step '${step.id}' depends on unknown step '${dependency}'.`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Flow contains a dependency cycle involving '${id}'.`);
    visiting.add(id);
    const step = byId.get(id);
    if (!step) throw new Error(`Internal DAG error: missing step '${id}'.`);
    for (const dependency of step.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id);
}

export function readySteps(steps: StepRecord[]): StepRecord[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  return steps
    .filter((step) => step.status === "pending")
    .filter((step) => step.dependsOn.every((dependency) => byId.get(dependency)?.status === "succeeded"));
}
