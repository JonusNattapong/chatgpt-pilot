/**
 * RuntimeControlService: the control plane behind runtime_info, capability_diff,
 * restart_if_stale, and self_update.
 *
 * One service (single lock, single audit path via the MCP gateway, bounded
 * timeouts) instead of handlers shelling out on their own.
 *
 * Restart physics: a worker cannot survive its own restart, and the supervisor
 * counts every worker restart as a failure. Control tools therefore never block
 * on a restart they cause: they spawn a detached helper
 * (scripts/apply-restart.mjs) that kills the worker after the response has
 * been flushed, waits for the respawn, runs a post-restart --check handshake,
 * and writes a receipt. Poll runtime_info afterwards for the outcome.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { canonicalize, createContractManifest } from './contract.js';
import { headCommit, loadBuildInfo } from './build-info.js';
import { ToolError } from './errors.js';
import type { ToolSpec } from './tools.js';

const execFileAsync = promisify(execFile);

const FETCH_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 300_000;
const VERIFY_TIMEOUT_MS = 540_000;
const CHECK_TIMEOUT_MS = 120_000;

export interface ManifestEntry {
  name: string;
  inputSchema: unknown;
  annotations: unknown;
}

export interface CapabilityDiff {
  fingerprintMatch: boolean;
  added: string[];
  removed: string[];
  changed: string[];
  live: { count: number; fingerprint: string };
  fresh: { count: number; fingerprint: string };
}

export interface ControlDeps {
  /** Checkout root. Defaults to the monorepo root resolved from dist. */
  repoDir?: string;
  /** Must match the live worker so dynamic schema bounds compare like-for-like. */
  maxTimeoutMs?: number;
  /** Spawns `node <dist>/index.js --check` and returns parsed JSON. */
  runCheck?: (surface: 'legacy' | 'hybrid') => Promise<{ tools: string[]; manifest: ManifestEntry[]; fingerprint: string; build: Record<string, unknown> }>;
  /** True when running under the MCP supervisor (respawn available). */
  isSupervised?: () => boolean;
  /** Spawns the detached restart helper. Defaults to the real spawner. */
  spawnRestarter?: (workerPid: number, expectedCommit: string | null, receiptPath: string) => void;
  /** Runs a command with timeout. Defaults to execFile. */
  runCommand?: (command: string, args: string[], options: { cwd: string; timeoutMs: number }) => Promise<{ stdout: string; stderr: string }>;
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

export function defaultRepoDir(): string {
  return path.resolve(here, '..', '..', '..');
}

export function distEntry(): string {
  return path.join(here, 'index.js');
}

export function ownerClaimPath(repoDir: string): string {
  return path.join(repoDir, '.tunnel', 'runtime-owner.json');
}

export function restartReceiptPath(repoDir: string): string {
  return path.join(repoDir, '.tunnel', 'last-control-restart.json');
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Process-wide lock so update/restart operations never overlap. */
let controlTail: Promise<void> = Promise.resolve();
let controlActiveCount = 0;

export function withControlLock<T>(operation: () => Promise<T>): Promise<T> {
  controlActiveCount += 1;
  const run = controlTail.then(operation, operation);
  controlTail = run.then(
    () => {
      controlActiveCount -= 1;
    },
    () => {
      controlActiveCount -= 1;
    },
  );
  return run;
}

export function isControlBusy(): boolean {
  return controlActiveCount > 0;
}

async function defaultRunCommand(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const detail = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (detail.killed) throw new ToolError('TIMEOUT', `Command timed out after ${options.timeoutMs} ms: ${command} ${args.join(' ')}`);
    throw new ToolError('INTERNAL', `Command failed: ${command} ${args.join(' ')}`, (detail.stderr ?? detail.message ?? String(error)).slice(0, 2000));
  }
}

