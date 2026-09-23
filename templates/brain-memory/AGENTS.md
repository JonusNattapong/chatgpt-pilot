# Agent Instructions

## Brain Memory

This repository uses a shared persistent memory system.

Memory architecture and lifecycle semantics are defined in:

- `docs/BRAIN_MEMORY.md`

Current persistent memory is stored under:

- `memory/INDEX.md`
- `memory/MAIN.md`
- `memory/projects/`
- `memory/decisions/`
- `memory/sub/`
- `memory/summaries/`
- `memory/archive/`

### Memory Loading

Do not load the entire memory directory by default. Load memory progressively.

For normal tasks:

1. Read `memory/INDEX.md`.
2. Determine which project, topic, or decision is relevant.
3. Read only the relevant memory files.
4. Read `memory/summaries/current.md` when recent cross-topic context is useful.
5. Read `docs/BRAIN_MEMORY.md` only when changing or reasoning about the memory system itself.

Prefer the smallest context set that can answer the task correctly.

### Memory Writing

Persist only information useful beyond the current session.

Good candidates include:

- architecture decisions
- stable project state
- important discoveries
- implementation decisions
- unresolved blockers
- reusable procedures
- stable project facts

Do not persist:

- temporary debugging noise
- guesses presented as facts
- generated filler
- credentials
- API keys
- tokens
- passwords
- personal or sensitive information

### Memory Lifecycle

New observations should normally enter Sub Memory first.

```text
event
  -> sub memory
  -> consolidation
  -> project/decision memory
  -> main memory
```

Promote information only when it is stable, repeatedly relevant, explicitly confirmed, an important decision, or necessary for future work.

### Conflicting Memory

Never silently overwrite conflicting information.

When new information supersedes old information:

- preserve the previous value when historically useful
- mark the old value as superseded
- record the new current value
- include date/source context when useful
- do not merge uncertainty into a false single fact

### Project Memory

Project-specific current context belongs in:

`memory/projects/<project>.md`

Keep project files concise and current. Move detailed historical events into Sub Memory or the archive.

### Decision Memory

Important decisions belong in:

`memory/decisions/`

A durable decision should record:

- decision
- reason
- date
- status
- affected components
- superseded decision, when applicable

### Session Completion

Before finishing substantial work:

1. determine whether durable project state, a decision, blocker, or reusable discovery changed
2. write new observations to Sub Memory when they are not yet stable
3. update the relevant project or decision memory when promotion criteria are met
4. update `memory/INDEX.md` if memory files were added, moved, or retired
5. refresh `memory/summaries/current.md` only when the current cross-project summary materially changed
6. avoid duplicating information already represented accurately elsewhere

Memory maintenance is part of completion only when something worth remembering actually changed.
