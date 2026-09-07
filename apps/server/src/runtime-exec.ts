import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { describeError, ToolError, type ToolErrorCode } from './errors.js';

export interface RuntimeCapability {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
}

export interface RuntimeCallSummary {
  name: string;
  ok: boolean;
  durationMs: number;
  errorCode?: string;
}

export interface RuntimeExecOptions {
  code: string;
  sessionId: string;
  resetSession?: boolean;
  timeoutMs: number;
  maxCalls: number;
  maxOutputBytes: number;
  capabilities: RuntimeCapability[];
  allowedTools: Set<string>;
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface RuntimeExecResult {
  runtime: 'ipython';
  persistent: true;
  sessionId: string;
  python: string;
  executionCount: number;
  result: unknown;
  stdout?: string;
  stderr?: string;
  displays?: Array<{ type: 'execute_result' | 'display_data'; text?: string }>;
  outputTruncated?: true;
  calls: RuntimeCallSummary[];
  usage: {
    calls: number;
    outputBytes: number;
    protocolBytes: number;
  };
}

interface PythonCommand {
  command: string;
  prefixArgs: string[];
  display: string;
}

interface ActiveExecution {
  resolve: (value: RuntimeExecResult) => void;
  reject: (error: unknown) => void;
  invoke: RuntimeExecOptions['invoke'];
  capabilities: RuntimeCapability[];
  allowedTools: Set<string>;
  maxCalls: number;
  maxOutputBytes: number;
  calls: RuntimeCallSummary[];
  callCount: number;
  protocolBytes: number;
  timer: NodeJS.Timeout;
}

interface RuntimeSession {
  id: string;
  child: ChildProcessWithoutNullStreams;
  python: string;
  ready: Promise<void>;
  readyResolve: () => void;
  readyReject: (error: unknown) => void;
  active?: ActiveExecution;
  queue: Promise<unknown>;
  lastUsedAt: number;
  stderrTail: string;
  executionCount: number;
  closed: boolean;
}

const MAX_CODE_BYTES = 256 * 1024;
const MAX_PROTOCOL_LINE_BYTES = 4 * 1024 * 1024;
const MAX_PROTOCOL_BYTES = 16 * 1024 * 1024;
const MAX_SESSIONS = 8;
const SESSION_IDLE_TTL_MS = 30 * 60_000;
const STARTUP_TIMEOUT_MS = 20_000;
const IMPORT_CHECK = 'import IPython, ipykernel, jupyter_client; print(IPython.__version__)';

const PYTHON_HELPER_SOURCE = String.raw`
import ast
import json
import os
import queue
import secrets
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Empty

from jupyter_client import KernelManager
from jupyter_client.kernelspec import KernelSpec

_write_lock = threading.Lock()
_pending_lock = threading.Lock()
_pending = {}
_requests = queue.Queue()
_stopping = threading.Event()
_bridge_token = secrets.token_urlsafe(32)


def _json_safe(value, depth=0, seen=None):
    if seen is None:
        seen = set()
    if depth > 20:
        return '[max-depth]'
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, bytes):
        return {'type': 'bytes', 'length': len(value), 'hex': value[:128].hex(), 'truncated': len(value) > 128}
    marker = id(value)
    if marker in seen:
        return '[circular]'
    seen.add(marker)
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_safe(item, depth + 1, seen) for item in list(value)[:10000]]
    if isinstance(value, dict):
        output = {}
        for index, (key, child) in enumerate(value.items()):
            if index >= 10000:
                output['__truncated__'] = True
                break
            output[str(key)] = _json_safe(child, depth + 1, seen)
        return output
    return {'type': type(value).__name__, 'repr': repr(value)[:8000]}


def _send(value):
    # Keep the line protocol ASCII-only. This makes the parent/child boundary
    # independent from the Windows active code page while preserving Unicode
    # losslessly through JSON escapes.
    line = json.dumps(_json_safe(value), ensure_ascii=True, separators=(',', ':'))
    with _write_lock:
        sys.stdout.write(line + '\n')
        sys.stdout.flush()


class _BridgeWaiter:
    def __init__(self):
        self.event = threading.Event()
        self.value = None


class _BridgeHandler(BaseHTTPRequestHandler):
    server_version = 'ChatGPTMCPBridge/1'

    def log_message(self, *_args):
        return

    def _reply(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        if self.path != '/host' or self.headers.get('x-chatgpt-mcp-token') != _bridge_token:
            self._reply(403, {'ok': False, 'error': {'code': 'POLICY_DENIED', 'message': 'Invalid runtime bridge request.'}})
            return
        try:
            length = int(self.headers.get('content-length') or '0')
        except ValueError:
            length = 0
        if length <= 0 or length > 4 * 1024 * 1024:
            self._reply(413, {'ok': False, 'error': {'code': 'TOO_LARGE', 'message': 'Runtime bridge payload is invalid or too large.'}})
            return
        try:
            request = json.loads(self.rfile.read(length).decode('utf-8'))
            request_id = secrets.token_hex(12)
            waiter = _BridgeWaiter()
            with _pending_lock:
                _pending[request_id] = waiter
            _send({'type': request.get('kind'), 'id': request_id, 'name': request.get('name'), 'args': request.get('args')})
            if not waiter.event.wait(120):
                with _pending_lock:
                    _pending.pop(request_id, None)
                self._reply(504, {'ok': False, 'error': {'code': 'TIMEOUT', 'message': 'Host capability response timed out.'}})
                return
            response = waiter.value or {'error': {'code': 'INTERNAL', 'message': 'Missing host capability response.'}}
            if response.get('error'):
                self._reply(400, {'ok': False, 'error': response['error']})
            else:
                self._reply(200, {'ok': True, 'result': response.get('result')})
        except Exception as exc:
            self._reply(500, {'ok': False, 'error': {'code': 'INTERNAL', 'message': str(exc)}})


def _stdin_reader():
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except Exception:
            continue
        message_type = message.get('type')
        if message_type == 'response':
            request_id = str(message.get('id', ''))
            with _pending_lock:
                waiter = _pending.pop(request_id, None)
            if waiter is not None:
                waiter.value = message
                waiter.event.set()
            continue
        if message_type in ('run', 'shutdown'):
            _requests.put(message)
            if message_type == 'shutdown':
                return


_bridge = ThreadingHTTPServer(('127.0.0.1', 0), _BridgeHandler)
_bridge.daemon_threads = True
threading.Thread(target=_bridge.serve_forever, name='chatgpt-mcp-bridge', daemon=True).start()
threading.Thread(target=_stdin_reader, name='chatgpt-mcp-stdin', daemon=True).start()

_bridge_port = _bridge.server_address[1]
_km = KernelManager(kernel_name='')
_km._kernel_spec = KernelSpec(
    argv=[sys.executable, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
    display_name='ChatGPT Machine MCP',
    language='python',
)
_kc = None


def _kernel_bootstrap():
    bridge_url = 'http://127.0.0.1:%d/host' % _bridge_port
    return """
import asyncio as _chatgpt_asyncio
import json as _chatgpt_json
import urllib.error as _chatgpt_urlerror
import urllib.request as _chatgpt_urlrequest

_CHATGPT_MCP_BRIDGE_URL = %r
_CHATGPT_MCP_BRIDGE_TOKEN = %r
__chatgpt_result__ = None

class HostCallError(RuntimeError):
    def __init__(self, payload):
        error = payload.get('error') or {}
        super().__init__(str(error.get('message') or 'Host capability call failed.'))
        self.code = error.get('code')
        self.hint = error.get('hint')
        self.details = error.get('details')


def _chatgpt_json_safe(value, depth=0, seen=None):
    if seen is None:
        seen = set()
    if depth > 20:
        return '[max-depth]'
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, bytes):
        return {'type': 'bytes', 'length': len(value), 'hex': value[:128].hex(), 'truncated': len(value) > 128}
    marker = id(value)
    if marker in seen:
        return '[circular]'
    seen.add(marker)
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_chatgpt_json_safe(item, depth + 1, seen) for item in list(value)[:10000]]
    if isinstance(value, dict):
        output = {}
        for index, (key, child) in enumerate(value.items()):
            if index >= 10000:
                output['__truncated__'] = True
                break
            output[str(key)] = _chatgpt_json_safe(child, depth + 1, seen)
        return output
    return {'type': type(value).__name__, 'repr': repr(value)[:8000]}


def _chatgpt_host_sync(kind, name=None, args=None):
    body = _chatgpt_json.dumps({'kind': kind, 'name': name, 'args': args or {}}, ensure_ascii=False).encode('utf-8')
    request = _chatgpt_urlrequest.Request(
        _CHATGPT_MCP_BRIDGE_URL,
        data=body,
        method='POST',
        headers={
            'content-type': 'application/json',
            'x-chatgpt-mcp-token': _CHATGPT_MCP_BRIDGE_TOKEN,
        },
    )
    try:
        with _chatgpt_urlrequest.urlopen(request, timeout=120) as response:
            payload = _chatgpt_json.loads(response.read().decode('utf-8'))
    except _chatgpt_urlerror.HTTPError as exc:
        try:
            payload = _chatgpt_json.loads(exc.read().decode('utf-8'))
        except Exception:
            payload = {'ok': False, 'error': {'code': 'REMOTE_ERROR', 'message': str(exc)}}
    if not payload.get('ok'):
        raise HostCallError(payload)
    return payload.get('result')


async def call(name, args=None, **kwargs):
    payload = dict(args or {})
    payload.update(kwargs)
    return await _chatgpt_asyncio.to_thread(_chatgpt_host_sync, 'call', str(name), payload)


async def describe(name=None, names=None):
    if name is not None and names is not None:
        raise TypeError('describe accepts either name or names, not both.')
    if names is not None:
        if not isinstance(names, (list, tuple)) or not all(isinstance(item, str) for item in names):
            raise TypeError('describe(names=...) requires a list of strings.')
        return await _chatgpt_asyncio.to_thread(_chatgpt_host_sync, 'describe', None, {'names': list(names)})
    return await _chatgpt_asyncio.to_thread(_chatgpt_host_sync, 'describe', None if name is None else str(name), {})


class _ChatGPTTools:
    def __getattr__(self, name):
        async def invoke(*args, **kwargs):
            if len(args) > 1 or (args and not isinstance(args[0], dict)):
                raise TypeError('Capability calls accept at most one positional dict plus keyword arguments.')
            payload = dict(args[0]) if args else {}
            payload.update(kwargs)
            return await call(name, payload)
        return invoke


def result(value):
    globals()['__chatgpt_result__'] = value
    # Do not echo the structured result through IPython's execute_result
    # channel. The value is returned separately through user_expressions.
    return None


def _chatgpt_result_json():
    return _chatgpt_json.dumps(_chatgpt_json_safe(globals().get('__chatgpt_result__')), ensure_ascii=True)


tools = _ChatGPTTools()
""" % (bridge_url, _bridge_token)


def _take(text, remaining):
    if remaining <= 0:
        return '', 0, bool(text)
    raw = text.encode('utf-8', errors='replace')
    if len(raw) <= remaining:
        return text, remaining - len(raw), False
    clipped = raw[:remaining].decode('utf-8', errors='ignore')
    return clipped, 0, True


def _await_shell(msg_id, deadline):
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Timed out waiting for execute_reply.')
        message = _kc.get_shell_msg(timeout=min(1.0, remaining))
        if message.get('parent_header', {}).get('msg_id') == msg_id:
            return message


def _execute(code, timeout_ms, max_output_bytes, capture=True):
    deadline = time.monotonic() + max(1.0, timeout_ms / 1000.0)
    expressions = {'chatgpt_result': '_chatgpt_result_json()'} if capture else {}
    msg_id = _kc.execute(
        code,
        allow_stdin=False,
        stop_on_error=True,
        user_expressions=expressions,
    )
    stdout_parts = []
    stderr_parts = []
    displays = []
    remaining_bytes = max_output_bytes
    truncated = False
    idle = False
    execution_count = 0
    while not idle:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('IPython cell exceeded its execution timeout.')
        try:
            message = _kc.get_iopub_msg(timeout=min(0.5, remaining))
        except Empty:
            continue
        if message.get('parent_header', {}).get('msg_id') != msg_id:
            continue
        message_type = message.get('msg_type')
        content = message.get('content') or {}
        if message_type == 'status' and content.get('execution_state') == 'idle':
            idle = True
            continue
        if message_type == 'execute_input':
            execution_count = int(content.get('execution_count') or 0)
            continue
        if message_type == 'stream':
            text = str(content.get('text') or '')
            piece, remaining_bytes, clipped = _take(text, remaining_bytes)
            truncated = truncated or clipped
            if content.get('name') == 'stderr':
                stderr_parts.append(piece)
            else:
                stdout_parts.append(piece)
            continue
        if message_type == 'error':
            text = '\n'.join(str(item) for item in (content.get('traceback') or []))
            piece, remaining_bytes, clipped = _take(text, remaining_bytes)
            truncated = truncated or clipped
            stderr_parts.append(piece)
            continue
        if message_type in ('execute_result', 'display_data'):
            text = str((content.get('data') or {}).get('text/plain') or '')
            piece, remaining_bytes, clipped = _take(text, remaining_bytes)
            truncated = truncated or clipped
            displays.append({'type': message_type, 'text': piece})

    shell = _await_shell(msg_id, deadline)
    shell_content = shell.get('content') or {}
    execution_count = int(shell_content.get('execution_count') or execution_count or 0)
    if shell_content.get('status') != 'ok':
        error = {
            'code': 'INTERNAL',
            'message': str(shell_content.get('evalue') or shell_content.get('ename') or 'IPython execution failed.'),
            'details': {
                'ename': shell_content.get('ename'),
                'traceback': shell_content.get('traceback') or [],
            },
        }
        return {'ok': False, 'error': error, 'executionCount': execution_count, 'stdout': ''.join(stdout_parts), 'stderr': ''.join(stderr_parts), 'displays': displays, 'outputTruncated': truncated}

    result_value = None
    if capture:
        expression = (shell_content.get('user_expressions') or {}).get('chatgpt_result') or {}
        if expression.get('status') == 'ok':
            text_repr = str((expression.get('data') or {}).get('text/plain') or "''")
            try:
                result_value = json.loads(ast.literal_eval(text_repr))
            except Exception:
                result_value = {'type': 'unparsed-result', 'repr': text_repr[:8000]}

    return {
        'ok': True,
        'result': result_value,
        'executionCount': execution_count,
        'stdout': ''.join(stdout_parts),
        'stderr': ''.join(stderr_parts),
        'displays': displays,
        'outputTruncated': truncated,
    }


try:
    _km.start_kernel(cwd=os.getcwd())
    _kc = _km.blocking_client()
    _kc.start_channels()
    _kc.wait_for_ready(timeout=15)
    bootstrap = _execute(_kernel_bootstrap(), 15_000, 256 * 1024, capture=False)
    if not bootstrap.get('ok'):
        raise RuntimeError(bootstrap.get('error', {}).get('message') or 'Kernel bootstrap failed.')
    _send({'type': 'ready', 'python': sys.executable})

    while not _stopping.is_set():
        message = _requests.get()
        if message.get('type') == 'shutdown':
            break
        if message.get('type') != 'run':
            continue
        try:
            code = str(message.get('code') or '')
            timeout_ms = int(message.get('timeoutMs') or 30_000)
            max_output_bytes = int(message.get('maxOutputBytes') or 1024 * 1024)
            prepared = "__chatgpt_result__ = None\n" + code
            outcome = _execute(prepared, timeout_ms, max_output_bytes, capture=True)
            if outcome.get('ok'):
                _send({'type': 'done', **outcome})
            else:
                _send({'type': 'error', **outcome})
        except TimeoutError as exc:
            try:
                _km.interrupt_kernel()
            except Exception:
                pass
            _send({'type': 'error', 'error': {'code': 'TIMEOUT', 'message': str(exc)}})
        except Exception as exc:
            _send({'type': 'error', 'error': {'code': 'INTERNAL', 'message': str(exc), 'details': {'traceback': traceback.format_exc()[-12000:]}}})
finally:
    _stopping.set()
    if _kc is not None:
        try:
            _kc.stop_channels()
        except Exception:
            pass
    try:
        _km.shutdown_kernel(now=True)
    except Exception:
        pass
    try:
        _bridge.server_close()
    except Exception:
        pass
`;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolError('INVALID_ARGUMENT', 'Runtime capability arguments must be an object.');
  }
  return value as Record<string, unknown>;
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function normalizeSessionId(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new ToolError('INVALID_ARGUMENT', '"session_id" must be 1-64 characters using letters, numbers, dot, underscore, or hyphen.');
  }
  return value;
}

