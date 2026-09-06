<p align="center">
  <img src="docs/assets/mcp-tunnel-meme.png" alt="ChatGPT Pilot" width="750">
</p>

# ChatGPT Pilot

[![CI/CD](https://github.com/JonusNattapong/chatgpt-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/JonusNattapong/chatgpt-pilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-2.0-purple.svg)](https://modelcontextprotocol.io/)

**Give ChatGPT controlled access to your local machine.**

ChatGPT Pilot is a local MCP runtime for ChatGPT, Codex, and other MCP clients. It combines machine/coding tools, structured reasoning, reusable skills, persistent Markdown memory, and the ChatGPT tunnel behind one gateway.

The normal user experience is a CLI: **set it up once, turn it on, use ChatGPT, turn it off when you are done.**

```text
ChatGPT / Codex
      │
      │ MCP over tunnel or stdio
      ▼
 ChatGPT Pilot
      ├── Machine & coding tools
      ├── ThinkForge
      ├── Skill Hub
      └── Memory
      │
      ▼
 Your computer / workspace
```

## Quick start

### Requirements

- Node.js 22+
- pnpm 9+ or 10+
- Git 2.30+
- Python 3.10+ with `ipykernel` only if you want persistent `toolpy` Python sessions

### Install

```bash
git clone https://github.com/JonusNattapong/chatgpt-pilot.git
cd chatgpt-pilot
pnpm install
pnpm build
```

### First-time setup

From the repository root:

```bash
pnpm pilot setup
```

`setup` creates the local Pilot configuration, checks the runtime prerequisites, builds the project, and validates the MCP server.

### Turn Pilot on

```bash
pnpm pilot start
```

`start` is an alias for `up`. It starts the supervised MCP runtime and ChatGPT tunnel. Starting an already-running local instance is safe: the tunnel lifecycle is designed to be idempotent and will not silently steal a live runtime owned by another checkout.

### Check it

```bash
pnpm pilot status
pnpm pilot doctor
```

### Turn Pilot off

```bash
pnpm pilot stop
```

`stop` is an alias for `down` and stops the tunnel/watchdog stack.

### Restart

```bash
pnpm pilot restart
```

That is the main workflow:

```text
pnpm pilot setup       # once
pnpm pilot start       # turn on
pnpm pilot status      # inspect
pnpm pilot doctor      # diagnose
pnpm pilot restart     # reload/recover
pnpm pilot stop        # turn off
```

> The underlying PowerShell/Bash scripts still exist for development and troubleshooting, but they are implementation details. For normal use, use the Pilot CLI.

## CLI

The built CLI identifies itself as `chatgpt-local`. Inside this repository, `pnpm pilot ...` is the convenient entry point.

| Command | Alias | Purpose |
|---|---|---|
| `pnpm pilot setup` | — | Initialize config, preflight, build, and check |
| `pnpm pilot up` | `start`, `on` | Start Pilot and the tunnel |
| `pnpm pilot down` | `stop`, `off` | Stop Pilot and the tunnel/watchdog |
| `pnpm pilot restart` | — | Rebuild and restart the stack |
| `pnpm pilot status` | — | Show tunnel, workspace, supervisor, worker, and circuit state |
| `pnpm pilot doctor` | — | Run deeper runtime diagnostics |
| `pnpm pilot check` | — | Build and validate the MCP surface |
| `pnpm pilot use <path>` | — | Select the active workspace |
| `pnpm pilot workspace [path]` | — | Read or change the active workspace |
| `pnpm pilot config show` | — | Show local configuration |
| `pnpm pilot config init` | — | Create local configuration if missing |
| `pnpm pilot config reset` | — | Reset local configuration |
| `pnpm pilot machine list` | — | List registered remote machines |
| `pnpm pilot version` | — | Print the version |

### Choose a workspace

Pilot can be pointed at the project ChatGPT should work with:

```bash
pnpm pilot use D:\Projects\Github\my-project
pnpm pilot status
```

Changing the configured workspace does not mutate a running worker in place. If `status` reports `restart_required: true`, run:

```bash
pnpm pilot restart
```

## Connect ChatGPT

### ChatGPT Web / Desktop

For ChatGPT, Pilot normally runs through the developer tunnel:

```bash
pnpm pilot start
```

The local gateway owns the worker and tunnel lifecycle. Once your MCP connection is configured in ChatGPT, you do not need to manually launch the server process for each session.

### Stdio clients

Clients that launch MCP servers directly can use the built server:

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

Only use unrestricted machine access when you actually need it. Workspace-scoped access is the safer default.

## What Pilot gives ChatGPT

### Machine & coding

Pilot exposes bounded, structured primitives instead of forcing the model to do everything through a shell:

- filesystem reads, searches, atomic edits, and SHA-256 preconditions
- project snapshots and code search
- supervised background processes with persistent output offsets
- direct argv process execution
- Git status, diff, history, verified commits, and controlled publishing
- machine, port, disk, network, and runtime diagnostics
- persistent Python execution through `toolpy`

High-authority operations remain policy/approval gated.

### GPT.md context

Pilot has an explicit context chain for ChatGPT-specific working instructions:

```text
runtime/system security       # hard guardrail; context files cannot weaken it
        ↓
~/.pilot/GPT.md               # user-global Pilot defaults
        ↓
<repo>/AGENTS.md              # shared repository engineering guidance
        ↓
<repo>/GPT.md                 # repository-local ChatGPT/Pilot guidance
        ↓
current user request          # highest task-level intent within guardrails
```

`pnpm pilot setup` creates `~/.pilot/GPT.md` once when it is missing and never overwrites an existing user file. Repository `GPT.md` files are normal tracked project context; `AGENTS.md` remains the shared cross-agent engineering contract.

Use `context_info` to inspect the loaded sources and merged context. Use `context_explain` with an optional literal query to trace a rule back to its source and effective priority. In workspace-restricted mode, repository context discovery never walks above the configured workspace boundary.

### ThinkForge

ThinkForge provides structured reasoning operations for work that benefits from more than a single generation pass:

- problem analysis and reframing
- inversion and first-principles exploration
- cross-domain analogy and biomimicry
- mechanism generation
- adversarial idea review
- synthesis
- bounded falsification experiments

### Skill Hub

Skill Hub lets ChatGPT discover and load reusable engineering procedures from the local skill registry. It supports search, task routing, ranking, workflow composition, skill reading, synchronization, and aggregate outcome telemetry.

### Memory

Pilot includes a human-readable Markdown memory engine under `.pilot/memory/`. It can maintain chapters, timelines, summaries, topic recall, and specialized memory drawers without requiring a native database.

## Hybrid tool surface

The hybrid surface keeps the public MCP connection compact while still giving ChatGPT access to the full capability registry:

```text
ChatGPT
  │
  ├── toolpy
  │     └── controlled programmatic access to capabilities
  │
  └── capability_registry
        ├── coding
        ├── think
        ├── skills
        └── memory
```

This lets ChatGPT compose several low-level operations inside one controlled execution rather than spending a separate MCP round trip on every primitive.

## Control plane

Pilot can inspect whether its running worker matches the current build:

```text
runtime_info
    │
    ├── fresh ───────────────► continue
    │
    └── stale
          │
          ▼
   capability_diff
          │
          ▼
   restart_if_stale
          │
          ▼
     runtime_info
```

`runtime_info` and `capability_diff` are read-only. `restart_if_stale` only restarts on demonstrated staleness. `self_update` is more privileged: it requires `MCP_ALLOW_SELF_UPDATE=1` and refuses unsafe repository states such as a dirty tree, non-main branch, unpushed commits, or divergence.

## Remote machines

Pilot can route capabilities to registered remote MCP machines. Selectors can be IDs, names, hostnames, aliases, IP addresses, or `host:port` values.

```bash
pnpm pilot machine list
pnpm pilot machine add devbox 192.168.1.50:8787 --name "Dev Box"
pnpm pilot machine remove devbox
```

Remote calls still pass through the remote machine's own policy, workspace boundary, approvals, and audit controls.

## Configuration

Local configuration controls the active workspace, policy, approval mode, and access mode. Runtime flags/environment variables are also available for lower-level launches.

| Argument | Environment variable | Default | Purpose |
|---|---|---|---|
| `--root` | `MCP_WORKSPACE_ROOT` | current directory | Workspace and safe-mode boundary |
| `--tool-surface` | `MCP_TOOL_SURFACE` | `legacy` | `legacy` or `hybrid` tool exposure |
| `--dangerously-open-machine` | `MCP_ACCESS_MODE` | `workspace` | Enable unrestricted machine access |
| `--policy` | `MCP_POLICY` | `admin` | `admin`, `developer`, or `readonly` |
| `--approval-mode` | `MCP_APPROVAL_MODE` | `mrtr` | Approval enforcement mode |
| `--audit-file` | `MCP_AUDIT_FILE` | `.pilot/audit.ndjson` | Audit trail path |
| `--max-timeout` | `MCP_SUPERVISOR_TIMEOUT_MS` | `600000` | Maximum per-tool timeout |

## Security model

Pilot is powerful by design, so the boundary is explicit:

- **Workspace isolation** — workspace mode confines filesystem operations to the configured root and rejects escaping symlinks.
- **Approval gates** — mutating/high-authority capabilities can require explicit authorization.
- **Process supervision** — long-running processes are tracked and can be inspected or terminated as process trees.
- **Optimistic concurrency** — file mutation tools can require a SHA-256 observed during the preceding read.
- **Verified Git flow** — verification can run before selected changes are committed or published.
- **Audit trail** — machine operations are recorded to NDJSON with sensitive values redacted.
- **Controlled self-update** — autonomous updates fail closed when repository state is unsafe.

`--dangerously-open-machine` deliberately removes the normal workspace filesystem boundary. Treat it as an administrator/developer mode, not the default installation mode.

## Direct tunnel scripts

These are useful when debugging the lifecycle layer itself. Normal users should prefer `pnpm pilot ...`.

### Windows

```powershell
.\scripts\start-tunnel.ps1
.\scripts\status-tunnel.ps1
.\scripts\doctor.ps1
.\scripts\restart-tunnel.ps1
.\scripts\stop-tunnel.ps1
```

### Linux / macOS

```bash
./scripts/start-tunnel.sh
./scripts/status-tunnel.sh
./scripts/doctor.sh
./scripts/restart-tunnel.sh
./scripts/stop-tunnel.sh
```

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm verify
pnpm check:hybrid
```

Repository layout:

```text
apps/server          MCP gateway, CLI, machine/coding runtime, supervisor
packages/thinkforge  structured reasoning capabilities
packages/skill-hub   local skill registry and routing
packages/memory      Markdown memory engine
scripts/             tunnel lifecycle and repository automation
skills/              reusable skill procedures
```

## Troubleshooting

Start with:

```bash
pnpm pilot status
pnpm pilot doctor
```

If the configured workspace differs from the running worker:

```bash
pnpm pilot restart
```

If you are developing Pilot itself and need to validate the complete repository:

```bash
pnpm verify
```

## License

MIT. See [LICENSE](LICENSE).
