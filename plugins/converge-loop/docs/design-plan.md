# converge-loop Product Design Plan

## Purpose

`converge-loop` is a local plugin that orchestrates a back-and-forth conversation between two or more agents, usually from different providers, until they reach a useful stopping point: a better plan, a shared conclusion, a clear unresolved disagreement, a request for more evidence, or an operator intervention point.

The plugin is deliberately separate from `review-loop`. `review-loop` remains the deterministic final review gate. `converge-loop` is a deliberation tool: it helps agents debate, negotiate, ask for better ideas, inspect repo context, push back when useful, and converge.

Like `review-loop`, `converge-loop` is a subject-agnostic facilitation engine. Callers own all subject detail — topic, focus, context packets, and artifacts — and the runtime must not assume the deliberation is about a plan, a repo, or software at all. The same mechanism serves architecture designs, product tradeoffs, and quick either/or decisions; only scope flags describe repo access, and they stay optional.

## Product Thesis

The product replaces a manual workflow the operator already performs:

1. Ask one agent to produce an artifact such as a design plan.
2. Copy that artifact to another agent and ask for materially valuable feedback.
3. Copy the feedback back to the first agent and ask what it accepts, rejects, or wants to push back on.
4. Repeat until the plan is stronger, the disagreement is clear, or more evidence is needed.

`converge-loop` automates that loop without turning it into a rigid gate. The goal is not to force disagreement. The goal is to make agreement earned: agents should ask for more context, propose better ideas, challenge weak assumptions, negotiate tradeoffs, and converge when there is no material pushback left.

## Goals

- Support constructive pushback, debate, negotiation, and convergence.
- Stay subject-agnostic: facilitate any deliberation, from architecture design to a quick decision, without baking subject assumptions into prompts, defaults, or outputs.
- Use agents from different companies/providers by default for genuinely different model behavior.
- Make the default installed-skill experience host-aware: `akx` (Codex) pairs with `akc` (Claude Code), and `akc` pairs with `akx`.
- Use the primary agent's sub-agent as a degraded fallback when an external participant is unavailable.
- Let both agents browse the repo directly within the same read-only scope.
- Let both agents gather web context through the same shared read-only web scope when web access is explicitly enabled.
- Keep the session local, bounded, inspectable, and resumable.
- Default to compact live output, with quiet and verbose modes.
- Produce a final artifact that a human or downstream tool can act on.
- Hand final plans or code changes to `review-loop` when deterministic review is needed.

## Non-Goals

- Do not replace `review-loop` as a final review gate.
- Do not edit files, apply patches, commit, or implement changes during deliberation.
- Do not require live human participation by default.
- Do not force disagreement when agents genuinely have no material pushback.
- Do not guarantee that every agent reads exactly the same files in the same order.
- Do not allow provider-native web browsing or repo tools that the orchestrator cannot observe or constrain.
- Do not build a hosted service, queue, or web UI in v1.

## User Flow

The default flow is:

1. The operator starts a session:

   ```bash
   converge-loop run --topic "Should this design use direct repo browsing?"
   converge-loop run --artifact converge-loop/design-plan.md --focus "Find better product defaults"
   converge-loop run --scope working-tree --focus "Push back on this implementation plan"
   ```

2. `converge-loop` selects two participants by default from the current host:
   - when invoked from `akx`, the primary participant is Codex and the secondary participant is `akc` / Claude Code
   - when invoked from `akc`, the primary participant is Claude Code and the secondary participant is `akx` / Codex
3. Both participants receive the same topic, artifact/context, working directory, scope policy, permissions, and transcript.
4. The first participant responds with a proposal, critique, or synthesis.
5. The second participant responds with constructive pushback, improvements, questions, evidence, or explicit agreement.
6. The orchestrator alternates turns, keeping the conversation focused on unresolved points and better ideas.
7. The agents converge, record a clear disagreement, request evidence, or identify operator intervention points.
8. `converge-loop` writes the transcript, evidence ledger, conclusion, and normalized result.

The operator should feel like the tool is doing the copy-paste feedback loop for them, not like it is running a court proceeding.

## Command Surface

The only user-facing command is `converge-loop`.

Initial commands:

```bash
converge-loop run --topic "Should transcript storage be local or repo-backed?"
converge-loop run --artifact plan.md --focus "Ask for better ideas and pushback"
converge-loop run --scope working-tree --output verbose
converge-loop run --background --artifact plan.md
converge-loop status
converge-loop status <session-id>
converge-loop doctor
converge-loop resume <session-id>
converge-loop result <session-id>
converge-loop cancel <session-id>
```

Useful `setup` options:

- `--json`: return machine-readable setup status.
- `--check-only`: run executable, read-only flag, and non-model auth-status checks without writing config or calling models.
- `--disable`: write disabled local-adapter config.
- `--smoke`: after normal readiness passes, run a tiny real Codex + Claude adapter exchange before enabling config. This can spend model calls and is not a deterministic CI requirement.

Useful `run` options:

