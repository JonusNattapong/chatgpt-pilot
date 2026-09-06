#!/usr/bin/env node

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { access, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  acceptedContent,
  createMcpHandler,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  Server,
  type RequestStateCodec,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { context as otelContext, propagation } from '@opentelemetry/api';
import {
  createApprovalRequestState,
  matchesApprovalRequestState,
  type ApprovalRequestState,
} from './approval-state.js';
import { AuditLogger, defaultAuditPath, redactSecrets } from './audit.js';
import { CONTRACT_VERSION, createContractManifest } from './contract.js';
import { describeError, ToolError } from './errors.js';
import { evaluatePolicy, loadPolicy, policyFingerprint, validatePolicyConfig, type PolicyConfig } from './policy.js';
import { withToolSpan } from './telemetry.js';
import type { ToolSpec } from './tools.js';
import { ToolGateway, type ToolProvider } from './gateway.js';
import { createMachineProvider } from './machine-provider.js';
import { createHybridProvider } from './hybrid-provider.js';
import { createRemoteMcpProvider } from './remote-provider.js';
import { StdioMcpAdapter } from './stdio-mcp-adapter.js';
import { IdempotencyStore } from './idempotency.js';
import { APP_VERSION } from './version.js';
import { headCommit, loadBuildInfo } from './build-info.js';

interface Options {
  root: string;
  dangerouslyOpenMachine: boolean;
  maxTimeoutMs: number;
  http: boolean;
  httpHost: string;
  httpPort: number;
  httpToken?: string;
  machinesFile?: string;
  policy: string;
  approvalMode: 'mrtr' | 'deny';
  auditFile?: string;
  check: boolean;
  doctor: boolean;
  dryRun: boolean;
  osintEnabled: boolean;
  torProxy?: string;
  toolSurface: 'legacy' | 'hybrid';
  skillHubDir?: string;
  thinkForgeDir?: string;
  memoryDir?: string;
}

interface Runtime {
  options: Options;
  policy: PolicyConfig;
  audit: AuditLogger;
  approvalState: RequestStateCodec<ApprovalRequestState>;
  idempotency: IdempotencyStore;
  gateway: ToolGateway;
  capabilities: readonly ToolSpec[];
  providerIds: string[];
  closeProviders: Array<() => Promise<void>>;
}

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseOptions(args: string[]): Options {
  const options: Options = {
    root: process.cwd(),
    dangerouslyOpenMachine: false,
    maxTimeoutMs: 10 * 60_000,
    http: false,
    httpHost: '127.0.0.1',
    httpPort: 8787,
    httpToken: process.env.MCP_HTTP_TOKEN,
    machinesFile: process.env.MCP_MACHINES_FILE,
    policy: process.env.MCP_POLICY ?? 'admin',
    approvalMode: 'mrtr',
    auditFile: process.env.MCP_AUDIT_FILE,
    check: false,
    doctor: false,
    dryRun: false,
    osintEnabled: process.env.MCP_ENABLE_OSINT === '1',
    torProxy: process.env.MCP_TOR_SOCKS_PROXY,
    toolSurface: process.env.MCP_TOOL_SURFACE === 'hybrid' ? 'hybrid' : 'legacy',
    skillHubDir: process.env.MCP_SKILL_HUB_DIR,
    thinkForgeDir: process.env.MCP_THINKFORGE_DIR,
    memoryDir: process.env.MCP_MEMORY_DIR,
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--root') options.root = valueAfter(args, index++, arg);
    else if (arg === '--dangerously-open-machine') options.dangerouslyOpenMachine = true;
    else if (arg === '--max-timeout') options.maxTimeoutMs = Number(valueAfter(args, index++, arg));
    else if (arg === '--http') options.http = true;
    else if (arg === '--http-host') options.httpHost = valueAfter(args, index++, arg);
    else if (arg === '--http-port') options.httpPort = Number(valueAfter(args, index++, arg));
    else if (arg === '--http-token') options.httpToken = valueAfter(args, index++, arg);
    else if (arg === '--machines-file') options.machinesFile = valueAfter(args, index++, arg);
    else if (arg === '--policy') options.policy = valueAfter(args, index++, arg);
    else if (arg === '--approval-mode') options.approvalMode = valueAfter(args, index++, arg) as Options['approvalMode'];
    else if (arg === '--audit-file') options.auditFile = valueAfter(args, index++, arg);
    else if (arg === '--check') options.check = true;
    else if (arg === '--doctor') options.doctor = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--enable-osint') options.osintEnabled = true;
    else if (arg === '--tor-proxy') options.torProxy = valueAfter(args, index++, arg);
    else if (arg === '--tool-surface') options.toolSurface = valueAfter(args, index++, arg) as Options['toolSurface'];
    else if (arg === '--skill-hub-dir') options.skillHubDir = valueAfter(args, index++, arg);
    else if (arg === '--thinkforge-dir') options.thinkForgeDir = valueAfter(args, index++, arg);
    else if (arg === '--memory-dir') options.memoryDir = valueAfter(args, index++, arg);
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`chatgpt-machine-mcp\n\n` +
        `  --root <path>                 Default workspace and safe-mode boundary\n` +
        `  --dangerously-open-machine    Allow absolute paths, arbitrary shell, and unrestricted Codex\n` +
        `  --max-timeout <ms>            Maximum tool timeout (default: 600000)\n` +
        `  --http                        Use Streamable HTTP instead of stdio\n` +
        `  --http-host <host>            HTTP bind host (default: 127.0.0.1)\n` +
        `  --http-port <port>            HTTP port (default: 8787)\n` +
        `  --http-token <token>          Optional Bearer token; required off loopback\n` +
        `  --machines-file <path>        JSON registry of allowed remote machine nodes\n` +
        `  --policy <profile|file>       admin (default), developer, readonly, or a JSON policy file\n` +
        `  --approval-mode <mode>        mrtr (default) or deny when a policy requires approval\n` +
        `  --audit-file <path>           NDJSON audit log (default: <root>/.chatgpt-machine/audit.ndjson)\n` +
        `  --check                       Print configuration and the tool list, then exit\n` +
        `  --dry-run                     Refuse mutations and report their simulated status\n` +
        `  --enable-osint                Enable bounded public-web/.onion OSINT tools\n` +
        `  --tor-proxy <socks5h://...>   Local Tor SOCKS5 proxy for .onion fetches\n` +
        `  --tool-surface <mode>         legacy (default) or hybrid (toolpy + capability registry)\n` +
        `  --skill-hub-dir <path>        Attach a local Skill Hub MCP provider behind toolpy\n` +
        `  --thinkforge-dir <path>       Attach a local ThinkForge MCP provider behind toolpy\n` +
        `  --memory-dir <path>           Attach a local OurBook memory MCP provider behind toolpy\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.root = path.resolve(options.root);
  if (options.auditFile) options.auditFile = path.resolve(options.root, options.auditFile);
  if (options.machinesFile) options.machinesFile = path.resolve(options.machinesFile);

  const workspaceRoot = path.resolve(new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  if (!options.skillHubDir) {
    const internal = path.join(workspaceRoot, 'packages', 'skill-hub');
    options.skillHubDir = internal;
  }
  if (!options.thinkForgeDir) {
    const internal = path.join(workspaceRoot, 'packages', 'thinkforge');
    options.thinkForgeDir = internal;
  }
  if (!options.memoryDir) {
    const internal = path.join(workspaceRoot, 'packages', 'memory');
    options.memoryDir = internal;
  }

  if (options.skillHubDir) options.skillHubDir = path.resolve(options.skillHubDir);
  if (options.thinkForgeDir) options.thinkForgeDir = path.resolve(options.thinkForgeDir);
  if (options.memoryDir) options.memoryDir = path.resolve(options.memoryDir);
  if (!Number.isInteger(options.maxTimeoutMs) || options.maxTimeoutMs < 1_000) {
    throw new Error('--max-timeout must be an integer of at least 1000 milliseconds.');
  }
  if (!Number.isInteger(options.httpPort) || options.httpPort < 1 || options.httpPort > 65_535) {
    throw new Error('--http-port must be an integer between 1 and 65535.');
  }
  if (!['mrtr', 'deny'].includes(options.approvalMode)) throw new Error('--approval-mode must be one of: mrtr, deny.');
  if (!['legacy', 'hybrid'].includes(options.toolSurface)) throw new Error('--tool-surface must be one of: legacy, hybrid.');
  if (options.toolSurface === 'hybrid' && !options.dangerouslyOpenMachine) throw new Error('--tool-surface hybrid requires --dangerously-open-machine because toolpy uses the persistent Python runtime.');
  if (options.http && !['127.0.0.1', 'localhost', '::1'].includes(options.httpHost) && !options.httpToken) {
    throw new Error('HTTP binding outside loopback requires --http-token or MCP_HTTP_TOKEN.');
  }
  return options;
}
function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: redactSecrets(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Every tool answers with the same envelope. A caller can branch on "ok" and, on
 * failure, on a stable "error.code" instead of pattern-matching prose.
 */
function successResult(value: unknown) {
  return textResult({ ok: true, ...(value as Record<string, unknown>) });
}

function errorResult(toolName: string, error: unknown) {
  return textResult({ ok: false, tool: toolName, error: describeError(error) }, true);
}

async function buildRuntime(
  options: Options,
  policy: PolicyConfig,
  audit: AuditLogger,
  approvalState: RequestStateCodec<ApprovalRequestState>,
): Promise<Runtime> {
  let externalCapabilities: ToolSpec[] = [];
  const machineProvider = createMachineProvider({
    root: options.root,
    unrestricted: options.dangerouslyOpenMachine,
    maxTimeoutMs: options.maxTimeoutMs,
    policyName: policy.name,
    approvalMode: options.approvalMode,
    audit,
    machinesFile: options.machinesFile,
    osintEnabled: options.osintEnabled,
    torProxy: options.torProxy,
    runtimeCapabilities: () => externalCapabilities,
    runtimePolicyCheck: (spec, args) => evaluatePolicy(policy, spec, args, options.root),
  });

  const capabilityProviders: ToolProvider[] = [machineProvider];
  const closeProviders: Array<() => Promise<void>> = [];

  try {
  if (options.skillHubDir) {
    let entry = path.join(options.skillHubDir, 'dist', 'src', 'index.js');
    let readable = await access(entry, fsConstants.R_OK).then(() => true, () => false);
    if (!readable) {
      entry = path.join(options.skillHubDir, 'dist', 'index.js');
      readable = await access(entry, fsConstants.R_OK).then(() => true, () => false);
    }
    if (!readable) {
      throw new ToolError(
        'DEPENDENCY_MISSING',
        `Skill Hub build output was not found in: ${options.skillHubDir}`,
        'Run pnpm build in the repository root, or remove --skill-hub-dir.',
      );
    }

    const adapter = new StdioMcpAdapter({
      command: process.execPath,
      args: [entry, '--stdio'],
      cwd: options.skillHubDir,
      timeoutMs: Math.min(options.maxTimeoutMs, 30_000),
      clientName: 'chatgpt-machine-mcp-skill-provider',
      clientVersion: APP_VERSION,
    });
    try {
      const provider = await createRemoteMcpProvider({ id: 'skills', adapter });
      capabilityProviders.push(provider);
      closeProviders.push(() => adapter.close());
    } catch (error) {
      await adapter.close();
      throw error;
    }
  }

  if (options.thinkForgeDir) {
    const entry = path.join(options.thinkForgeDir, 'dist', 'index.js');
    const readable = await access(entry, fsConstants.R_OK).then(() => true, () => false);
    if (!readable) {
      throw new ToolError(
        'DEPENDENCY_MISSING',
        `ThinkForge build output was not found: ${entry}`,
        'Run npm run build in the ThinkForge repository, or remove --thinkforge-dir.',
      );
    }

    const adapter = new StdioMcpAdapter({
      command: process.execPath,
      args: [entry],
      cwd: options.thinkForgeDir,
      timeoutMs: Math.min(options.maxTimeoutMs, 30_000),
      clientName: 'chatgpt-machine-mcp-think-provider',
      clientVersion: APP_VERSION,
    });
    try {
      const provider = await createRemoteMcpProvider({ id: 'think', adapter });
      capabilityProviders.push(provider);
      closeProviders.push(() => adapter.close());
    } catch (error) {
      await adapter.close();
      throw error;
    }
  }

  if (options.memoryDir) {
    const entry = path.join(options.memoryDir, 'dist', 'index.js');
    const readable = await access(entry, fsConstants.R_OK).then(() => true, () => false);
    if (!readable) {
      throw new ToolError(
        'DEPENDENCY_MISSING',
        `Memory build output was not found: ${entry}`,
        'Run pnpm build in packages/memory, or remove --memory-dir.',
      );
    }

    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    const adapter = new StdioMcpAdapter({
      command: process.execPath,
      args: [entry, 'mcp'],
      cwd: options.memoryDir,
      env: childEnv,
      timeoutMs: Math.min(options.maxTimeoutMs, 30_000),
      clientName: 'chatgpt-pilot-mcp-memory-provider',
      clientVersion: APP_VERSION,
    });
    try {
      const provider = await createRemoteMcpProvider({
        id: 'memory',
        adapter,
        publicName: (_providerId, remoteToolName) =>
          remoteToolName.startsWith('memory_')
            ? remoteToolName
            : remoteToolName.startsWith('ourbook_')
              ? `memory_${remoteToolName.slice('ourbook_'.length)}`
              : `memory_${remoteToolName}`,
      });
      capabilityProviders.push(provider);
      closeProviders.push(() => adapter.close());
    } catch (error) {
      await adapter.close();
      throw error;
    }
  }
  } catch (error) {
    await Promise.allSettled(closeProviders.map((close) => close()));
    throw error;
  }

  externalCapabilities = capabilityProviders.slice(1).flatMap((provider) => [...provider.tools()]);
  const capabilities = capabilityProviders.flatMap((provider) => [...provider.tools()]);
  const publicProvider = options.toolSurface === 'hybrid'
    ? createHybridProvider({ capabilities })
    : machineProvider;
  const gateway = new ToolGateway([publicProvider]);

  validatePolicyConfig(
    policy,
    new Set([...capabilities, ...gateway.listTools()].map((spec) => spec.name)),
  );

  return {
    options,
    policy,
    audit,
    approvalState,
    idempotency: new IdempotencyStore(path.join(
      options.root,
      existsSync(path.join(options.root, '.pilot')) || !existsSync(path.join(options.root, '.chatgpt-machine')) ? '.pilot' : '.chatgpt-machine',
      'receipts',
      policyFingerprint(policy) + (options.dangerouslyOpenMachine ? '-open' : '-workspace'),
    )),
    gateway,
    capabilities,
    providerIds: capabilityProviders.map((provider) => provider.id),
    closeProviders,
  };
}

function createMcpServer(runtime: Runtime): Server {
  const { options, policy, audit, approvalState, idempotency, gateway } = runtime;
  const specs = gateway.listTools();
  const server = new Server(
    { name: 'chatgpt-pilot', version: APP_VERSION },
    {
      capabilities: { tools: {}, prompts: { listChanged: false }, resources: { subscribe: true, listChanged: false }, completions: {}, logging: {} },
      cacheHints: {
        'tools/list': { ttlMs: 30_000, cacheScope: 'private' },
      },
      requestState: {
        verify: (state, ctx) => approvalState.verify(state, ctx),
      },
    },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: specs.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    })),
  }));

  server.setRequestHandler('prompts/list', async () => ({ prompts: [{ name: 'safe-edit-loop', title: 'Safe edit loop', description: 'Read, hash, transactionally edit, then verify a workspace file.', arguments: [{ name: 'path', description: 'Workspace-relative file path', required: true }] }] }));
  server.setRequestHandler('prompts/get', async (request) => {
    if (request.params.name !== 'safe-edit-loop') throw new ToolError('NOT_FOUND', `Unknown prompt: ${request.params.name}`);
    const target = request.params.arguments?.path ?? '<path>';
    return { description: 'Optimistic-concurrency safe file editing workflow.', messages: [{ role: 'user', content: { type: 'text', text: `Use read_file on ${target}, retain sha256, call edit_file with expected_sha256 and edits[], then read_file again to verify.` } }] };
  });
  server.setRequestHandler('resources/list', async () => ({ resources: [{ uri: 'workspace://status', name: 'Workspace status', description: 'Current bridge workspace and governance status', mimeType: 'application/json' }] }));
  server.setRequestHandler('resources/read', async (request) => {
    if (request.params.uri !== 'workspace://status') throw new ToolError('NOT_FOUND', `Unknown resource: ${request.params.uri}`);
    return { contents: [{ uri: 'workspace://status', mimeType: 'application/json', text: JSON.stringify({ root: options.root, accessMode: options.dangerouslyOpenMachine ? 'UNRESTRICTED_MACHINE' : 'WORKSPACE_ONLY', policy: policy.name, dryRun: options.dryRun }) }] };
  });
  server.setRequestHandler('resources/subscribe', async () => ({}));
  server.setRequestHandler('resources/unsubscribe', async () => ({}));
  server.setRequestHandler('completion/complete', async (request) => {
    const prefix = request.params.argument.value.replace(/\\/g, '/');
    const parent = path.dirname(prefix) === '.' ? '.' : path.dirname(prefix);
    const base = path.basename(prefix).toLowerCase();
    const directory = path.resolve(options.root, parent);
    const relative = path.relative(options.root, directory);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { completion: { values: [], total: 0, hasMore: false } };
    const values = await readdir(directory, { withFileTypes: true }).then((entries) => entries.filter((entry) => entry.name.toLowerCase().startsWith(base) && !entry.name.startsWith('.')).slice(0, 100).map((entry) => `${parent === '.' ? '' : `${parent}/`}${entry.name}${entry.isDirectory() ? '/' : ''}`.replace(/\\/g, '/'))).catch(() => []);
    return { completion: { values, total: values.length, hasMore: false } };
  });

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const name = request.params.name;
    const resolved = gateway.resolve(name);
    const spec = resolved?.spec;
    if (!spec) {
      return textResult({
        ok: false,
        tool: name,
        error: {
          code: 'UNKNOWN_TOOL',
          message: `Unknown tool: ${name}`,
          details: { available: specs.map((entry) => entry.name) },
        },
      }, true);
    }
    const suppliedArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
    const key = suppliedArgs.idempotency_key;
    if (key !== undefined && (typeof key !== 'string' || key.length < 8 || key.length > 128)) return errorResult(name, new ToolError('INVALID_ARGUMENT', 'idempotency_key must be a string between 8 and 128 characters.'));
    const args = Object.fromEntries(Object.entries(suppliedArgs).filter(([arg]) => arg !== 'idempotency_key'));
    const progressToken = request.params._meta?.progressToken;
    if (progressToken !== undefined) await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: 0, total: 1, message: `Starting ${name}` } });
    return withToolSpan(name, {
      'mcp.tool.name': name,
      'mcp.tool.read_only': spec.annotations.readOnlyHint,
      'mcp.tool.open_world': spec.annotations.openWorldHint,
      'mcp.policy.name': policy.name,
    }, async (traceId) => {
      const startedAt = Date.now();
      if (options.dryRun && !spec.annotations.readOnlyHint) {
        const response = successResult({ dryRun: true, tool: name, wouldExecute: true, message: 'Server dry-run mode prevented this mutation.' });
        await audit.write({ traceId, tool: name, policy: policy.name, decision: 'allowed', status: 'success', durationMs: Date.now() - startedAt, args });
        if (progressToken !== undefined) await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: 1, total: 1, message: `Completed ${name}` } });
        return response;
      }
      const decision = evaluatePolicy(policy, spec, args, options.root);
      if (!decision.allowed) {
        const error = new ToolError('POLICY_DENIED', decision.reason ?? `Tool ${name} was denied by policy.`);
        await audit.write({ traceId, tool: name, policy: policy.name, decision: 'denied', status: 'error', durationMs: Date.now() - startedAt, args, errorCode: error.code });
        return errorResult(name, error);
      }

      if (decision.requiresApproval) {
        if (options.approvalMode === 'deny') {
          const error = new ToolError('APPROVAL_REQUIRED', `Tool ${name} requires approval under policy ${policy.name}.`, 'Restart with --approval-mode mrtr to request approval interactively.');
          await audit.write({ traceId, tool: name, policy: policy.name, decision: 'approval_required', status: 'error', durationMs: Date.now() - startedAt, args, errorCode: error.code });
          return errorResult(name, error);
        }

        const view = inputResponse(ctx.mcpReq.inputResponses, 'approval');
        if (view.kind === 'elicit' && view.action !== 'accept') {
          const error = new ToolError('APPROVAL_REQUIRED', `Approval for ${name} was ${view.action}d.`);
          await audit.write({ traceId, tool: name, policy: policy.name, decision: 'approval_required', status: 'error', durationMs: Date.now() - startedAt, args, errorCode: error.code });
          return errorResult(name, error);
        }
        const approval = acceptedContent<{ approve?: boolean }>(ctx.mcpReq.inputResponses, 'approval');
        if (!approval) {
          await audit.write({ traceId, tool: name, policy: policy.name, decision: 'approval_required', status: 'input_required', durationMs: Date.now() - startedAt, args });
          return inputRequired({
            requestState: await approvalState.mint(createApprovalRequestState(name, args)),
            inputRequests: {
              approval: inputRequired.elicit({
                message: `Approve machine tool "${name}" under policy "${policy.name}"?`,
                requestedSchema: {
                  type: 'object',
                  properties: { approve: { type: 'boolean', title: 'Approve' } },
                  required: ['approve'],
                },
              }),
            },
          });
        }
        const verifiedState = ctx.mcpReq.requestState<ApprovalRequestState>();
        if (!matchesApprovalRequestState(verifiedState, name, args)) {
          const error = new ToolError('APPROVAL_REQUIRED', `Approval state for ${name} is missing, expired, or does not match this tool call.`);
          await audit.write({ traceId, tool: name, policy: policy.name, decision: 'approval_required', status: 'error', durationMs: Date.now() - startedAt, args, errorCode: error.code });
          return errorResult(name, error);
        }
        if (approval.approve !== true) {
          const error = new ToolError('APPROVAL_REQUIRED', `Approval for ${name} was denied.`);
          await audit.write({ traceId, tool: name, policy: policy.name, decision: 'approval_required', status: 'error', durationMs: Date.now() - startedAt, args, errorCode: error.code });
          return errorResult(name, error);
        }
      }

      const execute = async () => {
      try {
        const result = await spec.handler(args);
        const failed = name === 'shell_command'
          && (result as { promotedToBackground?: boolean }).promotedToBackground !== true
          && ((result as { success?: boolean }).success === false
            || (result as { expectationMet?: boolean }).expectationMet === false
            || (result as { exitCode?: number | null }).exitCode !== 0
            || (result as { timedOut?: boolean }).timedOut === true);
        await audit.write({
          traceId,
          tool: name,
          policy: policy.name,
          decision: decision.requiresApproval ? 'approval_required' : 'allowed',
          status: failed ? 'error' : 'success',
          durationMs: Date.now() - startedAt,
          args,
          errorCode: failed ? 'COMMAND_FAILED' : undefined,
        });
        const response = failed ? textResult({ ok: false, ...(result as Record<string, unknown>) }, true) : successResult(result);
        if (!failed && !spec.annotations.readOnlyHint) await ctx.mcpReq.notify({ method: 'notifications/resources/updated', params: { uri: 'workspace://status' } });
        if (progressToken !== undefined) await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: 1, total: 1, message: `${failed ? 'Failed' : 'Completed'} ${name}` } });
        return response;
      } catch (error: unknown) {
        const described = describeError(error);
        await audit.write({ traceId, tool: name, policy: policy.name, decision: decision.requiresApproval ? 'approval_required' : 'allowed', status: 'error', durationMs: Date.now() - startedAt, args, errorCode: described.code });
        const response = errorResult(name, error);
        return response;
      }
      };
      try {
        return typeof key === 'string' ? await idempotency.run(key, name, args, execute) : await execute();
      } catch (error) { return errorResult(name, error); }
    });
  });

  return server;
}

function addCorsHeaders(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', [
    'authorization',
    'content-type',
    'mcp-method',
    'mcp-name',
    'mcp-protocol-version',
    'traceparent',
    'tracestate',
    'baggage',
    'last-event-id',
  ].join(', '));
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-expose-headers', 'mcp-protocol-version, last-event-id');
}

function hasValidBearerToken(req: IncomingMessage, expectedToken?: string): boolean {
  if (!expectedToken) return true;
  const value = req.headers.authorization;
  if (!value?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(value.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const AUDIT_UI = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>ChatGPT Machine MCP</title><style>body{font:14px ui-monospace,monospace;background:#101319;color:#dbe4f0;margin:2rem}h1{font:600 22px system-ui}table{width:100%;border-collapse:collapse}td,th{padding:.55rem;border-bottom:1px solid #293241;text-align:left}.success{color:#71d99e}.error{color:#ff7b86}</style></head><body><h1>ChatGPT Machine MCP Â· recent calls</h1><table><thead><tr><th>Time</th><th>Tool</th><th>Decision</th><th>Status</th><th>Duration</th></tr></thead><tbody id="rows"></tbody></table><script>fetch('/ui/audit').then(r=>r.json()).then(({records})=>{rows.innerHTML=records.reverse().map(x=>'<tr><td>'+x.timestamp+'</td><td>'+x.tool+'</td><td>'+x.decision+'</td><td class="'+x.status+'">'+x.status+'</td><td>'+x.durationMs+' ms</td></tr>').join('')}).catch(e=>rows.innerHTML='<tr><td colspan=5>'+e+'</td></tr>')</script></body></html>`;

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const policy = loadPolicy(options.policy, options.root);
  const audit = new AuditLogger(options.auditFile ?? defaultAuditPath(options.root));
  const approvalState = createRequestStateCodec<ApprovalRequestState>({
    key: randomBytes(32),
    ttlSeconds: 5 * 60,
  });
  const runtime = await buildRuntime(options, policy, audit, approvalState);
  if (options.doctor) {
    const specs = runtime.gateway.listTools();
    const contract = createContractManifest([...specs]);
    const commands = process.platform === 'win32'
      ? [{ command: 'git', args: ['--version'] }, { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'] }]
      : [{ command: 'git', args: ['--version'] }, { command: 'bash', args: ['--version'] }];
    const checks = await Promise.all(commands.map(async ({ command, args }) => ({
      command,
      available: await new Promise<boolean>((resolve) => {
        const probe = spawn(command, args, { stdio: 'ignore', windowsHide: true });
        probe.once('error', () => resolve(false));
        probe.once('close', (code) => resolve(code === 0));
      }),
    })));
    const workspace = {
      readable: await access(options.root, fsConstants.R_OK).then(() => true, () => false),
      writable: await access(options.root, fsConstants.W_OK).then(() => true, () => false),
    };
    process.stdout.write(JSON.stringify({
      ok: checks.every((check) => check.available) && workspace.readable && workspace.writable,
      version: APP_VERSION,
      platform: process.platform,
      root: options.root,
      workspace,
      supervised: process.env.MCP_SUPERVISED === '1',
      checks,
      tools: specs.length,
      toolSurface: options.toolSurface,
      providers: runtime.providerIds,
      capabilityCount: runtime.capabilities.length,
      contractVersion: CONTRACT_VERSION,
      contractFingerprint: contract.fingerprint,
      policy: policy.name,
      policyFingerprint: policyFingerprint(policy),
      hint: 'Install missing dependencies or fix workspace permissions, then rerun --doctor.',
    }, null, 2) + '\n');
    await Promise.all(runtime.closeProviders.map((close) => close()));
    return;
  }
  if (options.check) {
    const specs = runtime.gateway.listTools();
    const contract = createContractManifest([...specs]);
    const build = loadBuildInfo();
    process.stdout.write(JSON.stringify({
      ok: true,
      version: APP_VERSION,
      build: { ...build, head: headCommit() },
      contractVersion: CONTRACT_VERSION,
      contractFingerprint: contract.fingerprint,
      root: options.root,
      accessMode: options.dangerouslyOpenMachine ? 'UNRESTRICTED_MACHINE' : 'WORKSPACE_ONLY',
      transport: options.http ? 'streamable-http' : 'stdio',
      endpoint: options.http ? `http://${options.httpHost}:${options.httpPort}/mcp` : undefined,
      policy: policy.name,
      approvalMode: options.approvalMode,
      auditFile: audit.filePath,
      dryRun: options.dryRun,
      toolSurface: options.toolSurface,
      providers: runtime.providerIds,
      capabilityCount: runtime.capabilities.length,
      tools: specs.map((spec) => spec.name),
    }, null, 2) + '\n');
    await Promise.all(runtime.closeProviders.map((close) => close()));
    return;
  }

  let closeMcp: (() => Promise<void>) | undefined;
  let closeHttpServer: (() => Promise<void>) | undefined;
  let httpReady = false;

  if (options.http) {
    const handler = createMcpHandler(() => createMcpServer(runtime), {
      legacy: 'stateless',
      // Start as JSON for ordinary calls and upgrade to SSE only when a tool
      // emits progress/logging notifications before its terminal result.
      responseMode: 'auto',
      onerror: (error) => console.error('[chatgpt-machine-mcp] MCP error:', error.message),
    });
    const handleMcpRequest = toNodeHandler(handler, {
      onerror: (error) => console.error('[chatgpt-machine-mcp] HTTP adapter error:', error.message),
    });
    const httpServer = createServer(async (req, res) => {
      addCorsHeaders(res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if ((pathname === '/healthz' || pathname === '/readyz') && req.method === 'GET') {
        const ready = pathname === '/healthz' ? true : httpReady;
        res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: ready,
          service: 'chatgpt-machine-mcp',
          version: APP_VERSION,
          contractVersion: CONTRACT_VERSION,
          status: pathname === '/healthz' ? 'alive' : (ready ? 'ready' : 'starting'),
          accessMode: options.dangerouslyOpenMachine ? 'UNRESTRICTED_MACHINE' : 'WORKSPACE_ONLY',
          endpoint: '/mcp',
        }));
        return;
      }
      if ((pathname === '/ui' || pathname === '/ui/audit') && !hasValidBearerToken(req, options.httpToken)) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
      }
      if (pathname === '/ui' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(AUDIT_UI); return; }
      if (pathname === '/ui/audit' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ records: await audit.recent(50) })); return; }
      if (pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      if (!hasValidBearerToken(req, options.httpToken)) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      try {
        const carrier = Object.fromEntries(
          Object.entries(req.headers).flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : []),
        );
        const extracted = propagation.extract(otelContext.active(), carrier);
        await otelContext.with(extracted, () => handleMcpRequest(req, res));
      } catch (error: unknown) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(options.httpPort, options.httpHost, resolve);
    });
    httpReady = true;
    console.error(`[chatgpt-machine-mcp] listening at http://${options.httpHost}:${options.httpPort}/mcp`);
    console.error(`[chatgpt-machine-mcp] access mode: ${options.dangerouslyOpenMachine ? 'UNRESTRICTED_MACHINE' : 'WORKSPACE_ONLY'}`);
    console.error(`[chatgpt-machine-mcp] policy: ${policy.name} (approval=${options.approvalMode})`);
    closeMcp = () => handler.close();
    closeHttpServer = () => new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
  } else {
    const handle = serveStdio(() => createMcpServer(runtime), {
      legacy: 'serve',
      onerror: (error) => console.error('[chatgpt-machine-mcp] stdio MCP error:', error.message),
    });
    closeMcp = () => handle.close();
  }

  const cleanup = async () => {
    httpReady = false;
    await closeMcp?.();
    await closeHttpServer?.();
    await Promise.all(runtime.closeProviders.map((close) => close()));
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}




