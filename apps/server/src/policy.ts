import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolSpec } from './tools.js';

export type PolicyProfileName = 'admin' | 'developer' | 'readonly';

export interface PolicyConfig {
  name: string;
  readOnly: boolean;
  tools: {
    allow?: string[];
    deny: string[];
    approvalRequired: string[];
  };
  filesystem: {
    read?: string[];
    write?: string[];
    deny: string[];
  };
  shell: {
    allow?: string[];
    deny: string[];
  };
  network: {
    outbound: boolean;
  };
}

interface PolicyFile {
  name?: string;
  extends?: PolicyProfileName;
  tools?: {
    allow?: string[];
    deny?: string[];
    approvalRequired?: string[];
  };
  filesystem?: {
    read?: string[];
    write?: string[];
    deny?: string[];
  };
  shell?: {
    allow?: string[];
    deny?: string[];
  };
  network?: {
    outbound?: boolean;
  };
}

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
}

const BUILTIN: Record<PolicyProfileName, PolicyConfig> = {
  admin: {
    name: 'admin',
    readOnly: false,
    tools: { deny: [], approvalRequired: [] },
    filesystem: { deny: [] },
    shell: { deny: [] },
    network: { outbound: true },
  },
  developer: {
    name: 'developer',
    readOnly: false,
    tools: {
      deny: [],
      approvalRequired: [
        'shell_command',
        'exec_process',
        'start_process',
        'process_write',
        'stop_process',
        'apply_patch',
        'verify_changes',
        'git_commit',
        'git_commit_verified',
        'git_checkout',
        'git_push',
        'git_publish_paths',
        'restart_if_stale',
        'self_update',
        'machine_call',
        'save_image_from_url',
      ],
    },
    filesystem: { deny: [] },
    shell: { deny: [] },
    network: { outbound: true },
  },
  readonly: {
    name: 'readonly',
    readOnly: true,
    tools: { deny: [], approvalRequired: [] },
    filesystem: { write: [], deny: [] },
    shell: { deny: [] },
    network: { outbound: false },
  },
};

function cloneProfile(name: PolicyProfileName): PolicyConfig {
  return structuredClone(BUILTIN[name]);
}

function assertStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value;
}

function validatePolicyFile(value: unknown): PolicyFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Policy file must contain a JSON object.');
  const input = value as Record<string, unknown>;
  const base = input.extends;
  if (base !== undefined && !['admin', 'developer', 'readonly'].includes(String(base))) {
    throw new Error('Policy "extends" must be one of: admin, developer, readonly.');
  }
  const result: PolicyFile = {
    name: typeof input.name === 'string' ? input.name : undefined,
    extends: base as PolicyProfileName | undefined,
  };
  for (const sectionName of ['tools', 'filesystem', 'shell', 'network'] as const) {
    const section = input[sectionName];
    if (section !== undefined && (!section || typeof section !== 'object' || Array.isArray(section))) {
      throw new Error(`Policy "${sectionName}" must be an object.`);
    }
  }
  const tools = input.tools as Record<string, unknown> | undefined;
  if (tools) {
    result.tools = {
      allow: assertStringArray(tools.allow, 'tools.allow'),
      deny: assertStringArray(tools.deny, 'tools.deny'),
      approvalRequired: assertStringArray(tools.approvalRequired, 'tools.approvalRequired'),
    };
  }
  const filesystem = input.filesystem as Record<string, unknown> | undefined;
  if (filesystem) {
    result.filesystem = {
      read: assertStringArray(filesystem.read, 'filesystem.read'),
      write: assertStringArray(filesystem.write, 'filesystem.write'),
      deny: assertStringArray(filesystem.deny, 'filesystem.deny'),
    };
  }
  const shell = input.shell as Record<string, unknown> | undefined;
  if (shell) {
    result.shell = {
      allow: assertStringArray(shell.allow, 'shell.allow'),
      deny: assertStringArray(shell.deny, 'shell.deny'),
    };
  }
  const network = input.network as Record<string, unknown> | undefined;
  if (network) {
    if (network.outbound !== undefined && typeof network.outbound !== 'boolean') {
      throw new Error('network.outbound must be a boolean.');
    }
    result.network = { outbound: network.outbound as boolean | undefined };
  }
  return result;
}

function mergeUnique(base: string[], extra?: string[]): string[] {
  return [...new Set([...base, ...(extra ?? [])])];
}

