# converge-loop Product Design Plan

## Purpose

`converge-loop` is a local plugin that orchestrates a back-and-forth conversation between two or more agents, usually from different providers, until they reach a useful stopping point: a better plan, a shared conclusion, a clear unresolved disagreement, a request for more evidence, or an operator intervention point.

The plugin is deliberately separate from `review-loop`. `review-loop` remains the deterministic final review gate. `converge-loop` is a deliberation tool: it helps agents debate, negotiate, ask for better ideas, inspect repo context, push back when useful, and converge.

## Product Thesis

The product replaces a manual workflow the operator already performs:

1. Ask one agent to produce an artifact such as a design plan.
2. Copy that artifact to another agent and ask for materially valuable feedback.
3. Copy the feedback back to the first agent and ask what it accepts, rejects, or wants to push back on.
4. Repeat until the plan is stronger, the disagreement is clear, or more evidence is needed.

`converge-loop` automates that loop without turning it into a rigid gate. The goal is not to force disagreement. The goal is to make agreement earned: agents should ask for more context, propose better ideas, challenge weak assumptions, negotiate tradeoffs, and converge when there is no material pushback left.

## Goals

- Support constructive pushback, debate, negotiation, and convergence.
- Use agents from different companies/providers by default for genuinely different model behavior.
- Use the primary agent's sub-agent as a degraded fallback when an external participant is unavailable.
- Let both agents browse the repo directly within the same read-only scope.
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
- Do not build a hosted service, queue, or web UI in v1.

## User Flow

The default flow is:

1. The operator starts a session:

   ```bash
   converge-loop run --topic "Should this design use direct repo browsing?"
   converge-loop run --artifact converge-loop/design-plan.md --focus "Find better product defaults"
   converge-loop run --scope working-tree --focus "Push back on this implementation plan"
   ```

