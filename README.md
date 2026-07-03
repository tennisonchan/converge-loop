# converge-loop

`converge-loop` is a local Codex plugin for multi-agent deliberation.

It is intentionally separate from `review-loop`:

- `converge-loop` is for deliberation: debate, pushback, negotiation, evidence gathering, and convergence while work is still fluid.
- `review-loop` is for validation: independent read-only review gates when an artifact is ready to proceed.

The current repository contains the product design and plugin scaffold. The command runtime is not implemented yet.

## Current Contents

- `.codex-plugin/plugin.json`: Codex plugin manifest.
- `skills/converge-loop/SKILL.md`: initial skill surface for planning and design use.
- `docs/design-plan.md`: canonical product design plan.
- `docs/archive/review-loop-source-draft.md`: preserved draft copied from the old review-loop checkout.

## Target Command

The planned user-facing command is:

```bash
converge-loop
```

The design currently sketches subcommands such as `run`, `status`, `result`, and `cancel`, but the top-level product name and plugin identity are `converge-loop`.

## Design

Read [docs/design-plan.md](docs/design-plan.md) for the current product plan.
