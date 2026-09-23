import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from './audit.js';
import { ToolError, describeError } from './errors.js';
import { findFiles, readMachineFile, searchCode, type SearchMatch } from './file-tools.js';
import { gitDiff } from './git-tools.js';
import { GoalRuntime, type GoalRecord, type GoalStartInput } from './goal-runtime.js';
import { GoalPlanner, type GoalPatchStageInput, type GoalPlanExecution, type GoalVerifyStageInput } from './goal-planner.js';
import { AtomicJsonStore } from './persistent-state.js';
import { applyFilePatch, type MachineAccess } from './shell-tools.js';
import type { VerificationProfile } from './verification.js';
import { parseDiagnostics } from './verification.js';
import { execProcess } from './process-tools.js';
import type { ToolSpec } from './tools.js';

const MAX_CONTEXT_FILES = 8;
const MAX_CONTEXT_BYTES = 96 * 1024;
const MAX_FILE_CONTEXT_BYTES = 16 * 1024;
const MAX_REVIEW_BYTES = 96 * 1024;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with',
  'add', 'change', 'create', 'fix', 'implement', 'make', 'update',
  'ระบบ', 'เพิ่ม', 'แก้', 'แก้ไข', 'ทำ', 'ให้', 'ใน', 'ของ', 'และ', 'ที่', 'เป็น',
]);

// A file is shown as up to MAX_WINDOWS_PER_FILE line ranges around its anchors (search hits,
// diagnostics) so that a hit deep in a large file is visible instead of silently cut off.
const MAX_WINDOWS_PER_FILE = 3;
const WINDOW_LINES_BEFORE = 30;
const WINDOW_LINES_AFTER = 60;
const WINDOW_MERGE_GAP = 10;
const DEFAULT_WINDOW_LINES = 180;
const MAX_LINES_PER_FILE = 300;
const MAX_EXPLICIT_RANGE_LINES = 400;
const MAX_EXPLICIT_CONTEXT_LINES = 600;
const DIAGNOSTIC_SCORE = 60;
const DECLARATION_BONUS = 4;
const BASENAME_BONUS = 6;
const TEST_SIBLING_SOURCES = 3;

const TEST_PATH = /(?:^|\/)(?:__tests__|tests?)\/|[._-](?:test|spec)\.[^/]+$|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py)$/i;

const FALLBACK_GLOBS = [
  '**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs',
  '**/*.go', '**/*.py', '**/*.cs', '**/*.cpp', '**/*.cc', '**/*.c', '**/*.h', '**/*.hpp',
  '**/*.rs', '**/*.java', '**/*.kt', '**/*.json', '**/*.md',
];

export interface GoalContextFile {
  path: string;
  sha256: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  /** Line ranges included in `content`, in file order. Omitted lines are marked in the content. */
  windows: LineWindow[];
  truncated: boolean;
  reasons: string[];
  content: string;
}

export interface GoalContextPacket {
  generatedAt: string;
  queries: string[];
  files: GoalContextFile[];
  baselineDirtyPaths: string[];
  warnings: string[];
  totalBytes: number;
  truncated: boolean;
}

interface StoredContextFile {
  path: string;
  sha256: string;
  startLine: number;
  endLine: number;
  reasons: string[];
}

interface StoredGoalRun {
  goalId: string;
  context?: {
    generatedAt: string;
    queries: string[];
    files: StoredContextFile[];
  };
  changedPaths: string[];
  contextUse?: { edited: string[]; shown: string[] };
  targetedCheck?: TargetedCheckResult;
  updatedAt: string;
}

interface ContextStatsEntry { shown: number; edited: number; lastEditedAt?: string }
interface ContextStatsState { version: 1; files: Record<string, ContextStatsEntry> }

interface GoalRunState {
  version: 1;
  runs: StoredGoalRun[];
}

export interface GoalRunInput {
  id?: string;
  goal?: string;
  path?: string;
  completion?: string[];
  verificationProfile?: VerificationProfile;
  patch?: string;
  includePaths?: string[];
  review?: 'accept' | 'reject';
  summary?: string;
  timeoutMs?: number;
  totalTimeoutMs?: number;
}

export interface GoalRunnerDependencies {
  runtime?: GoalRuntime;
  search?: typeof searchCode;
  read?: typeof readMachineFile;
  find?: typeof findFiles;
  applyPatch?: typeof applyFilePatch;
  diff?: typeof gitDiff;
  planner?: GoalPlanner;
  now?: () => string;
  targetedCheck?: (input: TargetedCheckInput) => Promise<TargetedCheckResult>;
}

export interface TargetedCheckInput { files: string[]; cwd: string; timeoutMs: number; totalTimeoutMs?: number }
export interface TargetedCheckResult { ran: boolean; files: string[]; ok: boolean; durationMs: number; diagnostics?: Array<{ file: string; line: number; message: string }> }

export interface GoalRunnerOptions extends MachineAccess {
  maxTimeoutMs: number;
}

export interface TargetedCommandInput {
  testScript: string;
  dependencies: Readonly<Record<string, string>>;
  usesPytest: boolean;
  files: string[];
  platform?: NodeJS.Platform;
}

/**
 * Picks a runner for a targeted pre-check, or undefined when it cannot be chosen with confidence.
 * Runs only the test sources themselves: mapping a changed source test to a build output (e.g.
 * src/x.test.ts -> dist/x.test.js) would execute stale code, because the patch is not rebuilt
 * before this check, and a stale failure would trap the goal in an endless repair loop.
 */
export function selectTargetedCommand(input: TargetedCommandInput): { executable: string; args: string[] } | undefined {
  const windows = (input.platform ?? process.platform) === 'win32';
  const npx = windows ? 'npx.cmd' : 'npx';
  const script = input.testScript;
  if (input.files.length === 0) return undefined;
  if (input.dependencies.vitest || /\bvitest\b/.test(script)) return { executable: npx, args: ['--no-install', 'vitest', 'run', ...input.files] };
  // Jest has no "run" subcommand; positional arguments are test path patterns.
  if (input.dependencies.jest || /\bjest\b/.test(script)) return { executable: npx, args: ['--no-install', 'jest', '--', ...input.files] };
  if (/\bnode\s+--test\b/.test(script)) {
    return input.files.every((file) => /\.(?:js|mjs|cjs)$/i.test(file))
      ? { executable: 'node', args: ['--test', ...input.files] }
      : undefined;
  }
  if (input.usesPytest && input.files.every((file) => file.endsWith('.py'))) {
    return { executable: windows ? 'python.exe' : 'python', args: ['-m', 'pytest', '-q', ...input.files] };
  }
  return undefined;
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

async function defaultTargetedCheck(options: GoalRunnerOptions, input: TargetedCheckInput): Promise<TargetedCheckResult> {
  const skipped: TargetedCheckResult = { ran: false, files: input.files, ok: true, durationMs: 0 };
  let pkg: { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> } | undefined;
  const packageText = await readOptionalText(path.join(input.cwd, 'package.json'));
  if (packageText !== undefined) {
    try {
      pkg = JSON.parse(packageText) as typeof pkg;
    } catch {
      return skipped; // Malformed package.json: full verification will report it.
    }
  }
  const pyproject = await readOptionalText(path.join(input.cwd, 'pyproject.toml'));
  const command = selectTargetedCommand({
    testScript: pkg?.scripts?.test ?? '',
    dependencies: { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) },
    usesPytest: existsSync(path.join(input.cwd, 'pytest.ini')) || /\bpytest\b/.test(pyproject ?? ''),
    files: input.files,
  });
  if (!command) return skipped;
  const result = await execProcess({ ...options, ...command, workdir: input.cwd, timeoutMs: input.timeoutMs, maxOutputBytes: 256 * 1024 });
  return { ran: true, files: input.files, ok: result.success, durationMs: result.durationMs, diagnostics: parseDiagnostics(`${result.stdout}\n${result.stderr}`) };
}

