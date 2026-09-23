# Recovered Projects & Repositories

Snapshot recovery pass: 3 — 2026-09-06 (Asia/Bangkok)

This file consolidates project/repository context ChatGPT could retrieve. Items are historical snapshots, not guaranteed current unless explicitly marked. Secrets and sensitive connected-account data are excluded.

## Loom Agent

- GitHub: `JonusNattapong/loom-agent`.
- By 2026-08-19 the user explicitly said Oracle was no longer the active project and Loom was the primary project context.
- v1.0.0 was released and merged to `main` around 2026-08-20.
- Remembered release metadata:
  - merge commit: `c8b7b1d9d298bd178075dd1eead1a9b652d9a609`
  - tag: `v1.0.0`
  - final branch commit: `938652d`
  - PR `#11` merged
  - `main` synchronized/clean at that snapshot
- Validation remembered: `npm ci`, build, eval, `npm audit` with 0 vulnerabilities, `git diff --check`, tarball secret/package checks, CI build/eval/GitGuardian.
- v1.0 remembered as 35 files / 167 tests, preserving 133 baseline tests + 34 V1 tests.
- Versioning remembered: root, `@loom/sdk`, `@loom/config`, and relevant publishable packages at `1.0.0`; protocol major 1 / `PROTOCOL_VERSION "1.0"`; config schema 1.
- Roadmap/history already preserved in `MEMORY.md`: durable harness; context compiler; skills; working memory; task graph; roles/delegation; bots; adaptive planner; daemon/jobs/schedules; remote worker fabric; WebSocket controller; SDK/productization.
- Architectural recommendations associated with Loom: checkpoint/resume, append-only event log/replay, state machine, idempotency, leases, capability permissions/policy engine, scheduler/queue/backpressure, circuit breaker, service discovery/health, tracing, artifacts/snapshots, schema registry/DLQ/saga, actor/supervisor patterns, feature flags/evals/cost governor.

## ChatGPTMCP / ChatGPT Machine MCP

- Primary local repo: `D:\Projects\Github\ChatGPTMCP`.
- GitHub account/repo context: `JonusNattapong/ChatGPTMCP`.
- Initial public-repo context remembered: initial commit `e1d5be8`; initial tests 4/4; `.tunnel/`, `node_modules`, `dist` excluded; large local binaries were not intended for source history.
- CLI name selected: `chatgpt-local`.
- Hardening snapshot around 2026-09-03:
  - commit `596327b` — `harden coding DX and remote reads`
  - verification remembered as 101/101 tests
  - contract remembered as v4 / 44 tools at that time
  - later coding capability registry exposed 45 tools
  - added/strengthened `read_files`, `project_snapshot`, `machine_read`, remote capability cache/fingerprint/refresh, audit `targetMachine`/`remoteTool`, PowerShell non-terminating-error handling, and runtime/configured-root visibility.
- Capability registry / hybrid surface milestone around 2026-09-04:
  - moved to persistent Jupyter/IPython kernel
  - stable `session_id` with persisted variables/imports/functions across calls
  - top-level `await`
  - `tools.*`, `call`, `describe`, `result`
  - limits/TTL/timeouts and fail-closed workspace-only behavior
  - local Python remembered as `C:\Python313\python.exe`
  - IPython 9.5.0, ipykernel 7.0.1, jupyter_client 8.6.3
  - `npm run build` passed at that milestone
- Important security caveat: persistent IPython is not a sandbox; it has worker OS privileges and must remain constrained by allowed capabilities/workspace/policy.
- Preferred persistent-runtime workflow:
  - one stable `session_id` per task/project, e.g. `analyze-em-gateway`
  - reuse kernel state across calls
  - reset when task completes, state is corrupted, dependencies/environment change, or clean-room verification is required
  - durable data belongs in files/DB/Git rather than only kernel memory.
- Standard temporary workspace remembered: `D:\temp\ChatGPT` for scratch files, generated artifacts, logs, downloads, intermediate data; not primary persistent source storage.
- P0 direction: local execution should be stable, smooth, recoverable, observable.
- Multi-machine direction: support more than two machines with explicit machine/IP selection.
- Architecture direction by 2026-09-05: one ChatGPTMCP surface exposing coding, think/ThinkForge, skills, and memory/OurBook capabilities, while ChatGPT Web remains planner/decision-maker and low-level execution stays behind the capability registry.
- Additional concepts explored: branching architecture experiments, composing components across repos, code/reasoning checkpointing, sandbox-built persistent tools, bounded background prototypes.
- 2026-09-05 proposed hardening patches accepted by user: process identity/start-time checks; persistent idempotency receipts; verified-commit content fingerprinting; richer verification diagnostics/overall timeout; `apply_patch` file preconditions; `process_wait` output inclusion. Baseline had pre-existing failures and 23 outstanding tasks that were to be preserved rather than overwritten.

