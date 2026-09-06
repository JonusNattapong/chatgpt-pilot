import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Checkpoint, CreateRunInput, FlowEvent, RunRecord, RunSnapshot, RunState, StepRecord, StepSpec, StepState } from "./types.js";

type Row = Record<string, unknown>;
const json = (value: unknown): string => JSON.stringify(value ?? null);
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
function stringValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid database row: '${key}' is not a string.`);
  return value;
}
function nullableString(row: Row, key: string): string | null { return typeof row[key] === "string" ? row[key] as string : null; }
function numberValue(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`Invalid database row: '${key}' is not a number.`);
  return value;
}

export class FlowStore {
  readonly #db: DatabaseSync;
  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA foreign_keys = ON;");
    if (path !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        state TEXT NOT NULL,
        concurrency INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS steps (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        capability TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        status TEXT NOT NULL,
        depends_on_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        PRIMARY KEY (run_id, id)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_id TEXT,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_run_created ON checkpoints(run_id, created_at);
    `);
  }
  #now(): string { return new Date().toISOString(); }
  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE;");
    try { const value = operation(); this.#db.exec("COMMIT;"); return value; }
    catch (error) { this.#db.exec("ROLLBACK;"); throw error; }
  }
  #appendEvent(runId: string, type: string, stepId: string | null, data: Record<string, unknown>): void {
    this.#db.prepare("INSERT INTO events (run_id, step_id, type, at, data_json) VALUES (?, ?, ?, ?, ?)")
      .run(runId, stepId, type, this.#now(), json(data));
  }

  createRun(input: CreateRunInput, steps: StepSpec[], concurrency: number): RunSnapshot {
    const id = input.id?.trim() || randomUUID();
    const goal = input.goal.trim();
    if (!goal) throw new Error("Flow goal cannot be empty.");
    const now = this.#now();
    this.#transaction(() => {
      this.#db.prepare("INSERT INTO runs (id, goal, state, concurrency, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, goal, "planned", concurrency, json(input.metadata ?? {}), now, now);
      const insert = this.#db.prepare(`INSERT INTO steps (
        run_id, id, capability, input_json, output_json, status, depends_on_json, attempts, max_attempts, error, started_at, completed_at
      ) VALUES (?, ?, ?, ?, NULL, 'pending', ?, 0, ?, NULL, NULL, NULL)`);
      for (const step of steps) insert.run(id, step.id, step.capability, json(step.input), json(step.dependsOn), step.maxAttempts);
      this.#appendEvent(id, "run.created", null, { stepCount: steps.length, concurrency });
    });
    return this.getSnapshot(id);
  }

  getSnapshot(runId: string): RunSnapshot {
    const runRow = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Row | undefined;
    if (!runRow) throw new Error(`Flow run not found: '${runId}'.`);
    const stepRows = this.#db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY rowid").all(runId) as Row[];
    return { run: this.#mapRun(runRow), steps: stepRows.map((row) => this.#mapStep(row)) };
  }
  #mapRun(row: Row): RunRecord {
    return {
      id: stringValue(row, "id"), goal: stringValue(row, "goal"), state: stringValue(row, "state") as RunState,
      concurrency: numberValue(row, "concurrency"), metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
      createdAt: stringValue(row, "created_at"), updatedAt: stringValue(row, "updated_at"),
    };
  }
  #mapStep(row: Row): StepRecord {
    return {
      runId: stringValue(row, "run_id"), id: stringValue(row, "id"), capability: stringValue(row, "capability"),
      input: parseJson<unknown>(row.input_json, {}), output: parseJson<unknown>(row.output_json, null),
      status: stringValue(row, "status") as StepState, dependsOn: parseJson<string[]>(row.depends_on_json, []),
      attempts: numberValue(row, "attempts"), maxAttempts: numberValue(row, "max_attempts"), error: nullableString(row, "error"),
      startedAt: nullableString(row, "started_at"), completedAt: nullableString(row, "completed_at"),
    };
  }

  setRunState(runId: string, state: RunState, eventType: string, data: Record<string, unknown> = {}): void {
    this.#transaction(() => {
      const changed = this.#db.prepare("UPDATE runs SET state = ?, updated_at = ? WHERE id = ?").run(state, this.#now(), runId).changes;
      if (changed !== 1) throw new Error(`Flow run not found: '${runId}'.`);
      this.#appendEvent(runId, eventType, null, data);
    });
  }
  beginStep(runId: string, stepId: string): StepRecord {
    this.#transaction(() => {
      const row = this.#db.prepare("SELECT status FROM steps WHERE run_id = ? AND id = ?").get(runId, stepId) as Row | undefined;
      if (!row) throw new Error(`Step not found: '${stepId}'.`);
      if (row.status !== "pending") throw new Error(`Step '${stepId}' is not pending.`);
      this.#db.prepare(`UPDATE steps SET status='running', attempts=attempts+1, started_at=?, completed_at=NULL, error=NULL WHERE run_id=? AND id=?`)
        .run(this.#now(), runId, stepId);
      this.#appendEvent(runId, "step.started", stepId, {});
    });
    return this.getSnapshot(runId).steps.find((step) => step.id === stepId)!;
  }
  completeStep(runId: string, stepId: string, output: unknown): void {
    this.#transaction(() => {
      const changed = this.#db.prepare(`UPDATE steps SET status='succeeded', output_json=?, error=NULL, completed_at=? WHERE run_id=? AND id=? AND status='running'`)
        .run(json(output), this.#now(), runId, stepId).changes;
      if (changed !== 1) throw new Error(`Step '${stepId}' is not running.`);
      this.#appendEvent(runId, "step.succeeded", stepId, {});
    });
    this.createCheckpoint(runId, `step:${stepId}:succeeded`);
  }
  failStep(runId: string, stepId: string, message: string): StepRecord {
    this.#transaction(() => {
      const changed = this.#db.prepare(`UPDATE steps SET status='failed', error=?, completed_at=? WHERE run_id=? AND id=? AND status='running'`)
        .run(message, this.#now(), runId, stepId).changes;
      if (changed !== 1) throw new Error(`Step '${stepId}' is not running.`);
      this.#appendEvent(runId, "step.failed", stepId, { error: message });
    });
    return this.getSnapshot(runId).steps.find((step) => step.id === stepId)!;
  }
  scheduleRetry(runId: string, stepId: string): void {
    this.#transaction(() => {
      const changed = this.#db.prepare("UPDATE steps SET status='pending', error=NULL WHERE run_id=? AND id=? AND status='failed'").run(runId, stepId).changes;
      if (changed !== 1) throw new Error(`Step '${stepId}' is not failed.`);
      this.#appendEvent(runId, "step.retry_scheduled", stepId, {});
    });
  }
  markRunningAsUncertain(runId: string): string[] {
    const running = this.getSnapshot(runId).steps.filter((step) => step.status === "running");
    if (running.length === 0) return [];
    this.#transaction(() => {
      for (const step of running) {
        this.#db.prepare("UPDATE steps SET status='uncertain', error=? WHERE run_id=? AND id=? AND status='running'")
          .run("Execution outcome is unknown after an interruption boundary.", runId, step.id);
        this.#appendEvent(runId, "step.uncertain", step.id, { reason: "interrupted_after_start_before_durable_result" });
      }
    });
    return running.map((step) => step.id);
  }
  prepareResume(runId: string, retryUncertain: boolean): void {
    this.#transaction(() => {
      const reset = (status: "failed" | "uncertain", event: string): void => {
        const rows = this.#db.prepare("SELECT id FROM steps WHERE run_id=? AND status=?").all(runId, status) as Row[];
        for (const row of rows) {
          const stepId = stringValue(row, "id");
          this.#db.prepare("UPDATE steps SET status='pending', attempts=0, error=NULL, started_at=NULL, completed_at=NULL WHERE run_id=? AND id=?").run(runId, stepId);
          this.#appendEvent(runId, event, stepId, { previousStatus: status });
        }
      };
      reset("failed", "step.reset_for_resume");
      if (retryUncertain) reset("uncertain", "step.uncertain_retry_authorized");
    });
  }
  cancel(runId: string): RunSnapshot {
    const snapshot = this.getSnapshot(runId);
    if (snapshot.run.state === "completed" || snapshot.run.state === "cancelled") return snapshot;
    this.setRunState(runId, "cancelled", "run.cancelled");
    return this.getSnapshot(runId);
  }
  createCheckpoint(runId: string, reason: string): Checkpoint {
    const snapshot = this.getSnapshot(runId);
    const checkpoint = { id: randomUUID(), runId, reason, createdAt: this.#now(), snapshot } satisfies Checkpoint;
    this.#db.prepare("INSERT INTO checkpoints (id, run_id, reason, created_at, snapshot_json) VALUES (?, ?, ?, ?, ?)")
      .run(checkpoint.id, runId, reason, checkpoint.createdAt, json(snapshot));
    return checkpoint;
  }
  listEvents(runId: string, limit = 100): FlowEvent[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.#db.prepare("SELECT * FROM events WHERE run_id=? ORDER BY seq DESC LIMIT ?").all(runId, bounded) as Row[];
    return rows.reverse().map((row) => ({ seq: numberValue(row,"seq"), runId:stringValue(row,"run_id"), stepId:nullableString(row,"step_id"), type:stringValue(row,"type"), at:stringValue(row,"at"), data:parseJson<Record<string,unknown>>(row.data_json,{}) }));
  }
  listCheckpoints(runId: string, limit = 20): Checkpoint[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.#db.prepare("SELECT * FROM checkpoints WHERE run_id=? ORDER BY created_at DESC LIMIT ?").all(runId, bounded) as Row[];
    return rows.map((row) => ({ id:stringValue(row,"id"), runId:stringValue(row,"run_id"), reason:stringValue(row,"reason"), createdAt:stringValue(row,"created_at"), snapshot:parseJson<RunSnapshot>(row.snapshot_json,this.getSnapshot(runId)) }));
  }
  close(): void { this.#db.close(); }
}
