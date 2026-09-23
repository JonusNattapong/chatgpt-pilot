import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { access, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ToolError } from './errors.js';
import { resolveMachinePath, type MachineAccess } from './shell-tools.js';

const MAX_BINARY_READ_BYTES = 16 * 1024 * 1024;
const MAX_BINARY_CHUNK_BYTES = 1 * 1024 * 1024;

const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_SEARCH_RESULTS = 2_000;
const MAX_DIRECTORY_ENTRIES = 5_000;
const MAX_IMAGE_REDIRECTS = 3;
const MAX_CONTEXT_LINES = 10;
const FALLBACK_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Directories that are almost never the subject of a question but dominate the
 * cost and the result set of a recursive walk. Callers can opt back in with
 * "include_ignored" or replace the list with "exclude".
 */
const DEFAULT_EXCLUDED_DIRECTORIES = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.gradle',
  '.idea',
  '.cache',
];

export interface ReadFileOptions extends MachineAccess {
  filePath: string;
  startLine?: number;
  maxLines?: number;
  maxBytes?: number;
  lineNumbers?: boolean;
  encoding?: BufferEncoding;
}

export interface WriteFileOptions extends MachineAccess {
  filePath: string;
  content: string;
  overwrite?: boolean;
  expectedSha256?: string;
  encoding?: BufferEncoding;
}

export interface EditFileOptions extends MachineAccess {
  filePath: string;
  oldText?: string;
  newText?: string;
  replaceAll?: boolean;
  expectedReplacements?: number;
  expectedSha256?: string;
  dryRun?: boolean;
  edits?: TransactionalEdit[];
  encoding?: BufferEncoding;
}

export interface TransactionalEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  expectedReplacements?: number;
}

export interface UpdateFileOptions extends MachineAccess {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  expectedSha256?: string;
  encoding?: BufferEncoding;
}

export interface ReadBinaryFileOptions extends MachineAccess {
  filePath: string;
  maxBytes?: number;
  offsetBytes?: number;
}

export interface SearchCodeOptions extends MachineAccess {
  pattern: string;
  searchPath?: string;
  globs?: string[];
  caseSensitive?: boolean;
  literal?: boolean;
  maxResults?: number;
  timeoutMs?: number;
  contextLines?: number;
  filesOnly?: boolean;
  maxMatchesPerFile?: number;
}

export interface ListDirectoryOptions extends MachineAccess {
  directoryPath?: string;
  maxEntries?: number;
  includeHidden?: boolean;
  cursor?: string;
}

export interface FindFilesOptions extends MachineAccess {
  directoryPath?: string;
  glob?: string;
  maxResults?: number;
  maxDepth?: number;
  includeHidden?: boolean;
  exclude?: string[];
  includeIgnored?: boolean;
  cursor?: string;
}

export interface FileInfoOptions extends MachineAccess {
  filePath: string;
  includeHash?: boolean;
}

export interface SaveImageFromUrlOptions extends MachineAccess {
  url: string;
  filePath: string;
  overwrite?: boolean;
}

export interface ImageInfoOptions extends MachineAccess {
  filePath: string;
}

interface TextFile {
  absolutePath: string;
  content: string;
  sha256: string;
  eol: '\n' | '\r\n';
  trailingNewline: boolean;
  lines: string[];
}

function hashText(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Optimistic concurrency for a remote caller: the model reads a file, reasons for
 * a while, then writes. "expected_sha256" turns a silent lost update into an
 * explicit, recoverable failure.
 */
function assertExpectedSha256(expected: string | undefined, actual: string | undefined, filePath: string): void {
  if (expected === undefined) return;
  const normalized = expected.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new ToolError('INVALID_ARGUMENT', '"expected_sha256" must be a 64-character hexadecimal SHA-256 digest.');
  }
  if (normalized !== actual) {
    throw new ToolError(
      'PRECONDITION_FAILED',
      `File has changed since it was read: ${filePath}`,
      'Re-read the file, rebuild the change against its current contents, then retry.',
      { expectedSha256: normalized, actualSha256: actual ?? null },
    );
  }
}