function toolErrorFromDescription(error: { code?: string; message?: string; hint?: string; details?: Record<string, unknown> }): ToolError {
  const code = typeof error.code === 'string' ? error.code as ToolErrorCode : 'INTERNAL';
  return new ToolError(code, error.message ?? 'Persistent IPython runtime failed.', error.hint, error.details);
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); }
  catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

function resolveKernelPython(): PythonCommand {
  const override = process.env.CHATGPT_MCP_KERNEL_PYTHON;
  const candidates: PythonCommand[] = [
    ...(override ? [{ command: override, prefixArgs: [], display: override }] : []),
    { command: 'python', prefixArgs: [], display: 'python' },
    { command: 'python3', prefixArgs: [], display: 'python3' },
    ...(process.platform === 'win32' ? [{ command: 'py', prefixArgs: ['-3'], display: 'py -3' }] : []),
  ];
  const failures: string[] = [];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.prefixArgs, '-c', IMPORT_CHECK], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    });
    if (probe.status === 0) return candidate;
    const detail = probe.error?.message ?? probe.stderr?.trim() ?? `exit=${probe.status}`;
    failures.push(`${candidate.display}: ${detail}`.slice(0, 1000));
  }
  throw new ToolError(
    'DEPENDENCY_MISSING',
    'Persistent IPython runtime requires Python with IPython, ipykernel, and jupyter_client.',
    'Install them into Python (python -m pip install IPython ipykernel jupyter_client) or set CHATGPT_MCP_KERNEL_PYTHON to a compatible interpreter.',
    { probes: failures },
  );
}

