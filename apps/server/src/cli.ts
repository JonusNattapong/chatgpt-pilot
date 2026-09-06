#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configEnvironment, initLocalConfig, loadLocalConfig, localConfigPath, setWorkspaceRoot, type LocalConfig } from './config.js';
import { machinesConfigPath, readMachineRegistry, removeMachine, upsertMachine } from './machine-router.js';
import { APP_VERSION } from './version.js';
import { initGlobalGpt } from './context.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const scriptsDir = path.join(projectRoot, 'scripts');

type Command = 'setup' | 'up' | 'down' | 'restart' | 'status' | 'use' | 'workspace' | 'machine' | 'doctor' | 'check' | 'config' | 'version' | 'help';

export function normalizeCommand(value: string | undefined): string {
  if (value === undefined || value === '--help' || value === '-h') return 'help';
  if (value === '--version' || value === '-v') return 'version';
  if (value === 'start' || value === 'on') return 'up';
  if (value === 'stop' || value === 'off') return 'down';
  return value;
}

export function usage(): string {
  return `chatgpt-local ${APP_VERSION}\n\nUsage:\n  chatgpt-local setup\n  chatgpt-local up\n  chatgpt-local start   (alias: on; starts the tunnel)\n  chatgpt-local down\n  chatgpt-local stop    (alias: off; stops tunnel and watchdog)\n  chatgpt-local restart\n  chatgpt-local status\n  chatgpt-local use <path>\n  chatgpt-local workspace [path]\n  chatgpt-local machine list\n  chatgpt-local machine add <id> <host[:port]|url> [--token-env VAR] [--name NAME] [--hostname HOST] [--alias VALUE]\n  chatgpt-local machine remove <id>\n  chatgpt-local doctor\n  chatgpt-local check\n  chatgpt-local config [show|init|reset]\n  chatgpt-local version\n\n`;
}

export function run(program: string, args: string[], cwd = projectRoot, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: 'inherit', windowsHide: true, env: { ...process.env, ...env } });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${program} exited with code ${code ?? 'unknown'}`)));
  });
}

function runNpm(args: string[]): Promise<void> {
  if (process.platform === 'win32') return run('cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`]);
  return run('npm', args);
}

export function resolveScript(platform: NodeJS.Platform, scriptsDir: string, name: string): { program: string; args: string[] } {
  if (platform === 'win32') {
    const file = path.join(scriptsDir, `${name}.ps1`);
    return { program: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file] };
  }
  const file = path.join(scriptsDir, `${name}.sh`);
  return { program: 'bash', args: [file] };
}

function script(name: string): { program: string; args: string[] } {
  return resolveScript(process.platform, scriptsDir, name);
}

async function runScript(name: string, config = loadLocalConfig(projectRoot)): Promise<void> {
  const { program, args } = script(name);
  await run(program, args, projectRoot, { ...configEnvironment(config), MCP_MACHINES_FILE: machinesConfigPath(projectRoot) });
}

export function preflight(root: string): string[] {
  const missing: string[] = [];
  const packageJson = path.join(root, 'package.json');
  if (!existsSync(packageJson)) missing.push('package.json');

  const toolClientBinary = process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client';
  if (!existsSync(path.join(root, 'tools', 'tunnel-client-v0.0.13', toolClientBinary))) missing.push('tunnel-client');

  const keyFilename = process.platform === 'win32' ? 'control-plane-api-key.dpapi' : 'control-plane-api-key';
  const hasKey = process.env.CONTROL_PLANE_API_KEY ||
    existsSync(path.join(root, '.pilot', 'tunnel', keyFilename)) ||
    existsSync(path.join(root, '.pilot', keyFilename)) ||
    existsSync(path.join(root, '.tunnel', keyFilename));
  if (!hasKey) missing.push('runtime key');

  return missing;
}

function serverArgs(config: LocalConfig): string[] {
  return [
    path.join(projectRoot, 'dist', 'index.js'),
    '--root', config.workspaceRoot,
    '--policy', config.policy,
    '--approval-mode', config.approvalMode,
    '--machines-file', machinesConfigPath(projectRoot),
    ...(config.accessMode === 'unrestricted' ? ['--dangerously-open-machine'] : []),
  ];
}