export interface ParsedIncludePath { path: string; startLine?: number; endLine?: number }

export function parseIncludePath(value: string): ParsedIncludePath {
  const match = /^(.+)#L(\d+)(?:-L?(\d+))?$/.exec(value);
  if (!match) {
    if (value.includes('#L')) throw new ToolError('INVALID_ARGUMENT', `Invalid include path range "${value}".`, 'Use path#L400 or path#L400-L520.');
    return { path: value };
  }
  const startLine = Number(match[2]);
  const endLine = Number(match[3] ?? match[2]);
  if (startLine < 1) throw new ToolError('INVALID_ARGUMENT', `Invalid include path range "${value}": start line must be at least 1.`, 'Use path#L400 or path#L400-L520.');
  if (endLine < startLine) throw new ToolError('INVALID_ARGUMENT', `Invalid include path range "${value}": end line must be at least the start line.`, 'Use path#L400-L520 with an ordered range.');
  if (endLine - startLine + 1 > MAX_EXPLICIT_RANGE_LINES) throw new ToolError('INVALID_ARGUMENT', `Invalid include path range "${value}": ranges are limited to ${MAX_EXPLICIT_RANGE_LINES} lines.`, 'Use a shorter range or multiple context calls.');
  return { path: match[1]!, startLine, endLine };
}

export interface RelativeImport { specifier: string; line: number; symbol?: string }

export function parseRelativeImports(source: string, language: 'ts' | 'js' | 'py' = 'ts'): RelativeImport[] {
  const imports: RelativeImport[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((text, index) => {
    const patterns = language === 'py'
      ? [/^\s*from\s+(\.[\w.]*)\s+import\s+([\w*]+)/, /^\s*from\s+([\w.]+)\s+import\s+([\w*]+)/]
      : [/\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/, /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/, /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/];
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (!match) continue;
      imports.push({ specifier: match[1]!, line: index + 1, ...(match[2] && language === 'py' ? { symbol: match[2] } : {}) });
      break;
    }
  });
  return imports;
}

export function resolveRelativeImport(importer: string, specifier: string, available: ReadonlySet<string>): string | undefined {
  if (specifier.startsWith('.') === false) return undefined;
  const isPython = importer.toLowerCase().endsWith('.py');
  const base = isPython
    ? (specifier.startsWith('.') ? path.posix.join(path.posix.dirname(importer), specifier.replace(/^\.+/, '').replace(/\./g, '/')) : path.posix.join(specifier.replace(/\./g, '/')))
    : path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = isPython
    ? [base, `${base}.py`, path.posix.join(base, '__init__.py')]
    : [base, base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : '', base.endsWith('.js') ? `${base.slice(0, -3)}.tsx` : '', `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`];
  return candidates.find((candidate) => candidate && available.has(normalizeRelative(candidate)));
}

interface ParsedPatchPaths {
  sourcePaths: string[];
  touchedPaths: string[];
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function cleanText(value: string, name: string, maxLength: number): string {
  const cleaned = redactSecrets(value).trim();
  if (!cleaned) throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a non-empty string.`);
  if (cleaned.length > maxLength) throw new ToolError('INVALID_ARGUMENT', `"${name}" must not exceed ${maxLength} characters.`);
  return cleaned;
}

function boundedRawText(value: string, name: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a non-empty string.`);
  if (value.length > maxLength) throw new ToolError('INVALID_ARGUMENT', `"${name}" must not exceed ${maxLength} characters.`);
  return value;
}

