# @chatgpt-pilot/thinkforge — Cognitive Accelerators

ThinkForge provides structured problem analysis, unconventional reframing, mechanism generation, adversarial critique, synthesis, and falsifiable experiment design for AI agents.

---

## MCP Tools

| Tool | Purpose |
|---|---|
| `think_analyze_problem` | Model assumptions, constraints, stakeholders, and unknowns before ideation. |
| `think_reframe_problem` | Reframe a problem through inversion, first principles, analogy, biomimicry, and other methods. |
| `think_think_reverse` | Deliberately design failure, then invert the failure mechanisms into principles. |
| `think_cross_domain_analogy` | Transfer structural principles from unrelated domains and state where each analogy breaks. |
| `think_bio_inspire` | Apply biomimicry patterns such as symbiosis, swarms, immune systems, and homeostasis. |
| `think_indirect_strategy` | Find leverage points and reshape defaults, incentives, dependencies, or terrain. |
| `think_break_constraints` | Remove, invert, or tighten constraints to expose hidden solution principles. |
| `think_idea_collision` | Combine unrelated operating models into a falsifiable hybrid mechanism. |
| `think_generate_mechanisms` | Generate mechanism-level alternatives, control flow, tradeoffs, and falsification tests. |
| `think_challenge_idea` | Challenge assumptions, failure modes, second-order effects, evidence needs, and kill criteria. |
| `think_synthesize_ideas` | Synthesize competing ideas while preserving conflicts, assumptions, and rejected parts. |
| `think_experiment_design` | Turn an idea into a bounded, reversible falsification experiment. |
| `think_unconventional_solve` | Orchestrate analysis, reframing, mechanisms, scoring, critique, synthesis, and experiment design. |

---

## Usage in ChatGPT Pilot

ThinkForge is registered automatically as the `think` provider and exposed with the `think_` namespace through the Hybrid capability runtime. Run the repository verification pipeline after changing schemas or behavior:

```bash
pnpm verify
```
