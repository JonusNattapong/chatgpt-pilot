import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { redactCommandForStorage } from './audit.js';
import { ToolError } from './errors.js';
import { resolveMachinePath, type MachineAccess, type ShellKind } from './shell-tools.js';

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const OUTPUT_POLL_INTERVAL_MS = 50;
const MAX_WAIT_MS = 60_000;
const STOP_GRACE_MS = 3_000;
const STOP_TIMEOUT_MS = 8_000;

export interface StartProcessOptions extends MachineAccess {
  command: string;
  workdir?: string;
  shell?: ShellKind;
  env?: Record<string, string>;
}

export interface ExecProcessOptions extends MachineAccess {
  executable: string;
  args?: string[];
  workdir?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  expectExitCode?: number;
}

export interface ProcessPidOptions extends MachineAccess {
  pid: number;
  processId?: string;
}

export interface ReadProcessOutputOptions extends ProcessPidOptions {
  sinceStdout?: number;
  sinceStderr?: number;
  waitMs?: number;
}

export interface WaitProcessOptions extends ProcessPidOptions {
  timeoutMs: number;
  maxTimeoutMs?: number;
  includeOutput?: boolean;
  maxOutputBytes?: number;
  sinceStdout?: number;
  sinceStderr?: number;
}

export interface WriteProcessInputOptions extends ProcessPidOptions {
  input: string;
  end?: boolean;
}

export interface ProcessClassification {
  kind: 'long-running' | 'short-lived' | 'interactive' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
}

interface PersistedProcess {
  pid: number;
  processId?: string;
  osStartTime?: string;
  root: string;
  command: string;
  workdir: string;
  shell: Exclude<ShellKind, 'auto'>;
  stdoutLogPath: string;
  stderrLogPath: string;
  outputTruncated: boolean;
  capturedBytes: number;
  startedAt: number;
  finishedAt?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface ManagedProcess extends Omit<PersistedProcess, 'pid'> {
  child?: ChildProcess;
  persistenceError?: string;
  stdout: string;
  stderr: string;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  stdoutLog?: WriteStream;
  stderrLog?: WriteStream;
  settled?: Promise<void>;
}

const managed = new Map<number, ManagedProcess>();
const loadedRoots = new Set<string>();
let persistQueue: Promise<void> = Promise.resolve();

function selectShell(shell: ShellKind): { kind: Exclude<ShellKind, 'auto'>; executable: string; args: string[] } {
  const selected = shell === 'auto' ? (process.platform === 'win32' ? 'powershell' : 'bash') : shell;
  if (selected === 'powershell') return { kind: selected, executable: process.platform === 'win32' ? 'powershell.exe' : 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] };
  if (selected === 'cmd') {
    if (process.platform !== 'win32') throw new ToolError('INVALID_ARGUMENT', 'The cmd shell is only available on Windows.');
    return { kind: selected, executable: 'cmd.exe', args: ['/d', '/s', '/c'] };
  }
  return { kind: selected, executable: 'bash', args: ['-lc'] };
}

function pilotProcessStateDir(root: string): string {
  const pilotDir = path.join(root, '.pilot');
  const legacyDir = path.join(root, '.chatgpt-machine');
  if (!existsSync(pilotDir) && existsSync(legacyDir)) {
    return legacyDir;
  }
  return pilotDir;
}

function runtimeDirectory(root: string): string {
  return path.join(pilotProcessStateDir(root), 'processes');
}

function registryPath(root: string): string {
  return path.join(pilotProcessStateDir(root), 'processes.json');
}

