import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type AccessMode = 'unrestricted' | 'restricted';
export type ApprovalMode = 'mrtr' | 'deny';

export interface LocalConfig {
  workspaceRoot: string;
  accessMode: AccessMode;
  policy: string;
  approvalMode: ApprovalMode;
  supervisorTimeoutMs: number;
}

export function pilotStateDir(root: string): string {
  const pilotDir = path.join(root, '.pilot');
  const legacyDir = path.join(root, '.chatgpt-machine');
  if (!existsSync(pilotDir) && existsSync(legacyDir)) {
    return legacyDir;
  }
  return pilotDir;
}

export function localConfigPath(root: string): string {
  return path.join(pilotStateDir(root), 'config.json');
}

export function defaultLocalConfig(root: string): LocalConfig {
  return {
    workspaceRoot: path.dirname(path.resolve(root)),
    accessMode: 'unrestricted',
    policy: 'admin',
    approvalMode: 'mrtr',
    // Tool calls may legitimately run for several minutes (for example a
    // repository verification or bounded research task).  Keep this aligned
    // with the documented maximum per-tool timeout so the tunnel does not
    // turn a slow, healthy call into a reconnect/502 cascade.
    supervisorTimeoutMs: 600_000,
  };
}

function validateConfig(raw: unknown): LocalConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config must be an object');
  const c = raw as Record<string, unknown>;
  const workspaceRoot = typeof c.workspaceRoot === 'string' ? c.workspaceRoot : String(c.workspaceRoot ?? '');
  const accessMode = c.accessMode as string;
  if (accessMode !== 'unrestricted' && accessMode !== 'restricted') throw new Error(`accessMode must be 'unrestricted' or 'restricted' (got ${JSON.stringify(accessMode)})`);
  const policy = typeof c.policy === 'string' ? c.policy : 'admin';
  const approvalMode = (c.approvalMode as string) ?? 'mrtr';
  if (approvalMode !== 'mrtr' && approvalMode !== 'deny') throw new Error(`approvalMode must be 'mrtr' or 'deny'`);
  const supervisorTimeoutMs = Number(c.supervisorTimeoutMs);
  if (!Number.isInteger(supervisorTimeoutMs) || supervisorTimeoutMs < 5_000 || supervisorTimeoutMs > 660_000) {
    throw new Error('supervisorTimeoutMs must be an integer between 5000 and 660000');
  }
  if (!workspaceRoot) throw new Error('workspaceRoot is required');
  return { workspaceRoot: path.resolve(workspaceRoot), accessMode: accessMode as AccessMode, policy, approvalMode: approvalMode as ApprovalMode, supervisorTimeoutMs };
}

export function initLocalConfig(root: string, reset = false): string {
  const p = localConfigPath(root);
  if (existsSync(p) && !reset) return p;
  mkdirSync(path.dirname(p), { recursive: true });
  const cfg = defaultLocalConfig(root);
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return p;
}

export function loadLocalConfig(root: string): LocalConfig {
  const p = localConfigPath(root);
  if (!existsSync(p)) return defaultLocalConfig(root);
  const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
  return validateConfig(raw);
}

export function configEnvironment(config: LocalConfig): Record<string, string> {
  return {
    MCP_WORKSPACE_ROOT: config.workspaceRoot,
    MCP_POLICY: config.policy,
    MCP_APPROVAL_MODE: config.approvalMode,
    MCP_ACCESS_MODE: config.accessMode,
    MCP_SUPERVISOR_TIMEOUT_MS: String(config.supervisorTimeoutMs),
  };
}

export function setWorkspaceRoot(root: string, newWorkspace: string): LocalConfig {
  if (!newWorkspace || typeof newWorkspace !== 'string') {
    throw new Error('Workspace path must be a non-empty string.');
  }
  const resolved = path.resolve(newWorkspace);
  if (!existsSync(resolved)) {
    throw new Error(`Workspace path does not exist: ${resolved}`);
  }
  const stat = statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolved}`);
  }
  const current = loadLocalConfig(root);
  const updated: LocalConfig = { ...current, workspaceRoot: resolved };
  const p = localConfigPath(root);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  return updated;
}
