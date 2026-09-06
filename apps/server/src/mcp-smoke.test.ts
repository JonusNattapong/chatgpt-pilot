import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('stdio MCP exposes and executes the machine tools', async () => {
  const distDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-stdio-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(distDirectory, 'index.js'),
      '--root',
      root,
      '--dangerously-open-machine',
    ],
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !['MCP_SUPERVISED', 'MCP_SUPERVISOR_STATE_FILE'].includes(entry[0])),
    ),
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'chatgpt-machine-mcp-smoke', version: '0.1.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  let resourceUpdates = 0;
  client.setNotificationHandler('notifications/resources/updated', async () => { resourceUpdates++; });

  try {
    await client.connect(transport);
    const capabilities = client.getServerCapabilities();
    assert.ok(capabilities?.prompts && capabilities.resources && capabilities.completions && capabilities.logging);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'apply_patch',
      'audit_recent',
      'audit_search',
      'capability_diff',
      'disk_info',
      'edit_file',
      'environment_info',
      'exec_process',
      'file_info',
      'find_files',
      'git_add',
      'git_branch',
      'git_checkout',
      'git_commit',
      'git_commit_verified',
      'git_diff',
      'git_log',
      'git_publish_paths',
      'git_push',
      'git_remote_status',
      'git_show',
      'git_status',
      'image_info',
      'list_directory',
      'list_ports',
      'list_processes',
      'machine_call',
      'machine_probe',
      'machine_read',
      'machine_status',
      'machine_tools',
      'machines_list',
      'network_info',
      'process_status',
      'process_wait',
      'process_write',
      'project_snapshot',
      'read_file',
      'read_files',
      'read_process_output',
      'restart_if_stale',
      'runtime_exec',
      'runtime_info',
      'save_image_from_url',
      'search_code',
      'self_update',
      'shell_command',
      'start_process',
      'stop_process',
      'system_info',
      'update_file',
      'verify_changes',
      'write_file',
    ]);

    const progress: number[] = [];
    const status = await client.callTool({ name: 'machine_status', arguments: {} }, { onprogress: (event) => { progress.push(event.progress); } });
    assert.equal(status.isError, undefined);
    assert.deepEqual(progress, [0, 1]);
    const statusPayload = JSON.parse((status.content as Array<{ text: string }>)[0].text);
    assert.equal(statusPayload.ok, true);
    assert.equal(statusPayload.status, 'unsupervised');
    assert.equal(statusPayload.workspace.root, root);
    assert.equal(statusPayload.tools, undefined);
    assert.equal(statusPayload.managedProcesses, undefined);

    const detailed = await client.callTool({ name: 'machine_status', arguments: { detailed: true } });
    const detailedPayload = JSON.parse((detailed.content as Array<{ text: string }>)[0].text);
    assert.equal(detailedPayload.accessMode, 'UNRESTRICTED_MACHINE');
    assert.deepEqual(detailedPayload.tools, listed.tools.map((tool) => tool.name));

    const prompts = await client.listPrompts();
    assert.equal(prompts.prompts[0]?.name, 'safe-edit-loop');
    const prompt = await client.getPrompt({ name: 'safe-edit-loop', arguments: { path: 'src/index.ts' } });
    assert.match(JSON.stringify(prompt), /expected_sha256/);
    const resources = await client.listResources();
    assert.equal(resources.resources[0]?.uri, 'workspace://status');
    const resource = await client.readResource({ uri: 'workspace://status' });
    assert.match(JSON.stringify(resource), /UNRESTRICTED_MACHINE/);
    const subscription = await client.listen({ resourceSubscriptions: ['workspace://status'] });

    // Failures answer with the same envelope and a stable machine-readable code.
    const missing = await client.callTool({ name: 'read_file', arguments: { path: 'no-such-file-here.txt' } });
    assert.equal(missing.isError, true);
    const missingPayload = JSON.parse((missing.content as Array<{ text: string }>)[0].text);
    assert.equal(missingPayload.ok, false);
    assert.equal(missingPayload.error.code, 'NOT_FOUND');

    const unknown = await client.callTool({ name: 'not_a_tool', arguments: {} });
    assert.equal(unknown.isError, true);
    assert.equal(JSON.parse((unknown.content as Array<{ text: string }>)[0].text).error.code, 'UNKNOWN_TOOL');

    const shell = await client.callTool({
      name: 'shell_command',
      arguments: {
        command: 'node -e "process.stdout.write(\'mcp-ok\')"',
        workdir: process.cwd(),
        timeout_ms: 10_000,
      },
    });
    assert.equal(shell.isError, undefined, JSON.stringify(shell.content));
    assert.match(JSON.stringify(shell.content), /mcp-ok/);

    const expectation = await client.callTool({ name: 'shell_command', arguments: { command: 'node -e "process.exit(0)"', expect_exit_code: 1, timeout_ms: 10_000 } });
    assert.equal(expectation.isError, true);

    const retryArgs = { path: 'retry.txt', content: 'once', idempotency_key: 'retry-request-123' };
    const firstRetry = await client.callTool({ name: 'write_file', arguments: retryArgs });
    assert.ok(resourceUpdates >= 1);
    const secondRetry = await client.callTool({ name: 'write_file', arguments: retryArgs });
    assert.deepEqual(secondRetry, firstRetry);
    const completion = await client.complete({ ref: { type: 'ref/prompt', name: 'safe-edit-loop' }, argument: { name: 'path', value: 'ret' } });
    assert.ok(completion.completion.values.includes('retry.txt'));
    const conflict = await client.callTool({ name: 'write_file', arguments: { ...retryArgs, content: 'different' } });
    assert.equal(JSON.parse((conflict.content as Array<{ text: string }>)[0].text).error.code, 'IDEMPOTENCY_CONFLICT');

    const protectedPath = await client.callTool({ name: 'read_file', arguments: { path: path.join(root, '.env') } });
    assert.equal(JSON.parse((protectedPath.content as Array<{ text: string }>)[0].text).error.code, 'POLICY_DENIED');
    await subscription.close();

    const promoted = await client.callTool({ name: 'shell_command', arguments: { command: 'node -e "setTimeout(() => console.log(\'done\'), 1000)"', timeout_ms: 100, on_timeout: 'background' } });
    const promotedPayload = JSON.parse((promoted.content as Array<{ text: string }>)[0].text);
    assert.equal(promotedPayload.ok, true);
    assert.equal(promotedPayload.promotedToBackground, true);
    const waited = await client.callTool({ name: 'process_wait', arguments: { pid: promotedPayload.pid, timeout_ms: 5_000 } });
    const waitedPayload = JSON.parse((waited.content as Array<{ text: string }>)[0].text);
    assert.equal(waitedPayload.ok, true);
    assert.equal(waitedPayload.completed, true);
    assert.equal(waitedPayload.timedOut, false);
    assert.equal(waitedPayload.exitCode, 0);
    assert.ok(waitedPayload.nextStdoutOffset > promotedPayload.nextStdoutOffset);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('MCP 2026-07-28 MRTR approval executes an approval-gated tool after elicitation', async () => {
  const distDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-mrtr-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(distDirectory, 'index.js'),
      '--root',
      root,
      '--policy',
      'developer',
    ],
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !['MCP_SUPERVISED', 'MCP_SUPERVISOR_STATE_FILE'].includes(entry[0])),
    ),
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'chatgpt-machine-mcp-mrtr', version: '0.3.0' },
    {
      versionNegotiation: { mode: 'auto' },
      capabilities: { elicitation: { form: {} } },
    },
  );
  let approvals = 0;
  client.setRequestHandler('elicitation/create', async () => {
    approvals++;
    return { action: 'accept', content: { approve: true } };
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'shell_command',
      arguments: {
        command: process.platform === 'win32' ? 'Write-Output approved' : 'printf approved',
        workdir: root,
        timeout_ms: 10_000,
      },
    });
    assert.equal(approvals, 1);
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.match(JSON.stringify(result.content), /approved/);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('server-wide dry-run prevents mutation', async () => {
  const distDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = await mkdtemp(path.join(tmpdir(), 'machine-mcp-server-dry-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(distDirectory, 'index.js'), '--root', root, '--dry-run'], env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), stderr: 'pipe' });
  const client = new Client({ name: 'dry-run-smoke', version: '0.3.0' }, { versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'write_file', arguments: { path: 'blocked.txt', content: 'nope' } });
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    assert.equal(payload.dryRun, true);
    assert.equal(await access(path.join(root, 'blocked.txt')).then(() => true, () => false), false);
  } finally { await client.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