export class PersistentIpythonRuntime {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly allChildren = new Set<ChildProcessWithoutNullStreams>();
  private pythonCommand?: PythonCommand;

  constructor(private readonly root: string) {}

  private python(): PythonCommand {
    this.pythonCommand ??= resolveKernelPython();
    return this.pythonCommand;
  }

  private sweepIdleSessions(): void {
    const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
    for (const [id, session] of this.sessions) {
      if (!session.active && session.lastUsedAt < cutoff) this.disposeSession(id);
    }
    if (this.sessions.size < MAX_SESSIONS) return;
    const idle = [...this.sessions.values()]
      .filter((session) => !session.active)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    while (this.sessions.size >= MAX_SESSIONS && idle.length > 0) {
      this.disposeSession(idle.shift()!.id);
    }
  }

  private createSession(id: string): RuntimeSession {
    this.sweepIdleSessions();
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new ToolError('TOO_LARGE', `Persistent IPython runtime is limited to ${MAX_SESSIONS} live sessions.`, 'Reuse an existing session_id or reset an idle session.');
    }
    const python = this.python();
    const child = spawn(python.command, [...python.prefixArgs, '-u', '-c', PYTHON_HELPER_SOURCE], {
      cwd: this.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });
    this.allChildren.add(child);
    child.once('exit', () => {
      this.allChildren.delete(child);
    });
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const session: RuntimeSession = {
      id,
      child,
      python: python.display,
      ready,
      readyResolve,
      readyReject,
      queue: Promise.resolve(),
      lastUsedAt: Date.now(),
      stderrTail: '',
      executionCount: 0,
      closed: false,
    };
    this.sessions.set(id, session);

