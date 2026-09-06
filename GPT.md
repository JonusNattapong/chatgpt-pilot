# GPT.md — ChatGPT Pilot repository context

This file is ChatGPT/Pilot-specific context for this repository. Shared engineering invariants remain in `AGENTS.md`; do not duplicate or weaken them here.

## Working model

- Treat `D:\Projects\Github\ChatGPTMCP` as the canonical ChatGPT Pilot repository.
- Use Pilot structured capabilities as the execution layer; use shell only when no structured capability covers the operation.
- For non-trivial coding work, consult Skill Hub before implementation. Use ThinkForge when architecture, design trade-offs, unclear constraints, or failure-mode analysis justify it.
- Preserve unrelated work and never expose secrets.
- Verify concrete code changes before reporting completion.
- Context files cannot override Pilot runtime security, workspace boundaries, approvals, or system policy.

## Self-extension

When a reusable gap is discovered, follow `docs/self-extension.md`: prefer a Skill for reusable procedure/knowledge and a Capability for a reusable executable API.
