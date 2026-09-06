import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Tool } from '@modelcontextprotocol/server';
import { AuditLogger, defaultAuditPath } from './audit.js';
import { CONTRACT_VERSION, createContractManifest } from './contract.js';
import { APP_VERSION } from './version.js';
import { headCommit, loadBuildInfo } from './build-info.js';
import { diffCapabilities, getRuntimeInfo, restartIfStale, selfUpdate } from './runtime-control.js';
import { describeError, ToolError } from './errors.js';
import {
  editMachineFile,
  editMachineFileTransaction,
  fileInfo,
  findFiles,
  imageInfo,
  listDirectory,
  readMachineFile,
  saveImageFromUrl,
  searchCode,
  updateMachineFile,
  writeMachineFile,
} from './file-tools.js';
import { applyFilePatch, runShellCommand, type MachineAccess, type ShellKind } from './shell-tools.js';
import {
  execProcess,
  listManagedProcesses,
  processStatus,
  readProcessOutput,
  startProcess,
  stopProcess,
  waitProcess,
  writeProcessInput,
} from './process-tools.js';
import {
  gitAdd,
  gitBranch,
  gitCheckout,
  gitCommit,
  gitDiff,
  gitLog,
  gitPush,
  gitPublishPaths,
  gitRemoteStatus,
  gitShow,
  gitStatus,
} from './git-tools.js';
import { diskInfo, environmentInfo, listPorts, listProcesses, networkInfo, systemInfo } from './system-tools.js';
import { gitCommitVerified, verifyChanges, type VerificationProfile } from './verification.js';
import { createMachineRoutingSpecs } from './machine-router.js';
import { PersistentIpythonRuntime, type RuntimeCapability } from './runtime-exec.js';
import { osintFetch, osintSearch, type OsintScope } from './osint.js';

const execFileAsync = promisify(execFile);

export interface ToolExecutionContext {
  approvalGranted?: boolean;
}

export interface RuntimePolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
}

export interface ToolContext extends MachineAccess {
  maxTimeoutMs: number;
  policyName?: string;
  approvalMode?: string;
  audit?: AuditLogger;
  machinesFile?: string;
  osintEnabled?: boolean;
  torProxy?: string;
  runtimeManager?: PersistentIpythonRuntime;
  /** Additional provider capabilities made available behind runtime_exec/toolpy. */
  runtimeCapabilities?: () => readonly ToolSpec[];
  runtimePolicyCheck?: (spec: ToolSpec, args: Record<string, unknown>) => RuntimePolicyDecision;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
  handler: (args: Record<string, unknown>, execution?: ToolExecutionContext) => Promise<unknown>;
}

/*
 * Argument coercion.
 *
 * The previous implementation used String(args.x ?? '') and Number(args.x),
 * which turned a missing or mistyped argument into an empty path or NaN and
 * produced a confusing downstream failure. These helpers fail immediately with
 * the argument name, so the caller can correct the call in one step.
 */

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" is required and must be a non-empty string.`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a string.`);
  return value;
}

function requireText(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string') throw new ToolError('INVALID_ARGUMENT', `"${name}" is required and must be a string.`);
  return value;
}

function optionalInteger(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must be an integer.`);
  }
  return value;
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a boolean.`);
  return value;
}

