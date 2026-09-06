# ChatGPT Pilot Architecture Specification

## 1. System Topology & Architecture Boundaries

ChatGPT Pilot functions as a unified gateway and capability fabric bridging AI client interfaces (ChatGPT Web via MCP tunnel, Codex, and local agents) with the developer's local operating system and tool ecosystem.

```text
               ┌────────────────────────────────────────────────────────────┐
               │                  ChatGPT / Codex Client                    │
               └─────────────────────────────┬──────────────────────────────┘
                                             │  MCP (JSON-RPC 2.0)
                                             ▼
               ┌────────────────────────────────────────────────────────────┐
               │           ChatGPT Pilot Server (`apps/server`)             │
               │  - Stdio & HTTP Streamable Transports                      │
               │  - Worker Supervisor Daemon & Heartbeat Circuit Breaker    │
               │  - Policy Governor & Precondition Verifiers                │
               │  - NDJSON Audit Stream (`.pilot/audit.ndjson`)             │
               └───────────┬──────────────┬──────────────┬─────────────┬────┘
                           │              │              │             │
               ┌───────────┴───┐   ┌──────┴──────┐ ┌─────┴─────┐ ┌─────┴──────────┐
               │  💻 Machine   │   │  🧠 Think   │ │ 📚 Skills │ │   💾 Memory    │
               │   Primitives  │   │  ThinkForge │ │ Skill Hub │ │  Living Book   │
               └───────────────┘   └─────────────┘ └───────────┘ └────────────────┘
```

---

## 2. The Four Pillar Subsystems

### 2.1 Coding & System Execution (`apps/server`)
- **Isolation & Sandboxing**: Restricts commands and mutations strictly inside `root` when in `workspace` mode. In `unrestricted` mode, operations require explicit authorization flags (`--dangerously-open-machine`).
- **Verified Commits**: `git_commit_verified` executes pre-commit verification gates (unit tests, build checks, and linter). If verification fails or unstaged files mutate during testing, staging is rolled back and the commit is aborted.
- **Persistent Python Execution (`toolpy`)**:
  - Provides stateful IPython kernels holding runtime variables across calls.
  - Exposes internal capabilities as local Python callable functions (`call_tool()`), reducing round-trip token overhead.

### 2.2 Cognitive Accelerators (`packages/thinkforge`)
- Provides divergent and convergent thinking structures.
- Tools include `think_analyze_problem`, `think_reframe_problem`, `think_generate_mechanisms`, `think_challenge_idea`, `think_synthesize_ideas`, `think_experiment_design`, and `think_unconventional_solve`.
- Enables models to test hypotheses, find blind spots, and optimize architectures before code generation.

### 2.3 Dynamic Skills Engine (`packages/skill-hub` + `skills/`)
- Discovers, validates, routes, and composes procedures from the currently indexed 139-skill repository.
- Skill metadata and procedures are exposed through `skills_skill_list`, `skills_skill_search`, `skills_skill_resolve`, `skills_skill_route`, `skills_skill_compose`, and `skills_skill_read`.

### 2.4 Living Memory Book Engine (`packages/memory`)
- **Pure Markdown Second Brain**: Replaces legacy SQL / SQLite engines with human-readable, zero-dependency Markdown documents.
- **Master Table of Contents (`TOC.md`)**: Automatically indexes chapters, subtopics, and chronological events.
- **Executive Summaries (`SUMMARY.md`)**: High-level system overview.
- **Chapters (`chapters/`)**:
  - `01-identity.md`: Developer identity, working style, and directives.
  - `02-projects.md`: System project catalogue, tags, commits, architectures.
  - `03-architecture.md`: Architectural DNA, loop patterns, and runtime conventions.
  - `04-timeline.md`: Master project chronological milestones.
- **Timesteps (`timesteps/`)**: Daily/monthly journals (`YYYY-MM-DD.md`) enabling temporal recall (`memory_recall_time`).
- **Self-Seeding**: Automatically seeds from `packages/memory/seed/` or external backups when starting in a fresh environment.

### 2.5 Hierarchical ChatGPT Context (`GPT.md`)
- `~/.pilot/GPT.md` provides user-global ChatGPT/Pilot defaults and is initialized once by `pilot setup` without overwriting existing content.
- `<repo>/AGENTS.md` remains shared repository engineering guidance for all coding agents.
- `<repo>/GPT.md` provides repository-local ChatGPT/Pilot guidance and may specialize lower-priority context.
- `context_info` returns bounded context sources, hashes, precedence, and merged content; `context_explain` traces literal rules to source lines and the highest-priority matching source.
- In workspace mode, repository context discovery is bounded by the configured root and may not walk to parent repositories. The user-global file is the only intentional external context source.
- Runtime/system policy, access boundaries, and approval requirements are guardrails and cannot be overridden by context files.

