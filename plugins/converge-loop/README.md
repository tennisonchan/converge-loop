# converge-loop

`converge-loop` is a local Codex plugin for multi-agent deliberation.

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
node scripts/bin/converge-loop.mjs run --topic "Improve this plan"
```

After package linking, package installation, or Codex plugin installation, use the bin directly:

```bash
converge-loop setup
converge-loop run --topic "Improve this plan"
converge-loop status
converge-loop result <session-id>
converge-loop cancel <session-id>
converge-loop resume <session-id>
```

The normal installed-skill path is host-aware: Codex pairs with Claude Code, and Claude Code pairs with Codex. The Codex skill sets `CONVERGE_LOOP_HOST=codex`; the Claude Code command uses `CLAUDE_PLUGIN_ROOT` so the runtime infers `claude`. If both plugin-root variables are present, `CLAUDE_PLUGIN_ROOT` is treated as the host signal before `PLUGIN_ROOT`. Direct shell users default to the Codex-hosted order unless they set `CONVERGE_LOOP_HOST` explicitly. Deterministic fake adapters are for verification only.

Run `converge-loop setup` before real local-agent deliberation. Setup verifies the local `codex` and `claude` CLIs, required read-only flag availability, and non-model auth status, then writes local readiness config under the converge-loop state directory. Normal users should not need to set local-adapter environment variables.

Setup controls:

- `converge-loop setup --check-only`: run executable, flag, and auth-status checks without writing config or calling models.
- `converge-loop setup --disable`: disable config-backed local adapters.
- `converge-loop setup --smoke`: after normal readiness passes, run a tiny real Codex + Claude adapter exchange before enabling config. This can spend model calls.

If the default opposite-agent path is unavailable, converge-loop may use the primary host adapter as a degraded fallback and will disclose that in the result. If the requested scope cannot be provided symmetrically, such as `--web shared` before shared web support is implemented, the run blocks instead of silently widening or changing access.

## Verification

From the repository root:

```bash
npm test --prefix plugins/converge-loop
```

If you are already in the plugin directory, run `npm test`.

## Design

Read [docs/design-plan.md](docs/design-plan.md) for the current product plan.
