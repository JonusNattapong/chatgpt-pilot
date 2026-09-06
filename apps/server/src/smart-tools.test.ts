import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolError } from './errors.js';
import {
  editMachineFile,
  findFiles,
  readMachineFile,
  searchCode,
  updateMachineFile,
  writeMachineFile,
} from './file-tools.js';
import { readProcessOutput, startProcess, stopProcess, writeProcessInput } from './process-tools.js';
import { createToolSpecs } from './tools.js';

async function withRoot(prefix: string, body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function toolError(error: unknown): ToolError {
  assert.ok(error instanceof ToolError, `expected ToolError, received ${String(error)}`);
  return error;
}

test('read_file reports a hash that write and edit accept as a precondition', async () => {
  await withRoot('machine-mcp-sha-', async (root) => {
    const access = { root, unrestricted: false };
    await writeMachineFile({ ...access, filePath: 'note.txt', content: 'alpha\nbeta\n' });
    const page = await readMachineFile({ ...access, filePath: 'note.txt' });
    assert.match(page.sha256, /^[a-f0-9]{64}$/);

    // A matching digest is accepted.
    const edited = await editMachineFile({
      ...access,
      filePath: 'note.txt',
      oldText: 'alpha',
      newText: 'ALPHA',
      expectedSha256: page.sha256,
    });
    assert.equal(edited.replacements, 1);

    // The stale digest from before the edit is now rejected.
    await assert.rejects(
      updateMachineFile({
        ...access,
        filePath: 'note.txt',
        startLine: 1,
        endLine: 1,
        content: 'lost update',
        expectedSha256: page.sha256,
      }),
      (error: unknown) => {
        const failure = toolError(error);
        assert.equal(failure.code, 'PRECONDITION_FAILED');
        assert.equal(failure.details?.actualSha256, edited.sha256);
        return true;
      },
    );
    assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'ALPHA\nbeta\n');
  });
});

test('edit_file reports near misses instead of a bare failure', async () => {
  await withRoot('machine-mcp-nearmiss-', async (root) => {
    const access = { root, unrestricted: false };
    await writeMachineFile({ ...access, filePath: 'code.ts', content: 'const   value = 1;\nexport default value;\n' });
    await assert.rejects(
      editMachineFile({ ...access, filePath: 'code.ts', oldText: 'const value = 1;', newText: 'const value = 2;' }),
      (error: unknown) => {
        const failure = toolError(error);
        assert.equal(failure.code, 'NO_MATCH');
        assert.deepEqual(failure.details?.nearMisses, [{ line: 1, text: 'const   value = 1;' }]);
        return true;
      },
    );
  });
});

test('edit_file dry_run previews the change without writing', async () => {
  await withRoot('machine-mcp-dryedit-', async (root) => {
    const access = { root, unrestricted: false };
    await writeMachineFile({ ...access, filePath: 'a.txt', content: 'one\ntwo\n' });
    const preview = await editMachineFile({
      ...access,
      filePath: 'a.txt',
      oldText: 'two',
      newText: 'three',
      dryRun: true,
    });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.firstReplacedLine, 2);
    assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n');
  });
});

test('edit_file enforces expected_replacements', async () => {
  await withRoot('machine-mcp-count-', async (root) => {
    const access = { root, unrestricted: false };
    await writeMachineFile({ ...access, filePath: 'r.txt', content: 'x x x' });
    await assert.rejects(
      editMachineFile({ ...access, filePath: 'r.txt', oldText: 'x', newText: 'y', expectedReplacements: 2 }),
      (error: unknown) => {
        const failure = toolError(error);
        assert.equal(failure.code, 'PRECONDITION_FAILED');
        assert.equal(failure.details?.occurrences, 3);
        return true;
      },
    );
    const result = await editMachineFile({
      ...access,
      filePath: 'r.txt',
      oldText: 'x',
      newText: 'y',
      expectedReplacements: 3,
    });
    assert.equal(result.replacements, 3);
    assert.equal(await readFile(path.join(root, 'r.txt'), 'utf8'), 'y y y');
  });
});

