import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TodoLedger } from './todo-tools.js';

test('todo ledger persists across instances and serializes concurrent writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pilot-todos-'));
  try {
    const ledger = new TodoLedger(root);
    const created = await Promise.all(Array.from({ length: 20 }, (_, index) => ledger.add({ title: `Task ${index}`, priority: index === 0 ? 'high' : 'normal', tags: ['pilot'] })));
    assert.equal(new Set(created.map((item) => item.id)).size, 20);

    const reopened = new TodoLedger(root);
    const listed = await reopened.list({ tag: 'pilot', limit: 100 });
    assert.equal(listed.total, 20);

    const updated = await reopened.update(created[0]!.id, { status: 'done' });
    assert.equal(updated.status, 'done');
    assert.match(updated.completedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);

    const persisted = JSON.parse(await readFile(path.join(root, '.pilot', 'todos.json'), 'utf8')) as { version: number; todos: unknown[] };
    assert.equal(persisted.version, 1);
    assert.equal(persisted.todos.length, 20);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('todo ledger rejects empty updates and keeps completed items as history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pilot-todo-history-'));
  try {
    const ledger = new TodoLedger(root);
    const todo = await ledger.add({ title: 'Verify learning loop' });
    await assert.rejects(() => ledger.update(todo.id, {}), /requires at least one field/);
    await ledger.update(todo.id, { status: 'done' });
    assert.equal((await ledger.list({ status: 'done', limit: 10 })).total, 1);
    await ledger.update(todo.id, { status: 'open' });
    assert.equal((await ledger.get(todo.id))?.completedAt, undefined);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
