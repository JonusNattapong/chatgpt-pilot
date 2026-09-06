import assert from "node:assert/strict";
import test from "node:test";
import { FlowEngine, FlowStore, validateDag } from "../dist/index.js";

class Executor {
  calls = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(handler = async (capability, input) => ({ capability, input })) { this.handler = handler; }
  async execute(capability, input, context) {
    this.calls.push({ capability, input, context });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try { return await this.handler(capability, input, context); }
    finally { this.inFlight--; }
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("independent ready steps execute concurrently", async () => {
  const store = new FlowStore(":memory:");
  try {
    const executor = new Executor(async (capability) => { await sleep(35); return capability; });
    const engine = new FlowEngine(store, executor);
    const run = engine.create({ goal: "parallel edits", concurrency: 4, steps: [
      { id: "edit-a", capability: "edit_file", input: { path: "a.ts" } },
      { id: "edit-b", capability: "edit_file", input: { path: "b.ts" } },
      { id: "verify", capability: "verify_changes", dependsOn: ["edit-a", "edit-b"] },
    ] });
    const done = await engine.run(run.run.id);
    assert.equal(done.run.state, "completed");
    assert.equal(executor.maxInFlight, 2);
    assert.deepEqual(executor.calls.slice(0, 2).map((call) => call.capability).sort(), ["edit_file", "edit_file"]);
    assert.equal(executor.calls.at(-1).capability, "verify_changes");
  } finally { store.close(); }
});

test("concurrency limit is enforced", async () => {
  const store = new FlowStore(":memory:");
  try {
    const executor = new Executor(async () => { await sleep(20); return true; });
    const engine = new FlowEngine(store, executor);
    const run = engine.create({ goal: "bounded", concurrency: 2, steps: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, capability: "read_file" })) });
    await engine.run(run.run.id);
    assert.equal(executor.maxInFlight, 2);
  } finally { store.close(); }
});

test("dependency cycles fail before persistence", () => {
  assert.throws(() => validateDag([
    { id: "a", capability: "x", input: {}, dependsOn: ["b"], maxAttempts: 1 },
    { id: "b", capability: "x", input: {}, dependsOn: ["a"], maxAttempts: 1 },
  ]), /cycle/);
});

test("resume preserves successes and fails closed on uncertain side effects", async () => {
  const store = new FlowStore(":memory:");
  try {
    const executor = new Executor();
    const engine = new FlowEngine(store, executor);
    const run = engine.create({ goal: "safe recovery", steps: [{ id: "mutate", capability: "write_file" }] });
    store.setRunState(run.run.id, "running", "run.started");
    store.beginStep(run.run.id, "mutate");
    const blocked = await engine.resume(run.run.id);
    assert.equal(blocked.run.state, "failed");
    assert.equal(blocked.steps[0].status, "uncertain");
    assert.equal(executor.calls.length, 0);
    const retried = await engine.resume(run.run.id, { retryUncertain: true });
    assert.equal(retried.run.state, "completed");
    assert.equal(executor.calls.length, 1);
  } finally { store.close(); }
});