## ChatGPT Skill Hub / chatgpt-skills

- Local paths:
  - `D:\Projects\Github\chatgpt-skill-hub`
  - `D:\Projects\Github\chatgpt-skills`
- Skill families remembered:
  - Discovery/Planning: research, grilling, grill-with-docs, domain-modeling, to-spec, to-tickets
  - Architecture: codebase-design, improve-codebase-architecture, adr-authoring, archify
  - Implementation: implement, tdd, diagnosing-bugs, frontend-design, databases
  - Verification: code-review, qa-methodology, playwright, verification-before-completion
  - Production: create-observability, platform-engineering
  - Documentation: humanizer, technical-documentation
- Archify workflow: read skill/schema -> scan real code -> collect source evidence -> architecture JSON -> validate -> HTML/SVG -> visual-check -> repair until pass -> treat architecture drift as first-class.
- Capability Forge direction: observe recurring real friction first; inspect/reuse existing skills/tools/plugins/MCPs; prefer configuration/patching before new components; define measurable success; build minimum useful versions; verify inputs/errors/timeouts/permissions; dogfood; never store secrets in skills/source.
- Capability Observer direction: telemetry only, not full prompts/keys/secrets; project-local capabilities stay in Git.
- Curator controls explored: weekly-ish interval (`interval_hours: 168`), minimum idle 2h, stale after 30d, archive after 90d, consolidation disabled initially, dry-run first, explicit write approval, diff/approve flow, maintain changelog.

## ThinkForge MCP

- Local path: `D:\Projects\Github\ThinkForge-MCP`.
- Purpose: unconventional thinking/reframing with inversion, analogy, biomimicry, constraint breaking, synthesis.
- v0.2.1 Quality Hardening:
  - objective-alignment scoring
  - `accept / reframe / reject`
  - semantic dedup
  - candidate-specific challenge
  - synthesis answers original decision
  - experiment design tied to candidate hypothesis/metric/falsification
  - objective + constraints support
  - alignment-aware ranking
  - regression tests for drift/duplicate/generic challenge/synthesis/experiment behavior
- Remembered commit: `da564d3 fix: harden ThinkForge reasoning quality`.
- Remembered verification: 18/18 tests.

## OurBook

- Local path: `D:\Projects\Github\ourbook`.
- Persistent-memory/Second-Brain direction:
  - cross-session/restart/project persistence
  - default DB `~/.ourbook/memory.db`
  - optional `OURBOOK_MEMORY_SCOPE=project`
  - embeddings + SQLite FTS5 + importance/confidence/recency/access/supersession
  - timeline, feedback, working memory, reflection, preferences, decisions, handoff, next actions
  - nightly consolidation / `ourbook_consolidate`
  - idempotent daily continuity memory with source IDs
  - dream/shared-lore direction for recombining old memories into new stories/continuity.

## ClewCode / Clew ecosystem

- Canonical naming: **ClewCode / Clew Code**. Ignore stale `MooCode` naming.
- Main local path: `D:\Projects\Github\clew-code`.
- Older family map:
  - ClewCode = coding-agent runtime/harness
  - Clew IDE = control-plane/IDE direction
  - `clew-api` = multi-provider gateway/model catalog/usage-cost logging
  - `agoya` = file-backed Memory MCP with BM25/optional vector/graph/consolidation
  - `agora` = Rust/file-backed message bus
  - `saka` = historical naming/branch/context
  - Reverse-Engineer = agent-sandbox research
- Core metaphor: many threads woven together become stronger; avatar/name context `Loony`.
- June 2026 ClewCode documentation described a Bun/TypeScript local-first multi-provider CLI with built-in file/shell/browser/GitHub/notebook/web tools, MCP, plugins/hooks/skills, subagents, autonomous work, LAN/process mesh.
- Remembered June architecture/source paths:
  - `src/main.tsx`, `src/replLauncher.tsx`, `src/QueryEngine.ts`, `src/query.ts`, `src/commands.ts`
  - `src/tools/`, `src/services/ai/`, `src/services/mcp/`, `src/services/autonomous/`, `src/services/Supervisor/`, `src/peer/`, `src/memory/`, `src/plugins/`, `src/skills/`
  - settings `.clew/settings.json` and `.clew/settings.local.json`
