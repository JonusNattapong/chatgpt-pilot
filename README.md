<p align="center">
  <img src="docs/assets/mcp-tunnel-meme.png" alt="ChatGPT, OpenAI, and MCP Tunnel" width="750">
</p>

# ChatGPT Pilot

[![CI/CD](https://github.com/JonusNattapong/chatgpt-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/JonusNattapong/chatgpt-pilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-orange.svg)](pnpm-workspace.yaml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-2.0-purple.svg)](https://modelcontextprotocol.io/)

ChatGPT Pilot is a local Model Context Protocol (MCP) server that provides system execution, memory, and cognitive capabilities to ChatGPT, Codex, and other MCP-compatible clients.

It unifies four capabilities behind a single MCP connection:

- **System and Machine Primitives (`apps/server`)**: Bounded filesystem operations, background process execution, pre-commit Git verification gates, and a persistent Python execution runtime (`toolpy`).
- **Cognitive Frameworks (`packages/thinkforge`)**: Analytical tools for structured divergence, convergence, assumption testing, and failure mode simulation.
- **Skills Catalog (`packages/skill-hub`)**: Dynamic discovery and execution of curated procedures stored in `skills/`.
- **Markdown Memory Engine (`packages/memory`)**: A file-based memory store that organizes documentation, project metadata, architectural decisions, and timelines into human-readable Markdown files without native database dependencies.

## System Architecture

```text
                  ┌─────────────────────────────────────────────────────────┐
                  │                 ChatGPT / Codex Client                  │
                  └────────────────────────────┬────────────────────────────┘
                                               │
                                      Stdio / HTTP Stream
                                               │
                                               ▼
                  ┌─────────────────────────────────────────────────────────┐
                  │        ChatGPT Pilot Gateway (`apps/server`)            │
                  │   - Process Isolation & Supervisor Circuit Breaker      │
                  │   - Dynamic Policy Governance & NDJSON Audit Trail      │
                  │   - Hybrid Surface (toolpy + capability_registry)       │
                  └───────┬──────────────┬──────────────┬─────────────┬─────┘
                          │              │              │             │
              ┌───────────┴───┐   ┌──────┴──────┐ ┌─────┴─────┐ ┌─────┴──────────┐
              │ System/Machine│   │ ThinkForge  │ │ Skill Hub │ │ Memory Book    │
              │  apps/server  │   │  Cognitive  │ │ Execution │ │ Pure Markdown  │
              └───────────────┘   └─────────────┘ └───────────┘ └────────────────┘
```

## Prerequisites

Before running ChatGPT Pilot, ensure that your environment meets the following requirements:

- **Node.js**: `20.0.0` or later (`22.x` or `24.x` recommended)
- **pnpm**: `9.x` or `10.x`
- **Git**: `2.30.0` or later
- **Python**: `3.10` or later with `ipykernel` (optional, required only for persistent `toolpy` execution)

## Quickstart

### 1. Clone the repository and install dependencies

```bash
git clone https://github.com/JonusNattapong/chatgpt-pilot.git
cd chatgpt-pilot
pnpm install
```

### 2. Build the packages

```bash
pnpm build
```

### 3. Verify the installation

Run the verification suite to ensure all packages compile and tests pass:

```bash
# Run unit tests across all workspace packages (138 tests)
pnpm test

# Verify the capability surface
pnpm check:hybrid
```

### 4. Connect to an MCP Client

#### Stdio Mode (Claude Desktop, Antigravity, or Local CLI)

Add the server to your client configuration file:

```json
{
  "mcpServers": {
    "chatgpt-pilot": {
      "command": "node",
      "args": [
        "<path-to-repo>/apps/server/dist/index.js",
        "--tool-surface", "hybrid",
        "--dangerously-open-machine"
      ]
    }
  }
}
```

#### Tunnel Mode (ChatGPT Desktop or Web)

To connect through OpenAI's developer tunnel:

- **Windows (PowerShell)**:
  ```powershell
  .\scripts\start-tunnel.ps1
  ```
- **Linux / macOS (Bash)**:
  ```bash
  ./scripts/start-tunnel.sh
  ```

To check tunnel health, diagnose, restart, or stop:

```bash
# Check tunnel status
.\scripts\status-tunnel.ps1   # Windows
./scripts/status-tunnel.sh    # Linux/macOS

# Diagnose everything (ownership, build, tunnel, providers, tool surface)
.\scripts\doctor.ps1           # Windows
./scripts/doctor.sh             # Linux/macOS

# Restart the full stack (stop, reclaim ownership, start, watchdog)
.\scripts\restart-tunnel.ps1  # Windows
./scripts/restart-tunnel.sh     # Linux/macOS

# Stop the tunnel
.\scripts\stop-tunnel.ps1     # Windows
./scripts/stop-tunnel.sh      # Linux/macOS
```

`ChatGPTMCP` is the sole owner of the `chatgpt-machine` tunnel lifecycle.
`start` is idempotent (no-op when already running here) and refuses to steal
a live runtime owned by another checkout unless `-Force` / `--force` is given.

### Control plane (self-diagnosis from ChatGPT)

```text
runtime_info -> stale? no -> continue
             -> yes -> capability_diff -> restart_if_stale -> runtime_info
self_update  -> origin/main only, ff-only, build, verify, restart, handshake
```

`runtime_info` / `capability_diff` are read-only. `restart_if_stale` restarts
only on proven staleness. `self_update` additionally requires
`MCP_ALLOW_SELF_UPDATE=1` and refuses dirty trees, non-main branches,
unpushed commits, and divergence.

## Core Modules

### 1. System and Machine Execution (`apps/server`)

The core server exposes file and process control tools with safety boundaries:

- **Filesystem Tools**: Atomic reads and edits with SHA-256 preconditions and near-miss diagnostics (`read_file`, `write_file`, `edit_file`, `find_files`, `search_code`).
- **Process Management**: Supervised background execution with monotonic offsets and explicit termination (`start_process`, `read_process_output`, `process_write`, `process_wait`, `stop_process`).
- **Verified Git Commits**: `git_commit_verified` executes pre-commit verification checks (`test`, `build`) in a temporary index candidate. If verification fails or files mutate during testing, staging is rolled back and the commit is aborted.
- **Persistent Python (`toolpy`)**: Stateful IPython kernel providing local variables across tool invocations and direct access to internal capabilities via Python functions.

### 2. Cognitive Frameworks (`packages/thinkforge`)

Analytical scaffolds that help models structure complex decisions before code generation:

- `think_diverge`: Generates alternative hypotheses, implementations, or architectures.
- `think_converge`: Synthesizes findings, resolves trade-offs, and structures actionable decisions.
- `think_challenge`: Identifies unstated assumptions, edge cases, and failure modes.
- `think_reframe`: Reformulates a problem under different operational constraints.
- `think_perspective_swap`: Evaluates designs from different user or system perspectives.
- `think_stress_test`: Evaluates architectural resilience against load, concurrency, and partial failure.

### 3. Skills Catalog (`packages/skill-hub`)

A curated repository of 249 currently indexed procedural skills located in the `skills/` directory:

- Catalog discovery via `skills_skill_list` and `skills_skill_search`.
- Task ranking and intent routing via `skills_skill_resolve` and `skills_skill_route`.
- Ordered workflow composition via `skills_skill_compose`.
- On-demand procedure retrieval via `skills_skill_read`.
- Local aggregate learning via `skills_skill_feedback` and `skills_skill_insights` (task/prompt text is not persisted).
- Procedures cover engineering, performance profiling, security audits, database migrations, and release automation.

### 4. Markdown Memory Engine (`packages/memory`)

A zero-native-dependency memory engine that stores state in structured Markdown files under `.pilot/memory/`:

- **Table of Contents (`TOC.md`)**: Automatically maintained index of all chapters, topics, and timesteps.
- **Executive Summary (`SUMMARY.md`)**: High-level synthesis of system context, active projects, and architectural patterns.
- **Chapters (`chapters/`)**:
  - `01-identity.md`: Developer working preferences and interaction models.
  - `02-projects.md`: System catalogue, repository paths, and test counts.
  - `03-architecture.md`: Architectural DNA, loop patterns, and invariants.
  - `04-timeline.md`: Chronological milestones.
- **Timesteps (`timesteps/YYYY-MM-DD.md`)**: Time-indexed logs for temporal recall.
- **Self-Seeding**: Automatically initializes from bundled snapshots in `packages/memory/seed/` when starting in a fresh environment.

## Tool Reference

### System Tools

| Tool | Purpose | Key Parameters |
|---|---|---|
| `read_file` | Read bounded file contents with optional line numbers | `path`, `offset`, `limit`, `expected_sha256` |
| `write_file` | Write complete file contents with collision guard | `path`, `content`, `overwrite`, `expected_sha256` |
| `edit_file` | Transactionally replace exact text blocks | `path`, `edits`, `expected_sha256` |
| `find_files` | Search for files by glob pattern | `pattern`, `root`, `max_depth` |
| `search_code` | Regex search across codebase via ripgrep | `query`, `path`, `case_sensitive` |
| `shell` | Execute shell command within workspace boundary | `command`, `timeout_ms`, `cwd` |
| `start_process` | Start a persistent background process | `command`, `cwd` |
| `read_process_output` | Read stdout/stderr since previous offset | `pid`, `process_id`, `stdout_offset` |
| `process_write` | Send input to a running process | `pid`, `process_id`, `input` |
| `process_wait` | Wait for process completion | `pid`, `process_id`, `timeout_ms` |
| `git_status` | Retrieve structured working tree status | None |
| `git_diff` | Generate unified diff without shell expansion | `paths`, `cached` |
| `git_commit_verified` | Commit staged files after passing verification gate | `message`, `paths`, `profile` |
| `toolpy` | Execute Python code in a stateful IPython session | `code`, `reset_session`, `allow_tools` |

### Memory Tools

| Tool | Purpose | Key Parameters |
|---|---|---|
| `memory_toc` | Retrieve the master Table of Contents | None |
| `memory_summary` | Read the executive summary or chapter overview | `chapter` (optional) |
| `memory_read_topic` | Read a specific chapter or subtopic section | `topic`, `subtopic` |
| `memory_recall_time` | Retrieve notes by date or timestep identifier | `timestep` (`YYYY-MM-DD` or `latest`) |
| `memory_search` | Keyword and semantic search across Markdown files | `query` |
| `memory_remember` | Append a new entry to the timeline and update index | `title`, `content`, `tags` |
| `memory_stats` | Report file counts, word counts, and storage paths | None |
| `memory_recall` | Unified lookup supporting topic, query, or timestep | `query`, `topic`, `timestep` |

### Cognitive and Skill Tools

| Tool | Purpose | Key Parameters |
|---|---|---|
| `think_diverge` | Generate multiple alternative approaches | `prompt`, `count` |
| `think_converge` | Synthesize options into a structured decision | `inputs`, `criteria` |
| `think_challenge` | Identify unstated assumptions and risks | `thesis`, `context` |
| `think_reframe` | Restate problem under alternate constraints | `problem`, `constraints` |
| `think_perspective_swap` | Review scenario from specific stakeholder views | `scenario`, `perspectives` |
| `think_stress_test` | Simulate failure scenarios against a system plan | `plan`, `failure_modes` |
| `skills_skill_list` | List installed skills | `offset`, `limit` |
| `skills_skill_search` | Literal search over skill name/description | `query`, `limit` |
| `skills_skill_resolve` | Rank and deduplicate skills for a task | `task`, `limit` |
| `skills_skill_route` | Classify task intent and return ranked candidates | `task`, `limit` |
| `skills_skill_compose` | Build an ordered workflow of relevant skills | `task`, `max_skills` |
| `skills_skill_feedback` | Record aggregate local outcome telemetry | `skill`, `outcome` |
| `skills_skill_insights` | Return taxonomy, duplicate groups, core coverage, and success stats | None |
| `skills_skill_read` | Read `SKILL.md` or a referenced file inside one skill | `name`, `path` |
| `skills_skill_sync` | Rescan the workspace skill catalog | None |
| `skills_skill_stats` | Return catalog count, roots, and last sync | None |

## Configuration

You can configure ChatGPT Pilot through command-line arguments or environment variables:

| Argument | Environment Variable | Default | Description |
|---|---|---|---|
| `--root` | `MCP_WORKSPACE_ROOT` | Current directory | Working directory and safe-mode boundary |
| `--tool-surface` | `MCP_TOOL_SURFACE` | `legacy` | Tool exposure: `legacy` (raw tools) or `hybrid` (`toolpy` + registry) |
| `--dangerously-open-machine` | `MCP_ACCESS_MODE` | `workspace` | Permits unrestricted filesystem and shell access |
| `--policy` | `MCP_POLICY` | `admin` | Security profile: `admin`, `developer`, or `readonly` |
| `--approval-mode` | `MCP_APPROVAL_MODE` | `mrtr` | Policy enforcement: `mrtr` (require approval) or `deny` |
| `--audit-file` | `MCP_AUDIT_FILE` | `.pilot/audit.ndjson` | Destination path for the immutable NDJSON audit trail |
| `--max-timeout` | `MCP_SUPERVISOR_TIMEOUT_MS` | `600000` | Maximum per-tool timeout in milliseconds |

## Security and Governance

ChatGPT Pilot enforces the following security boundaries:

- **Filesystem Isolation**: In workspace mode, all filesystem reads, writes, and searches are confined to `--root`. Symlinks traversing outside the root boundary are rejected.
- **Process Supervision**: Background processes execute under a supervisor daemon with configurable timeouts, process tree termination, and an automatic circuit breaker.
- **Pre-commit Integrity**: `git_commit_verified` computes a SHA-256 fingerprint of tracked files before and after verification to detect uncommitted or side-effect mutations.
- **Audit Stream**: Every tool call, argument set, execution timestamp, and outcome is written to an append-only `.pilot/audit.ndjson` file. Sensitive credentials (tokens, private keys, and `.env` variables) are automatically redacted before logging and transport.

## Development

```bash
# Run type checking across all workspace packages
pnpm typecheck

# Run test suite
pnpm test

# Build all packages
pnpm build

# Verify build and test gates
pnpm verify
```

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
