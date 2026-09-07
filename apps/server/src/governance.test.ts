import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLogger, redactSecrets } from './audit.js';
import { IdempotencyStore } from './idempotency.js';
import { evaluatePolicy, loadPolicy, policyFingerprint, validatePolicyConfig } from './policy.js';
import { environmentInfo, listPorts, listProcesses, networkInfo, systemInfo } from './system-tools.js';
import { createToolSpecs } from './tools.js';

async function withRoot(prefix: string, body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('readonly policy denies mutations and developer policy approval-gates high-authority tools', async () => {
  await withRoot('machine-mcp-policy-', async (root) => {
    const specs = createToolSpecs({ root, unrestricted: false, maxTimeoutMs: 60_000 });
    const byName = new Map(specs.map((spec) => [spec.name, spec]));

    const readonly = loadPolicy('readonly', root);
    assert.equal(evaluatePolicy(readonly, byName.get('read_file')!, { path: 'a.txt' }, root).allowed, true);
    assert.equal(evaluatePolicy(readonly, byName.get('write_file')!, { path: 'a.txt', content: 'x' }, root).allowed, false);
    assert.equal(evaluatePolicy(readonly, byName.get('shell_command')!, { command: 'echo hi' }, root).allowed, false);
    assert.equal(evaluatePolicy(readonly, byName.get('machine_call')!, { machine: 'server', tool: 'read_file', arguments: { path: 'README.md' } }, root).allowed, false);
    assert.equal(evaluatePolicy(readonly, byName.get('machine_read')!, { machine: 'server', tool: 'read_file', arguments: { path: 'README.md' } }, root).allowed, false);
    assert.equal(evaluatePolicy(readonly, byName.get('browser_session')!, { action: 'tabs' }, root).allowed, false);
    assert.equal(evaluatePolicy(readonly, byName.get('browser_snapshot')!, {}, root).allowed, true);
    assert.equal(evaluatePolicy(readonly, byName.get('browser_act')!, { action: 'click', ref: 'e1.1' }, root).allowed, false);
    assert.equal(evaluatePolicy(readonly, byName.get('computer_observe')!, { action: 'cursor' }, root).allowed, true);
    assert.equal(evaluatePolicy(readonly, byName.get('computer_act')!, { action: 'click', x: 1, y: 1 }, root).allowed, false);

    const developer = loadPolicy('developer', root);
    const shell = evaluatePolicy(developer, byName.get('shell_command')!, { command: 'npm test', workdir: root }, root);
    assert.equal(shell.allowed, true);
    assert.equal(shell.requiresApproval, true);
    assert.equal(evaluatePolicy(developer, byName.get('exec_process')!, { executable: 'node', args: ['--version'] }, root).requiresApproval, true);
    assert.equal(evaluatePolicy(developer, byName.get('git_publish_paths')!, { path: root, paths: ['README.md'], message: 'docs' }, root).requiresApproval, true);
    const routed = evaluatePolicy(developer, byName.get('machine_call')!, { machine: 'server', tool: 'read_file', arguments: { path: 'README.md' } }, root);
    assert.equal(routed.allowed, true);
    assert.equal(routed.requiresApproval, true);
    const routedRead = evaluatePolicy(developer, byName.get('machine_read')!, { machine: 'server', tool: 'read_file', arguments: { path: 'README.md' } }, root);
    assert.equal(routedRead.allowed, true);
    assert.equal(routedRead.requiresApproval, false);
    assert.equal(evaluatePolicy(developer, byName.get('read_file')!, { path: 'README.md' }, root).requiresApproval, false);
    assert.equal(evaluatePolicy(developer, byName.get('browser_session')!, { action: 'tabs' }, root).requiresApproval, false);
    assert.equal(evaluatePolicy(developer, byName.get('browser_snapshot')!, {}, root).requiresApproval, false);
    assert.equal(evaluatePolicy(developer, byName.get('browser_act')!, { action: 'click', ref: 'e1.1' }, root).requiresApproval, true);
    assert.equal(evaluatePolicy(developer, byName.get('computer_observe')!, { action: 'cursor' }, root).requiresApproval, false);
    assert.equal(evaluatePolicy(developer, byName.get('computer_act')!, { action: 'click', x: 1, y: 1 }, root).requiresApproval, true);
    assert.equal(evaluatePolicy(loadPolicy('admin', root), byName.get('read_file')!, { path: '.env' }, root).allowed, false);
    assert.equal(evaluatePolicy(loadPolicy('admin', root), byName.get('read_file')!, { path: '.ssh/id_ed25519' }, root).allowed, false);
  });
});

test('idempotency rejects conflicting reuse and output redaction covers common credentials', () => {
  const store = new IdempotencyStore();
  store.store('request-123', 'write_file', { path: 'a.txt', content: 'one' }, { ok: true });
  assert.deepEqual(store.lookup('request-123', 'write_file', { content: 'one', path: 'a.txt' }), { ok: true });
  assert.throws(() => store.lookup('request-123', 'write_file', { path: 'a.txt', content: 'two' }), /different tool arguments/);
  assert.equal(redactSecrets('token ghp_abcdefghijklmnopqrstuvwxyz123456'), 'token [REDACTED_SECRET]');
});

test('custom policy file applies path and shell restrictions', async () => {
  await withRoot('machine-mcp-custom-policy-', async (root) => {
    const policyPath = path.join(root, 'policy.json');
    await writeFile(policyPath, JSON.stringify({
      extends: 'admin',
      name: 'ci-safe',
      filesystem: { write: ['allowed'], deny: ['allowed/private'] },
      shell: { deny: ['Remove-Item', 'rm\\s+-rf'] },
      network: { outbound: false },
    }), 'utf8');
    const policy = loadPolicy(policyPath, root);
    const specs = createToolSpecs({ root, unrestricted: true, maxTimeoutMs: 60_000 });
    const byName = new Map(specs.map((spec) => [spec.name, spec]));

    assert.equal(evaluatePolicy(policy, byName.get('write_file')!, { path: path.join(root, 'allowed', 'x.txt'), content: 'x' }, root).allowed, true);
    assert.equal(evaluatePolicy(policy, byName.get('write_file')!, { path: path.join(root, 'elsewhere', 'x.txt'), content: 'x' }, root).allowed, false);
    assert.equal(evaluatePolicy(policy, byName.get('write_file')!, { path: path.join(root, 'allowed', 'private', 'x.txt'), content: 'x' }, root).allowed, false);
    assert.equal(evaluatePolicy(policy, byName.get('shell_command')!, { command: 'Remove-Item x' }, root).allowed, false);
    assert.equal(evaluatePolicy(policy, byName.get('git_push')!, { path: root }, root).allowed, false);
  });
});

test('audit log redacts secrets and hashes large mutation payloads', async () => {
  await withRoot('machine-mcp-audit-', async (root) => {
    const logger = new AuditLogger(path.join(root, 'audit.ndjson'));
    await logger.write({
      traceId: 'trace-1',
      tool: 'shell_command',
      policy: 'admin',
      decision: 'allowed',
      status: 'success',
      durationMs: 1,
      args: {
        command: 'deploy --token super-secret-value',
        content: 'payload that should not be copied verbatim',
        apiKey: 'another-secret',
        text: 'sensitive-text-value',
        expression: 'window.secret = "expression-secret"',
        input: 'process-input-secret',
        url: 'https://user:pass@example.com/path?token=query-secret&mode=debug#fragment-secret',
      },
    });

    const text = await readFile(logger.filePath, 'utf8');
    assert.doesNotMatch(text, /super-secret-value/);
    assert.doesNotMatch(text, /another-secret/);
    assert.doesNotMatch(text, /payload that should not be copied verbatim/);
    assert.doesNotMatch(text, /sensitive-text-value/);
    assert.doesNotMatch(text, /expression-secret/);
    assert.doesNotMatch(text, /process-input-secret/);
    assert.doesNotMatch(text, /query-secret|fragment-secret|user:pass/);
    assert.ok(text.includes('example.com/path'));
    assert.match(text, /REDACTED/);
    assert.match(text, /sha256:/);
    assert.equal((await logger.recent(10)).length, 1);
    assert.equal((await logger.search('shell_command')).length, 1);
  });
});

test('audit records promote remote machine and tool selectors to top-level fields', async () => {
  await withRoot('machine-mcp-audit-routing-', async (root) => {
    const logger = new AuditLogger(path.join(root, 'audit.ndjson'));
    await logger.write({
      traceId: 'trace-routing',
      tool: 'machine_read',
      policy: 'developer',
      decision: 'allowed',
      status: 'success',
      durationMs: 12,
      args: { machine: 'server', tool: 'git_status', arguments: { path: '.' } },
    });

    const [record] = await logger.recent(10) as Array<{ targetMachine?: string; remoteTool?: string; args?: Record<string, unknown> }>;
    assert.equal(record.targetMachine, 'server');
    assert.equal(record.remoteTool, 'git_status');
    assert.ok(record.args);
  });
});

test('system inspection tools return bounded structured information and redact secret-like env values', async () => {
  const previous = process.env.MACHINE_MCP_TEST_TOKEN;
  process.env.MACHINE_MCP_TEST_TOKEN = 'must-not-leak';
  try {
    const info = await systemInfo();
    assert.equal(typeof info.hostname, 'string');
    assert.ok(info.memory.totalBytes > 0);

    const processes = await listProcesses({ limit: 5 });
    assert.ok(processes.processes.length <= 5);

    const ports = await listPorts({ limit: 5 });
    assert.ok(ports.ports.length <= 5);

    const environment = await environmentInfo({ includeValues: true, filter: 'MACHINE_MCP_TEST_TOKEN' });
    assert.equal(environment.variables[0]?.value, '[REDACTED]');

    const network = await networkInfo();
    assert.ok(Array.isArray(network.interfaces));
  } finally {
    if (previous === undefined) delete process.env.MACHINE_MCP_TEST_TOKEN;
    else process.env.MACHINE_MCP_TEST_TOKEN = previous;
  }
});

test('policy validation rejects unknown tools and malformed regular expressions', async () => {
  await withRoot('machine-mcp-policy-validation-', async (root) => {
    const specs = createToolSpecs({ root, unrestricted: false, maxTimeoutMs: 60_000 });
    const unknownPath = path.join(root, 'unknown.json');
    await writeFile(unknownPath, JSON.stringify({ extends: 'admin', tools: { deny: ['git_puhs'] } }), 'utf8');
    assert.throws(() => validatePolicyConfig(loadPolicy(unknownPath, root), specs.map((spec) => spec.name)), /unknown tool: git_puhs/);

    const regexPath = path.join(root, 'regex.json');
    await writeFile(regexPath, JSON.stringify({ extends: 'admin', shell: { deny: ['[unterminated'] } }), 'utf8');
    assert.throws(() => validatePolicyConfig(loadPolicy(regexPath, root), specs.map((spec) => spec.name)), /invalid regular expression/);

    const admin = loadPolicy('admin', root);
    validatePolicyConfig(admin, specs.map((spec) => spec.name));
    assert.match(policyFingerprint(admin), /^[a-f0-9]{64}$/);
  });
});