async function loadTextFile(accessConfig: MachineAccess, requestedPath: string, encoding: BufferEncoding = 'utf8'): Promise<TextFile> {
  const absolutePath = await resolveMachinePath(accessConfig, requestedPath);
  const info = await stat(absolutePath);
  if (!info.isFile()) {
    throw new ToolError('NOT_A_FILE', `Path is not a file: ${requestedPath}`);
  }
  if (info.size > MAX_TEXT_FILE_BYTES) {
    throw new ToolError(
      'TOO_LARGE',
      `File exceeds the ${MAX_TEXT_FILE_BYTES}-byte text file limit: ${requestedPath}`,
      'Use shell_command with a streaming tool for files this large.',
      { bytes: info.size, limit: MAX_TEXT_FILE_BYTES },
    );
  }

  const buffer = await readFile(absolutePath);
  if (encoding.toLowerCase() === 'utf8' && buffer.includes(0)) {
    throw new ToolError(
      'BINARY_FILE',
      `File appears to be binary: ${requestedPath}`,
      'Use file_info or image_info to inspect non-text files.',
    );
  }
  const content = buffer.toString(encoding);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = content.endsWith('\n');
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (trailingNewline) lines.pop();
  return { absolutePath, content, sha256: hashText(content), eol, trailingNewline, lines };
}

function validatePositiveInteger(value: number, name: string, maximum?: number): void {
  if (!Number.isInteger(value) || value < 1 || (maximum !== undefined && value > maximum)) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `"${name}" must be an integer between 1 and ${maximum ?? 'the supported limit'}.`,
    );
  }
}

function validateBoundedInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must be an integer between ${minimum} and ${maximum}.`);
  }
}

/** Collapses whitespace so near-miss diagnostics survive indentation drift. */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function replacementLines(content: string): string[] {
  if (content === '') return [];
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) lines.pop();
  return lines;
}

function fileType(info: Awaited<ReturnType<typeof lstat>>): 'file' | 'directory' | 'symlink' | 'other' {
  if (info.isFile()) return 'file';
  if (info.isDirectory()) return 'directory';
  if (info.isSymbolicLink()) return 'symlink';
  return 'other';
}

function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  const normalized = glob.replace(/\\/g, '/');
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index++;
        if (normalized[index + 1] === '/') {
          index++;
          pattern += '(?:.*/)?';
        } else {
          pattern += '.*';
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${pattern}$`, process.platform === 'win32' ? 'i' : '');
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
  }
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
}

async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== 'https:') throw new ToolError('INVALID_ARGUMENT', 'Image URL must use HTTPS.');
  if (url.username || url.password) {
    throw new ToolError('INVALID_ARGUMENT', 'Image URL must not contain credentials.');
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new ToolError(
      'PATH_DENIED',
      'Image URL resolves to a private or local network address.',
      'Only public HTTPS hosts may be fetched.',
    );
  }
}