function cleanStrings(values: string[] | undefined, name: string, maxItems: number, maxLength: number): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length > maxItems) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must contain at most ${maxItems} strings.`);
  }
  const result = values.map((value) => {
    if (typeof value !== 'string') throw new ToolError('INVALID_ARGUMENT', `"${name}" must contain only strings.`);
    return cleanText(value, name, maxLength);
  });
  return [...new Set(result)];
}

function extractSearchTerms(goal: string): string[] {
  const pathLike = goal.match(/[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|mjs|cjs|go|py|cs|cpp|cc|c|h|hpp|rs|java|kt|json|md)/g) ?? [];
  const symbolLike = goal.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [];
  const unicodeWords = goal.match(/[\p{L}\p{N}_.$/\\-]{3,}/gu) ?? [];
  const candidates = [...pathLike, ...symbolLike, ...unicodeWords]
    .map((value) => value.replace(/^[^\p{L}\p{N}_$./\\-]+|[^\p{L}\p{N}_$./\\-]+$/gu, ''))
    .filter((value) => value.length >= 3 && !STOP_WORDS.has(value.toLowerCase()));

  const unique: string[] = [];
  for (const value of candidates) {
    const lower = value.toLowerCase();
    if (unique.some((existing) => existing.toLowerCase() === lower)) continue;
    unique.push(value);
    if (unique.length >= 8) break;
  }
  if (unique.length === 0) {
    const fallback = goal.trim().slice(0, 120);
    if (fallback) unique.push(fallback);
  }
  return unique;
}

function projectRelative(projectPath: string, candidate: string): string {
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(projectPath, candidate);
  const relative = normalizeRelative(path.relative(projectPath, absolute));
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new ToolError('PATH_DENIED', `Context path is outside the goal project: ${candidate}`);
  }
  return relative;
}

function parsePatchPaths(patch: string): ParsedPatchPaths {
  const normalized = patch.replace(/\r\n/g, '\n');
  const sourcePaths = new Set<string>();
  const touchedPaths = new Set<string>();

  if (/^diff --git/m.test(normalized)) {
    const lines = normalized.split('\n');
    let currentOld: string | undefined;
    let currentNew: string | undefined;
    const flush = () => {
      if (currentOld && currentOld !== '/dev/null') sourcePaths.add(normalizeRelative(currentOld.replace(/^a\//, '')));
      if (currentOld && currentOld !== '/dev/null') touchedPaths.add(normalizeRelative(currentOld.replace(/^a\//, '')));
      if (currentNew && currentNew !== '/dev/null') touchedPaths.add(normalizeRelative(currentNew.replace(/^b\//, '')));
      currentOld = undefined;
      currentNew = undefined;
    };
    for (const line of lines) {
      if (line.startsWith('diff --git ')) {
        flush();
        const match = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
        if (match) {
          currentOld = match[1];
          currentNew = match[2];
        }
      } else if (line.startsWith('--- ')) {
        currentOld = line.slice(4).replace(/^"?a\//, '').replace(/"$/, '');
      } else if (line.startsWith('+++ ')) {
        currentNew = line.slice(4).replace(/^"?b\//, '').replace(/"$/, '');
      }
    }
    flush();
  } else {
    for (const line of normalized.split('\n')) {
      const match = /^\*\*\* (Update|Delete|Add) File: (.+)$/.exec(line);
      if (!match) continue;
      const kind = match[1]!;
      const file = normalizeRelative(match[2]!.trim());
      touchedPaths.add(file);
      if (kind !== 'Add') sourcePaths.add(file);
    }
    const moveRegex = /^\*\*\* Move to: (.+)$/gm;
    for (const match of normalized.matchAll(moveRegex)) touchedPaths.add(normalizeRelative(match[1]!.trim()));
  }

  if (touchedPaths.size === 0) {
    throw new ToolError('PATCH_INVALID', 'Could not determine affected paths from the patch.', 'Use a Codex patch or a standard diff --git unified diff.');
  }
  return { sourcePaths: [...sourcePaths], touchedPaths: [...touchedPaths] };
}

function currentAction(goal: GoalRecord) {
  return goal.actions.find((action) => action.id === goal.currentActionId);
}

interface ContextDiagnostic {
  file: string;
  line?: number;
  message?: string;
}

function verificationDiagnostics(goal: GoalRecord): ContextDiagnostic[] {
  const latest = goal.verificationRuns[goal.verificationRuns.length - 1]?.result;
  if (!latest || !Array.isArray(latest.checks)) return [];
  const diagnostics: ContextDiagnostic[] = [];
  const files = new Set<string>();
  for (const check of latest.checks as Array<Record<string, unknown>>) {
    if (!Array.isArray(check.diagnostics)) continue;
    for (const diagnostic of check.diagnostics as Array<Record<string, unknown>>) {
      if (typeof diagnostic.file !== 'string' || !diagnostic.file.trim()) continue;
      const file = diagnostic.file.trim();
      // Keep every diagnostic of an already-selected file (more anchors), but cap distinct files.
      if (!files.has(file) && files.size >= MAX_CONTEXT_FILES) continue;
      files.add(file);
      diagnostics.push({
        file,
        ...(Number.isInteger(diagnostic.line) && (diagnostic.line as number) > 0 ? { line: diagnostic.line as number } : {}),
        ...(typeof diagnostic.message === 'string' ? { message: diagnostic.message.slice(0, 160) } : {}),
      });
      if (diagnostics.length >= 60) return diagnostics;
    }
  }
  return diagnostics;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when a matched line looks like the definition of `symbol` rather than a use of it. */
export function isDeclarationOf(text: string, symbol: string): boolean {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) return false;
  const name = escapeRegExp(symbol);
  return new RegExp(
    `\\b(?:function\\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|namespace|module)\\s+${name}\\b`
    + `|^\\s*(?:(?:public|private|protected|static|async|readonly|override)\\s+)*${name}\\s*(?:<[^>]*>)?\\([^)]*\\)\\s*[:{]`,
  ).test(text);
}

/**
 * Rare terms are informative; a term that matches in many files ("error", "config") is mostly noise.
 * Weight decays logarithmically with the number of distinct files the term matched.
 */
export function termWeight(matchedFiles: number): number {
  return 4 / (1 + Math.log2(1 + Math.max(1, matchedFiles)));
}

export interface LineWindow {
  startLine: number;
  endLine: number;
}

/**
 * Turns weighted anchor lines into at most `maxWindows` non-overlapping ranges, keeping the
 * heaviest clusters and never exceeding `maxLines` in total. Returned in file order.
 */
export function planContextWindows(
  anchors: ReadonlyMap<number, number>,
  maxWindows = MAX_WINDOWS_PER_FILE,
  maxLines = MAX_LINES_PER_FILE,
  requiredWindows: readonly LineWindow[] = [],
): LineWindow[] {
  const required = requiredWindows.map((window) => ({ startLine: window.startLine, endLine: window.endLine }));
  if (anchors.size === 0 && required.length === 0) return [{ startLine: 1, endLine: DEFAULT_WINDOW_LINES }];
  const merged: Array<LineWindow & { weight: number; peak: number }> = [];
  for (const line of [...anchors.keys()].sort((a, b) => a - b)) {
    const weight = anchors.get(line)!;
    const startLine = Math.max(1, line - WINDOW_LINES_BEFORE);
    const endLine = line + WINDOW_LINES_AFTER;
    const last = merged[merged.length - 1];
    if (last && startLine <= last.endLine + WINDOW_MERGE_GAP) {
      last.endLine = Math.max(last.endLine, endLine);
      last.weight += weight;
      last.peak = Math.max(last.peak, weight);
    } else {
      merged.push({ startLine, endLine, weight, peak: weight });
    }
  }

  const chosen = [...merged]
    .sort((a, b) => b.weight - a.weight || a.startLine - b.startLine)
    .slice(0, Math.max(0, maxWindows - required.length));
  const windows: LineWindow[] = [...required];
  let remaining = Math.max(0, maxLines - required.reduce((sum, window) => sum + window.endLine - window.startLine + 1, 0));
  for (const window of chosen) {
    if (remaining <= 0) break;
    const length = Math.min(window.endLine - window.startLine + 1, remaining);
    windows.push({ startLine: window.startLine, endLine: window.startLine + length - 1 });
    remaining -= length;
  }
  return windows.sort((a, b) => a.startLine - b.startLine);
}

/** Conventional locations of the test file for a source file, relative to the project root. */
export function testSiblingCandidates(relative: string): string[] {
  if (TEST_PATH.test(relative)) return [];
  const directory = path.posix.dirname(relative);
  const extension = path.posix.extname(relative);
  const stem = path.posix.basename(relative, extension);
  const join = (...parts: string[]) => normalizeRelative(path.posix.join(...parts));
  switch (extension.toLowerCase()) {
    case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': case '.cjs':
      return [
        join(directory, `${stem}.test${extension}`),
        join(directory, `${stem}.spec${extension}`),
        join(directory, '__tests__', `${stem}.test${extension}`),
      ];
    case '.py':
      return [join(directory, `test_${stem}.py`), join(directory, `${stem}_test.py`), join('tests', `test_${stem}.py`)];
    case '.go':
      return [join(directory, `${stem}_test.go`)];
    default:
      return [];
  }
}

async function isRegularFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

export class GoalRunner {
  readonly #options: GoalRunnerOptions;
  readonly #runtime: GoalRuntime;
  readonly #store: AtomicJsonStore<GoalRunState>;
  readonly #stats: AtomicJsonStore<ContextStatsState>;
  readonly #search: typeof searchCode;
  readonly #read: typeof readMachineFile;
  readonly #find: typeof findFiles;
  readonly #applyPatch: typeof applyFilePatch;
  readonly #diff: typeof gitDiff;
  readonly #planner: GoalPlanner;
  readonly #now: () => string;
  readonly #targetedCheck: (input: TargetedCheckInput) => Promise<TargetedCheckResult>;

  constructor(options: GoalRunnerOptions, dependencies: GoalRunnerDependencies = {}) {
    this.#options = options;
    this.#runtime = dependencies.runtime ?? new GoalRuntime(options);
    this.#store = new AtomicJsonStore(path.join(path.resolve(options.root), '.pilot', 'goal-runs.json'), () => ({ version: 1, runs: [] }));
    this.#stats = new AtomicJsonStore(path.join(path.resolve(options.root), '.pilot', 'goal-context-stats.json'), () => ({ version: 1, files: {} }));
    this.#search = dependencies.search ?? searchCode;
    this.#read = dependencies.read ?? readMachineFile;
    this.#find = dependencies.find ?? findFiles;
    this.#applyPatch = dependencies.applyPatch ?? applyFilePatch;
    this.#diff = dependencies.diff ?? gitDiff;
    this.#planner = dependencies.planner ?? new GoalPlanner({ root: options.root }, {
      applyPatch: async (input) => this.#applyPatchStage(input),
      verify: async (input) => this.#verifyStage(input),
    });
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#targetedCheck = dependencies.targetedCheck ?? ((input) => defaultTargetedCheck(this.#options, input));
  }

  async #runState(goalId: string): Promise<StoredGoalRun | undefined> {
    const state = await this.#store.read();
    return state.runs.find((run) => run.goalId === goalId);
  }

  async #saveContext(goalId: string, packet: GoalContextPacket, changedPaths?: string[]): Promise<void> {
    await this.#store.update((state) => {
      let run = state.runs.find((candidate) => candidate.goalId === goalId);
      if (!run) {
        run = { goalId, changedPaths: [], updatedAt: this.#now() };
        state.runs.push(run);
      }
      run.context = {
        generatedAt: packet.generatedAt,
        queries: packet.queries,
        files: packet.files.map((file) => ({
          path: file.path,
          sha256: file.sha256,
          startLine: file.startLine,
          endLine: file.endLine,
          reasons: file.reasons,
        })),
      };
      run.contextUse = {
        shown: [...new Set([...(run.contextUse?.shown ?? []), ...packet.files.map((file) => file.path)])].slice(-200),
        edited: run.contextUse?.edited ?? [],
      };
      if (changedPaths) run.changedPaths = [...new Set([...run.changedPaths, ...changedPaths])].slice(0, 100);
      run.updatedAt = this.#now();
      if (state.runs.length > 1000) {
        state.runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        state.runs.length = 1000;
      }
    });
    await this.#stats.update((state) => {
      for (const file of packet.files) {
        const current = state.files[file.path] ?? { shown: 0, edited: 0 };
        state.files[file.path] = { ...current, shown: current.shown + 1 };
      }
      this.#trimStats(state);
    });
  }

  #trimStats(state: ContextStatsState): void {
    const entries = Object.entries(state.files).sort((a, b) => (b[1].lastEditedAt ?? '').localeCompare(a[1].lastEditedAt ?? '') || b[1].shown - a[1].shown);
    state.files = Object.fromEntries(entries.slice(0, 2000));
  }

  async #rememberChanged(goalId: string, changedPaths: string[]): Promise<void> {
    await this.#store.update((state) => {
      let run = state.runs.find((candidate) => candidate.goalId === goalId);
      if (!run) {
        run = { goalId, changedPaths: [], updatedAt: this.#now() };
        state.runs.push(run);
      }
      run.changedPaths = [...new Set([...run.changedPaths, ...changedPaths])].slice(0, 100);
      run.contextUse = { shown: run.contextUse?.shown ?? [], edited: [...new Set([...(run.contextUse?.edited ?? []), ...changedPaths])].slice(0, 100) };
      run.updatedAt = this.#now();
    });
    await this.#stats.update((state) => {
      const now = this.#now();
      for (const file of changedPaths) {
        const current = state.files[file] ?? { shown: 0, edited: 0 };
        state.files[file] = { ...current, edited: current.edited + 1, lastEditedAt: now };
      }
      this.#trimStats(state);
    });
  }

  async #rememberTargetedCheck(goalId: string, targetedCheck: TargetedCheckResult): Promise<void> {
    await this.#store.update((state) => {
      const run = state.runs.find((candidate) => candidate.goalId === goalId);
      if (run) { run.targetedCheck = targetedCheck; run.updatedAt = this.#now(); }
    });
  }

  async #discover(
    goal: GoalRecord,
    includePaths: string[] = [],
    diagnostics: ContextDiagnostic[] = [],
  ): Promise<GoalContextPacket> {
    const queries = extractSearchTerms(goal.goal);
    const warnings: string[] = [];
    const candidates = new Map<string, { score: number; anchors: Map<number, number>; reasons: Set<string>; optional: boolean; explicitWindows: LineWindow[] }>();

    const addCandidate = (
      candidatePath: string,
      score: number,
      line: number | undefined,
      reason: string,
      optional = false,
      explicitWindow?: LineWindow,
    ) => {
      try {
        const relative = projectRelative(goal.path, candidatePath);
        const existing = candidates.get(relative)
          ?? { score: 0, anchors: new Map<number, number>(), reasons: new Set<string>(), optional, explicitWindows: [] };
        existing.score += score;
        existing.optional &&= optional;
        if (line) existing.anchors.set(line, (existing.anchors.get(line) ?? 0) + score);
        if (existing.reasons.size < 8) existing.reasons.add(reason);
        if (explicitWindow && !existing.explicitWindows.some((window) => window.startLine === explicitWindow.startLine && window.endLine === explicitWindow.endLine)) existing.explicitWindows.push(explicitWindow);
        candidates.set(relative, existing);
      } catch {
        // Search engines can theoretically report an out-of-root path through an alias.
        // Ignore it here; reads still enforce the workspace boundary.
      }
    };

    for (const explicit of includePaths) {
      const parsed = parseIncludePath(explicit);
      const relative = projectRelative(goal.path, parsed.path);
      addCandidate(relative, 100, parsed.startLine, parsed.startLine ? `explicitly requested lines ${parsed.startLine}-${parsed.endLine}` : 'explicitly requested', false, parsed.startLine && parsed.endLine ? { startLine: parsed.startLine, endLine: parsed.endLine } : undefined);
    }
    // Verification failures point at the exact line to repair; anchor the window there.
    for (const diagnostic of diagnostics) {
      const where = diagnostic.line ? `line ${diagnostic.line}` : 'file';
      addCandidate(
        diagnostic.file,
        DIAGNOSTIC_SCORE,
        diagnostic.line,
        `verification diagnostic at ${where}${diagnostic.message ? `: ${diagnostic.message}` : ''}`,
      );
    }
    for (const query of queries) {
      if (!/\.(?:ts|tsx|js|mjs|cjs|go|py|cs|cpp|cc|c|h|hpp|rs|java|kt|json|md)$/i.test(query)) continue;
      const normalized = normalizeRelative(query);
      if (normalized.includes('/')) {
        addCandidate(normalized, 80, undefined, 'path named in goal');
        continue;
      }
      try {
        const found = await this.#find({
          ...this.#options,
          directoryPath: goal.path,
          glob: `**/${normalized}`,
          maxResults: 4,
          maxDepth: 12,
          includeHidden: false,
        });
        for (const candidate of found.matches) addCandidate(candidate, 80, undefined, 'filename named in goal');
      } catch (error: unknown) {
        warnings.push(`Could not resolve filename "${query}": ${describeError(error).message}`);
      }
    }

    for (const query of queries) {
      try {
        const result = await this.#search({
          ...this.#options,
          pattern: query,
          searchPath: goal.path,
          caseSensitive: false,
          literal: true,
          maxResults: 24,
          maxMatchesPerFile: 3,
          contextLines: 0,
          timeoutMs: 10_000,
        });
        const weight = termWeight(new Set(result.matches.map((match) => match.path)).size);
        const queryLower = query.toLowerCase();
        for (const match of result.matches) {
          const basenameBonus = path.basename(match.path).toLowerCase().includes(queryLower) ? BASENAME_BONUS : 0;
          const declares = isDeclarationOf(match.text, query);
          addCandidate(
            match.path,
            weight + basenameBonus + (declares ? DECLARATION_BONUS : 0),
            match.line,
            declares ? `declares "${query}"` : `matched "${query}"`,
          );
        }
        if (result.truncated) warnings.push(`Search results for "${query}" were truncated.`);
      } catch (error: unknown) {
        warnings.push(`Search for "${query}" failed: ${describeError(error).message}`);
      }
    }

    if (candidates.size === 0) {
      for (const glob of FALLBACK_GLOBS) {
        try {
          const found = await this.#find({
            ...this.#options,
            directoryPath: goal.path,
            glob,
            maxResults: 2,
            maxDepth: 8,
            includeHidden: false,
          });
          for (const candidate of found.matches) addCandidate(candidate, 1, undefined, `fallback ${glob}`);
          if (candidates.size >= MAX_CONTEXT_FILES) break;
        } catch {
          // Fallback discovery is best-effort.
        }
      }
      if (candidates.size === 0) warnings.push('No source-file candidates were discovered from the goal text.');
    }

    const stats = await this.#stats.read();
    for (const [relative, candidate] of candidates) {
      const history = stats.files[relative];
      if (!history || history.shown < 1) continue;
      const adjustment = history.edited > 0 ? Math.min(4, 1 + history.edited) : -Math.min(3, Math.floor(history.shown / 3));
      candidate.score += adjustment;
      candidate.reasons.add(history.edited > 0 ? `history: edited ${history.edited}/${history.shown} times` : `history: shown ${history.shown} times, never edited`);
    }

    // Add a bounded import neighbourhood before test siblings. Neighbours remain low priority.
    const sourceRank = [...candidates.entries()]
      .filter(([relative]) => !TEST_PATH.test(relative))
      .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
      .slice(0, 3);
    const sourcePaths = new Set<string>();
    try {
      const found = await this.#find({ ...this.#options, directoryPath: goal.path, glob: '**/*', maxResults: 2000, maxDepth: 20, includeHidden: false });
      for (const match of found.matches) sourcePaths.add(projectRelative(goal.path, match));
    } catch { /* optional neighbour discovery */ }
    for (const [relative] of sourceRank) {
      try {
        const read = await this.#read({ ...this.#options, filePath: path.join(goal.path, relative), maxLines: 600, maxBytes: 48 * 1024, lineNumbers: false });
        const imports = parseRelativeImports(read.content, relative.endsWith('.py') ? 'py' : 'ts');
        for (const item of imports.slice(0, 6)) {
          const target = resolveRelativeImport(relative, item.specifier, sourcePaths);
          // item.line is a line of the importer, so it cannot anchor a window in the imported file.
          if (target) addCandidate(target, 2, undefined, `imported by ${relative}`, true);
        }
      } catch { /* optional */ }
      try {
        const basename = path.posix.basename(relative, path.posix.extname(relative));
        const result = await this.#search({ ...this.#options, pattern: basename, searchPath: goal.path, caseSensitive: false, literal: true, maxResults: 12, maxMatchesPerFile: 2, contextLines: 0, timeoutMs: 10_000 });
        for (const match of result.matches.slice(0, 6)) {
          try {
            const importer = projectRelative(goal.path, match.path);
            if (importer === relative || TEST_PATH.test(importer)) continue;
            const read = await this.#read({ ...this.#options, filePath: match.path, maxLines: 600, maxBytes: 48 * 1024, lineNumbers: false });
            const imports = parseRelativeImports(read.content, importer.endsWith('.py') ? 'py' : 'ts');
            const matched = imports.find((item) => resolveRelativeImport(importer, item.specifier, sourcePaths) === relative);
            if (matched) addCandidate(importer, 2, matched.line, `imports ${relative}`, true);
          } catch { /* optional: one unreadable caller must not hide the others */ }
        }
      } catch { /* optional */ }
    }

    // Verification runs the tests, so a patch to a source file usually needs its test in view too.
    const topSources = [...candidates.entries()]
      .filter(([relative]) => !TEST_PATH.test(relative))
      .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
      .slice(0, TEST_SIBLING_SOURCES);
    for (const [relative, candidate] of topSources) {
      for (const sibling of testSiblingCandidates(relative)) {
        if (!candidates.has(sibling) && !(await isRegularFile(path.join(goal.path, sibling)))) continue;
        addCandidate(sibling, candidate.score / 2, undefined, `test for ${relative}`, true);
        break;
      }
    }

    const ranked = [...candidates.entries()]
      .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
      .slice(0, MAX_CONTEXT_FILES);

    const files: GoalContextFile[] = [];
    let totalBytes = 0;
    let truncated = candidates.size > ranked.length;

    for (const [relative, candidate] of ranked) {
      if (totalBytes >= MAX_CONTEXT_BYTES) {
        truncated = true;
        break;
      }
      const budget = Math.max(1024, Math.min(MAX_FILE_CONTEXT_BYTES, MAX_CONTEXT_BYTES - totalBytes));
      try {
        const lineBudget = candidate.explicitWindows.length ? MAX_EXPLICIT_CONTEXT_LINES : MAX_LINES_PER_FILE;
        const file = await this.#readWindows(path.join(goal.path, relative), planContextWindows(candidate.anchors, MAX_WINDOWS_PER_FILE, lineBudget, candidate.explicitWindows), budget);
        if (!file) {
          warnings.push(`Skipped ${relative}: it changed while its context was being read.`);
          continue;
        }
        const content = redactSecrets(file.content);
        totalBytes += Buffer.byteLength(content);
        files.push({ path: relative, ...file, reasons: [...candidate.reasons], content });
        if (file.truncated) truncated = true;
      } catch (error: unknown) {
        if (!candidate.optional) warnings.push(`Could not read ${relative}: ${describeError(error).message}`);
      }
    }

    const packet: GoalContextPacket = {
      generatedAt: this.#now(),
      queries,
      files,
      baselineDirtyPaths: goal.project.baselineDirtyPaths,
      warnings: warnings.slice(0, 20),
      totalBytes,
      truncated,
    };
    await this.#saveContext(goal.id, packet);
    return packet;
  }

  /**
   * Reads the planned windows of one file into a single line-numbered excerpt. All windows must
   * come from the same file version, because the patch is later hash-locked to that version.
   * Returns undefined when the file changed between window reads.
   */
  async #readWindows(filePath: string, planned: LineWindow[], maxBytes: number) {
    const parts: string[] = [];
    const windows: LineWindow[] = [];
    let sha256: string | undefined;
    let totalLines: number | undefined;
    let remaining = maxBytes;
    let budgetExhausted = false;

    for (const window of planned) {
      if (totalLines !== undefined && window.startLine > totalLines) continue;
      if (remaining < 256) {
        budgetExhausted = true;
        break;
      }
      let read: Awaited<ReturnType<typeof readMachineFile>>;
      try {
        read = await this.#read({
          ...this.#options,
          filePath,
          startLine: window.startLine,
          maxLines: window.endLine - window.startLine + 1,
          maxBytes: remaining,
          lineNumbers: true,
        });
      } catch (error: unknown) {
        // A stale anchor (e.g. an old diagnostic) can point past the end of the file.
        if (error instanceof ToolError && error.code === 'INVALID_ARGUMENT' && window.startLine > 1) continue;
        throw error;
      }
      if (sha256 !== undefined && read.sha256 !== sha256) return undefined;
      sha256 = read.sha256;
      totalLines = read.totalLines;
      if (read.endLine < read.startLine) continue;

      const gapStart = (windows[windows.length - 1]?.endLine ?? 0) + 1;
      if (read.startLine > gapStart) parts.push(`... lines ${gapStart}-${read.startLine - 1} omitted ...`);
      parts.push(read.content);
      windows.push({ startLine: read.startLine, endLine: read.endLine });
      remaining -= Buffer.byteLength(read.content);
      if (read.endLine < Math.min(window.endLine, read.totalLines)) budgetExhausted = true;
    }

    if (sha256 === undefined || totalLines === undefined) {
      // Every planned window was past the end of the file: fall back to its head.
      const read = await this.#read({ ...this.#options, filePath, maxLines: DEFAULT_WINDOW_LINES, maxBytes, lineNumbers: true });
      return {
        sha256: read.sha256,
        startLine: read.startLine,
        endLine: read.endLine,
        totalLines: read.totalLines,
        windows: [{ startLine: read.startLine, endLine: read.endLine }],
        truncated: read.truncated,
        content: read.content,
      };
    }

    const lastEnd = windows[windows.length - 1]?.endLine ?? 0;
    if (lastEnd < totalLines) parts.push(`... lines ${lastEnd + 1}-${totalLines} omitted ...`);
    const covered = windows.reduce((sum, window) => sum + window.endLine - window.startLine + 1, 0);
    return {
      sha256,
      startLine: windows[0]?.startLine ?? 1,
      endLine: lastEnd,
      totalLines,
      windows,
      truncated: budgetExhausted || covered < totalLines,
      content: parts.join('\n'),
    };
  }

  async #contextForPatch(goal: GoalRecord): Promise<{ run: StoredGoalRun; expectedHashes: Record<string, string> }> {
    const run = await this.#runState(goal.id);
    if (!run?.context?.files.length) {
      throw new ToolError(
        'PRECONDITION_FAILED',
        'No prepared goal context exists for this patch.',
        'Call goal_run with the goal id and no patch first, then build the patch from the returned context.',
      );
    }
    return {
      run,
      expectedHashes: Object.fromEntries(run.context.files.map((file) => [normalizeRelative(file.path), file.sha256])),
    };
  }

  async #applyPatchStage(input: GoalPatchStageInput) {
    const goal = await this.#runtime.get(input.goalId);
    const action = currentAction(goal);
    if (!action || action.kind !== 'change' || action.id !== input.actionId) {
      throw new ToolError(
        'PRECONDITION_FAILED',
        `Goal patch stage is stale. Current action is ${action?.id ?? '(none)'} (${action?.kind ?? goal.status}).`,
        'Resume the goal and rebuild the patch from its current context.',
      );
    }

    const parsed = parsePatchPaths(input.patch);
    const prepared = await this.#contextForPatch(goal);
    const missing = parsed.sourcePaths.filter((source) => !prepared.expectedHashes[source]);
    if (missing.length) {
      throw new ToolError(
        'PRECONDITION_FAILED',
        `Patch references source files that were not in the prepared context: ${missing.join(', ')}`,
        'Refresh goal context including these files, then rebuild the patch.',
        { reason: 'context_missing', missing },
      );
    }
    const expectedHashes = Object.fromEntries(parsed.sourcePaths.map((source) => [source, prepared.expectedHashes[source]!]));
    await this.#applyPatch(this.#options, input.patch, true, expectedHashes);
    const changed = await this.#applyPatch(this.#options, input.patch, false, expectedHashes);
    await this.#rememberChanged(goal.id, parsed.touchedPaths);
    const advanced = await this.#runtime.report({
      id: goal.id,
      actionId: action.id,
      outcome: 'success',
      summary: input.summary ? cleanText(input.summary, 'summary', 8000) : `Applied goal patch: ${changed.join('; ')}`,
      evidence: changed,
    });
    return {
      changed,
      touchedPaths: parsed.touchedPaths,
      phase: advanced.goal.phase,
      nextActionId: advanced.goal.currentActionId,
    };
  }

  async #verifyStage(input: GoalVerifyStageInput) {
    const goal = await this.#runtime.get(input.goalId);
    const action = currentAction(goal);
    if (goal.status === 'done' || action?.kind === 'review') {
      return {
        alreadyVerified: true,
        phase: goal.phase,
        latest: goal.verificationRuns[goal.verificationRuns.length - 1]?.result,
      };
    }
    if (!action || action.kind !== 'verify') {
      throw new ToolError(
        'PRECONDITION_FAILED',
        `Goal verification stage is stale. Current action is ${action?.id ?? '(none)'} (${action?.kind ?? goal.status}).`,
      );
    }
    const latest = goal.verificationRuns[goal.verificationRuns.length - 1];
    const run = await this.#runState(goal.id);
    const related = new Set<string>();
    for (const changed of run?.changedPaths ?? []) {
      for (const sibling of testSiblingCandidates(changed)) if (await isRegularFile(path.join(goal.path, sibling))) related.add(sibling);
    }
    for (const file of run?.context?.files ?? []) if (TEST_PATH.test(file.path)) related.add(file.path);
    const files = [...related].slice(0, 12);
    let targetedCheck: TargetedCheckResult & { error?: ReturnType<typeof describeError> } = { ran: false, files, ok: true, durationMs: 0 };
    if (latest?.ok === false && files.length > 0) {
      try {
        targetedCheck = await this.#targetedCheck({ files, cwd: goal.path, timeoutMs: input.timeoutMs ?? this.#options.maxTimeoutMs, ...(input.totalTimeoutMs !== undefined ? { totalTimeoutMs: input.totalTimeoutMs } : {}) });
      } catch (error: unknown) {
        // The pre-check is only an accelerator; if it cannot run, full verification still decides.
        targetedCheck = { ran: false, files, ok: true, durationMs: 0, error: describeError(error) };
      }
    }
    // Always overwrite, so a stale targeted failure never anchors a later repair context.
    await this.#rememberTargetedCheck(goal.id, targetedCheck);
    if (targetedCheck.ran && !targetedCheck.ok) {
      const failed = { ok: false, checks: [{ name: 'targeted tests', ok: false, diagnostics: targetedCheck.diagnostics ?? [] }], targetedCheck };
      return this.#runtime.recordTargetedFailure(goal.id, failed);
    }
    const verified = await this.#runtime.verify(goal.id, input.timeoutMs, input.totalTimeoutMs);
    return { ...verified, verification: { ...verified.verification, targetedCheck } };
  }

  async #reviewPacket(goal: GoalRecord) {
    const run = await this.#runState(goal.id);
    const changedPaths = run?.changedPaths ?? [];
    let diffResult: Awaited<ReturnType<typeof gitDiff>> | undefined;
    let diffError: ReturnType<typeof describeError> | undefined;
    try {
      diffResult = await this.#diff({
        ...this.#options,
        path: goal.path,
        paths: changedPaths.length ? changedPaths : undefined,
        contextLines: 5,
        maxBytes: 64 * 1024,
      });
    } catch (error: unknown) {
      diffError = describeError(error);
    }

    const files: Array<{ path: string; sha256: string; content: string; truncated: boolean }> = [];
    let remaining = MAX_REVIEW_BYTES;
    for (const relative of changedPaths.slice(0, 12)) {
      if (remaining < 1024) break;
      try {
        const read = await this.#read({
          ...this.#options,
          filePath: path.join(goal.path, relative),
          maxLines: 220,
          maxBytes: Math.min(12 * 1024, remaining),
          lineNumbers: true,
        });
        const content = redactSecrets(read.content);
        remaining -= Buffer.byteLength(content);
        files.push({ path: relative, sha256: read.sha256, content, truncated: read.truncated });
      } catch {
        // Deleted paths and binary files are represented by the diff/status instead.
      }
    }

    return {
      completion: goal.completion,
      baselineDirtyPaths: goal.project.baselineDirtyPaths,
      changedPaths,
      diff: diffResult?.diff ?? '',
      diffTruncated: diffResult?.truncated ?? false,
      ...(diffError ? { diffError } : {}),
      files,
    };
  }

  async #needsPatch(goal: GoalRecord, includePaths: string[] = []) {
    // A failed targeted pre-check is newer than the last full verification run, so its
    // diagnostics are what the repair has to address.
    const targeted = (await this.#runState(goal.id))?.targetedCheck;
    const targetedDiagnostics: ContextDiagnostic[] = targeted?.ran && !targeted.ok
      ? (targeted.diagnostics ?? []).slice(0, 60).map((diagnostic) => ({ file: diagnostic.file, line: diagnostic.line, message: diagnostic.message.slice(0, 160) }))
      : [];
    const packet = await this.#discover(goal, includePaths, [...targetedDiagnostics, ...verificationDiagnostics(goal)]);
    return {
      goalId: goal.id,
      state: 'needs_patch',
      phase: goal.phase,
      action: currentAction(goal),
      context: packet,
      patchRequirements: {
        formats: ['Codex *** Begin Patch format', 'standard diff --git unified diff'],
        sourceFilesMustComeFromContext: true,
        additionsAllowed: true,
        note: 'Patch source files are hash-locked to this context. If they change before the next call, the patch is rejected and context is refreshed.',
      },
    };
  }

  async run(input: GoalRunInput) {
    if (input.patch && input.review) throw new ToolError('INVALID_ARGUMENT', 'Pass either "patch" or "review", not both.');
    if (!input.id && (input.patch || input.review)) {
      throw new ToolError('INVALID_ARGUMENT', 'Start goal_run without a patch/review first so the runtime can prepare hash-locked context.');
    }
    if (input.patch && input.includePaths?.length) {
      throw new ToolError('INVALID_ARGUMENT', 'Add include_paths in a context-preparation call before submitting the patch.');
    }

    let goal: GoalRecord;
    if (!input.id) {
      if (!input.goal) throw new ToolError('INVALID_ARGUMENT', 'Start goal_run with "goal", or resume it with "id".');
      const started = await this.#runtime.start({
        goal: cleanText(input.goal, 'goal', 8000),
        path: input.path,
        completion: cleanStrings(input.completion, 'completion', 20, 500),
        verificationProfile: input.verificationProfile,
      });
      goal = started.goal;
    } else {
      if (input.goal) throw new ToolError('INVALID_ARGUMENT', 'Do not pass "goal" when resuming an existing goal id.');
      goal = await this.#runtime.get(input.id);
    }

    if (goal.status === 'done') return { goalId: goal.id, state: 'done', goal };
    if (goal.status === 'cancelled') return { goalId: goal.id, state: 'cancelled', goal };
    if (goal.status === 'blocked') return { goalId: goal.id, state: 'blocked', goal, action: currentAction(goal) };

    let action = currentAction(goal);
    let execution: GoalPlanExecution | undefined;
    if (!action) throw new ToolError('INTERNAL', `Goal ${goal.id} has no current action.`);

    if (action.kind === 'inspect') {
      const context = await this.#discover(goal, cleanStrings(input.includePaths, 'include_paths', 12, 4000) ?? []);
      const advanced = await this.#runtime.report({
        id: goal.id,
        actionId: action.id,
        outcome: 'success',
        summary: `Goal runner prepared ${context.files.length} bounded context files using ${context.queries.length} search terms.`,
        evidence: context.files.map((file) => `${file.path}#L${file.startLine}-L${file.endLine}`),
      });
      goal = advanced.goal;
      action = currentAction(goal)!;
      return {
        goalId: goal.id,
        state: 'needs_patch',
        phase: goal.phase,
        action,
        context,
        patchRequirements: {
          formats: ['Codex *** Begin Patch format', 'standard diff --git unified diff'],
          sourceFilesMustComeFromContext: true,
          additionsAllowed: true,
        },
      };
    }

    if (action.kind === 'change') {
      if (!input.patch) {
        return await this.#needsPatch(goal, cleanStrings(input.includePaths, 'include_paths', 12, 4000) ?? []);
      }

      const patch = boundedRawText(input.patch, 'patch', 512 * 1024);
      const parsed = parsePatchPaths(patch);
      execution = await this.#planner.executePatchCycle({
        goalId: goal.id,
        actionId: action.id,
        patch,
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.totalTimeoutMs !== undefined ? { totalTimeoutMs: input.totalTimeoutMs } : {}),
      });

      goal = await this.#runtime.get(goal.id);
      action = currentAction(goal)!;

      if (execution.recoveryRequired) {
        if (action?.kind === 'verify') {
          const recovered = await this.#verifyStage({
            goalId: goal.id,
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
            ...(input.totalTimeoutMs !== undefined ? { totalTimeoutMs: input.totalTimeoutMs } : {}),
          }) as Awaited<ReturnType<GoalRuntime['verify']>>;
          goal = recovered.goal;
          action = currentAction(goal)!;
          if (recovered.verification.ok !== true) {
            return {
              ...(await this.#needsPatch(goal)),
              verification: recovered.verification,
              repair: true,
              plan: execution.plan,
              flow: execution.flow,
              recoveredAfterRestart: true,
            };
          }
        } else if (action?.kind !== 'review') {
          const context = await this.#discover(goal, parsed.sourcePaths);
          return {
            goalId: goal.id,
            state: 'recovery_required',
            phase: goal.phase,
            action,
            recovery: {
              reason: execution.recoveryReason ?? 'Patch execution outcome is uncertain.',
              automaticRetry: false,
              instruction: 'Inspect the refreshed source context and reconcile the interrupted mutation before submitting a new patch.',
            },
            plan: execution.plan,
            flow: execution.flow,
            context,
          };
        }
      }

      if (execution.stageError) {
        const detail = execution.stageError;
        if (detail.code === 'PRECONDITION_FAILED' || detail.code === 'NO_MATCH') {
          const missing = Array.isArray(detail.details?.missing)
            ? detail.details.missing.filter((value): value is string => typeof value === 'string')
            : parsed.sourcePaths;
          const context = await this.#discover(goal, missing.length ? missing : parsed.sourcePaths);
          return {
            goalId: goal.id,
            state: 'needs_patch',
            phase: goal.phase,
            patchRejected: detail.details?.reason === 'context_missing'
              ? { ...detail, code: 'CONTEXT_MISSING' }
              : detail,
            plan: execution.plan,
            flow: execution.flow,
            context,
          };
        }
        throw new ToolError(detail.code, detail.message, detail.hint, detail.details);
      }

      goal = await this.#runtime.get(goal.id);
      action = currentAction(goal)!;
      if (action?.kind === 'change' && goal.phase === 'execute') {
        const latest = goal.verificationRuns[goal.verificationRuns.length - 1];
        const run = await this.#runState(goal.id);
        return {
          ...(await this.#needsPatch(goal)),
          goal,
          ...(latest ? { verification: { ...latest.result, ...(run?.targetedCheck ? { targetedCheck: run.targetedCheck } : {}) } } : {}),
          repair: true,
          plan: execution.plan,
          flow: execution.flow,
        };
      }
    }

    if (action.kind === 'verify') {
      const verified = await this.#verifyStage({
        goalId: goal.id,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.totalTimeoutMs !== undefined ? { totalTimeoutMs: input.totalTimeoutMs } : {}),
      }) as Awaited<ReturnType<GoalRuntime['verify']>>;
      goal = verified.goal;
      action = currentAction(goal)!;
      if (verified.verification.ok !== true) {
        return {
          ...(await this.#needsPatch(goal)),
          verification: verified.verification,
          repair: true,
          ...(execution ? { plan: execution.plan, flow: execution.flow } : {}),
        };
      }
    }

    if (action.kind === 'review' || goal.phase === 'review') {
      action = currentAction(goal)!;
      if (input.review === 'reject') {
        const rejected = await this.#runtime.report({
          id: goal.id,
          actionId: action.id,
          outcome: 'failure',
          summary: input.summary ? cleanText(input.summary, 'summary', 8000) : 'Final review rejected the current change.',
        });
        goal = rejected.goal;
        return {
          ...(await this.#needsPatch(goal)),
          reviewRejected: true,
          ...(execution ? { plan: execution.plan, flow: execution.flow } : {}),
        };
      }
      if (input.review === 'accept') {
        const accepted = await this.#runtime.report({
          id: goal.id,
          actionId: action.id,
          outcome: 'success',
          summary: input.summary ? cleanText(input.summary, 'summary', 8000) : 'Final diff and behavior satisfy the goal completion criteria.',
        });
        return { goalId: goal.id, state: 'done', goal: accepted.goal, ...(execution ? { plan: execution.plan, flow: execution.flow } : {}) };
      }
      return {
        goalId: goal.id,
        state: 'needs_review',
        phase: goal.phase,
        action,
        review: await this.#reviewPacket(goal),
        ...(execution ? { plan: execution.plan, flow: execution.flow } : {}),
      };
    }

    return { goalId: goal.id, state: goal.status, phase: goal.phase, action };
  }
}