async function persistRoot(root: string): Promise<void> {
  const entries: PersistedProcess[] = [...managed.entries()]
    .filter(([, info]) => info.root === root)
    .map(([pid, info]) => ({
      pid,
      processId: info.processId,
      osStartTime: info.osStartTime,
      root: info.root,
      command: redactCommandForStorage(info.command),
      workdir: info.workdir,
      shell: info.shell,
      stdoutLogPath: info.stdoutLogPath,
      stderrLogPath: info.stderrLogPath,
      outputTruncated: info.outputTruncated,
      capturedBytes: info.capturedBytes,
      startedAt: info.startedAt,
      finishedAt: info.finishedAt,
      exitCode: info.exitCode,
      signal: info.signal,
    }));
  const destination = registryPath(root);
  const temporary = `${destination}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  persistQueue = persistQueue.then(async () => {
    try {
      // A temporary workspace may legitimately be removed immediately after a
      // process is stopped. Never recreate a deleted root just to persist stale
      // bookkeeping from an already-finished child.
      await fs.access(root);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify({ version: 1, processes: entries }, null, 2), 'utf8');
      await fs.rename(temporary, destination);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }).catch((error) => {
    for (const info of managed.values()) if (info.root === root) info.persistenceError = 'Process registry write failed; restart recovery is not guaranteed.';
    console.error('[chatgpt-machine-mcp] process registry write failed:', error instanceof Error ? error.message : String(error));
  });
  return persistQueue;
}

function closeWriteStream(stream: WriteStream | undefined): Promise<void> {
  if (!stream || stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    stream.once('close', done);
    stream.once('error', done);
    if (!stream.writableEnded) stream.end();
  });
}

async function ensureLoaded(access: MachineAccess): Promise<void> {
  const root = path.resolve(access.root);
  if (loadedRoots.has(root)) return;
  loadedRoots.add(root);
  try {
    const parsed = JSON.parse(await fs.readFile(registryPath(root), 'utf8')) as { processes?: PersistedProcess[] };
    for (const entry of parsed.processes ?? []) {
      if (!Number.isInteger(entry.pid) || entry.pid < 1 || managed.has(entry.pid)) continue;
      managed.set(entry.pid, {
        root,
        processId: entry.processId,
        osStartTime: entry.osStartTime,
        command: entry.command,
        workdir: entry.workdir,
        shell: entry.shell,
        stdoutLogPath: entry.stdoutLogPath,
        stderrLogPath: entry.stderrLogPath,
        outputTruncated: entry.outputTruncated,
        capturedBytes: entry.capturedBytes ?? 0,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
        exitCode: entry.exitCode,
        signal: entry.signal,
        stdout: '',
        stderr: '',
        stdoutDecoder: new StringDecoder('utf8'),
        stderrDecoder: new StringDecoder('utf8'),
      });
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error('[chatgpt-machine-mcp] process registry read failed:', error instanceof Error ? error.message : String(error));
    }
  }
}

function appendOutput(info: ManagedProcess, stream: 'stdout' | 'stderr', chunk: Buffer): void {
  const remaining = Math.max(0, MAX_CAPTURE_BYTES - info.capturedBytes);
  const accepted = chunk.subarray(0, remaining);
  info.capturedBytes += accepted.length;
  if (accepted.length < chunk.length) info.outputTruncated = true;
  if (!accepted.length) return;

  const decoder = stream === 'stdout' ? info.stdoutDecoder : info.stderrDecoder;
  const value = decoder.write(accepted);
  if (stream === 'stdout') {
    info.stdout += value;
    info.stdoutLog?.write(accepted);
  } else {
    info.stderr += value;
    info.stderrLog?.write(accepted);
  }
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

const execIdentity = promisify(execFile);

/** OS identity is independent of PID reuse and of our wall-clock launch timestamp. */
export async function processStartIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid < 1) return undefined;
  try {
    if (process.platform === 'linux') {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const boot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      return `${boot}:${fields[19]}`;
    }
    if (process.platform === 'win32') {
      const result = await execIdentity('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`], { timeout: 3000, maxBuffer: 4096, windowsHide: true });
      const value = result.stdout.trim();
      return /^\d+$/.test(value) ? value : undefined;
    }
    // Coarse ps timestamps cannot safely authorize a recovered destructive operation.
    return undefined;
  } catch { return undefined; }
}

async function assertRecoveredIdentity(pid: number, info: ManagedProcess): Promise<void> {
  if (info.child || info.finishedAt !== undefined) return;
  const actual = await processStartIdentity(pid);
  if (!info.osStartTime || actual !== info.osStartTime) {
    throw new ToolError('PROCESS_IDENTITY_UNVERIFIED', 'Cannot prove that this PID still belongs to the recorded process.',
      'Inspect the host process; no signal was sent.', { pid, processId: info.processId });
  }
}