async function setup(): Promise<void> {
  const globalGpt = await initGlobalGpt();
  const configFile = initLocalConfig(projectRoot);
  const config = loadLocalConfig(projectRoot);
  const missing = preflight(projectRoot);

  process.stdout.write(`chatgpt-local setup\nproject: ${projectRoot}\nconfig: ${configFile}\nglobal_gpt: ${globalGpt.path} (${globalGpt.created ? 'created' : 'existing'})\nworkspace: ${config.workspaceRoot}\naccess: ${config.accessMode}\n`);
  if (missing.length) {
    process.stdout.write(`missing: ${missing.join(', ')}\n\nSee README.md setup instructions, then run: chatgpt-local up\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('preflight: ok\n');
  await runNpm(['run', 'build']);
  await run(process.execPath, [...serverArgs(config), '--check']);
  process.stdout.write('ready: run `chatgpt-local up`\n');
}

function showConfig(): void {
  const config = loadLocalConfig(projectRoot);
  process.stdout.write(JSON.stringify({ file: localConfigPath(projectRoot), ...config }, null, 2) + '\n');
}

interface SupervisorState {
  ready?: boolean;
  health?: string;
  circuit?: string;
  workerGeneration?: number;
  workerPid?: number | null;
  workerRoot?: string | null;
  restarts?: number;
  lastRestartReason?: string | null;
}

function readSupervisorState(): SupervisorState | undefined {
  const pilotFile = path.join(projectRoot, '.pilot', 'supervisor.json');
  const legacyFile = path.join(projectRoot, '.chatgpt-machine', 'supervisor.json');
  const file = existsSync(pilotFile) || !existsSync(legacyFile) ? pilotFile : legacyFile;
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SupervisorState;
  } catch {
    return undefined;
  }
}

export function workspaceNeedsRestart(configuredRoot: string, state: SupervisorState | undefined): boolean {
  if (!state?.workerRoot || state.health === 'stopped') return false;
  return path.resolve(state.workerRoot) !== path.resolve(configuredRoot);
}

function showWorkspaceRuntimeHint(config: LocalConfig, state = readSupervisorState()): void {
  if (!state?.workerRoot) return;
  process.stdout.write(`runtime_workspace: ${state.workerRoot}\n`);
  if (workspaceNeedsRestart(config.workspaceRoot, state)) {
    process.stdout.write('restart_required: true (run `chatgpt-local restart`)\n');
  }
}

function showSupervisorState(config: LocalConfig): void {
  const state = readSupervisorState();
  if (!state) {
    process.stdout.write('supervisor: no local state\n');
    return;
  }
  const health = typeof state.health === 'string' ? state.health : (state.ready === true ? 'healthy' : 'not-ready');
  process.stdout.write(`supervisor: ${health} (ready=${state.ready === true}) circuit=${state.circuit ?? 'unknown'} generation=${state.workerGeneration ?? '?'} restarts=${state.restarts ?? '?'} worker_pid=${state.workerPid ?? '?'}\n`);
  showWorkspaceRuntimeHint(config, state);
  if (state.lastRestartReason) process.stdout.write(`last_restart: ${String(state.lastRestartReason)}\n`);
}

async function main(): Promise<void> {
  const command = normalizeCommand(process.argv[2]) as Command;
  switch (command) {
    case 'setup':
      await setup();
      break;
    case 'up':
      await runNpm(['run', 'build']);
      await runScript('start-tunnel');
      break;
    case 'down':
      await runScript('stop-tunnel');
      break;
    case 'restart':
      await runNpm(['run', 'build']);
      await runScript('stop-tunnel');
      await runScript('start-tunnel');
      break;
    case 'status': {
      const config = loadLocalConfig(projectRoot);
      process.stdout.write(`workspace: ${config.workspaceRoot}\n`);
      await runScript('status-tunnel');
      showSupervisorState(config);
      break;
    }
    case 'use':
    case 'workspace': {
      const target = process.argv[3];
      if (!target) {
        const config = loadLocalConfig(projectRoot);
        process.stdout.write(`workspace: ${config.workspaceRoot}\n`);
        showWorkspaceRuntimeHint(config);
      } else {
        const updated = setWorkspaceRoot(projectRoot, target);
        process.stdout.write(`Active workspace set to: ${updated.workspaceRoot}\n`);
        showWorkspaceRuntimeHint(updated);
      }
      break;
    }
    case 'machine': {
      const action = process.argv[3] ?? 'list';
      const file = machinesConfigPath(projectRoot);
      if (action === 'list') {
        process.stdout.write(JSON.stringify({ file, ...readMachineRegistry(file) }, null, 2) + '\n');
        break;
      }
      if (action === 'remove') {
        const id = process.argv[4];
        if (!id) throw new Error('machine remove requires <id>.');
        if (!removeMachine(file, id)) throw new Error(`machine not found: ${id}`);
        process.stdout.write(`Removed machine: ${id}\n`);
        break;
      }
      if (action === 'add') {
        const id = process.argv[4];
        const endpoint = process.argv[5];
        if (!id || !endpoint) throw new Error('machine add requires <id> <host[:port]|url>.');
        const rest = process.argv.slice(6);
        let tokenEnv: string | undefined;
        let name: string | undefined;
        let hostname: string | undefined;
        const aliases: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          const flag = rest[i];
          const value = rest[++i];
          if (!value) throw new Error(`${flag} requires a value.`);
          if (flag === '--token-env') tokenEnv = value;
          else if (flag === '--name') name = value;
          else if (flag === '--hostname') hostname = value;
          else if (flag === '--alias') aliases.push(value);
          else throw new Error(`Unknown machine add option: ${flag}`);
        }
        const machine = upsertMachine(file, { id, endpoint, tokenEnv, name, hostname, aliases: aliases.length ? aliases : undefined });
        process.stdout.write(JSON.stringify({ file, machine }, null, 2) + '\n');
        process.stdout.write('Restart the gateway/tunnel only if token environment variables changed; registry edits are loaded per call.\n');
        break;
      }
      throw new Error('machine action must be list, add, or remove.');
    }
    case 'doctor': {
      await runNpm(['run', 'build']);
      const config = loadLocalConfig(projectRoot);
      await run(process.execPath, [...serverArgs(config), '--doctor']);
      break;
    }
    case 'check': {
      await runNpm(['run', 'build']);
      const config = loadLocalConfig(projectRoot);
      await run(process.execPath, [...serverArgs(config), '--check']);
      break;
    }
    case 'config': {
      const action = process.argv[3] ?? 'show';
      if (action === 'init') initLocalConfig(projectRoot);
      else if (action === 'reset') initLocalConfig(projectRoot, true);
      else if (action !== 'show') throw new Error('config action must be show, init, or reset.');
      showConfig();
      break;
    }
    case 'version':
      process.stdout.write(`${APP_VERSION}\n`);
      break;
    case 'help':
    default:
      process.stdout.write(usage());
      if (command !== 'help') process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`chatgpt-local: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
