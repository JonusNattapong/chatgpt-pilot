# ChatGPT Memory Backup — JonusNattapong

Snapshot date: 2026-09-06 (Asia/Bangkok)

> This is a user-readable snapshot reconstructed from the personal context and memories ChatGPT could retrieve at backup time. It is not an export of OpenAI's internal memory database, hidden model state, credentials, or system data.

## Identity & working style

- Preferred name: JonusNattapong / Jonus.
- Role/context: software engineer / software architect; systems-oriented builder.
- Preferred languages: Go and TypeScript.
- Thai-first technical communication; senior-engineer-to-senior-engineer style; concise, actionable, code-first when appropriate.
- Prefers system/architecture before implementation, with emphasis on reliability, security, DX, scale, explicit verification, and willingness to cut scope.
- Wants real execution rather than vague advice: inspect repos, debug, plan, run safe commands, manage tasks/docs/reports, and distinguish verified fact from inference.
- Strong local-first preference: inspectable, controllable, durable agent infrastructure.
- Development preferences remembered: search/read before claiming; small diffs; parallel agents for independent work; remove fake/unready scaffolding; explicit risk handling for money, secrets, Git mutation, and production.
- Hardware note: 32 GB RAM.
- Birthday context: July 26.

## Current / recent project landscape

### Loom Agent
Primary focus around Aug 19–21, 2026. Repo: JonusNattapong/loom-agent.

- V0.1 durable agent harness baseline.
- V0.2 Context Compiler, Skills Runtime, Working Memory + SQLite, OpenAI-compatible provider + MockProvider, MCP stdio adapter, tool middleware, path/symlink security, shell timeout, recovery lifecycle, config/CLI.
- V0.3 Task Graph & Verified Execution.
- V0.4 roles: planner/researcher/coder/reviewer/tester/general; durable delegation/handoff, leases, A2A bus, scoped context, concurrency, failure propagation, repair, cancellation, approvals, artifacts.
- V0.5 bot runtime + event gateway; V0.5.1 hardening and Discord-ready transports.
- V0.6 adaptive planner, plan validation, deterministic fallback, capability-aware routing, multi-round execution, checkpoints, structured reviewer, targeted tests.
- V0.7 daemon, identity/heartbeat/single-instance, durable jobs/schedules, claim/leases, recovery, retries/backoff/cancel, idempotency, cron/interval/one-shot, bot supervisor.
- V0.8 remote worker fabric: identities/capabilities, routing, fencing, ACK journals, durable state, transport abstraction, replay.
- V0.8.1 WebSocket controller transport, auth, trust scoping, replay, ToolExecutor, policy intersection, shell deny-by-default, workspace canonicalization, cancellation/renewal, worker E2E.
- V0.9: remembered as 28 files / 124 tests, eval passed, npm audit 0, CI green.
- V1.0 SDK productization: @loom/sdk 1.0.0, LoomClient, @loom/config 1.0.0, CLI init/doctor/version/config validation/JSON, OpenAPI 3.0, WorldAdapter, examples/docs; remembered 35 files / 167 tests.

### ChatGPTMCP / ChatGPT Machine MCP
Primary local repo: D:\Projects\Github\ChatGPTMCP; GitHub: JonusNattapong/ChatGPTMCP.

- CLI naming selected: `chatgpt-local`.
- Hardening release around Sep 3: commit `596327b` (`harden coding DX and remote reads`), remembered verification 101/101 tests.
- Contract remembered as v4 / 44 tools at that point; later coding capability registry exposed 45 tools.
- Important tools/features: `read_files`, `project_snapshot`, `machine_read`, remote capability cache/fingerprint/refresh, audit targetMachine/remoteTool, PowerShell non-terminating error handling, runtime/configured root visibility.
- Multi-machine direction: support more than two machines with machine/IP selection.
- P0 direction: local execution must be stable, smooth, recoverable, observable.
- Recent architecture direction: one ChatGPTMCP surface with coding tool, think tool, skills tool, memory tool; ChatGPT Web acts as planning/decision brain while lower-level execution stays behind capability registry.

### ChatGPT Skill Hub / chatgpt-skills
Paths remembered:
- D:\Projects\Github\chatgpt-skill-hub
- D:\Projects\Github\chatgpt-skills

Core skill families remembered:
- Discovery/Planning: research, grilling, grill-with-docs, domain-modeling, to-spec, to-tickets.
- Architecture: codebase-design, improve-codebase-architecture, adr-authoring, archify.
- Implementation: implement, tdd, diagnosing-bugs, frontend-design, databases.
- Verification: code-review, qa-methodology, playwright, verification-before-completion.
- Production: create-observability, platform-engineering.
- Documentation: humanizer, technical-documentation.