async function refreshRecovered(pid: number, info: ManagedProcess): Promise<boolean> {
  if (info.child) return info.exitCode === null && info.finishedAt === undefined;
  if (info.finishedAt !== undefined || info.exitCode !== null) return false;
  const alive = await pidAlive(pid);
  if (alive) {
    try {
      await assertRecoveredIdentity(pid, info);
    } catch {
      // PID has been reused by another process since the last session.
      // Treat as finished — do not signal or interact with the foreign process.
      info.finishedAt = Date.now();
      await persistRoot(info.root);
      return false;
    }
  }
  if (!alive) {
    info.finishedAt = Date.now();
    await persistRoot(info.root);
  }
  return alive;
}

async function getManaged(pid: number, access: ProcessPidOptions): Promise<ManagedProcess> {
  if (!Number.isInteger(pid) || pid < 1) throw new ToolError('INVALID_ARGUMENT', '"pid" must be a positive integer.');
  await ensureLoaded(access);
  const info = managed.get(pid);
  if (!info) {
    throw new ToolError(
      'PROCESS_NOT_MANAGED',
      `Process ${pid} is not managed by this MCP runtime.`,
      'Only processes started by start_process and recorded by this runtime can be inspected.',
      { managedPids: [...managed.keys()] },
    );
  }
  if (info.root !== path.resolve(access.root)) throw new ToolError('PROCESS_NOT_MANAGED', 'Process belongs to a different workspace root.');
  if (access.processId !== undefined && info.processId !== access.processId) throw new ToolError('PROCESS_IDENTITY_UNVERIFIED', 'process_id does not match this PID.');
  return info;
}

async function readLog(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return '';
    throw error;
  }
}

function classifyProcess(command: string, running: boolean, exitCode: number | null): ProcessClassification {
  const lower = command.toLowerCase();
  const reasons: string[] = [];
  let kind: ProcessClassification['kind'] = 'unknown';
  let confidence: ProcessClassification['confidence'] = 'low';

  if (!running && exitCode === null) {
    reasons.push('Process is not running and has no recorded exit code.');
  } else if (!running) {
    reasons.push(`Process has exited with code ${exitCode}.`);
  } else {
    reasons.push('Process is currently running.');
  }

  if (/node\s+-e\s+".*setTimeout/.test(lower) || /sleep\s+\d+/.test(lower) || /timeout\s+\/\d+/.test(lower)) {
    reasons.push('Command contains a sleep/timer pattern; likely long-running or test fixture.');
    kind = 'long-running';
    confidence = 'medium';
  } else if (/python\s+-u\s+|\bpython\b.*-m\s+http\.server/.test(lower)) {
    reasons.push('Command appears to be a Python HTTP server or long-running script.');
    kind = 'long-running';
    confidence = 'medium';
  } else if (/npm\s+(?:run|start|dev|test|watch)\b/.test(lower) || /yarn\s+(?:start|dev|watch)\b/.test(lower) || /pnpm\s+(?:start|dev|watch)\b/.test(lower)) {
    reasons.push('Command appears to be a long-running development server.');
    kind = 'long-running';
    confidence = 'high';
  } else if (/\b(?:vim|nano|vi|less|more|top|htop|btop|watch|python\s+-i|node\s+-i)\b/i.test(lower)) {
    reasons.push('Command appears to be interactive.');
    kind = 'interactive';
    confidence = 'high';
  } else if (/\b(?:echo|node\s+-e\s+console\.log|printf|Write-Output|Write-Host)\b/i.test(lower)) {
    reasons.push('Command appears to be a short-lived output operation.');
    kind = 'short-lived';
    confidence = 'medium';
  }

  if (kind === 'unknown') {
    reasons.push('Process type could not be determined from the recorded command.');
  }

  return { kind, confidence, reasons };
}

async function terminateDirectProcess(child: ChildProcess): Promise<void> {
  if (!child.pid) {
    child.kill();
    return;
  }
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(); });
      killer.once('close', () => resolve());
    });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { child.kill('SIGKILL'); }
}

