# converge-loop

This repository is a local plugin marketplace for `converge-loop`, for both Codex and Claude Code.

`converge-loop` is a subject-agnostic deliberation engine: callers provide the topic, focus, context, and artifacts; the engine facilitates debate, evidence exchange, and convergence whether the subject is an architecture design or a quick decision.

The plugin source lives in [`plugins/converge-loop`](plugins/converge-loop). Codex marketplace metadata lives in [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json); Claude Code marketplace metadata lives in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json), so either host can install the plugin from this repository root.

## Install

### Codex

From the repository root:

```bash
codex plugin marketplace add "$PWD"
codex plugin add converge-loop@converge-loop
```

Start a new Codex thread after reinstalling so the updated skills and command surface are loaded.

### Claude Code

Add this repository as a plugin marketplace and install the plugin:

```bash
claude plugin marketplace add "$PWD"
claude plugin install converge-loop@converge-loop
```

Claude Code-hosted sessions use Claude Code as the primary participant and Codex as the secondary participant; ensure the `codex` CLI is installed and authenticated for opposite-agent deliberation, then run:

```bash
/converge-loop:converge-loop setup
/converge-loop:converge-loop run --topic "Decide the retention default for exported sessions"
```

## Develop

```bash
npm test --prefix plugins/converge-loop
```

Read [`plugins/converge-loop/README.md`](plugins/converge-loop/README.md) for runtime usage and product details.