- `--topic <text>`: primary discussion topic.
- `--context <path>`: user-provided context packet.
- `--artifact <path>`: specific artifact to discuss.
- `--scope none|working-tree|branch`: repo scope available to both participants; default is `working-tree`.
- `--base <ref>`: base ref for branch-scope material.
- `--web off|shared`: web scope available to both participants; default is `off`.
- `--focus <text>`: narrow the discussion.
- `--counterpart codex|claude`: select the counterpart participant; default is the host's opposite agent. There is no flag for arbitrary participant lists; `--fake-adapters <fake-a,fake-b>` exists for deterministic verification only and refuses real adapters.
- `--roles proposer,critic`: select stance for the primary and secondary participants.
- `--output compact|verbose|quiet`: terminal display mode; default is `compact`.
- `--intervene`: allow the orchestrator to pause and ask the operator for input.
- `--max-turns <n>`: cap dialogue turns.
- `--max-minutes <n>`: cap wall-clock runtime.
- `--turn-timeout-seconds <n>`: absolute cap for a single participant turn.
- `--turn-inactivity-seconds <n>`: kill a local CLI turn that produces no output for `n` seconds (0 disables); distinguishes a hung adapter from a slow model. Doubles alongside the absolute cap on the extended timeout retry.
- `--claude-model <model>` / `--codex-model <model>`: per-run model override for a local CLI participant; persistent defaults live in `local-adapters.json` under `adapters.<name>.model`.
- `--max-tool-calls-per-turn <n>`: cap direct repo reads/searches per turn.
- `--max-control-retries <n>`: cap control-output repair attempts.
- `--require-independent`: block instead of using degraded same-provider fallback when genuine independent provider coverage is required.
- `--json`: return machine-readable session status.
- `--background`: run as a background job.

`--intervene` is foreground-only. If combined with `--background`, the command fails fast with a validation error. Without `--intervene`, operator questions are recorded as output instead of interrupting the run.

`converge-loop run` requires at least one of `--topic`, `--context`, `--artifact`, a non-empty selected repo scope, or `--web shared` with a topic/focus that asks for external evidence. With the default `--scope working-tree`, a clean tree and no topic/context/artifact is invalid input: the command should ask for a topic, artifact, context, branch/base scope, or explicit web-backed research topic.

`--scope branch` requires `--base <ref>`. If omitted, the command fails before launching participants with a clear validation error. `--artifact` and `--context` must exist, be readable files, and resolve inside the current working directory unless an absolute path is supplied intentionally. Missing or unreadable paths are invalid input.

`converge-loop status` without an id lists recent active and terminal sessions. `converge-loop status <session-id>` shows one session. Background runs print a session id immediately so the operator can call `converge-loop status <session-id>`, `converge-loop result <session-id>`, `converge-loop resume <session-id>`, or `converge-loop cancel <session-id>`.

`converge-loop doctor [--json] [--limit N]` is a read-only reliability view over recent stored sessions. It reports terminal status counts, fallback and timeout rates over all included sessions, fallback reasons, independent-provider coverage excluding fake-adapter sessions, blocked reasons, elapsed turn-duration statistics overall and per adapter, and current adapter-health cache verdicts. Turn durations are elapsed wall-clock gaps between persisted turn timestamps, not compute-only timings.

## Command Runtime and Plugin Wiring

The v1 runtime is a Node.js ESM CLI packaged inside the plugin:

- `package.json` declares `"type": "module"` and a `bin` entry: `"converge-loop": "./scripts/bin/converge-loop.mjs"`.
- `scripts/bin/converge-loop.mjs` is the only public executable. It parses top-level commands and dispatches to runtime modules under `scripts/lib/`.
- `scripts/lib/cli.mjs` owns argument parsing and validation.
- `scripts/lib/orchestrator.mjs` owns the turn loop.
- `scripts/lib/adapters/*.mjs` own participant launch/invocation.
- `scripts/lib/state-store.mjs` owns session persistence and background job metadata.
- `skills/converge-loop/SKILL.md` is a guidance surface that tells Codex when and how to invoke the CLI; it is not the runtime and must not implement orchestration in prose.

The `.codex-plugin/plugin.json` manifest continues to expose `skills` because the current plugin surface discovers skills. The command itself is exposed through the package binary and script path. If future Codex plugin manifests add first-class command entries, this plan can add a manifest pointer without changing the runtime contract.

The first implementation slice must create the package metadata, bin wrapper, command parser, and no-provider fake adapter path before any real provider adapter is added. That keeps command wiring testable without live model credentials.

The installed skill should not make fake adapters feel like the normal product path. Fake adapters are for deterministic tests, smoke checks, and fixture-driven development. In normal use, running without `--counterpart` means "use the current host and its opposite agent," matching the `review-loop` host/opposite-agent convention.

## Participants

The default v1 session has two active participants:

- `proposer`: develops, defends, or revises the current idea.
- `critic`: pushes back, asks for evidence, identifies risks, and proposes better alternatives.

Roles are stances, not fixed personalities. Either participant can agree, disagree, concede, ask questions, or improve the proposal.

Default participant selection is host-aware and deterministic:

- `akx` / Codex-hosted sessions use Codex as the primary participant and `akc` / Claude Code as the secondary participant.
- `akc` / Claude Code-hosted sessions use Claude Code as the primary participant and `akx` / Codex as the secondary participant.
- CLI-only sessions without a known host infer the host from `CONVERGE_LOOP_HOST`; if unset, they infer `claude` from `CLAUDE_PLUGIN_ROOT`, infer `codex` from `PLUGIN_ROOT`, then default to the Codex-hosted order. If both plugin-root variables are present, `CLAUDE_PLUGIN_ROOT` wins over `PLUGIN_ROOT`.
- Explicit `CONVERGE_LOOP_HOST` wins over plugin-root inference.
- If the preferred opposite-provider adapter is unavailable or unauthenticated in the default participant order, the orchestrator uses an explicitly configured alternate provider when present.
- If no external alternate is available, the orchestrator uses the primary agent's sub-agent fallback and marks coverage as degraded.