/** Execute one binary with an argv vector. No shell parser or quoting layer is involved. */
export async function execProcess(options: ExecProcessOptions) {
  if (!options.executable.trim()) throw new ToolError('INVALID_ARGUMENT', '"executable" must be a non-empty string.');
  const args = options.args ?? [];
  if (!Array.isArray(args) || args.length > 256 || args.some((arg) => typeof arg !== 'string')) {
    throw new ToolError('INVALID_ARGUMENT', '"args" must be an array of at most 256 strings.');
  }
  const maxTimeoutMs = options.maxTimeoutMs ?? 10 * 60_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > maxTimeoutMs) {
    throw new ToolError('INVALID_ARGUMENT', `"timeout_ms" must be an integer between 100 and ${maxTimeoutMs}.`);
  }
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > MAX_CAPTURE_BYTES) {
    throw new ToolError('INVALID_ARGUMENT', `"max_output_bytes" must be an integer between 1024 and ${MAX_CAPTURE_BYTES}.`);
  }
  if (options.expectExitCode !== undefined && !Number.isInteger(options.expectExitCode)) {
    throw new ToolError('INVALID_ARGUMENT', '"expect_exit_code" must be an integer.');
  }

  const workdir = await resolveMachinePath(options, options.workdir ?? '.', true);
  const startedAt = Date.now();
  const child = spawn(options.executable, args, {
    cwd: workdir,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let stdout = '';
  let stderr = '';
  let capturedBytes = 0;
  let outputTruncated = false;
  let timedOut = false;
  let spawnError: Error | undefined;

  const append = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    const remaining = Math.max(0, maxOutputBytes - capturedBytes);
    const accepted = chunk.subarray(0, remaining);
    capturedBytes += accepted.length;
    if (accepted.length < chunk.length) outputTruncated = true;
    if (!accepted.length) return;
    if (stream === 'stdout') stdout += stdoutDecoder.write(accepted);
    else stderr += stderrDecoder.write(accepted);
  };
  child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
  child.once('error', (error) => { spawnError = error; });

  if (options.stdin !== undefined) child.stdin?.end(options.stdin, 'utf8');
  else child.stdin?.end();

  const close = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    void terminateDirectProcess(child);
  }, timeoutMs);
  const { exitCode, signal } = await close;
  clearTimeout(timer);
  stdout += stdoutDecoder.end();
  stderr += stderrDecoder.end();
  if (spawnError) {
    const code = (spawnError as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ToolError('DEPENDENCY_MISSING', `Executable was not found: ${options.executable}`);
    throw new ToolError('INTERNAL', spawnError.message);
  }
  const expectedExitCode = options.expectExitCode;
  return {
    executable: options.executable,
    args,
    workdir,
    exitCode,
    signal,
    success: !timedOut && exitCode === (expectedExitCode ?? 0),
    timedOut,
    outputTruncated,
    stdout,
    stderr,
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    durationMs: Date.now() - startedAt,
    ...(expectedExitCode === undefined ? {} : { expectedExitCode, expectationMet: exitCode === expectedExitCode }),
  };
}

