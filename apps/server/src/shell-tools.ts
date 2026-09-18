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

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
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
      });
    });
  });
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

function findSequence(haystack: string[], needle: string[], start: number): number {
  if (needle.length === 0) return start;
  for (let index = start; index <= haystack.length - needle.length; index++) {
    if (needle.every((line, offset) => haystack[index + offset] === line)) return index;
  }
  return -1;
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
  const operations = parsePatch(patchText);
  const prepared: Array<PatchOperation & { source: string; destination?: string; content?: string; originalHash?: string }> = [];
  const claimedPaths = new Set<string>();
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  if (expectedHashes) {
    for (const [file, value] of Object.entries(expectedHashes)) {
      if (!/^[a-f0-9]{64}$/i.test(value) || !operations.some(op => op.filePath === file && op.kind !== 'add')) throw new ToolError('INVALID_ARGUMENT', 'expected_sha256 must map updated/deleted source paths to SHA-256 hashes.');
    }
    for (const operation of operations) if (operation.kind !== 'add' && !Object.hasOwn(expectedHashes, operation.filePath)) throw new ToolError('INVALID_ARGUMENT', `Missing expected hash for ${operation.filePath}.`);
  }

  for (const operation of operations) {
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
      prepared.push({
        ...operation,
        source,
        content: operation.lines.map((line) => line.slice(1)).join('\n') + '\n',
      });
      continue;
    }

    const original = await readFile(source, 'utf8');
    const originalHash = hash(original);
    if (expectedHashes && expectedHashes[operation.filePath].toLowerCase() !== originalHash) throw new ToolError('PRECONDITION_FAILED', `File changed: ${operation.filePath}`, 'Read all affected files again before retrying.');
    if (operation.kind === 'delete') {
      if (operation.lines.some((line) => line !== '')) {
        throw new ToolError('PATCH_INVALID', `Delete operation must not contain content: ${operation.filePath}`);
      }
      prepared.push({ ...operation, source, originalHash });
    } else {
      prepared.push({
        ...operation,
        source,
        destination,
        content: applyUpdate(original, operation.lines, operation.filePath),
        originalHash,
      });
    }
  }

  const describe = (operation: (typeof prepared)[number]): string => operation.kind === 'delete'
    ? `deleted ${operation.filePath}`
    : operation.destination
      ? `moved ${operation.filePath} -> ${operation.moveTo}`
      : `${operation.kind === 'add' ? 'added' : 'updated'} ${operation.filePath}`;
  if (dryRun) return prepared.map(describe);

  const check = async (operation: (typeof prepared)[number]) => {
    if (await resolveMachinePath(accessConfig, operation.filePath) !== operation.source) throw new ToolError('PRECONDITION_FAILED', 'Patch path changed during preparation.');
    if (operation.originalHash && hash(await readFile(operation.source, 'utf8')) !== operation.originalHash) throw new ToolError('PRECONDITION_FAILED', `File changed during patch preparation: ${operation.filePath}`);
    if (operation.destination && await resolveMachinePath(accessConfig, operation.moveTo!) !== operation.destination) throw new ToolError('PRECONDITION_FAILED', 'Move destination changed during preparation.');
  };
  // Validate every source before the first write, and again immediately before its own mutation.
  for (const operation of prepared) await check(operation);
  const changed: string[] = [];
  for (const operation of prepared) {
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
        await writeFile(target, operation.content!, { encoding: 'utf8', flag: operation.kind === 'add' || operation.destination ? 'wx' : 'w' });
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
