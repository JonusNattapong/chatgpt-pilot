# chatgpt-skills (138 ทักษะ)

Sources:
- https://github.com/sickn33/agentic-awesome-skills — 30 curated skills: Cloud & Infrastructure (8), Mobile (7), Data & ML (7), Security & Auditing (8) (2026-09-06)
- https://github.com/mattpocock/skills (cloned 2026-09-03, depth 1)
- https://github.com/blader/humanizer (cloned 2026-09-03, depth 1)
- https://github.com/obra/superpowers — skills/ ครบทั้ง 14 ทักษะ (2026-09-03; frontmatter ผ่านครบทั้ง 14 รายการ ไม่ต้องแก้)
- https://github.com/Digidai/product-manager-skills — SKILL.md + knowledge/ + templates/ + examples/ + bin/ (2026-09-03; ปรับแล้ว: ย้าย `type` ไปไว้ใน metadata)
- https://github.com/mvanhorn/last30days-skill — skills/last30days (2026-09-03; ปรับแล้ว: ย้าย `version`/`argument-hint`/`homepage`/`repository`/`author`/`user-invocable` ไปไว้ใน metadata และตัด `assets/` ขนาด 14 MB กับ dev scripts ตาม `.skillignore`)
- https://github.com/CloudAI-X/threejs-skills — skills/ 10 ทักษะ (2026-09-03; SKILL.md เดี่ยว, frontmatter ผ่านครบทั้ง 10 รายการ ไม่ต้องแก้)
- https://github.com/ChromeDevTools/chrome-devtools-mcp — skills/ 7 ทักษะ (2026-09-03; frontmatter ผ่านครบทั้ง 7 รายการ ไม่ต้องแก้)
- https://github.com/freestylefly/awesome-gpt-image-2 — agents/skills/gpt-image-2-style-library (2026-09-03; frontmatter ผ่านแล้ว ไม่ต้องแก้)
- https://github.com/langchain-ai/deepagents — libs/code/examples/skills/skill-creator (2026-09-03, sparse)
- https://github.com/PracticalSwan/agent-skills — frontend-design (2026-09-03, sparse)
- https://github.com/iuliandita/skills — skills/databases (2026-09-03, sparse)
- https://github.com/magnus919/agent-skills — qa-methodology, playwright, platform-engineering, adr-authoring (2026-09-03, sparse)
- https://github.com/tomzx/agents — skills/create-observability (2026-09-03, sparse)
- https://github.com/JPeetz/agent-skills — skills/documentation-content/technical-documentation (2026-09-03, sparse)
- https://github.com/tt-a1i/archify — archify/ (2026-09-03, sparse)
- https://github.com/Leonxlnx/taste-skill — skills/ ครบทั้ง 13 ทักษะ (2026-09-03)
- https://github.com/Imbad0202/academic-research-skills — academic-paper, academic-paper-reviewer, academic-pipeline, deep-research (2026-09-03)
- https://github.com/coreyhaines31/marketingskills — skills/ 31 ทักษะตามรายการด้านล่าง (2026-09-03, sparse; frontmatter ผ่านครบทั้ง 31 รายการ ไม่ต้องแก้)

## โครงสร้างไฟล์
- `chatgpt-skills/<skill-name>/` = โฟลเดอร์เต็มของแต่ละ skill (`SKILL.md` + `references/` + `agents/`)
- `chatgpt-skills/zips/<skill-name>.zip` = ZIP สำหรับอัปโหลดทีละ skill ที่ `chatgpt.com/skills`
  - แต่ละ ZIP ต้องมี **โฟลเดอร์ชื่อเดียวกับ skill** ครอบอยู่ (`<skill-name>/SKILL.md`) ตามสเปก อย่า zip เฉพาะไฟล์ด้านในโดยไม่มีโฟลเดอร์หลัก

