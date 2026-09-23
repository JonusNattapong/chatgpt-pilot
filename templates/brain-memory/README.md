# Shared Brain Memory Template

A Git-friendly, Markdown-backed persistent memory layout shared by coding agents.

Supported consumers:

- Codex: reads `AGENTS.md`
- OpenCode: reads `AGENTS.md`
- Claude Code: `CLAUDE.md` imports `AGENTS.md`
- Gemini Antigravity: `.agents/rules/brain-memory.md` imports `AGENTS.md`

## Install into a repository

Copy this template's contents into the target repository root.

If the target already has an `AGENTS.md`, do **not** replace it. Merge the **Brain Memory** section from this template into the existing file and keep the repository's existing instructions.

Likewise, preserve existing `CLAUDE.md` and Antigravity rules. Add the bridge/import only when it is missing.

## Source of truth

`AGENTS.md` is the shared behavioral router.

`docs/BRAIN_MEMORY.md` defines memory architecture and lifecycle semantics.

`memory/` contains the actual persistent memory data.

The architecture spec is not itself the memory store.

## Loading model

Agents should load memory progressively:

```text
task
  -> memory/INDEX.md
  -> relevant project/topic files
  -> relevant decisions
  -> recent summary when useful
```

Do not preload the whole memory tree.

## Writing model

New observations normally enter Sub Memory first:

```text
event
  -> sub memory
  -> consolidation
  -> project/decision memory
  -> MAIN.md when globally important
```

Only persist information that has value beyond the current session.

## Future phases

Phase 1 is intentionally plain Markdown.

Future implementations may add a CLI/library and then an MCP service with search, recall, linking, consolidation, and structured persistence. Markdown should remain usable as an inspectable bootstrap/export format.