Host identity must be normalized before participant selection. `akx`, `codex`, and `openai` are Codex-host aliases. `akc`, `claude`, `claude-code`, and `anthropic` are Claude-host aliases. The Codex skill sets `CONVERGE_LOOP_HOST=codex`; the Claude Code command uses `CLAUDE_PLUGIN_ROOT` and lets the runtime infer `claude`. An unset host defaults to the Codex-hosted order for CLI-only use; an explicitly unknown host value fails closed.

The default agent order is primary host first, opposite agent second. That means the operator should usually invoke `converge-loop run ...` without `--counterpart`. `--counterpart codex|claude` is the only real-adapter pairing override, mirroring review-loop's `--reviewer`; the `--fake-adapters` pair flag exists for diagnostics and deterministic tests only, refuses real adapters, and is not the standard skill path.

Fallback applies only to the implicit default opposite-agent path. If an operator supplies `--counterpart` or `--fake-adapters`, the orchestrator treats the selection as intentional and does not replace a failed participant with a fallback. If the operator passes `--require-independent`, the default path also refuses degraded fallback: unavailable counterpart adapters, remembered known-bad counterparts, invoke-time failures that would otherwise swap, or operator-selected same-provider pairings end as `blocked` with `blocked_reason: "require_independent"` and no degraded participant.

Fallback is enforced at two points. Preflight fallback replaces an unavailable secondary participant before any turns run. Invoke-time fallback handles mid-session adapter failure: a failed turn is retried once on the same adapter (with a doubled window when the failure was a timeout), then the failed slot is swapped to the opposite local CLI when it passes preflight, disclosed as degraded coverage in the transcript and result, and only when no swap is possible does the session end `blocked` with `blocked_reason: "adapter_failure"`. Adapter-failure blocked sessions are resumable once adapters are healthy again. Each swapped participant carries `tier: "fallback"`, `fallback_for`, and a redacted `fallback_reason`, and a slot never swaps twice.

Adapter failures are classified so fallback stays a rare shock absorber rather than a chronic crutch. **Transient** failures (timeouts, dropped connections, unknown errors) get the one same-adapter retry described above. **Deterministic** failures (auth/token, output-schema rejection, missing CLI flags) fail the same way every run, so they skip the useless retry and are remembered: the orchestrator records a TTL-bounded known-bad verdict for that adapter in `config/adapter-health.json` (schema `converge-loop.adapter-health.v1`, default 15-minute TTL). Preflight consults the cache and fails the adapter fast with the stored category, redacted reason, and fix hint, so later sessions do not rediscover the same breakage turn-by-turn and silently swap. A clean turn or a passing `converge-loop setup` clears the verdict; `CONVERGE_LOOP_IGNORE_ADAPTER_HEALTH=1` bypasses the cache for a forced retry.

Real local CLI adapters are enabled through `converge-loop setup`, not by asking normal users to set local-adapter environment variables. Setup verifies the local `codex` and `claude` executables, required read-only flag availability, and non-model auth status, then runs a tiny real Codex + Claude smoke exchange before writing enabled readiness config in the converge-loop state directory. Runtime preflight remains fail-closed when setup has not verified the local controls/auth status or when the installed CLIs no longer satisfy the same flag checks.

`converge-loop setup --check-only` runs the same executable, flag, and auth-status checks without mutation or model calls. `converge-loop setup --disable` disables config-backed local adapters. `converge-loop setup --no-smoke` keeps deterministic/offline enablement by skipping the live exchange and enabling from readiness checks only. `converge-loop setup --smoke` explicitly requests the default live-provider proof. Under `CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE=1`, default setup skips smoke so deterministic CI never spends model calls; explicit `--smoke` still refuses the fake shortcut. Smoke uses explicit `codex,claude` participants, disables fallback by construction, requires independent provider coverage, and enables durable config only after the smoke passes.

Codex participant invocations include `--ignore-user-config` so nested participant runs do not inherit host-session hooks or plugin config. Authentication still uses `CODEX_HOME`; setup verifies the flag before enabling the local adapter. Claude participant invocations include `--safe-mode` for the same hook-isolation reason while preserving auth, model selection, built-in tools, and permissions.

`--roles` binds positionally to the primary and secondary participants: `roles[0]` is the primary's stance, `roles[1]` the secondary's. When `--roles` is omitted, roles default to `proposer,critic` in participant order. With a single entry, only the primary's stance is overridden and the secondary falls back to the generic `participant-2` label, not `critic`.

The data model should use participant arrays so future versions can support more than two agents without a schema break, but v1 should focus on two.

## File and Web Browsing Model

Both participants may browse files and, when enabled, web sources in v1, but under the same constraints:

- Same working directory.
- Same selected file scope.
- Same selected web scope.
- Same read-only permissions.
- Same allowed read/search/fetch tools.
- Same transcript visibility.
- Same max-turn, timeout, and tool-use budgets.

The risk is not that agents read files. The risk is that one agent gets broader authority or different evidence and the result pretends to be a symmetric debate. The product should solve that with equal scope plus an evidence ledger, not by preventing direct browsing.

File scope is controlled by `--scope`:

