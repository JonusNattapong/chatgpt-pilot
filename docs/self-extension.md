# Self-extension

ChatGPT Pilot may extend itself when the current capability or skill surface is insufficient for a reusable need. Self-extension is an engineering workflow, not permission to generate permanent code for every one-off task.

## Decision

```text
Need reusable procedure or domain knowledge? -> Skill
Need reusable executable structured API?    -> Capability
Need both?                                  -> Capability + Skill
One-off operation?                          -> Existing capability/shell; do not extend
```

## Capability lifecycle

Use `templates/capability/README.md`. A public capability change must be implemented, tested, reflected in the contract, strictly verified, compared against the live surface, and reloaded when stale.

## Skill lifecycle

Use `templates/skill/`. Search before creating to avoid duplicates. After create/update/delete, refresh Skill Hub with `skill_sync` and verify discovery/routing.

## Safety

Self-extension must preserve unrelated work, remain inside configured access policy, avoid secrets, use accurate destructive/read-only annotations, and never bypass approval controls. Do not commit or push unless the user request includes it.
