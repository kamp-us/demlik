# @demlik/tea/agent

> THE headline Level-3 machine: a durable, crash-recoverable AI agent that runs an ordered stage pipeline, and inside the agentic stage drives the classic loop `llm → tools → fold → llm` until the model stops asking for tools.

```ts
import { … } from "@demlik/tea/agent";
```

## Exports (98)

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
| `AgentMessage` | Type | One message the lid's `model` receives. |
| `AgentPorts` | Type | Ports the consumer supplies to the llm-call handler — re-exported shape. |
| `AgentPrompt` | Interface | The brain-call payload the lid builds from the durable state — everything `messagesOf` renders, so the prompt is a pure function of the Model and the resilient slice carries exactly what was sent. |
| `AgentSnapshotConfig` | Type | The snapshotting discriminant (#55). |
| `AgentState` | Interface | The agent slice — every composed brick's slice plus the loop's conversation and the agent-specific failure annotation. |
| `AgentStatus` | Type | The agent's lifecycle status — THE single typed channel for "what is this run doing?" (issue #49). |
| `AgentTerminalFailure` | Type | The unified terminal failure (issue #49). |
| `AgentTimerMsg` | Type | The timer Msg (retry + safety deadline) — `DeadlineExceeded`, the shared shape of both bricks' timer Msgs (`LlmTimerMsg` and `MonitoredRunTimerMsg` are both `DeadlineExceeded`). |
| `AgentToMachine` | Type | The `toMachine` signature, parametrized on the `Snap` + `Compact` discriminants so the snapshotting / compaction overloads of `createAgent` hand back the right obligations. |
| `AgentTurn` | Interface | One model turn — the seed's `AiTurn`, generalized: the narration `content` the model produced and the `toolCalls` it asked us to run. |
| `agentTurnSchema` | Variable | The `Schema<AgentTurn>` for tea's own turn type — the parse target a brain call binds when the agentic purpose's output is a bare `AgentTurn` (the common case). |
| `AnyToolDef` | Type | The declaration-erased view the router reads. |
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
| `defineAgent` | Function |  |
| `DefineAgentConfig` | Interface | What `defineAgent` takes: the three intents, plus the two run guards. |
| `DefinedAgent` | Interface | What `defineAgent` returns. |
| `DefinedAgentCtx` | Type | The ctx the tools' `needs` demand, intersected — what `run` asks for. |
| `DefinedAgentEvent` | Type | One lifecycle event a defined agent's run emits — AgentEvent with the tool results typed against this agent's own tool set. |
| `DefinedAgentMachine` | Type | The wired machine `defineAgent` builds per `input` — feed it to the raw `run`. |
| `DefinedAgentRunOptions` | Type | Host wiring for one `run`: the store, the ctx the tools need, a runId, a clock. |
| `DefinedAgentState` | Type | The Model a defined agent runs — a hand-wired `createAgent`'s, key for key. |
| `isAgentTurn` | Function |  |
| `isCompactionSummary` | Function |  |
| `isReservedToolName` | Function |  |
| `LidPurpose` | Type | The one purpose the lid's agent runs. |
| `liftAgent` | Function |  |
| `LlmCall` | Interface | One LLM call request — the resilient-call `input` for this knob, carried on the `resilient_run` Cmd as plain data (no closures, invariant 3). |
| `LlmErr` | Interface | The typed failure variant — every failure path surfaces this, tagged by purpose. |
| `LlmFailMsg` | Type |  |
| `LlmOk` | Interface | The parsed, typed success carried on the `resilient_ok` settle Msg, tagged with its purpose. |
| `LlmRunCmd` | Type | The effect Cmd the knob emits: run the LLM call for `key` with `input`. |
| `LlmSucceedMsg` | Type | The settle Msgs llm-call's handler RETURNS from `interpret` so the substrate enqueues them as follow-up Msgs (re-entry) into the host reducer — exactly as `../resilient-call` does. |
| `mergeInterpret` | Function |  |
| `MessageLoader` | Type | Build the `Msg[]` the handler hands to the bound model for a given call. |
| `ModelFactory` | Type | The model factory — the first DI port. |
| `ModelPort` | Type | Either model port. |
| `MonitoredRunCmd` | Type | The checkpoint-write Cmd, generic over the consumer's checkpoint value `V`. |
| `PLAIN_MODEL_MISROUTE_REASON` | Variable | The reason an `LlmErr` carries when a sync promise-returning function was passed as `model` bare — the one runtime shape neither port can own. |
| `plainModel` | Function |  |
| `PlainModel` | Type | The plain-function model port — the common path (#58). |
| `renderPrompt` | Function |  |
| `ReservedToolName` | Type | A tool name `tool()` refuses (#72). |
| `RunFailure` | Type | Why a run terminated as `failed`. |
| `Schema` | Interface | The minimal structured-output schema contract: `parse(unknown) => T`, the zod-style call the handler uses to validate the model's output before it settles `resilient_ok`. |
| `SnapshotInterpret` | Type | The CONFIG-DERIVED snapshot obligation on `toMachine`'s `toolInterpret` (#55). |
| `status` | Function |  |
| `subscribeDeadline` | Variable | The `subscribe["deadline"]` cell for the DEFAULT `setTimeout` backing. |
| `tool` | Function |  |
| `ToolCall` | Interface | One tool the model asked to call this turn — the seed's `ToolCall`, stripped of the audit-specific args typing. |
| `ToolCmd` | Type | The Cmd union a router's `toolOf` produces — `TC` for `createAgent`. |
| `ToolConstructors` | Type | The two constructors a handler is handed, one per channel — `ok` for the value the `ok` schema parses, `fail` for a declared `{ _tag }`. |
| `ToolDef` | Type | What `tool()` returns: the `Cmd.define`d constructor (so `Settled<typeof t>` / `CmdOf<typeof t>` read it like any def) plus the colocated `interpret` cell, the bare `args` schema the router parses a call against, and the `description` a provider adapter declares to the model beside that schema. |
| `toolErrorReason` | Function |  |
| `ToolFail` | Type | The typed failure constructor a handler receives: `fail({ _tag })` with `E` fixed to the declared tags, so the literal is checked against them where it is written. |
| `ToolHandler` | Type | A tool's handler: the parsed `args`, the ctx slice `needs` named, and the typed `{ ok, fail }`, to a result over the declared channels — `Ok` is what the `ok` schema parses, `E` the declared `_tag` union. |
| `ToolInput` | Type | The input a tool Cmd carries: the model's `callId` (the fan-out identity the settle folds back on) and the `args` already parsed against the tool's `input` schema — the boundary parses, the handler trusts. |
| `ToolMsg` | Type | The settled Msg union a router's cells return — folded by `toMachine`. |
| `ToolOk` | Type | The typed success constructor a handler receives: `ok(value)` with `Ok` fixed to what the `ok` schema parses, so a value of the wrong shape is refused where it is written. |
| `ToolOutcome` | Type | One settled tool outcome the consumer routes back into the loop — the seed's `ToolOutcome`. |
| `ToolRecord` | Interface | A folded tool record kept on the conversation once a tool settles — the call + its outcome, in settle order. |
| `ToolRejectedCmd` | Type | The Cmd `tool_rejected` builds — the router-owned variant of `ToolCmd`. |
| `ToolRejection` | Type | A call the router could not hand to a tool: the model named a tool nobody declared, or its `args` failed the tool's `input` schema. |
| `ToolResult` | Type | The union of every tool's `ok` value — `R` for `createAgent`. |
| `toolRouter` | Function |  |
| `ToolRouter` | Interface | What `toolRouter()` returns: the derived `toolOf` for `createAgent`'s config, the interpret table `toMachine({ tools })` merges, the defs it puts on `Machine.cmds`, and the one reader that turns a settled Msg back into the conversation's `ToolOutcome`. |
| `ToolSettlement` | Type | One settled tool, read back off a `ToolMsg` by `outcomeOf`. |
| `ToolThrown` | Type | The router-minted failure beside a tool's declared tags: the handler threw (or rejected) with something that is not a declared `{ _tag }`. |
| `WiredToolCmd` | Type | `ToolCmd<T>` as `toMachine` reads it: `never` for `T = never` — the "no router" reading it defaults to — so the router-owned `tool_rejected` arm does not leak into a machine that wired no router. |
| `WiredToolMsg` | Type | `ToolMsg<T>` as `toMachine` / `agentEvents` read it — see `WiredToolCmd`. |
