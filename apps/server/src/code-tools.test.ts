import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scaffoldCode, SUPPORTED_TEMPLATES, validateTemplate, parseCodeArtifact, writeCodeFromArtifact } from './code-tools.js';

test('validate_template rejects empty and unknown templates', async () => {
  assert.throws(() => validateTemplate(''), /required/);
  assert.throws(() => validateTemplate('unknown-template'), /Unsupported template/);
  assert.ok(SUPPORTED_TEMPLATES.length >= 6);
});

test('scaffold_code generates react component files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'code-scaffold-react-'));
  const access = { root, unrestricted: false };
  try {
    const result = await scaffoldCode({
      ...access,
      template: 'react-component',
      name: 'UserCard',
      description: 'Displays a user summary card.',
      outputPath: 'src/components',
    });

    assert.equal(result.template, 'react-component');
    assert.equal(result.name, 'UserCard');
    assert.equal(result.files.length, 3);
    assert.ok(result.files.every((file) => file.created));
    assert.equal(result.files[0].path, 'user-card.tsx');
    assert.equal(result.files[2].path, 'index.ts');

    const component = await readFile(path.join(root, 'src/components/user-card.tsx'), 'utf8');
    assert.match(component, /UserCardProps/);
    assert.match(component, /UserCard/);
    assert.match(component, /user-card/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scaffold_code generates python script with tests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'code-scaffold-python-'));
  const access = { root, unrestricted: false };
  try {
    const result = await scaffoldCode({
      ...access,
      template: 'python-script',
      name: 'report_generator',
      outputPath: 'scripts',
    });

    assert.equal(result.files.length, 2);
    assert.equal(result.files[0].path, 'report_generator.py');
    assert.equal(result.files[1].path, 'tests.test.py');

    const script = await readFile(path.join(root, 'scripts/report_generator.py'), 'utf8');
    assert.match(script, /def main/);
    assert.match(script, /argparse/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scaffold_code refuses to overwrite existing files by default', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'code-scaffold-overwrite-'));
  const access = { root, unrestricted: false };
  try {
    await scaffoldCode({
      ...access,
      template: 'typescript-utility',
      name: 'safe-text',
      outputPath: 'lib',
    });

    await assert.rejects(
      scaffoldCode({
        ...access,
        template: 'typescript-utility',
        name: 'safe-text',
        outputPath: 'lib',
      }),
      /already exists/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scaffold_code overwrites files when overwrite is true', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'code-scaffold-force-'));
  const access = { root, unrestricted: false };
  try {
    const first = await scaffoldCode({
      ...access,
      template: 'node-service',
      name: 'worker',
      outputPath: 'src/services',
    });
    assert.equal(first.files[0].created, true);
    assert.equal(first.files[0].overwritten, false);

    const second = await scaffoldCode({
      ...access,
      template: 'node-service',
      name: 'worker',
      outputPath: 'src/services',
      overwrite: true,
    });
    assert.equal(second.files[0].created, false);
    assert.equal(second.files[0].overwritten, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scaffold_code normalizes names into kebab-case file paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'code-scaffold-names-'));
  try {
    const result = await scaffoldCode({
      root,
      unrestricted: true,
      template: 'api-controller',
      name: 'Order_Controller',
      outputPath: '.',
    });

    assert.ok(result.files.some((file) => file.path === 'order_controller-controller.ts'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parse_code_artifact accepts JSON files array', async () => {
  const artifact = JSON.stringify({
    files: [
      { path: 'src/index.ts', content: 'export const ok = true;' },
      { path: 'README.md', content: '# hello' },
    ],
  });
  const files = parseCodeArtifact(artifact);
  assert.deepEqual(files, [
    { path: 'src/index.ts', content: 'export const ok = true;' },
    { path: 'README.md', content: '# hello' },
  ]);
});

test('parse_code_artifact accepts markdown headers and code blocks', async () => {
  const artifact = `
### path: src/index.ts
\`\`\`ts
export const ok = true;
\`\`\`

### path: README.md
\`\`\`md
# hello
\`\`\`
`;
  const files = parseCodeArtifact(artifact);
  assert.equal(files.length, 2);
  assert.equal(files[0]!.path, 'src/index.ts');
  assert.equal(files[0]!.content, 'export const ok = true;');
  assert.equal(files[1]!.path, 'README.md');
  assert.equal(files[1]!.content, '# hello');
});

test('write_code_from_artifact materializes JSON artifact', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'code-artifact-json-'));
  const access = { root, unrestricted: false };
  try {
    const result = await writeCodeFromArtifact({
      ...access,
      artifact: JSON.stringify({
        files: [
          { path: 'app/index.ts', content: 'export const app = 1;' },
          { path: 'app/utils.ts', content: 'export const util = 2;' },
        ],
      }),
      basePath: '.',
    });

    assert.equal(result.format, 'json');
    assert.equal(result.files.length, 2);
    assert.ok(result.files.every((file) => file.created));
    assert.equal(await readFile(path.join(root, 'app/index.ts'), 'utf8'), 'export const app = 1;\n');
    assert.equal(await readFile(path.join(root, 'app/utils.ts'), 'utf8'), 'export const util = 2;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write_code_from_artifact materializes markdown artifact', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'code-artifact-md-'));
  const access = { root, unrestricted: false };
  try {
    const result = await writeCodeFromArtifact({
      ...access,
      artifact: `
### path: docs/readme.md
\`\`\`md
# hello
\`\`\`

### path: scripts/run.ts
\`\`\`ts
console.log('hi');
\`\`\`
`,
      basePath: '.',
    });

    assert.equal(result.format, 'markdown');
    assert.equal(result.files.length, 2);
    assert.equal(result.files[0]!.path, 'docs/readme.md');
    assert.equal(result.files[1]!.path, 'scripts/run.ts');
    assert.equal(await readFile(path.join(root, 'docs/readme.md'), 'utf8'), '# hello\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write_code_from_artifact refuses overwrite by default', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'code-artifact-overwrite-'));
  const access = { root, unrestricted: false };
  try {
    await writeCodeFromArtifact({
      ...access,
      artifact: JSON.stringify({ files: [{ path: 'existing.txt', content: 'v1' }] }),
      basePath: '.',
    });

    await assert.rejects(
      writeCodeFromArtifact({
        ...access,
        artifact: JSON.stringify({ files: [{ path: 'existing.txt', content: 'v2' }] }),
        basePath: '.',
      }),
      /already exists/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write_code_from_artifact overwrites when enabled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'code-artifact-force-'));
  const access = { root, unrestricted: false };
  try {
    await writeCodeFromArtifact({
      ...access,
      artifact: JSON.stringify({ files: [{ path: 'file.txt', content: 'v1' }] }),
      basePath: '.',
      overwrite: true,
    });

    const result = await writeCodeFromArtifact({
      ...access,
      artifact: JSON.stringify({ files: [{ path: 'file.txt', content: 'v2' }] }),
      basePath: '.',
      overwrite: true,
    });

    assert.equal(result.files[0]!.overwritten, true);
    assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'v2\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
