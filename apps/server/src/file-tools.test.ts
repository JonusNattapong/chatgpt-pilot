import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  editMachineFile,
  editMachineFileTransaction,
  fileInfo,
  findFiles,
  imageInfo,
  listDirectory,
  readMachineFile,
  readBinaryFile,
  saveImageFromUrl,
  searchCode,
  updateMachineFile,
  writeMachineFile,
  writeMachineFileWithRetry,
} from './file-tools.js';

test('file tools create, read, edit, and update UTF-8 files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-files-'));
  const access = { root, unrestricted: false };
  try {
    const written = await writeMachineFile({
      ...access,
      filePath: 'nested/example.txt',
      content: 'alpha\nbeta\ngamma\n',
    });
    assert.equal(written.created, true);

    const page = await readMachineFile({ ...access, filePath: 'nested/example.txt', startLine: 2, maxLines: 1 });
    assert.equal(page.content, 'beta');
    assert.equal(page.totalLines, 3);
    assert.equal(page.truncated, true);

    await editMachineFile({ ...access, filePath: 'nested/example.txt', oldText: 'beta', newText: 'BETA' });
    await updateMachineFile({
      ...access,
      filePath: 'nested/example.txt',
      startLine: 1,
      endLine: 2,
      content: 'one\ntwo',
    });
    assert.equal(await readFile(path.join(root, 'nested/example.txt'), 'utf8'), 'one\ntwo\ngamma\n');

    await assert.rejects(
      writeMachineFile({ ...access, filePath: 'nested/example.txt', content: 'replace' }),
      /already exists/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('edit_file rejects ambiguous replacements unless replace_all is true', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-edit-'));
  const access = { root, unrestricted: false };
  try {
    await writeMachineFile({ ...access, filePath: 'repeat.txt', content: 'same same' });
    await assert.rejects(
      editMachineFile({ ...access, filePath: 'repeat.txt', oldText: 'same', newText: 'new' }),
      /occurs 2 times/,
    );
    const result = await editMachineFile({
      ...access,
      filePath: 'repeat.txt',
      oldText: 'same',
      newText: 'new',
      replaceAll: true,
    });
    assert.equal(result.replacements, 2);
    assert.equal(await readFile(path.join(root, 'repeat.txt'), 'utf8'), 'new new');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('transactional edit_file validates every edit before writing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-transaction-'));
  const access = { root, unrestricted: false };
  try {
    await writeMachineFile({ ...access, filePath: 'example.txt', content: 'one\ntwo\n' });
    await assert.rejects(editMachineFileTransaction({ ...access, filePath: 'example.txt', edits: [{ oldText: 'one', newText: 'ONE' }, { oldText: 'missing', newText: 'X' }] }), /not found/);
    assert.equal(await readFile(path.join(root, 'example.txt'), 'utf8'), 'one\ntwo\n');
    const result = await editMachineFileTransaction({ ...access, filePath: 'example.txt', edits: [{ oldText: 'one', newText: 'ONE' }, { oldText: 'two', newText: 'TWO' }] });
    assert.equal(result.replacements, 2);
    assert.equal(await readFile(path.join(root, 'example.txt'), 'utf8'), 'ONE\nTWO\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file tools enforce the workspace boundary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-safe-files-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'machine-mcp-outside-files-'));
  try {
    await assert.rejects(
      writeMachineFile({
        root,
        unrestricted: false,
        filePath: path.join(outside, 'escape.txt'),
        content: 'blocked',
      }),
      /outside the configured root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('search_code returns structured ripgrep matches', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-search-'));
  const access = { root, unrestricted: false };
  try {
    await writeMachineFile({ ...access, filePath: 'first.ts', content: 'const searchNeedle = 1;\n' });
    await writeMachineFile({ ...access, filePath: 'ignored.txt', content: 'searchNeedle\n' });
    const result = await searchCode({
      ...access,
      pattern: 'searchNeedle',
      globs: ['*.ts'],
      literal: true,
    });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].line, 1);
    assert.match(result.matches[0].path, /first\.ts$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('directory tools list entries, find files by glob, and report a hash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-directory-'));
  const access = { root, unrestricted: false };
  try {
    await writeMachineFile({ ...access, filePath: 'root.txt', content: 'root' });
    await writeMachineFile({ ...access, filePath: 'src/example.ts', content: 'export const value = 1;\n' });

    const listed = await listDirectory({ ...access, maxEntries: 1 });
    assert.equal(listed.entries.length, 1);
    assert.equal(listed.truncated, true);

    const found = await findFiles({ ...access, glob: '**/*.ts' });
    assert.deepEqual(found.matches.map((match) => path.basename(match)), ['example.ts']);

    const info = await fileInfo({ ...access, filePath: 'root.txt' });
    assert.equal(info.type, 'file');
    assert.equal(info.size, 4);
    assert.match(info.sha256 ?? '', /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('image_info validates supported image signatures and dimensions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-image-'));
  const access = { root, unrestricted: false };
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    await writeFile(path.join(root, 'pixel.png'), png);
    const result = await imageInfo({ ...access, filePath: 'pixel.png' });
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.width, 1);
    assert.equal(result.height, 1);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('save_image_from_url requires HTTPS before making a network request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-image-url-'));
  try {
    await assert.rejects(
      saveImageFromUrl({ root, unrestricted: false, url: 'http://example.com/a.png', filePath: 'a.png' }),
      /HTTPS/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read_file supports non-UTF-8 encoding', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-encoding-'));
  const access = { root, unrestricted: false };
  try {
    const latin1 = Buffer.from('café', 'latin1');
    await writeFile(path.join(root, 'latin1.txt'), latin1);
    const result = await readMachineFile({ ...access, filePath: 'latin1.txt', encoding: 'latin1' });
    assert.equal(result.content, 'café');
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write_file supports non-UTF-8 encoding', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-write-encoding-'));
  const access = { root, unrestricted: false };
  try {
    await writeMachineFile({ ...access, filePath: 'latin1-out.txt', content: 'café', encoding: 'latin1' });
    const buffer = await readFile(path.join(root, 'latin1-out.txt'));
    assert.equal(buffer.toString('latin1'), 'café');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('edit_file supports encoding option', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-edit-encoding-'));
  const access = { root, unrestricted: false };
  try {
    await writeMachineFile({ ...access, filePath: 'latin1-edit.txt', content: 'hello', encoding: 'latin1' });
    await editMachineFile({ ...access, filePath: 'latin1-edit.txt', oldText: 'hello', newText: 'héllo', encoding: 'latin1' });
    assert.equal(await readFile(path.join(root, 'latin1-edit.txt'), 'latin1'), 'héllo');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read_file_binary reads binary files as base64', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-binary-'));
  const access = { root, unrestricted: false };
  try {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    await writeFile(path.join(root, 'binary.bin'), binary);
    const result = await readBinaryFile({ ...access, filePath: 'binary.bin' });
    assert.equal(result.bytes, 5);
    assert.equal(result.truncated, false);
    assert.equal(result.mimeType, 'application/octet-stream');
    assert.deepEqual(Buffer.from(result.data, 'base64'), binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('read_file_binary supports offset and max_bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-binary-offset-'));
  const access = { root, unrestricted: false };
  try {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
    await writeFile(path.join(root, 'offset.bin'), binary);
    const result = await readBinaryFile({ ...access, filePath: 'offset.bin', offsetBytes: 2, maxBytes: 2 });
    assert.equal(result.offsetBytes, 2);
    assert.equal(result.bytes, 2);
    assert.deepEqual(Buffer.from(result.data, 'base64'), Buffer.from([0x02, 0x03]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('list_directory supports cursor pagination', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-dir-cursor-'));
  const access = { root, unrestricted: false };
  try {
    for (let i = 0; i < 5; i++) {
      await writeFile(path.join(root, `file-${i}.txt`), Buffer.from(`content-${i}`));
    }
    const first = await listDirectory({ ...access, directoryPath: '.', maxEntries: 2 });
    assert.equal(first.entries.length, 2);
    assert.ok(first.cursor);
    assert.ok(first.nextCursor);

    const second = await listDirectory({ ...access, directoryPath: '.', maxEntries: 2, cursor: first.nextCursor });
    assert.equal(second.entries.length, 2);
    assert.ok(second.nextCursor);

    const third = await listDirectory({ ...access, directoryPath: '.', maxEntries: 2, cursor: second.nextCursor });
    assert.equal(third.entries.length, 1);
    assert.equal(third.nextCursor, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('find_files supports cursor pagination', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-find-cursor-'));
  const access = { root, unrestricted: false };
  try {
    await mkdir(path.join(root, 'sub'), { recursive: true });
    for (let i = 0; i < 3; i++) {
      await writeFile(path.join(root, 'sub', `file-${i}.txt`), Buffer.from(`content-${i}`));
    }
    const first = await findFiles({ ...access, directoryPath: '.', glob: '**/*.txt', maxResults: 2 });
    assert.equal(first.matches.length, 2);
    assert.ok(first.cursor);

    const second = await findFiles({ ...access, directoryPath: '.', glob: '**/*.txt', maxResults: 2, cursor: first.cursor });
    assert.equal(second.matches.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write_file_with_retry retries on precondition failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-retry-'));
  const access = { root, unrestricted: false };
  try {
    await writeMachineFile({ ...access, filePath: 'retry.txt', content: 'v1' });
    const buffer = await readFile(path.join(root, 'retry.txt'));
    const staleHash = '0'.repeat(64);

    await assert.rejects(
      writeMachineFileWithRetry({ ...access, filePath: 'retry.txt', content: 'v2', expectedSha256: staleHash, overwrite: true, retryOnConflict: true, maxRetries: 2 }),
      (error: unknown) => (error as { code?: string }).code === 'PRECONDITION_FAILED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