Archify workflow to preserve:
1. Read SKILL.md/schema.
2. Scan real code.
3. Collect source evidence.
4. Build typed architecture JSON.
5. Validate.
6. Render HTML/SVG.
7. Visual-check.
8. Fix until pass.
9. Treat architecture drift as first-class.

### ThinkForge MCP
Repo/path: D:\Projects\Github\ThinkForge-MCP.

- Unconventional thinking/reframing system: inversion, analogy, biomimicry, constraint breaking, synthesis.
- v0.2.1 Quality Hardening remembered: objective-alignment scoring; accept/reframe/reject; semantic dedup; candidate-specific challenge; synthesis answering original decision; experiment design tied to candidate; objective + constraints support; alignment-aware ranking; regression tests.
- Remembered commit: `da564d3 fix: harden ThinkForge reasoning quality`; 18/18 tests at that point.

### OurBook / persistent memory
Repo/path: D:\Projects\Github\ourbook.

Concept: persistent second brain / shared memory between AI and user.
- Persistent memory across sessions/restarts/projects.
- Default DB remembered as `~/.ourbook/memory.db`; project scope option `OURBOOK_MEMORY_SCOPE=project`.
- Hybrid recall: embeddings + SQLite FTS5 + importance/confidence/recency/access/supersession.
- Timeline, feedback, working memory, reflection, preferences, decisions, handoff, next actions.
- Nightly consolidation and `ourbook_consolidate`, source IDs, idempotent daily continuity memory.
- Dream/shared-lore direction: memories, dreams, stories, relationship continuity.

### kasvanta / CropGraph MCP
Concept: AI gardener + garden digital twin/event memory.
- Knowledge layer: PlantTaxon/Cultivar -> GrowthProfile.
- User garden layer: Planting/Specimen located in GardenZone.
- Events/entities: Observation, LifecycleEvent, Intervention, Harvest, HealthIncident, Task, EnvironmentSnapshot.
- Core differentiation: plant database is baseline knowledge; accumulated garden history is the valuable persistent digital twin.

### Prediction Market Oracle MCP
Repo/path: D:\Projects\Github\prediction-market-oracle-mcp.
- TypeScript MCP SDK v2.
- PolymarketProvider.
- Tools: search_markets, get_market, get_probability, get_orderbook, list_sources.
- CLOB bid/ask midpoint with fallback snapshot probability.
- Polygon chainId 137; conditionId/questionId; ERC-1155 outcome token IDs; CTF/Exchange/UMA provenance.
- Provider abstraction prepared for Azuro.
- Read oracle separated from execution/trading; execution disabled initially.

### AgentTalk / A2A MCP
Repo/path: D:\Projects\Github\agenttalk-mcp; GitHub context JonusNattapong/A2A-MCP.
- Goal: let two or more agents communicate through an A2A/MCP message layer.
- Part of broader recurring interest in multi-agent orchestration, shared memory, handoff, coordination and message buses.

### chatgpt-tunnel-manager
Path: D:\Projects\Github\chatgpt-tunnel-manager.
- Used to manage secure tunnels for Machine MCP / Skill Hub / related local MCP services.
- `tunnelctl` workflow remembered; tunnel health/auth/reconnect issues have been worked on repeatedly.

## Earlier / historical projects

### Oracle
Previously primary, later explicitly inactive when Loom became primary.
- Local workspace remembered: D:\Projects\Github\Oracle-Ecosystems -> hybrid-ws.
- CLI/MCP names: oracle / oracle-mcp.
- Architecture included CLI, MCP server, message server, runtime daemon, Remote Swarm, Control Center, ConsultService, backends, sandbox, memory, messaging, task tracker, coordination, scheduler, docs KB, web providers, skills, wiki, soul prompts, identity, GitHub integration.
- Backends remembered: codex, anthropic, openai, gemini, opencode, chatgpt-browser/browser.
- Stream Reader fix note: `turnRequestIds`; remembered 651 tests passed.

### Clew ecosystem
- Clew Code: coding-agent CLI/harness fork/direction.
- Clew IDE: control plane / IDE.
- Reverse-Engineer: agent sandbox research.
- Additional remembered project map from older material: ClewCode = coding-agent harness; clew-api = multi-provider gateway with pricing/usage/model catalog; agoya = file-backed Memory MCP; agora = Rust message bus.
- Thread metaphor: many threads woven together become stronger; avatar/name context `Loony`.
- Clew Code local path remembered: D:\Projects\Github\clew-code.

### Cursox
Desktop terminal workspace app (Aug 2026).
- Tauri 2 + React + TypeScript + Tailwind; Rust ConPTY via portable-pty; xterm.js.
- Multiple terminals, inline CWD, editor, split horizontal/vertical, tabs, drag/drop, move/resize.
- Hardening included crash/exit detection, orphan cleanup, backpressure, UTF-8/Thai paths, PowerShell/cmd/WSL tests.
- Modules: Monaco editor, workflow detectors/panels, agent launcher/workspace, Context Composer, Coordination, Rust integration.