## รายการทักษะ
1. setup-matt-pocock-skills
2. domain-modeling
3. codebase-design
4. research
5. grilling (ต้นทาง: skills/productivity/grilling — ตัวอื่นเรียกใช้)
6. grill-with-docs
7. to-spec
8. to-tickets
9. tdd
10. diagnosing-bugs
11. implement
12. code-review
13. improve-codebase-architecture
14. humanizer (blader — ปรับข้อความให้เป็นธรรมชาติมากขึ้น ใช้งานเดี่ยวได้)
15. verification-before-completion (obra/superpowers — บังคับให้มีหลักฐานก่อนสรุปว่างานเสร็จ)
16. skill-builder (ต้นทาง deepagents skill-creator — เปลี่ยนชื่อเพราะ `skill-creator` เป็นชื่อที่ ChatGPT สงวนไว้; มี scripts/init_skill.py + quick_validate.py)
17. resolving-merge-conflicts (mattpocock — เข้าชุดเดิม)
18. prototype (mattpocock — prototype แบบใช้ทดสอบแนวคิด เพื่อพิสูจน์ design/state/UI ก่อนทำจริง)
19. frontend-design (PracticalSwan — UI/UX, accessibility, responsive; ปรับ frontmatter แล้ว: ย้าย `version`/`last_updated`/`tags` ไปไว้ใน metadata)
20. databases (iuliandita — Postgres/Mongo/MySQL/MSSQL, migration, EXPLAIN)
21. qa-methodology (magnus919 — test strategy, regression, quality gates, CI triage)
22. playwright (magnus919 — E2E, selectors, network mocking; ปรับ `->` เป็น `→` ใน description)
23. create-observability (tomzx — ออกแบบ logs/metrics/traces/alerts ตั้งแต่ระดับ feature; ปรับแล้ว: ย้าย `argument-hint` ไปไว้ใน metadata)
24. platform-engineering (magnus919 — Docker/K8s/Terraform/telemetry/Grafana/release)
25. technical-documentation (JPeetz — README/ADR/API docs/runbook; ปรับแล้ว: ย้าย `version`/`author`/`platforms`/`tags`/`geo` ไปไว้ใน metadata)
26. adr-authoring (magnus919 — ADR lifecycle)
27. archify (tt-a1i — architecture/workflow/sequence/data-flow/lifecycle diagrams เป็น HTML+SVG standalone; ~1.5MB zip, frontmatter ผ่านแล้ว ไม่ต้องแก้)
28. design-taste-frontend (Leonxlnx/taste-skill ตัวหลัก — เปลี่ยนชื่อโฟลเดอร์จาก `taste-skill` ให้ตรงกับค่า `name` ใน frontmatter)
29. design-taste-frontend-v1 (รุ่น v1 — ชื่อเดิม taste-skill-v1)
30. brandkit (ใช้ชื่อเดิม)
31. industrial-brutalist-ui (ชื่อเดิม brutalist-skill)
32. gpt-taste (ชื่อเดิม gpt-tasteskill)
33. image-to-code (ชื่อเดิม image-to-code-skill)
34. imagegen-frontend-web (ใช้ชื่อเดิม)
35. imagegen-frontend-mobile (ใช้ชื่อเดิม)
36. minimalist-ui (ชื่อเดิม minimalist-skill)
37. high-end-visual-design (ชื่อเดิม soft-skill)
38. redesign-existing-projects (ชื่อเดิม redesign-skill)
39. stitch-design-taste (ชื่อเดิม stitch-skill, มี DESIGN.md ประกอบ)
40. full-output-enforcement (ชื่อเดิม output-skill)
41. deep-research (Imbad0202 — systematic review, source verification, meta-analysis; 53 ไฟล์)
42. academic-paper (เขียนงานวิชาการตามโครง IMRaD/APA7; 63 ไฟล์)
43. academic-paper-reviewer (peer review 2-stage; 28 ไฟล์)
44. academic-pipeline (orchestrator 10 ขั้นตอนที่ประสาน 3 skill ด้านบน; ปรับ `->` เป็น `→` ใน description)
45-75. Marketing Skills by Corey Haines (31 ทักษะ, `product-marketing` เป็น foundation ที่ตัวอื่นอ่านก่อน):
ab-testing, ad-creative, ai-seo, analytics, churn-prevention, cold-email, competitors,
content-strategy, copy-editing, copywriting, emails, free-tools, launch, marketing-ideas,
marketing-psychology, onboarding, cro, ads, paywalls, popups, pricing, product-marketing,
programmatic-seo, referrals, revops, sales-enablement, schema, seo-audit, signup,
site-architecture, social
76-88. obra/superpowers ที่เหลืออีก 13 ทักษะ (ตัวที่ 14 คือ verification-before-completion มีอยู่แล้ว):
brainstorming, dispatching-parallel-agents, executing-plans, finishing-a-development-branch,
receiving-code-review, requesting-code-review, subagent-driven-development, systematic-debugging,
test-driven-development, using-git-worktrees, using-superpowers, writing-plans, writing-skills
89. product-manager-skills (Digidai — SaaS metrics, PRD review, roadmap, discovery, PLG; 30 ไฟล์)
90. last30days (mvanhorn — social listening 30 วัน Reddit/X/YouTube/TikTok/HN; 121 ไฟล์, ~800KB zip)
91-100. CloudAI-X/threejs-skills (10 ทักษะ, SKILL.md เดี่ยว):
threejs-fundamentals, threejs-geometry, threejs-materials, threejs-textures, threejs-lighting,
threejs-animation, threejs-interaction, threejs-loaders, threejs-shaders, threejs-postprocessing
101-107. ChromeDevTools/chrome-devtools-mcp (7 ทักษะ):
chrome-devtools, chrome-devtools-cli, a11y-debugging, cookie-debugging, debug-optimize-lcp,
memory-leak-debugging, troubleshooting
108. gpt-image-2-style-library (freestylefly — GPT-Image2 style library + prompt templates; 6 ไฟล์)
109-116. Cloud & Infrastructure (sickn33/agentic-awesome-skills — 8 ทักษะ):
docker-expert, kubernetes-architect, terraform-specialist, cloud-architect,
aws-skills, gcp-cloud-run, helm-chart-scaffolding, gitops-workflow
117-123. Mobile Development (sickn33/agentic-awesome-skills — 7 ทักษะ):
react-native-skills, react-native-architecture, flutter-expert, ios-developer,
android-dev, expo-dev-client, expo-deployment
124-130. Data Engineering & Machine Learning (sickn33/agentic-awesome-skills — 7 ทักษะ):
data-engineer, data-engineering-data-pipeline, dbt-transformation-patterns,
ml-engineer, machine-learning-ops-ml-pipeline, hugging-face-model-trainer, hugging-face-datasets
131-138. Security & Penetration Testing (sickn33/agentic-awesome-skills — 8 ทักษะ):
security-auditor, api-security-testing, threat-modeling-expert, container-security-hardening,
pentest-checklist, sqlmap-database-pentesting, idor-testing, database-security

## ลำดับการติดตั้งที่แนะนำ
```text
setup-matt-pocock-skills
domain-modeling, codebase-design, research
grilling, grill-with-docs
to-spec, to-tickets
tdd, diagnosing-bugs, implement
code-review, improve-codebase-architecture
```

## หมายเหตุ
- `grill-with-docs`, `implement` เป็น stub ที่ส่งต่อการทำงานไปยัง skill อื่น (เช่น grilling + domain-modeling) — จึงต้องติดตั้ง skill ที่เกี่ยวข้องร่วมกันจึงจะทำงานได้ครบ
- รัน `setup-matt-pocock-skills` หนึ่งครั้งต่อ repo ก่อนใช้ skill อื่น (เพื่อตั้งค่า issue tracker, labels และตำแหน่งเอกสาร)