---
name: converge-loop
description: Use when the user wants multi-agent deliberation, constructive pushback, debate, negotiation, or convergence on a plan, design, decision, artifact, or ambiguous topic.
---

# converge-loop

Use this skill when the user wants agents to reason together before execution or final validation.

`converge-loop` is a subject-agnostic deliberation engine: callers provide the topic, focus, context, and artifacts; the engine only facilitates debate, evidence exchange, and convergence. Use it the same way for architecture designs, product tradeoffs, quick either/or decisions, or any artifact worth pressure-testing — all subject detail travels through `--topic`, `--focus`, `--context`, and `--artifact`.

`converge-loop` is for deliberation, not gate validation. Keep it separate from `review-loop`:

- Use `converge-loop` when the work is still fluid and would benefit from pushback, better ideas, negotiated tradeoffs, or explicit unresolved disagreement.
- Use `review-loop` when the work is ready to be independently checked for blockers before handoff, finalization, or merge.

The plugin includes a Node.js command runtime. From Codex, invoke it with the Codex host identity:

```bash
CONVERGE_LOOP_HOST=codex node "<skill-root>/../../scripts/bin/converge-loop.mjs" setup
CONVERGE_LOOP_HOST=codex node "<skill-root>/../../scripts/bin/converge-loop.mjs" run --topic "Decide the retention default for exported sessions"
```

From the plugin source, invoke the same runtime directly:

```bash
CONVERGE_LOOP_HOST=codex node scripts/bin/converge-loop.mjs setup
CONVERGE_LOOP_HOST=codex node scripts/bin/converge-loop.mjs run --topic "Decide the retention default for exported sessions"
```

Default participant selection should mirror `review-loop`:

- In Codex, use Codex as the primary participant and Claude Code as the secondary participant.
- In Claude Code, use Claude Code as the primary participant and Codex as the secondary participant.
- If the secondary opposite-agent path is unavailable, use the primary agent's restricted sub-agent fallback only as degraded coverage and disclose that degradation.

The Codex skill owns `CONVERGE_LOOP_HOST=codex`; users should not need to set host identity manually. The Claude command surface uses `CLAUDE_PLUGIN_ROOT` and lets the runtime infer `claude`.

Run `converge-loop setup` before real local-agent deliberation. Setup verifies local `codex` and `claude` CLIs, required read-only flag availability, and non-model auth status, then writes readiness config. Normal users should not need to set local-adapter environment variables.

Use `converge-loop setup --check-only` for diagnostics without config mutation or model calls. Use `converge-loop setup --disable` to turn off config-backed local adapters. Use `converge-loop setup --smoke` only when the operator wants a real tiny Codex + Claude adapter exchange and accepts that it may spend model calls.

Do not pass fake adapters for normal user-facing deliberation. `fake-sequence`, `fake-replay`, and `fake-tooling` are deterministic verification adapters only; results from them must be described as smoke/test coverage, not independent provider deliberation.

If the real opposite-agent path is not enabled yet and the operator only wants to verify installation, run with `--fake-adapters fake-sequence,fake-sequence` explicitly and disclose that it is fake-adapter smoke coverage; the flag refuses real adapters, so it can never stand in for real deliberation. There is no flag for arbitrary participant lists; the operator surface is the host primary plus `--counterpart codex|claude`.

Normal deliberation runs complete at least 4 participant turns before agreement or no-progress, with a default cap of `--max-turns 8`. Use the extra turns to pressure-test the strongest remaining assumption, evidence gap, risk, or alternative without manufacturing disagreement. For broad topics, narrow `--topic` or `--focus` first; raise `--max-turns` only when the same session needs several material issues, evidence exchange, or multiple negotiation rounds.

When helping evolve this plugin:

1. Treat `docs/design-plan.md` as the canonical product plan.
2. Preserve the rule that both active participants see the same scope and have the same read-only access.
3. Prefer the host/opposite default pairing (Codex with Claude Code, Claude Code with Codex), with primary sub-agent fallback clearly marked as degraded coverage.
4. Do not force disagreement. Encourage constructive pushback, better ideas, evidence requests, and convergence.
5. Keep human intervention optional unless the operator opts in or interrupts.
6. Do not add implementation, file edits, or review-gate semantics to `converge-loop`; downstream action belongs to the host agent and deterministic validation belongs to `review-loop`.
7. Prefer deterministic fake adapters for local verification. Real provider adapters are fail-closed until `converge-loop setup` verifies read-only controls and auth status.

For the current design, read:

```bash
docs/design-plan.md
```