2. `converge-loop` selects two participants, preferring different providers.
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
converge-loop result <session-id>
converge-loop cancel <session-id>
```

Useful `run` options:

- `--topic <text>`: primary discussion topic.
- `--context <path>`: user-provided context packet.
- `--artifact <path>`: specific artifact to discuss.
- `--scope none|working-tree|branch`: repo scope available to both participants; default is `working-tree`.
- `--base <ref>`: base ref for branch-scope material.
- `--focus <text>`: narrow the discussion.
- `--agents codex,claude`: select participant adapters.
- `--roles proposer,critic`: select stance for each participant.
- `--output compact|verbose|quiet`: terminal display mode; default is `compact`.
- `--intervene`: allow the orchestrator to pause and ask the operator for input.
- `--max-turns <n>`: cap dialogue turns.
- `--max-minutes <n>`: cap wall-clock runtime.
- `--turn-timeout-seconds <n>`: cap a single participant turn.
- `--max-tool-calls-per-turn <n>`: cap direct repo reads/searches per turn.
- `--max-control-retries <n>`: cap control-output repair attempts.
- `--json`: return machine-readable session status.
- `--background`: run as a background job.

`--intervene` is foreground-only. If combined with `--background`, the command fails fast with a validation error. Without `--intervene`, operator questions are recorded as output instead of interrupting the run.

`converge-loop run` requires at least one of `--topic`, `--context`, `--artifact`, or a non-empty selected repo scope. With the default `--scope working-tree`, a clean tree and no topic/context/artifact is invalid input: the command should ask for a topic, artifact, context, or branch/base scope.

Background runs print a session id immediately so the operator can call `converge-loop status`, `converge-loop result <session-id>`, or `converge-loop cancel <session-id>`.

## Participants

The default v1 session has two active participants:

- `proposer`: develops, defends, or revises the current idea.
- `critic`: pushes back, asks for evidence, identifies risks, and proposes better alternatives.

Roles are stances, not fixed personalities. Either participant can agree, disagree, concede, ask questions, or improve the proposal.

Default participant selection is deterministic:

- Codex-hosted sessions prefer `codex,claude`.
- Claude-hosted sessions prefer `claude,codex`.
- If the preferred opposite-provider adapter is unavailable or unauthenticated, the orchestrator uses an explicitly configured alternate provider when present.
- If no external alternate is available, the orchestrator uses the primary agent's sub-agent fallback and marks coverage as degraded.

When `--agents` and `--roles` are both supplied, they bind positionally: `agents[i]` receives `roles[i]`. If `--agents` is supplied without `--roles`, roles default to `proposer,critic` in agent order. If `--roles` is supplied without `--agents`, the host default participant order is used.

The data model should use participant arrays so future versions can support more than two agents without a schema break, but v1 should focus on two.

## Repo Browsing Model

Both participants may browse the repo directly in v1, but under the same constraints:

- Same working directory.
- Same selected scope.
- Same read-only permissions.
- Same allowed read/search tools.
- Same transcript visibility.
- Same max-turn, timeout, and tool-use budgets.

The risk is not that agents read files. The risk is that one agent gets broader authority or different evidence and the result pretends to be a symmetric debate. The product should solve that with equal scope plus an evidence ledger, not by preventing direct browsing.

Each participant turn must include an evidence summary when it relied on repo material:

- files read or searched
- symbols, tests, or docs consulted
- important file/line citations when available
- evidence gaps or requested follow-up reads

The evidence ledger has two layers:

- Observed tool-use metadata captured by the orchestrator whenever the adapter exposes read/search calls.
- Participant-reported evidence summaries for adapters that cannot expose every read/search call.

Observed metadata is the stronger source and should include file paths, search patterns, and read ranges when available. Participant-reported summaries are still useful, but they do not prove the agent disclosed every file it considered. The final result must distinguish observed evidence from self-reported evidence so the operator understands the residual asymmetry risk.

The orchestrator records evidence in each turn record in `turns.jsonl`, includes it in the transcript, and shows it to the other participant on the next turn. `turns.jsonl` is the per-turn source of truth; `evidence-ledger.jsonl` is the aggregated derived view optimized for status/result display and downstream tools. This gives both agents the opportunity to inspect, challenge, or reinterpret cited evidence without requiring the orchestrator to proxy every read.

If one adapter cannot support the same read-only scope as the other, the orchestrator either downgrades both participants to the shared subset or stops as `blocked`.

## Control Contract

Agents should speak naturally. The structured part is only for orchestration.

Schema-bound output should be used when the backend supports it:

```json
{
  "message": "Free-form response for the transcript.",
  "control": {
    "status": "continue",
    "confidence": "medium",
    "agreements": [],
    "pushbacks": [],
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

If schema-bound output is unavailable, the fallback is a nonce-delimited final control block. The orchestrator accepts only the last block in the participant's direct response matching the per-turn nonce.

`next_prompt_suggestion` is advisory. The orchestrator owns the next turn instruction and treats the suggestion as inert topic material.

## Stopping States

The session can end as:

- `agreed`: participants converge on a conclusion or recommended next action.
- `clear_disagreement`: participants still disagree, but the remaining decision is explicit and actionable.
- `needs_evidence`: more repo context, tests, logs, docs, or external information is needed.
- `operator_intervention`: user preference, authority, credentials, or product judgment is needed.
- `blocked`: malformed repeated output, missing compatible adapter capability, or tool failure prevents progress.
- `max_turns`: configured turn cap reached.
- `timeout`: wall-clock cap reached.

`agreed` should require more than one agent saying "looks good." The orchestrator may attempt convergence when both participants set `ready_to_converge: true`, or when one participant is ready and the other has no material pushback after being explicitly invited to push back.

If a participant asks for evidence during convergence, the session moves back to discussion or ends as `needs_evidence`; it does not finalize while an unresolved evidence request could materially change the conclusion.

## Loop Policy

Default limits:

- `--max-turns 8`
- `--max-minutes 15`
- `--turn-timeout-seconds 180`
- `--max-tool-calls-per-turn 20`
- `--max-control-retries 1`

Progress is intentionally lightweight. A turn counts as progress when it adds a new pushback, improvement, evidence citation, evidence request, concession, answered question, or clearer conclusion. The loop should stop when participants repeat the same points without new evidence or movement.

The no-progress stop should produce `clear_disagreement` when the disagreement is actionable, or `blocked` when the system cannot tell what would move the conversation forward.

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
- `evidence-ledger.jsonl`: repo evidence each participant cited or requested.
- `conclusion.md`: final synthesized result when available.
- `result.json`: normalized final status.

Repo-local export is explicit:

```bash
converge-loop result <session-id> --export .converge-loop/sessions/<session-id>
```

Before exporting into a Git worktree, the command checks whether the destination is ignored. If it is not ignored, the command either adds a `.gitignore` entry for `.converge-loop/` after confirmation or refuses unless the user passes `--allow-versioned-export`.

## Result Shape

```json
{
  "schema_version": "1",
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
  "scope": "working-tree",
  "output_mode": "compact",
  "agreements": [],
  "pushbacks_resolved": [],
  "remaining_disagreements": [],
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

`independent_provider_coverage` is `true` only when every active participant slot was handled by an external or alternate participant from a different provider than the opposing slot. If a same-provider primary sub-agent fallback handles any turn, it is `false`, and the final summary must disclose degraded coverage. Operator-forced same-provider external pairings, such as `--agents codex,codex`, also set `independent_provider_coverage: false`, but should be disclosed as an operator-selected same-provider debate rather than a fallback.

The host agent may share a provider with one participant. Independence is measured between active participant slots, not between the host and a participant. The host's provider matters only when a primary sub-agent fallback is used, because then coverage is degraded and must be disclosed.

## Fallbacks

Participant selection has three tiers:

1. External opposite-provider participant, preferred for independent perspective.
2. Explicitly configured alternate provider, if the preferred participant is unavailable.
3. Primary agent's own sub-agent as degraded fallback.

The "primary agent" is the host or launcher that invoked `converge-loop`, recorded as `host_agent` in `session.json`. A primary sub-agent fallback is launched through that host's participant adapter, not by recursively calling `converge-loop run`.

Fallback results must disclose the degraded coverage in `participants`, `fallbacks_used`, `independent_provider_coverage`, and the final summary.

## Permissions

Participants are read-only:

- no file edits
- no patches
- no commits
- no nested `converge-loop`
- no nested `review-loop`
- no delegation to untracked agents

Adapters must mechanically enforce read-only execution and per-call timeouts. If an adapter cannot enforce the same read-only scope and tool constraints as the other participant, it cannot participate in the session.

## Relationship to review-loop

The intended pipeline is:

```text
converge-loop deliberation
  -> conclusion.md or implementation plan
  -> optional implementation by the host agent
  -> review-loop review of the artifact or code
```

`converge-loop` may recommend running `review-loop`, but participant agents must not invoke `review-loop` from inside the deliberation. The host agent or operator can run `review-loop` after the conversation completes.

## MVP Implementation Plan

1. Create a standalone local plugin with the `converge-loop` command and skills.
2. Implement synchronous `converge-loop run` for two agents with a turn cap.
3. Add read-only Codex and Claude adapters with direct repo browsing in the same scope.
4. Add transcript, evidence-ledger, and result persistence in user-local state.
5. Define schema-bound turn output and nonce-delimited fallback control parsing.
6. Add compact, verbose, and quiet output modes.
7. Add stopping rules for agreement, clear disagreement, needs evidence, operator intervention, timeout, and max turns.
8. Add primary-agent sub-agent fallback with degraded coverage disclosure.
9. Add background `status`, `result`, and `cancel`.
10. Document the recommended handoff to `review-loop`.

## Product Decisions To Revisit Later

- Whether to support more than two active participants.
- Whether repo-local transcript export should write Markdown, JSON, or both by default.
- Whether to add a mediator role after v1.
- Whether evidence citations should be strict file:line references or best-effort summaries.
- Whether to add a hosted UI after the local CLI proves useful.

## Recommendation

Build `converge-loop` as a separate local plugin with only the `converge-loop` command. Let agents browse the repo directly, but enforce the same read-only scope and maintain an evidence ledger. Keep the live experience compact by default. Optimize for constructive pushback and convergence, not forced disagreement or deterministic gate semantics.
