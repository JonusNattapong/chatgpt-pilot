# Bounded Learning Loop

ChatGPT Pilot learns from verified task outcomes without granting itself permission to rewrite persistent behavior silently.

## Lifecycle

```text
Todo / task intent
      ↓
ChatGPT plans → Pilot executes → verification evidence
      ↓
learning_observe
      ↓
Learning candidate
   ├─ memory      → evidence threshold → learning_promote → Memory lessons drawer
   ├─ skill       → proposal only
   ├─ capability  → proposal only
   └─ gpt         → proposal only
      ↓
learning_history / metrics
      ↓
learning_rollback when a promoted lesson or proposal is no longer valid
```

## Persistent state

Workspace-local runtime state lives under `.pilot/` and is intentionally ignored by Git:

- `.pilot/todos.json` — durable task ledger.
- `.pilot/learning.json` — observations, evidence, candidates, promotion state, and links to promoted memory items.
- `.pilot/memory/drawers/lessons/` — durable lessons promoted through the existing Memory provider.

JSON state is written through an atomic temp-file + rename store. Mutations are serialized within the runtime process. Corrupt JSON fails closed instead of being silently reset.

## Todo tools

- `todo_add` creates a durable todo with priority, tags, optional description, and optional due date.
- `todo_list` filters by status, tag, or text with bounded result limits.
- `todo_update` changes fields or status. `done` records `completedAt`; completed and cancelled work remains historical evidence rather than being silently deleted.

The ledger is capped at 5,000 items per workspace in v1.

## Learning tools

### `learning_observe`

Records a task outcome (`success`, `partial`, or `failure`), bounded evidence, skills used, and zero or more candidate lessons. A candidate contains:

- `lesson`
- `confidence` in `[0, 1]`
- `reuse_potential` in `[0, 1]`
- `target`: `memory`, `skill`, `capability`, or `gpt`

Observations may link to a todo via `todo_id`. Secret-like values are redacted again inside the persistence module, not only at the MCP boundary.

### `learning_history`

Returns bounded candidates plus aggregate metrics:

- outcomes by `success` / `partial` / `failure`
- candidates by status
- candidates by target
- promotion rate

These metrics are evidence for whether the loop is producing durable value or merely accumulating candidates.

### `learning_promote`

Promotion requires both:

- `confidence >= 0.6`
- `reuse_potential >= 0.5`

A `memory` candidate is written to the existing `lessons` memory drawer. The nested Memory capability is still evaluated through Pilot policy before execution.

`skill`, `capability`, and `gpt` candidates become **proposals only**. This tool never edits a Skill, source code, tool contract, `GPT.md`, commits, pushes, or restarts Pilot.

### `learning_rollback`

A promoted Memory lesson can be removed from the lessons drawer and marked rolled back. Proposal-only candidates can also be withdrawn. The operation is bounded to artifacts created by the learning candidate.

## Operating rules

1. Do not create a learning observation for routine work with no reusable signal.
2. Prefer verification output, tests, user feedback, repeated failure patterns, or measured outcomes as evidence.
3. Do not promote speculation just because it sounds plausible.
4. Persistent Skill / Capability / GPT changes always go through the normal inspect → implement → verify → approval / Git workflow.
5. A learning candidate never weakens runtime security, workspace boundaries, approval policy, or audit requirements.
6. Roll back a lesson when later evidence contradicts it.

## What v1 intentionally does not do

- no autonomous rewriting of Skills or `GPT.md`
- no autonomous code changes or commits
- no background model reflection loop
- no automatic promotion based only on repetition count
- no replacement for the existing Markdown Memory engine

The model remains the planner. Pilot remains the controlled execution and evidence layer.