### 2.6 Bounded Learning & Task Ledger (`apps/server`)
- `todo_add`, `todo_list`, and `todo_update` maintain durable per-workspace intent/history in `.pilot/todos.json`; completed work is retained rather than silently deleted.
- `learning_observe` records bounded task outcome evidence and candidate lessons in `.pilot/learning.json`; secrets are redacted inside the persistence module as a defense-in-depth invariant.
- `learning_history` exposes outcome/status/target counts plus promotion rate so learning quality is measurable rather than inferred from candidate volume.
- `learning_promote` requires `confidence >= 0.6` and `reuse_potential >= 0.5`. Memory candidates use the existing Memory provider and `lessons` drawer.
- Skill, Capability, and GPT candidates are proposal-only. Learning never grants authority to edit code, Skills, context files, Git history, or runtime policy.
- `learning_rollback` withdraws proposals or removes only the Memory artifact associated with a promoted candidate.
- Todo and learning JSON use atomic temp-file/rename persistence with serialized in-process mutations and fail closed on corrupt state.

### 2.7 Durable Flow Orchestration (`apps/server`)
- `flow_create` plans a durable DAG workflow from a goal plus steps; independent ready steps are eligible to run concurrently up to the run concurrency limit. Steps reference inner capabilities (with `expected_sha256` support on `edit_file` inputs) and are re-checked against policy at execution time.
- `flow_run` executes a planned run, `flow_get` reads one run with all step states, and `flow_events` reads the append-only event log plus recent checkpoints.
- `flow_resume` resumes a failed or interrupted run; unknown side effects fail closed unless `retry_uncertain` is explicitly authorized. `flow_cancel` persistently marks a run cancelled so no new step batch is scheduled.
- Flow capabilities are grouped under `flow` in `capability_registry` and stay behind `toolpy` on the Hybrid surface, so ChatGPT composes DAGs programmatically instead of chaining dozens of direct calls.

---

## 3. Runtime Control Plane

- `runtime_info`: reports build commit vs Git HEAD, stale-build state, worker PID/uptime, tunnel ownership, contract fingerprint, capability count, and last restart receipt.
- `capability_diff`: compares the live worker manifest against a fresh `--check` probe and reports added/removed/changed tools plus fingerprint equality.
- `restart_if_stale`: restarts only for proven worker-behind-dist or surface mismatch; it refuses unsupervised self-termination and reports dist-behind-HEAD as a build prerequisite.
- `self_update`: opt-in fast-forward of `origin/main`, then build, full verification, supervised restart, and post-restart handshake; it fails closed on dirty trees, non-main branches, unpushed commits, divergence, or fetch failure.

The deterministic contract fingerprint excludes environment-specific timeout configuration so equivalent capability surfaces compare equal across deployments.

---

## 4. Storage Architecture

Storage is split into two deterministic layers:

1. **Workspace-Local Storage (`.pilot/`)**:
   - `audit.ndjson`: Immutable chronological log of every executed tool call.
   - `config.json`: Local machine router and environment configuration.
   - `supervisor.json`: Worker heartbeat and PID registry.
   - `todos.json`: Durable task/todo ledger.
   - `learning.json`: Outcome observations and learning-candidate lifecycle state.
   - `memory/`: Active living memory book (`TOC.md`, `SUMMARY.md`, `chapters/`, `timesteps/`).
2. **User-Global Storage (`~/.pilot/`)**:
   - Fallback directory when no workspace `.pilot/` directory exists.
   - `GPT.md`: user-global ChatGPT/Pilot working defaults.
   - Stores global credentials, tunnel control plane DPAPI keys, and global memory.

---

## 5. Architectural Invariants

1. **Zero-Native Dependencies in Memory**: The memory system must remain pure Markdown + Node.js standard library to ensure 100% portability across operating systems without C++ compilation requirements.
2. **Zero-Config Discovery**: Internal workspace modules must be discoverable automatically from the repository root without requiring manual path flags.
3. **Fail-Closed Security**: External remote providers must declare read-only hints explicitly; tools lacking explicit annotations are treated as potentially destructive.
4. **Deterministic Fingerprints**: Worktree state fingerprints must omit runtime artifacts (`.pilot/`, `.chatgpt-machine/`, `.tunnel/`) to avoid false-positive verification errors.
5. **Supervisor Circuit Breaker**: Background MCP workers must be monitored; failing or hung workers are killed cleanly and transparently restarted.
6. **Evidence Before Learning**: Learning candidates are observations, not authority. Memory promotion requires evidence thresholds; Skill/Capability/GPT changes remain proposal-only and use the normal verification/policy workflow.