export async function startProcess(options: StartProcessOptions) {
  if (!options.command.trim()) throw new ToolError('INVALID_ARGUMENT', '"command" parameter is required.');
  await ensureLoaded(options);
  const workdir = await resolveMachinePath(options, options.workdir || '.', true);
  const shell = selectShell(options.shell ?? 'auto');
  const processId = randomUUID();
  const directory = runtimeDirectory(path.resolve(options.root));
  await fs.mkdir(directory, { recursive: true });
  const stdoutLogPath = path.join(directory, `${processId}.stdout.log`);
  const stderrLogPath = path.join(directory, `${processId}.stderr.log`);
  await Promise.all([fs.writeFile(stdoutLogPath, ''), fs.writeFile(stderrLogPath, '')]);
  const child = spawn(shell.executable, [...shell.args, options.command], {
    cwd: workdir,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!child.pid) throw new ToolError('INTERNAL', 'The process started without a PID.');

  let settleProcess!: () => void;
  const settled = new Promise<void>((resolve) => { settleProcess = resolve; });

  const info: ManagedProcess = {
    child,
    processId,
    root: path.resolve(options.root),
    command: options.command,
    workdir,
    shell: shell.kind,
    stdout: '',
    stderr: '',
    stdoutDecoder: new StringDecoder('utf8'),
    stderrDecoder: new StringDecoder('utf8'),
    stdoutLogPath,
    stderrLogPath,
    stdoutLog: createWriteStream(stdoutLogPath, { flags: 'a' }),
    stderrLog: createWriteStream(stderrLogPath, { flags: 'a' }),
    outputTruncated: false,
    capturedBytes: 0,
    startedAt: Date.now(),
    exitCode: null,
    signal: null,
    settled,
  };
  managed.set(child.pid, info);

  child.stdout?.on('data', (chunk: Buffer) => appendOutput(info, 'stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => appendOutput(info, 'stderr', chunk));
  child.on('error', (error) => {
    appendOutput(info, 'stderr', Buffer.from(`${info.stderr ? '\n' : ''}${error.message}`, 'utf8'));
  });
  child.on('close', (exitCode, signal) => {
    void (async () => {
      try {
        info.stdout += info.stdoutDecoder.end();
        info.stderr += info.stderrDecoder.end();
        info.exitCode = exitCode;
        info.signal = signal;
        info.finishedAt = Date.now();
        await Promise.all([closeWriteStream(info.stdoutLog), closeWriteStream(info.stderrLog)]);
        await persistRoot(info.root);
      } finally {
        settleProcess();
      }
    })();
  });
  info.osStartTime = await processStartIdentity(child.pid);
  await persistRoot(info.root);
  child.unref();

  const classification = classifyProcess(options.command, true, null);
  const recommendation = classification.kind === 'long-running'
    ? { type: 'use_start_process' as const, message: 'This command looks long-running. start_process is appropriate; poll with read_process_output.', severity: 'info' as const }
    : classification.kind === 'interactive'
      ? { type: 'use_start_process' as const, message: 'This command appears interactive. start_process is required; interactive stdin may not survive recovery.', severity: 'warning' as const }
      : undefined;

  return {
    pid: child.pid,
    processId,
    identityAvailable: info.osStartTime !== undefined,
    recoveryWarning: info.persistenceError,
    command: info.command,
    workdir,
    shell: info.shell,
    startedAt: new Date(info.startedAt).toISOString(),
    durable: !info.persistenceError,
    stdinAvailable: child.stdin?.writable === true,
    classification,
    recommendation,
  };
}

export async function listManagedProcesses(access?: MachineAccess) {
  if (access) await ensureLoaded(access);
  return Promise.all([...managed.entries()].filter(([, info]) => !access || info.root === path.resolve(access.root)).map(async ([pid, info]) => ({
    pid,
    running: await refreshRecovered(pid, info),
    recovered: !info.child,
    command: info.command,
    workdir: info.workdir,
    exitCode: info.exitCode,
    startedAt: new Date(info.startedAt).toISOString(),
  })));
}

export async function processStatus(options: ProcessPidOptions) {
  const info = await getManaged(options.pid, options);
  const running = await refreshRecovered(options.pid, info);
  const stdout = info.child ? info.stdout : await readLog(info.stdoutLogPath);
  const stderr = info.child ? info.stderr : await readLog(info.stderrLogPath);
  const classification = classifyProcess(info.command, running, info.exitCode);
  return {
    pid: options.pid,
    processId: info.processId,
    exitCodeKnown: info.exitCode !== null,
    recoveryWarning: info.persistenceError,
    running,
    recovered: !info.child,
    exitCode: info.exitCode,
    signal: info.signal,
    command: info.command,
    workdir: info.workdir,
    shell: info.shell,
    startedAt: new Date(info.startedAt).toISOString(),
    finishedAt: info.finishedAt === undefined ? undefined : new Date(info.finishedAt).toISOString(),
    runtimeMs: (info.finishedAt ?? Date.now()) - info.startedAt,
    stdoutOffset: stdout.length,
    stderrOffset: stderr.length,
    outputTruncated: info.outputTruncated,
    stdinAvailable: info.child?.stdin?.writable === true,
    classification,
    hint: !running && info.exitCode !== 0
      ? `Process exited with code ${info.exitCode}. Check stderr for details.`
      : running && classification.kind === 'interactive'
        ? 'Interactive process; stdin may be available via process_write.'
        : undefined,
  };
}

export async function readProcessOutput(options: ReadProcessOutputOptions) {
  const info = await getManaged(options.pid, options);
  const sinceStdout = options.sinceStdout ?? 0;
  const sinceStderr = options.sinceStderr ?? 0;
  const waitMs = options.waitMs ?? 0;
  for (const [name, value] of [['since_stdout', sinceStdout], ['since_stderr', sinceStderr]] as const) {
    if (!Number.isInteger(value) || value < 0) throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a non-negative integer offset.`);
  }
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
    throw new ToolError('INVALID_ARGUMENT', `"wait_ms" must be an integer between 0 and ${MAX_WAIT_MS}.`);
  }

  const readCurrent = async () => ({
    stdout: info.child ? info.stdout : await readLog(info.stdoutLogPath),
    stderr: info.child ? info.stderr : await readLog(info.stderrLogPath),
  });
  let current = await readCurrent();
  const hasNewOutput = () => current.stdout.length > sinceStdout || current.stderr.length > sinceStderr;
  const deadline = Date.now() + waitMs;
  let running = await refreshRecovered(options.pid, info);
  while (waitMs > 0 && !hasNewOutput() && running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, OUTPUT_POLL_INTERVAL_MS));
    current = await readCurrent();
    running = await refreshRecovered(options.pid, info);
  }

  const isLikelyComplete = !running && info.exitCode !== null;
  const hasNew = current.stdout.length > sinceStdout || current.stderr.length > sinceStderr;
  return {
    pid: options.pid,
    processId: info.processId,
    exitCodeKnown: info.exitCode !== null,
    recoveryWarning: info.persistenceError,
    running,
    recovered: !info.child,
    exitCode: info.exitCode,
    stdout: current.stdout.slice(Math.min(sinceStdout, current.stdout.length)),
    stderr: current.stderr.slice(Math.min(sinceStderr, current.stderr.length)),
    nextStdoutOffset: current.stdout.length,
    nextStderrOffset: current.stderr.length,
    outputTruncated: info.outputTruncated,
    hint: isLikelyComplete && !hasNew
      ? 'Process has exited and there is no new output since the last read.'
      : running && !hasNew && waitMs > 0
        ? 'No new output arrived within wait_ms; the process may be idle or slow.'
        : undefined,
  };
}

export async function waitProcess(options: WaitProcessOptions) {
  const maxTimeoutMs = options.maxTimeoutMs ?? 10 * 60_000;
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > maxTimeoutMs) {
    throw new ToolError('INVALID_ARGUMENT', `"timeout_ms" must be an integer between 100 and ${maxTimeoutMs}.`);
  }
  const maxOutputBytes = options.maxOutputBytes ?? 16_384;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 4 || maxOutputBytes > MAX_CAPTURE_BYTES) throw new ToolError('INVALID_ARGUMENT', 'max_output_bytes must be between 4 and 4194304.');
  for (const offset of [options.sinceStdout ?? 0, options.sinceStderr ?? 0]) if (!Number.isInteger(offset) || offset < 0) throw new ToolError('INVALID_ARGUMENT', 'Output offsets must be non-negative integers.');
  const info = await getManaged(options.pid, options);

  const startedWaitingAt = Date.now();
  let running = await refreshRecovered(options.pid, info);
  if (running && info.settled) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        info.settled,
        new Promise<void>((resolve) => { timeout = setTimeout(resolve, options.timeoutMs); }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    running = await refreshRecovered(options.pid, info);
  } else {
    const deadline = startedWaitingAt + options.timeoutMs;
    while (running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(OUTPUT_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))));
      running = await refreshRecovered(options.pid, info);
    }
  }

  const stdout = info.child ? info.stdout : await readLog(info.stdoutLogPath);
  const stderr = info.child ? info.stderr : await readLog(info.stderrLogPath);
  const outStart = Math.min(options.sinceStdout ?? 0, stdout.length);
  const errStart = Math.min(options.sinceStderr ?? 0, stderr.length);
  const take = (text: string, budget: number) => {
    let value = text.slice(0, budget);
    while (Buffer.byteLength(value) > budget || /[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
    return value;
  };
  const out = options.includeOutput ? take(stdout.slice(outStart), maxOutputBytes) : '';
  const err = options.includeOutput ? take(stderr.slice(errStart), maxOutputBytes - Buffer.byteLength(out)) : '';
  const classification = classifyProcess(info.command, running, info.exitCode);
  return {
    ...(options.includeOutput ? { stdout: out, stderr: err, outputHasMore: outStart + out.length < stdout.length || errStart + err.length < stderr.length } : {}),
    pid: options.pid,
    processId: info.processId,
    exitCodeKnown: info.exitCode !== null,
    recoveryWarning: info.persistenceError,
    running,
    completed: !running,
    timedOut: running,
    recovered: !info.child,
    exitCode: info.exitCode,
    signal: info.signal,
    nextStdoutOffset: options.includeOutput ? outStart + out.length : stdout.length,
    nextStderrOffset: options.includeOutput ? errStart + err.length : stderr.length,
    outputTruncated: info.outputTruncated,
    waitedMs: Date.now() - startedWaitingAt,
    classification,
    hint: !running && info.exitCode !== 0
      ? `Process exited with code ${info.exitCode}. Check stderr for details.`
      : running
        ? 'Process is still running; continue polling or call stop_process to terminate.'
        : 'Process has completed.',
  };
}

export async function writeProcessInput(options: WriteProcessInputOptions) {
  const info = await getManaged(options.pid, options);
  if (!info.child?.stdin?.writable) {
    throw new ToolError(
      'PROCESS_IO_UNAVAILABLE',
      `Standard input for process ${options.pid} is not attached to this MCP process.`,
      'Recovered processes can be inspected and stopped after an MCP restart, but their stdin pipe cannot be reattached.',
    );
  }
  await new Promise<void>((resolve, reject) => {
    const writable = info.child!.stdin!;
    const done = (error?: Error | null) => error ? reject(error) : resolve();
    if (writable.write(options.input, 'utf8')) resolve();
    else writable.once('drain', resolve).once('error', done);
  });
  if (options.end) info.child.stdin.end();
  return { pid: options.pid, bytes: Buffer.byteLength(options.input), ended: options.end === true };
}

export async function stopProcess(options: ProcessPidOptions) {
  const info = await getManaged(options.pid, options);
  const wasRunning = await refreshRecovered(options.pid, info);
  if (!wasRunning) {
    return {
      pid: options.pid,
      stopped: false,
      alreadyExited: true,
      exited: true,
      exitCode: info.exitCode,
      recovered: !info.child,
      hint: info.exitCode !== null
        ? `Process had already exited with code ${info.exitCode}.`
        : 'Process was not running and had no recorded exit code.',
    };
  }

  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(options.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    await new Promise<void>((resolve) => { killer.once('close', () => resolve()); killer.once('error', () => resolve()); });
  } else if (info.child) {
    try { process.kill(-options.pid, 'SIGTERM'); } catch { info.child.kill('SIGTERM'); }
  } else {
    try { process.kill(options.pid, 'SIGTERM'); } catch { /* already gone */ }
  }

  const startedWaitingAt = Date.now();
  let escalated = false;
  while (await pidAlive(options.pid) && Date.now() - startedWaitingAt < STOP_TIMEOUT_MS) {
    if (!escalated && process.platform !== 'win32' && Date.now() - startedWaitingAt > STOP_GRACE_MS) {
      await assertRecoveredIdentity(options.pid, info);
      escalated = true;
      try { process.kill(info.child ? -options.pid : options.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await new Promise((resolve) => setTimeout(resolve, OUTPUT_POLL_INTERVAL_MS));
  }

  if (info.settled) {
    await Promise.race([
      info.settled,
      new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
    ]);
  }
  if (process.platform === 'win32') {
    // taskkill can report completion a few milliseconds before Windows releases
    // the last descendant CWD/file handle. Give the kernel a bounded grace
    // period so the documented "stop, then delete workdir" sequence is reliable.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (await pidAlive(options.pid)) throw new ToolError('TIMEOUT', 'Process did not exit within the stop deadline.', undefined, { pid: options.pid });
  if (!info.child && info.finishedAt === undefined) info.finishedAt = Date.now();
  await persistRoot(info.root);
  return {
    pid: options.pid,
    stopped: true,
    alreadyExited: false,
    exited: !(await pidAlive(options.pid)),
    exitCode: info.exitCode,
    signal: info.signal,
    recovered: !info.child,
    waitedMs: Date.now() - startedWaitingAt,
    hint: info.exitCode !== null
      ? `Process stopped with exit code ${info.exitCode}.`
      : 'Process was stopped before it could set an exit code.',
  };
}