async function defaultRunCheck(surface: 'legacy' | 'hybrid', maxTimeoutMs?: number): Promise<{ tools: string[]; manifest: ManifestEntry[]; fingerprint: string; build: Record<string, unknown> }> {
  const args = surface === 'hybrid' ? ['--tool-surface', 'hybrid', '--dangerously-open-machine', '--check'] : ['--check'];
  if (typeof maxTimeoutMs === 'number' && Number.isInteger(maxTimeoutMs) && maxTimeoutMs >= 1000) {
    args.unshift('--max-timeout', String(maxTimeoutMs));
  }
  const child = spawn(process.execPath, [distEntry(), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const code: number = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(124);
    }, CHECK_TIMEOUT_MS);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode ?? 1);
    });
  });
  if (code !== 0) throw new ToolError('INTERNAL', `Fresh capability probe failed (exit ${code}).`, stderr.slice(-2000));
  try {
    const parsed = JSON.parse(stdout) as { tools?: string[]; manifest?: ManifestEntry[]; contractFingerprint?: string; build?: Record<string, unknown> };
    if (!Array.isArray(parsed.tools)) throw new Error('missing tools');
    return {
      tools: parsed.tools,
      manifest: Array.isArray(parsed.manifest) ? parsed.manifest : [],
      fingerprint: typeof parsed.contractFingerprint === 'string' ? parsed.contractFingerprint : '',
      build: parsed.build && typeof parsed.build === 'object' ? parsed.build : {},
    };
  } catch (error: unknown) {
    throw new ToolError('INTERNAL', 'Fresh capability probe returned unparsable output.', String(error).slice(0, 500));
  }
}

function defaultIsSupervised(): boolean {
  return process.env.MCP_SUPERVISED === '1';
}