function imageMetadata(buffer: Buffer): { mimeType: string; width?: number; height?: number } {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR') {
    return { mimeType: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    if (buffer.toString('ascii', 12, 16) === 'VP8X' && buffer.length >= 30) {
      return { mimeType: 'image/webp', width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
    return { mimeType: 'image/webp' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { mimeType: 'image/jpeg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
    return { mimeType: 'image/jpeg' };
  }
  throw new ToolError('INVALID_ARGUMENT', 'File is not a supported PNG, JPEG, or WebP image.');
}

export async function saveImageFromUrl(options: SaveImageFromUrlOptions) {
  let current = new URL(options.url);
  for (let redirect = 0; redirect <= MAX_IMAGE_REDIRECTS; redirect++) {
    await assertPublicHost(current);
    const response = await fetch(current, { redirect: 'manual', headers: { accept: 'image/png,image/jpeg,image/webp' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw new ToolError('NETWORK', `Image server returned redirect ${response.status} without a location.`);
      }
      if (redirect === MAX_IMAGE_REDIRECTS) throw new ToolError('NETWORK', 'Too many image redirects.');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new ToolError('NETWORK', `Image download failed with HTTP ${response.status}.`);
    const body = Buffer.from(await response.arrayBuffer());
    const metadata = imageMetadata(body);
    const absolutePath = await resolveMachinePath(options, options.filePath);
    const existed = await access(absolutePath).then(() => true, () => false);
    if (existed && !options.overwrite) {
      throw new ToolError(
        'ALREADY_EXISTS',
        `File already exists; set "overwrite" to true to replace it: ${options.filePath}`,
      );
    }
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, body, { flag: options.overwrite ? 'w' : 'wx' });
    return { path: absolutePath, url: current.toString(), ...metadata, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), created: !existed, overwritten: existed };
  }
  throw new ToolError('NETWORK', 'Image download did not complete.');
}

export async function imageInfo(options: ImageInfoOptions) {
  const absolutePath = await resolveMachinePath(options, options.filePath);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new ToolError('NOT_A_FILE', `Path is not a file: ${options.filePath}`);
  const metadata = imageMetadata(await readFile(absolutePath));
  return { path: absolutePath, ...metadata, bytes: info.size, sha256: await sha256File(absolutePath), modifiedAt: info.mtime.toISOString() };
}

export async function listDirectory(options: ListDirectoryOptions) {
  const directoryPath = options.directoryPath ?? '.';
  const maxEntries = options.maxEntries ?? 500;
  validatePositiveInteger(maxEntries, 'max_entries', MAX_DIRECTORY_ENTRIES);
  const absolutePath = await resolveMachinePath(options, directoryPath, true);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const visibleEntries = entries
    .filter((entry) => options.includeHidden || !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const startIndex = decodeCursor(options.cursor, visibleEntries.length);
  const selected = visibleEntries.slice(startIndex, startIndex + maxEntries);
  const entriesWithMetadata = await Promise.all(selected.map(async (entry) => {
    const entryPath = path.join(absolutePath, entry.name);
    const type = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'other';
    // Metadata is best-effort: a race or a broken symlink must not fail the listing.
    const info = await lstat(entryPath).catch(() => undefined);
    return {
      name: entry.name,
      path: entryPath,
      type,
      bytes: type === 'file' ? info?.size : undefined,
      modifiedAt: info?.mtime.toISOString(),
    };
  }));
  const nextIndex = startIndex + selected.length;
  return {
    path: absolutePath,
    entries: entriesWithMetadata,
    totalEntries: visibleEntries.length,
    truncated: nextIndex < visibleEntries.length,
    cursor: nextIndex < visibleEntries.length ? encodeCursor(nextIndex) : undefined,
    nextCursor: nextIndex < visibleEntries.length ? encodeCursor(nextIndex) : undefined,
  };
}

function encodeCursor(index: number): string {
  return Buffer.from(String(index), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, max: number): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const value = Number(decoded);
    if (!Number.isInteger(value) || value < 0 || value > max) throw new ToolError('INVALID_ARGUMENT', `Invalid directory cursor: ${cursor}.`);
    return value;
  } catch (error) {
    if ((error as ToolError)?.code === 'INVALID_ARGUMENT') throw error;
    throw new ToolError('INVALID_ARGUMENT', `Invalid directory cursor: ${cursor}.`);
  }
}

interface WalkOptions {
  root: string;
  maxDepth: number;
  includeHidden?: boolean;
  exclude?: string[];
  includeIgnored?: boolean;
  accept: (relativePath: string) => boolean;
  onFile: (absolutePath: string, relativePath: string) => boolean | Promise<boolean>;
}

/**
 * Deterministic, budget-aware recursive walk shared by find_files and the
 * built-in search fallback. Returns true when the walk stopped early.
 */
async function walkFiles(options: WalkOptions): Promise<{ stopped: boolean; excludedDirectories: string[] }> {
  const excluded = options.includeIgnored ? [] : [...DEFAULT_EXCLUDED_DIRECTORIES, ...(options.exclude ?? [])];
  const excludedSet = new Set(excluded.map((name) => name.toLowerCase()));
  const skipped = new Set<string>();
  let stopped = false;

  const visit = async (currentPath: string, relativePath: string, depth: number): Promise<void> => {
    if (stopped) return;
    // A directory that disappeared or is not readable must not abort the whole walk.
    const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (stopped) return;
      if (!options.includeHidden && entry.name.startsWith('.')) continue;
      const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (excludedSet.has(entry.name.toLowerCase())) {
          skipped.add(entry.name);
          continue;
        }
        if (depth < options.maxDepth) await visit(entryPath, entryRelativePath, depth + 1);
      } else if (entry.isFile() && options.accept(entryRelativePath)) {
        if (!(await options.onFile(entryPath, entryRelativePath))) stopped = true;
      }
    }
  };

  await visit(options.root, '', 0);
  return { stopped, excludedDirectories: [...skipped].sort() };
}

export async function findFiles(options: FindFilesOptions) {
  const directoryPath = options.directoryPath ?? '.';
  const maxResults = options.maxResults ?? 500;
  const maxDepth = options.maxDepth ?? 25;
  validatePositiveInteger(maxResults, 'max_results', MAX_DIRECTORY_ENTRIES);
  validatePositiveInteger(maxDepth, 'max_depth', 100);
  const absolutePath = await resolveMachinePath(options, directoryPath, true);
  const pattern = options.glob ?? '**/*';
  const matcher = globToRegExp(pattern);
  const startIndex = decodeFindCursor(options.cursor);
  const matches: string[] = [];
  let totalSeen = 0;

  const { stopped, excludedDirectories } = await walkFiles({
    root: absolutePath,
    maxDepth,
    includeHidden: options.includeHidden,
    exclude: options.exclude,
    includeIgnored: options.includeIgnored,
    accept: (relativePath) => matcher.test(relativePath),
    onFile: (entryPath) => {
      if (totalSeen < startIndex) {
        totalSeen++;
        return true;
      }
      matches.push(entryPath);
      totalSeen++;
      return matches.length < maxResults;
    },
  });

  const nextIndex = startIndex + matches.length;
  return {
    path: absolutePath,
    glob: pattern,
    matches,
    truncated: stopped || totalSeen < startIndex + matches.length,
    excludedDirectories,
    cursor: stopped || totalSeen < startIndex + matches.length ? encodeCursor(nextIndex) : undefined,
    nextCursor: stopped || totalSeen < startIndex + matches.length ? encodeCursor(nextIndex) : undefined,
  };
}

function decodeFindCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const value = Number(decoded);
    if (!Number.isInteger(value) || value < 0) throw new ToolError('INVALID_ARGUMENT', `Invalid find cursor: ${cursor}.`);
    return value;
  } catch (error) {
    if ((error as ToolError)?.code === 'INVALID_ARGUMENT') throw error;
    throw new ToolError('INVALID_ARGUMENT', `Invalid find cursor: ${cursor}.`);
  }
}

