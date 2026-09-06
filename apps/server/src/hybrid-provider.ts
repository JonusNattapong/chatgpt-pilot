import { ToolError } from './errors.js';
import type { ToolProvider } from './gateway.js';
import type { ToolSpec } from './tools.js';

export interface CapabilityGroup {
  id: 'coding' | 'think' | 'skills' | 'memory' | 'flow';
  description: string;
  tools: string[];
}

export interface HybridProviderOptions {
  /** Existing low-level capabilities. They remain callable from toolpy but are not all advertised to ChatGPT. */
  capabilities: readonly ToolSpec[];
}

const GROUPS: Array<Omit<CapabilityGroup, 'tools'>> = [
  { id: 'coding', description: 'Machine, filesystem, process, Git, verification, network, and developer operations.' },
  { id: 'think', description: 'Reasoning accelerators supplied by ThinkForge-compatible capability providers.' },
  { id: 'skills', description: 'Reusable procedures and workflow knowledge supplied by Skill Hub-compatible providers.' },
  { id: 'memory', description: 'Persistent recall and write-back supplied by memory capability providers.' },
  { id: 'flow', description: 'Durable DAG orchestration, checkpoints, resume, and bounded parallel capability execution.' },
];

function classify(name: string): CapabilityGroup['id'] {
  if (name.startsWith('thinkforge_') || name.startsWith('think_')) return 'think';
  if (name.startsWith('skills_') || name.startsWith('skill_')) return 'skills';
  if (name.startsWith('memory_') || name.startsWith('ourbook_')) return 'memory';
  if (name.startsWith('flow_')) return 'flow';
  return 'coding';
}

function registrySpec(capabilities: readonly ToolSpec[]): ToolSpec {
  return {
    name: 'capability_registry',
    description: 'Inspect the capabilities available behind toolpy, grouped as coding, think, skills, memory, and flow. Returns metadata only and does not execute a capability.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', enum: GROUPS.map((group) => group.id), description: 'Optional capability group filter.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: async (args) => {
      const requested = args.group;
      if (requested !== undefined && (typeof requested !== 'string' || !GROUPS.some((group) => group.id === requested))) {
        throw new ToolError('INVALID_ARGUMENT', '"group" must be one of: coding, think, skills, memory, flow.');
      }
      const groups = GROUPS
        .filter((group) => requested === undefined || group.id === requested)
        .map((group) => ({
          ...group,
          tools: capabilities.filter((spec) => spec.name !== 'runtime_exec' && classify(spec.name) === group.id).map((spec) => spec.name),
        }));
      return {
        mode: 'hybrid',
        groups,
        capabilityCount: groups.reduce((sum, group) => sum + group.tools.length, 0),
      };
    },
  };
}

/**
 * Compact ChatGPT-facing surface.
 *
 * The existing runtime_exec implementation already provides the controlled Python
 * bridge, policy checks, approvals, audit logging, call budgets, and capability
 * allow-list. Hybrid mode advertises that implementation as `toolpy` and keeps
 * low-level primitives behind it instead of making ChatGPT choose from dozens of
 * nearly mechanical tools.
 */
export function createHybridProvider(options: HybridProviderOptions): ToolProvider {
  const runtimeExec = options.capabilities.find((spec) => spec.name === 'runtime_exec');
  if (!runtimeExec) throw new Error('Hybrid provider requires the runtime_exec capability.');

  const toolpy: ToolSpec = {
    ...runtimeExec,
    name: 'toolpy',
    description: 'Execute model-generated Python in the persistent controlled capability runtime. Use await describe() to inspect capability schemas plus authorization state, await tools.<name>(...) to invoke authorized capabilities, and result(value) for structured output. Low-level coding capabilities stay behind this tool so ChatGPT can compose them programmatically.',
  };

  const publicTools = [toolpy, registrySpec(options.capabilities)];
  return {
    id: 'hybrid',
    tools: () => publicTools,
  };
}