- `none`: no repo file access beyond explicitly supplied `--context` or `--artifact`.
- `working-tree`: read/search access to the current worktree, including uncommitted changes, with writes denied.
- `branch`: read/search access to the diff and relevant files between `--base` and `HEAD`; `--base` is required.

Web scope is controlled by `--web`:

- `off`: no web/search/fetch tools are available to either participant. Provider-native web features must be disabled or the adapter cannot participate.
- `shared`: both participants use the same orchestrator-mediated web access with the same limits, URL policy, timeout, and evidence logging. Provider-native web features remain disabled so one provider cannot silently use broader web access.

Shared web v1 is fetch-only and mediated between turns rather than through an in-turn tool bridge (one-shot local CLI participants cannot call back into the orchestrator mid-turn). Participants list public http(s) URLs in the `web_fetch_requests` control field; after the turn, the orchestrator fetches them under identical caps for everyone (per-turn and per-session limits, byte cap, timeout, manual redirect validation, private/loopback hosts rejected), records observed evidence entries with content hashes, persists the fetched content to `web-materials.jsonl`, and includes it in every subsequent turn prompt as shared material. Web search (queries) is deferred until a search provider exists; participants express search needs as fetches of known URLs or as `evidence_requests` for the operator.

If one adapter cannot support the same file or web scope as the other, the orchestrator either downgrades both participants to the shared subset when the operator did not explicitly request the unavailable scope, or stops as `blocked` when the requested scope cannot be honored symmetrically.

Each participant turn must include an evidence summary when it relied on repo or web material:

- files read or searched
- web queries run or URLs fetched
- symbols, tests, or docs consulted
- important file/line citations or URL citations when available
- evidence gaps or requested follow-up reads

The evidence ledger has two layers:

- Observed tool-use metadata captured by the orchestrator for file read/search calls and web search/fetch calls.
- Participant-reported evidence summaries for adapters that cannot expose every read/search/fetch call.

Observed metadata is the stronger source and should include file paths, search patterns, read ranges, web queries, fetched URLs, HTTP status, fetch timestamp, and content hash when available. Participant-reported summaries are still useful, but they do not prove the agent disclosed every source it considered. The final result must distinguish observed evidence from self-reported evidence so the operator understands the residual asymmetry risk.

The orchestrator records evidence in each turn record in `turns.jsonl`, includes it in the transcript, and shows it to the other participant on the next turn. `turns.jsonl` is the per-turn source of truth; `evidence-ledger.jsonl` is the aggregated derived view optimized for status/result display and downstream tools. This gives both agents the opportunity to inspect, challenge, or reinterpret cited evidence without requiring the orchestrator to proxy every read.

## Read-Only Enforcement

The runtime has three adapter classes, and each class must prove read-only enforcement before it can participate:

- `tool-proxy` adapters for hosted APIs. The model receives only orchestrator-provided tools. The allowlist contains file read/search and optional shared web search/fetch. It never contains write, patch, shell, commit, network-fetch outside the shared web tool, or nested-agent tools. Per-call timeouts are enforced by the orchestrator.
- `local-cli` adapters for local agent CLIs. The subprocess is launched with the strongest supported read-only controls for that CLI plus an OS-level execution guard when available. The adapter must deny patch/write/commit/delegation tools, pass the selected working directory, set turn timeouts, and run preflight checks that prove the requested read-only/sandbox flags are supported. If a CLI cannot prove these controls, it cannot participate.
- `primary-sub-agent` fallback adapters. The host launches the fallback through a restricted prompt/tool configuration equivalent to the active participant allowlist. If the host cannot disable write/patch/commit/delegation tools for the fallback, fallback is unavailable and the session stops as `blocked` rather than silently widening authority.

Every adapter declares capabilities before a run:

```json
{
  "adapter": "codex",
  "provider": "openai",
  "class": "local-cli",
  "file_scope": ["none", "working-tree", "branch"],
  "web_scope": ["off", "shared"],
  "control_output": ["json-schema", "nonce-block"],
  "read_only_enforcement": "sandbox-read-only",
  "observed_evidence": ["file", "web"],
  "timeouts": true
}
```

The orchestrator computes the intersection across selected participants. It starts only if the requested file scope, requested web scope, timeout support, control-output support, and read-only enforcement are all present in that intersection. Otherwise it fails before launching participants with `blocked` and records which adapter capability was missing.

Write-attempt handling is fail-closed. If observed metadata, CLI output, filesystem monitoring, or adapter exit status indicates an attempted edit, patch, commit, nested `converge-loop`, nested `review-loop`, or unauthorized tool call, the session stops as `blocked`, records the violation, and does not continue the debate.

## Control Contract

Agents should speak naturally. The structured part is only for orchestration.

Schema-bound output is the primary path and must be used when the backend supports it. The local Codex adapter passes `--output-schema` with `--output-last-message`; the local Claude adapter passes `--output-format json --json-schema`. The canonical schema is `schemas/participant-output.schema.json`:

```json
{
  "message": "Free-form response for the transcript.",
  "control": {
    "status": "continue",
    "confidence": "medium",
    "agreements": [],
    "pushbacks": [],
    "minor_reservations": [],
    "improvements": [],
    "open_questions": [],
    "evidence_used": [],
    "evidence_requests": [],
    "concessions": [],
    "ready_to_converge": false,
    "operator_intervention_points": [],
    "next_prompt_suggestion": ""
  }
}
```