export async function fileInfo(options: FileInfoOptions) {
  const absolutePath = await resolveMachinePath(options, options.filePath);
  const info = await lstat(absolutePath);
  const type = fileType(info);
  return {
    path: absolutePath,
    type,
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    createdAt: info.birthtime.toISOString(),
    sha256: options.includeHash === false || type !== 'file' ? undefined : await sha256File(absolutePath),
  };
}

export async function readMachineFile(options: ReadFileOptions) {
  const file = await loadTextFile(options, options.filePath, options.encoding ?? 'utf8');
  const startLine = options.startLine ?? 1;
  const maxLines = options.maxLines ?? 1_000;
  const maxBytes = options.maxBytes ?? MAX_READ_BYTES;
  validatePositiveInteger(startLine, 'start_line');
  validatePositiveInteger(maxLines, 'max_lines', 10_000);
  validatePositiveInteger(maxBytes, 'max_bytes', MAX_READ_BYTES);

  if (startLine > Math.max(1, file.lines.length)) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `"start_line" exceeds the file length of ${file.lines.length} lines.`,
      `This file has ${file.lines.length} lines.`,
      { totalLines: file.lines.length },
    );
  }

  const selected: string[] = [];
  let bytes = 0;
  for (const line of file.lines.slice(startLine - 1, startLine - 1 + maxLines)) {
    const lineBytes = Buffer.byteLength(line + file.eol);
    if (selected.length > 0 && bytes + lineBytes > maxBytes) break;
    selected.push(line);
    bytes += lineBytes;
    if (bytes >= maxBytes) break;
  }
  const endLine = selected.length === 0 ? startLine - 1 : startLine + selected.length - 1;
  const numberWidth = String(endLine).length;
  const rendered = options.lineNumbers
    ? selected.map((line, offset) => `${String(startLine + offset).padStart(numberWidth, ' ')}\t${line}`)
    : selected;
  const encoding = options.encoding ?? 'utf8';
  const content = rendered.join(file.eol);
  return {
    path: file.absolutePath,
    startLine,
    endLine,
    totalLines: file.lines.length,
    truncated: endLine < file.lines.length,
    lineNumbers: options.lineNumbers === true,
    encoding,
    // Callers pass this back as "expected_sha256" to make a later write safe.
    sha256: file.sha256,
    content,
  };
}

export async function readBinaryFile(options: ReadBinaryFileOptions) {
  const absolutePath = await resolveMachinePath(options, options.filePath);
  const info = await stat(absolutePath);
  if (!info.isFile()) {
    throw new ToolError('NOT_A_FILE', `Path is not a file: ${options.filePath}`);
  }
  const maxBytes = options.maxBytes ?? MAX_BINARY_READ_BYTES;
  validatePositiveInteger(maxBytes, 'max_bytes', MAX_BINARY_READ_BYTES);
  const offsetBytes = options.offsetBytes ?? 0;
  if (offsetBytes < 0 || offsetBytes >= info.size) {
    throw new ToolError('INVALID_ARGUMENT', `"offset_bytes" must be between 0 and file size ${info.size}.`);
  }

  const remaining = Math.min(maxBytes, info.size - offsetBytes);
  const buffer = Buffer.allocUnsafe(remaining);
  let readBytes = 0;
  const stream = createReadStream(absolutePath, { start: offsetBytes, end: offsetBytes + remaining - 1, highWaterMark: MAX_BINARY_CHUNK_BYTES });
  for await (const chunk of stream) {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunkBuffer.copy(buffer, readBytes);
    readBytes += chunkBuffer.length;
    if (readBytes >= remaining) break;
  }
  return {
    path: absolutePath,
    offsetBytes,
    bytes: readBytes,
    truncated: offsetBytes + readBytes < info.size,
    totalBytes: info.size,
    mimeType: guessBinaryMimeType(absolutePath, buffer),
    sha256: createHash('sha256').update(buffer.slice(0, readBytes)).digest('hex'),
    data: buffer.slice(0, readBytes).toString('base64'),
  };
}

