# AGENTS.md — Agent Operating Guidelines for `chatgpt-pilot`

This document provides strict instructions, operational boundaries, and architectural principles for AI agents (Antigravity, Codex, Loom, ChatGPT) working within the `chatgpt-pilot` monorepo.

---

## 1. System Topology & Monorepo Map

```text
chatgpt-pilot/
├── apps/
│   ├── server/           # MCP Gateway runtime, Process Manager, Git, IPython (toolpy)
│   └── playground/       # Testbed & integration fixtures
├── packages/
│   ├── memory/           # Pure Markdown Living Memory Book (@chatgpt-pilot/memory)
│   │   ├── seed/         # Bundled recovery snapshots (identity, projects, architecture)
│   │   └── src/          # BrainBook manager, Stdio MCP server, and CLI
│   ├── thinkforge/       # Cognitive scaffolds & problem reframing (@chatgpt-pilot/thinkforge)
│   ├── skill-hub/        # Curated skills registry & execution gateway (@chatgpt-pilot/skill-hub)
│   ├── mcp-server/       # Minimal MCP adapter (@chatgpt-pilot/mcp-server)
│   └── core/             # Shared contracts & types (@chatgpt-pilot/core)
├── skills/               # curated agent skills in markdown format (139 indexed in the current snapshot)
├── scripts/              # Platform tunnel and management scripts (.ps1, .sh)
└── .pilot/               # Runtime local directory (audit.ndjson, config.json, memory/)
```

---

## 2. Capability Architecture & The Four Pillars

When interacting with this codebase, remember the 4 capability providers federated by `apps/server`:

1. **System & Machine (`apps/server`)**: Low-level filesystem, background process orchestration, verified Git commits, and stateful Python (`toolpy`).
2. **ThinkForge (`packages/thinkforge`)**: Structured cognitive accelerators such as `think_analyze_problem`, `think_reframe_problem`, `think_challenge_idea`, `think_synthesize_ideas`, and `think_experiment_design`.
3. **Skill Hub (`packages/skill-hub`)**: Dynamic discovery, routing, composition, feedback, and on-demand reading across 139 currently indexed skills in `skills/`.
4. **Living Memory Book (`packages/memory`)**: Pure Markdown second brain indexed by Chapters, Subtopics, Timesteps, and Memory Drawers.

---

## 3. Authoritative Files & Precedence Order

When resolving architectural or implementation questions, treat these files as authoritative in the following order:

1. `apps/server/src/tools.ts` — The tool registry: schema, description, argument validation, and handler for machine tools.
2. `apps/server/src/contract.ts` — Versioned public tool contract and deterministic contract fingerprint.
3. `apps/server/src/supervisor.ts` — Tunnel-facing stdio worker boundary, hard deadlines, restart/circuit breaker logic.
4. `packages/memory/src/brain.ts` — Pure Markdown Memory Engine, TOC generator, timestep indexer.
5. `apps/server/src/index.ts` — Gateway entrypoint, capability provider federation, HTTP authentication, and result envelope.
6. `apps/server/src/verification.ts` — Pre-commit verification gates and worktree integrity checks.
7. Test suites (`*.test.ts`) — Executable behavioral contracts.
8. `README.md`, `README.th.md`, and `docs/architecture.md` — Human-facing specifications.

---

## 4. How to Query and Update Memory

The memory system is file-based Markdown under `.pilot/memory/` (with fallback seed under `packages/memory/seed/`).

- **To discover topics**: Call `memory_toc` or read `TOC.md`.
- **To view high-level summaries**: Call `memory_summary` or read `SUMMARY.md`.
- **To read a specific chapter or section**: Call `memory_read_topic` with `{ topic: "02-projects", subtopic: "..." }`.
- **To recall historical context**: Call `memory_recall_time` with `{ timestep: "YYYY-MM-DD" }` or `{ timestep: "latest" }`.
- **To search across all memories**: Call `memory_search` with `{ query: "..." }`.
- **To persist new milestones/learnings**: Call `memory_remember` with `{ title: "...", content: "...", tags: [...] }`.

---

## 5. Security Invariants & Guardrails

### 5.1 Filesystem & Mutation Safety
- `read_file` output must remain bounded and reject binary inputs.
- `read_files` caps both file count and combined byte output; a single missing file must not fail sibling reads.
- `find_files` skips dependency directories (`node_modules`, `.git`, `dist`, `.pilot`) unless explicitly requested, and must not follow symlinks.
- `write_file` must not overwrite an existing file without explicit `overwrite=true`.
- `edit_file` must reject ambiguous exact matches unless `replace_all` or `expected_replacements` is provided, and returns actionable near-miss diagnostics on failure.
- Precondition checking: `read_file`, `write_file`, and `edit_file` support `expected_sha256`; mismatches fail closed with `PRECONDITION_FAILED`.

### 5.2 Shell & Process Execution
- Shell execution defaults to a 30-second timeout (max 10 minutes) with a combined output cap of 4 MiB.
- Shell commands in workspace mode must never escape the workspace root.
- Background processes started via `start_process` return an explicit PID and use monotonic byte offsets for incremental reading (`read_process_output`).
- `stop_process` is idempotent and must wait for process termination.

### 5.3 Git & Verified Commits
- `git_status` and `git_diff` are read-only and invoke Git directly without shell interpolation.
- `git_commit_verified` runs verification checks (`npm test`, build gates) in a detached index candidate. If tests fail, or if files in the worktree change during verification, the commit is aborted and staging is left untouched.
- Worktree fingerprints must exclude runtime directories (`.pilot/`, `.chatgpt-machine/`, `.tunnel/`) to avoid false-positive verification failures.

### 5.4 Result Envelope & Errors
- Every tool result conforms to `{ "ok": true, ... }` or `{ "ok": false, "tool": "...", "error": { "code": "...", "message": "...", "hint": "..." } }`.
- Common credential formats (`.env`, private keys, DPAPI keys) are automatically redacted before crossing the transport boundary.
- Error codes in `apps/server/src/errors.ts` are a fixed public contract; add new codes rather than repurposing existing ones.

---

## 6. Engineering Invariants & Coding Standards

1. **Pure TypeScript / Zero Native C++ Dependencies in Memory**:
   - `packages/memory` must never introduce SQLite (`better-sqlite3`), `sqlite-vec`, or native C++ addons.
   - Memory must remain pure Markdown files manipulated through standard Node.js modules (`fs`, `path`).

2. **Zero-Config Discovery**:
   - Internal workspace packages must be auto-detected relative to the workspace root. Never introduce mandatory CLI path flags for built-in packages.

3. **Pre-commit Verification Gate**:
   - Ensure the current monorepo verification suite passes with 100% success before pushing changes:
     ```bash
     pnpm verify
     ```

4. **Line Endings**:
   - All shell scripts (`.sh`) must use LF line endings (`\n`) to prevent syntax failures on bash/Linux environments.

5. **Storage Isolation**:
   - Local runtime artifacts belong in `.pilot/` (workspace) or `~/.pilot/` (global user).
   - `.pilot/` is excluded from git tracking, while `packages/memory/seed/` holds repository-level backup templates.

---

## 7. Security Review Checklist

Before completing any task touching execution, filesystem, or transport code, verify:

1. Can workspace-only mode escape `--root`?
2. Can a symlink or junction redirect access outside the root?
3. Does untrusted user input reach a shell unescaped?
4. Can output grow unboundedly without pagination?
5. Can a background process outlive its timeout or leak handles?
6. Are secrets or private keys exposed in logs, error envelopes, or git commits?
7. Did the tool maintain accurate read-only / destructive MCP annotations?