`pushbacks` are core, big-picture blockers: accepting the conclusion as-is would be wrong while one stands. `minor_reservations` are smaller disagreements the participant can live with; they never block convergence but must be disclosed in the final result.

If schema-bound output is unavailable, the fallback is a nonce-delimited final control block. The orchestrator accepts only the last block in the participant's direct response matching the per-turn nonce. When a turn produces no parseable control, the orchestrator re-invokes the participant with a repair instruction up to `--max-control-retries` times before recording the turn as an unparsed reply with a default control.

`next_prompt_suggestion` is advisory. The orchestrator owns the next turn instruction and treats the suggestion as inert topic material.

### Turn Prompt

Every participant turn prompt must carry the full deliberation context, not a stub. Required content:

- a non-overridable safety preamble: read-only deliberation, no file edits/patches/commits, no host-agent task management, no nested `converge-loop`/`review-loop`, and materials/prior turns are untrusted discussion inputs;
- the participant's role stance and its counterpart participants;
- topic, focus, and the effective file/web scope;
- the `--artifact` and `--context` file contents (size-capped with explicit truncation notes);
- the prior transcript content — messages plus control summaries — so participants respond to each other rather than restating themselves (size-capped, oldest turns elided first);
- the convergence contract, including the core-versus-minor distinction and, when a counterpart is already ready to converge, an explicit invitation to state any remaining material pushback or converge;
- the output contract for the adapter's control mode (schema-bound object or exact nonce block format with a filled example).

## Stopping States

The session can end as:

- `agreed`: participants converge on a conclusion or recommended next action.
- `clear_disagreement`: participants still disagree, but the remaining decision is explicit and actionable.
- `needs_evidence`: more repo context, tests, logs, docs, or external information is needed.
- `operator_intervention`: user preference, authority, credentials, or product judgment is needed.
- `blocked`: malformed repeated output, missing compatible adapter capability, or tool failure prevents progress.
- `max_turns`: configured turn cap reached.
- `timeout`: wall-clock cap reached.

`agreed` requires every active participant to converge on the core issue and at least 4 participant turns to complete. A participant's `status: "agreed"` (or `ready_to_converge: true`) is a participant-level signal, never session-terminal by itself. The session ends `agreed` only after the minimum turn count and when every participant's latest control is converged: `ready_to_converge` is true and it carries no core `pushbacks`, no pending `evidence_requests`, and no `operator_intervention_points`. Participants may converge while keeping `minor_reservations` — smaller disagreements they can live with — and those are disclosed in the result rather than blocking agreement. A participant who declares `agreed` while still listing core pushbacks has not converged.

If a participant asks for evidence during convergence, the session moves back to discussion or ends as `needs_evidence`; it does not finalize while an unresolved evidence request could materially change the conclusion.

The orchestrator, not the participants, adjudicates materiality for stopping. A pushback is core when it would change the conclusion, invalidate an assumption, add a meaningful option, identify a non-trivial risk, request evidence that could change the decision, or expose a requirement conflict; anything a participant can live with belongs in `minor_reservations`. When a counterpart is already ready to converge, the next turn prompt explicitly asks the non-ready participant: "Do you have any material pushback, missing evidence, or better option that would change the conclusion?" If the answer contains only restated resolved points, style preferences, or non-actionable caveats, the participant should converge with minor reservations. If the answer contains new core pushback or an evidence request, the loop returns to discussion or ends as `needs_evidence`.

Before the 4-turn minimum is met, provisional agreement keeps the loop running and the prompt asks participants to pressure-test the strongest remaining assumption, evidence gap, risk, or alternative without manufacturing disagreement. Agreement and no-progress respect the minimum; operational exits such as `needs_evidence`, `operator_intervention`, `blocked`, timeout, and cancellation remain immediate. An explicit lower `--max-turns` still ends as `max_turns` rather than manufacturing additional dialogue.

## Loop Policy

Wall-clock and turn budgets are kept coherent so a session does not systematically die as `timeout` under adapter stress. At session start, if `--max-minutes` cannot fit one full round of turns at the configured per-turn timeout, the runtime warns the operator to raise `--max-minutes` or lower `--turn-timeout-seconds`. Before each turn, if the remaining wall clock is less than one turn timeout, the session stops early as a clean resumable `timeout` (with a message naming the shortfall) instead of launching a turn that would die mid-flight. At least one turn always runs before this guard applies.


Default limits:

- 4 participant turns before agreement or no-progress
- `--max-turns 8`
- `--max-minutes 30`
- `--turn-timeout-seconds 420`
- `--turn-inactivity-seconds 120`
- `--max-tool-calls-per-turn 20`
- `--max-control-retries 1`

The turn timeout is an absolute hang bound, not an expected turn length: deliberation turns on large models routinely run past 3 minutes of pure generation, so hung-adapter detection is primarily the inactivity bound. Local CLI participants stream their output (Claude via `--output-format stream-json --include-partial-messages`; Codex via its progressive exec output), and a turn is killed early only when the CLI produces no output at all for the inactivity window. The inactivity default is generous because a legitimate read-only tool call emits nothing until it returns.

Every invoke attempt is additionally bounded by an orchestrator-level timeout of `--turn-timeout-seconds`, independent of any timeout the adapter enforces internally, so a hung adapter cannot stall the loop. A turn that hits either the absolute cap or the inactivity bound is retried once on the same adapter with both windows doubled (a slow model is not a broken adapter) before invoke-time fallback applies. No retry or fallback attempt starts after the `--max-minutes` deadline has passed, which bounds wall-clock overshoot to at most the attempt already in flight. Adapter error text is redacted for common secret shapes before it is persisted to results or transcripts.