### Conus direction
Remembered roadmap from prior project material:
- Rust/Tokio durable agent runtime with SQLite events, resumable execution, verification, recursive agents, continual harness, scheduler, MCP/skills, TUI, then remote workers.
- Local-first and inspectable.

### Other remembered repos/contexts
- D:\Projects\Github\dopa-bullet-rust
- D:\Projects\Github\WebMCP
- D:\Projects\Github\em-gateway-rust
- Reverse-Engineer: JonusNattapong/Reverse-Engineer
- Roblox/Ozoria context and structured game-runtime experiments.

## Architecture DNA / recurring goals

- Multi-agent orchestration and A2A communication.
- Durable message bus and shared/persistent memory.
- Context continuity, working memory, checkpoints and resumability.
- CLI + IDE/control-plane surfaces.
- Browser Agent tooling.
- Bot-to-Bot integrations such as Discord/Telegram.
- Remote workers / server-side connection layer.
- Agent sandbox/research harness for coding agents.
- Provider abstraction and routing.
- Explicit permission/policy boundaries.
- Durable local supervisor + SQLite state.
- Leases, event logs, verification, backoff, idempotency, budgets, credentials/security boundaries and human escalation.

## Saved technical note

### MemoryAdapter ordering
`recall()` orders by `ts` only. MemoryAdapter stamps every write with `monotonicTimestamp()` to avoid CI ordering failures when writes share millisecond timestamps. Removing this guard can reintroduce intermittent ordering failures.

## Trading context

Historical strategy remembered:
- Momentum Burst Scalper + Recovery Layer + Equity Compounding.
- XAUUSD.
- M5 EMA20/EMA50 trend filter; M1 pullback + breakout.
- Burst multiple orders in same direction; equity-based compounding; basket TP; no fixed SL; not grid.
- User explicitly accepted high risk for small-capital experimentation.
- Target repo remembered: JonusNattapong/Ea-somaria.

No account IDs, API keys, passwords, tokens, or other secrets are included in this backup.

## Media / product exploration

- Desktop AI video creation app concept: generate scenes, edit, publish YouTube content; explored low-cost/open-source model/API options.
- Viral-short styles explored: Stickman Explainer and Time-Lapse Plant Growth.
- Image generation/editing experiments and visual-design exploration.
- Design taste remembered: high-contrast monochrome with heavy dithering/halftone/photocopy aesthetic.

## Learning / interests

- AI agents, context engineering, RAG, MCP/tool calling, LLMOps/evaluation, AI security/governance, enterprise AI architecture.
- DevOps/cloud interests include Docker, Jenkins, Kubernetes, Terraform, observability and CI/CD.
- Local models, BYOK/model routing, coding agents, parallel agents and Git worktrees are recurring research areas.

## Operating constraints remembered

From earlier project operating rules/material:
- No provider auto-top-up; manual budget alerts.
- BYOK was disabled in that specific saved operating context.
- Show full API key only at creation in that context.
- Git investigation read-only unless mutation is authorized.
- Do not commit/push without authorization in that saved context.

These constraints are historical/project-contextual and may be superseded by explicit instructions in a later conversation.

## Backup boundary

This snapshot intentionally excludes:
- passwords, tokens, API keys and account IDs;
- hidden chain-of-thought/model reasoning;
- OpenAI internal databases or inaccessible memory state;
- sensitive personal information retrieved incidentally from connected services.

It captures the user/project context ChatGPT could surface at the time of backup and is intended as a portable recovery/reference document.

## Additional recovered memories — pass 2

These details were recovered in a second memory pass and were not fully represented in the first snapshot.

### ClewCode — deeper implementation details
- Preferred canonical name is **ClewCode**; stale naming such as `MooCode` should not be used.
- Remembered Sep 2, 2026 main HEAD: `00b1b7e4`.
- Hybrid project memory lives under `.clew/memory/` with `MEMORY.md`, `DECISIONS.md`, `checkpoint.md`, `notes.md`, `tasks/`, plus `memory.db`.
- SQLite memory schema/features remembered: `memories`, `memory_keys`, `memory_timeline`, importance, confidence, access tracking, dedup/reinforcement, and timeline.
- `BudgetInjector` projects MEMORY/DECISIONS/TASTE plus SQLite memories into context, with remembered ranking `importance*0.5 + confidence*0.3 + recency*0.2`, using roughly 5% of context budget and a cap around 4000 tokens.
- Memory hardening direction: add provenance (`stated|observed|inferred`), source ownership (`user|assistant|tool|web|connector|system`), default no-save for re-queryable web/GitHub/tool output, read-before-ask, explicit supersedes/supersededBy links, and a consolidation gate. Do not unnecessarily rebuild MemoryDB/BudgetInjector or switch the design back to filesystem-only memory.
- Terminal UI remembered as Ink/React. Commands include `/model`, `/provider-select`, `/mcp`, `/mesh`, `/loop`, `/daemon`, `/task`.
- Supports stdio/SSE/in-process MCP, LAN mesh, process-backed workers, and project memory.
- Development workflow remembered: Bun, Vitest, `bun x tsc --noEmit`, Biome lint/format, generated docs, `codegraph`, relay, command registration under `src/commands/`, provider registration under `src/services/ai/`.