function guessBinaryMimeType(filePath: string, buffer: Buffer): string {
  const ext = path.extname(filePath).toLowerCase();
  const byExt: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.exe': 'application/x-msdownload',
    '.dll': 'application/x-msdownload',
    '.so': 'application/x-sharedlib',
    '.dylib': 'application/x-mach-binary',
    '.wasm': 'application/wasm',
  };
  if (byExt[ext]) return byExt[ext];
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'application/zip';
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) return 'application/pdf';
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) return 'application/gzip';
  return 'application/octet-stream';
}

export async function writeMachineFile(options: WriteFileOptions) {
  const absolutePath = await resolveMachinePath(options, options.filePath);
  const existed = await access(absolutePath).then(() => true, () => false);
  if (existed && !options.overwrite) {
    throw new ToolError(
      'ALREADY_EXISTS',
      `File already exists; set "overwrite" to true to replace it: ${options.filePath}`,
      'Read the file first, then retry with "overwrite" and "expected_sha256".',
    );
  }
  const encoding = options.encoding ?? 'utf8';
  if (options.expectedSha256 !== undefined) {
    const current = existed ? hashText(await readFile(absolutePath, encoding)) : undefined;
    assertExpectedSha256(options.expectedSha256, current, options.filePath);
  }
  await mkdir(path.dirname(absolutePath), { recursive: true });
  let writeOptions: { encoding?: BufferEncoding; flag?: string } = { encoding };
  if (options.overwrite) writeOptions.flag = 'w';
  await writeFile(absolutePath, options.content, writeOptions);
  return {
    path: absolutePath,
    created: !existed,
    overwritten: existed,
    bytes: Buffer.byteLength(options.content),
    sha256: hashText(options.content),
  };
}

export async function writeMachineFileWithRetry(options: WriteFileOptions & { retryOnConflict?: boolean; maxRetries?: number }) {
  const maxRetries = options.maxRetries ?? 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await writeMachineFile(options);
    } catch (error) {
      lastError = error;
      if (!options.retryOnConflict || !(error instanceof ToolError) || error.code !== 'PRECONDITION_FAILED') {
        throw error;
      }
      if (attempt === maxRetries - 1) throw error;
    }
  }
  throw lastError;
}

/**
 * When an exact match fails the caller usually mistyped indentation or a line
 * ending. Reporting the whitespace-insensitive candidates lets the model correct
 * itself in one step instead of retrying blindly.
 */
function nearMissCandidates(lines: string[], oldText: string, limit = 5): Array<{ line: number; text: string }> {
  const needle = normalizeWhitespace(oldText.split('\n')[0] ?? '');
  if (needle.length < 3) return [];
  const candidates: Array<{ line: number; text: string }> = [];
  for (let index = 0; index < lines.length && candidates.length < limit; index++) {
    if (normalizeWhitespace(lines[index]).includes(needle)) {
      candidates.push({ line: index + 1, text: lines[index] });
    }
  }
  return candidates;
}

function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) if (content[index] === '\n') line++;
  return line;
}