Progress is measured against the same participant's previous control: a turn counts as progress only when it adds a new pushback, minor reservation, improvement, evidence citation, evidence request, concession, answered question, status change, or readiness change relative to that participant's prior turn. Restating the same positions verbatim is not movement, and once the 4-turn minimum is met, a full round without new movement stops the loop.

The no-progress stop should produce `clear_disagreement` when the disagreement is actionable, or `blocked` when the system cannot tell what would move the conversation forward.

Foreground intervention pauses `--max-minutes` while the process is waiting for operator input. Turn-level timeouts still apply only to participant execution, not to human wait time. If the operator does not answer and no default is safe, the run ends as `operator_intervention`.

## Background Jobs and Resume

Foreground and background runs use the same session directory format. Background mode adds a job registry under the state root:

- `jobs/<session-id>.json`: pid, command arguments, cwd, created_at, last_heartbeat_at, status, and session path.
- `jobs/lock`: advisory lock used when listing, canceling, or updating job state.

`converge-loop run --background` starts a detached Node child process with the same environment needed for provider credentials, writes the job record, prints the session id, and returns after the child records `session.json`. The child updates a heartbeat at least once per turn and on terminal state.

`converge-loop status` lists recent sessions and jobs, marking a job `stale` when the pid no longer exists or the heartbeat is older than nine turn-timeout windows (heartbeats land once per completed turn, and one turn may legitimately span up to ~8 windows across primary control attempts, doubled timeout-retry attempts, and fallback-swap attempts). `converge-loop resume` refuses a heartbeat-stale session whose process is still alive, so a slow turn can never be resumed into two concurrent orchestrators. `converge-loop status <session-id>` reports one session and includes stale/orphan diagnostics.

`converge-loop cancel <session-id>` sends a graceful signal to the background child, waits for it to persist `result.json` with status `canceled`, and escalates only if the process ignores the graceful signal. A canceled run keeps all completed turns and records that no conclusion was reached.

`converge-loop resume <session-id>` reloads `session.json`, `turns.jsonl`, and participant state, revalidates adapter availability and capability intersection, appends a resume event, and continues from the next turn. Resume accepts `--context`, `--artifact`, and `--focus` overrides so the operator can answer a `needs_evidence` session with the requested material; newly supplied materials are disclosed in the transcript resume event and included in subsequent turn prompts. Resume is allowed for sessions in `operator_intervention`, `timeout`, `needs_evidence`, `canceled`, or `stale` when the last completed turn is valid, plus two recovery cases: sessions stuck in `running` with no result and no live process (an interrupted foreground run; foreground runs treat SIGINT like SIGTERM and record `canceled` when they can), and sessions `blocked` with `blocked_reason: "adapter_failure"`. It is rejected for `agreed`, `clear_disagreement`, and `blocked` unless the operator starts a new run with the prior transcript as context.

## Output Modes

- `compact` is the default. It streams concise turn summaries, current unresolved points, evidence highlights, and convergence status.
- `verbose` streams full participant messages and control metadata.
- `quiet` prints only terminal status and artifact paths unless the run fails or `--intervene` needs to show an operator prompt.

Full transcripts are always persisted regardless of display mode.

For background runs, display mode affects persisted logs only. `verbose` stores full turn text in job logs and transcript files; `compact` stores compact job events plus full transcripts; `quiet` stores terminal job metadata plus full transcripts. In foreground runs, intervention prompts always print regardless of output mode so a paused session never looks hung.

## Storage

Default storage is user-local state to avoid accidentally committing private deliberation. Storage honors `$XDG_STATE_HOME` when set. Otherwise it uses documented platform defaults:

```text
Linux and other XDG hosts: ~/.local/state/converge-loop/sessions/<session-id>/
macOS: ~/Library/Application Support/converge-loop/sessions/<session-id>/
Windows: %LOCALAPPDATA%\converge-loop\sessions\<session-id>\
```

Each session directory contains:

- `session.json`: metadata, options, participants, state, and current turn index.
- `turns.jsonl`: one JSON object per participant turn.
- `transcript.md`: human-readable transcript.
- `evidence-ledger.jsonl`: file and web evidence each participant cited or requested.
- `conclusion.md`: final synthesized result when available.
- `operator-inputs.jsonl`: operator answers captured during `--intervene` pauses; included in subsequent turn prompts as authoritative preference input.
- `web-materials.jsonl`: shared web content fetched by the orchestrator under `--web shared`; included in all subsequent turn prompts.
- `result.json`: normalized final status.

Every persisted JSON object carries a schema version:

- `session.json`: `schema_version: "converge-loop.session.v1"`
- each `turns.jsonl` record: `schema_version: "converge-loop.turn.v1"`
- each `evidence-ledger.jsonl` record: `schema_version: "converge-loop.evidence.v1"`
- each `operator-inputs.jsonl` record: `schema_version: "converge-loop.operator-input.v1"`
- each `web-materials.jsonl` record: `schema_version: "converge-loop.web-material.v1"`
- `jobs/<session-id>.json`: `schema_version: "converge-loop.job.v1"`
- `result.json`: `schema_version: "converge-loop.result.v1"`
- `doctor --json`: `schema_version: "converge-loop.doctor.v1"`

