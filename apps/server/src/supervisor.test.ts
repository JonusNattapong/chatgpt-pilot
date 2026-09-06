import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { killProcessTree, McpSupervisor, parseSupervisorArgs } from './supervisor.js';

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last!: T;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (predicate(last)) return last;
    } catch { /* state may not exist yet */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not reached within ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('supervisor options validate the hard request deadline', () => {
  assert.equal(parseSupervisorArgs(['--supervisor-timeout', '5000', '--root', 'x']).requestTimeoutMs, 5000);
  assert.throws(() => parseSupervisorArgs(['--supervisor-timeout', '4999']), /between 5000 and 660000/);
});

test('supervisor restarts a hung MCP worker and the next request succeeds', async () => {
  const distDirectory = path.dirname(fileURLToPath(import.meta.url));
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'machine-supervisor-'));
  const fixture = path.join(fixtureDir, 'worker.mjs');
  const stateFile = path.join(fixtureDir, 'supervisor.json');
  await writeFile(fixture, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}})+'\\n');
  if (m.method === 'notifications/initialized') return;
  if (m.method === 'tools/list') return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'ping',description:'ping',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}},{name:'hang',description:'hang',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]}})+'\\n');
  if (m.method === 'tools/call' && m.params.name === 'hang') return;
  if (m.method === 'tools/call') return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'pong'}]}})+'\\n');
});
`, 'utf8');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(distDirectory, 'supervisor.js'), '--supervisor-timeout', '5000'],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), MCP_SUPERVISOR_CHILD_ENTRY: fixture, MCP_SUPERVISOR_STATE_FILE: stateFile },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'supervisor-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(transport);
    const hung = await client.callTool({ name: 'hang', arguments: {} }).catch((error) => error as Error);
    assert.match(String(hung), /did not answer|worker/i);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const result = await client.callTool({ name: 'ping', arguments: {} });
    assert.match(JSON.stringify(result), /pong/);
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as { ready: boolean; health: string; circuit: string; restarts: number; workerGeneration: number; lastRestartReason: string };
    assert.equal(state.ready, true);
    assert.equal(state.health, 'healthy');
    assert.equal(state.circuit, 'closed');
    assert.ok(state.restarts >= 1);
    assert.ok(state.workerGeneration >= 2);
    assert.match(state.lastRestartReason, /request timeout/);
  } finally {
    await client.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test('killProcessTree terminates a real descendant process tree', async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'machine-process-tree-'));
  const fixture = path.join(fixtureDir, 'parent.mjs');
  const childPidFile = path.join(fixtureDir, 'child.pid');
  await writeFile(fixture, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
writeFileSync(process.argv[2], String(child.pid));
setInterval(() => {}, 1000);
`, 'utf8');

  const parent = spawn(process.execPath, [fixture, childPidFile], {
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  assert.ok(parent.pid);
  let childPid = 0;
  try {
    childPid = await waitFor(
      async () => Number(await readFile(childPidFile, 'utf8')),
      (pid) => Number.isInteger(pid) && pid > 0 && pidAlive(pid),
    );
    assert.equal(pidAlive(parent.pid!), true);
    assert.equal(pidAlive(childPid), true);

    killProcessTree(parent.pid);
    await waitFor(async () => ({ parent: pidAlive(parent.pid!), child: pidAlive(childPid) }), (state) => !state.parent && !state.child, 8_000);
  } finally {
    killProcessTree(parent.pid);
    if (childPid) {
      try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('circuit breaker opens on a crash loop, rejects work, and closes only after a stable half-open probe', async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'machine-circuit-'));
  const fixture = path.join(fixtureDir, 'worker.mjs');
  const stateFile = path.join(fixtureDir, 'supervisor.json');
  await writeFile(fixture, `
import readline from 'node:readline';
const generation = Number(process.env.MCP_WORKER_GENERATION || '1');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion || 'test',capabilities:{tools:{}},serverInfo:{name:'circuit-fixture',version:'1'}}})+'\\n');
    if (generation <= 2) setTimeout(() => process.exit(7), 40);
    return;
  }
  if (m.method === 'notifications/initialized') return;
  if (m.method === 'tools/call') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'pong'}]}})+'\\n');
});
`, 'utf8');

  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  let outputText = '';
  output.on('data', (chunk) => { outputText += chunk.toString(); });
  const supervisor = new McpSupervisor({
    childEntry: fixture,
    childArgs: ['--root', fixtureDir],
    requestTimeoutMs: 1_000,
    restartDelayMs: 30,
    circuitWindowMs: 2_000,
    circuitThreshold: 2,
    circuitCooldownMs: 900,
    recoveryStableMs: 250,
    stateFile,
    stdio: { input, output, error },
  });

  try {
    supervisor.start();
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'test' } }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const opened = await waitFor(
      async () => JSON.parse(await readFile(stateFile, 'utf8')) as { circuit: string; health: string; ready: boolean; workerGeneration: number },
      (state) => state.circuit === 'open',
      4_000,
    );
    assert.equal(opened.health, 'degraded');
    assert.equal(opened.ready, false);
    assert.ok(opened.workerGeneration >= 2);

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'ping', arguments: {} } }) + '\n');
    await waitFor(async () => outputText, (text) => text.includes('circuit_open'), 1_000);

    // This delay is longer than recoveryStableMs but shorter than circuitCooldownMs.
    // A stale recovery timer from generation 2 must not report healthy/ready here.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const stillOpen = JSON.parse(await readFile(stateFile, 'utf8')) as { circuit: string; health: string; ready: boolean };
    assert.equal(stillOpen.circuit, 'open');
    assert.equal(stillOpen.health, 'degraded');
    assert.equal(stillOpen.ready, false);

    const recovered = await waitFor(
      async () => JSON.parse(await readFile(stateFile, 'utf8')) as { circuit: string; health: string; ready: boolean; workerGeneration: number },
      (state) => state.circuit === 'closed' && state.health === 'healthy' && state.ready === true,
      4_000,
    );
    assert.ok(recovered.workerGeneration >= 3);
  } finally {
    supervisor.stop();
    input.end();
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('killProcessTree handles undefined and invalid pid safely', () => {
  assert.doesNotThrow(() => killProcessTree(undefined));
  assert.doesNotThrow(() => killProcessTree(99999999));
});

test('supervisor proxies the real MCP server during normal use', async () => {
  const distDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = await mkdtemp(path.join(tmpdir(), 'machine-supervisor-real-'));
  const stateFile = path.join(root, 'supervisor.json');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(distDirectory, 'supervisor.js'), '--root', root, '--dangerously-open-machine'],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      MCP_SUPERVISOR_STATE_FILE: stateFile,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'supervisor-real-smoke', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 55);
    const compact = await client.callTool({ name: 'machine_status', arguments: {} });
    assert.doesNotMatch(JSON.stringify(compact), /managedProcesses/);
    const detailed = await client.callTool({ name: 'machine_status', arguments: { detailed: true } });
    assert.match(JSON.stringify(detailed), /UNRESTRICTED_MACHINE/);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