function defaultSpawnRestarter(workerPid: number, expectedCommit: string | null, receiptPath: string): void {
  const helper = path.resolve(here, '..', 'scripts', 'apply-restart.mjs');
  if (!existsSync(helper)) throw new ToolError('DEPENDENCY_MISSING', `Restart helper not found: ${helper}`);
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  const child = spawn(process.execPath, [helper, String(workerPid), receiptPath, expectedCommit ?? '', distEntry()], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function liveManifest(specs: readonly ToolSpec[]): ManifestEntry[] {
  return specs.map((spec) => ({
    name: spec.name,
    inputSchema: canonicalize(spec.inputSchema),
    annotations: canonicalize(spec.annotations),
  }));
}

export function diffManifests(live: ManifestEntry[], fresh: ManifestEntry[]): Omit<CapabilityDiff, 'live' | 'fresh'> {
  const liveByName = new Map(live.map((entry) => [entry.name, JSON.stringify(entry)]));
  const freshByName = new Map(fresh.map((entry) => [entry.name, JSON.stringify(entry)]));
  const added = [...freshByName.keys()].filter((name) => !liveByName.has(name)).sort();
  const removed = [...liveByName.keys()].filter((name) => !freshByName.has(name)).sort();
  const changed = [...freshByName.keys()]
    .filter((name) => liveByName.has(name) && liveByName.get(name) !== freshByName.get(name))
    .sort();
  return { fingerprintMatch: added.length === 0 && removed.length === 0 && changed.length === 0, added, removed, changed };
}

export interface RuntimeInfo {
  service: { version: string; contractVersion: number; contractFingerprint: string; capabilityCount: number };
  build: Record<string, unknown>;
  worker: { pid: number; uptimeSeconds: number; supervised: boolean };
  tunnel: { owner: string | null; daemonPid: number | null; claimedAt: string | null };
  lastControlRestart: Record<string, unknown> | null;
}

export function getRuntimeInfo(specs: readonly ToolSpec[], deps: ControlDeps = {}): RuntimeInfo {
  const repoDir = deps.repoDir ?? defaultRepoDir();
  const build = loadBuildInfo();
  const head = headCommit(repoDir);
  const contract = createContractManifest([...specs]);
  const claim = readJsonFile(ownerClaimPath(repoDir));
  const receipt = readJsonFile(restartReceiptPath(repoDir));
  const owner = typeof claim?.owner === 'string' ? claim.owner : null;
  const daemonPid = typeof claim?.pid === 'number' ? claim.pid : null;
  const claimedAt = typeof claim?.startedAt === 'string' ? claim.startedAt : null;
  return {
    service: {
      version: build.packageVersion,
      contractVersion: contract.contractVersion,
      contractFingerprint: contract.fingerprint,
      capabilityCount: specs.length,
    },
    build: { ...build, head, staleBuild: build.commit !== null && head !== null && build.commit !== head },
    worker: { pid: process.pid, uptimeSeconds: Math.floor(process.uptime()), supervised: (deps.isSupervised ?? defaultIsSupervised)() },
    tunnel: { owner, daemonPid, claimedAt },
    lastControlRestart: receipt,
  };
}

export async function diffCapabilities(specs: readonly ToolSpec[], deps: ControlDeps = {}): Promise<CapabilityDiff> {
  const live = liveManifest(specs);
  const liveFingerprint = createContractManifest([...specs]).fingerprint;
  const runCheck = deps.runCheck ?? ((surface: 'legacy' | 'hybrid') => defaultRunCheck(surface, deps.maxTimeoutMs));
  const fresh = await runCheck('legacy');
  const freshManifest: ManifestEntry[] =
    fresh.manifest.length > 0
      ? fresh.manifest
      : fresh.tools.map((name) => ({ name, inputSchema: {}, annotations: {} }));
  const diff = diffManifests(live, freshManifest);
  const fingerprintMatch = diff.fingerprintMatch && (fresh.fingerprint === '' || fresh.fingerprint === liveFingerprint);
  return {
    ...diff,
    fingerprintMatch,
    live: { count: live.length, fingerprint: liveFingerprint },
    fresh: { count: fresh.manifest.length > 0 ? fresh.manifest.length : fresh.tools.length, fingerprint: fresh.fingerprint },
  };
}

export interface RestartDecision {
  restarted: boolean;
  stale: boolean;
  cause: string;
  workerPid: number;
  expectedCommit: string | null;
  receipt: string;
  hint?: string;
}

async function initiateRestart(reason: string, expectedCommit: string | null, deps: ControlDeps): Promise<RestartDecision> {
  const repoDir = deps.repoDir ?? defaultRepoDir();
  const supervised = (deps.isSupervised ?? defaultIsSupervised)();
  const receipt = restartReceiptPath(repoDir);
  if (!supervised) {
    throw new ToolError(
      'PRECONDITION_FAILED',
      `Restart requested (${reason}) but this worker is not supervised and would not come back.`,
      'Restart the runtime externally (scripts/restart-tunnel.ps1) or run under the supervisor.',
    );
  }
  (deps.spawnRestarter ?? defaultSpawnRestarter)(process.pid, expectedCommit, receipt);
  return { restarted: true, stale: true, cause: reason, workerPid: process.pid, expectedCommit, receipt };
}

export async function restartIfStale(specs: readonly ToolSpec[], deps: ControlDeps = {}): Promise<RestartDecision> {
  return withControlLock(async () => {
    const repoDir = deps.repoDir ?? defaultRepoDir();
    const build = loadBuildInfo();
    const head = headCommit(repoDir);
    if (build.commit !== null && head !== null && build.commit !== head) {
      return {
        restarted: false,
        stale: true,
        cause: 'dist-behind-head',
        workerPid: process.pid,
        expectedCommit: head,
        receipt: restartReceiptPath(repoDir),
        hint: 'A restart alone cannot help: dist was built from an older commit. Run self_update (or pnpm build) first, then restart.',
      };
    }
    const claim = readJsonFile(ownerClaimPath(repoDir));
    const claimedBuild = typeof claim?.buildCommit === 'string' ? claim.buildCommit : null;
    if (claimedBuild !== null && build.commit !== null && claimedBuild !== build.commit) {
      return initiateRestart('worker-behind-dist', build.commit, deps);
    }
    const diff = await diffCapabilities(specs, deps);
    if (!diff.fingerprintMatch) {
      return initiateRestart('surface-mismatch', build.commit, deps);
    }
    return {
      restarted: false,
      stale: false,
      cause: 'fresh',
      workerPid: process.pid,
      expectedCommit: build.commit,
      receipt: restartReceiptPath(repoDir),
      hint: 'Worker serves the current dist; no restart needed.',
    };
  });
}

export interface UpdateResult {
  updated: boolean;
  from: string | null;
  to: string | null;
  restarted: boolean;
  receipt: string;
  reason: string;
  steps: string[];
}

async function gitStatusPorcelain(repoDir: string, run: ControlDeps['runCommand']): Promise<string[]> {
  const runCommand = run ?? defaultRunCommand;
  const result = await runCommand('git', ['-C', repoDir, 'status', '--porcelain'], { cwd: repoDir, timeoutMs: 30_000 });
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function selfUpdate(deps: ControlDeps = {}): Promise<UpdateResult> {
  if (process.env.MCP_ALLOW_SELF_UPDATE !== '1') {
    throw new ToolError(
      'POLICY_DENIED',
      'self_update requires explicit opt-in.',
      'Set MCP_ALLOW_SELF_UPDATE=1 in the runtime environment (and grant the tool via policy) to allow autonomous code updates.',
    );
  }
  return withControlLock(async () => {
    const repoDir = deps.repoDir ?? defaultRepoDir();
    const receipt = restartReceiptPath(repoDir);
    const run = deps.runCommand ?? defaultRunCommand;
    const steps: string[] = [];
    const branch = (await run('git', ['-C', repoDir, 'branch', '--show-current'], { cwd: repoDir, timeoutMs: 30_000 })).stdout.trim();
    if (branch !== 'main') {
      throw new ToolError('PRECONDITION_FAILED', `self_update refuses to run on branch '${branch || '(detached)'}'.`, 'Switch to main before autonomous updates.');
    }
    steps.push('branch=main');
    const dirty = await gitStatusPorcelain(repoDir, deps.runCommand);
    if (dirty.length > 0) {
      throw new ToolError('PRECONDITION_FAILED', `Working tree is dirty (${dirty.length} file(s)); refusing to touch it.`, dirty.slice(0, 20).join('; '));
    }
    steps.push('tree=clean');
    let ahead = 0;
    try {
      ahead = Number((await run('git', ['-C', repoDir, 'rev-list', '--count', 'HEAD..@{u}'], { cwd: repoDir, timeoutMs: 30_000 })).stdout.trim());
    } catch {
      throw new ToolError('PRECONDITION_FAILED', 'No upstream tracking branch; cannot verify fast-forward safety.', 'Set an upstream (git branch --set-upstream-to=origin/main).');
    }
    if (!Number.isInteger(ahead) || ahead > 0) {
      throw new ToolError('PRECONDITION_FAILED', 'Local HEAD is ahead of upstream; refusing to pull over unpushed work.', 'Push local commits first.');
    }
    steps.push('ahead=0');
    try {
      await run('git', ['-C', repoDir, 'fetch', 'origin'], { cwd: repoDir, timeoutMs: FETCH_TIMEOUT_MS });
    } catch {
      throw new ToolError('NETWORK', 'Fetch from origin failed; aborting without touching the runtime.');
    }
    steps.push('fetched');
    const head = headCommit(repoDir);
    const remote = (await run('git', ['-C', repoDir, 'rev-parse', 'origin/main'], { cwd: repoDir, timeoutMs: 30_000 })).stdout.trim();
    if (head !== null && head === remote) {
      return { updated: false, from: head, to: remote, restarted: false, receipt, reason: 'already up to date with origin/main', steps };
    }
    try {
      await run('git', ['-C', repoDir, 'merge', '--ff-only', 'origin/main'], { cwd: repoDir, timeoutMs: 60_000 });
    } catch {
      throw new ToolError('PRECONDITION_FAILED', 'Diverged from origin/main; fast-forward impossible.', 'Reconcile manually; autonomous merge is disabled.');
    }
    steps.push(`fast-forwarded to ${remote.slice(0, 7)}`);
    const usePnpm = existsSync(path.join(repoDir, 'pnpm-lock.yaml'));
    const buildTool = usePnpm ? 'pnpm' : 'npm';
    try {
      await run(buildTool, ['build'], { cwd: repoDir, timeoutMs: BUILD_TIMEOUT_MS });
    } catch (error: unknown) {
      throw new ToolError('INTERNAL', 'Build failed after fast-forward; runtime left untouched on the previous build.', error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000));
    }
    steps.push('built');
    try {
      await run(buildTool, ['verify'], { cwd: repoDir, timeoutMs: VERIFY_TIMEOUT_MS });
    } catch (error: unknown) {
      throw new ToolError('INTERNAL', 'Verification failed after update; runtime left untouched on the previous build.', error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000));
    }
    steps.push('verified');
    const decision = await initiateRestart('post-update', remote, deps);
    return {
      updated: true,
      from: head,
      to: remote,
      restarted: decision.restarted,
      receipt: decision.receipt,
      reason: 'updated, verified, restart initiated; poll runtime_info until build.commit matches the new HEAD',
      steps,
    };
  });
}
