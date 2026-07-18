# 0004 — An opt-in context-compaction seam on `createAgent`

- **Status:** Accepted
- **Date:** 2026-06-23
- **Scope:** the `@demlik/tea/agent` subpath — `createAgent`'s config
  (`AgentCompactionConfig` / `CompactionPolicy`), the `Conversation` /
  `ToolRecord` / `Awaiting` slice shapes, the `settleTool` compaction trigger,
  the `compact_ok` / `compact_err` fold-back verbs, and the `compact_run` /
  `compact_ok` / `compact_err` protocol discriminants. Resolves issue #85.

## Context

The brain-call prompt for the agentic loop is assembled by the consumer's
`loadMessages` (`MessageLoader`), which reads `conversation.turns` +
`conversation.toolRecords`. Both lists only ever APPEND — `turn()` appends a
model turn, `settleTool()` appends a tool record. The run guards that exist
(`maxTurns`, `deadlineMs`, `snapshotEvery`) *cap* a run; none *compress* the
transcript. So a long ReAct journey grows the prompt unbounded → context-window
overflow, rising token cost, degraded quality. The only compaction seam today is
the consumer hand-rolling it inside `loadMessages` — but the context wall is
generic, so it belongs in the agent layer, not re-derived per consumer.

The transcript has grown and is about to be *spent* at exactly one place:
`settleTool()`'s "batch drained → fire next brain call" tail. `advanceStage`
starts a fresh conversation per stage and the seed/boot brain call runs on an
empty conversation — neither needs compaction. So the trigger is a single point.

## Decision

`createAgent` gains an **opt-in context-compaction seam**: a transcript
snapshot-and-compact step that, before firing a brain call, can fold the oldest
turns into a single model-produced summary. It is shaped exactly like the
snapshotting discriminant (#55) — off by default, and a short agent cannot even
mention the machinery. Four design forks were resolved:

- **A1 — summary representation.** The summary is a synthetic `AgentTurn` (no
  tool calls) carrying the summary text; compaction REPLACES `turns[0..N]` AND
  their tool records with `[summaryTurn]`. `loadMessages` is unchanged — it sees
  a shorter `turns` whose head is a normal turn (no watermark to learn). The cost
  is one honest field: `ToolRecord.turn` (the `turnCount` at fold time) so the
  fold-back drops the RIGHT records. Rejected A2 (a separate `summary` +
  `compactedThrough` watermark on `Conversation`), which pushes the generic
  concern back onto every consumer's `loadMessages` — the thing #85 removes.

- **B1 — compaction transport.** A DEDICATED round-trip: a `compact_run` Cmd, a
  `compact_ok` / `compact_err` settle Msg, an `Awaiting { kind: "compacting" }`
  variant, and its own interpret cell — structurally mirroring the brain call.
  The resilient brick is composed INSIDE it (a second resilient-call slice keyed
  on the reserved `$compact` purpose), so compaction inherits retry/backoff
  WITHOUT sharing the brain call's breaker or retry counter; the re-issued
  `resilient_run` is re-keyed to `compact_run` at the agent boundary (the
  `with-resilience` re-keying discipline). The consumer owns the `compact_run`
  cell — the summarize I/O — exactly as it owns tool I/O via `toolOf`. Rejected
  B2 (reserve a compaction *purpose* and ride the existing `llm-call` seam),
  which bends `turnOf(stage): P` (compaction is not stage-driven) and muddies the
  purpose union.

- **Compaction does NOT count toward `maxTurns`.** It is not model *reasoning*
  progress; counting it would let compaction trip the livelock guard on long runs
  — the exact runs that need it. It DOES bump the monitored-run watchdog
  (`run.progress`): a compaction round-trip is liveness. A `compacting` run
  reports `running` from `status()` (no new public status kind, no new resumable
  case — resumability stays exactly "awaiting tools").

- **Ship an ADR.** Compaction adds a durable round-trip + a new `Awaiting`
  variant — an architecture-level seam like #55 / #70 — so it is recorded here,
  not buried in a feature PR.

Replay/determinism (design D) needs no new seam: `planCompaction` is PURE (no
clock/RNG → replay re-decides identically), and the summary text — model output,
hence nondeterministic — is replay-safe because it arrives back through the Msg
log (`compact_ok`) and is folded by a pure reducer, the same contract brain turns
already honor. `compact_err` on exhausted retry PROCEEDS WITHOUT COMPACTING
(errors are data): a failed summarize is an optimization miss, never a wedge —
the brain call's own resilient retry and the deadline watchdog still bound the
un-compacted continuation.

`toMachine` config-derives the `compact_run` interpret cell — REQUIRED when a
policy is present, FORBIDDEN (`{ compact_run?: never }`) when absent — the exact
type-lie-killer #55 established for `snapshot_write`. No silent no-op cell: an
agent with no policy never emits `compact_run`, so the consumer cannot wire it;
an agent with a policy must.

## Consequences

- **Long ReAct runs stop overflowing the context window.** A consumer hands
  `createAgent` a `CompactionPolicy` (one pure `planCompaction` heuristic — char
  length, turn count, a real deterministic tokenizer) and the agent folds the
  oldest turns into a summary mid-loop, transparently to `loadMessages`.
- **The generic concern leaves consumer code.** The hand-rolled
  compaction-inside-`loadMessages` each consumer was about to write is now one
  config field, durable and replayable like every other agent brick.
- **Two independent opt-in discriminants compose.** `createAgent` is now
  overloaded on the snapshot × compaction grid; both default OFF, so existing
  agents are unaffected and pay nothing.
- **Cost:** a second resilient-call slice on every agent Model (empty when no
  compaction is in flight, so JSON-stable and cheap), one new field on
  `ToolRecord`, and a third `Awaiting` variant. The summary text is the
  consumer's `compact_run` cell's responsibility, so the agent owns no second
  model-prompt assembly.
