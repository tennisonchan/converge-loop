---
name: converge-loop
description: Use when the user wants multi-agent deliberation, constructive pushback, debate, negotiation, or convergence on a plan, design, decision, artifact, or ambiguous topic.
---

# converge-loop

Use this skill when the user wants agents to reason together before execution or final validation.

`converge-loop` is for deliberation, not gate validation. Keep it separate from `review-loop`:

- Use `converge-loop` when the work is still fluid and would benefit from pushback, better ideas, negotiated tradeoffs, or explicit unresolved disagreement.
- Use `review-loop` when the work is ready to be independently checked for blockers before handoff, finalization, or merge.

The plugin includes a Node.js command runtime. Invoke it through the package bin when installed or directly from the plugin source:

```bash
node scripts/bin/converge-loop.mjs run --agents fake-sequence,fake-sequence --topic "Improve this plan"
```

When helping evolve this plugin:

1. Treat `docs/design-plan.md` as the canonical product plan.
2. Preserve the rule that both active participants see the same scope and have the same read-only access.
3. Prefer different providers for the two active participants, with primary sub-agent fallback clearly marked as degraded coverage.
4. Do not force disagreement. Encourage constructive pushback, better ideas, evidence requests, and convergence.
5. Keep human intervention optional unless the operator opts in or interrupts.
6. Do not add implementation, file edits, or review-gate semantics to `converge-loop`; downstream action belongs to the host agent and deterministic validation belongs to `review-loop`.
7. Prefer deterministic fake adapters for local verification. Real provider adapters are fail-closed unless read-only preflight checks prove safe execution.

For the current design, read:

```bash
docs/design-plan.md
```
