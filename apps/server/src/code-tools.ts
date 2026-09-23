import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from './errors.js';
import { resolveMachinePath, type MachineAccess } from './shell-tools.js';

export interface CodeScaffoldOptions extends MachineAccess {
  template: string;
  name: string;
  outputPath: string;
  description?: string;
  author?: string;
  overwrite?: boolean;
}

export interface CodeScaffoldResult {
  template: string;
  name: string;
  files: Array<{ path: string; bytes: number; created: boolean; overwritten: boolean }>;
}

type TemplateContext = {
  name: string;
  description?: string;
  author?: string;
  pascalName: string;
  camelName: string;
  snakeName: string;
  kebabName: string;
  year: string;
};

type TemplateDefinition = {
  description: string;
  files: Array<{ path: (ctx: TemplateContext) => string; content: (ctx: TemplateContext) => string }>;
};

function toPascal(value: string): string {
  return value
    .replace(/[-_ ]+([a-zA-Z])/g, (_, letter) => letter.toUpperCase())
    .replace(/^[a-zA-Z]/, (letter) => letter.toUpperCase());
}

function toCamel(value: string): string {
  const pascal = toPascal(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function toSnake(value: string): string {
  return value
    .replace(/[- ]+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .toLowerCase();
}

function toKebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_ ]+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .toLowerCase();
}

function buildContext(rawName: string, description?: string, author?: string): TemplateContext {
  const normalized = rawName.trim() || 'Generated';
  return {
    name: normalized,
    description: description || '',
    author: author || '',
    pascalName: toPascal(normalized),
    camelName: toCamel(normalized),
    snakeName: toSnake(normalized),
    kebabName: toKebab(normalized),
    year: String(new Date().getFullYear()),
  };
}

const TEMPLATES: Record<string, TemplateDefinition> = {
  'react-component': {
    description: 'React functional component with TypeScript and basic props.',
    files: [
      {
        path: ({ pascalName }) => `${toKebab(pascalName)}.tsx`,
        content: ({ pascalName, description, kebabName }) => [
          "import React from 'react';",
          '',
          description ? `/**` : null,
          description ? ` * ${description}` : null,
          description ? ` */` : null,
          description ? '' : null,
          `interface ${pascalName}Props {`,
          "  title?: string;",
          '}',
          '',
          `export const ${pascalName}: React.FC<${pascalName}Props> = ({ title }) => {`,
          '  return (',
          `    <div className="${kebabName}">`,
          '      <h1>{title ?? ' + `'${pascalName}'` + '}</h1>',
          '    </div>',
          '  );',
          '};',
          '',
          `export default ${pascalName};`,
          '',
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
      },
      {
        path: () => `${toKebab(toPascal('styles'))}.css`,
        content: ({ camelName }) => `.${camelName} {\n  padding: 1rem;\n  font-family: system-ui, sans-serif;\n}\n`,
      },
      {
        path: () => 'index.ts',
        content: ({ pascalName }) => `export { ${pascalName} } from './${toKebab(pascalName)}';\nexport type { ${pascalName}Props } from './${toKebab(pascalName)}';\n`,
      },
    ],
  },
  'typescript-utility': {
    description: 'Pure TypeScript utility module with JSDoc and simple tests.',
    files: [
      {
        path: ({ camelName }) => `${camelName}.ts`,
        content: ({ camelName, description, pascalName }) => [
          description ? `/**` : null,
          description ? ` * ${description}` : null,
          description ? ` */` : null,
          description ? '' : null,
          `export function ${camelName}(value: unknown): boolean {`,
          '  return typeof value === \'string\' && value.trim().length > 0;',
          '}',
          '',
          description ? `/**` : null,
          description ? ` * Normalized result for ${pascalName}.` : null,
          description ? ` */` : null,
          description ? '' : null,
          `export interface ${pascalName}Result {`,
          '  valid: boolean;',
          "  value?: string;",
          '}',
          '',
          `export function ${camelName}Result(input: unknown): ${pascalName}Result {`,
          `  if (${camelName}(input)) {`,
          '    return { valid: true, value: String(input).trim() };',
          '  }',
          '  return { valid: false };',
          '}',
          '',
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
      },
      {
        path: () => `${toKebab(toPascal('tests'))}.test.ts`,
        content: ({ camelName, pascalName }) => [
          "import assert from 'node:assert/strict';",
          "import { describe, it } from 'node:test';",
          `import { ${camelName}, ${camelName}Result } from './${camelName}';`,
          '',
          `describe('${camelName}', () => {`,
          `  it('accepts a non-empty string', () => {`,
          `    assert.equal(${camelName}('hello'), true);`,
          '  });',
          '',
          `  it('rejects blank input', () => {`,
          `    assert.equal(${camelName}('   '), false);`,
          '  });',
          '',
          `  it('returns a normalized result', () => {`,
          `    assert.deepEqual(${camelName}Result('  foo  '), { valid: true, value: 'foo' });`,
          '  });',
          '});',
          '',
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
      },
      {
        path: () => 'index.ts',
        content: ({ camelName, pascalName }) => `export { ${camelName}, ${camelName}Result } from './${camelName}';\nexport type { ${pascalName}Result } from './${camelName}';\n`,
      },
    ],
  },
  'node-service': {
    description: 'Node.js service class with lifecycle and error handling.',
    files: [
      {
        path: ({ camelName }) => `${camelName}.ts`,
        content: ({ pascalName, camelName, description }) => [
          description ? `/**` : null,
          description ? ` * ${description}` : null,
          description ? ` */` : null,
          description ? '' : null,
          `export class ${pascalName}Service {`,
          '  private readonly startedAt?: Date;',
          '',
          `  constructor(private readonly name = '${pascalName}') {}`,
          '',
          '  start(): void {',
          '    if (this.startedAt) {',
          `      throw new Error('${pascalName} is already started');`,
          '    }',
          '    this.startedAt = new Date();',
          `    console.log('[' + this.name + '] started at ' + this.startedAt.toISOString());`,
          '  }',
          '',
          '  stop(): void {',
          '    if (!this.startedAt) {',
          `      throw new Error('${pascalName} is not running');`,
          '    }',
          '    const uptime = Date.now() - this.startedAt.getTime();',
          '    this.startedAt = undefined;',
          `    console.log('[' + this.name + '] stopped after ' + uptime + 'ms');`,
          '  }',
          '',
          "  status(): 'stopped' | 'running' {",
          '    return this.startedAt ? \'running\' : \'stopped\';',
          '  }',
          '}',
          '',
          `export function create${pascalName}(options?: { description?: string; author?: string }) {`,
          '  return new ' + pascalName + 'Service(options?.description ? options.description.slice(0, 40) : undefined);',
          '}',
          '',
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
      },
      {
        path: () => `${toKebab(toPascal('cli'))}.ts`,
        content: ({ pascalName }) => [
          "#!/usr/bin/env node",
          `import { create${pascalName} } from './${toCamel(pascalName)}';`,
          '',
          'const service = create' + pascalName + '();',
          'service.start();',
          "process.on('SIGINT', () => {",
          '  service.stop();',
          '  process.exit(0);',
          '});',
          '',
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
      },
      {
        path: () => `${toKebab(toPascal('tests'))}.test.ts`,
        content: ({ pascalName, camelName }) => [
          "import assert from 'node:assert/strict';",
          "import { describe, it } from 'node:test';",
          `import { ${pascalName}Service, create${pascalName} } from './${camelName}';`,
          '',
          `describe('${pascalName}Service', () => {`,
          `  it('starts and stops', () => {`,
          `    const service = create${pascalName}();`,
          `    assert.equal(service.status(), 'stopped');`,
          '    service.start();',
          `    assert.equal(service.status(), 'running');`,
          '    service.stop();',
          `    assert.equal(service.status(), 'stopped');`,
          '  });',
          '',
          `  it('throws on duplicate start', () => {`,
          `    const service = create${pascalName}();`,
          '    service.start();',
          `    assert.throws(() => service.start(), /already started/);`,
          '    service.stop();',
          '  });',
          '});',
          '',
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
      },
      {
        path: () => 'index.ts',
        content: ({ pascalName, camelName }) => `export { ${pascalName}Service, create${pascalName} } from './${camelName}';\n`,
      },
    ],
  },
  'express-route': {
    description: 'Express.js route with validation and JSON response.',
    files: [
      {
        path: ({ snakeName }) => `${snakeName}.ts`,
        content: ({ pascalName, camelName, snakeName, description }) => [
          "import { Router, Request, Response } from 'express';",
          '',
          'const router = Router();',
          '',
          description ? `/**` : null,
          description ? ` * ${description}` : null,
          description ? ` */` : null,
          description ? '' : null,
          `router.get('/${snakeName}', (req: Request, res: Response) => {`,
          '  const query = req.query as Record<string, unknown>;',
          '  const limit = typeof query.limit === \'string\' ? Number(query.limit) : 20;',
          '',
          '  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {',
          '    return res.status(400).json({ error: \'"limit" must be an integer between 1 and 100.\' });',
          '  }',
          '',
          '  return res.json({',
          '    ok: true,',
          `    template: '${pascalName}',`,
          '    items: Array.from({ length: Math.min(limit, 10) }).map((_, index) => ({',
          `      id: index + 1,`,
          `      name: '${camelName}-sample',`,
          '    })),',
          '  });',
          '});',
          '',
          'export default router;',
          '',
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
      },
      {
        path: () => `${toKebab(toPascal('tests'))}.test.ts`,
        content: ({ snakeName, pascalName }) => [
          "import assert from 'node:assert/strict';",
          "import { describe, it } from 'node:test';",
          "import request from 'node:http';",
          "import { createServer } from 'node:http';",
          `import router from './${snakeName}';`,
          '',
          `describe('${pascalName} route', () => {`,
          `  it('returns items with default limit', async () => {`,
          '    const server = createServer((req, res) => router(req, res as any));',
          '    await new Promise<void>((resolve) => server.listen(0, resolve));',
          '    try {',
          '      const port = (server.address() as any).port;',
          '      const data = await new Promise<any>((resolve, reject) => {',
          `        request.get({ hostname: '127.0.0.1', port, path: '/${snakeName}' }, (res) => {`,
          '          let body = \'\';',
          '          res.on(\'data\', (chunk) => (body += chunk));',
          '          res.on(\'end\', () => resolve(JSON.parse(body)));',
          '        }).on(\'error\', reject);',
          '      });',
          '      assert.equal(data.ok, true);',
          '      assert.equal(Array.isArray(data.items), true);',
          '    } finally {',
          '      await new Promise<void>((resolve) => server.close(() => resolve()));',
          '    }',
          '  });',
          '});',
          '',
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
      },
      {
        path: () => 'index.ts',
        content: ({ snakeName }) => `export { default } from './${snakeName}';\n`,
      },
    ],
  },
  'python-script': {
    description: 'Python CLI script with argparse and typed output.',
    files: [
      {
        path: ({ snakeName }) => `${snakeName}.py`,
        content: ({ pascalName, camelName, description }) =>
          [
            "#!/usr/bin/env python3",
            description ? `"""` : null,
            description ? `${description}` : null,
            description ? `"""` : null,
            description ? '' : null,
            'from __future__ import annotations',
            '',
            'import argparse',
            'from dataclasses import dataclass',
            'from typing import List',
            '',
            '',
            `@dataclass(frozen=True)`,
            `class ${pascalName}Item:`,
            '    id: int',
            '    name: str',
            '',
            '',
            'def main(argv: List[str] | None = None) -> int:',
            `    parser = argparse.ArgumentParser(description='${description || pascalName}')`,
            "    parser.add_argument('--limit', type=int, default=5, help='items to return')",
            `    parser.add_argument('--name', default='${camelName}', help='base name')`,
            '    args = parser.parse_args(argv)',
            '',
            '    if args.limit < 1 or args.limit > 100:',
            "        raise SystemExit('--limit must be between 1 and 100')",
            '',
            `    items = [${pascalName}Item(id=index + 1, name=f"${camelName}-{index + 1}") for index in range(args.limit)]`,
            '    for item in items:',
            '        print(f"{item.id}\\t{item.name}")',
            '',
            '    return 0',
            '',
            '',
            "if __name__ == '__main__':",
            '    raise SystemExit(main())',
            '',
          ]
            .filter((line): line is string => line !== null)
            .join('\n'),
      },
      {
        path: () => `${toKebab(toPascal('tests'))}.test.py`,
        content: ({ snakeName }) => [
          'from __future__ import annotations',
          'import subprocess',
          'import sys',
          'import unittest',
          '',
          '',
          `class ${toPascal(snakeName)}Tests(unittest.TestCase):`,
          '    def test_default_output(self):',
          `        result = subprocess.run([sys.executable, '${snakeName}.py'], capture_output=True, text=True, check=True)`,
          "        lines = [line for line in result.stdout.strip().splitlines() if line]",
          '        self.assertEqual(len(lines), 5)',
          "        self.assertTrue(lines[0].startswith('1\\t'))",
          '',
          '',
          "if __name__ == '__main__':",
          '    unittest.main()',
          '',
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
      },
    ],
  },
  'nextjs-page': {
    description: 'Next.js App Router page with typed props.',
    files: [
      {
        path: ({ snakeName }) => `app/${snakeName}/page.tsx`,
        content: ({ pascalName, camelName, description }) => [
          "import { Metadata } from 'next';",
          '',
          description ? `/**` : null,
          description ? ` * ${description}` : null,
          description ? ` */` : null,
          description ? '' : null,
          `type ${pascalName}PageProps = {`,
          '  params: { id: string };',
          '  searchParams?: Record<string, string | string[]>;',
          '};',
          '',
          'export const metadata: Metadata = {',
          `  title: '${description || pascalName}',`,
          '};',
          '',
          `export default async function ${pascalName}Page({ params }: ${pascalName}PageProps) {`,
          '  const resolved = await params;',
          '  return (',
          `    <main className="${camelName}-page">`,
          `      <h1>${description || pascalName}</h1>`,
          '      <p>id: {resolved.id}</p>',
          '    </main>',
          '  );',
          '}',
          '',
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
      },
      {
        path: ({ snakeName }) => `app/${snakeName}/page.test.tsx`,
        content: ({ pascalName, camelName, snakeName }) => [
          "import assert from 'node:assert/strict';",
          "import { describe, it } from 'node:test';",
          'import React from \'react\';',
          "import { renderToString } from 'react-dom/server';",
          `import ${pascalName}Page from './page';`,
          '',
          `describe('${pascalName}Page', () => {`,
          `  it('renders heading text', () => {`,
          `    const html = renderToString(<${pascalName}Page params={{ id: '1' }} />);`,
          "    assert.match(html, /<h1>/);",
          "    assert.match(html, /<p>/);",
          '  });',
          '});',
          '',
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
      },
    ],
  },
  'api-controller': {
    description: 'REST API controller with standard CRUD response shapes.',
    files: [
      {
        path: ({ snakeName }) => `${snakeName}-controller.ts`,
        content: ({ pascalName, camelName }) => [
          `export interface ${pascalName}Dto {`,
          '  id: string;',
          '  name: string;',
          '  createdAt: string;',
          '}',
          '',
          `export type ${pascalName}CreateInput = Pick<${pascalName}Dto, 'name'>;`,
          `export type ${pascalName}UpdateInput = Partial<${pascalName}CreateInput>;`,
          '',
          `class ${pascalName}Controller {`,
          '  private readonly items = new Map<string, ' + pascalName + 'Dto>();',
          '',
          '  list() {',
          '    return Array.from(this.items.values());',
          '  }',
          '',
          '  get(id: string) {',
          '    const item = this.items.get(id);',
          `    if (!item) throw new Error('${pascalName} not found');`,
          '    return item;',
          '  }',
          '',
          `  create(input: ${pascalName}CreateInput) {`,
          '    const id = crypto.randomUUID();',
          `    const item: ${pascalName}Dto = {`,
          '      id,',
          '      name: input.name.trim(),',
          '      createdAt: new Date().toISOString(),',
          '    };',
          '    this.items.set(id, item);',
          '    return item;',
          '  }',
          '',
          `  update(id: string, input: ${pascalName}UpdateInput) {`,
          '    const existing = this.get(id);',
          `    const updated: ${pascalName}Dto = {`,
          '      ...existing,',
          '      ...(input.name !== undefined ? { name: input.name.trim() } : {}),',
          '    };',
          '    this.items.set(id, updated);',
          '    return updated;',
          '  }',
          '',
          '  delete(id: string) {',
          '    const existed = this.items.has(id);',
          '    this.items.delete(id);',
          `    if (!existed) throw new Error('${pascalName} not found');`,
          '  }',
          '}',
          '',
          `export const ${camelName}Controller = new ${pascalName}Controller();`,
          '',
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
      },
      {
        path: () => `${toKebab(toPascal('tests'))}.test.ts`,
        content: ({ pascalName, camelName }) => [
          "import assert from 'node:assert/strict';",
          "import { describe, it } from 'node:test';",
          `import { ${pascalName}Dto, ${camelName}Controller } from './${toCamel(pascalName)}-controller';`,
          '',
          `describe('${pascalName}Controller', () => {`,
          `  it('creates and reads an item', () => {`,
          `    const created = ${camelName}Controller.create({ name: 'sample' });`,
          `    const item = ${camelName}Controller.get(created.id) as ${pascalName}Dto;`,
          "    assert.equal(item.name, 'sample');",
          '    assert.ok(item.createdAt);',
          '  });',
          '',
          `  it('updates and deletes an item', () => {`,
          `    const created = ${camelName}Controller.create({ name: 'old' });`,
          `    const updated = ${camelName}Controller.update(created.id, { name: 'new' });`,
          "    assert.equal(updated.name, 'new');",
          `    ${camelName}Controller.delete(created.id);`,
          `    assert.throws(() => ${camelName}Controller.get(created.id), /not found/);`,
          '  });',
          '});',
          '',
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
      },
      {
        path: () => 'index.ts',
        content: ({ pascalName, camelName }) => `export { ${camelName}Controller } from './${toCamel(pascalName)}-controller';\nexport type { ${pascalName}Dto, ${pascalName}CreateInput, ${pascalName}UpdateInput } from './${toCamel(pascalName)}-controller';\n`,
      },
    ],
  },
};

export const SUPPORTED_TEMPLATES = Object.keys(TEMPLATES);

export function validateTemplate(template: string): TemplateDefinition {
  const normalized = template.trim();
  if (!normalized) {
    throw new ToolError('INVALID_ARGUMENT', '"template" is required and must be a non-empty string.');
  }
  const definition = TEMPLATES[normalized];
  if (!definition) {
    throw new ToolError('INVALID_ARGUMENT', `Unsupported template: ${template}. Supported: ${SUPPORTED_TEMPLATES.join(', ')}.`);
  }
  return definition;
}

export async function scaffoldCode(options: CodeScaffoldOptions): Promise<CodeScaffoldResult> {
  const absolutePath = await resolveMachinePath(options, options.outputPath, false);
  const definition = validateTemplate(options.template);
  const context = buildContext(options.name, options.description, options.author);
  const files: CodeScaffoldResult['files'] = [];

  for (const file of definition.files) {
    const relativePath = file.path(context).replace(/^\/+/, '');
    const absoluteFile = path.join(absolutePath, ...relativePath.split('/'));
    const parentDir = path.dirname(absoluteFile);
    await mkdir(parentDir, { recursive: true });

    let existed = false;
    try {
      await access(absoluteFile);
      existed = true;
    } catch {
      existed = false;
    }

    if (existed && !options.overwrite) {
      throw new ToolError(
        'ALREADY_EXISTS',
        `File already exists; set "overwrite" to true to replace it: ${relativePath}`,
        `Remove the file or rerun with overwrite=true inside: ${absolutePath}`,
      );
    }

    const content = file.content(context);
    await writeFile(absoluteFile, content, { encoding: 'utf8', flag: options.overwrite ? 'w' : 'wx' });
    files.push({
      path: relativePath,
      bytes: Buffer.byteLength(content),
      created: !existed,
      overwritten: existed,
    });
  }

  return {
    template: options.template,
    name: options.name,
    files,
  };
}

export interface CodeFromArtifactOptions extends MachineAccess {
  artifact: string;
  basePath: string;
  overwrite?: boolean;
}

export interface CodeArtifactFile {
  path: string;
  content: string;
}

export interface CodeFromArtifactResult {
  format: 'json' | 'markdown';
  files: Array<{ path: string; bytes: number; created: boolean; overwritten: boolean }>;
}

export function parseCodeArtifact(artifact: string): CodeArtifactFile[] {
  const trimmed = artifact.trim();
  if (!trimmed) {
    throw new ToolError('INVALID_ARGUMENT', '"artifact" is required and must not be empty.');
  }

  const json = tryParseJsonArtifact(trimmed);
  if (json) return json;

  return parseMarkdownArtifact(trimmed);
}

function tryParseJsonArtifact(artifact: string): CodeArtifactFile[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact);
  } catch {
    return undefined;
  }

  const files = (parsed as Record<string, unknown>).files;
  if (!Array.isArray(files) || files.length === 0) return undefined;

  const result: CodeArtifactFile[] = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new ToolError('INVALID_ARGUMENT', `files[${index}] must be an object with "path" and "content".`);
    }
    const record = file as Record<string, unknown>;
    const filePath = record.path;
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new ToolError('INVALID_ARGUMENT', `files[${index}].path is required and must be a non-empty string.`);
    }
    const content = record.content;
    if (typeof content !== 'string') {
      throw new ToolError('INVALID_ARGUMENT', `files[${index}].content is required and must be a string.`);
    }
    result.push({ path: filePath.trim(), content });
  }

  return result;
}

function parseMarkdownArtifact(artifact: string): CodeArtifactFile[] {
  const lines = artifact.split('\n');
  const files: CodeArtifactFile[] = [];
  let currentPath: string | undefined;
  let currentContent: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (!inCodeBlock) {
      const headerMatch = line.match(/^###\s+path:\s*(.+)$/);
      if (headerMatch) {
        if (currentPath && currentContent.length > 0) {
          files.push({ path: currentPath, content: currentContent.join('\n').replace(/\n$/, '') });
        }
        currentPath = headerMatch[1]!.trim();
        currentContent = [];
        inCodeBlock = true;
        continue;
      }
      continue;
    }

    if (line.trim().startsWith('```')) {
      if (currentContent.length === 0 && line.trim() !== '```') continue;
      inCodeBlock = false;
      continue;
    }

    currentContent.push(line);
  }

  if (currentPath && currentContent.length > 0) {
    files.push({ path: currentPath, content: currentContent.join('\n').replace(/\n$/, '') });
  }

  if (files.length === 0) {
    throw new ToolError('INVALID_ARGUMENT', 'Markdown artifact must include ### path: <file> headers above each code block.');
  }

  return files;
}

export async function writeCodeFromArtifact(options: CodeFromArtifactOptions): Promise<CodeFromArtifactResult> {
  const absoluteBase = await resolveMachinePath(options, options.basePath, false);
  const files = parseCodeArtifact(options.artifact);
  const written: CodeFromArtifactResult['files'] = [];

  for (const file of files) {
    const relativePath = file.path.replace(/^\/+/, '');
    const absoluteFile = path.join(absoluteBase, ...relativePath.split('/'));
    const parentDir = path.dirname(absoluteFile);
    await mkdir(parentDir, { recursive: true });

    let existed = false;
    try {
      await access(absoluteFile);
      existed = true;
    } catch {
      existed = false;
    }

    if (existed && !options.overwrite) {
      throw new ToolError(
        'ALREADY_EXISTS',
        `File already exists; set "overwrite" to true to replace it: ${relativePath}`,
        `Remove the file or rerun with overwrite=true inside: ${absoluteBase}`,
      );
    }

    const trimmed = file.content.replace(/\n$/, '') + '\n';
    await writeFile(absoluteFile, trimmed, { encoding: 'utf8', flag: options.overwrite ? 'w' : 'wx' });
    written.push({
      path: relativePath,
      bytes: Buffer.byteLength(trimmed),
      created: !existed,
      overwritten: existed,
    });
  }

  return { format: files.length > 0 && options.artifact.trim().startsWith('{') ? 'json' : 'markdown', files: written };
}
