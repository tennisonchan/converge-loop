---
description: Run converge-loop deliberation with the opposite-agent participant
argument-hint: 'run [options] | status [session-id] | result <session-id> | cancel <session-id> | resume <session-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/converge-loop.mjs" $ARGUMENTS
```

Return the command output as-is. This command is deliberation-only; do not edit files, apply patches, commit, invoke nested review loops, or continue into implementation from inside the participant turn.
