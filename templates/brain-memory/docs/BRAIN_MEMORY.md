# Brain Memory Architecture

## Purpose

Brain Memory is a shared persistent-memory convention for coding agents working on the same repository.

This file is the **system specification**. It defines how memory should be organized, loaded, written, consolidated, promoted, superseded, and archived.

It is not the memory store itself.

## Goals

- one memory source shared across multiple agents
- Git-diffable and human-readable state
- progressive context loading
- low dependency surface for Phase 1
- explicit handling of conflicts and superseded facts
- a clean migration path to CLI/library and MCP-backed implementations

## Non-goals

Phase 1 does not attempt to provide:

- semantic vector retrieval
- autonomous fact extraction from every message
- opaque model-specific memory databases
- hidden per-agent copies of repository memory
- automatic persistence of secrets or personal data

## Memory Layers

### Working Memory

Short-lived context held by the active agent/session.

Working Memory is not durable by default.

### Sub Memory

Append-oriented observations that may matter later but have not yet earned promotion.

Typical location:

`memory/sub/YYYY-MM-DD.md`

Sub Memory may contain implementation milestones, research outcomes, blockers, experiments, or newly discovered facts.

### Summaries

Compressed views over recent Sub Memory.

Typical location:

`memory/summaries/current.md`

Summaries reduce replay cost but are not authoritative when they conflict with a more specific current project or decision file.

### Project Memory

Current, durable project context.

Typical location:

`memory/projects/<project>.md`

Project Memory should answer: what is this project doing now, what matters, what is blocked, and what stable constraints or decisions shape current work?

### Decision Memory

Durable decision records.

Typical location:

`memory/decisions/<decision>.md`

A decision record should preserve why a choice was made and whether it is still active.

### Main Memory

Small cross-project memory containing only globally important, repeatedly useful facts.

Typical location:

`memory/MAIN.md`

Main Memory should remain intentionally compact.

### Archive

Historical memory no longer required for routine recall.

Typical location:

`memory/archive/`

Archived memory remains inspectable but should not be loaded unless a task needs historical context.

## Lifecycle

```text
Working Memory
      |
      v
  Sub Memory
      |
      v
 Consolidation
    /      \
   v        v
Project  Decision
Memory   Memory
    \      /
     v    v
   Main Memory
       |
       v
     Recall
       |
       v
Reinforcement / Decay / Archive
```

## Promotion

Promote an observation when one or more of these are true:

- it has been explicitly confirmed
- it is an accepted implementation or architecture decision
- it is repeatedly useful across sessions
- it changes current project state materially
- future work would likely fail or repeat effort without it

Do not promote:

- speculative guesses
- temporary logs
- intermediate debugging attempts
- one-off command output
- information already represented accurately elsewhere

## Recall

Recall is progressive.

Default path:

```text
prompt
  -> memory/INDEX.md
  -> relevant project memory
  -> relevant decision memory
  -> current summary if useful
  -> Sub Memory/history only when needed
```

The index is a router, not a summary dump.

## Consolidation

Consolidation transforms noisy observations into durable state.

During consolidation:

1. group related observations
2. discard duplicate or temporary noise
3. separate facts from hypotheses
4. identify decisions and blockers
5. update the smallest authoritative memory file
6. preserve useful historical context when superseding older information
7. update the index only when routing metadata changed

## Reinforcement and Decay

Frequently reused facts may remain in active project or Main Memory.

Stale details should decay out of active memory when:

- they no longer affect current work
- a newer decision supersedes them
- the project becomes inactive
- they are detailed history better suited to archive

Decay means moving information out of default recall paths, not destroying useful history.

## Conflict Handling

Memory conflicts must be explicit.

Recommended states:

- `current`
- `superseded`
- `proposed`
- `rejected`
- `unknown`

Never resolve conflicts by silently overwriting a previous durable fact.

## Security

Never store credentials, private keys, authentication tokens, passwords, or other secrets in repository memory.

Avoid personal or sensitive information unless the repository genuinely requires it and the storage is appropriate for that data.

## Multi-Agent Integration

The shared source of truth is `AGENTS.md`.

Agent-specific files should act as thin bridges:

- Codex -> `AGENTS.md`
- OpenCode -> `AGENTS.md`
- Claude Code -> `CLAUDE.md` -> `@AGENTS.md`
- Gemini Antigravity -> `.agents/rules/brain-memory.md` -> `@../../AGENTS.md`

Do not fork the memory policy separately for each agent.

## Future MCP Model

A later Brain Memory MCP may expose tools such as:

- `memory_recall`
- `memory_remember`
- `memory_search`
- `memory_link`
- `memory_update`
- `memory_forget`
- `memory_consolidate`
- `memory_get_project`
- `memory_get_recent`

The MCP implementation should preserve the same conceptual lifecycle and provide Markdown import/export so the repository remains inspectable without the service.
