# converge-loop

`converge-loop` is a local Codex plugin for multi-agent deliberation.

It is intentionally separate from `review-loop`:

- `converge-loop` is for deliberation: debate, pushback, negotiation, evidence gathering, and convergence while work is still fluid.
- `review-loop` is for validation: independent read-only review gates when an artifact is ready to proceed.

The current repository contains the product design, plugin scaffold, and Node.js command runtime.

## Current Contents

- `.codex-plugin/plugin.json`: Codex plugin manifest.
- `skills/converge-loop/SKILL.md`: skill surface for when to use the command.
- `scripts/bin/converge-loop.mjs`: command entrypoint.
- `scripts/lib/`: runtime modules for CLI parsing, orchestration, adapters, and state.
- `tests/`: deterministic fake-adapter tests.
- `docs/design-plan.md`: canonical product design plan.
- `docs/archive/review-loop-source-draft.md`: preserved draft copied from the old review-loop checkout.

## Command

Run from this repo with Node:

```bash
node scripts/bin/converge-loop.mjs run --agents fake-sequence,fake-sequence --topic "Improve this plan"
```

After package linking or installation, use the bin directly:

```bash
converge-loop run --agents fake-sequence,fake-sequence --topic "Improve this plan"
converge-loop status
converge-loop result <session-id>
converge-loop cancel <session-id>
converge-loop resume <session-id>
```

The deterministic fake adapters are the verified local path. Real `codex` and `claude` adapter scaffolds fail closed unless `CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS=1` is set and read-only preflight checks pass.

## Verification

```bash
npm test
```

## Design

Read [docs/design-plan.md](docs/design-plan.md) for the current product plan.