### Persistent intelligent loop design
- Preferred loop architecture: local durable supervisor + SQLite WAL/control state + isolated per-iteration agent context.
- Optional worktrees and remote adapters; event adapters, adaptive backoff, budgets, dedupe, verification, and explicit goal termination.
- Supervisor owns scheduler persistence and validates model requests to reschedule/stop/pause; the agent should not mutate durable scheduler state directly.

### Conus — recovered specifics
- Conus had a full Rust local-first agent-runtime specification remembered as approximately 3,092 lines.
- At the remembered starting point, the public `main` contained only README/initial commit and implementation work had not yet landed.
- Canonical executables: `conus` and `conusd`.
- Runtime choice: Tokio tasks/channels rather than a formal actor framework.
- Persistence choice: transactional SQLite writes, ordered event append, idempotency identifiers, typed error classes, durable approval states, resource budgets, secret redaction, localhost-default daemon binding.
- Initial implementation was intended to rely on GitHub App/CI when the execution environment lacked local `gh`, `rustc`, and `cargo`.

### mcp-agent-hub migration
- Project/direction: `mcp-agent-hub/`, a TypeScript rewrite/migration from `bus-agent v2.4`.
- Core protocol: JSON-RPC 2.0; MCP treated as an adapter rather than the core domain model.
- SQLite is the source of truth; FTS5 belongs in core; embeddings/vector memory should be a plugin.
- Child-process execution should be asynchronous rather than `execSync`-style blocking execution.

### AgentWorld roadmap
- Separate remembered experimental direction using Godot 4.x + Python/SQLite.
- Roadmap included bot teams, memory/skills, MCP, Git worktree isolation, leases, checkpoints/resume/recovery, Godot automation, verifier/metrics/replay, and a persistent world with inbox/scheduler/offline tasks.

### Additional repo lineage / experiments
- `saka` appears in older project lineage as a naming/correction branch/context.
- Additional remembered repos/experiments: `Roblox-101`, `AK47ScalperEA`, and `ptt_ws_tpa`.
- `AK47ScalperEA` was also tracked in a local MetaTrader 5 Experts directory; the exact terminal-instance path is intentionally omitted from this portable snapshot.
- Clew setup at one point used MCP servers `playwright` and `codegraph`, plus TypeScript and Pyright LSP plugins.

### Workflow detail
- The user has used a separate Work-mode chat for read-only inspection of local shell/terminal processes.

No sensitive account recovery details, email addresses, authentication state, passwords, tokens, or connected-account security information from the retrieval pass were added to this backup.

## Full recovery pass — pass 3

A broader retrieval pass was completed across available personal/project context. Additional details were recovered and normalized into separate files to avoid bloating or losing structure:

- `PROJECTS.md` — detailed repositories, paths, releases, commits, tests, architecture and project history.
- `TIMELINE.md` — chronological June–September 2026 project/architecture milestones.
- `TECHNICAL_NOTES.md` — working preferences, persistent-loop safeguards, memory/runtime caveats, CI/infrastructure and operating patterns.

Major new recovered details include Loom v1.0.0 merge/tag/PR metadata; ChatGPTMCP persistent Jupyter runtime versions and session practice; additional Clew version history/tool counts/audit counts; persistent-agent state machine and verification rules; Oracle version discrepancy; local-AI/Hermes exploration; and CI/tunnel workflow details.

The recovery pass also encountered connected-account/promotional/security-related context. Those items were deliberately excluded because this backup is meant to preserve useful ChatGPT project/personal-working context, not credentials, account-recovery data, private communications, or unrelated sensitive information.

## Final catch-all recovery — pass 4

Final non-sensitive catch-all retrieval found a small set of remaining items: `cargo-agentbench` V1, Oracle v0.1.0 Node/TypeScript package context, detailed engineering-collaborator interaction policy, Clew extension conventions, and the TypeScript/Bun/Zod/Vitest + Rust/Lua/MQL5 technical stack. These were added to `PROJECTS.md` and `TECHNICAL_NOTES.md`.
