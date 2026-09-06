import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolError } from './errors.js';
import { AtomicJsonStore } from './persistent-state.js';
import type { ToolSpec } from './tools.js';

export type TodoStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
export type TodoPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface TodoItem {
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
  priority: TodoPriority;
  tags: string[];
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface TodoState { version: 1; todos: TodoItem[] }

function requireString(args: Record<string, unknown>, name: string, max = 4000): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new ToolError('INVALID_ARGUMENT', `"${name}" is required and must be a non-empty string.`);
  if (value.length > max) throw new ToolError('INVALID_ARGUMENT', `"${name}" must not exceed ${max} characters.`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, name: string, max = 8000): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a string.`);
  if (value.length > max) throw new ToolError('INVALID_ARGUMENT', `"${name}" must not exceed ${max} characters.`);
  return value.trim();
}

function stringArray(value: unknown, name: string, maxItems = 20): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maxItems || value.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 80)) {
    throw new ToolError('INVALID_ARGUMENT', `"${name}" must be an array of at most ${maxItems} non-empty strings up to 80 characters each.`);
  }
  return [...new Set(value.map((entry) => (entry as string).trim().toLowerCase()))];
}

function enumValue<T extends string>(value: unknown, name: string, allowed: readonly T[], fallback?: T): T | undefined {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new ToolError('INVALID_ARGUMENT', `"${name}" must be one of: ${allowed.join(', ')}.`);
  return value as T;
}

function isoDate(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new ToolError('INVALID_ARGUMENT', `"${name}" must be a valid ISO-8601 date/time string.`);
  return new Date(value).toISOString();
}

export class TodoLedger {
  readonly store: AtomicJsonStore<TodoState>;
  constructor(root: string) {
    this.store = new AtomicJsonStore(path.join(path.resolve(root), '.pilot', 'todos.json'), () => ({ version: 1, todos: [] }));
  }

  async add(input: { title: string; description?: string; priority?: TodoPriority; tags?: string[]; dueAt?: string }): Promise<TodoItem> {
    return this.store.update((state) => {
      if (state.todos.length >= 5000) throw new ToolError('TOO_LARGE', 'Todo ledger reached the 5000-item safety limit.', 'Complete/archive work before adding more todos.');
      const now = new Date().toISOString();
      const item: TodoItem = { id: randomUUID(), title: input.title, description: input.description || undefined, status: 'open', priority: input.priority ?? 'normal', tags: input.tags ?? [], dueAt: input.dueAt, createdAt: now, updatedAt: now };
      state.todos.push(item);
      return item;
    });
  }

  async get(id: string): Promise<TodoItem | undefined> {
    const state = await this.store.read();
    return state.todos.find((item) => item.id === id);
  }

  async list(input: { status?: TodoStatus; tag?: string; query?: string; limit?: number }): Promise<{ total: number; todos: TodoItem[] }> {
    const state = await this.store.read();
    const q = input.query?.toLowerCase();
    const tag = input.tag?.toLowerCase();
    const filtered = state.todos.filter((item) =>
      (!input.status || item.status === input.status)
      && (!tag || item.tags.includes(tag))
      && (!q || `${item.title}
${item.description ?? ''}
${item.tags.join(' ')}`.toLowerCase().includes(q))
    ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const limit = input.limit ?? 100;
    return { total: filtered.length, todos: filtered.slice(0, limit) };
  }

  async update(id: string, patch: Partial<Pick<TodoItem, 'title' | 'description' | 'status' | 'priority' | 'tags' | 'dueAt'>>): Promise<TodoItem> {
    return this.store.update((state) => {
      const item = state.todos.find((todo) => todo.id === id);
      if (!item) throw new ToolError('NOT_FOUND', `Todo not found: ${id}`);
      if (Object.keys(patch).length === 0) throw new ToolError('INVALID_ARGUMENT', 'todo_update requires at least one field to change.');
      const previousStatus = item.status;
      Object.assign(item, patch, { updatedAt: new Date().toISOString() });
      if (patch.status === 'done' && previousStatus !== 'done') item.completedAt = item.updatedAt;
      if (patch.status && patch.status !== 'done') delete item.completedAt;
      return { ...item };
    });
  }
}

export function createTodoToolSpecs(root: string, ledger = new TodoLedger(root)): ToolSpec[] {
  return [
    {
      name: 'todo_add',
      description: 'Create a persistent workspace todo in .pilot/todos.json. Todos survive Pilot restarts and can be linked to learning observations.',
      inputSchema: { type: 'object', properties: { title: { type: 'string', maxLength: 4000 }, description: { type: 'string', maxLength: 8000 }, priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 80 } }, due_at: { type: 'string', description: 'Optional ISO-8601 due date/time.' } }, required: ['title'] },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: async (args) => ({ todo: await ledger.add({ title: requireString(args, 'title', 4000), description: optionalString(args, 'description'), priority: enumValue(args.priority, 'priority', ['low', 'normal', 'high', 'urgent'] as const, 'normal'), tags: stringArray(args.tags, 'tags'), dueAt: isoDate(args.due_at, 'due_at') }) }),
    },
    {
      name: 'todo_list',
      description: 'List persistent workspace todos with bounded status, tag, and text filters.',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] }, tag: { type: 'string', maxLength: 80 }, query: { type: 'string', maxLength: 500 }, limit: { type: 'integer', minimum: 1, maximum: 500 } } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) => {
        const limit = args.limit === undefined ? 100 : args.limit;
        if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 500) throw new ToolError('INVALID_ARGUMENT', '"limit" must be an integer between 1 and 500.');
        return ledger.list({ status: enumValue(args.status, 'status', ['open', 'in_progress', 'done', 'cancelled'] as const), tag: optionalString(args, 'tag', 80), query: optionalString(args, 'query', 500), limit: limit as number });
      },
    },
    {
      name: 'todo_update',
      description: 'Update a persistent todo, including status transitions to in_progress, done, or cancelled. Completed todos are retained as history rather than silently deleted.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string', maxLength: 4000 }, description: { type: 'string', maxLength: 8000 }, status: { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] }, priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 80 } }, due_at: { type: 'string' } }, required: ['id'] },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      handler: async (args) => {
        const patch: Partial<Pick<TodoItem, 'title' | 'description' | 'status' | 'priority' | 'tags' | 'dueAt'>> = {};
        if (args.title !== undefined) patch.title = requireString(args, 'title', 4000);
        if (args.description !== undefined) patch.description = optionalString(args, 'description') || undefined;
        if (args.status !== undefined) patch.status = enumValue(args.status, 'status', ['open', 'in_progress', 'done', 'cancelled'] as const)!;
        if (args.priority !== undefined) patch.priority = enumValue(args.priority, 'priority', ['low', 'normal', 'high', 'urgent'] as const)!;
        if (args.tags !== undefined) patch.tags = stringArray(args.tags, 'tags')!;
        if (args.due_at !== undefined) patch.dueAt = isoDate(args.due_at, 'due_at');
        return { todo: await ledger.update(requireString(args, 'id', 128), patch) };
      },
    },
  ];
}
