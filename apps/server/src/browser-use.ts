import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { ToolError } from './errors.js';
import { mcpImageResult } from './mcp-content.js';
import type { ToolSpec } from './tools.js';

const MAX_SESSIONS = 8;
const SESSION_IDLE_MS = 15 * 60_000;
const MAX_SNAPSHOT_CHARS = 30_000;
const MAX_INTERACTIVE = 160;
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const MAX_TYPE_CHARS = 20_000;
const MAX_BATCH_STEPS = 8;

type BrowserChannel = 'auto' | 'chromium' | 'chrome' | 'msedge';
type BrowserRefHandle = NonNullable<Awaited<ReturnType<Locator['elementHandle']>>>;
type BrowserRefMeta = {
  ref: string;
  tag: string;
  role: string | null;
  name: string;
  text: string;
  placeholder: string | null;
  inputType: string | null;
  disabled: boolean;
  href: string | null;
};
type BrowserRef = BrowserRefMeta & { handle: BrowserRefHandle };

interface BrowserSession {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  channel: BrowserChannel;
  headless: boolean;
  generation: number;
  refs: Map<string, BrowserRef>;
  idleTimer?: NodeJS.Timeout;
}

function stringArg(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new ToolError('INVALID_ARGUMENT', `"${name}" is required and must be a non-empty string.`);
    return undefined;
  }
  if (typeof value !== 'string' || (required && value.length === 0)) throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a string.`);
  return value;
}

function booleanArg(value: unknown, name: string, fallback?: boolean): boolean | undefined {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a boolean.`);
  return value;
}