export async function editMachineFile(options: EditFileOptions): Promise<any> {
  if (options.edits !== undefined) return editMachineFileTransaction({ ...options, edits: options.edits });
  if (!options.oldText) throw new ToolError('INVALID_ARGUMENT', '"old_text" must not be empty.');
  if (options.newText === undefined) throw new ToolError('INVALID_ARGUMENT', '"new_text" is required.');
  if (options.expectedReplacements !== undefined) {
    validatePositiveInteger(options.expectedReplacements, 'expected_replacements', 10_000);
  }
  const file = await loadTextFile(options, options.filePath, options.encoding ?? 'utf8');
  assertExpectedSha256(options.expectedSha256, file.sha256, options.filePath);

  const occurrences = file.content.split(options.oldText).length - 1;
  if (occurrences === 0) {
    throw new ToolError(
      'NO_MATCH',
      `"old_text" was not found in: ${options.filePath}`,
      'Copy the text verbatim from read_file output, including indentation and line endings.',
      { sha256: file.sha256, nearMisses: nearMissCandidates(file.lines, options.oldText) },
    );
  }
  if (options.expectedReplacements !== undefined && occurrences !== options.expectedReplacements) {
    throw new ToolError(
      'PRECONDITION_FAILED',
      `"old_text" occurs ${occurrences} times but "expected_replacements" is ${options.expectedReplacements}.`,
      'Widen "old_text" until it is unique, or correct the expected count.',
      { occurrences },
    );
  }
  if (!options.replaceAll && options.expectedReplacements === undefined && occurrences !== 1) {
    throw new ToolError(
      'AMBIGUOUS_MATCH',
      `"old_text" occurs ${occurrences} times; provide a unique value or set "replace_all" to true.`,
      'Include surrounding lines so the match is unique, or set "replace_all".',
      {
        occurrences,
        matchLines: file.content
          .split(options.oldText)
          .slice(0, -1)
          .reduce<{ offset: number; lines: number[] }>((state, segment) => {
            const offset = state.offset + segment.length;
            state.lines.push(lineOfOffset(file.content, offset));
            return { offset: offset + (options.oldText as string).length, lines: state.lines };
          }, { offset: 0, lines: [] }).lines,
      },
    );
  }

  const replaceAll = options.replaceAll || (options.expectedReplacements ?? 0) > 1;
  const content = replaceAll
    ? file.content.split(options.oldText).join(options.newText)
    : file.content.replace(options.oldText, options.newText);
  const replacements = replaceAll ? occurrences : 1;
  const firstLine = lineOfOffset(file.content, file.content.indexOf(options.oldText));

  if (options.dryRun) {
    return {
      path: file.absolutePath,
      dryRun: true,
      replacements,
      firstReplacedLine: firstLine,
      sha256: file.sha256,
      resultingSha256: hashText(content),
      bytes: Buffer.byteLength(content),
    };
  }

  await writeFile(file.absolutePath, content, { encoding: options.encoding ?? 'utf8' });
  return {
    path: file.absolutePath,
    dryRun: false,
    replacements,
    firstReplacedLine: firstLine,
    bytes: Buffer.byteLength(content),
    sha256: hashText(content),
  };
}

/** Validate every replacement in memory, then make one write: no partial edit. */
export async function editMachineFileTransaction(options: Omit<EditFileOptions, 'oldText' | 'newText' | 'replaceAll' | 'expectedReplacements'> & { edits: TransactionalEdit[] }) {
  if (!Array.isArray(options.edits) || options.edits.length === 0) throw new ToolError('INVALID_ARGUMENT', '"edits" must contain at least one edit.');
  const file = await loadTextFile(options, options.filePath, options.encoding ?? 'utf8');
  assertExpectedSha256(options.expectedSha256, file.sha256, options.filePath);
  let content = file.content;
  const applied: Array<{ replacements: number; firstReplacedLine: number }> = [];
  for (let index = 0; index < options.edits.length; index++) {
    const edit = options.edits[index]!;
    if (!edit.oldText) throw new ToolError('INVALID_ARGUMENT', `edits[${index}].old_text must not be empty.`, undefined, { failedEditIndex: index });
    const occurrences = content.split(edit.oldText).length - 1;
    if (occurrences === 0) throw new ToolError('NO_MATCH', `edits[${index}].old_text was not found.`, 'Copy the text verbatim from read_file output.', { failedEditIndex: index, nearMisses: nearMissCandidates(content.replace(/\r\n/g, '\n').split('\n'), edit.oldText) });
    if (edit.expectedReplacements !== undefined && occurrences !== edit.expectedReplacements) throw new ToolError('PRECONDITION_FAILED', `edits[${index}] occurs ${occurrences} times, expected ${edit.expectedReplacements}.`, undefined, { failedEditIndex: index, occurrences });
    if (!edit.replaceAll && edit.expectedReplacements === undefined && occurrences !== 1) throw new ToolError('AMBIGUOUS_MATCH', `edits[${index}].old_text occurs ${occurrences} times.`, 'Set replace_all or expected_replacements.', { failedEditIndex: index, occurrences });
    const replaceAll = edit.replaceAll || (edit.expectedReplacements ?? 0) > 1;
    applied.push({ replacements: replaceAll ? occurrences : 1, firstReplacedLine: lineOfOffset(content, content.indexOf(edit.oldText)) });
    content = replaceAll ? content.split(edit.oldText).join(edit.newText) : content.replace(edit.oldText, edit.newText);
  }
  const result = { path: file.absolutePath, dryRun: options.dryRun === true, edits: applied, replacements: applied.reduce((sum, item) => sum + item.replacements, 0), sha256: hashText(content), bytes: Buffer.byteLength(content) };
  if (!options.dryRun) await writeFile(file.absolutePath, content, { encoding: options.encoding ?? 'utf8' });
  return result;
}

