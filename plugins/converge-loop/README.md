# converge-loop

`converge-loop` is a local Codex plugin for multi-agent deliberation.

It is intentionally separate from `review-loop`:

- `converge-loop` is for deliberation: debate, pushback, negotiation, evidence gathering, and convergence while work is still fluid.
- `review-loop` is for validation: independent read-only review gates when an artifact is ready to proceed.

This plugin package contains the product design, plugin scaffold, and Node.js command runtime.

## Current Contents

- `.codex-plugin/plugin.json`: Codex plugin manifest.
- `skills/converge-loop/SKILL.md`: skill surface for when to use the command.
- `scripts/bin/converge-loop.mjs`: command entrypoint.
- `scripts/lib/`: runtime modules for CLI parsing, orchestration, adapters, and state.
- `tests/`: deterministic fake-adapter tests.
- `docs/design-plan.md`: canonical product design plan.
- `docs/archive/review-loop-source-draft.md`: preserved draft copied from the old review-loop checkout.

## Command

From the repository root, enter the plugin directory and run the command with Node:

```bash
cd plugins/converge-loop
CONVERGE_LOOP_HOST=akx node scripts/bin/converge-loop.mjs run --topic "Improve this plan"
```

After package linking, package installation, or Codex plugin installation, use the bin directly:

```bash
CONVERGE_LOOP_HOST=akx converge-loop run --topic "Improve this plan"
converge-loop status
converge-loop result <session-id>
converge-loop cancel <session-id>
converge-loop resume <session-id>
```

The normal installed-skill path should use the host-aware default pairing: `akx` / Codex pairs with `akc` / Claude Code, and `akc` pairs with `akx`. The host plugin should set `CONVERGE_LOOP_HOST=akx` or `CONVERGE_LOOP_HOST=akc`; shell users can set it explicitly. Deterministic fake adapters are for verification only. Real `codex` and `claude` adapter scaffolds fail closed unless `CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS=1` is set and read-only preflight checks pass.

Until the real-adapter slice is fully enabled in your environment, the bare command may return a blocked fail-closed result. For installation smoke tests only, use `--agents fake-sequence,fake-sequence` and treat the result as deterministic test coverage, not independent provider deliberation.

## Verification

From the repository root:

```bash
npm test --prefix plugins/converge-loop
```

If you are already in the plugin directory, run `npm test`.

## Design

Read [docs/design-plan.md](docs/design-plan.md) for the current product plan.