function integerArg(value: unknown, name: string, minimum: number, maximum: number, fallback?: number): number | undefined {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function requiredIntegerArg(value: unknown, name: string, minimum: number, maximum: number): number {
  const resolved = integerArg(value, name, minimum, maximum);
  if (resolved === undefined) throw new ToolError('INVALID_ARGUMENT', `"${name}" is required.`);
  return resolved;
}

function enumArg<T extends string>(value: unknown, name: string, allowed: readonly T[], fallback?: T): T {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'string' || !allowed.includes(resolved as T)) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must be one of: ${allowed.join(', ')}.`);
  }
  return resolved as T;
}

function sessionIdArg(value: unknown): string {
  const id = stringArg(value, 'session_id') ?? 'default';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new ToolError('INVALID_ARGUMENT', '"session_id" must match ^[A-Za-z0-9._-]{1,64}$.');
  return id;
}

function safeUrl(raw: string): string {
  try {
    const value = new URL(raw);
    value.username = '';
    value.password = '';
    for (const key of [...new Set(value.searchParams.keys())]) {
      if (/(?:token|secret|password|passwd|auth|session|code|key|credential)/i.test(key)) value.searchParams.set(key, '[REDACTED]');
    }
    return value.href;
  } catch {
    return raw.slice(0, 2_000);
  }
}

function validateUrl(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new ToolError('INVALID_ARGUMENT', '"url" must be an absolute http(s) URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new ToolError('INVALID_ARGUMENT', 'Browser navigation permits only http:// and https:// URLs.');
  return parsed.href;
}

function bounded(value: string, max = MAX_SNAPSHOT_CHARS): { text: string; truncated: boolean } {
  return value.length > max ? { text: `${value.slice(0, max)}…`, truncated: true } : { text: value, truncated: false };
}

type BrowserFindMatchMode = 'exact' | 'contains' | 'fuzzy';

function normalizedWords(value: string): string[] {
  return value.toLowerCase().trim().split(/\s+/).filter(Boolean);
}

export function browserFindMatches(values: string[], query: string, mode: BrowserFindMatchMode): boolean {
  const normalizedQuery = query.toLowerCase().trim();
  if (mode === 'exact') return values.some((value) => value.toLowerCase().trim() === normalizedQuery);
  if (mode === 'contains') return values.some((value) => value.toLowerCase().includes(normalizedQuery));
  const queryWords = normalizedWords(query);
  if (queryWords.length === 0) return false;
  return values.some((value) => {
    const valueWords = new Set(normalizedWords(value));
    const overlap = queryWords.filter((word) => valueWords.has(word)).length;
    return overlap > 0 && overlap / queryWords.length >= 0.5;
  });
}

function publicRef(ref: BrowserRef): BrowserRefMeta {
  const { handle: _handle, ...meta } = ref;
  return meta;
}

export class BrowserUseManager {
  readonly #sessions = new Map<string, BrowserSession>();

  private scheduleIdleClose(session: BrowserSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (this.#sessions.get(session.id) !== session) return;
      this.#sessions.delete(session.id);
      void this.disposeRefs(session).finally(() => session.browser.close().catch(() => undefined));
    }, SESSION_IDLE_MS);
    session.idleTimer.unref?.();
  }

  private touch(session: BrowserSession): void {
    this.scheduleIdleClose(session);
  }

  private async disposeRefs(session: BrowserSession): Promise<void> {
    const refs = [...session.refs.values()];
    session.refs.clear();
    await Promise.allSettled(refs.map((entry) => entry.handle.dispose()));
  }

  private async launch(channel: BrowserChannel, headless: boolean): Promise<Browser> {
    const attempts: Array<{ label: string; run: () => Promise<Browser> }> = channel === 'auto'
      ? [
          { label: 'chrome', run: () => chromium.launch({ headless, channel: 'chrome' }) },
          { label: 'msedge', run: () => chromium.launch({ headless, channel: 'msedge' }) },
          { label: 'chromium', run: () => chromium.launch({ headless }) },
        ]
      : channel === 'chromium'
        ? [{ label: 'chromium', run: () => chromium.launch({ headless }) }]
        : [{ label: channel, run: () => chromium.launch({ headless, channel }) }];

    const failures: string[] = [];
    for (const attempt of attempts) {
      try { return await attempt.run(); } catch (error) { failures.push(`${attempt.label}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    throw new ToolError(
      'DEPENDENCY_MISSING',
      `No usable Playwright browser could be launched (${failures.join(' | ').slice(0, 2_000)}).`,
      'Install Chrome/Edge or run "pnpm --filter @chatgpt-pilot/server exec playwright install chromium".',
    );
  }

  private async start(id: string, channel: BrowserChannel, headless: boolean, timeoutMs: number): Promise<BrowserSession> {
    const existing = this.#sessions.get(id);
    if (existing) await this.close(id);
    if (this.#sessions.size >= MAX_SESSIONS) throw new ToolError('TOO_LARGE', `Browser automation supports at most ${MAX_SESSIONS} concurrent sessions.`, 'Close an unused session first.');
    const browser = await this.launch(channel, headless);
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
    const session: BrowserSession = { id, browser, context, page, channel, headless, generation: 0, refs: new Map() };
    this.#sessions.set(id, session);
    this.touch(session);
    return session;
  }

  private getSession(id: string): BrowserSession {
    const session = this.#sessions.get(id);
    if (!session) throw new ToolError('NOT_FOUND', `Browser session "${id}" does not exist.`, 'Call browser_session with action=start or navigate first.');
    const pages = session.context.pages().filter((page) => !page.isClosed());
    if (pages.length === 0) throw new ToolError('NOT_FOUND', `Browser session "${id}" has no open pages.`, 'Close the session and start it again.');
    if (session.page.isClosed()) session.page = pages.at(-1)!;
    this.touch(session);
    return session;
  }

  private configureTimeout(session: BrowserSession, timeoutMs: number): void {
    session.page.setDefaultTimeout(timeoutMs);
    session.page.setDefaultNavigationTimeout(timeoutMs);
  }

  private async state(session: BrowserSession): Promise<Record<string, unknown>> {
    const pages = session.context.pages().filter((page) => !page.isClosed());
    if (!pages.includes(session.page)) session.page = pages.at(-1) ?? session.page;
    const tabs = await Promise.all(pages.map(async (page, index) => ({
      index,
      active: page === session.page,
      url: safeUrl(page.url()),
      title: await page.title().catch(() => ''),
    })));
    return {
      sessionId: session.id,
      url: safeUrl(session.page.url()),
      title: await session.page.title().catch(() => ''),
      activeTab: Math.max(0, pages.indexOf(session.page)),
      tabs,
      refGeneration: session.generation,
      downloads: 'disabled',
    };
  }

  private async refreshRefs(session: BrowserSession, timeoutMs: number): Promise<BrowserRefMeta[]> {
    await this.disposeRefs(session);
    session.generation += 1;
    const handles = await session.page.locator('a,button,input,textarea,select,[role],[contenteditable="true"],[tabindex]').elementHandles();
    const selected = handles.slice(0, MAX_INTERACTIVE);
    for (const handle of handles.slice(MAX_INTERACTIVE)) await handle.dispose().catch(() => undefined);
    const evaluated = await Promise.all(selected.map(async (handle, index) => {
      try {
        const meta = await handle.evaluate((node) => {
          const el = node as unknown as {
            tagName?: string;
            innerText?: string;
            textContent?: string | null;
            placeholder?: string;
            type?: string;
            disabled?: boolean;
            href?: string;
            title?: string;
            getAttribute(name: string): string | null;
            closest?(selector: string): { textContent?: string | null } | null;
          };
          const tag = (el.tagName ?? '').toLowerCase();
          const inputType = el.type?.toLowerCase() ?? null;
          let role = el.getAttribute('role');
          if (!role) {
            if (tag === 'button') role = 'button';
            else if (tag === 'a' && el.href) role = 'link';
            else if (tag === 'textarea') role = 'textbox';
            else if (tag === 'select') role = 'combobox';
            else if (tag === 'input' && ['button', 'submit', 'reset'].includes(inputType ?? '')) role = 'button';
            else if (tag === 'input' && inputType === 'checkbox') role = 'checkbox';
            else if (tag === 'input' && inputType === 'radio') role = 'radio';
            else if (tag === 'input') role = 'textbox';
          }
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
          const ariaLabel = el.getAttribute('aria-label')?.trim() ?? '';
          const documentLike = (globalThis as unknown as { document: { getElementById(id: string): { textContent?: string | null } | null; querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null; textContent?: string | null }> } }).document;
          const labelledBy = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
            .map((id) => documentLike.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean).join(' ');
          const id = el.getAttribute('id');
          const forLabel = id ? Array.from(documentLike.querySelectorAll('label')).find((label) => label.getAttribute('for') === id)?.textContent?.trim() ?? '' : '';
          const wrappingLabel = el.closest?.('label')?.textContent?.trim() ?? '';
          const alt = el.getAttribute('alt')?.trim() ?? '';
          const placeholder = el.placeholder?.trim() || null;
          const name = (ariaLabel || labelledBy || forLabel || wrappingLabel || alt || text || placeholder || el.title || '').replace(/\s+/g, ' ').slice(0, 300);
          return { tag, role, name, text, placeholder, inputType, disabled: Boolean(el.disabled), href: el.href || null };
        });
        const ref = `e${session.generation}.${index + 1}`;
        const entry: BrowserRef = { ref, ...meta, href: meta.href ? safeUrl(meta.href) : null, handle };
        session.refs.set(ref, entry);
        return publicRef(entry);
      } catch {
        await handle.dispose().catch(() => undefined);
        return undefined;
      }
    }));
    return evaluated.filter((entry): entry is BrowserRefMeta => entry !== undefined);
  }

  private async ensureRefs(session: BrowserSession, timeoutMs: number): Promise<BrowserRefMeta[]> {
    if (session.refs.size === 0) return this.refreshRefs(session, timeoutMs);
    return [...session.refs.values()].map(publicRef);
  }

  private ref(session: BrowserSession, raw: unknown): BrowserRef {
    const ref = stringArg(raw, 'ref', true)!;
    const entry = session.refs.get(ref);
    if (!entry) throw new ToolError('NOT_FOUND', `Browser element ref "${ref}" is stale or unknown.`, 'Call browser_snapshot or browser_find again to get current refs.');
    return entry;
  }

  private async close(id: string): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (!session) return false;
    this.#sessions.delete(id);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    await this.disposeRefs(session);
    await session.browser.close().catch(() => undefined);
    return true;
  }

  async sessionCommand(args: Record<string, unknown>, maxTimeoutMs: number): Promise<unknown> {
    const action = enumArg(args.action, 'action', ['start', 'navigate', 'tabs', 'select_tab', 'close'] as const);
    const id = sessionIdArg(args.session_id);
    const timeoutMs = integerArg(args.timeout_ms, 'timeout_ms', 100, maxTimeoutMs, Math.min(30_000, maxTimeoutMs))!;

    if (action === 'close') {
      const closed = await this.close(id);
      return { action, sessionId: id, closed, alreadyClosed: !closed };
    }

    const channel = enumArg(args.channel, 'channel', ['auto', 'chromium', 'chrome', 'msedge'] as const, 'auto');
    const headless = booleanArg(args.headless, 'headless', true)!;

    if (action === 'start') {
      const requestedUrl = stringArg(args.url, 'url');
      const url = requestedUrl === undefined ? undefined : validateUrl(requestedUrl);
      const session = await this.start(id, channel, headless, timeoutMs);
      if (url) await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      return { action, channel: session.channel, headless: session.headless, state: await this.state(session) };
    }

    let session: BrowserSession;
    if (action === 'navigate') {
      const url = validateUrl(stringArg(args.url, 'url', true)!);
      session = this.#sessions.has(id) ? this.getSession(id) : await this.start(id, channel, headless, timeoutMs);
      this.configureTimeout(session, timeoutMs);
      await this.disposeRefs(session);
      const waitUntil = enumArg(args.wait_until, 'wait_until', ['commit', 'domcontentloaded', 'load', 'networkidle'] as const, 'domcontentloaded');
      const response = await session.page.goto(url, { waitUntil, timeout: timeoutMs });
      session.generation += 1;
      return { action, status: response?.status() ?? null, state: await this.state(session) };
    }

    session = this.getSession(id);
    if (action === 'select_tab') {
      const pages = session.context.pages().filter((page) => !page.isClosed());
      const index = requiredIntegerArg(args.index, 'index', 0, Math.max(0, pages.length - 1));
      const page = pages[index];
      if (!page) throw new ToolError('NOT_FOUND', `Browser tab ${index} does not exist.`);
      if (page !== session.page) {
        await this.disposeRefs(session);
        session.generation += 1;
        session.page = page;
      }
    }
    return { action, state: await this.state(session) };
  }

  async snapshot(args: Record<string, unknown>, maxTimeoutMs: number): Promise<unknown> {
    const id = sessionIdArg(args.session_id);
    const timeoutMs = integerArg(args.timeout_ms, 'timeout_ms', 100, maxTimeoutMs, Math.min(30_000, maxTimeoutMs))!;
    const session = this.getSession(id);
    this.configureTimeout(session, timeoutMs);
    const ariaRaw = await session.page.locator('body').ariaSnapshot({ timeout: timeoutMs }).catch(() => '');
    const aria = bounded(ariaRaw);
    const refs = await this.refreshRefs(session, timeoutMs);
    return {
      state: await this.state(session),
      aria: aria.text,
      ariaTruncated: aria.truncated,
      refs,
      refsTruncated: refs.length >= MAX_INTERACTIVE,
    };
  }

  async find(args: Record<string, unknown>, maxTimeoutMs: number): Promise<unknown> {
    const id = sessionIdArg(args.session_id);
    const timeoutMs = integerArg(args.timeout_ms, 'timeout_ms', 100, maxTimeoutMs, Math.min(30_000, maxTimeoutMs))!;
    const rawQuery = stringArg(args.query, 'query', true)!;
    const query = rawQuery.toLowerCase();
    const role = stringArg(args.role, 'role')?.toLowerCase();
    const mode = enumArg(args.match_mode, 'match_mode', ['exact', 'contains', 'fuzzy'] as const, 'contains');
    const limit = integerArg(args.limit, 'limit', 1, 50, 20)!;
    const session = this.getSession(id);
    const refs = await this.ensureRefs(session, timeoutMs);
    const matches = refs.filter((entry) => {
      if (role && entry.role?.toLowerCase() !== role) return false;
      const fields = [entry.name, entry.text, entry.placeholder, entry.role, entry.tag].filter((value): value is string => Boolean(value));
      return browserFindMatches(fields, query, mode);
    }).slice(0, limit);
    return { state: await this.state(session), query: rawQuery, role: role ?? null, matchMode: mode, matches, truncated: matches.length >= limit };
  }

  async screenshot(args: Record<string, unknown>, maxTimeoutMs: number): Promise<unknown> {
    const id = sessionIdArg(args.session_id);
    const timeoutMs = integerArg(args.timeout_ms, 'timeout_ms', 100, maxTimeoutMs, Math.min(30_000, maxTimeoutMs))!;
    const session = this.getSession(id);
    this.configureTimeout(session, timeoutMs);
    const ref = stringArg(args.ref, 'ref');
    const fullPage = booleanArg(args.full_page, 'full_page', false)!;
    const buffer = ref
      ? await this.ref(session, ref).handle.screenshot({ type: 'png', animations: 'disabled', timeout: timeoutMs })
      : await session.page.screenshot({ type: 'png', fullPage, animations: 'disabled', timeout: timeoutMs });
    if (buffer.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new ToolError('TOO_LARGE', `Browser screenshot exceeded ${MAX_SCREENSHOT_BYTES} bytes.`, 'Retry with full_page=false or pass an element ref for a smaller capture.');
    }
    return mcpImageResult(buffer, 'image/png', {
      state: await this.state(session),
      ref: ref ?? null,
      fullPage: ref ? false : fullPage,
      viewport: session.page.viewportSize(),
      bytes: buffer.byteLength,
    });
  }

  private async actionStep(session: BrowserSession, step: Record<string, unknown>, timeoutMs: number, batch = false): Promise<Record<string, unknown>> {
    const action = enumArg(step.action, 'action', ['click', 'type', 'press', 'wait'] as const);
    if (action === 'wait') {
      const maxWait = batch ? 5_000 : 30_000;
      const durationMs = requiredIntegerArg(step.duration_ms, 'duration_ms', 0, maxWait);
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      return { action, waitedMs: durationMs };
    }

    const entry = this.ref(session, step.ref);
    if (action === 'click') {
      const button = enumArg(step.button, 'button', ['left', 'right', 'middle'] as const, 'left');
      const clickCount = integerArg(step.click_count, 'click_count', 1, 3, 1)!;
      const beforePages = session.context.pages().length;
      const beforeUrl = session.page.url();
      try {
        await entry.handle.click({ button, clickCount, timeout: timeoutMs });
      } catch (error) {
        if (error instanceof Error && /not attached|detached from DOM|stale/i.test(error.message)) {
          throw new ToolError('NOT_FOUND', `Browser element ref "${entry.ref}" is stale or detached.`, 'Call browser_snapshot or browser_find again to get current refs.');
        }
        throw error;
      }
      const pages = session.context.pages().filter((page) => !page.isClosed());
      if (pages.length > beforePages) session.page = pages.at(-1)!;
      if (session.page.url() !== beforeUrl) await this.disposeRefs(session);
      return { action, ref: entry.ref, button, clickCount };
    }
    if (action === 'type') {
      const text = stringArg(step.text, 'text', true)!;
      if (text.length > MAX_TYPE_CHARS) throw new ToolError('TOO_LARGE', `"text" exceeds the ${MAX_TYPE_CHARS} character browser typing limit.`);
      const clear = booleanArg(step.clear, 'clear', true)!;
      if (clear) await entry.handle.fill(text, { timeout: timeoutMs });
      else await entry.handle.type(text, { delay: integerArg(step.delay_ms, 'delay_ms', 0, 2_000, 0)! });
      return { action, ref: entry.ref, typedCharacters: text.length, clear };
    }
    const key = stringArg(step.key, 'key', true)!;
    await entry.handle.press(key, { timeout: timeoutMs });
    return { action, ref: entry.ref, key };
  }

  async act(args: Record<string, unknown>, maxTimeoutMs: number): Promise<unknown> {
    const id = sessionIdArg(args.session_id);
    const timeoutMs = integerArg(args.timeout_ms, 'timeout_ms', 100, maxTimeoutMs, Math.min(30_000, maxTimeoutMs))!;
    const action = enumArg(args.action, 'action', ['click', 'type', 'press', 'wait', 'batch'] as const);
    let steps: Record<string, unknown>[] | undefined;
    if (action === 'batch') {
      if (!Array.isArray(args.steps) || args.steps.length === 0 || args.steps.length > MAX_BATCH_STEPS || args.steps.some((step) => !step || typeof step !== 'object' || Array.isArray(step))) {
        throw new ToolError('INVALID_ARGUMENT', `"steps" must be an array of 1-${MAX_BATCH_STEPS} browser action objects.`);
      }
      steps = args.steps as Record<string, unknown>[];
      const typed = steps.reduce((sum, step) => sum + (typeof step.text === 'string' ? step.text.length : 0), 0);
      if (typed > MAX_TYPE_CHARS) throw new ToolError('TOO_LARGE', `Batch browser typing exceeds ${MAX_TYPE_CHARS} total characters.`);
    } else if (action === 'wait') {
      requiredIntegerArg(args.duration_ms, 'duration_ms', 0, 30_000);
    } else {
      stringArg(args.ref, 'ref', true);
    }
    const session = this.getSession(id);
    this.configureTimeout(session, timeoutMs);
    if (action !== 'batch') {
      const step = await this.actionStep(session, args, timeoutMs);
      this.touch(session);
      return { ...step, state: await this.state(session) };
    }
    const results: Record<string, unknown>[] = [];
    for (const step of steps!) results.push(await this.actionStep(session, step, timeoutMs, true));
    this.touch(session);
    return { action, results, state: await this.state(session) };
  }
}