export async function updateMachineFile(options: UpdateFileOptions) {
  const file = await loadTextFile(options, options.filePath, options.encoding ?? 'utf8');
  assertExpectedSha256(options.expectedSha256, file.sha256, options.filePath);
  validatePositiveInteger(options.startLine, 'start_line');
  validatePositiveInteger(options.endLine, 'end_line');
  if (options.endLine < options.startLine) {
    throw new ToolError('INVALID_ARGUMENT', '"end_line" must be greater than or equal to "start_line".');
  }
  if (options.endLine > file.lines.length) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `"end_line" exceeds the file length of ${file.lines.length} lines.`,
      'Read the file again; line numbers shift after every edit.',
      { totalLines: file.lines.length },
    );
  }
  const lines = [...file.lines];
  lines.splice(options.startLine - 1, options.endLine - options.startLine + 1, ...replacementLines(options.content));
  const content = lines.join(file.eol) + (file.trailingNewline ? file.eol : '');
  await writeFile(file.absolutePath, content, { encoding: options.encoding ?? 'utf8' });
  return {
    path: file.absolutePath,
    replacedStartLine: options.startLine,
    replacedEndLine: options.endLine,
    totalLines: lines.length,
    bytes: Buffer.byteLength(content),
    sha256: hashText(content),
  };
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface SearchResult {
  pattern: string;
  path: string;
  engine: 'ripgrep' | 'builtin';
  matches: SearchMatch[];
  files?: string[];
  truncated: boolean;
}

interface NormalizedSearch {
  target: string;
  maxResults: number;
  timeoutMs: number;
  contextLines: number;
  maxMatchesPerFile?: number;
  filesOnly: boolean;
}

function buildSearchRegExp(options: SearchCodeOptions): RegExp {
  const source = options.literal
    ? options.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : options.pattern;
  try {
    return new RegExp(source, options.caseSensitive === false ? 'gi' : 'g');
  } catch (error: unknown) {
    throw new ToolError(
      'INVALID_ARGUMENT',
      `Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`,
      'Set "literal" to true to search for the text exactly as written.',
    );
  }
}

function ripgrepSearch(options: SearchCodeOptions, search: NormalizedSearch): Promise<SearchResult> {
  const args = ['--no-messages'];
  if (search.filesOnly) {
    args.push('--files-with-matches');
  } else {
    args.push('--json');
    if (search.contextLines > 0) args.push('--context', String(search.contextLines));
    if (search.maxMatchesPerFile !== undefined) args.push('--max-count', String(search.maxMatchesPerFile));
  }
  if (options.caseSensitive === false) args.push('--ignore-case');
  if (options.literal) args.push('--fixed-strings');
  for (const glob of options.globs ?? []) args.push('--glob', glob);
  args.push('--', options.pattern, search.target);

  return new Promise<SearchResult>((resolve, reject) => {
    const child = spawn('rg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    const matches: SearchMatch[] = [];
    const files: string[] = [];
    let pendingBefore: string[] = [];
    let pending = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const reachedLimit = () => (search.filesOnly ? files.length : matches.length) >= search.maxResults;

    const consumeLine = (line: string) => {
      if (!line || reachedLimit()) return;
      if (search.filesOnly) {
        files.push(line);
      } else {
        let event: {
          type?: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
            submatches?: Array<{ start?: number }>;
          };
        };
        try {
          event = JSON.parse(line);
        } catch {
          // Ignore non-JSON diagnostic lines; stderr is returned on real rg failures.
          return;
        }
        const text = (event.data?.lines?.text ?? '').replace(/[\r\n]+$/, '');
        if (event.type === 'context') {
          const last = matches[matches.length - 1];
          if (last && last.after !== undefined && last.after.length < search.contextLines && (event.data?.line_number ?? 0) > last.line) {
            last.after.push(text);
          } else {
            pendingBefore.push(text);
            if (pendingBefore.length > search.contextLines) pendingBefore.shift();
          }
          return;
        }
        if (event.type !== 'match' || !event.data?.path?.text || !event.data.line_number) return;
        matches.push({
          path: event.data.path.text,
          line: event.data.line_number,
          column: (event.data.submatches?.[0]?.start ?? 0) + 1,
          text,
          ...(search.contextLines > 0 ? { before: pendingBefore, after: [] } : {}),
        });
        pendingBefore = [];
      }
      if (reachedLimit()) {
        truncated = true;
        child.kill();
      }
    };

    const consume = (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) consumeLine(line.replace(/\r$/, ''));
    };

    child.stdout.on('data', (chunk: Buffer) => consume(decoder.write(chunk)));
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_192) stderr += chunk.toString('utf8').slice(0, 8_192 - stderr.length);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ToolError('DEPENDENCY_MISSING', `Unable to start ripgrep (rg): ${error.message}`));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, search.timeoutMs);
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      consume(decoder.end());
      if (timedOut) {
        reject(new ToolError(
          'TIMEOUT',
          `Code search timed out after ${search.timeoutMs}ms.`,
          'Narrow the search with "path" or "globs", or raise "timeout_ms".',
        ));
        return;
      }
      if (exitCode !== 0 && exitCode !== 1 && !truncated) {
        reject(new ToolError('INTERNAL', stderr.trim() || `ripgrep exited with code ${exitCode}.`));
        return;
      }
      resolve({
        pattern: options.pattern,
        path: search.target,
        engine: 'ripgrep',
        matches,
        ...(search.filesOnly ? { files } : {}),
        truncated,
      });
    });
  });
}

