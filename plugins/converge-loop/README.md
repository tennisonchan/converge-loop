# converge-loop

`converge-loop` is a local plugin for multi-agent deliberation, installable from Codex and Claude Code.

Like `review-loop`, it is a subject-agnostic facilitation engine: callers provide the topic, focus, context, and artifacts; higher-level agents decide what to deliberate and what the conclusion feeds. It works the same for architecture designs, product tradeoffs, and quick either/or decisions.

It is intentionally separate from `review-loop`:

- `converge-loop` is for deliberation: debate, pushback, negotiation, evidence gathering, and convergence while work is still fluid.
- `review-loop` is for validation: independent read-only review gates when an artifact is ready to proceed.

This plugin package contains the product design, plugin scaffold, and Node.js command runtime.

## Current Contents

- `.codex-plugin/plugin.json`: Codex plugin manifest.
- `.claude-plugin/plugin.json`: Claude Code plugin manifest.
- `commands/converge-loop.md`: Claude Code command surface.
- `skills/`: Codex skill surfaces for deliberation and setup.
- `scripts/bin/converge-loop.mjs`: command entrypoint.
- `scripts/lib/`: runtime modules for CLI parsing, orchestration, adapters, and state.
- `tests/`: deterministic fake-adapter tests.
- `docs/design-plan.md`: canonical product design plan.
- `docs/archive/review-loop-source-draft.md`: preserved draft copied from the old review-loop checkout.

## Command

From the repository root, enter the plugin directory and run the command with Node:

```bash
cd plugins/converge-loop
node scripts/bin/converge-loop.mjs setup
node scripts/bin/converge-loop.mjs run --topic "Decide the retention default for exported sessions"
```

After package linking, package installation, or Codex plugin installation, use the bin directly:

```bash
converge-loop setup
converge-loop run --topic "Decide the retention default for exported sessions"
converge-loop status
converge-loop doctor
converge-loop result <session-id>
converge-loop cancel <session-id>
converge-loop resume <session-id>
```

The normal installed-skill path is host-aware: Codex pairs with Claude Code, and Claude Code pairs with Codex. The Codex skill sets `CONVERGE_LOOP_HOST=codex`; the Claude Code command uses `CLAUDE_PLUGIN_ROOT` so the runtime infers `claude`. If both plugin-root variables are present, `CLAUDE_PLUGIN_ROOT` is treated as the host signal before `PLUGIN_ROOT`. Direct shell users default to the Codex-hosted order unless they set `CONVERGE_LOOP_HOST` explicitly. Deterministic fake adapters are for verification only.

Run `converge-loop setup` before real local-agent deliberation. Setup verifies the local `codex` and `claude` CLIs, required read-only flag availability, and non-model auth status, then writes local readiness config under the converge-loop state directory. Normal users should not need to set local-adapter environment variables.

Setup controls:

- `converge-loop setup --check-only`: run executable, flag, and auth-status checks without writing config or calling models.
- `converge-loop setup --disable`: disable config-backed local adapters.
- `converge-loop setup`: after normal readiness passes, run a tiny real Codex + Claude adapter exchange before enabling config. This can spend model calls.
- `converge-loop setup --no-smoke`: skip the live exchange and enable from readiness checks only; use this for deterministic CI or offline setup.
- `converge-loop setup --smoke`: explicitly request the live exchange. This is also the default unless deterministic fake CLI mode is active.

If the default opposite-agent path is unavailable, converge-loop may use the primary host adapter as a degraded fallback and will disclose that in the result. Pass `converge-loop run --require-independent` to block instead of accepting degraded same-provider fallback when genuine independent provider coverage is required. If the requested scope cannot be provided symmetrically, such as `--web shared` before shared web support is implemented, the run blocks instead of silently widening or changing access.

Use `converge-loop doctor [--json] [--limit N]` to inspect recent reliability from stored sessions without calling models or mutating state. It reports status counts, fallback and timeout rates over all included sessions, independent-provider coverage excluding fake-adapter sessions, blocked reasons, elapsed turn-duration stats, and the current adapter-health cache.

## Models and turn budgets

Each local CLI participant uses its CLI's default model unless overridden. Per run, pass `--claude-model <model>` or `--codex-model <model>`. For a persistent default, add an `adapters` block to `local-adapters.json` in the converge-loop state directory (`converge-loop setup` prints its path and preserves this block across reruns):

```json
{
  "adapters": {
    "claude": { "model": "sonnet" },
    "codex": { "model": "gpt-5" }
  }
}
```

Turn budgets: `--turn-timeout-seconds` (default 420) is an absolute per-turn cap, and `--turn-inactivity-seconds` (default 120, 0 disables) kills a turn whose CLI streams no output at all — a hung adapter dies fast while a slow-but-streaming model keeps its full window. A turn that hits either limit is retried once with both windows doubled before fallback handling applies, and no new attempt starts past `--max-minutes`. Large default models can need most of the timeout window for a deliberation turn; picking a faster model is usually the better fix than raising the cap.

The default dialogue cap is `--max-turns 8`. Keep broad topics focused first; raise `--max-turns` when one deliberation must cover several material issues, evidence exchange, or multiple rounds of negotiation.

## Verification

From the repository root:

```bash
npm test --prefix plugins/converge-loop
```

If you are already in the plugin directory, run `npm test`.

## Design

Read [docs/design-plan.md](docs/design-plan.md) for the current product plan.