const SESSION_COMMON = {
  session_id: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$', description: 'Stateful browser session id; defaults to default.' },
  timeout_ms: { type: 'integer', minimum: 100 },
} as const;

function timeoutSchema(maxTimeoutMs: number) {
  return { type: 'integer', minimum: 100, maximum: maxTimeoutMs } as const;
}

export function createBrowserUseSpecs(maxTimeoutMs: number, manager = new BrowserUseManager()): ToolSpec[] {
  return [
    {
      name: 'browser_session',
      description: 'Manage a stateful Playwright browser session: start, navigate, inspect/select tabs, or close. URLs are limited to absolute http(s); cookies and storage are never returned.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'navigate', 'tabs', 'select_tab', 'close'] },
          session_id: SESSION_COMMON.session_id,
          url: { type: 'string', description: 'Absolute http(s) URL for start/navigate.' },
          channel: { type: 'string', enum: ['auto', 'chromium', 'chrome', 'msedge'] },
          headless: { type: 'boolean', description: 'Defaults to true.' },
          timeout_ms: timeoutSchema(maxTimeoutMs),
          wait_until: { type: 'string', enum: ['commit', 'domcontentloaded', 'load', 'networkidle'] },
          index: { type: 'integer', minimum: 0, description: 'Tab index for select_tab.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      handler: (args) => manager.sessionCommand(args, maxTimeoutMs),
    },
    {
      name: 'browser_snapshot',
      description: 'Read the active page as a bounded accessibility snapshot plus generation-scoped element refs. Use returned refs for browser_act instead of inventing selectors.',
      inputSchema: { type: 'object', properties: { session_id: SESSION_COMMON.session_id, timeout_ms: timeoutSchema(maxTimeoutMs) }, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: (args) => manager.snapshot(args, maxTimeoutMs),
    },
    {
      name: 'browser_find',
      description: 'Find current browser element refs by accessible name/text/role without returning the full page snapshot. Refreshes refs when needed.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: SESSION_COMMON.session_id,
          timeout_ms: timeoutSchema(maxTimeoutMs),
          query: { type: 'string', minLength: 1 },
          role: { type: 'string', description: 'Optional exact accessible role filter.' },
          match_mode: { type: 'string', enum: ['exact', 'contains', 'fuzzy'], default: 'contains', description: 'Matching strategy. exact checks whole fields; contains checks substrings; fuzzy uses shared words.' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: (args) => manager.find(args, maxTimeoutMs),
    },
    {
      name: 'browser_screenshot',
      description: 'Capture the active browser viewport/full page or one referenced element as a bounded MCP image. Prefer browser_snapshot for interaction decisions.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: SESSION_COMMON.session_id,
          timeout_ms: timeoutSchema(maxTimeoutMs),
          ref: { type: 'string', description: 'Optional element ref from browser_snapshot/browser_find.' },
          full_page: { type: 'boolean', description: 'Ignored when ref is provided.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: (args) => manager.screenshot(args, maxTimeoutMs),
    },
    {
      name: 'browser_act',
      description: 'Mutate the active browser page through current element refs: click, type, press, wait, or run a bounded batch. Re-snapshot after material DOM/navigation changes to refresh refs.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: SESSION_COMMON.session_id,
          timeout_ms: timeoutSchema(maxTimeoutMs),
          action: { type: 'string', enum: ['click', 'type', 'press', 'wait', 'batch'] },
          ref: { type: 'string' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          click_count: { type: 'integer', minimum: 1, maximum: 3 },
          text: { type: 'string', maxLength: MAX_TYPE_CHARS },
          clear: { type: 'boolean' },
          delay_ms: { type: 'integer', minimum: 0, maximum: 2000 },
          key: { type: 'string' },
          duration_ms: { type: 'integer', minimum: 0, maximum: 30000 },
          steps: {
            type: 'array', minItems: 1, maxItems: MAX_BATCH_STEPS,
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['click', 'type', 'press', 'wait'] },
                ref: { type: 'string' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, click_count: { type: 'integer', minimum: 1, maximum: 3 },
                text: { type: 'string', maxLength: MAX_TYPE_CHARS }, clear: { type: 'boolean' }, delay_ms: { type: 'integer', minimum: 0, maximum: 2000 }, key: { type: 'string' }, duration_ms: { type: 'integer', minimum: 0, maximum: 5000 },
              },
              required: ['action'],
              additionalProperties: false,
            },
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      handler: (args) => manager.act(args, maxTimeoutMs),
    },
  ];
}
