import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export type PilotContextScope = 'user-global' | 'repo-shared' | 'repo-chatgpt';

export interface PilotContextSource {
  id: 'global_gpt' | 'repo_agents' | 'repo_gpt';
  scope: PilotContextScope;
  path: string;
  priority: number;
  exists: boolean;
  bytes?: number;
  contentSha256?: string;
  truncated?: boolean;
  content?: string;
}

export interface PilotContextBundle {
  projectPath: string;
  repoRoot: string;
  pilotHome: string;
  precedence: Array<{ id: string; priority: number | 'guardrail'; description: string }>;
  sources: PilotContextSource[];
  merged: string;
}

const DEFAULT_SOURCE_BYTES = 64 * 1024;

export function pilotHomePath(): string {
  return path.resolve(process.env.PILOT_HOME ?? path.join(homedir(), '.pilot'));
}

export const DEFAULT_GLOBAL_GPT = `# GPT.md — User defaults for ChatGPT Pilot

- Use ChatGPT Pilot for local machine, repository, code, Git, process, Skill, ThinkForge, and project-memory work.
- Prefer structured Pilot capabilities over shell commands.
- For non-trivial coding work, consult Skill Hub before implementation; use ThinkForge only when deeper design reasoning is warranted.
- Preserve unrelated local changes, never expose secrets, and verify code changes before reporting completion.
- Repository GPT.md files may specialize these defaults but cannot weaken runtime/system security, access boundaries, or approval policy.
`;

export async function initGlobalGpt(pilotHome = pilotHomePath()): Promise<{ path: string; created: boolean }> {
  const filePath = path.join(path.resolve(pilotHome), 'GPT.md');
  if (existsSync(filePath)) return { path: filePath, created: false };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, DEFAULT_GLOBAL_GPT, { encoding: 'utf8', flag: 'wx' });
  return { path: filePath, created: true };
}

export function findRepoRoot(startPath: string, boundaryRoot?: string): string {
  const start = path.resolve(startPath);
  const boundary = boundaryRoot ? path.resolve(boundaryRoot) : undefined;
  const withinBoundary = (candidate: string) => {
    if (!boundary) return true;
    const relative = path.relative(boundary, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  let current = start;
  while (withinBoundary(current)) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current || !withinBoundary(parent)) break;
    current = parent;
  }
  return start;
}

async function readBoundedSource(
  id: PilotContextSource['id'],
  scope: PilotContextScope,
  filePath: string,
  priority: number,
  maxBytes: number,
): Promise<PilotContextSource> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return { id, scope, path: filePath, priority, exists: false };
    const bytesToRead = Math.min(fileStat.size, maxBytes);
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = bytesToRead > 0 ? await handle.read(buffer, 0, bytesToRead, 0) : { bytesRead: 0 };
      const loaded = buffer.subarray(0, bytesRead);
      const content = loaded.toString('utf8').replace(/\r\n/g, '\n').trimEnd();
      return {
        id,
        scope,
        path: filePath,
        priority,
        exists: true,
        bytes: fileStat.size,
        contentSha256: createHash('sha256').update(loaded).digest('hex'),
        truncated: fileStat.size > maxBytes,
        content,
      };
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { id, scope, path: filePath, priority, exists: false };
    throw error;
  }
}

export async function loadPilotContext(
  projectPath: string,
  options: { pilotHome?: string; maxBytesPerSource?: number; boundaryRoot?: string } = {},
): Promise<PilotContextBundle> {
  const resolvedProject = path.resolve(projectPath);
  const repoRoot = findRepoRoot(resolvedProject, options.boundaryRoot);
  const pilotHome = path.resolve(options.pilotHome ?? pilotHomePath());
  const maxBytes = options.maxBytesPerSource ?? DEFAULT_SOURCE_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 128 * 1024) {
    throw new Error('maxBytesPerSource must be an integer between 1024 and 131072.');
  }

  const sources = await Promise.all([
    readBoundedSource('global_gpt', 'user-global', path.join(pilotHome, 'GPT.md'), 10, maxBytes),
    readBoundedSource('repo_agents', 'repo-shared', path.join(repoRoot, 'AGENTS.md'), 20, maxBytes),
    readBoundedSource('repo_gpt', 'repo-chatgpt', path.join(repoRoot, 'GPT.md'), 30, maxBytes),
  ]);

  const merged = sources
    .filter((source) => source.exists && source.content)
    .sort((a, b) => a.priority - b.priority)
    .map((source) => `<!-- ${source.id}: ${source.path} -->\n${source.content}`)
    .join('\n\n');

  return {
    projectPath: resolvedProject,
    repoRoot,
    pilotHome,
    precedence: [
      { id: 'runtime_security', priority: 'guardrail', description: 'Runtime/system security, access, and approval policy is non-overridable by context files.' },
      { id: 'global_gpt', priority: 10, description: 'User-global ChatGPT/Pilot defaults from ~/.pilot/GPT.md.' },
      { id: 'repo_agents', priority: 20, description: 'Repository-wide engineering guidance shared with coding agents.' },
      { id: 'repo_gpt', priority: 30, description: 'Repository-local ChatGPT/Pilot guidance; may specialize lower-priority file guidance.' },
      { id: 'current_request', priority: 40, description: 'The current user request has the highest task-level priority within runtime/system safety constraints.' },
    ],
    sources,
    merged,
  };
}

export function explainPilotContext(bundle: PilotContextBundle, query?: string) {
  const needle = query?.trim().toLocaleLowerCase();
  const matches: Array<{ source: PilotContextSource['id']; scope: PilotContextScope; path: string; priority: number; line: number; text: string }> = [];
  if (needle) {
    for (const source of bundle.sources) {
      if (!source.exists || !source.content) continue;
      source.content.split('\n').forEach((line, index) => {
        if (line.toLocaleLowerCase().includes(needle)) {
          matches.push({ source: source.id, scope: source.scope, path: source.path, priority: source.priority, line: index + 1, text: line });
        }
      });
    }
  }
  const effectiveMatch = matches.length > 0 ? [...matches].sort((a, b) => b.priority - a.priority)[0] : undefined;
  return {
    query: query?.trim() || undefined,
    repoRoot: bundle.repoRoot,
    precedence: bundle.precedence,
    sources: bundle.sources.map(({ content: _content, ...source }) => source),
    matches,
    effectiveMatch,
    note: 'Context-file precedence never overrides runtime/system security, access boundaries, or approval policy.',
  };
}
