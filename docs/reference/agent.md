# @demlik/tea/agent

> THE headline Level-3 machine: a durable, crash-recoverable AI agent that runs an ordered stage pipeline, and inside the agentic stage drives the classic loop `llm → tools → fold → llm` until the model stops asking for tools.

```ts
import { … } from "@demlik/tea/agent";
```

## Exports (60)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `agentBootMsg` | Function |  |
| `AgentBootMsg` | Type | The Msg `do/host`'s `autoBoot` fires to re-enter the agent's `boot` verb on rehydrate. |
| `AgentCmd` | Type | The Cmd union the agent emits, as a CLOSED discriminated union (precise `TC`, not the open `Cmd`) so `Interpret<M, AgentCmd<P, TC>, Ctx>` maps each key precisely and `toMachine` merges the interpret halves with no laundering cast: - `AgentLlmRunCmd<P>` — the brain-call run Cmd (`resilient_run`), folded by the wired `brainHandlers` cell. |
| `AgentCompactErrMsg` | Type | The compaction round-trip failure settle Msg — carries the typed LlmErr. |
| `AgentCompactionConfig` | Type | The compaction discriminant (#85), shaped exactly like AgentSnapshotConfig. |
| `AgentCompactOkMsg` | Type | The compaction round-trip success settle Msg — carries the parsed CompactionSummary. |
| `AgentCompactRunCmd` | Type | The "summarize the oldest N turns" effect Cmd — the compaction round-trip's carrier (#85). |
| `AgentConfig` | Type | The agent knob — the core seams intersected with the snapshotting discriminant (`AgentSnapshotConfig`). |
| `AgentConfigCore` | Interface | The core (non-snapshot, non-compaction) agent knob. |
| `AgentDetachedHandlers` | Type | The LEGACY detached brain-call handler dictionary `handlers(ports)` returns — the inherited `../llm-call` detached form's exact shape, NOT an `Interpret`. |
| `AgentEvent` | Type | The agent's PUBLIC lifecycle events — the semantic stream a consumer subscribes to via `runtime.on(type, …)` (#47). |
| `agentEvents` | Function |  |
| `AgentFailure` | Type | Why a run terminated as `failed`, beyond monitored-run's own reasons. |
| `AgentKnob` | Interface | The agent knob `createAgent` returns — the uniform verb contract every tea composition exposes, plus the wired `toMachine` and the `unsafeDetachedHandlers` escape hatch. |
| `AgentLlmErrMsg` | Type |  |
| `AgentLlmOkMsg` | Type | The brain-call success / failure settle Msgs, inherited from `../llm-call`. |
| `AgentLlmRunCmd` | Type | The brain-call effect Cmd, inherited from `../llm-call`. |
| `AgentMachineMsg` | Type | The agent machine's Msg union — one variant per reducer entry point. |
| `AgentPorts` | Type | Ports the consumer supplies to the llm-call handler — re-exported shape. |
| `AgentSnapshotConfig` | Type | The snapshotting discriminant (#55). |
| `AgentState` | Interface | The agent slice — every composed brick's slice plus the loop's conversation and the agent-specific failure annotation. |
| `AgentStatus` | Type | The agent's lifecycle status — THE single typed channel for "what is this run doing?" (issue #49). |
| `AgentTerminalFailure` | Type | The unified terminal failure (issue #49). |
| `AgentTimerMsg` | Type | The timer Msg (retry + safety deadline) — `DeadlineExceeded`, the shared shape of both bricks' timer Msgs (`LlmTimerMsg` and `MonitoredRunTimerMsg` are both `DeadlineExceeded`). |
| `AgentToMachine` | Type | The `toMachine` signature, parametrized on the `Snap` + `Compact` discriminants so the snapshotting / compaction overloads of `createAgent` hand back the right obligations. |
| `AgentTurn` | Interface | One model turn — the seed's `AiTurn`, generalized: the narration `content` the model produced and the `toolCalls` it asked us to run. |
| `agentTurnSchema` | Variable | The `Schema<AgentTurn>` for tea's own turn type — the parse target a brain call binds when the agentic purpose's output is a bare `AgentTurn` (the common case). |
| `Awaiting` | Type | Whether the agentic stage is waiting on the model (`llm`), on tools (`tools`), or on a compaction round-trip (`compacting`, #85). |
| `CompactInterpret` | Type | The CONFIG-DERIVED compaction obligation on `toMachine`'s `toolInterpret` (#85), the exact twin of SnapshotInterpret. |
| `COMPACTION_PURPOSE` | Variable | The reserved compaction purpose's value — the single in-flight summarize call's key. |
| `CompactionOutputs` | Interface | The purpose→output map for the compaction LLM call — the single reserved `$compact` purpose mapping to a CompactionSummary. |
| `CompactionPolicy` | Interface | The consumer's compaction policy (#85). |
| `CompactionPurpose` | Type | The reserved purpose the compaction round-trip runs under (#85). |
| `CompactionSummary` | Interface | The result a compaction round-trip produces — the model's summary of the folded-away turns. |
| `compactionSummarySchema` | Variable | The `Schema<CompactionSummary>` the compaction call binds — tea's own parse target for the summarize round-trip (it OWNS the `$compact` purpose's output). |
| `Conversation` | Interface | The agentic-stage conversation — durable inside the agent slice so an eviction mid-loop resumes the exact turn. |
| `createAgent` | Function |  |
| `deadlineSub` | Function | Re-export the deadline Sub primitives so consumers (and tests) wire one import: `subscribeDeadline` is the `subscribe` cell, `deadlineSub` builds the Sub literal both composed bricks' `subs` emit. |
| `DeadlineSub` | Type | The Sub variant a deadline produces. |
| `isAgentTurn` | Function |  |
| `isCompactionSummary` | Function |  |
| `liftAgent` | Function |  |
| `LlmCall` | Reference |  |
| `LlmErr` | Reference |  |
| `LlmFailMsg` | Reference |  |
| `LlmOk` | Reference |  |
| `LlmRunCmd` | Reference |  |
| `LlmSucceedMsg` | Reference |  |
| `mergeInterpret` | Function |  |
| `MessageLoader` | Reference |  |
| `ModelFactory` | Reference |  |
| `MonitoredRunCmd` | Type | The checkpoint-write Cmd, generic over the consumer's checkpoint value `V`. |
| `RunFailure` | Type | Why a run terminated as `failed`. |
| `Schema` | Reference |  |
| `SnapshotInterpret` | Type | The CONFIG-DERIVED snapshot obligation on `toMachine`'s `toolInterpret` (#55). |
| `status` | Function |  |
| `subscribeDeadline` | Variable | The `subscribe["deadline"]` cell. |
| `ToolCall` | Interface | One tool the model asked to call this turn — the seed's `ToolCall`, stripped of the audit-specific args typing. |
| `ToolOutcome` | Type | One settled tool outcome the consumer routes back into the loop — the seed's `ToolOutcome`. |
| `ToolRecord` | Interface | A folded tool record kept on the conversation once a tool settles — the call + its outcome, in settle order. |