function optionalString(args: Record<string, unknown>, name: string, maxLength: number): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a string.`);
  return cleanText(value, name, maxLength);
}

function optionalInteger(args: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must be an integer between ${min} and ${max}.`);
  }
  return value as number;
}

function optionalEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new ToolError('INVALID_ARGUMENT', `"${name}" must be one of: ${allowed.join(', ')}.`);
  return value as T;
}

export function createGoalRunToolSpec(options: GoalRunnerOptions, runner = new GoalRunner(options)): ToolSpec {
  return {
    name: 'goal_run',
    description: 'Drive a durable coding goal through automatic repository discovery, bounded context packing, hash-locked patch application, verification/repair, and final review. ChatGPT supplies semantic patches/review decisions; Goal Runtime owns the mechanical workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 128, description: 'Existing goal id to resume.' },
        goal: { type: 'string', minLength: 1, maxLength: 8000, description: 'Natural-language goal when starting a new run.' },
        path: { type: 'string', maxLength: 4000, description: 'Project directory for a new goal.' },
        completion: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 500 } },
        verification_profile: { type: 'string', enum: ['fast', 'normal', 'strict'] },
        patch: { type: 'string', maxLength: 524288, description: 'Patch generated from the context returned by the previous goal_run call.' },
        include_paths: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 4000 }, description: 'Explicit source files to include; optionally use path#L400 or path#L400-L520 for a strict line range (maximum 400 lines).' },
        review: { type: 'string', enum: ['accept', 'reject'], description: 'Final semantic review decision after verification passes.' },
        summary: { type: 'string', maxLength: 8000 },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 660000 },
        total_timeout_ms: { type: 'integer', minimum: 1000, maximum: 660000 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: async (args) => runner.run({
      id: optionalString(args, 'id', 128),
      goal: optionalString(args, 'goal', 8000),
      path: optionalString(args, 'path', 4000),
      completion: cleanStrings(args.completion as string[] | undefined, 'completion', 20, 500),
      verificationProfile: optionalEnum(args.verification_profile, 'verification_profile', ['fast', 'normal', 'strict'] as const),
      patch: optionalString(args, 'patch', 512 * 1024),
      includePaths: cleanStrings(args.include_paths as string[] | undefined, 'include_paths', 12, 4000),
      review: optionalEnum(args.review, 'review', ['accept', 'reject'] as const),
      summary: optionalString(args, 'summary', 8000),
      timeoutMs: optionalInteger(args, 'timeout_ms', 1000, 660000),
      totalTimeoutMs: optionalInteger(args, 'total_timeout_ms', 1000, 660000),
    }),
  };
}