The v1 runtime may reject newer major schema versions with a clear error. Minor additive fields are ignored by readers unless they are required by a future `minimum_runtime_version` field.

Repo-local export is explicit:

```bash
converge-loop result <session-id> --export .converge-loop/sessions/<session-id>
```

Before exporting into a Git worktree, the command checks whether the destination is ignored. If it is not ignored, the command either adds a `.gitignore` entry for `.converge-loop/` after confirmation or refuses unless the user passes `--allow-versioned-export`.

## Result Shape

```json
{
  "schema_version": "converge-loop.result.v1",
  "status": "agreed",
  "summary": "Use direct read-only repo browsing with same-scope permissions and an evidence ledger.",
  "conclusion_path": "conclusion.md",
  "turn_count": 6,
  "host_agent": "codex",
  "participants": [
    {
      "id": "p1",
      "adapter": "codex",
      "provider": "openai",
      "role": "proposer",
      "tier": "external",
      "fallback_for": null
    },
    {
      "id": "p2",
      "adapter": "claude",
      "provider": "anthropic",
      "role": "critic",
      "tier": "external",
      "fallback_for": null
    }
  ],
  "independent_provider_coverage": true,
  "fallbacks_used": [],
  "blocked_reason": null,
  "scope": "working-tree",
  "web_scope": "off",
  "output_mode": "compact",
  "fake_coverage": false,
  "agreements": [],
  "pushbacks_resolved": [],
  "remaining_disagreements": [],
  "minor_reservations": [],
  "improvements": [],
  "operator_intervention_points": [],
  "evidence_summary": {
    "observed": [],
    "self_reported": [],
    "residual_asymmetry_risk": "low"
  },
  "recommended_next_actions": [],
  "transcript_path": "transcript.md",
  "evidence_ledger_path": "evidence-ledger.jsonl"
}
```

Blocked results carry `blocked_reason` (`preflight`, `adapter_failure`, `enforcement_violation`, `require_independent`, `no_progress`, `participant_declared`, or `unknown`). Results produced by any fake-tier participant set `fake_coverage: true` and append an explicit fake-coverage disclosure to the summary so test output can never pass as real deliberation. `result.json` is validated against contract invariants before it is written (for example, an `agreed` result cannot carry `remaining_disagreements`), and `turns.jsonl` readers tolerate a torn trailing line from a crash mid-append.

`remaining_disagreements` reports unresolved core pushbacks from each participant's latest control, not every pushback ever raised; pushbacks raised earlier and absent from the final round appear in `pushbacks_resolved`. `minor_reservations` disclose the smaller disagreements participants chose to live with when converging.

`independent_provider_coverage` is `true` only when every active participant slot was handled by an external or alternate participant from a different provider than the opposing slot. If a same-provider primary sub-agent fallback handles any turn, it is `false`, and the final summary must disclose degraded coverage. Operator-forced same-provider external pairings, such as `--counterpart codex` from a Codex host, also set `independent_provider_coverage: false`, but should be disclosed as an operator-selected same-provider debate rather than a fallback. With `--require-independent`, those same-provider or unavailable-coverage cases block before degraded work is accepted.

The host agent may share a provider with one participant. Independence is measured between active participant slots, not between the host and a participant. The host's provider matters only when a primary sub-agent fallback is used, because then coverage is degraded and must be disclosed.

## Fallbacks

Participant selection has three tiers:

1. External opposite-provider participant, preferred for independent perspective.
2. Explicitly configured alternate provider, if the preferred participant is unavailable.
3. Primary agent's own sub-agent as degraded fallback.

This follows the same product rule as `review-loop`: the default peer is the opposite agent, and the primary host's own agent path is only a degraded fallback when the opposite agent cannot run.

The "primary agent" is the host or launcher that invoked `converge-loop`, recorded as `host_agent` in `session.json`. A primary sub-agent fallback is launched through that host's participant adapter, not by recursively calling `converge-loop run`. In an `akx` session, fallback means a Codex-managed sub-agent or equivalent restricted same-provider path. In an `akc` session, fallback means a Claude-managed sub-agent or equivalent restricted same-provider path.

Fallback results must disclose the degraded coverage in `participants`, `fallbacks_used`, `independent_provider_coverage`, and the final summary.

## Permissions

Participants are read-only:

- no file edits
- no patches
- no commits
- no nested `converge-loop`
- no nested `review-loop`
- no delegation to untracked agents

Nested invocation is mechanically enforced: participant subprocesses run with `CONVERGE_LOOP_PARTICIPANT=1`, and `converge-loop run`/`resume` refuse to start when that sentinel is present. Participant subprocesses run in their own process group, and turn-timeout termination signals the whole group (SIGTERM, then SIGKILL) so grandchild processes cannot outlive a canceled turn.

Adapters must mechanically enforce read-only execution and per-call timeouts. If an adapter cannot enforce the same read-only scope and tool constraints as the other participant, it cannot participate in the session.

This permission rule applies to both file and web access. Provider-native tools outside the orchestrator allowlist are disabled. If disabling them cannot be proven, the adapter is unavailable for that run.

## Relationship to review-loop

The intended pipeline is:

```text
converge-loop deliberation
  -> conclusion.md or implementation plan
  -> optional implementation by the host agent
  -> review-loop review of the artifact or code
```

