# @chatgpt-pilot/skill-hub — Dynamic Skills Engine

Skill Hub indexes and routes curated agent procedures from the repository `skills/` directory. The current registry contains 139 skills.

---

## Key Features

- **139 Indexed Skills**: Broad coverage across engineering, infrastructure, testing, security, data, product, and documentation workflows.
- **On-Demand Reading**: Catalog metadata stays compact; full `SKILL.md` content is loaded only when requested.
- **Task Routing & Composition**: Resolve and rank skills for natural-language tasks, then compose a bounded 1–4 skill pipeline.
- **Local Outcome Telemetry**: Aggregate success/partial/failure counts without storing prompts or task content.
- **Zero-Config Discovery**: Automatically discovers the root `skills/` directory inside ChatGPT Pilot.

---

## MCP Tools

| Tool | Purpose |
|---|---|
| `skills_skill_list` | List installed skills with pagination. |
| `skills_skill_search` | Search the catalog by name and description. |
| `skills_skill_resolve` | Rank and deduplicate relevant skills for a task. |
| `skills_skill_route` | Classify a task into skill families and ranked candidates. |
| `skills_skill_compose` | Build an ordered 1–4 skill pipeline while avoiding duplicate groups. |
| `skills_skill_feedback` | Record aggregate local outcome telemetry. |
| `skills_skill_insights` | Report taxonomy coverage, duplicate groups, and aggregate telemetry. |
| `skills_skill_read` | Read `SKILL.md` or another text file sandboxed to a selected skill. |
| `skills_skill_sync` | Rescan the configured skills source and refresh the registry. |
| `skills_skill_stats` | Report registry health, roots, count, and last sync time. |
