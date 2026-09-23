import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type SupervisorHealth = 'healthy' | 'degraded' | 'restarting' | 'stopped';
export type SupervisorCircuit = 'closed' | 'open' | 'half_open';

export function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      if (result.error) throw result.error;
      return;
    } catch {
      try { process.kill(pid); } catch { /* already gone */ }
      return;
    }
  }
  try {
    // supervisor children are spawned detached on POSIX, making their PID the
    // process-group id. Killing -pid therefore terminates the whole worker tree.
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  timer: NodeJS.Timeout;
  method: string;
  line: string;
  message: JsonRpcMessage;
  deadlineAt: number;
}

interface ReplayRequest {
  line: string;
  message: JsonRpcMessage;
  deadlineAt: number;
}

export interface SupervisorOptions {
  childEntry: string;
  childArgs: string[];
  requestTimeoutMs: number;
  restartDelayMs: number;
  stateFile?: string;
  circuitWindowMs?: number;
  circuitThreshold?: number;
  circuitCooldownMs?: number;
  recoveryStableMs?: number;
  readinessTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  stdio?: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    error: NodeJS.WritableStream;
  };
}

const REINIT_ID = '__chatgpt_machine_supervisor_reinitialize__';
const HEARTBEAT_ID = '__chatgpt_machine_supervisor_execute_probe__';
const TOOL_CATALOG_ID = '__chatgpt_machine_supervisor_tool_catalog__';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const RESTART_DELAY_MS = 250;
const CIRCUIT_WINDOW_MS = 30_000;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 30_000;
const RECOVERY_STABLE_MS = 15_000;

function parseMessage(line: string): JsonRpcMessage | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRpcMessage : undefined;
  } catch {
    return undefined;
  }
}

function responseFor(id: JsonRpcMessage['id'], message: string, data?: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32001, message, ...(data ? { data } : {}) },
  }) + '\n';
}

function readOnlyToolNames(result: unknown): string[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const tool = entry as { name?: unknown; annotations?: { readOnlyHint?: unknown } };
    return typeof tool.name === 'string' && tool.annotations?.readOnlyHint === true ? [tool.name] : [];
  });
}

function requestDeadline(message: JsonRpcMessage, fallbackMs: number): number {
  if (message.method !== 'tools/call') return Math.min(fallbackMs, 30_000);
  const params = message.params as { arguments?: Record<string, unknown> } | undefined;
  const toolTimeout = params?.arguments?.timeout_ms;
  if (typeof toolTimeout === 'number' && Number.isFinite(toolTimeout) && toolTimeout > 0) {
    return Math.max(5_000, Math.min(11 * 60_000, toolTimeout + 15_000));
  }
  return fallbackMs;
}

export class McpSupervisor {
  private child?: ChildProcessWithoutNullStreams;
  private childGeneration = 0;
  private stopping = false;
  private restarting = false;
  private health: SupervisorHealth = 'healthy';
  private circuit: SupervisorCircuit = 'closed';
  private circuitRetryAt?: number;
  private failureTimestamps: number[] = [];
  private recoveryTimer?: NodeJS.Timeout;
  private readinessTimer?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatDeadline?: NodeJS.Timeout;
  private pending = new Map<string | number | null, PendingRequest>();
  private queuedLines: string[] = [];
  private replayQueue: ReplayRequest[] = [];
  private readOnlyTools = new Set<string>();
  private catalogRefreshTimer?: NodeJS.Timeout;
  private catalogRefreshing = false;
  private initializeMessage?: JsonRpcMessage;
  private initializedNotification?: JsonRpcMessage;
  private reinitializing = false;
  private restarts = 0;
  private lastRestartReason?: string;
  private readonly startedAt = new Date().toISOString();
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly error: NodeJS.WritableStream;

  constructor(private readonly options: SupervisorOptions) {
    this.input = options.stdio?.input ?? process.stdin;
    this.output = options.stdio?.output ?? process.stdout;
    this.error = options.stdio?.error ?? process.stderr;
  }