- Dev commands remembered: `bun install`, `bun run dev`, `bun run build`, `bun run start`, `bun test`, `bun run lint:check`, `bun run format:check`, `bun x tsc --noEmit`, `bun run check:ci`, `bun run docs:generate`, `bun run codegraph`, `bun run relay`.
- June README snapshots claimed 27 provider adapters, 50+ built-in tools, 15 mesh tools in one snapshot, 7 permission modes, SQLite-backed memory, file-backed autonomous queue, leases/retries/dead letters, cron, max 3 concurrent workers.
- v0.2.22 remembered for 2026-06-15: Max Mode default 3 candidates, `/goal`, checkpoints at 20/45/70%, 7-day Dream consolidation, 30-day Distill, video input, image/video generation, `/profile`, `/mode` (`safe|yolo|afk|review-only|browser-safe`), `ReadArtifact`, 200-line tool-output cap with disk persistence.
- v0.2.4/v0.2.5 history remembered: P2P discovery, autonomous agents, `/memory search`, ~14 peer tools.
- Runtime boundaries explicitly separated: subagents for quick investigation; teammates/swarm for longer coordination; `/mesh` for LAN Clew instances; ACP for external editors/agents; Process Mesh for external workers.
- Plan persistence: `.clew/plans/long-term-plan.md`.
- Commands remembered: `/model`, `/provider-select`, `/mcp`, `/mesh`, `/loop`, `/daemon`, `/task`, `/goal`, `/profile`, `/mode`.
- Local/LAN behavior: optional multicast via `CLEW_MESH_LAN=1`; peer operations include share/discover/list/run/send/dashboard/memory sync; leases/retries/dead letters/cron/heartbeats/up to 3 workers.
- Remembered 2026-09-02 `main` HEAD: `00b1b7e4`.
- Hybrid memory under `.clew/memory/`: `MEMORY.md`, `DECISIONS.md`, `checkpoint.md`, `notes.md`, `tasks/`, plus `memory.db`.
- SQLite memory features: memories, memory_keys, memory_timeline, importance, confidence, access tracking, dedup/reinforcement, timeline.
- `BudgetInjector` remembered ranking: `importance*0.5 + confidence*0.3 + recency*0.2`, roughly 5% context budget with cap around 4000 tokens.
- Memory-hardening direction: provenance `stated|observed|inferred`; source ownership `user|assistant|tool|web|connector|system`; no-save by default for re-queryable output; read-before-ask; explicit supersedes links; consolidation gate. Avoid unnecessarily replacing the existing hybrid MemoryDB/BudgetInjector design with filesystem-only memory.
- Setup at one point included Playwright/codegraph MCP plus TypeScript/Pyright LSP plugins.
- 2026-09-05 audit snapshot:
  - 968 tests passing and build passing in one audit stage
  - fixed unsupported `eval.*` authorization denial and awaited MCP toggles via `allSettled` with failure reporting
  - large structural debt observed: 1,329 circular cycles, 1,116 Phase3 `ts-expect-error`, 43 `ts-ignore`/`nocheck`, 146 inline sourcemaps
  - worktree was dirty; not committed/pushed at that stage
  - later scan still had frontend async-lifecycle/source/type/circular-debt work remaining.
- Separate hardening pass around 2026-09-04 remembered:
  - MCP client reconnect lifecycle/tests
  - removed automatic Jina fallback
  - propagated memory persistence failures
  - enforced MCP Zod parsing
  - removed duplicate `/bg` registration with uniqueness invariant
  - removed HISTORY_SNIP inert surfaces
  - removed TaskOutputTool from default pool
  - added `useMergedClients` and diagnostic-tracking tests
  - verification snapshot: Biome CI 0 warnings, TypeScript `noEmit` passed, 999 tests / 0 failed, 2,978 assertions, 175 test files; not yet committed/pushed at that snapshot.
- Product/scope preference around 2026-08-27: rejected overbuilt Clew cloud/multi-worker/training direction as too large. Preferred minimal scope: small local 1.5B/3B model for simple work, Codex/Claude/GPT fallback, verifier, record success/failure; no auto-training initially.
- Earlier protocol preference: Anthropic Messages format as official Clew internal protocol and capability registry instead of scattered provider-specific checks; prioritize registry/CLI/provider behavior over large protocol refactor.

## Persistent intelligent loop / agent-platform pattern