    const startupTimer = setTimeout(() => {
      if (session.closed) return;
      const error = new ToolError('TIMEOUT', `Persistent IPython session ${id} did not become ready within ${STARTUP_TIMEOUT_MS} ms.`);
      session.readyReject(error);
      this.disposeSession(id, error);
    }, STARTUP_TIMEOUT_MS);

    child.stderr.on('data', (chunk: Buffer) => {
      session.stderrTail = `${session.stderrTail}${chunk.toString('utf8')}`.slice(-16_000);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
        this.failActive(session, new ToolError('TOO_LARGE', 'Persistent IPython runtime emitted an oversized protocol frame.'));
        this.disposeSession(id);
        return;
      }
      this.onRuntimeLine(session, line, startupTimer);
    });
    child.once('error', (error) => {
      clearTimeout(startupTimer);
      session.readyReject(new ToolError('DEPENDENCY_MISSING', `Failed to start Python runtime: ${error.message}`));
      this.failActive(session, error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(startupTimer);
      session.closed = true;
      this.sessions.delete(id);
      const error = new ToolError(
        'INTERNAL',
        `Persistent IPython runtime exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`,
        undefined,
        session.stderrTail ? { stderr: session.stderrTail } : undefined,
      );
      session.readyReject(error);
      this.failActive(session, error);
    });
    return session;
  }

  private failActive(session: RuntimeSession, error: unknown): void {
    const active = session.active;
    if (!active) return;
    clearTimeout(active.timer);
    session.active = undefined;
    active.reject(error);
  }

  private send(session: RuntimeSession, message: Record<string, unknown>): void {
    if (session.closed || session.child.killed || !session.child.stdin.writable) {
      throw new ToolError('INTERNAL', `Persistent IPython session ${session.id} is not writable.`);
    }
    session.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onRuntimeLine(session: RuntimeSession, line: string, startupTimer: NodeJS.Timeout): void {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      message = asRecord(parsed);
    } catch {
      session.stderrTail = `${session.stderrTail}\n[protocol] ${line}`.slice(-16_000);
      return;
    }
    const type = typeof message.type === 'string' ? message.type : '';
    if (type === 'ready') {
      clearTimeout(startupTimer);
      if (typeof message.python === 'string') session.python = message.python;
      session.readyResolve();
      return;
    }
    if (type === 'call' || type === 'describe') {
      void this.handleBridgeRequest(session, message);
      return;
    }
    const active = session.active;
    if (!active) return;
    active.protocolBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (active.protocolBytes > MAX_PROTOCOL_BYTES) {
      this.failActive(session, new ToolError('TOO_LARGE', 'Persistent IPython runtime protocol traffic exceeded 16 MiB.'));
      this.disposeSession(session.id);
      return;
    }
    if (type !== 'done' && type !== 'error') return;
    clearTimeout(active.timer);
    session.active = undefined;
    session.lastUsedAt = Date.now();
    if (type === 'error') {
      const error = message.error && typeof message.error === 'object'
        ? toolErrorFromDescription(message.error as { code?: string; message?: string; hint?: string; details?: Record<string, unknown> })
        : new ToolError('INTERNAL', 'Persistent IPython execution failed.');
      active.reject(error);
      return;
    }
    const responseBytes = jsonBytes(message);
    if (!Number.isFinite(responseBytes) || responseBytes > active.maxOutputBytes + 512 * 1024) {
      active.reject(new ToolError('TOO_LARGE', `runtime_exec result exceeded max_output_bytes (${active.maxOutputBytes}).`, 'Return a smaller object or raise max_output_bytes.'));
      return;
    }
    const stdout = typeof message.stdout === 'string' ? message.stdout : '';
    const stderr = typeof message.stderr === 'string' ? message.stderr : '';
    const displays = Array.isArray(message.displays)
      ? message.displays.slice(0, 100).flatMap((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
        ? [{ type: ((entry as Record<string, unknown>).type === 'display_data' ? 'display_data' : 'execute_result') as 'display_data' | 'execute_result', text: typeof (entry as Record<string, unknown>).text === 'string' ? (entry as Record<string, unknown>).text as string : undefined }]
        : [])
      : [];
    const executionCount = typeof message.executionCount === 'number' ? message.executionCount : session.executionCount + 1;
    session.executionCount = Math.max(session.executionCount, executionCount);
    const response: RuntimeExecResult = {
      runtime: 'ipython',
      persistent: true,
      sessionId: session.id,
      python: session.python,
      executionCount,
      result: message.result,
      calls: active.calls,
      usage: {
        calls: active.callCount,
        outputBytes: Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') + displays.reduce((sum, entry) => sum + Buffer.byteLength(entry.text ?? '', 'utf8'), 0),
        protocolBytes: active.protocolBytes,
      },
    };
    if (stdout) response.stdout = stdout;
    if (stderr) response.stderr = stderr;
    if (displays.length > 0) response.displays = displays;
    if (message.outputTruncated === true) response.outputTruncated = true;
    active.resolve(response);
  }

  private async handleBridgeRequest(session: RuntimeSession, message: Record<string, unknown>): Promise<void> {
    const active = session.active;
    const id = typeof message.id === 'string' ? message.id : '';
    if (!active || !id) return;
    if (message.type === 'describe') {
      const requested = typeof message.name === 'string' ? message.name : undefined;
      const requestArgs = message.args && typeof message.args === 'object' && !Array.isArray(message.args)
        ? message.args as Record<string, unknown> : {};
      const requestedNames = requestArgs.names === undefined ? undefined : requestArgs.names;
      if (requested !== undefined && requestedNames !== undefined) {
        this.send(session, { type: 'response', id, error: describeError(new ToolError('INVALID_ARGUMENT', 'describe accepts either name or names, not both.')) });
        return;
      }
      if (requestedNames !== undefined && (!Array.isArray(requestedNames) || requestedNames.some((name) => typeof name !== 'string'))) {
        this.send(session, { type: 'response', id, error: describeError(new ToolError('INVALID_ARGUMENT', 'describe(names=...) requires an array of strings.')) });
        return;
      }
      const catalog = active.capabilities
        .map((capability) => ({
          name: capability.name,
          description: capability.description,
          inputSchema: capability.inputSchema,
          annotations: capability.annotations,
          authorized: active.allowedTools.has(capability.name),
        }));
      const result = requested
        ? catalog.find((entry) => entry.name === requested) ?? null
        : requestedNames
          ? (requestedNames as string[]).map((name) => catalog.find((entry) => entry.name === name) ?? null)
          : catalog;
      this.send(session, { type: 'response', id, result });
      return;
    }
    const name = typeof message.name === 'string' ? message.name : '';
    const startedAt = Date.now();
    active.callCount++;
    if (active.callCount > active.maxCalls) {
      const error = new ToolError('POLICY_DENIED', `runtime_exec exceeded max_calls (${active.maxCalls}).`);
      active.calls.push({ name, ok: false, durationMs: Date.now() - startedAt, errorCode: error.code });
      this.send(session, { type: 'response', id, error: describeError(error) });
      return;
    }
    if (!active.allowedTools.has(name)) {
      const error = new ToolError('POLICY_DENIED', `Runtime capability ${name || '<missing>'} is not declared in allow_tools for this execution.`);
      active.calls.push({ name, ok: false, durationMs: Date.now() - startedAt, errorCode: error.code });
      this.send(session, { type: 'response', id, error: describeError(error) });
      return;
    }
    let args: Record<string, unknown>;
    try {
      args = asRecord(message.args ?? {});
      if ('idempotency_key' in args) throw new ToolError('INVALID_ARGUMENT', 'Nested runtime calls do not accept idempotency_key; apply idempotency to the outer runtime_exec call.');
      if (jsonBytes(args) > MAX_PROTOCOL_LINE_BYTES) throw new ToolError('TOO_LARGE', 'Runtime capability arguments exceeded 4 MiB.');
    } catch (error: unknown) {
      active.calls.push({ name, ok: false, durationMs: Date.now() - startedAt, errorCode: describeError(error).code });
      this.send(session, { type: 'response', id, error: describeError(error) });
      return;
    }
    try {
      const result = await active.invoke(name, args);
      if (jsonBytes(result) > MAX_PROTOCOL_LINE_BYTES) throw new ToolError('TOO_LARGE', 'Runtime capability result exceeded 4 MiB.');
      active.calls.push({ name, ok: true, durationMs: Date.now() - startedAt });
      this.send(session, { type: 'response', id, result });
    } catch (error: unknown) {
      const described = describeError(error);
      active.calls.push({ name, ok: false, durationMs: Date.now() - startedAt, errorCode: described.code });
      this.send(session, { type: 'response', id, error: described });
    }
  }

  private async executeOne(session: RuntimeSession, options: RuntimeExecOptions): Promise<RuntimeExecResult> {
    await session.ready;
    if (session.closed) throw new ToolError('INTERNAL', `Persistent IPython session ${session.id} is closed.`);
    return new Promise<RuntimeExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new ToolError('TIMEOUT', `runtime_exec exceeded ${options.timeoutMs} ms; the persistent session was terminated to guarantee cleanup.`, 'Reduce the cell scope or increase timeout_ms.');
        this.failActive(session, error);
        this.disposeSession(session.id);
      }, options.timeoutMs + 500);
      session.active = {
        resolve,
        reject,
        invoke: options.invoke,
        capabilities: options.capabilities,
        allowedTools: options.allowedTools,
        maxCalls: options.maxCalls,
        maxOutputBytes: options.maxOutputBytes,
        calls: [],
        callCount: 0,
        protocolBytes: 0,
        timer,
      };
      try {
        this.send(session, {
          type: 'run',
          code: options.code,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
        });
      } catch (error: unknown) {
        clearTimeout(timer);
        session.active = undefined;
        reject(error);
      }
    });
  }

  async execute(options: RuntimeExecOptions): Promise<RuntimeExecResult> {
    const codeBytes = Buffer.byteLength(options.code, 'utf8');
    if (codeBytes === 0 || codeBytes > MAX_CODE_BYTES) {
      throw new ToolError('INVALID_ARGUMENT', `"code" must be between 1 and ${MAX_CODE_BYTES} UTF-8 bytes.`);
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 10 * 60_000) {
      throw new ToolError('INVALID_ARGUMENT', '"timeout_ms" must be an integer between 1000 and 600000.');
    }
    if (!Number.isInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 256) {
      throw new ToolError('INVALID_ARGUMENT', '"max_calls" must be an integer between 1 and 256.');
    }
    if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 1024 || options.maxOutputBytes > 4 * 1024 * 1024) {
      throw new ToolError('INVALID_ARGUMENT', '"max_output_bytes" must be an integer between 1024 and 4194304.');
    }
    const sessionId = normalizeSessionId(options.sessionId);
    if (options.resetSession) this.disposeSession(sessionId);
    let session = this.sessions.get(sessionId);
    if (!session) session = this.createSession(sessionId);
    session.lastUsedAt = Date.now();
    const task = session.queue.then(() => this.executeOne(session!, options));
    session.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  disposeSession(sessionId: string, reason?: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.closed = true;
    if (reason) this.failActive(session, reason);
    try {
      if (session.child.stdin.writable) {
        session.child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
        session.child.stdin.end();
      }
    } catch { /* ignore */ }
    const pid = session.child.pid;
    killProcessTree(pid);
  }

  async disposeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.disposeSession(id);
    for (const child of this.allChildren) {
      killProcessTree(child.pid);
    }
    const deadline = Date.now() + 2000;
    while (this.allChildren.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  status(): Array<{ sessionId: string; active: boolean; executionCount: number; lastUsedAt: string }> {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.id,
      active: Boolean(session.active),
      executionCount: session.executionCount,
      lastUsedAt: new Date(session.lastUsedAt).toISOString(),
    }));
  }
}
