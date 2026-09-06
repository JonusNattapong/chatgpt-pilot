import path from 'node:path';
import { FlowEngine, FlowStore, type CapabilityExecutor, type CreateRunInput } from '@chatgpt-pilot/flow';
import { ToolError } from './errors.js';
import type { ToolProvider } from './gateway.js';
import type { RuntimePolicyDecision, ToolSpec } from './tools.js';

export interface FlowProviderOptions {
  root: string;
  capabilities: () => readonly ToolSpec[];
  policyCheck: (spec: ToolSpec, args: Record<string, unknown>) => RuntimePolicyDecision;
  dbPath?: string;
}

export interface FlowToolProvider extends ToolProvider {
  close(): Promise<void>;
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" is required and must be a non-empty string.`);
  }
  return value;
}

function optionalInteger(args: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must be an integer between ${min} and ${max}.`);
  }
  return value as number;
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseSteps(value: unknown): CreateRunInput['steps'] {
  if (!Array.isArray(value) || value.length === 0) throw new ToolError('INVALID_ARGUMENT', '"steps" must be a non-empty array.');
  return value.map((raw, index) => {
    const step = objectValue(raw, `steps[${index}]`);
    const id = requireString(step, 'id');
    const capability = requireString(step, 'capability');
    const dependsRaw = step.depends_on;
    let dependsOn: string[] | undefined;
    if (dependsRaw !== undefined) {
      if (!Array.isArray(dependsRaw) || !dependsRaw.every((entry) => typeof entry === 'string' && entry.length > 0)) {
        throw new ToolError('INVALID_ARGUMENT', `"steps[${index}].depends_on" must be an array of non-empty strings.`);
      }
      dependsOn = [...dependsRaw] as string[];
    }
    const maxAttemptsRaw = step.max_attempts;
    let maxAttempts: number | undefined;
    if (maxAttemptsRaw !== undefined) {
      if (!Number.isInteger(maxAttemptsRaw) || (maxAttemptsRaw as number) < 1 || (maxAttemptsRaw as number) > 20) {
        throw new ToolError('INVALID_ARGUMENT', `"steps[${index}].max_attempts" must be an integer between 1 and 20.`);
      }
      maxAttempts = maxAttemptsRaw as number;
    }
    return {
      id,
      capability,
      input: step.input ?? {},
      ...(dependsOn ? { dependsOn } : {}),
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    };
  });
}

function argsRecord(input: unknown, capability: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ToolError('INVALID_ARGUMENT', `Flow step capability ${capability} requires object input.`);
  }
  return input as Record<string, unknown>;
}

export function createFlowProvider(options: FlowProviderOptions): FlowToolProvider {
  const store = new FlowStore(options.dbPath ?? path.join(options.root, '.pilot', 'flow', 'runs.db'));

  const executor: CapabilityExecutor = {
    execute: async (capability, input) => {
      if (capability.startsWith('flow_') || capability === 'runtime_exec' || capability === 'toolpy' || capability === 'capability_registry') {
        throw new ToolError('POLICY_DENIED', `Flow cannot recursively execute orchestration capability ${capability}.`);
      }
      const spec = options.capabilities().find((candidate) => candidate.name === capability);
      if (!spec) throw new ToolError('UNKNOWN_TOOL', `Unknown flow capability: ${capability}.`);
      const args = argsRecord(input, capability);
      const decision = options.policyCheck(spec, args);
      if (!decision.allowed) throw new ToolError('POLICY_DENIED', decision.reason ?? `Capability ${capability} was denied by policy.`);
      if (decision.requiresApproval) {
        throw new ToolError(
          'APPROVAL_REQUIRED',
          `Nested flow capability ${capability} requires approval.`,
          'Run the capability directly for interactive approval, or use a policy that allows this bounded flow step.',
        );
      }
      return spec.handler(args);
    },
  };

  const engine = new FlowEngine(store, executor);
  const specs: ToolSpec[] = [
    {
      name: 'flow_create',
      description: 'Create a durable DAG workflow. Independent ready steps are eligible to run concurrently; use expected_sha256 on edit_file inputs for optimistic concurrency instead of serial file locks.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          goal: { type: 'string', minLength: 1 },
          concurrency: { type: 'integer', minimum: 1, maximum: 32, default: 4 },
          metadata: { type: 'object', additionalProperties: true },
          steps: {
            type: 'array', minItems: 1, maxItems: 512,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', minLength: 1 },
                capability: { type: 'string', minLength: 1 },
                input: { type: 'object', additionalProperties: true },
                depends_on: { type: 'array', items: { type: 'string' } },
                max_attempts: { type: 'integer', minimum: 1, maximum: 20, default: 1 },
              },
              required: ['id', 'capability'],
              additionalProperties: false,
            },
          },
        },
        required: ['goal', 'steps'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: async (args) => {
        const metadata = args.metadata === undefined ? undefined : objectValue(args.metadata, 'metadata');
        return engine.create({
          ...(typeof args.id === 'string' ? { id: args.id } : {}),
          goal: requireString(args, 'goal'),
          ...(optionalInteger(args, 'concurrency', 1, 32) !== undefined ? { concurrency: args.concurrency as number } : {}),
          steps: parseSteps(args.steps),
          ...(metadata ? { metadata } : {}),
        });
      },
    },
    {
      name: 'flow_get',
      description: 'Read one durable workflow run and all step states.',
      inputSchema: { type: 'object', properties: { run_id: { type: 'string', minLength: 1 } }, required: ['run_id'], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => engine.get(requireString(args, 'run_id')),
    },
    {
      name: 'flow_run',
      description: 'Execute a planned workflow. Ready DAG steps run concurrently up to the run concurrency limit. Nested capabilities are re-checked against the active policy.',
      inputSchema: { type: 'object', properties: { run_id: { type: 'string', minLength: 1 } }, required: ['run_id'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      handler: async (args) => engine.run(requireString(args, 'run_id')),
    },
    {
      name: 'flow_resume',
      description: 'Resume a failed/interrupted workflow. Unknown side effects fail closed unless retry_uncertain is explicitly authorized.',
      inputSchema: {
        type: 'object',
        properties: { run_id: { type: 'string', minLength: 1 }, retry_uncertain: { type: 'boolean', default: false } },
        required: ['run_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      handler: async (args) => {
        if (args.retry_uncertain !== undefined && typeof args.retry_uncertain !== 'boolean') throw new ToolError('INVALID_ARGUMENT', '"retry_uncertain" must be a boolean.');
        return engine.resume(requireString(args, 'run_id'), { retryUncertain: args.retry_uncertain === true });
      },
    },
    {
      name: 'flow_cancel',
      description: 'Persistently mark a workflow run cancelled so no new step batch is scheduled.',
      inputSchema: { type: 'object', properties: { run_id: { type: 'string', minLength: 1 } }, required: ['run_id'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: async (args) => engine.cancel(requireString(args, 'run_id')),
    },
    {
      name: 'flow_events',
      description: 'Read the append-only event log and recent checkpoints for a workflow run.',
      inputSchema: {
        type: 'object',
        properties: { run_id: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
        required: ['run_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => {
        const runId = requireString(args, 'run_id');
        const limit = optionalInteger(args, 'limit', 1, 500) ?? 100;
        return { events: store.listEvents(runId, limit), checkpoints: store.listCheckpoints(runId, Math.min(limit, 100)) };
      },
    },
  ];

  return {
    id: 'flow',
    tools: () => specs,
    close: async () => { store.close(); },
  };
}