- Durable local supervisor + SQLite WAL/control state + isolated per-iteration agent context.
- Optional worktrees, remote adapters, and event adapters.
- Budgets, backoff/jitter, no-progress breaker, overlap coalescing, semantic dedupe/fingerprints, idempotency, independent verification, explicit goal termination.
- One writer per checkout and unchanged-HEAD preconditions before mutation.
- Supervisor owns durable scheduler state; model can request reschedule/stop/pause but should not directly mutate scheduler persistence.
- Recommended audit bundle: commands, exit codes, diff/patch hash, tests/lints/typechecks, verification evidence, resulting commit.
- Durable task states remembered: `PENDING`, `READY`, `CLAIMED`, `WORKING`, `WAITING`, `REVIEW`, `BLOCKED`, `FAILED`, `DONE`, `CANCELLED`.
- Lease ownership, heartbeats, stale-worker reconciliation, layered memory (project/bot/task/user), worktree isolation, explicit approval, evidence-backed completion.
- Scoped MCP connection ownership fields explored: server/session/principal/auth scope/health/capabilities/connection state.

## Conus

- Rust local-first agent runtime direction; remembered full specification ~3,092 lines.
- At one remembered starting point, public `main` held only README/initial commit; implementation had not landed yet.
- Executables: `conus`, `conusd`.
- Tokio tasks/channels rather than formal actor framework.
- Transactional SQLite writes, ordered event append, idempotency IDs, typed errors, durable approvals, resource budgets, secret redaction, localhost-default daemon binding.
- Roadmap: resumable execution, verification, recursive agents, continual harness, scheduler, MCP/skills, TUI, then remote workers.

## Cursox

- Desktop terminal workspace app, Aug 2026.
- Stack: Tauri 2 + React + TypeScript + Tailwind; Rust ConPTY through portable-pty; xterm.js.
- Multiple terminals, inline CWD, editor, split H/V, tabs, drag/drop, move/resize.
- Hardening: crash/exit detection, orphan cleanup, backpressure, UTF-8/Thai paths, PowerShell/cmd/WSL runtime tests.
- Modules explored: Monaco editor/file tree/tabs, workflow detectors/panels, agent launcher/workspace, Context Composer, Coordination, Rust integration.

## Oracle — historical

- Former primary project; explicitly superseded by Loom around 2026-08-19.
- Local workspace remembered: `D:\Projects\Github\Oracle-Ecosystems` -> `hybrid-ws`.
- CLI/MCP names: `oracle`, `oracle-mcp`.
- Architecture: CLI, MCP server, message server, runtime daemon, Remote Swarm, Control Center, ConsultService, backends, sandbox, memory, messaging, task tracker, coordination, scheduler, docs KB, web providers, skills, wiki, identity/soul prompts, GitHub integration.
- Backends: codex, anthropic, openai, gemini, opencode, chatgpt-browser/browser.
- Remembered 2026-07-26 discrepancy: latest code had a v0.7.0 feature commit while `package.json` still declared `0.5.0`.
- Oracle was characterized as a durable coordination runtime with checkpoint/resume, audit, provider/cost routing, remote swarm, durable outbox, deterministic IDs, replay/reconnect, idempotent recovery, tamper-evident audit.
- Stream Reader fix note: `turnRequestIds`; remembered 651 tests passed in a later snapshot.

## Prediction Market Oracle MCP

- Local path: `D:\Projects\Github\prediction-market-oracle-mcp`.
- TypeScript MCP SDK v2, `PolymarketProvider`.
- Tools: `search_markets`, `get_market`, `get_probability`, `get_orderbook`, `list_sources`.
- CLOB bid/ask midpoint + fallback snapshot probability.
- Polygon `chainId: 137`; conditionId/questionId; ERC-1155 outcome token IDs; CTF/Exchange/UMA provenance.
- Provider abstraction prepared for Azuro.
- Read-only oracle separated from execution/trading; execution disabled initially.

## kasvanta / CropGraph MCP

- AI gardener / digital-twin + event-memory concept.
- PlantTaxon/Cultivar -> GrowthProfile -> user Planting/Specimen -> GardenZone.
- Observation, LifecycleEvent, Intervention, Harvest, HealthIncident, Task, EnvironmentSnapshot.
- Differentiator: static plant database is baseline knowledge; accumulated garden history is the durable asset.

## AgentTalk / A2A MCP

- Local path: `D:\Projects\Github\agenttalk-mcp`; GitHub context `JonusNattapong/A2A-MCP`.
- Goal: direct agent-to-agent communication/coordination through an MCP/message layer.
- LAN P2P code remembered with unique UDP-port allocation, HTTP-port binding smoke tests, and end-to-end local message-store flow tests.

