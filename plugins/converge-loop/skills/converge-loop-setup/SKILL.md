---
name: converge-loop-setup
description: Verify Codex and Claude Code local CLI readiness for converge-loop and enable config-backed local adapters.
---

# converge-loop setup

Use this skill when the user or agent needs to prepare `converge-loop` for real Codex + Claude local-agent deliberation from Codex.

Run:

```bash
CONVERGE_LOOP_HOST=codex node "<skill-root>/../../scripts/bin/converge-loop.mjs" setup $ARGUMENTS
```

Supported arguments:

- `--json`

Setup only checks local prerequisites and writes converge-loop readiness config when required read-only flags are available. Do not ask Claude Code or Codex to edit files as part of setup.

After setup succeeds, normal users can run `converge-loop run ...` without setting local-adapter environment variables.