test('edit_file accepts a transactional array of edits', async () => {
  await withRoot('machine-mcp-txn-', async (root) => {
    const access = { root, unrestricted: false };
    await writeMachineFile({ ...access, filePath: 'multi.txt', content: 'alpha=1\nbeta=2\ngamma=3\n' });
    const result = await editMachineFile({
      ...access,
      filePath: 'multi.txt',
      edits: [
        { oldText: 'alpha=1', newText: 'alpha=10' },
        { oldText: 'beta=2', newText: 'beta=20' },
        { oldText: 'gamma=3', newText: 'gamma=30' },
      ],
    } as any);
    assert.equal(result.replacements, 3);
    const content = await readFile(path.join(root, 'multi.txt'), 'utf8');
    assert.equal(content, 'alpha=10\nbeta=20\ngamma=30\n');
  });
});

test('edit_file rejects transactional array if any edit fails', async () => {
  await withRoot('machine-mcp-txn-fail-', async (root) => {
    const access = { root, unrestricted: false };
    await writeMachineFile({ ...access, filePath: 't.txt', content: 'a\nb\nc\n' });
    await assert.rejects(
      editMachineFile({
        ...access,
        filePath: 't.txt',
        edits: [
          { oldText: 'a', newText: 'A' },
          { oldText: 'notfound', newText: 'X' }, // This fails
          { oldText: 'c', newText: 'C' },
        ],
      }),
      (error: unknown) => {
        const failure = toolError(error);
        assert.equal(failure.code, 'NO_MATCH');
        assert.equal(failure.details?.failedEditIndex, 1);
        return true;
      },
    );
    // File should remain unchanged
    assert.equal(await readFile(path.join(root, 't.txt'), 'utf8'), 'a\nb\nc\n');
  });
});

test('read_file can number the lines it returns', async () => {
  await withRoot('machine-mcp-numbers-', async (root) => {
    const access = { root, unrestricted: false };
    await writeMachineFile({ ...access, filePath: 'n.txt', content: 'a\nb\nc\n' });
    const page = await readMachineFile({ ...access, filePath: 'n.txt', startLine: 2, lineNumbers: true });
    assert.equal(page.content, '2\tb\n3\tc');
    assert.equal(page.lineNumbers, true);
  });
});

test('find_files skips dependency directories unless asked for them', async () => {
  await withRoot('machine-mcp-ignore-', async (root) => {
    const access = { root, unrestricted: false };
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    await writeMachineFile({ ...access, filePath: 'app.js', content: 'export const app = 1;\n' });

    const filtered = await findFiles({ ...access, glob: '**/*.js' });
    assert.deepEqual(filtered.matches.map((match) => path.basename(match)), ['app.js']);
    assert.deepEqual(filtered.excludedDirectories, ['node_modules']);

    const all = await findFiles({ ...access, glob: '**/*.js', includeIgnored: true });
    assert.equal(all.matches.length, 2);
  });
});

test('search_code returns context lines and a files-only survey', async () => {
  await withRoot('machine-mcp-context-', async (root) => {
    const access = { root, unrestricted: false };
    await writeMachineFile({ ...access, filePath: 'ctx.ts', content: 'before\nneedle\nafter\n' });

    const withContext = await searchCode({ ...access, pattern: 'needle', literal: true, contextLines: 1 });
    assert.equal(withContext.matches.length, 1);
    assert.deepEqual(withContext.matches[0].before, ['before']);
    assert.deepEqual(withContext.matches[0].after, ['after']);

    const filesOnly = await searchCode({ ...access, pattern: 'needle', literal: true, filesOnly: true });
    assert.equal(filesOnly.files?.length, 1);
    assert.match(filesOnly.files?.[0] ?? '', /ctx\.ts$/);
  });
});

test('search_code rejects an invalid regular expression with actionable guidance', async () => {
  await withRoot('machine-mcp-badregex-', async (root) => {
    await assert.rejects(
      searchCode({ root, unrestricted: false, pattern: '([unclosed' }),
      (error: unknown) => {
        const failure = toolError(error);
        assert.equal(failure.code, 'INVALID_ARGUMENT');
        assert.match(failure.hint ?? '', /literal/);
        return true;
      },
    );
  });
});