  start(): void {
    this.spawnChild();
    const inputLines = createInterface({ input: this.input, crlfDelay: Infinity });
    inputLines.on('line', (line) => this.onParentLine(line));
    inputLines.on('close', () => this.stop());
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.readinessTimer) clearTimeout(this.readinessTimer);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
    if (this.catalogRefreshTimer) clearTimeout(this.catalogRefreshTimer);
    for (const item of this.pending.values()) clearTimeout(item.timer);
    this.pending.clear();
    this.replayQueue = [];
    this.health = 'stopped';
    const pid = this.child?.pid;
    this.child = undefined;
    killProcessTree(pid);
    this.writeState(false, 'stopped');
  }

  private workerRoot(): string | undefined {
    const index = this.options.childArgs.indexOf('--root');
    const value = index >= 0 ? this.options.childArgs[index + 1] : undefined;
    return value ? path.resolve(value) : undefined;
  }

  private writeState(ready: boolean, healthOverride?: SupervisorHealth): void {
    if (!this.options.stateFile) return;
    const destination = this.options.stateFile;
    const temporary = `${destination}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    mkdirSync(path.dirname(destination), { recursive: true });
    const health = healthOverride ?? this.health;
    writeFileSync(temporary, JSON.stringify({
      version: 2,
      supervisorPid: process.pid,
      workerPid: this.child?.pid ?? null,
      workerGeneration: this.childGeneration,
      workerRoot: this.workerRoot() ?? null,
      ready,
      health,
      circuit: this.circuit,
      circuitRetryAt: this.circuitRetryAt ? new Date(this.circuitRetryAt).toISOString() : null,
      restarts: this.restarts,
      lastRestartReason: this.lastRestartReason ?? null,
      replayQueued: this.replayQueue.length,
      catalogRefreshing: this.catalogRefreshing,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8');
    try {
      renameSync(temporary, destination);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EEXIST')) {
        // Windows can transiently reject replacing an existing state file. The
        // temp file is unique, so a bounded remove+rename fallback is safe here.
        rmSync(destination, { force: true });
        renameSync(temporary, destination);
      } else {
        rmSync(temporary, { force: true });
        throw error;
      }
    }
  }

  private spawnChild(): void {
    if (this.stopping || this.circuit === 'open') return;
    const generation = ++this.childGeneration;
    const child = spawn(process.execPath, [this.options.childEntry, ...this.options.childArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        MCP_SUPERVISED: '1',
        MCP_WORKER_GENERATION: String(generation),
        ...(this.options.stateFile ? { MCP_SUPERVISOR_STATE_FILE: this.options.stateFile } : {}),
      },
    });
    this.child = child;
    const isFirstReady = !this.reinitializing && generation === 1;
    this.writeState(isFirstReady, isFirstReady ? 'healthy' : this.health);
    this.error.write(`[chatgpt-machine-supervisor] worker started generation=${generation} pid=${child.pid ?? 'unknown'}\n`);

    const stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdoutLines.on('line', (line) => this.onChildLine(line, generation));
    child.stderr.on('data', (chunk) => this.error.write(chunk));
    child.once('error', (error) => this.handleWorkerFailure(`worker error: ${error.message}`, generation));
    child.once('exit', (code, signal) => {
      if (!this.stopping && this.childGeneration === generation) {
        this.handleWorkerFailure(`worker exited code=${code ?? 'null'} signal=${signal ?? 'null'}`, generation);
      }
    });

    if (this.initializeMessage && generation > 1) {
      this.reinitializing = true;
      const replay = { ...this.initializeMessage, id: REINIT_ID };
      child.stdin.write(JSON.stringify(replay) + '\n');
      const readinessTimeoutMs = this.options.readinessTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      this.readinessTimer = setTimeout(() => {
        if (generation !== this.childGeneration || !this.reinitializing || this.stopping) return;
        this.readinessTimer = undefined;
        this.handleWorkerFailure(`worker readiness timeout generation=${generation}`, generation);
      }, readinessTimeoutMs).unref();
    }
  }

  private onParentLine(line: string): void {
    const message = parseMessage(line);
    if (!message) {
      this.error.write('[chatgpt-machine-supervisor] ignored malformed parent JSON line\n');
      return;
    }
    if (message.method === 'initialize' && message.id !== undefined) this.initializeMessage = message;
    if (message.method === 'notifications/initialized') this.initializedNotification = message;

    if (this.circuit === 'open') {
      if (message.id !== undefined && message.method) {
        this.output.write(responseFor(message.id, 'MCP worker circuit is open after repeated failures.', {
          reason: 'circuit_open',
          health: this.health,
          retryAfterMs: Math.max(0, (this.circuitRetryAt ?? Date.now()) - Date.now()),
          recoverable: true,
        }));
      }
      return;
    }

    if (this.reinitializing || !this.child || this.child.killed) {
      this.queuedLines.push(line);
      return;
    }
    this.forwardToChild(line, message);
  }

  private isReplayable(message: JsonRpcMessage): boolean {
    if (!message.method) return false;
    if (message.method === 'tools/call') {
      const name = (message.params as { name?: unknown } | undefined)?.name;
      return typeof name === 'string' && this.readOnlyTools.has(name);
    }
    return [
      'tools/list',
      'resources/list',
      'resources/read',
      'prompts/list',
      'prompts/get',
      'completion/complete',
    ].includes(message.method);
  }

  private forwardToChild(line: string, message: JsonRpcMessage, preservedDeadlineAt?: number): void {
    if (!this.child || this.child.killed) {
      this.queuedLines.push(line);
      return;
    }
    if (message.id !== undefined && message.method) {
      const timeoutMs = preservedDeadlineAt === undefined
        ? requestDeadline(message, this.options.requestTimeoutMs)
        : Math.max(0, preservedDeadlineAt - Date.now());
      if (timeoutMs <= 0) {
        this.output.write(responseFor(message.id, `MCP request deadline expired while reconnecting: ${message.method}.`, {
          reason: 'replay_deadline_expired',
          workerGeneration: this.childGeneration,
          recoverable: true,
        }));
        return;
      }
      const deadlineAt = preservedDeadlineAt ?? Date.now() + timeoutMs;
      const timer = setTimeout(() => this.onRequestTimeout(message.id!, message.method!, timeoutMs), timeoutMs);
      this.pending.set(message.id, { timer, method: message.method, line, message, deadlineAt });
    }
    this.child.stdin.write(line + '\n');
  }

  private preservePendingForRestart(): void {
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      if (this.isReplayable(item.message)) {
        this.replayQueue.push({ line: item.line, message: item.message, deadlineAt: item.deadlineAt });
        continue;
      }
      this.output.write(responseFor(id, 'MCP worker restarted before the request completed.', {
        reason: 'worker_restarted',
        workerGeneration: this.childGeneration,
        health: this.health,
        recoverable: true,
        replaySafe: false,
        hint: 'Mutation requests are never replayed automatically. Resume through durable Goal/Flow state or retry with the same idempotency key after reconciliation.',
      }));
    }
    this.pending.clear();
  }

  private rejectReplayQueue(reason: string, message: string): void {
    for (const item of this.replayQueue.splice(0)) {
      if (item.message.id === undefined) continue;
      this.output.write(responseFor(item.message.id, message, {
        reason,
        workerGeneration: this.childGeneration,
        health: this.health,
        recoverable: true,
      }));
    }
  }

  private refreshToolCatalog(generation: number): void {
    if (!this.child || this.child.killed || generation !== this.childGeneration) return;
    this.catalogRefreshing = true;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: TOOL_CATALOG_ID, method: 'tools/list', params: {} }) + '\n');
    const timeoutMs = Math.min(this.options.readinessTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 5_000);
    this.catalogRefreshTimer = setTimeout(() => {
      this.catalogRefreshTimer = undefined;
      if (generation !== this.childGeneration || this.stopping || !this.catalogRefreshing) return;
      this.catalogRefreshing = false;
      this.readOnlyTools.clear();
      this.error.write(`[chatgpt-machine-supervisor] tool catalog refresh timed out generation=${generation}; replaying only protocol-level read requests\n`);
      this.finishWorkerReady(generation);
    }, timeoutMs).unref();
  }

  private markWorkerReady(generation: number): void {
    if (generation !== this.childGeneration || !this.child || this.child.killed) return;
    if (this.replayQueue.some((item) => item.message.method === 'tools/call')) {
      this.refreshToolCatalog(generation);
      return;
    }
    this.finishWorkerReady(generation);
  }

  private finishWorkerReady(generation: number): void {
    if (generation !== this.childGeneration || !this.child || this.child.killed) return;
    if (this.readinessTimer) {
      clearTimeout(this.readinessTimer);
      this.readinessTimer = undefined;
    }
    if (this.catalogRefreshTimer) {
      clearTimeout(this.catalogRefreshTimer);
      this.catalogRefreshTimer = undefined;
    }
    this.catalogRefreshing = false;
    this.reinitializing = false;
    this.restarting = false;
    const probing = this.circuit === 'half_open';
    this.health = probing ? 'degraded' : 'healthy';
    this.writeState(true, this.health);

    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    const stableMs = this.options.recoveryStableMs ?? RECOVERY_STABLE_MS;
    this.recoveryTimer = setTimeout(() => {
      if (
        this.stopping ||
        this.restarting ||
        this.reinitializing ||
        generation !== this.childGeneration ||
        !this.child ||
        this.child.killed
      ) return;
      this.failureTimestamps = [];
      this.circuit = 'closed';
      this.circuitRetryAt = undefined;
      this.health = 'healthy';
      this.writeState(true, 'healthy');
      this.error.write(`[chatgpt-machine-supervisor] worker stable generation=${generation}; circuit=closed\n`);
    }, stableMs).unref();

    const replay = this.replayQueue.splice(0);
    for (const item of replay) {
      if (!this.isReplayable(item.message)) {
        if (item.message.id !== undefined) {
          this.output.write(responseFor(item.message.id, 'Request was read-only before restart but is not confirmed read-only on the replacement worker.', {
            reason: 'read_only_contract_changed',
            workerGeneration: this.childGeneration,
            recoverable: true,
            replaySafe: false,
          }));
        }
        continue;
      }
      this.forwardToChild(item.line, item.message, item.deadlineAt);
    }

    const queued = this.queuedLines.splice(0);
    for (const queuedLine of queued) {
      const queuedMessage = parseMessage(queuedLine);
      if (queuedMessage) this.forwardToChild(queuedLine, queuedMessage);
    }
    this.scheduleHeartbeat(generation);
    this.error.write(`[chatgpt-machine-supervisor] worker ready generation=${generation} (health=${this.health}, circuit=${this.circuit}, replayed=${replay.length})\n`);
  }

  private scheduleHeartbeat(generation: number): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    const intervalMs = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimer = setTimeout(() => this.runHeartbeat(generation), intervalMs).unref();
  }

  private runHeartbeat(generation: number): void {
    this.heartbeatTimer = undefined;
    if (this.stopping || this.restarting || this.reinitializing || generation !== this.childGeneration || !this.child || this.child.killed) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: HEARTBEAT_ID, method: 'tools/call', params: { name: 'runtime_info', arguments: {} } }) + '\n');
    const timeoutMs = this.options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.heartbeatDeadline = setTimeout(() => {
      this.heartbeatDeadline = undefined;
      if (generation !== this.childGeneration || this.stopping) return;
      this.restartWorker(`execute probe timeout generation=${generation}`);
    }, timeoutMs).unref();
  }

  private onChildLine(line: string, generation: number): void {
    if (generation !== this.childGeneration) return;
    const message = parseMessage(line);
    if (!message) {
      this.error.write('[chatgpt-machine-supervisor] worker emitted malformed JSON line\n');
      return;
    }

    if (message.id === TOOL_CATALOG_ID && (message.result !== undefined || message.error !== undefined)) {
      if (this.catalogRefreshTimer) {
        clearTimeout(this.catalogRefreshTimer);
        this.catalogRefreshTimer = undefined;
      }
      this.catalogRefreshing = false;
      if (message.error === undefined) this.readOnlyTools = new Set(readOnlyToolNames(message.result));
      else this.readOnlyTools.clear();
      this.finishWorkerReady(generation);
      return;
    }

    if (message.id === HEARTBEAT_ID && (message.result !== undefined || message.error !== undefined)) {
      if (this.heartbeatDeadline) {
        clearTimeout(this.heartbeatDeadline);
        this.heartbeatDeadline = undefined;
      }
      if (message.error !== undefined) {
        this.restartWorker(`execute probe failed generation=${generation}`);
        return;
      }
      this.scheduleHeartbeat(generation);
      return;
    }

    if (message.id === REINIT_ID && (message.result !== undefined || message.error !== undefined)) {
      if (message.error !== undefined) {
        this.handleWorkerFailure('worker reinitialization failed', generation);
        return;
      }
      if (this.initializedNotification && this.child && !this.child.killed) {
        this.child.stdin.write(JSON.stringify(this.initializedNotification) + '\n');
      }
      this.markWorkerReady(generation);
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const item = this.pending.get(message.id);
      if (item) {
        clearTimeout(item.timer);
        this.pending.delete(message.id);
        if (item.method === 'tools/list' && message.error === undefined) {
          this.readOnlyTools = new Set(readOnlyToolNames(message.result));
        }
      }
      if (generation === 1 && this.initializeMessage?.id === message.id && message.error === undefined) {
        this.markWorkerReady(generation);
      }
    }
    this.output.write(line + '\n');
  }

  private onRequestTimeout(id: string | number | null, method: string, timeoutMs: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.output.write(responseFor(id, `MCP worker did not answer ${method} within ${timeoutMs} ms.`, {
      reason: 'worker_timeout',
      workerGeneration: this.childGeneration,
      recoverable: true,
      workerContinues: true,
    }));
    // A request deadline is not proof that the worker is unhealthy. Long Git,
    // build, and deploy operations may still be running in an awaited child
    // process. Keep the worker alive so the next request does not race a
    // reinitialization; managed process tools provide the polling path.
    this.error.write(`[chatgpt-machine-supervisor] request timeout method=${method}; worker retained\n`);
  }

  private handleWorkerFailure(reason: string, generation: number): void {
    if (this.stopping || generation !== this.childGeneration) return;
    this.restartWorker(reason);
  }

  private rejectPending(reason: 'worker_restarted' | 'circuit_open', message: string): void {
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      this.output.write(responseFor(id, message, {
        reason,
        workerGeneration: this.childGeneration,
        health: this.health,
        recoverable: true,
      }));
    }
    this.pending.clear();
    this.rejectReplayQueue(reason, message);
  }

  private killCurrentWorker(): void {
    const pid = this.child?.pid;
    this.child = undefined;
    killProcessTree(pid);
  }

  private openCircuit(reason: string): void {
    const cooldownMs = this.options.circuitCooldownMs ?? CIRCUIT_COOLDOWN_MS;
    this.circuit = 'open';
    this.health = 'degraded';
    this.circuitRetryAt = Date.now() + cooldownMs;
    this.killCurrentWorker();
    this.rejectPending('circuit_open', 'MCP worker circuit opened after repeated failures.');
    this.writeState(false, 'degraded');
    this.error.write(`[chatgpt-machine-supervisor] circuit opened cooldown=${cooldownMs}ms: ${reason}\n`);

    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopping) return;
      this.circuit = 'half_open';
      this.circuitRetryAt = undefined;
      this.health = 'restarting';
      this.restarting = false;
      this.reinitializing = Boolean(this.initializeMessage);
      this.writeState(false, 'restarting');
      this.error.write('[chatgpt-machine-supervisor] circuit half-open probe starting\n');
      this.spawnChild();
    }, cooldownMs).unref();
  }

  private restartWorker(reason: string): void {
    if (this.stopping || this.restarting || this.circuit === 'open') return;
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    if (this.readinessTimer) {
      clearTimeout(this.readinessTimer);
      this.readinessTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.heartbeatDeadline) {
      clearTimeout(this.heartbeatDeadline);
      this.heartbeatDeadline = undefined;
    }
    if (this.catalogRefreshTimer) {
      clearTimeout(this.catalogRefreshTimer);
      this.catalogRefreshTimer = undefined;
    }
    this.catalogRefreshing = false;
    this.restarting = true;
    this.reinitializing = Boolean(this.initializeMessage);
    this.restarts++;
    this.lastRestartReason = reason;

    const now = Date.now();
    const windowMs = this.options.circuitWindowMs ?? CIRCUIT_WINDOW_MS;
    const threshold = this.options.circuitThreshold ?? CIRCUIT_THRESHOLD;
    this.failureTimestamps = this.failureTimestamps.filter((t) => now - t < windowMs);
    this.failureTimestamps.push(now);

    if (this.circuit === 'half_open' || this.failureTimestamps.length >= threshold) {
      this.openCircuit(reason);
      return;
    }

    this.health = 'restarting';
    this.preservePendingForRestart();
    this.killCurrentWorker();
    this.writeState(false, 'restarting');
    this.error.write(`[chatgpt-machine-supervisor] restarting worker delay=${this.options.restartDelayMs}ms: ${reason}\n`);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopping) return;
      this.restarting = false;
      this.spawnChild();
    }, this.options.restartDelayMs).unref();
  }
}

export function parseSupervisorArgs(args: string[]): { requestTimeoutMs: number; childArgs: string[] } {
  let requestTimeoutMs = Number(process.env.MCP_SUPERVISOR_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const childArgs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--supervisor-timeout') {
      const raw = args[++index];
      if (!raw) throw new Error('--supervisor-timeout requires a value.');
      requestTimeoutMs = Number(raw);
    } else {
      childArgs.push(args[index]);
    }
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 5_000 || requestTimeoutMs > 11 * 60_000) {
    throw new Error('--supervisor-timeout must be an integer between 5000 and 660000 milliseconds.');
  }
  return { requestTimeoutMs, childArgs };
}

export function main(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { requestTimeoutMs, childArgs } = parseSupervisorArgs(process.argv.slice(2));
  const childEntry = process.env.MCP_SUPERVISOR_CHILD_ENTRY ?? path.join(here, 'index.js');
  const pilotSupervisor = path.join(here, '..', '.pilot', 'supervisor.json');
  const legacySupervisor = path.join(here, '..', '.chatgpt-machine', 'supervisor.json');
  const defaultState = existsSync(pilotSupervisor) || !existsSync(legacySupervisor) ? pilotSupervisor : legacySupervisor;
  const stateFile = process.env.MCP_SUPERVISOR_STATE_FILE ?? defaultState;
  const supervisor = new McpSupervisor({ childEntry, childArgs, requestTimeoutMs, restartDelayMs: RESTART_DELAY_MS, stateFile });
  process.once('SIGINT', () => supervisor.stop());
  process.once('SIGTERM', () => supervisor.stop());
  supervisor.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[chatgpt-machine-supervisor] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