`converge-loop` may recommend running `review-loop`, but participant agents must not invoke `review-loop` from inside the deliberation. The host agent or operator can run `review-loop` after the conversation completes.

## Test Strategy

The runtime must be testable without live model providers. The core test seam is a deterministic participant adapter interface:

- `fake-sequence` adapter returns scripted turns from fixtures.
- `fake-replay` adapter replays recorded transcripts and control blocks.
- `fake-tooling` adapter emits observed file/web evidence and attempted write/tool violations.

Required test coverage:

- CLI parser and validation for every command and invalid option combination.
- Adapter capability intersection, including degraded fallback disclosure and fail-closed missing enforcement.
- Control parsing for schema-bound output, nonce-delimited fallback blocks, malformed retries, and repeated malformed output.
- Turn alternation, progress/no-progress detection, convergence attempt, late evidence request handling, and every terminal status.
- File/web evidence ledger recording, observed versus self-reported evidence, and residual asymmetry summary.
- Session persistence, schema versions, result export, ignored `.converge-loop/` protection, resume, background status, stale detection, and cancel.
- Read-only enforcement violation handling for attempted edit, patch, commit, nested `converge-loop`, nested `review-loop`, and unauthorized provider-native web use.

Live provider tests are smoke tests only. They should verify adapter preflight and one minimal foreground exchange when credentials are available, but they must not be required for deterministic CI. `converge-loop setup --smoke` is a local/manual verification path because it may spend model calls.

## MVP Implementation Plan

Build the runtime in risk-ordered slices. Each slice should leave the repo in a usable state and pass deterministic tests.

1. Command skeleton and fake loop.
   - Add `package.json`, `scripts/bin/converge-loop.mjs`, CLI parser, `run/status/result/cancel/resume` stubs, state directory resolution, and fake adapter support.
   - Acceptance: `converge-loop run --fake-adapters fake-sequence,fake-sequence --topic ...` executes a bounded foreground loop, persists session files with schema versions, and `result <id>` prints the normalized result.

2. Control contract and stopping policy.
   - Implement schema-bound control parsing, nonce fallback parsing, retry behavior, progress heuristic, materiality adjudication, convergence attempt, terminal statuses, and compact output.
   - Acceptance: fixture tests cover `agreed`, `clear_disagreement`, `needs_evidence`, `operator_intervention`, `blocked`, `max_turns`, and `timeout`.

3. Read-only file evidence and adapter capability preflight.
   - Implement file-scope validation, artifact/context validation, adapter capability intersection, observed/self-reported evidence model, and fail-closed read-only enforcement checks.
   - Acceptance: fake tooling proves same-scope file reads, branch scope requires `--base`, and write/patch/commit attempts stop as `blocked`.

4. Real local adapters.
   - Add Codex and Claude local CLI adapters only after their read-only flags, positive tool-allowlist behavior, timeout behavior, control-output support, and host/opposite selection can be proven in preflight.
   - Acceptance: `converge-loop setup` verifies Codex and Claude local CLI read-only controls plus non-model auth status and proves a tiny explicit Codex + Claude smoke exchange before enabling config-backed local adapters by default; `--no-smoke` keeps deterministic/offline readiness-only enablement; `--check-only` is non-mutating; `--disable` turns config-backed adapters off; explicit `--smoke` still refuses fake shortcuts; adapter preflight fails closed when setup has not succeeded or enforcement is unavailable; host aliases normalize correctly; from Codex, default selection pairs Codex with Claude Code; from Claude Code, default selection pairs Claude Code with Codex; background jobs persist normalized `host_agent`; default opposite-agent unavailability can fall back to the host adapter with degraded disclosure unless `--require-independent` is set; explicit `--counterpart`/`--fake-adapters` selections do not fallback implicitly; with available adapters, a minimal foreground two-agent run completes using the same file scope.

5. Shared web scope.
   - Add `--web shared` through an orchestrator-owned search/fetch tool, evidence logging for queries/URLs, and provider-native web disabling checks.
   - Acceptance: both participants receive identical shared web tool capability; unavailable symmetric web support downgrades to `off` only when web was not explicitly requested, otherwise blocks before launch.

6. Background, cancel, status, and resume.
   - Add job registry, heartbeat, stale detection, graceful cancel, and resumable session continuation.
   - Acceptance: tests cover active/stale/completed status, cancel terminal result, resume from an allowed state, and rejection from terminal agreed/blocked states.

7. Output modes, export, and docs.
   - Add verbose/quiet modes, repo-local export protection, command docs, and the handoff note that `review-loop` remains an external validation step.
   - Acceptance: output snapshots and export tests pass; documentation matches implemented commands.

v1 is done when slices 1-7 pass deterministic tests, the plugin validates, at least one real opposite-provider pairing passes adapter preflight in the maintainer environment, and unsupported adapters fail closed with actionable diagnostics.

## Product Decisions To Revisit Later

- Whether to support more than two active participants.
- Whether repo-local transcript export should write Markdown, JSON, or both by default.
- Whether to add a mediator role after v1.
- Whether evidence citations should be strict file:line references or best-effort summaries.
- Whether to add a hosted UI after the local CLI proves useful.

## Recommendation

Build `converge-loop` as a separate local plugin with only the `converge-loop` command. Let agents browse the repo directly, but enforce the same read-only scope and maintain an evidence ledger. Keep the live experience compact by default. Optimize for constructive pushback and convergence, not forced disagreement or deterministic gate semantics.
