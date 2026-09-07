# @chatgpt-pilot/server — Core MCP Gateway & Supervisor

The central runtime engine of ChatGPT Pilot. It hosts the MCP server over Stdio and HTTP Streamable transports, runs the supervisor daemon, manages background child processes, enforces workspace safety policies, and mounts internal capability providers.

---

## Core Modules

- `supervisor.ts`: Daemon supervisor that monitors worker health, issues heartbeats, and re-launches crashed MCP workers via circuit breaker.
- `index.ts`: Stdio & HTTP Streamable entrypoint. Federates capability providers (`machine`, `think`, `skills`, `memory`).
- `tools.ts`: Primitives for filesystem reads, edits, search, processes, git operations, and capability registration.
- `browser-use.ts`: Stateful Playwright browser driver with accessibility snapshots, generation-scoped element refs, ref search/actions, bounded batches, and MCP-native screenshots.
- `computer-use.ts`: Structured Windows desktop observe/act driver with screenshot-relative coordinates, cursor/zoom observation, drag/key-hold support, and bounded batches.
- `toolpy.ts`: Persistent IPython kernel sandbox for fast, multi-step programmatic capability calls.
- `verification.ts`: Transactional pre-commit verification gates (`git_commit_verified`).
- `audit.ts`: Immutable NDJSON audit logger recording all tool interactions to `.pilot/audit.ndjson`.

---

## CLI & Options

```bash
# Start server in hybrid surface mode
node dist/index.js --tool-surface hybrid --dangerously-open-machine

# Verify configuration & providers
node dist/index.js --check
```
