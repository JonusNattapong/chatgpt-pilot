---
name: example-skill
description: Describe the concrete tasks that should route to this skill and when it should be used.
metadata:
  version: 0.1.0
  author: ChatGPT Pilot
---

# Example Skill

## Purpose

State the reusable procedure, judgment, or domain knowledge this skill adds.

## When to use

- Use when ...
- Do not use when a dedicated executable capability is required instead.

## Workflow

1. Inspect the relevant state and constraints.
2. Perform the smallest safe sequence of actions.
3. Verify the result with concrete evidence.
4. Report the outcome and any remaining blocker.

## Guardrails

- Preserve unrelated local changes.
- Never expose secrets.
- Prefer structured Pilot capabilities over raw shell commands.
- Do not claim completion without verification.

## References

Add files under `references/` only when the skill needs durable supporting material.