function optionalStringArray(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must be an array of strings.`);
  }
  return value as string[];
}

function optionalStringRecord(args: Record<string, unknown>, name: string): Record<string, string> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must be an object of string values.`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, entry]) => typeof entry !== 'string')) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" values must be strings.`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function requireObjectArray(args: Record<string, unknown>, name: string, maxItems: number): Record<string, unknown>[] {
  const value = args[name];
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems || value.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must be an array of 1-${maxItems} objects.`);
  }
  return value as Record<string, unknown>[];
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function optionalShell(args: Record<string, unknown>): ShellKind {
  const value = args.shell;
  if (value === undefined || value === null) return 'auto';
  if (typeof value !== 'string' || !['auto', 'powershell', 'cmd', 'bash'].includes(value)) {
    throw new ToolError('INVALID_ARGUMENT', '"shell" must be one of: auto, powershell, cmd, bash.');
  }
  return value as ShellKind;
}

function optionalVerificationProfile(args: Record<string, unknown>): VerificationProfile | undefined {
  const value = args.profile;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !['fast', 'normal', 'strict'].includes(value)) {
    throw new ToolError('INVALID_ARGUMENT', '"profile" must be one of: fast, normal, strict.');
  }
  return value as VerificationProfile;
}

function optionalOsintScope(args: Record<string, unknown>): 'web' | 'onion' {
  const value = optionalString(args, 'scope') ?? 'web';
  if (value !== 'web' && value !== 'onion') throw new ToolError('INVALID_ARGUMENT', '"scope" must be one of: web, onion.');
  return value;
}
/**
 * External-tool probes are cached for the process lifetime: machine_status is
 * called often, and a missing binary does not appear mid-session.
 */
const probeCache = new Map<string, Promise<string | null>>();

function probeVersion(executable: string, args: string[]): Promise<string | null> {
  const key = `${executable} ${args.join(' ')}`;
  const cached = probeCache.get(key);
  if (cached) return cached;
  const probe = execFileAsync(executable, args, { windowsHide: true, timeout: 5_000 })
    .then(({ stdout }) => stdout.split('\n')[0]?.trim() ?? null)
    .catch(() => null);
  probeCache.set(key, probe);
  return probe;
}

const PATH_PROPERTY = {
  type: 'string',
  description: 'Path relative to the workspace root, or an allowed absolute path.',
} as const;

const EXPECTED_SHA256_PROPERTY = {
  type: 'string',
  description: 'Optional SHA-256 returned by a previous read or write. The call fails if the file changed since then.',
} as const;

export function createToolSpecs(context: ToolContext): ToolSpec[] {
  const access: MachineAccess = { root: context.root, unrestricted: context.unrestricted };
  const open = context.unrestricted;
  const audit = context.audit ?? new AuditLogger(defaultAuditPath(context.root));
  const runtimeManager = context.runtimeManager ?? new PersistentIpythonRuntime(context.root);

  const specs: ToolSpec[] = [
    {
      name: 'machine_status',
      description: 'Return a compact machine/runtime health summary. Request optional sections or detailed=true only when deeper diagnostics are needed.',
      inputSchema: {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string', enum: ['git', 'project', 'processes', 'tools'] }, description: 'Optional expanded sections.' },
          detailed: { type: 'boolean', description: 'Include service, platform, dependency, governance, process-history, and tool-surface details.' },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => {
        const include = optionalStringArray(args, 'include') ?? [];
        const detailed = optionalBoolean(args, 'detailed') === true;
        const supervisorFile = process.env.MCP_SUPERVISOR_STATE_FILE ?? path.join(context.root, '.chatgpt-machine', 'supervisor.json');
        let supervisorState: {
          health?: string;
          circuit?: string;
          circuitRetryAt?: string | null;
          lastRestartReason?: string | null;
          restarts?: number;
          workerRoot?: string | null;
        } | undefined;
        try {
          if (existsSync(supervisorFile)) supervisorState = JSON.parse(readFileSync(supervisorFile, 'utf8')) as typeof supervisorState;
        } catch { /* ignore unreadable state */ }

        let configuredWorkspace: string | undefined;
        try {
          const configFile = path.join(path.dirname(supervisorFile), 'config.json');
          if (existsSync(configFile)) {
            const config = JSON.parse(readFileSync(configFile, 'utf8')) as { workspaceRoot?: unknown };
            if (typeof config.workspaceRoot === 'string') configuredWorkspace = path.resolve(config.workspaceRoot);
          }
        } catch { /* ignore unreadable config */ }

        const allProcesses = await listManagedProcesses(access);
        const runningProcesses = allProcesses.filter((entry) => entry.running);
        let statusDetail: Awaited<ReturnType<typeof gitStatus>> | undefined;
        try { statusDetail = await gitStatus(access); } catch { /* workspace may not be a git repo */ }
        const gitLabel = statusDetail ? (statusDetail.clean ? 'clean' : `${statusDetail.files.length} changes (${statusDetail.branch})`) : 'non-git';
        const health = supervisorState?.health ?? (process.env.MCP_SUPERVISED === '1' ? 'healthy' : 'unsupervised');
        const runtimeRoot = supervisorState?.workerRoot ? path.resolve(supervisorState.workerRoot) : path.resolve(context.root);
        const configApplied = configuredWorkspace === undefined ? undefined : sameResolvedPath(runtimeRoot, configuredWorkspace);
        const restartRequired = Boolean(supervisorState && supervisorState.health !== 'stopped' && configApplied === false);

        const project = (detailed || include.includes('project')) ? await readFile(path.join(context.root, 'package.json'), 'utf8').then((text) => {
          const pkg = JSON.parse(text) as { name?: string; scripts?: Record<string, string> };
          return { name: pkg.name, scripts: Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([name]) => ['dev', 'test', 'build', 'lint', 'start', 'check', 'typecheck'].includes(name))) };
        }).catch(() => undefined) : undefined;

        const base = {
          status: health,
          workspace: {
            name: path.basename(runtimeRoot),
            root: runtimeRoot,
            runtimeRoot,
            ...(configuredWorkspace ? { configuredRoot: configuredWorkspace } : {}),
            ...(configApplied !== undefined ? { configApplied } : {}),
            git: gitLabel,
          },
          processes: { running: runningProcesses.length, total: allProcesses.length },
          diagnostics: {
            status: health,
            circuit: supervisorState?.circuit ?? (process.env.MCP_SUPERVISED === '1' ? 'closed' : 'n/a'),
            circuitRetryAt: supervisorState?.circuitRetryAt ?? null,
            restarts: supervisorState?.restarts ?? 0,
            lastRestartReason: supervisorState?.lastRestartReason ?? null,
            configApplied: configApplied ?? null,
            restartRequired,
          },
        };

        if (!detailed) {
          return {
            ...base,
            ...(include.includes('processes') ? { managedProcesses: allProcesses } : {}),
            ...(include.includes('tools') ? { tools: specs.map((spec) => spec.name) } : {}),
            ...(include.includes('project') ? { project } : {}),
            ...(include.includes('git') ? { git: statusDetail } : {}),
          };
        }

        const contract = createContractManifest(specs);
        const build = loadBuildInfo();
        const head = headCommit();
        const staleBuild = build.commit !== null && head !== null && build.commit !== head;
        const [git, ripgrep, bash, powershell] = await Promise.all([
          probeVersion('git', ['--version']),
          probeVersion('rg', ['--version']),
          probeVersion('bash', ['--version']),
          probeVersion(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']),
        ]);
        return {
          ...base,
          service: {
            version: APP_VERSION,
            contractVersion: CONTRACT_VERSION,
            contractFingerprint: contract.fingerprint,
            build: { ...build, head, staleBuild },
            supervised: process.env.MCP_SUPERVISED === '1',
            workerGeneration: process.env.MCP_WORKER_GENERATION ? Number(process.env.MCP_WORKER_GENERATION) : undefined,
          },
          platform: process.platform,
          defaultWorkspace: context.root,
          accessMode: open ? 'UNRESTRICTED_MACHINE' : 'WORKSPACE_ONLY',
          pid: process.pid,
          node: process.version,
          maxTimeoutMs: context.maxTimeoutMs,
          available: { git, ripgrep, bash, powershell, searchEngine: ripgrep ? 'ripgrep' : 'builtin' },
          governance: { policy: context.policyName ?? 'admin', approvalMode: context.approvalMode ?? 'mrtr', auditFile: audit.filePath },
          managedProcesses: allProcesses,
          tools: specs.map((spec) => spec.name),
          project,
          git: statusDetail,
        };
      },
    },
    {
      name: 'runtime_info',
      description: 'Read-only control-plane handshake: build commit/HEAD/staleBuild, worker PID/uptime, tunnel ownership, contract fingerprint, capability count, and the last control restart receipt.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async () => getRuntimeInfo(specs),
    },
    {
      name: 'capability_diff',
      description: 'Read-only. Compare the live worker tool surface against a fresh probe of the current build. Returns added/removed/changed tool names and fingerprintMatch. A mismatch means the worker serves a stale build.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async () => diffCapabilities(specs, { maxTimeoutMs: context.maxTimeoutMs }),
    },
    {
      name: 'restart_if_stale',
      description: 'Bounded mutation. Restarts the worker only when it demonstrably serves a stale build (worker-behind-dist or surface mismatch); no-op with a reason when fresh. Returns immediately; the restart lands seconds later, so poll runtime_info for the new worker. Refuses when unsupervised.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async () => restartIfStale(specs),
    },
    {
      name: 'self_update',
      description: 'Privileged autonomous update: requires MCP_ALLOW_SELF_UPDATE=1. Refuses on dirty tree, non-main branch, unpushed commits, divergence, or fetch failure. Otherwise fast-forward-only pull of origin/main, build, full verification, supervised restart, and a post-restart handshake receipt. Returns before the restart lands; poll runtime_info.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      handler: async () => selfUpdate(),
    },
    {
      name: 'system_info',
      description: 'Read operating-system, CPU, memory, uptime, Node.js, and host identity information without invoking a shell.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async () => systemInfo(),
    },
    {
      name: 'list_processes',
      description: 'List operating-system processes with bounded structured results.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Optional case-insensitive text filter.' },
          limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Maximum returned processes; defaults to 500.' },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => listProcesses({ filter: optionalString(args, 'filter'), limit: optionalInteger(args, 'limit') }),
    },
    {
      name: 'list_ports',
      description: 'List local TCP/UDP endpoints and owning PIDs, optionally filtered by port, PID, or protocol.',
      inputSchema: {
        type: 'object',
        properties: {
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          pid: { type: 'integer', minimum: 1 },
          protocol: { type: 'string', enum: ['tcp', 'udp'] },
          limit: { type: 'integer', minimum: 1, maximum: 2000 },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => {
        const protocol = optionalString(args, 'protocol');
        if (protocol !== undefined && protocol !== 'tcp' && protocol !== 'udp') throw new ToolError('INVALID_ARGUMENT', '"protocol" must be tcp or udp.');
        return listPorts({ port: optionalInteger(args, 'port'), pid: optionalInteger(args, 'pid'), protocol, limit: optionalInteger(args, 'limit') });
      },
    },
    {
      name: 'environment_info',
      description: 'List environment variable names and optionally non-sensitive values. Secret-like variables are always redacted.',
      inputSchema: {
        type: 'object',
        properties: {
          include_values: { type: 'boolean', description: 'Include values for non-sensitive variables; defaults to false.' },
          filter: { type: 'string', description: 'Optional variable-name filter.' },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => environmentInfo({ includeValues: optionalBoolean(args, 'include_values'), filter: optionalString(args, 'filter') }),
    },
    {
      name: 'disk_info',
      description: 'Read filesystem capacity and free-space information for a path allowed by the current machine access policy.',
      inputSchema: { type: 'object', properties: { path: PATH_PROPERTY } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => diskInfo(access, optionalString(args, 'path')),
    },
    {
      name: 'network_info',
      description: 'Read local network-interface addresses and metadata without making an outbound network request.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async () => networkInfo(),
    },
    {
      name: 'audit_recent',
      description: 'Read recent redacted machine-operation audit records.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => ({ records: await audit.recent(optionalInteger(args, 'limit') ?? 50), path: audit.filePath }),
    },
    {
      name: 'audit_search',
      description: 'Search recent redacted audit records by text.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => ({ records: await audit.search(requireString(args, 'query'), optionalInteger(args, 'limit') ?? 100), path: audit.filePath }),
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file with line and byte limits. Returns the file SHA-256; pass it back as "expected_sha256" when writing to detect concurrent changes.',
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH_PROPERTY,
          start_line: { type: 'integer', minimum: 1, description: 'First line to return (1-based).' },
          max_lines: { type: 'integer', minimum: 1, maximum: 10000, description: 'Maximum lines to return.' },
          max_bytes: { type: 'integer', minimum: 1, maximum: 1048576, description: 'Maximum UTF-8 bytes to return.' },
          line_numbers: { type: 'boolean', description: 'Prefix each returned line with its 1-based number and a tab.' },
        },
        required: ['path'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => readMachineFile({
        ...access,
        filePath: requireString(args, 'path'),
        startLine: optionalInteger(args, 'start_line'),
        maxLines: optionalInteger(args, 'max_lines'),
        maxBytes: optionalInteger(args, 'max_bytes'),
        lineNumbers: optionalBoolean(args, 'line_numbers'),
      }),
    },
    {
      name: 'read_files',
      description: 'Read multiple UTF-8 text files in one bounded call. Each file keeps its own line/byte limits and SHA-256; failures are reported per file so one missing file does not discard the other reads.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                path: PATH_PROPERTY,
                start_line: { type: 'integer', minimum: 1 },
                max_lines: { type: 'integer', minimum: 1, maximum: 10000 },
                max_bytes: { type: 'integer', minimum: 1, maximum: 1048576 },
                line_numbers: { type: 'boolean' },
              },
              required: ['path'],
            },
          },
          max_total_bytes: { type: 'integer', minimum: 1024, maximum: 4194304, description: 'Combined returned content budget; defaults to 1 MiB.' },
        },
        required: ['files'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => {
        const requests = requireObjectArray(args, 'files', 50);
        const maxTotalBytes = optionalInteger(args, 'max_total_bytes') ?? 1024 * 1024;
        if (maxTotalBytes < 1024 || maxTotalBytes > 4 * 1024 * 1024) throw new ToolError('INVALID_ARGUMENT', '"max_total_bytes" must be between 1024 and 4194304.');
        let remaining = maxTotalBytes;
        const files: unknown[] = [];
        let budgetExhausted = false;
        for (let index = 0; index < requests.length; index++) {
          const request = requests[index]!;
          const requestedPath = requireString(request, 'path');
          if (remaining <= 0) {
            budgetExhausted = true;
            files.push({ path: requestedPath, skipped: true, error: { code: 'TOO_LARGE', message: 'Combined read_files byte budget was exhausted before this file.' } });
            continue;
          }
          try {
            const perFileMax = optionalInteger(request, 'max_bytes') ?? 1024 * 1024;
            const result = await readMachineFile({
              ...access,
              filePath: requestedPath,
              startLine: optionalInteger(request, 'start_line'),
              maxLines: optionalInteger(request, 'max_lines'),
              maxBytes: Math.min(perFileMax, remaining),
              lineNumbers: optionalBoolean(request, 'line_numbers'),
            });
            remaining -= Buffer.byteLength(result.content, 'utf8');
            files.push(result);
          } catch (error: unknown) {
            files.push({ path: requestedPath, error: describeError(error) });
          }
        }
        return { files, totalBytes: maxTotalBytes - remaining, maxTotalBytes, budgetExhausted };
      },
    },
    {
      name: 'project_snapshot',
      description: 'Read a bounded coding-oriented project snapshot in one call: Git status, top-level tree, package/scripts, project type hints, and common agent instruction files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project directory; defaults to the workspace root.' },
          include: { type: 'array', items: { type: 'string', enum: ['git', 'tree', 'package', 'scripts', 'instructions'] }, description: 'Sections to include; defaults to all.' },
          max_tree_entries: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum top-level entries; defaults to 100.' },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => {
        const requestedPath = optionalString(args, 'path') ?? '.';
        const include = optionalStringArray(args, 'include') ?? ['git', 'tree', 'package', 'scripts', 'instructions'];
        const allowed = new Set(['git', 'tree', 'package', 'scripts', 'instructions']);
        if (include.some((section) => !allowed.has(section))) throw new ToolError('INVALID_ARGUMENT', '"include" contains an unsupported project_snapshot section.');
        const directory = await listDirectory({ ...access, directoryPath: requestedPath, maxEntries: optionalInteger(args, 'max_tree_entries') ?? 100, includeHidden: false });
        const names = new Set(directory.entries.map((entry) => entry.name));
        const projectTypes = [
          names.has('package.json') ? 'node' : undefined,
          names.has('go.mod') ? 'go' : undefined,
          names.has('Cargo.toml') ? 'rust' : undefined,
          names.has('pyproject.toml') || names.has('requirements.txt') ? 'python' : undefined,
        ].filter((value): value is string => Boolean(value));

        let packageInfo: Record<string, unknown> | undefined;
        if ((include.includes('package') || include.includes('scripts')) && names.has('package.json')) {
          try {
            const packageRead = await readMachineFile({ ...access, filePath: path.join(directory.path, 'package.json'), maxBytes: 256 * 1024 });
            const pkg = JSON.parse(packageRead.content) as { name?: string; version?: string; type?: string; scripts?: Record<string, string>; engines?: Record<string, string> };
            packageInfo = { name: pkg.name, version: pkg.version, type: pkg.type, engines: pkg.engines, scripts: pkg.scripts ?? {} };
          } catch (error: unknown) {
            packageInfo = { error: describeError(error) };
          }
        }

        let git: unknown;
        if (include.includes('git')) {
          try { git = await gitStatus({ ...access, path: directory.path }); }
          catch (error: unknown) { git = { error: describeError(error) }; }
        }

        const instructions: unknown[] = [];
        if (include.includes('instructions')) {
          for (const relativePath of ['AGENTS.md', 'CLAUDE.md', path.join('.github', 'copilot-instructions.md')]) {
            try {
              const read = await readMachineFile({ ...access, filePath: path.join(directory.path, relativePath), maxLines: 400, maxBytes: 64 * 1024 });
              instructions.push({ path: read.path, sha256: read.sha256, truncated: read.truncated, content: read.content });
            } catch (error: unknown) {
              if (describeError(error).code !== 'NOT_FOUND') instructions.push({ path: relativePath, error: describeError(error) });
            }
          }
        }

        return {
          path: directory.path,
          projectTypes,
          ...(include.includes('git') ? { git } : {}),
          ...(include.includes('tree') ? { tree: directory } : {}),
          ...(include.includes('package') ? { package: packageInfo } : {}),
          ...(include.includes('scripts') ? { scripts: (packageInfo?.scripts as Record<string, string> | undefined) ?? {} } : {}),
          ...(include.includes('instructions') ? { instructions } : {}),
        };
      },
    },
    {
      name: 'list_directory',
      description: 'List files, directories, and symlinks with size and modification time, without running a shell command.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path; defaults to the workspace root.' },
          max_entries: { type: 'integer', minimum: 1, maximum: 5000, description: 'Maximum returned entries.' },
          include_hidden: { type: 'boolean', description: 'Include names beginning with a dot; defaults to false.' },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => listDirectory({
        ...access,
        directoryPath: optionalString(args, 'path'),
        maxEntries: optionalInteger(args, 'max_entries'),
        includeHidden: optionalBoolean(args, 'include_hidden'),
      }),
    },
    {
      name: 'find_files',
      description: 'Find files recursively by glob. Build output and dependency directories such as node_modules, .git, dist, and target are skipped unless "include_ignored" is true.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to search; defaults to the workspace root.' },
          glob: { type: 'string', description: 'Glob such as **/*.ts; defaults to **/*.' },
          max_results: { type: 'integer', minimum: 1, maximum: 5000, description: 'Maximum returned paths.' },
          max_depth: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum recursive directory depth.' },
          include_hidden: { type: 'boolean', description: 'Traverse names beginning with a dot; defaults to false.' },
          exclude: { type: 'array', items: { type: 'string' }, description: 'Extra directory names to skip.' },
          include_ignored: { type: 'boolean', description: 'Traverse the default-skipped build and dependency directories.' },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => findFiles({
        ...access,
        directoryPath: optionalString(args, 'path'),
        glob: optionalString(args, 'glob'),
        maxResults: optionalInteger(args, 'max_results'),
        maxDepth: optionalInteger(args, 'max_depth'),
        includeHidden: optionalBoolean(args, 'include_hidden'),
        exclude: optionalStringArray(args, 'exclude'),
        includeIgnored: optionalBoolean(args, 'include_ignored'),
      }),
    },
    {
      name: 'file_info',
      description: 'Get file or directory metadata and an optional SHA-256 hash for regular files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH_PROPERTY,
          include_hash: { type: 'boolean', description: 'Calculate SHA-256 for regular files; defaults to true.' },
        },
        required: ['path'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => fileInfo({
        ...access,
        filePath: requireString(args, 'path'),
        includeHash: optionalBoolean(args, 'include_hash') ?? true,
      }),
    },
    {
      name: 'image_info',
      description: 'Inspect a local PNG, JPEG, or WebP image and return dimensions, size, and SHA-256.',
      inputSchema: { type: 'object', properties: { path: PATH_PROPERTY }, required: ['path'] },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => imageInfo({ ...access, filePath: requireString(args, 'path') }),
    },
    {
      name: 'save_image_from_url',
      description: 'Download an HTTPS PNG, JPEG, or WebP image to the machine. Blocks local and private hosts, limits redirects and size, and sends no cookies or credentials.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTPS image URL.' },
          path: { type: 'string', description: 'Destination image path.' },
          overwrite: { type: 'boolean', description: 'Allow replacing an existing file; defaults to false.' },
        },
        required: ['url', 'path'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      handler: async (args) => saveImageFromUrl({
        ...access,
        url: requireString(args, 'url'),
        filePath: requireString(args, 'path'),
        overwrite: optionalBoolean(args, 'overwrite'),
      }),
    },
    {
      name: 'search_code',
      description: 'Search file contents and return structured path, line, column, and text matches. Uses ripgrep when installed and falls back to a built-in scanner otherwise. Supports surrounding context lines, a per-file match cap, and a files-only mode for cheap surveys.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression, or literal text when "literal" is true.' },
          path: { type: 'string', description: 'File or directory to search; defaults to the workspace.' },
          globs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Include globs such as **/*.ts, or exclude globs prefixed with "!".',
          },
          case_sensitive: { type: 'boolean', description: 'Use case-sensitive matching; defaults to true.' },
          literal: { type: 'boolean', description: 'Treat pattern as literal text instead of a regular expression.' },
          max_results: { type: 'integer', minimum: 1, maximum: 2000, description: 'Maximum returned matches.' },
          max_matches_per_file: { type: 'integer', minimum: 1, maximum: 2000, description: 'Stop after this many matches in each file.' },
          context_lines: { type: 'integer', minimum: 0, maximum: 10, description: 'Lines of surrounding context to include with each match.' },
          files_only: { type: 'boolean', description: 'Return only the list of matching file paths.' },
          timeout_ms: { type: 'integer', minimum: 1, maximum: 60000, description: 'Search timeout in milliseconds.' },
        },
        required: ['pattern'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => searchCode({
        ...access,
        pattern: requireString(args, 'pattern'),
        searchPath: optionalString(args, 'path'),
        globs: optionalStringArray(args, 'globs'),
        caseSensitive: optionalBoolean(args, 'case_sensitive') ?? true,
        literal: optionalBoolean(args, 'literal'),
        maxResults: optionalInteger(args, 'max_results'),
        maxMatchesPerFile: optionalInteger(args, 'max_matches_per_file'),
        contextLines: optionalInteger(args, 'context_lines'),
        filesOnly: optionalBoolean(args, 'files_only'),
        timeoutMs: optionalInteger(args, 'timeout_ms'),
      }),
    },
    {
      name: 'write_file',
      description: 'Create a UTF-8 text file, or replace one when "overwrite" is true. Prefer edit_file or update_file for changes to an existing file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH_PROPERTY,
          content: { type: 'string', description: 'Complete UTF-8 file content.' },
          overwrite: { type: 'boolean', description: 'Allow replacing an existing file; defaults to false.' },
          expected_sha256: EXPECTED_SHA256_PROPERTY,
        },
        required: ['path', 'content'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args) => writeMachineFile({
        ...access,
        filePath: requireString(args, 'path'),
        content: requireText(args, 'content'),
        overwrite: optionalBoolean(args, 'overwrite'),
        expectedSha256: optionalString(args, 'expected_sha256'),
      }),
    },
    {
      name: 'edit_file',
      description: 'Replace exact text in an existing UTF-8 file. Supply either old_text/new_text or an edits array. Array edits are validated in memory then written atomically, so a failed edit never leaves a partial file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH_PROPERTY,
          old_text: { type: 'string', description: 'Exact text to find, copied verbatim from read_file output.' },
          new_text: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence; defaults to false.' },
          expected_replacements: { type: 'integer', minimum: 1, description: 'Require exactly this many occurrences.' },
          expected_sha256: EXPECTED_SHA256_PROPERTY,
          dry_run: { type: 'boolean', description: 'Report what would change without writing the file.' },
          edits: { type: 'array', minItems: 1, items: { type: 'object', properties: { old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' }, expected_replacements: { type: 'integer', minimum: 1 } }, required: ['old_text', 'new_text'] }, description: 'Transactional sequence of edits; all succeed or none are written.' },
        },
        required: ['path'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args) => {
        const common = { ...access, filePath: requireString(args, 'path'), expectedSha256: optionalString(args, 'expected_sha256'), dryRun: optionalBoolean(args, 'dry_run') };
        if (args.edits !== undefined) {
          if (!Array.isArray(args.edits)) throw new ToolError('INVALID_ARGUMENT', '"edits" must be an array.');
          return editMachineFileTransaction({ ...common, edits: args.edits.map((item, index) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ToolError('INVALID_ARGUMENT', `edits[${index}] must be an object.`);
            const edit = item as Record<string, unknown>;
            return { oldText: requireText(edit, 'old_text'), newText: requireText(edit, 'new_text'), replaceAll: optionalBoolean(edit, 'replace_all'), expectedReplacements: optionalInteger(edit, 'expected_replacements') };
          }) });
        }
        return editMachineFile({ ...common, oldText: requireText(args, 'old_text'), newText: requireText(args, 'new_text'), replaceAll: optionalBoolean(args, 'replace_all'), expectedReplacements: optionalInteger(args, 'expected_replacements') });
      },
    },
    {
      name: 'update_file',
      description: 'Replace an inclusive 1-based line range in an existing UTF-8 text file. Line numbers shift after every edit, so read the file again between updates.',
      inputSchema: {
        type: 'object',
        properties: {
          path: PATH_PROPERTY,
          start_line: { type: 'integer', minimum: 1, description: 'First line to replace (1-based).' },
          end_line: { type: 'integer', minimum: 1, description: 'Last line to replace (inclusive).' },
          content: { type: 'string', description: 'Replacement content; an empty string deletes the selected lines.' },
          expected_sha256: EXPECTED_SHA256_PROPERTY,
        },
        required: ['path', 'start_line', 'end_line', 'content'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args) => updateMachineFile({
        ...access,
        filePath: requireString(args, 'path'),
        startLine: optionalInteger(args, 'start_line') ?? Number.NaN,
        endLine: optionalInteger(args, 'end_line') ?? Number.NaN,
        content: requireText(args, 'content'),
        expectedSha256: optionalString(args, 'expected_sha256'),
      }),
    },
    {
      name: 'shell_command',
      description: open
        ? 'Run an arbitrary shell command anywhere on this machine and wait for it to finish. This tool has unrestricted machine access. Use start_process for anything long-running.'
        : 'Run a shell command inside the configured workspace root and wait for it to finish. Use start_process for anything long-running.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to execute.' },
          workdir: { type: 'string', description: 'Absolute path or path relative to the default workspace.' },
          shell: { type: 'string', enum: ['auto', 'powershell', 'cmd', 'bash'] },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds.' },
          max_output_bytes: { type: 'number', description: 'Maximum combined stdout/stderr bytes (1024-4194304).' },
          env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Environment variables merged over the server environment.' },
          stdin: { type: 'string', description: 'Text written to the command standard input, which is then closed.' },
          expect_exit_code: { type: 'integer', description: 'Expected exit code; a different result is reported as an error.' },
          on_timeout: { type: 'string', enum: ['terminate', 'background'], description: 'Terminate on timeout (default), or keep running as a managed background process.' },
        },
        required: ['command'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      handler: async (args) => {
        const expectedExitCode = optionalInteger(args, 'expect_exit_code');
        const onTimeout = optionalString(args, 'on_timeout') ?? 'terminate';
        if (!['terminate', 'background'].includes(onTimeout)) throw new ToolError('INVALID_ARGUMENT', '"on_timeout" must be terminate or background.');
        if (onTimeout === 'background') {
          const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : 30_000;
          if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > context.maxTimeoutMs) throw new ToolError('INVALID_ARGUMENT', `"timeout_ms" must be between 100 and ${context.maxTimeoutMs}.`);
          const started = await startProcess({ ...access, command: requireString(args, 'command'), workdir: optionalString(args, 'workdir'), shell: optionalShell(args), env: optionalStringRecord(args, 'env') });
          const stdin = optionalString(args, 'stdin');
          if (stdin !== undefined) await writeProcessInput({ ...access, pid: started.pid, input: stdin, end: true });
          const output = await readProcessOutput({ ...access, pid: started.pid, waitMs: timeoutMs });
          const base = { shell: started.shell, command: started.command, workdir: started.workdir, pid: started.pid, exitCode: output.exitCode, stdout: output.stdout, stderr: output.stderr, timedOut: output.running, outputTruncated: output.outputTruncated, promotedToBackground: output.running, nextStdoutOffset: output.nextStdoutOffset, nextStderrOffset: output.nextStderrOffset, hint: output.running ? 'Poll read_process_output with the returned offsets.' : undefined };
          return expectedExitCode === undefined ? base : { ...base, expectedExitCode, expectationMet: output.exitCode === expectedExitCode };
        }
        const result = await runShellCommand({
        ...access,
        command: requireString(args, 'command'),
        workdir: optionalString(args, 'workdir'),
        shell: optionalShell(args),
        timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
        maxTimeoutMs: context.maxTimeoutMs,
        maxOutputBytes: typeof args.max_output_bytes === 'number' ? args.max_output_bytes : undefined,
        env: optionalStringRecord(args, 'env'),
        stdin: optionalString(args, 'stdin'),
        });
        return expectedExitCode === undefined ? result : { ...result, expectedExitCode, expectationMet: result.exitCode === expectedExitCode };
      },
    },
    {
      name: 'exec_process',
      description: 'Execute one binary with an explicit argv vector, without shell parsing or quoting. Prefer this over shell_command for scripts, Git helpers, and structured command invocation.',
      inputSchema: {
        type: 'object',
        properties: {
          executable: { type: 'string', description: 'Executable name or path.' },
          args: { type: 'array', maxItems: 256, items: { type: 'string' }, description: 'Argument vector passed directly to the executable.' },
          workdir: { type: 'string', description: 'Working directory; defaults to the workspace.' },
          env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Environment variables merged over the server environment.' },
          stdin: { type: 'string', description: 'UTF-8 text written to stdin before it is closed.' },
          timeout_ms: { type: 'integer', minimum: 100, maximum: context.maxTimeoutMs },
          max_output_bytes: { type: 'integer', minimum: 1024, maximum: 4194304 },
          expect_exit_code: { type: 'integer', description: 'Optional expected exit code.' },
        },
        required: ['executable'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      handler: async (args) => execProcess({
        ...access,
        executable: requireString(args, 'executable'),
        args: optionalStringArray(args, 'args'),
        workdir: optionalString(args, 'workdir'),
        env: optionalStringRecord(args, 'env'),
        stdin: optionalString(args, 'stdin'),
        timeoutMs: optionalInteger(args, 'timeout_ms'),
        maxTimeoutMs: context.maxTimeoutMs,
        maxOutputBytes: optionalInteger(args, 'max_output_bytes'),
        expectExitCode: optionalInteger(args, 'expect_exit_code'),
      }),
    },
    {
      name: 'start_process',
      description: open
        ? 'Start a background PowerShell, cmd, or Bash process anywhere on this machine and return its PID. Poll it with read_process_output.'
        : 'Start a background process inside the configured workspace and return its PID. Poll it with read_process_output.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run in the background.' },
          workdir: { type: 'string', description: 'Working directory.' },
          shell: { type: 'string', enum: ['auto', 'powershell', 'cmd', 'bash'] },
          env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Environment variables merged over the server environment.' },
        },
        required: ['command'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      handler: async (args) => startProcess({
        ...access,
        command: requireString(args, 'command'),
        workdir: optionalString(args, 'workdir'),
        shell: optionalShell(args),
        env: optionalStringRecord(args, 'env'),
      }),
    },
    {
      name: 'process_status',
      description: 'Get the status, runtime, and current output offsets for a managed background process.',
      inputSchema: {
        type: 'object',
        properties: { pid: { type: 'integer', minimum: 1, description: 'Process ID returned by start_process.' }, process_id: { type: 'string', description: 'Opaque processId returned by start_process; detects stale PID references.' } },
        required: ['pid'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => processStatus({ ...access, pid: optionalInteger(args, 'pid') ?? Number.NaN, processId: optionalString(args, 'process_id') }),
    },
    {
      name: 'read_process_output',
      description: 'Read captured stdout and stderr from a managed background process. Pass the previous "next_stdout_offset" and "next_stderr_offset" values as "since_stdout" and "since_stderr" to receive only new output, and "wait_ms" to block until output arrives or the process exits.',
      inputSchema: {
        type: 'object',
        properties: {
          pid: { type: 'integer', minimum: 1, description: 'Process ID returned by start_process.' },
          process_id: { type: 'string', description: 'Opaque processId returned by start_process; detects stale PID references.' },
          since_stdout: { type: 'integer', minimum: 0, description: 'Return stdout produced after this offset.' },
          since_stderr: { type: 'integer', minimum: 0, description: 'Return stderr produced after this offset.' },
          wait_ms: { type: 'integer', minimum: 0, maximum: 60000, description: 'Wait up to this long for new output or process exit.' },
        },
        required: ['pid'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => readProcessOutput({
        ...access,
        pid: optionalInteger(args, 'pid') ?? Number.NaN, processId: optionalString(args, 'process_id'),
        sinceStdout: optionalInteger(args, 'since_stdout'),
        sinceStderr: optionalInteger(args, 'since_stderr'),
        waitMs: optionalInteger(args, 'wait_ms'),
      }),
    },
    {
      name: 'process_write',
      description: 'Write UTF-8 text to the standard input of a live process started by start_process. Recovered processes remain inspectable after restart but their stdin cannot be reattached.',
      inputSchema: {
        type: 'object',
        properties: {
          pid: { type: 'integer', minimum: 1, description: 'Process ID returned by start_process.' },
          process_id: { type: 'string', description: 'Opaque processId returned by start_process; detects stale PID references.' },
          input: { type: 'string', description: 'UTF-8 text to write to standard input.' },
          end: { type: 'boolean', description: 'Close standard input after writing; defaults to false.' },
        },
        required: ['pid', 'input'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args) => writeProcessInput({
        ...access,
        pid: optionalInteger(args, 'pid') ?? Number.NaN, processId: optionalString(args, 'process_id'),
        input: requireText(args, 'input'),
        end: optionalBoolean(args, 'end'),
      }),
    },
    {
      name: 'process_wait',
      description: 'Wait until a managed background process exits or the timeout expires. Returns the exit code and output offsets without requiring repeated process_status calls; a timeout does not stop the process.',
      inputSchema: {
        type: 'object',
        properties: {
          pid: { type: 'integer', minimum: 1, description: 'Process ID returned by start_process.' },
          process_id: { type: 'string', description: 'Opaque processId returned by start_process; detects stale PID references.' },
          include_output: { type: 'boolean', description: 'Include a bounded stdout/stderr page with the exit status.' },
          max_output_bytes: { type: 'integer', minimum: 4, maximum: 4194304 },
          since_stdout: { type: 'integer', minimum: 0 },
          since_stderr: { type: 'integer', minimum: 0 },
          timeout_ms: { type: 'integer', minimum: 100, maximum: context.maxTimeoutMs, description: 'Maximum time to wait. Defaults to 30000 ms.' },
        },
        required: ['pid'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => waitProcess({
        ...access,
        pid: optionalInteger(args, 'pid') ?? Number.NaN, processId: optionalString(args, 'process_id'),
        timeoutMs: optionalInteger(args, 'timeout_ms') ?? Math.min(30_000, context.maxTimeoutMs),
        maxTimeoutMs: context.maxTimeoutMs,
        includeOutput: optionalBoolean(args, 'include_output'),
        maxOutputBytes: optionalInteger(args, 'max_output_bytes'),
        sinceStdout: optionalInteger(args, 'since_stdout'),
        sinceStderr: optionalInteger(args, 'since_stderr'),
      }),
    },
    {
      name: 'stop_process',
      description: 'Stop a managed background process and its child tree by PID.',
      inputSchema: {
        type: 'object',
        properties: { pid: { type: 'integer', minimum: 1, description: 'Process ID returned by start_process.' }, process_id: { type: 'string', description: 'Opaque processId returned by start_process; detects stale PID references.' } },
        required: ['pid'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args) => stopProcess({ ...access, pid: optionalInteger(args, 'pid') ?? Number.NaN, processId: optionalString(args, 'process_id') }),
    },
    {
      name: 'apply_patch',
      description: open
        ? 'Add, update, move, or delete files anywhere on this machine using Codex patch format. Run with "dry_run" first when the context lines are uncertain.'
        : 'Add, update, move, or delete files inside the configured workspace using Codex patch format. Run with "dry_run" first when the context lines are uncertain.',
      inputSchema: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'Patch beginning with *** Begin Patch and ending with *** End Patch.' },
          expected_sha256: { type: 'object', additionalProperties: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, description: 'When supplied, must cover every updated/deleted source path with its read-time SHA-256.' },
          dry_run: { type: 'boolean', description: 'Validate and report changes without writing files.' },
        },
        required: ['patch'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args) => {
        const dryRun = optionalBoolean(args, 'dry_run') === true;
        return { changed: await applyFilePatch(access, requireText(args, 'patch'), dryRun, optionalStringRecord(args, 'expected_sha256')), dryRun };
      },
    },
    {
      name: 'verify_changes',
      description: 'Run the detected project verification pipeline with a fast, normal, or strict profile. This executes repository-defined build/test scripts but does not stage or commit files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project directory; defaults to the workspace.' },
          profile: { type: 'string', enum: ['fast', 'normal', 'strict'], description: 'Verification depth; defaults to normal.' },
          total_timeout_ms: { type: 'integer', minimum: 1000, maximum: 660000, description: 'Total verification budget across all checks; defaults to timeout_ms. Cleanup may take a bounded grace period.' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: 660000, description: 'Timeout per verification command.' },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args) => verifyChanges({
        ...access,
        path: optionalString(args, 'path'),
        profile: optionalVerificationProfile(args),
        timeoutMs: optionalInteger(args, 'timeout_ms') ?? context.maxTimeoutMs,
        totalTimeoutMs: optionalInteger(args, 'total_timeout_ms'),
      }),
    },
    {
      name: 'git_status',
      description: 'Read the current Git branch, upstream tracking state, and working-tree status without running a shell command.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Git repository directory; defaults to the workspace.' } },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => gitStatus({ ...access, path: optionalString(args, 'path') }),
    },
    {
      name: 'git_remote_status',
      description: 'Read local-vs-remote branch state using structured Git commands. Set refresh=true to fetch the selected branch first so ahead/behind is based on current remote state.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Git repository directory; defaults to the workspace.' },
          remote: { type: 'string', description: 'Remote name; defaults to origin.' },
          branch: { type: 'string', description: 'Branch; defaults to the current branch.' },
          refresh: { type: 'boolean', description: 'Fetch remote/branch before computing ahead/behind.' },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      handler: async (args) => gitRemoteStatus({
        ...access,
        path: optionalString(args, 'path'),
        remote: optionalString(args, 'remote'),
        branch: optionalString(args, 'branch'),
        refresh: optionalBoolean(args, 'refresh'),
      }),
    },
    {
      name: 'git_diff',
      description: 'Read the Git working-tree or staged diff without running a shell command, optionally limited to specific paths.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Git repository directory; defaults to the workspace.' },
          staged: { type: 'boolean', description: 'Read the staged diff instead of the working-tree diff.' },
          stat_only: { type: 'boolean', description: 'Return only diff statistics.' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Limit the diff to these repository paths.' },
          context_lines: { type: 'integer', minimum: 0, maximum: 20, description: 'Lines of context around each hunk.' },
          max_bytes: { type: 'integer', minimum: 1024, maximum: 4194304, description: 'Maximum diff bytes.' },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => gitDiff({
        ...access,
        path: optionalString(args, 'path'),
        staged: optionalBoolean(args, 'staged'),
        statOnly: optionalBoolean(args, 'stat_only'),
        paths: optionalStringArray(args, 'paths'),
        contextLines: optionalInteger(args, 'context_lines'),
        maxBytes: optionalInteger(args, 'max_bytes'),
      }),
    },
    {
      name: 'git_log',
      description: 'Read structured Git commit history without shell interpolation.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Git repository directory; defaults to the workspace.' },
          max_count: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum commits; defaults to 20.' },
          ref: { type: 'string', description: 'Optional revision or branch; defaults to HEAD.' },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => gitLog({ ...access, path: optionalString(args, 'path'), maxCount: optionalInteger(args, 'max_count'), ref: optionalString(args, 'ref') }),
    },
    {
      name: 'git_show',
      description: 'Read one Git revision and its patch or statistics with bounded output.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Git repository directory; defaults to the workspace.' },
          ref: { type: 'string', description: 'Revision; defaults to HEAD.' },
          stat_only: { type: 'boolean' },
          max_bytes: { type: 'integer', minimum: 1024, maximum: 4194304 },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => gitShow({ ...access, path: optionalString(args, 'path'), ref: optionalString(args, 'ref'), statOnly: optionalBoolean(args, 'stat_only'), maxBytes: optionalInteger(args, 'max_bytes') }),
    },
    {
      name: 'git_branch',
      description: 'List local Git branches and optionally remote branches with current/upstream metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Git repository directory; defaults to the workspace.' },
          all: { type: 'boolean', description: 'Include remote branches.' },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => gitBranch({ ...access, path: optionalString(args, 'path'), all: optionalBoolean(args, 'all') }),
    },
    {
      name: 'git_add',
      description: 'Stage explicit repository paths using Git directly, without shell interpolation.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Git repository directory; defaults to the workspace.' },
          paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Repository paths to stage.' },
        },
        required: ['paths'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args) => gitAdd({ ...access, path: optionalString(args, 'path'), paths: optionalStringArray(args, 'paths') ?? [] }),
    },
    {
      name: 'git_commit',
      description: 'Create a local Git commit from staged changes, optionally staging tracked-file modifications with --all.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Git repository directory; defaults to the workspace.' },
          message: { type: 'string', description: 'Commit message.' },
          all: { type: 'boolean', description: 'Stage tracked-file modifications/deletions before committing.' },
        },
        required: ['message'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args) => gitCommit({ ...access, path: optionalString(args, 'path'), message: requireString(args, 'message'), all: optionalBoolean(args, 'all') }),
    },
    {
      name: 'git_commit_verified',
      description: 'Verify the project, stage only explicit paths, and create a local commit. Refuses pre-existing staged changes so unrelated work cannot be committed accidentally.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Git repository directory; defaults to the workspace.' },
          paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Explicit repository paths to include.' },
          message: { type: 'string', description: 'Commit message.' },
          profile: { type: 'string', enum: ['fast', 'normal', 'strict'], description: 'Verification depth; defaults to normal.' },
          total_timeout_ms: { type: 'integer', minimum: 1000, maximum: 660000, description: 'Total verification budget across all checks; defaults to timeout_ms. Cleanup may take a bounded grace period.' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: 660000, description: 'Timeout per verification command.' },
        },
        required: ['paths', 'message'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args) => gitCommitVerified({
        ...access,
        path: optionalString(args, 'path'),
        paths: optionalStringArray(args, 'paths') ?? [],
        message: requireString(args, 'message'),
        profile: optionalVerificationProfile(args),
        timeoutMs: optionalInteger(args, 'timeout_ms') ?? context.maxTimeoutMs,
        totalTimeoutMs: optionalInteger(args, 'total_timeout_ms'),
      }),
    },
    {
      name: 'git_checkout',
      description: 'Switch to an existing Git branch, or create and switch to a new branch. Force/discard modes are intentionally not exposed.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Git repository directory; defaults to the workspace.' },
          branch: { type: 'string' },
          create: { type: 'boolean' },
        },
        required: ['branch'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      handler: async (args) => gitCheckout({ ...access, path: optionalString(args, 'path'), branch: requireString(args, 'branch'), create: optionalBoolean(args, 'create') }),
    },
    {
      name: 'git_push',
      description: 'Push a Git branch to a remote using Git directly. This is an external mutation and is approval-gated by the developer policy.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Git repository directory; defaults to the workspace.' },
          remote: { type: 'string', description: 'Remote name; defaults to origin.' },
          branch: { type: 'string', description: 'Branch; defaults to the current branch.' },
          set_upstream: { type: 'boolean' },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      handler: async (args) => gitPush({ ...access, path: optionalString(args, 'path'), remote: optionalString(args, 'remote'), branch: optionalString(args, 'branch'), setUpstream: optionalBoolean(args, 'set_upstream') }),
    },
    {
      name: 'git_publish_paths',
      description: 'Safely publish only selected files. Fetches the remote branch, refuses selected-path drift, copies only those files into an isolated temporary worktree rooted at the remote tip, optionally verifies there, commits, then pushes without changing the caller worktree/index/branch.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Git repository directory; defaults to the workspace.' },
          paths: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' }, description: 'Repository-relative files to publish.' },
          message: { type: 'string', description: 'Commit message for the isolated publish commit.' },
          remote: { type: 'string', description: 'Remote name; defaults to origin.' },
          branch: { type: 'string', description: 'Branch; defaults to the current branch.' },
          verify_profile: { type: 'string', enum: ['fast', 'normal', 'strict'], description: 'Optional project verification profile to run inside the isolated worktree before commit/push.' },
          verify_timeout_ms: { type: 'integer', minimum: 1000, maximum: context.maxTimeoutMs, description: 'Verification timeout when verify_profile is supplied.' },
        },
        required: ['paths', 'message'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      handler: async (args) => {
        const profile = optionalVerificationProfile({ profile: args.verify_profile });
        return gitPublishPaths({
          ...access,
          path: optionalString(args, 'path'),
          paths: optionalStringArray(args, 'paths') ?? [],
          message: requireString(args, 'message'),
          remote: optionalString(args, 'remote'),
          branch: optionalString(args, 'branch'),
          verify: profile ? async (isolatedWorktree) => verifyChanges({
            ...access,
            root: isolatedWorktree,
            path: isolatedWorktree,
            profile,
            timeoutMs: optionalInteger(args, 'verify_timeout_ms') ?? context.maxTimeoutMs,
          }) : undefined,
        });
      },
    },
  ];

  if (context.osintEnabled) {
    specs.push({
      name: 'osint_search',
      description: 'Search public web indexes for OSINT leads. onion scope uses the Ahmia public index and returns links only; it does not log in, submit forms, or crawl.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 500 },
          scope: { type: 'string', enum: ['web', 'onion'], description: 'web for clearnet results; onion for public .onion links indexed by Ahmia.' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: context.maxTimeoutMs },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      handler: async (args) => osintSearch(
        requireString(args, 'query'),
        optionalOsintScope(args) as OsintScope,
        optionalInteger(args, 'timeout_ms') ?? Math.min(30_000, context.maxTimeoutMs),
        context.torProxy,
      ),
    });
    specs.push({
      name: 'osint_fetch',
      description: 'Fetch and extract bounded text, title, and links from a public HTTPS page. .onion URLs require a local Tor SOCKS5 proxy; cookies, credentials, binary downloads, and redirects outside the requested scope are rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute HTTPS URL. Use scope=onion for .onion hosts.' },
          scope: { type: 'string', enum: ['web', 'onion'] },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: context.maxTimeoutMs },
        },
        required: ['url'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      handler: async (args) => osintFetch({
        url: requireString(args, 'url'),
        scope: optionalOsintScope(args) as OsintScope,
        timeoutMs: optionalInteger(args, 'timeout_ms') ?? Math.min(30_000, context.maxTimeoutMs),
        torProxy: context.torProxy,
      }),
    });
  }

  specs.push(...createMachineRoutingSpecs({
    machinesFile: context.machinesFile,
    timeoutMs: context.maxTimeoutMs,
  }));

  specs.push({
    name: 'runtime_exec',
    description: 'Execute model-generated Python in a persistent IPython/Jupyter kernel. Variables, imports, and helper functions survive across calls sharing session_id. Use await tools.<name>(...) or await call(name, args) for MCP capabilities, await describe() for the declared catalog, and result(value) to return structured data. The kernel is an unrestricted control environment, not a sandbox, so this tool is available only with --dangerously-open-machine.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', maxLength: 262144, description: 'Python/IPython cell source. Top-level await is supported. Use result(value) for a structured result.' },
        session_id: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$', description: 'Persistent kernel namespace. Defaults to default. State survives until reset, idle eviction, worker restart, or timeout termination.' },
        reset_session: { type: 'boolean', description: 'Terminate any existing kernel for session_id before executing this cell.' },
        allow_tools: { type: 'array', maxItems: 64, items: { type: 'string' }, description: 'Exact MCP capabilities callable from this cell. Defaults to all read-only capabilities. Mutating capabilities must be explicitly declared.' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: context.maxTimeoutMs, description: 'Cell execution limit; defaults to 30000 ms. A timeout terminates the session to guarantee cleanup.' },
        max_calls: { type: 'integer', minimum: 1, maximum: 256, description: 'Maximum MCP capability calls from this cell; defaults to 32.' },
        max_output_bytes: { type: 'integer', minimum: 1024, maximum: 4194304, description: 'Maximum captured stdout/stderr/display output for this cell; defaults to 1048576.' },
      },
      required: ['code'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args, execution) => {
      if (!context.unrestricted) {
        throw new ToolError(
          'POLICY_DENIED',
          'runtime_exec requires --dangerously-open-machine because a persistent IPython kernel has the worker operating-system permissions.',
          'Use the ordinary bounded MCP tools in workspace-only mode, or run the bridge inside an external sandbox before enabling runtime_exec.',
        );
      }
      const code = requireText(args, 'code');
      const requested = optionalStringArray(args, 'allow_tools');
      if (requested && requested.length > 64) throw new ToolError('INVALID_ARGUMENT', '"allow_tools" accepts at most 64 capability names.');
      const localCallableSpecs = specs.filter((spec) => spec.name !== 'runtime_exec');
      const externalCallableSpecs = [...(context.runtimeCapabilities?.() ?? [])]
        .filter((spec) => spec.name !== 'runtime_exec' && spec.name !== 'toolpy');
      const byName = new Map<string, ToolSpec>();
      for (const spec of [...localCallableSpecs, ...externalCallableSpecs]) {
        const existing = byName.get(spec.name);
        if (existing && existing !== spec) {
          throw new ToolError('INTERNAL', `Duplicate runtime capability: ${spec.name}.`);
        }
        byName.set(spec.name, spec);
      }
      const callableSpecs = [...byName.values()];
      const defaultAllowed = callableSpecs
        .filter((spec) => spec.annotations.readOnlyHint
          || (!spec.annotations.destructiveHint && !spec.annotations.openWorldHint))
        .map((spec) => spec.name);
      const allowedNames = [...new Set(requested ?? defaultAllowed)];
      for (const name of allowedNames) {
        if (!byName.has(name)) {
          throw new ToolError(
            'UNKNOWN_TOOL',
            `Unknown runtime capability: ${name}.`,
            'Call runtime_exec with code="result(await describe())" to inspect capability schemas and their authorized flag, or use the normal MCP tool list outside runtime-only mode.',
          );
        }
      }
      const capabilities: RuntimeCapability[] = callableSpecs.map((spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: spec.annotations,
      }));
      return runtimeManager.execute({
        code,
        sessionId: optionalString(args, 'session_id') ?? 'default',
        resetSession: optionalBoolean(args, 'reset_session'),
        allowedTools: new Set(allowedNames),
        capabilities,
        timeoutMs: optionalInteger(args, 'timeout_ms') ?? Math.min(30_000, context.maxTimeoutMs),
        maxCalls: optionalInteger(args, 'max_calls') ?? 32,
        maxOutputBytes: optionalInteger(args, 'max_output_bytes') ?? 1024 * 1024,
        invoke: async (name, nestedArgs) => {
          const nestedSpec = byName.get(name);
          if (!nestedSpec) throw new ToolError('UNKNOWN_TOOL', `Unknown runtime capability: ${name}.`);
          const decision = context.runtimePolicyCheck?.(nestedSpec, nestedArgs) ?? { allowed: true, requiresApproval: false };
          if (!decision.allowed) throw new ToolError('POLICY_DENIED', decision.reason ?? `Runtime capability ${name} was denied by policy.`);
          if (decision.requiresApproval && execution?.approvalGranted !== true) {
            throw new ToolError(
              'APPROVAL_REQUIRED',
              `Runtime capability ${name} requires approval under policy ${context.policyName ?? 'current'}.`,
              'Approve the outer runtime_exec request or call the capability directly.',
            );
          }
          const traceId = randomUUID();
          const startedAt = Date.now();
          try {
            const result = await nestedSpec.handler(nestedArgs, { approvalGranted: execution?.approvalGranted });
            const failed = (name === 'shell_command' || name === 'exec_process')
              && (result as { promotedToBackground?: boolean }).promotedToBackground !== true
              && ((result as { success?: boolean }).success === false
                || (result as { expectationMet?: boolean }).expectationMet === false
                || (result as { exitCode?: number | null }).exitCode !== 0
                || (result as { timedOut?: boolean }).timedOut === true);
            await audit.write({
              traceId,
              tool: name,
              policy: context.policyName ?? 'admin',
              decision: decision.requiresApproval ? 'approval_required' : 'allowed',
              status: failed ? 'error' : 'success',
              durationMs: Date.now() - startedAt,
              args: { ...nestedArgs, runtime_parent: 'runtime_exec' },
              errorCode: failed ? 'COMMAND_FAILED' : undefined,
            });
            return result;
          } catch (error: unknown) {
            const described = describeError(error);
            await audit.write({
              traceId,
              tool: name,
              policy: context.policyName ?? 'admin',
              decision: decision.requiresApproval ? 'approval_required' : 'allowed',
              status: 'error',
              durationMs: Date.now() - startedAt,
              args: { ...nestedArgs, runtime_parent: 'runtime_exec' },
              errorCode: described.code,
            });
            throw error;
          }
        },
      });
    },
  });

  return specs;
}
