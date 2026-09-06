# Skill Template

Use a Skill when Pilot needs reusable knowledge, procedure, or decision guidance rather than a new executable API.

## Create

1. Search Skill Hub first; do not duplicate an existing skill.
2. Copy `SKILL.md` into `skills/<skill-name>/SKILL.md`.
3. Use a lowercase kebab-case name and a routing-oriented description.
4. Keep the core workflow in `SKILL.md`; put large supporting material in `references/`.
5. Add `evals/` or tests when the workflow has behavior that can regress.
6. Run `skill_sync`, then confirm with `skill_search`/`skill_resolve` and `skill_read`.

## Update

- Preserve the skill's routing intent unless intentionally changing it.
- Update metadata version when behavior materially changes.
- Re-sync and verify that routing still selects the skill for representative tasks.

## Delete

- Search for references to the skill name.
- Remove the skill directory only when no required references remain.
- Run `skill_sync` and confirm it no longer appears in `skill_search`/`skill_list`.

## Decision rule

- Reusable procedure/knowledge -> Skill.
- Reusable executable structured API -> Capability.
- Both are needed -> Capability + Skill.