test('read_process_output returns only output newer than the supplied offsets', async () => {
  await withRoot('machine-mcp-offsets-', async (root) => {
    const access = { root, unrestricted: false };
    const started = await startProcess({
      ...access,
      command: "node -e \"console.log('first'); process.stdin.once('data', () => console.log('second')); setTimeout(() => {}, 5000)\"",
    });
    try {
      const first = await readProcessOutput({ ...access, pid: started.pid, waitMs: 5_000 });
      assert.match(first.stdout, /first/);
      assert.ok(first.nextStdoutOffset > 0);

      await writeProcessInput({ ...access, pid: started.pid, input: 'next\n' });
      const second = await readProcessOutput({
        ...access,
        pid: started.pid,
        sinceStdout: first.nextStdoutOffset,
        waitMs: 5_000,
      });
      assert.doesNotMatch(second.stdout, /first/);
      assert.match(second.stdout, /second/);
    } finally {
      await stopProcess({ ...access, pid: started.pid });
    }
  });
});

test('the tool registry validates arguments and reports its own surface', async () => {
  await withRoot('machine-mcp-registry-', async (root) => {
    const specs = createToolSpecs({ root, unrestricted: false, maxTimeoutMs: 60_000 });
    const byName = new Map(specs.map((spec) => [spec.name, spec]));
    assert.equal(specs.length, 62);

    await assert.rejects(
      byName.get('read_file')!.handler({}),
      (error: unknown) => toolError(error).code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      byName.get('read_file')!.handler({ path: 'a.txt', max_lines: 'ten' }),
      (error: unknown) => toolError(error).code === 'INVALID_ARGUMENT',
    );

    const compact = await byName.get('machine_status')!.handler({}) as Record<string, unknown>;
    assert.equal('tools' in compact, false);
    assert.equal('available' in compact, false);

    const status = await byName.get('machine_status')!.handler({ detailed: true }) as {
      tools: string[];
      available: { searchEngine: string };
    };
    // The expanded surface is derived from the registry, so it cannot drift.
    assert.deepEqual(status.tools, specs.map((spec) => spec.name));
    assert.ok(['ripgrep', 'builtin'].includes(status.available.searchEngine));
  });
});

test('process_write sends input to a live managed process', async () => {
  await withRoot('machine-mcp-stdin-', async (root) => {
    const access = { root, unrestricted: false };
    const started = await startProcess({
      ...access,
      command: "node -e \"process.stdin.once('data', d => { console.log('echo:' + d.toString().trim()); setTimeout(() => {}, 5000); })\"",
    });
    try {
      const written = await writeProcessInput({ ...access, pid: started.pid, input: 'hello\\n' });
      assert.ok(written.bytes > 0);
      const output = await readProcessOutput({ ...access, pid: started.pid, waitMs: 5_000 });
      assert.match(output.stdout, /echo:hello/);
    } finally {
      await stopProcess({ ...access, pid: started.pid });
    }
  });
});

test('search_code falls back to the built-in scanner when ripgrep is unavailable', async () => {
  await withRoot('machine-mcp-fallback-', async (root) => {
    const access = { root, unrestricted: false };
    await writeMachineFile({ ...access, filePath: 'f.ts', content: 'above\nfallbackNeedle\nbelow\n' });
    const originalPath = process.env.PATH;
    const originalWindowsPath = process.env.Path;
    // An empty PATH makes spawning rg fail exactly as it would on a machine without it.
    process.env.PATH = path.join(root, 'no-such-bin');
    process.env.Path = process.env.PATH;
    try {
      const result = await searchCode({ ...access, pattern: 'fallbackNeedle', literal: true, contextLines: 1 });
      assert.equal(result.engine, 'builtin');
      assert.equal(result.matches.length, 1);
      assert.deepEqual(result.matches[0].before, ['above']);
      assert.deepEqual(result.matches[0].after, ['below']);
    } finally {
      process.env.PATH = originalPath;
      process.env.Path = originalWindowsPath;
    }
  });
});
