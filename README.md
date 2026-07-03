# converge-loop

This repository is a local Codex plugin marketplace for `converge-loop`.

The plugin source lives in [`plugins/converge-loop`](plugins/converge-loop). The marketplace metadata lives in [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json), so Codex can install the plugin from this repository root.

## Install

From the repository root:

```bash
codex plugin marketplace add "$PWD"
codex plugin add converge-loop@converge-loop
```

Start a new Codex thread after reinstalling so the updated skills and command surface are loaded.

## Develop

```bash
npm test --prefix plugins/converge-loop
```

Read [`plugins/converge-loop/README.md`](plugins/converge-loop/README.md) for runtime usage and product details.