## mcp-agent-hub

- Planned TypeScript rewrite/migration from `bus-agent v2.4`.
- Legacy module sizes remembered approximately: `mcp.js` 28k, `bus.js` 18k, `memory.js` 21k.
- JSON-RPC 2.0 as core protocol; MCP as adapter rather than domain core.
- SQLite source of truth; FTS5 in core; embeddings/vector memory as plugin.
- Child-process bridges should be asynchronous, not blocking `execSync` style.

## AgentWorld / 3D agent world

- Godot 4.x + Python/SQLite experimental direction.
- Four-bot MVP remembered: Manager, Coder, Researcher, Reviewer.
- First vertical slice: Godot Control Room -> Manager -> Coder -> isolated workspace -> edit/test -> Reviewer -> evidence-backed completion.
- Long-term idea: programmable 3D world as spatial interface to an Agent Harness Runtime with persistence, swappable models, progressive skills, scoped MCP, permissions, restart-safe tasks, delegation/review, measurable cost/tool usage.
- Roadmap included worktrees, leases, checkpoints/resume/recovery, Godot automation, verifier/metrics/replay, inbox/scheduler/offline tasks.

## Reverse-Engineer / browser-agent / sandbox research

- Reverse-Engineer repo: `JonusNattapong/Reverse-Engineer`; agent-sandbox research direction.
- Browser Agent tooling explored repeatedly; Python + Playwright, local/browser automation, MCP integration, and later ChatGPT/Clew browser-tool ideas.

## Roblox / Ozoria / WarZ experiments

- Roblox/Ozoria survival-game and structured runtime experiments were part of project exploration.
- `Roblox-101` appears in project lineage.
- WarZ source audit context existed for `bizkut/warz-server` and `bizkut/warz-client`; Windows-era DirectX9/PhysX/RakNet/Scaleform-style stack was identified. Detailed old personal data found in source/database artifacts is intentionally excluded from this backup.

## Trading / AK47ScalperEA / Ea-somaria

- Historical strategy: Momentum Burst Scalper + Recovery Layer + Equity Compounding on XAUUSD.
- M5 EMA20/EMA50 trend filter; M1 pullback + breakout; burst multiple same-direction orders; equity-based compounding; basket TP; no fixed SL; not grid.
- High risk was explicitly accepted for small-capital experimentation.
- Target repo remembered: `JonusNattapong/Ea-somaria`.
- `AK47ScalperEA` also appears in project lineage; exact local MetaTrader terminal instance path intentionally omitted.

## Other repos/contexts remembered

- `D:\Projects\Github\dopa-bullet-rust`
- `D:\Projects\Github\WebMCP`
- `D:\Projects\Github\em-gateway-rust`
- `D:\Projects\Github\chatgpt-tunnel-manager`
- `ptt_ws_tpa`
- `saka`

## Personal AI node / Hermes direction

- July 2026 local-node exploration: Ollama + Open WebUI, with AnythingLLM/LiteLLM considered later; small local models such as qwen3:4b or llama3.2:1b were discussed.
- Hermes-agent was preferred over OpenClaw for a server-side personal agent with memory/skills/scheduled jobs/messaging; OpenClaw seen more as broader assistant UX/reference.
- Personal Work Agent architecture explored: Hermes + Ollama + Open WebUI + workspace/memory/task queue/logs/skills/inbox/outbox + `AGENTS.md` + approval gates + Clew integration.

## Media-generation/product experiments

- Desktop AI video-creation app: generate film/cartoon scenes, edit, publish to YouTube; explored low-cost/open-source API/model options.
- Short-form content styles: Stickman Explainer, Time-Lapse Plant Growth.
- Image generation/editing experiments and high-contrast monochrome/dithering/halftone/photocopy visual taste.

## cargo-agentbench

- Rust project packaged as `cargo-agentbench` V1 around 2026-07-10.
- Config-driven agent benchmarking CLI.
- Isolated workspaces.
- Verification/scoring pipeline.
- SQLite WAL history.
- JSON/HTML reports.
- Parallel runs.
- Demo fixture and GitHub Actions workflow.

## Oracle v0.1.0 package context

- Earlier 2026-07-28 context described Oracle as a Node/TypeScript CLI/MCP package named `oracle`, version `0.1.0` at that stage.
- Intended as a personal AI consultant/reviewer-agent with correctness, maintainability, explicit assumptions/uncertainty, and verification as core behavior.
