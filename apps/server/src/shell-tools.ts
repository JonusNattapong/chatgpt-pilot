import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ToolError } from './errors.js';

export type ShellKind = 'auto' | 'bash' | 'powershell' | 'cmd';

export interface MachineAccess {
  root: string;
  unrestricted: boolean;
}

export interface ShellCommandOptions extends MachineAccess {
  command: string;
  workdir?: string;
  shell?: ShellKind;
  timeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  stdin?: string;
}

export interface ShellCommandResult {
  shell: Exclude<ShellKind, 'auto'>;
  workdir: string;
  exitCode: number | null;
  success: boolean;
  hadPowerShellError: boolean;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
  command: string;
  /** New: lightweight classification of what this command does. */
  classification?: CommandClassification;
  /** New: actionable recommendation when a safer or smarter tool is available. */
  recommendation?: CommandRecommendation;
  /** New: parsed exit signal info when available. */
  signal?: NodeJS.Signals | null;
}

export interface CommandClassification {
  kind: 'read-only' | 'build' | 'git' | 'file-write' | 'network' | 'package-manager' | 'system' | 'interactive' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  /** Suggested safer alternative tool name, if any. */
  preferredTool?: string;
  /** Suggested safe timeout range in ms, if any. */
  suggestedTimeoutMs?: { min: number; max: number };
}

export interface CommandRecommendation {
  type: 'prefer_exec_process' | 'use_start_process' | 'use_git_tool' | 'use_file_tool' | 'shell_needed' | 'dangerous_pattern';
  message: string;
  severity: 'info' | 'warning' | 'error';
}