/**
 * Pure-Node fallback used when ripgrep is not installed. It is slower and skips
 * large or binary files, but it keeps search working instead of failing outright.
 */
async function builtinSearch(options: SearchCodeOptions, search: NormalizedSearch): Promise<SearchResult> {
  const expression = buildSearchRegExp(options);
  const includeGlobs = (options.globs ?? []).filter((glob) => !glob.startsWith('!')).map(globToRegExp);
  const excludeGlobs = (options.globs ?? [])
    .filter((glob) => glob.startsWith('!'))
    .map((glob) => globToRegExp(glob.slice(1)));
  const deadline = Date.now() + search.timeoutMs;
  const matches: SearchMatch[] = [];
  const files: string[] = [];
  let truncated = false;

  const scanFile = async (absolutePath: string): Promise<boolean> => {
    if (Date.now() > deadline) {
      throw new ToolError('TIMEOUT', `Code search timed out after ${search.timeoutMs}ms.`);
    }
    const info = await stat(absolutePath).catch(() => undefined);
    if (!info?.isFile() || info.size > FALLBACK_SEARCH_FILE_BYTES) return true;
    const buffer = await readFile(absolutePath).catch(() => undefined);
    if (!buffer || buffer.includes(0)) return true;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    let inFile = 0;
    for (let index = 0; index < lines.length; index++) {
      expression.lastIndex = 0;
      const found = expression.exec(lines[index]);
      if (!found) continue;
      if (search.filesOnly) {
        files.push(absolutePath);
        return files.length < search.maxResults;
      }
      matches.push({
        path: absolutePath,
        line: index + 1,
        column: found.index + 1,
        text: lines[index],
        ...(search.contextLines > 0
          ? {
            before: lines.slice(Math.max(0, index - search.contextLines), index),
            after: lines.slice(index + 1, index + 1 + search.contextLines),
          }
          : {}),
      });
      inFile++;
      if (matches.length >= search.maxResults) return false;
      if (search.maxMatchesPerFile !== undefined && inFile >= search.maxMatchesPerFile) return true;
    }
    return true;
  };

  const info = await stat(search.target).catch(() => undefined);
  if (info?.isFile()) {
    truncated = !(await scanFile(search.target));
  } else {
    const walked = await walkFiles({
      root: search.target,
      maxDepth: 50,
      includeHidden: false,
      accept: (relativePath) => (includeGlobs.length === 0 || includeGlobs.some((glob) => glob.test(relativePath)))
        && !excludeGlobs.some((glob) => glob.test(relativePath)),
      onFile: (absolutePath) => scanFile(absolutePath),
    });
    truncated = walked.stopped;
  }

  return {
    pattern: options.pattern,
    path: search.target,
    engine: 'builtin',
    matches,
    ...(search.filesOnly ? { files } : {}),
    truncated,
  };
}

export async function searchCode(options: SearchCodeOptions): Promise<SearchResult> {
  if (!options.pattern) throw new ToolError('INVALID_ARGUMENT', '"pattern" parameter is required.');
  const maxResults = options.maxResults ?? 200;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const contextLines = options.contextLines ?? 0;
  validatePositiveInteger(maxResults, 'max_results', MAX_SEARCH_RESULTS);
  validatePositiveInteger(timeoutMs, 'timeout_ms', 60_000);
  validateBoundedInteger(contextLines, 'context_lines', 0, MAX_CONTEXT_LINES);
  if (options.maxMatchesPerFile !== undefined) {
    validatePositiveInteger(options.maxMatchesPerFile, 'max_matches_per_file', MAX_SEARCH_RESULTS);
  }
  // Reject an unusable regular expression before spawning anything.
  buildSearchRegExp(options);

  const search: NormalizedSearch = {
    target: await resolveMachinePath(options, options.searchPath ?? '.'),
    maxResults,
    timeoutMs,
    contextLines,
    maxMatchesPerFile: options.maxMatchesPerFile,
    filesOnly: options.filesOnly === true,
  };

  try {
    return await ripgrepSearch(options, search);
  } catch (error: unknown) {
    if (error instanceof ToolError && error.code === 'DEPENDENCY_MISSING') {
      return await builtinSearch(options, search);
    }
    throw error;
  }
}