export function loadPolicy(spec: string | undefined, root: string): PolicyConfig {
  if (!spec || spec === 'admin') return cloneProfile('admin');
  if (spec === 'developer' || spec === 'readonly') return cloneProfile(spec);

  const policyPath = path.resolve(root, spec);
  const parsed = validatePolicyFile(JSON.parse(fs.readFileSync(policyPath, 'utf8')));
  const base = cloneProfile(parsed.extends ?? 'developer');
  return {
    name: parsed.name ?? `custom:${policyPath}`,
    readOnly: base.readOnly,
    tools: {
      allow: parsed.tools?.allow ?? base.tools.allow,
      deny: mergeUnique(base.tools.deny, parsed.tools?.deny),
      approvalRequired: mergeUnique(base.tools.approvalRequired, parsed.tools?.approvalRequired),
    },
    filesystem: {
      read: parsed.filesystem?.read ?? base.filesystem.read,
      write: parsed.filesystem?.write ?? base.filesystem.write,
      deny: mergeUnique(base.filesystem.deny, parsed.filesystem?.deny),
    },
    shell: {
      allow: parsed.shell?.allow ?? base.shell.allow,
      deny: mergeUnique(base.shell.deny, parsed.shell?.deny),
    },
    network: { outbound: parsed.network?.outbound ?? base.network.outbound },
  };
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Never expose private keys or environment files through the remote bridge. */
function isProtectedSecretPath(candidate: string): boolean {
  const parts = candidate.replace(/\\/g, '/').toLowerCase().split('/');
  const base = parts.at(-1) ?? '';
  return parts.includes('.ssh') || base === '.env' || base.startsWith('.env.') || /\.(pem|key|p12|pfx)$/i.test(base) || base === 'id_rsa' || base === 'id_ed25519';
}

function normalizedRoots(values: string[] | undefined, root: string): string[] | undefined {
  return values?.map((value) => path.resolve(root, value));
}

function extractPaths(toolName: string, args: Record<string, unknown>, root: string): string[] {
  const paths: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) paths.push(path.resolve(root, value));
  };
  add(args.path);
  add(args.workdir);
  if (toolName === 'apply_patch' && typeof args.patch === 'string') {
    for (const line of args.patch.split(/\r?\n/)) {
      const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
      if (match) add(match[1]);
    }
  }
  return [...new Set(paths)];
}

function matchesAnyPattern(command: string, patterns: string[] | undefined): boolean {
  return patterns?.some((pattern) => new RegExp(pattern, 'i').test(command)) ?? false;
}

function validateRegexPatterns(patterns: string[] | undefined, label: string): void {
  for (const pattern of patterns ?? []) {
    try {
      new RegExp(pattern, 'i');
    } catch (error) {
      throw new Error(`${label} contains invalid regular expression ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function validatePolicyConfig(policy: PolicyConfig, toolNames: Iterable<string>): void {
  const known = new Set(toolNames);
  for (const [label, names] of [
    ['tools.allow', policy.tools.allow],
    ['tools.deny', policy.tools.deny],
    ['tools.approvalRequired', policy.tools.approvalRequired],
  ] as const) {
    for (const name of names ?? []) {
      if (!known.has(name)) throw new Error(`${label} references unknown tool: ${name}`);
    }
  }
  validateRegexPatterns(policy.shell.allow, 'shell.allow');
  validateRegexPatterns(policy.shell.deny, 'shell.deny');
}

export function policyFingerprint(policy: PolicyConfig): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

export function evaluatePolicy(
  policy: PolicyConfig,
  spec: ToolSpec,
  args: Record<string, unknown>,
  root: string,
): PolicyDecision {
  if (policy.tools.deny.includes(spec.name)) {
    return { allowed: false, requiresApproval: false, reason: `Tool ${spec.name} is denied by policy ${policy.name}.` };
  }
  if (policy.tools.allow && !policy.tools.allow.includes(spec.name)) {
    return { allowed: false, requiresApproval: false, reason: `Tool ${spec.name} is not in the policy allow-list.` };
  }
  if (policy.readOnly && !spec.annotations.readOnlyHint) {
    return { allowed: false, requiresApproval: false, reason: `Policy readonly permits only read-only tools.` };
  }
  if (!policy.network.outbound && spec.annotations.openWorldHint) {
    return { allowed: false, requiresApproval: false, reason: `Outbound/open-world tools are disabled by policy ${policy.name}.` };
  }

  const command = typeof args.command === 'string' ? args.command : undefined;
  if (command) {
    if (matchesAnyPattern(command, policy.shell.deny)) {
      return { allowed: false, requiresApproval: false, reason: 'The command matched a denied shell policy pattern.' };
    }
    if (policy.shell.allow?.length && !matchesAnyPattern(command, policy.shell.allow)) {
      return { allowed: false, requiresApproval: false, reason: 'The command did not match any allowed shell policy pattern.' };
    }
  }

  const candidates = extractPaths(spec.name, args, root);
  if (candidates.some(isProtectedSecretPath)) {
    return { allowed: false, requiresApproval: false, reason: 'Secret-bearing paths (.env, .ssh, private keys) are always denied by the machine bridge.' };
  }
  const deniedRoots = normalizedRoots(policy.filesystem.deny, root) ?? [];
  for (const candidate of candidates) {
    if (deniedRoots.some((denied) => isInside(candidate, denied))) {
      return { allowed: false, requiresApproval: false, reason: `Path is denied by policy: ${candidate}` };
    }
  }
  const allowedRoots = normalizedRoots(
    spec.annotations.readOnlyHint ? policy.filesystem.read : policy.filesystem.write,
    root,
  );
  if (allowedRoots && candidates.some((candidate) => !allowedRoots.some((allowed) => isInside(candidate, allowed)))) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: `${spec.annotations.readOnlyHint ? 'Read' : 'Write'} path is outside the policy allow-list.`,
    };
  }

  return {
    allowed: true,
    requiresApproval: policy.tools.approvalRequired.includes(spec.name),
  };
}