interface PatchOperation {
  kind: 'add' | 'update' | 'delete';
  filePath: string;
  moveTo?: string;
  lines: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const POWERSHELL_ERROR_MARKER_PREFIX = '__CHATGPT_MACHINE_POWERSHELL_ERROR__';

/* ------------------------------------------------------------------ */
/*  Command intelligence                                               */
/* ------------------------------------------------------------------ */

const READ_ONLY_PREFIXES = [
  'cat ', 'ls ', 'dir ', 'type ', 'head ', 'tail ', 'less ', 'more ', 'find ', 'grep ', 'rg ', 'ripgrep',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git ls-files', 'git ls-tree',
  'npm ls', 'npm outdated', 'npm audit', 'yarn list', 'pnpm list',
  'where ', 'which ', 'Get-ChildItem', 'Get-Content', 'ls ', 'dir ', 'tree ', 'fc ', 'findstr ', 'find ', 'Select-String',
  'ls ', 'pwd ', 'echo ', 'Write-Output', 'Write-Host',
];

const BUILD_PREFIXES = [
  'npm run', 'npm build', 'npm test', 'npm compile', 'npm start', 'npm dev',
  'yarn ', 'yarn build', 'yarn test', 'yarn start', 'yarn dev',
  'pnpm ', 'pnpm build', 'pnpm test', 'pnpm start', 'pnpm dev',
  'make ', 'cmake ', 'ninja ', 'bazel ', 'bazelisk ', 'mvn ', 'gradle ',
  'dotnet build', 'dotnet run', 'cargo build', 'cargo test', 'go build', 'go test', 'go run',
  'npx ', 'ts-node ', 'tsx ',
  'javac ', 'java ', 'gcc ', 'g++ ', 'clang ', 'make ', 'xcodebuild ', 'msbuild ',
  'webpack ', 'vite ', 'rollup ', 'esbuild ', 'tsc ', 'babel ', 'parcel ',
  'autoconf ', './configure',
];

const GIT_PREFIXES = [
  'git ', 'hub ', 'gh ', 'git-', 'gitflow-', 'git-lfs',
];

const FILE_WRITE_PREFIXES = [
  'npm install', 'npm i ', 'yarn add', 'yarn remove', 'pnpm add', 'pnpm remove', 'pnpm install',
  'cp ', 'copy ', 'mv ', 'move ', 'rm ', 'del ', 'rd ', 'rmdir ', 'mkdir ', 'md ',
  'New-Item', 'Set-Content', 'Add-Content', 'Out-File', '>', '>>',
  'touch ', '> ', '>> ',
];

const NETWORK_PREFIXES = [
  'curl ', 'wget ', 'http ', 'https ', 'nc ', 'netcat ', 'ncat ', 'socat ',
  'ssh ', 'scp ', 'rsync ', 'ftp ', 'sftp ', 'telnet ', 'ping ', 'traceroute ',
  'nslookup ', 'dig ', 'host ', 'curl ', 'wget ', 'Invoke-WebRequest', 'Invoke-RestMethod',
  'curl ', 'wget ', 'iwr ', 'irm ',
];

const PACKAGE_MANAGER_PREFIXES = [
  'npm ', 'yarn ', 'pnpm ', 'bun ', 'pip ', 'pip3 ', 'pipenv ', 'poetry ', 'conda ',
  'apt ', 'apt-get ', 'yum ', 'dnf ', 'brew ', 'choco ', 'scoop ', 'winget ', 'cargo ', 'nuget ',
];

const SYSTEM_PREFIXES = [
  'sudo ', 'su ', 'chmod ', 'chown ', 'chgrp ', 'umask ', 'setfacl ', 'getfacl ',
  'systemctl ', 'service ', 'launchctl ', 'brew services ', 'sc ', 'net ', 'sc config',
  'shutdown ', 'reboot ', 'halt ', 'poweroff ', 'init ', 'systemd-run',
  'Set-ExecutionPolicy', 'New-Service', 'Start-Service', 'Stop-Service', 'Restart-Service',
];

const DANGEROUS_PATTERNS = [
  { pattern: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(?:\/|\/\*|[a-zA-Z]:\\?)/i, severity: 'error', message: 'Recursive force deletion of root or wildcard paths is blocked in workspace mode.' },
  { pattern: /\brmdir(?:\s+\/[a-zA-Z])+\s+[a-zA-Z]:\\?/i, severity: 'error', message: 'Recursive directory removal of system paths is blocked in workspace mode.' },
  { pattern: /\bformat\s+[a-zA-Z]:/i, severity: 'error', message: 'Disk formatting commands are blocked in workspace mode.' },
  { pattern: /\bmkfs(?:\.[a-z0-9]+)?\s+/i, severity: 'error', message: 'Filesystem creation commands are blocked in workspace mode.' },
  { pattern: /\bdd\s+[^;|\n]*of=\/dev\/(?:sd|nvme|hd)/i, severity: 'error', message: 'Raw disk writes via dd are blocked in workspace mode.' },
  { pattern: /\bsudo\b/i, severity: 'warning', message: 'sudo is rarely needed inside the managed workspace root.' },
  { pattern: /\|\s*(?:rm|del|rd|rmdir)\b/i, severity: 'warning', message: 'Piping into a destructive deletion command is dangerous.' },
  { pattern: /\b(?:eval|exec)\s+\$/i, severity: 'warning', message: 'Dynamic eval of command output is risky; prefer explicit commands.' },
  { pattern: /\$\(/i, severity: 'warning', message: 'Command substitution $() bypasses static analysis; ensure the substituted command is safe.' },
  { pattern: /`/i, severity: 'info', message: 'Backtick command substitution detected; modern shells prefer $().' },
  { pattern: /\|\s*sh\b|\|\s*bash\b/i, severity: 'warning', message: 'Piping into a new shell instance is risky.' },
  { pattern: /\b(?:curl|wget|iwr|irm)\s+.*\|\s*(?:sh|bash|cmd|powershell)/i, severity: 'warning', message: 'Downloading and piping directly to a shell is a common injection vector.' },
];

function classifyCommand(command: string): CommandClassification {
  const trimmed = command.trim();
  const lower = trimmed.toLowerCase();
  const reasons: string[] = [];
  let kind: CommandClassification['kind'] = 'unknown';
  let confidence: CommandClassification['confidence'] = 'low';

  const match = (prefixes: string[], label: string): boolean => {
    return prefixes.some((p) => lower.startsWith(p));
  };

  const countMatches = (prefixes: string[]): number => {
    return prefixes.filter((p) => lower.startsWith(p)).length;
  };

  // Detect primary command
  if (match(GIT_PREFIXES, 'git')) {
    kind = 'git';
    reasons.push('Command starts with a git-related executable.');
    confidence = 'high';
  } else if (match(BUILD_PREFIXES, 'build')) {
    kind = 'build';
    reasons.push('Command matches common build/test runner patterns.');
    confidence = 'medium';
  } else if (match(PACKAGE_MANAGER_PREFIXES, 'package')) {
    kind = 'package-manager';
    reasons.push('Command matches a package manager.');
    confidence = 'medium';
  } else if (match(FILE_WRITE_PREFIXES, 'file-write')) {
    kind = 'file-write';
    reasons.push('Command appears to modify files or the filesystem.');
    confidence = 'medium';
  } else if (match(NETWORK_PREFIXES, 'network')) {
    kind = 'network';
    reasons.push('Command appears to perform network I/O.');
    confidence = 'medium';
  } else if (match(SYSTEM_PREFIXES, 'system')) {
    kind = 'system';
    reasons.push('Command appears to modify system state or permissions.');
    confidence = 'medium';
  } else if (match(READ_ONLY_PREFIXES, 'read-only')) {
    kind = 'read-only';
    reasons.push('Command matches common read-only inspection patterns.');
    confidence = 'medium';
  }

  // Detect interactive patterns
  if (/\b(?:vim|nano|vi|less|more|top|htop|btop|watch)\b/i.test(trimmed)) {
    reasons.push('Command appears to be interactive; it may not terminate cleanly in a managed shell.');
    if (kind === 'unknown') { kind = 'interactive'; confidence = 'high'; }
  }

  // Detect chaining
  if (/[;&|]\s*\w/.test(trimmed)) {
    reasons.push('Command contains chaining operators; the first command determines the primary classification.');
    if (confidence === 'low') confidence = 'low';
  }

  // Detect subshells
  if (/\([^)]*\)/.test(trimmed)) {
    reasons.push('Command contains subshell syntax; static analysis is approximate.');
  }

  // Suggested timeout based on classification
  let suggestedTimeoutMs: { min: number; max: number } | undefined;
  switch (kind) {
    case 'read-only':
      suggestedTimeoutMs = { min: 5_000, max: 30_000 };
      break;
    case 'build':
      suggestedTimeoutMs = { min: 30_000, max: 300_000 };
      break;
    case 'git':
      suggestedTimeoutMs = { min: 5_000, max: 60_000 };
      break;
    case 'file-write':
      suggestedTimeoutMs = { min: 5_000, max: 60_000 };
      break;
    case 'network':
      suggestedTimeoutMs = { min: 15_000, max: 120_000 };
      break;
    case 'package-manager':
      suggestedTimeoutMs = { min: 30_000, max: 300_000 };
      break;
    case 'system':
      suggestedTimeoutMs = { min: 10_000, max: 120_000 };
      break;
    case 'interactive':
      suggestedTimeoutMs = { min: 0, max: 0 };
      break;
  }

  // Preferred tool recommendation
  let preferredTool: string | undefined;
  if (kind === 'git' && !match(['git log', 'git show', 'git branch', 'git diff', 'git status', 'git ls-files', 'git ls-tree'], 'git-read')) {
    // Write git operations - still use shell or git tools
  } else if (kind === 'git' && match(['git log', 'git show', 'git branch', 'git diff', 'git status', 'git ls-files', 'git ls-tree'], 'git-read')) {
    preferredTool = 'git_log / git_diff / git_show / git_status';
  } else if (kind === 'read-only' && match(['cat ', 'head ', 'tail ', 'less ', 'more ', 'find ', 'grep ', 'rg ', 'ripgrep'], 'read-only-file')) {
    preferredTool = 'read_file / search_code / find_files';
  } else if (kind === 'file-write' && match(['npm install', 'yarn add', 'pnpm add', 'cp ', 'mv '], 'file-write-package')) {
    preferredTool = 'Use exec_process with explicit args instead of shell_command for package/file operations.';
  }

  if (reasons.length === 0) {
    reasons.push('Command type could not be determined from static analysis.');
  }

  return { kind, confidence, reasons, preferredTool, suggestedTimeoutMs };
}

function analyzeDangerousPatterns(command: string): CommandRecommendation[] {
  const recommendations: CommandRecommendation[] = [];
  for (const { pattern, severity, message } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      recommendations.push({
        type: severity === 'error' ? 'dangerous_pattern' : 'dangerous_pattern',
        message,
        severity: severity as CommandRecommendation['severity'],
      });
    }
  }
  return recommendations;
}

function buildRecommendation(classification: CommandClassification, command: string): CommandRecommendation | undefined {
  if (classification.kind === 'interactive') {
    return { type: 'use_start_process', message: 'This command appears interactive. Use start_process and poll with read_process_output.', severity: 'warning' };
  }
  if (classification.kind === 'build' || classification.kind === 'package-manager') {
    return { type: 'prefer_exec_process', message: 'Consider exec_process for deterministic builds without shell quoting issues.', severity: 'info' };
  }
  if (classification.preferredTool) {
    return { type: classification.kind === 'git' ? 'use_git_tool' : 'use_file_tool', message: classification.preferredTool, severity: 'info' };
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Shell wrappers                                                     */
/* ------------------------------------------------------------------ */

function wrapPowerShellCommand(command: string, marker: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    // Windows PowerShell inherits the active console/code-page encoding. The
    // parent process decodes pipes as UTF-8, so force both PowerShell output
    // and native-command output to the same encoding before any user code.
    '$utf8 = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = $utf8',
    '[Console]::OutputEncoding = $utf8',
    '[Console]::InputEncoding = $utf8',
    '$global:LASTEXITCODE = $null',
    'try {',
    '  & {',
    command,
    '  }',
    '  $chatgptMachineSucceeded = $?',
    '  $chatgptMachineNativeExit = $LASTEXITCODE',
    "  if (-not $chatgptMachineSucceeded) { throw 'PowerShell command reported failure.' }",
    '  if ($null -ne $chatgptMachineNativeExit -and $chatgptMachineNativeExit -ne 0) { exit $chatgptMachineNativeExit }',
    '} catch {',
    `  [Console]::Error.WriteLine('${marker}')`,
    '  [Console]::Error.WriteLine(($_ | Out-String))',
    '  exit 1',
    '}',
  ].join('\n');
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await access(current, constants.F_OK);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new ToolError('NOT_FOUND', `Cannot resolve an existing parent for: ${candidate}`);
      }
      current = parent;
    }
  }
}

export async function resolveMachinePath(
  accessConfig: MachineAccess,
  requestedPath: string,
  mustBeDirectory = false,
): Promise<string> {
  const resolvedRoot = await realpath(path.resolve(accessConfig.root));
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(resolvedRoot, requestedPath);

  const existing = await nearestExistingPath(candidate);
  const realExisting = await realpath(existing);
  if (!accessConfig.unrestricted && !isWithin(resolvedRoot, realExisting)) {
    throw new ToolError(
      'PATH_DENIED',
      `Path resolves outside the configured root: ${requestedPath}`,
      'A symbolic link in this path escapes the workspace root.',
      { root: resolvedRoot },
    );
  }

  if (mustBeDirectory) {
    const info = await stat(candidate);
    if (!info.isDirectory()) {
      throw new ToolError('NOT_A_DIRECTORY', `Path is not a directory: ${requestedPath}`);
    }
  }
  // `realExisting` is canonicalized above before the boundary check. This
  // accepts macOS /var and Windows 8.3 aliases while preserving the caller's
  // requested spelling as the returned working path.
  return candidate;
}

function selectShell(shell: ShellKind): {
  kind: Exclude<ShellKind, 'auto'>;
  executable: string;
  args: string[];
} {
  const selected = shell === 'auto' ? (process.platform === 'win32' ? 'powershell' : 'bash') : shell;
  if (selected === 'powershell') {
    return {
      kind: selected,
      executable: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
    };
  }
  if (selected === 'cmd') {
    if (process.platform !== 'win32') {
      throw new ToolError('INVALID_ARGUMENT', 'The cmd shell is only available on Windows.', 'Use "bash" or "auto" on this platform.');
    }
    return { kind: selected, executable: 'cmd.exe', args: ['/d', '/s', '/c'] };
  }
  return { kind: selected, executable: 'bash', args: ['-lc'] };
}

async function terminateProcessTree(child: import('node:child_process').ChildProcess): Promise<void> {
  if (!child.pid) {
    child.kill();
    return;
  }
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => {
        child.kill();
        resolve();
      });
      killer.once('close', () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

export async function runShellCommand(options: ShellCommandOptions): Promise<ShellCommandResult> {
  if (!options.command.trim()) throw new ToolError('INVALID_ARGUMENT', '"command" parameter is required.');
  if (options.shell && !['auto', 'bash', 'powershell', 'cmd'].includes(options.shell)) {
    throw new ToolError('INVALID_ARGUMENT', '"shell" must be one of: auto, bash, powershell, cmd.');
  }

  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > maxTimeoutMs) {
    throw new ToolError('INVALID_ARGUMENT', `"timeout_ms" must be between 100 and ${maxTimeoutMs}.`);
  }

  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new ToolError('INVALID_ARGUMENT', `"max_output_bytes" must be an integer between 1024 and ${MAX_OUTPUT_BYTES}.`);
  }

  if (!options.unrestricted) {
    const dangerous = /(?:^|[;&|\s])(?:rm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(?:\/|\/\*|[a-zA-Z]:\\?)|rmdir(?:\s+\/[a-zA-Z])+\s+[a-zA-Z]:\\?|format\s+[a-zA-Z]:|mkfs(?:\.[a-z0-9]+)?\s+|dd\s+[^;|\n]*of=\/dev\/(?:sd|nvme|hd))/i;
    if (dangerous.test(options.command)) {
      throw new ToolError('POLICY_DENIED', 'Catastrophic destructive command blocked by workspace guardrail.', 'Dangerous disk-formatting and root-deletion commands require --dangerously-open-machine.');
    }
  }

  const workdir = await resolveMachinePath(options, options.workdir || '.', true);
  const shell = selectShell(options.shell ?? 'auto');

  // Intelligence: classify the command and build recommendations
  const classification = classifyCommand(options.command);
  const recommendations = analyzeDangerousPatterns(options.command);
  const primaryRecommendation = buildRecommendation(classification, options.command);

  if (primaryRecommendation && primaryRecommendation.severity === 'error') {
    // Block only truly dangerous patterns
    throw new ToolError('POLICY_DENIED', primaryRecommendation.message, 'Review the command and consider a safer alternative.');
  }

  return await new Promise<ShellCommandResult>((resolve, reject) => {
    const powerShellErrorMarker = shell.kind === 'powershell'
      ? `${POWERSHELL_ERROR_MARKER_PREFIX}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`
      : undefined;
    const executedCommand = shell.kind === 'powershell'
      ? wrapPowerShellCommand(options.command, powerShellErrorMarker!)
      : shell.kind === 'cmd' && process.platform === 'win32'
        ? `chcp 65001>nul & ${options.command}`
        : options.command;
    const child = spawn(shell.executable, [...shell.args, executedCommand], {
      cwd: workdir,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (options.stdin !== undefined) {
      // A command that exits before draining stdin closes the pipe; that is not a tool failure.
      child.stdin?.on('error', () => {});
      child.stdin?.end(options.stdin, 'utf8');
    }
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let outputTruncated = false;
    let settled = false;
    let exitSignal: NodeJS.Signals | null = null;

    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (outputTruncated) return;
      const remaining = maxOutputBytes - outputBytes;
      const accepted = chunk.length <= remaining ? chunk : chunk.subarray(0, Math.max(0, remaining));
      outputBytes += accepted.length;
      if (target === 'stdout') stdout += stdoutDecoder.write(accepted);
      else stderr += stderrDecoder.write(accepted);
      if (accepted.length < chunk.length || outputBytes >= maxOutputBytes) {
        outputTruncated = true;
        void terminateProcessTree(child);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ToolError(
        'DEPENDENCY_MISSING',
        `Unable to start ${shell.kind}: ${error.message}`,
        `Confirm that ${shell.executable} exists on PATH, or choose another "shell".`,
      ));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child);
    }, timeoutMs);

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      exitSignal = signal ?? null;
      clearTimeout(timer);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      const hadPowerShellError = powerShellErrorMarker !== undefined && stderr.includes(powerShellErrorMarker);
      if (hadPowerShellError) {
        stderr = stderr
          .split(/\r?\n/)
          .filter((line) => line.trim() !== powerShellErrorMarker)
          .join(process.platform === 'win32' ? '\r\n' : '\n');
      }
      if (outputTruncated) {
        stderr += `${stderr ? '\n' : ''}Output reached the ${maxOutputBytes}-byte limit and the process tree was stopped.`;
      }

      // Collect all recommendations for the result
      const allRecommendations = [...recommendations];
      if (primaryRecommendation && !allRecommendations.some((r) => r.type === primaryRecommendation.type)) {
        allRecommendations.push(primaryRecommendation);
      }

      const success = exitCode === 0 && !timedOut && !outputTruncated && !hadPowerShellError;
      resolve({
        shell: shell.kind,
        command: options.command,
        workdir,
        exitCode,
        success,
        hadPowerShellError,
        stdout,
        stderr,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        timedOut,
        outputTruncated,
        durationMs: Date.now() - startedAt,
        classification,
        recommendation: allRecommendations[0],
        signal: exitSignal,
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Patch formats: Codex format + standard unified diff                */
/* ------------------------------------------------------------------ */

interface UnifiedDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface UnifiedDiffFile {
  oldPath: string;
  newPath: string;
  hunks: UnifiedDiffHunk[];
}

function parseUnifiedDiff(text: string): UnifiedDiffFile[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const files: UnifiedDiffFile[] = [];
  let current: UnifiedDiffFile | null = null;
  let currentHunk: UnifiedDiffHunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const diffGitMatch = /^diff --git "?([^"]+)"? "?([^"]+)"?$/.exec(line);
    if (diffGitMatch) {
      if (current) files.push(current);
      current = { oldPath: diffGitMatch[1]!, newPath: diffGitMatch[2]!, hunks: [] };
      currentHunk = null;
      continue;
    }
    const oldNewMatch = /^(---|\+\+\+)\s+"?([^"]+)"?$/.exec(line);
    if (oldNewMatch && current) {
      const prefix = oldNewMatch[1]!;
      let p = oldNewMatch[2]!;
      if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
      if (prefix === '---') current.oldPath = p;
      else current.newPath = p;
      continue;
    }
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch && current) {
      currentHunk = {
        oldStart: Number(hunkMatch[1]!),
        oldLines: hunkMatch[2] ? Number(hunkMatch[2]!) : 1,
        newStart: Number(hunkMatch[3]!),
        newLines: hunkMatch[4] ? Number(hunkMatch[4]!) : 1,
        lines: [],
      };
      current.hunks.push(currentHunk);
      continue;
    }
    if (currentHunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\'))) {
      currentHunk.lines.push(line);
    }
  }
  if (current) files.push(current);
  return files;
}

function applyUnifiedDiff(original: string, hunks: UnifiedDiffHunk[]): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = original.endsWith('\n');
  const fileLines = original.replace(/\r\n/g, '\n').split('\n');
  if (trailingNewline) fileLines.pop();
  let cursor = 0;

  for (const hunk of hunks) {
    const oldLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.startsWith('-') || line.startsWith(' ')) oldLines.push(line.slice(1));
    }
    const newLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.startsWith('+') || line.startsWith(' ')) newLines.push(line.slice(1));
    }
    let matchAt = findSequence(fileLines, oldLines, cursor);
    if (matchAt < 0) matchAt = findSequence(fileLines, oldLines, 0);
    if (matchAt < 0) {
      throw new ToolError('NO_MATCH', `Could not find patch context.`, 'Re-read the file and rebuild the hunk from its current contents.');
    }
    fileLines.splice(matchAt, oldLines.length, ...newLines);
    cursor = matchAt + newLines.length;
  }
  return fileLines.join(eol) + (trailingNewline ? eol : '');
}

function findSequence(haystack: string[], needle: string[], start: number): number {
  if (needle.length === 0) return start;
  for (let index = start; index <= haystack.length - needle.length; index++) {
    if (needle.every((line, offset) => haystack[index + offset] === line)) return index;
  }
  return -1;
}

function parsePatch(patchText: string): PatchOperation[] {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '*** Begin Patch') {
    throw new ToolError('PATCH_INVALID', 'Patch must start with "*** Begin Patch".');
  }

  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length && lines[index] !== '*** End Patch') {
    const header = lines[index++];
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(header);
    if (!match) {
      throw new ToolError(
        'PATCH_INVALID',
        `Invalid patch operation header: ${header}`,
        'Headers must read "*** Add File: <path>", "*** Update File: <path>", or "*** Delete File: <path>".',
      );
    }

    const operation: PatchOperation = {
      kind: match[1].toLowerCase() as PatchOperation['kind'],
      filePath: match[2],
      lines: [],
    };
    if (operation.kind === 'update' && lines[index]?.startsWith('*** Move to: ')) {
      operation.moveTo = lines[index++].slice('*** Move to: '.length);
    }
    while (
      index < lines.length &&
      !lines[index].startsWith('*** Add File: ') &&
      !lines[index].startsWith('*** Update File: ') &&
      !lines[index].startsWith('*** Delete File: ') &&
      lines[index] !== '*** End Patch'
    ) {
      operation.lines.push(lines[index++]);
    }
    operations.push(operation);
  }

  if (lines[index] !== '*** End Patch') {
    throw new ToolError('PATCH_INVALID', 'Patch must end with "*** End Patch".');
  }
  if (operations.length === 0) throw new ToolError('PATCH_INVALID', 'Patch contains no file operations.');
  return operations;
}

function applyUpdate(original: string, patchLines: string[], filePath: string): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = original.endsWith('\n');
  const fileLines = original.replace(/\r\n/g, '\n').split('\n');
  if (trailingNewline) fileLines.pop();
  let cursor = 0;
  let index = 0;
  let sawHunk = false;

  while (index < patchLines.length) {
    if (!patchLines[index].startsWith('@@')) {
      if (patchLines[index] === '') {
        index++;
        continue;
      }
      throw new ToolError('PATCH_INVALID', `Expected "@@" hunk header while updating ${filePath}.`);
    }
    sawHunk = true;
    index++;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    while (index < patchLines.length && !patchLines[index].startsWith('@@')) {
      const line = patchLines[index++];
      if (!line || ![' ', '+', '-'].includes(line[0])) {
        throw new ToolError(
          'PATCH_INVALID',
          `Invalid hunk line while updating ${filePath}: ${line}`,
          'Every hunk line must begin with a space, "+", or "-".',
        );
      }
      const content = line.slice(1);
      if (line[0] !== '+') oldLines.push(content);
      if (line[0] !== '-') newLines.push(content);
    }

    let matchAt = findSequence(fileLines, oldLines, cursor);
    if (matchAt < 0) matchAt = findSequence(fileLines, oldLines, 0);
    if (matchAt < 0) {
      throw new ToolError(
        'NO_MATCH',
        `Could not find patch context in ${filePath}.`,
        'Re-read the file and rebuild the hunk from its current contents.',
      );
    }
    fileLines.splice(matchAt, oldLines.length, ...newLines);
    cursor = matchAt + newLines.length;
  }

  if (!sawHunk) throw new ToolError('PATCH_INVALID', `Update for ${filePath} contains no hunks.`);
  return fileLines.join(eol) + (trailingNewline ? eol : '');
}

export async function applyFilePatch(accessConfig: MachineAccess, patchText: string, dryRun = false, expectedHashes?: Record<string, string>): Promise<string[]> {
  const trimmed = patchText.trim();

  // Detect format: unified diff vs Codex patch
  const isUnifiedDiff = /^diff --git/.test(trimmed);
  const operations: Array<PatchOperation & { source: string; destination?: string; content?: string; originalHash?: string; unifiedFile?: UnifiedDiffFile }> = [];
  const claimedPaths = new Set<string>();
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');

  if (isUnifiedDiff) {
    const files = parseUnifiedDiff(trimmed);
    if (files.length === 0) throw new ToolError('PATCH_INVALID', 'Unified diff contains no file entries.');

    for (const file of files) {
      // Skip files with no hunks — they are no-ops.
      if (file.hunks.length === 0) continue;
      const source = await resolveMachinePath(accessConfig, file.oldPath);
      const destination = file.newPath !== file.oldPath ? await resolveMachinePath(accessConfig, file.newPath) : undefined;
      for (const claimedPath of [source, destination].filter((value): value is string => Boolean(value))) {
        const key = process.platform === 'win32' ? claimedPath.toLowerCase() : claimedPath;
        if (claimedPaths.has(key)) {
          throw new ToolError('PATCH_INVALID', `A patch may only operate on each path once: ${claimedPath}`);
        }
        claimedPaths.add(key);
      }
      if (destination) {
        try {
          await access(destination);
          throw new ToolError('ALREADY_EXISTS', `Cannot move file because the destination already exists: ${file.newPath}`);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        }
      }
      const original = await readFile(source, 'utf8');
      const originalHashVal = hash(original);
      if (expectedHashes && expectedHashes[file.oldPath]?.toLowerCase() !== originalHashVal) {
        throw new ToolError('PRECONDITION_FAILED', `File changed: ${file.oldPath}`, 'Read all affected files again before retrying.');
      }
      operations.push({
        kind: destination ? 'update' : 'update',
        filePath: file.oldPath,
        moveTo: destination,
        lines: [],
        source,
        destination,
        unifiedFile: file,
        originalHash: originalHashVal,
      });
    }
  } else {
    const parsedOps = parsePatch(trimmed);
    if (expectedHashes) {
      for (const [file, value] of Object.entries(expectedHashes)) {
        if (!/^[a-f0-9]{64}$/i.test(value) || !parsedOps.some((op) => op.filePath === file && op.kind !== 'add')) {
          throw new ToolError('INVALID_ARGUMENT', 'expected_sha256 must map updated/deleted source paths to SHA-256 hashes.');
        }
      }
      for (const operation of parsedOps) if (operation.kind !== 'add' && !Object.hasOwn(expectedHashes, operation.filePath)) {
        throw new ToolError('INVALID_ARGUMENT', `Missing expected hash for ${operation.filePath}.`);
      }
    }

    for (const operation of parsedOps) {
      const source = await resolveMachinePath(accessConfig, operation.filePath);
      const destination = operation.moveTo
        ? await resolveMachinePath(accessConfig, operation.moveTo)
        : undefined;
      for (const claimedPath of [source, destination].filter((value): value is string => Boolean(value))) {
        const key = process.platform === 'win32' ? claimedPath.toLowerCase() : claimedPath;
        if (claimedPaths.has(key)) {
          throw new ToolError('PATCH_INVALID', `A patch may only operate on each path once: ${claimedPath}`);
        }
        claimedPaths.add(key);
      }
      if (destination) {
        try {
          await access(destination);
          throw new ToolError('ALREADY_EXISTS', `Cannot move file because the destination already exists: ${operation.moveTo}`);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        }
      }
      if (operation.kind === 'add') {
        try {
          await access(source);
          throw new ToolError(
            'ALREADY_EXISTS',
            `Cannot add file because it already exists: ${operation.filePath}`,
            'Use an "*** Update File" operation instead.',
          );
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        }
        if (operation.lines.some((line) => !line.startsWith('+'))) {
          throw new ToolError('PATCH_INVALID', `Every content line for an added file must start with "+": ${operation.filePath}`);
        }
        operations.push({
          ...operation,
          source,
          content: operation.lines.map((line) => line.slice(1)).join('\n') + '\n',
        });
        continue;
      }

      const original = await readFile(source, 'utf8');
      const originalHashVal = hash(original);
      if (expectedHashes && expectedHashes[operation.filePath].toLowerCase() !== originalHashVal) {
        throw new ToolError('PRECONDITION_FAILED', `File changed: ${operation.filePath}`, 'Read all affected files again before retrying.');
      }
      if (operation.kind === 'delete') {
        if (operation.lines.some((line) => line !== '')) {
          throw new ToolError('PATCH_INVALID', `Delete operation must not contain content: ${operation.filePath}`);
        }
        operations.push({ ...operation, source, originalHash: originalHashVal });
      } else {
        operations.push({
          ...operation,
          source,
          destination,
          content: applyUpdate(original, operation.lines, operation.filePath),
          originalHash: originalHashVal,
        });
      }
    }
  }

  const describe = (operation: (typeof operations)[number]): string => operation.kind === 'delete'
    ? `deleted ${operation.filePath}`
    : operation.destination
      ? `moved ${operation.filePath} -> ${operation.moveTo}`
      : `${operation.kind === 'add' ? 'added' : 'updated'} ${operation.filePath}`;
  if (dryRun) return operations.map(describe);

  const check = async (operation: (typeof operations)[number]) => {
    if (await resolveMachinePath(accessConfig, operation.filePath) !== operation.source) throw new ToolError('PRECONDITION_FAILED', 'Patch path changed during preparation.');
    if (operation.originalHash && hash(await readFile(operation.source, 'utf8')) !== operation.originalHash) throw new ToolError('PRECONDITION_FAILED', `File changed during patch preparation: ${operation.filePath}`);
    if (operation.destination && await resolveMachinePath(accessConfig, operation.moveTo!) !== operation.destination) throw new ToolError('PRECONDITION_FAILED', 'Move destination changed during preparation.');
  };
  // Validate every source before the first write, and again immediately before its own mutation.
  for (const operation of operations) await check(operation);
  const changed: string[] = [];
  for (const operation of operations) {
    let mutationStarted = false;
    try {
      await check(operation);
      if (operation.kind === 'delete') {
        mutationStarted = true;
        await rm(operation.source);
      } else {
        const target = operation.destination ?? operation.source;
        await mkdir(path.dirname(target), { recursive: true });
        mutationStarted = true;
        // Exclusive creation ensures add/move never overwrite a newly created destination.
        const content = operation.unifiedFile
          ? applyUnifiedDiff(await readFile(operation.source, 'utf8'), operation.unifiedFile.hunks)
          : operation.content!;
        await writeFile(target, content, { encoding: 'utf8', flag: operation.kind === 'add' || operation.destination ? 'wx' : 'w' });
        if (operation.destination) await rm(operation.source);
      }
      changed.push(describe(operation));
    } catch (error) {
      if (!changed.length && !mutationStarted) throw error;
      throw new ToolError('PATCH_PARTIAL_FAILURE', 'Patch did not finish; inspect the reported paths before retrying.',
        'Filesystem patches are not multi-file atomic transactions.', {
          completed: changed, failedPath: operation.filePath,
          possiblyChanged: mutationStarted ? [operation.source, ...(operation.destination ? [operation.destination] : [])] : [],
          cause: error instanceof Error ? error.message : String(error),
        });
    }
  }
  return changed;
}
