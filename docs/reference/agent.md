# @demlik/tea/agent

> THE headline Level-3 machine: a durable, crash-recoverable AI agent that runs an ordered stage pipeline, and inside the agentic stage drives the classic loop `llm → tools → fold → llm` until the model stops asking for tools.

```ts
import { … } from "@demlik/tea/agent";
```

## Start here

The exports below are alphabetical, which says nothing about where to begin.
These are the ones to read first:

| Symbol | Reach for it when |
| --- | --- |
| `defineAgent` | You want an agent: a model, the tools it may call, instructions. This is the entry point — `run(input)` drives it to its finished state. |
| `tool` | Declare one thing the model may call — its input/result schemas, the failures it may name, and the handler. |
| `ToolOutcome` | Read what a settled call hands back, whether it succeeded or failed. |
| `DefinedAgentState` | Type the Model a defined agent persists — what a `Store` reads and writes. |
| `createAgent` | Drop below the lid, once you need to walk a stage pipeline `defineAgent` does not express. |

## Exports (131)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `agentBootMsg` | Function | The do↔agent boot port: construct the `agent_boot` Msg `autoBoot` dispatches on a resumable rehydrate. |
| `AgentBootMsg` | Type | The Msg `do/host`'s `autoBoot` fires to re-enter the agent's `boot` verb on rehydrate. |
| `agentCancelMsg` | Function | Construct the `agent_cancel` Msg an abort dispatches. |
| `AgentCancelMsg` | Type | The Msg an aborted `AbortSignal` fires to settle the run `cancelled`. |
| `AgentCmd` | Type | The Cmd union the agent emits, as a CLOSED discriminated union (precise `TC`, not the open `Cmd`) so `Interpret<M, AgentCmd<P, TC>, Ctx>` maps each key precisely and `toMachine` merges the interpret halves with no laundering cast: - `AgentLlmRunCmd<P>` — the brain-call run Cmd (`resilient_run`), folded by the wired `brainHandlers` handler. |
| `AgentCompactErrMsg` | Type | The compaction round-trip failure settle Msg — carries the typed LlmErr. |
| `AgentCompactionConfig` | Type | The compaction discriminant, shaped exactly like AgentSnapshotConfig. |
| `AgentCompactOkMsg` | Type | The compaction round-trip success settle Msg — carries the parsed CompactionSummary. |
| `AgentCompactRunCmd` | Type | The "summarize the oldest N turns" effect Cmd — the compaction round-trip's carrier. |
| `AgentConfig` | Type | The agent configuration — the core seams intersected with the snapshotting discriminant (`AgentSnapshotConfig`). |
| `AgentConfigCore` | Interface | The core (non-snapshot, non-compaction) agent configuration. |
| `AgentDetachedHandlers` | Type | The LEGACY detached brain-call handler dictionary `handlers(ports)` returns, superseded by the `Interpret` table `AgentKnob.toMachine()` wires — reach for `toMachine()` unless you are hand-wiring the verbs yourself. |
| `AgentEvent` | Type | The agent's PUBLIC lifecycle events — the semantic stream a consumer subscribes to via `runtime.on(type, …)`. |
| `agentEvents` | Function | Project one APPLIED agent transition `(msg, state)` to its semantic AgentEvents — the `events` projector a consumer passes to `run(machine, { events: agentEvents() })` to light up `runtime.on(...)`. |
| `AgentFailure` | Type | Why a run terminated as `failed`, beyond monitored-run's own reasons. |
| `AgentKnob` | Interface | The agent handle `createAgent` returns — the uniform verb contract every tea composition exposes, plus the wired `toMachine` and the `unsafeDetachedHandlers` escape hatch. |
| `AgentLlmErrMsg` | Type | The brain-call FAILURE settle Msg, inherited from `../llm-call` — it re-enters the agent's `fail` verb, which backs off via the retry ladder rather than ending the run. |
| `AgentLlmOkMsg` | Type | The brain-call SUCCESS settle Msg, inherited from `../llm-call`. |
| `AgentLlmRunCmd` | Type | The brain-call effect Cmd, inherited from `../llm-call`. |
| `AgentMachineMsg` | Type | The agent machine's Msg union — one variant per reducer entry point. |
| `AgentMessage` | Type | One message a `defineAgent` `model` receives. |
| `AgentPorts` | Type | Ports the consumer supplies to the llm-call handler — re-exported shape. |
| `AgentPrompt` | Interface | The brain-call payload `defineAgent` builds from the durable state — everything `messagesOf` renders, so the prompt is a pure function of the Model and the resilient slice carries exactly what was sent. |
| `AgentSnapshotConfig` | Type | The snapshotting discriminant. |
| `AgentState` | Interface | The agent slice — every composed wrapper's slice plus the loop's conversation and the agent-specific failure annotation. |
| `AgentStatus` | Type | The agent's lifecycle status — THE single typed channel for "what is this run doing?". |
| `AgentTerminalFailure` | Type | The unified terminal failure the agent settles on. |
| `AgentTimerMsg` | Type | The timer Msg (retry + safety deadline) — `DeadlineExceeded`, the shared shape of both composed wrappers' timer Msgs (`LlmTimerMsg` and `MonitoredRunTimerMsg` are both `DeadlineExceeded`). |
| `AgentToMachine` | Type | The `toMachine` signature, parametrized on the `Snap` + `Compact` discriminants so the snapshotting / compaction overloads of `createAgent` hand back the right obligations. |
| `AgentTurn` | Interface | One model turn: the narration `content` the model produced and the `toolCalls` it asked us to run. |
| `agentTurnSchema` | Variable | The `Schema<AgentTurn>` for tea's own turn type — the parse target a brain call binds when the agentic purpose's output is a bare `AgentTurn` (the common case). |
| `AnyToolDef` | Type | The declaration-erased view the router reads. |
| `Awaiting` | Type | Whether the agentic stage is waiting on the model (`llm`), on tools (`tools`), or on a compaction round-trip (`compacting`). |
| `CompactInterpret` | Type | The CONFIG-DERIVED compaction obligation on `toMachine`'s `toolInterpret` — the exact twin of SnapshotInterpret. |
| `COMPACTION_PURPOSE` | Variable | The reserved compaction purpose's value — the single in-flight summarize call's key. |
| `CompactionOutputs` | Interface | The purpose→output map for the compaction LLM call — the single reserved `$compact` purpose mapping to a CompactionSummary. |
| `CompactionPolicy` | Interface | The consumer's compaction policy. |
| `CompactionPurpose` | Type | The reserved purpose the compaction round-trip runs under. |
| `CompactionSummary` | Interface | The result a compaction round-trip produces — the model's summary of the folded-away turns. |
| `compactionSummarySchema` | Variable | The `Schema<CompactionSummary>` the compaction call binds — tea's own parse target for the summarize round-trip (it OWNS the `$compact` purpose's output). |
| `Conversation` | Interface | The agentic-stage conversation — durable inside the agent slice so an eviction mid-loop resumes the exact turn. |
| `createAgent` | Function | Assemble an agent from `config` — the model, the stages it walks, and how a tool call is turned into a command — and get back its `init`, verbs and `subs` plus a `toMachine()` that wires all of it into one machine you hand to `run`, which is the layer to reach for only once `defineAgent` cannot express the run you want — a newcomer starts there, not here. |
| `deadlineSub` | Function | Re-export the deadline Sub primitives so consumers (and tests) wire one import: `subscribeDeadline` is the `subscribe` handler, `deadlineSub` builds the Sub literal both composed wrappers' `subs` emit. |
| `DeadlineSub` | Type | The Sub variant a deadline produces. |
| `defineAgent` | Function | Define an agent from a model, the tools it may call and its instructions, and get back `run(input)` — a promise of the finished state — plus `machine(input)` for driving the same run yourself, which is the entry point a newcomer picks, `createAgent` being the layer underneath that you drop to only to walk a stage pipeline of your own. |
| `DefineAgentCompaction` | Interface | The lid's compaction budget: the two numbers that say when a transcript is too long and how much of it survives the fold. |
| `DefineAgentConfig` | Interface | What `defineAgent` takes: the model, the tools and the instructions, plus the four optional guards that stop a run — `maxTurns`, `deadlineMs`, `maxElapsedMs` and `stopWhen` — and the one that keeps a run going, `retry`, the brain call's backoff ladder. |
| `DefinedAgent` | Interface | What `defineAgent` returns. |
| `DefinedAgentCmd` | Type | The Cmd union a defined agent's machine emits — one interpret cell per member. |
| `DefinedAgentCtx` | Type | The ctx the tools' `needs` demand, intersected — what `run` asks for. |
| `DefinedAgentEvent` | Type | One lifecycle event a defined agent's run emits — AgentEvent with the tool results typed against this agent's own tool set. |
| `DefinedAgentInterpret` | Type | The interpret table of the machine `defineAgent` wired: one cell per DefinedAgentCmd, keyed by its `type` — a tool's own Cmd type, the router's `tool_rejected`, and the agent-owned brain call. |
| `DefinedAgentMachine` | Type | The wired machine `defineAgent` builds per `input` — feed it to the raw `run`. |
| `DefinedAgentModel` | Type | The brain a defined agent runs, in either of its two shapes: - `async (messages) => turn` — the plain port, and the common path. |
| `DefinedAgentMsg` | Type | The Msg union a defined agent's machine folds. |
| `DefinedAgentOverlay` | Interface | What `defineAgent(cfg).with(...)` takes — the one documented wrap point over the machine the lid built. |
| `DefinedAgentResolvedState` | Type | The Model `run` RESOLVES with — DefinedAgentState whose `run` slice is narrowed to the ended phases (EndedRun). |
| `DefinedAgentRunOptions` | Type | Host wiring for one `run`: the store, the ctx the tools need, a runId, a clock. |
| `DefinedAgentState` | Type | The Model a defined agent runs — a hand-wired `createAgent`'s, key for key. |
| `EndedRun` | Type | The ENDED phases — a run that finished (`done`) or was stopped from outside (`cancelled`). |
| `fanOutInterpret` | Function | Give a router's interpret cells real wall-clock overlap without touching the kernel — pass the table `toolRouter` built, get back one whose cells launch their tool and RETURN, so `runInterpret` reaches the next Cmd of the turn while the first tool is still running. |
| `InterpretOverlay` | Type | One decorator per interpret cell you name: it receives the cell the agent wired (`next`) and returns the cell that runs in its place. |
| `isAgentTurn` | Function | Narrow an unknown to an `AgentTurn` — the runtime witness for tea's own structured-output type. |
| `isCompactionSummary` | Function | Narrow an unknown to a CompactionSummary — the runtime witness for the compaction call's structured output. |
| `isReservedToolName` | Function | Whether `name` is one `tool()` refuses — the set `ReservedToolName` types. |
| `isStreamingModel` | Function | Whether a model port wants the ModelStream — read off its declared arity, which is the mark JavaScript already carries. |
| `LidPurpose` | Type | The one purpose a `defineAgent` agent runs. |
| `liftAgent` | Function | Lift an agent result `[slice, cmds]` into a host `[State, cmds]` where the slice lives at `state.agent`. |
| `LlmCall` | Interface | One LLM call request — the resilient-call `input` for this module, carried on the `resilient_run` Cmd as plain data — no closures, so it survives persistence and replay. |
| `LlmErr` | Interface | The typed failure variant — every failure path surfaces this, tagged by purpose. |
| `LlmFailMsg` | Type | The FAILURE settle Msg (`resilient_err`) — resilient-call's `FailMsg` with its `error: unknown` narrowed to the typed `LlmErr`, so the host reducer reads the purpose, the reason and the raw payload without a cast. |
| `LlmOk` | Interface | The parsed, typed success carried on the `resilient_ok` settle Msg, tagged with its purpose. |
| `LlmRunCmd` | Type | The effect Cmd this module emits: run the LLM call for `key` with `input`. |
| `LlmSucceedMsg` | Type | The settle Msgs llm-call's handler RETURNS from `interpret` so the substrate enqueues them as follow-up Msgs (re-entry) into the host reducer — exactly as `../resilient-call` does. |
| `mergeInterpret` | Function | Join two `Interpret` dictionaries over DISJOINT Cmd subsets `A` and `B` (over the same Msg union `M` and Ctx) into the full `Interpret<M, A \| B, Ctx>`. |
| `MessageLoader` | Type | Build the `Msg[]` the handler hands to the bound model for a given call. |
| `ModelFactory` | Type | The model factory — the first DI port. |
| `ModelPort` | Type | Either model port. |
| `ModelStream` | Interface | The side channel a StreamingModel writes its deltas to — the second argument of the streaming port. |
| `MonitoredRunCmd` | Type | The checkpoint-write Cmd, generic over the consumer's checkpoint value `V`. |
| `PLAIN_MODEL_MISROUTE_REASON` | Variable | The reason an `LlmErr` carries when a sync promise-returning function was passed as `model` bare — the one runtime shape neither port can own. |
| `plainModel` | Function | Lift a plain-function model into the `ModelFactory` port. |
| `PlainModel` | Type | The plain-function model port — the common path. |
| `renderPrompt` | Function | The prompt as messages: the head, then each turn with its tool outcomes. |
| `ReservedToolName` | Type | A tool name `tool()` refuses. |
| `RunFailure` | Type | Why a run terminated as `failed`. |
| `Schema` | Interface | The minimal structured-output schema contract: `parse(unknown) => T`, the zod-style call the handler uses to validate the model's output before it settles `resilient_ok`. |
| `SnapshotInterpret` | Type | The CONFIG-DERIVED snapshot obligation on `toMachine`'s `toolInterpret`. |
| `status` | Function | Ask where an agent run stands: pass its state, get back one of `idle`, `running`, `suspended` (with the tool calls it is waiting on), `done` (with the output) or `failed` (with the failure). |
| `StreamingModel` | Type | The streaming model port — `(messages, { onChunk }) => Promise<AgentTurn>`. |
| `subscribeDeadline` | Variable | The `subscribe["deadline"]` handler for the DEFAULT `setTimeout` backing. |
| `TaggedFailure` | Type | The failure arm typed against a KNOWN tag union — `{ kind, reason }` beside each arm of `E`, distributed, so a `switch` on `_tag` narrows the payload and an unhandled tag is a compile error. |
| `tool` | Function | Declare one tool the model may call — its name, the schemas for its arguments and result, the failures it may return and the handler that runs it — and get back a `Cmd<T, E, R>` definition, whose `T` is what `ok` parses and whose `E` is the `err` tag union, that you pass to `toolRouter` or `defineAgent`. |
| `TOOL_RETRY_EXHAUSTED_TAG` | Variable | The reason-tag a tool call that spent its retry budget settles under. |
| `TOOL_TIMEOUT_TAG` | Variable | The reason-tag a timed-out tool call settles under. |
| `ToolCall` | Interface | One tool the model asked to call this turn. |
| `ToolCmd` | Type | The Cmd union a router's `toolOf` produces — `TC` for `createAgent`. |
| `ToolConstructors` | Type | The two constructors a handler is handed, one per channel — `ok` for the value the `ok` schema parses, `fail` for a declared `{ _tag }`. |
| `ToolDef` | Type | What `tool()` returns: the `Cmd.define`d constructor (so `Settled<typeof t>` / `CmdOf<typeof t>` read it like any def) plus the colocated `interpret` handler, the bare `args` schema the router parses a call against, and the `description` a provider adapter declares to the model beside that schema. |
| `ToolError` | Type | Every failure a router over `T` can settle with — the union `outcomeOf`'s error arm is typed from. |
| `ToolErrorContext` | Interface | Which call an `onToolError` failure belongs to: the model's `callId` — the fan-out identity the outcome folds back on — and the tool `name` the model asked for, which for an `unknown_tool` is the name it invented rather than any declared tool. |
| `toolErrorReason` | Function | Turn a tool failure into the human-readable reason string the conversation carries — pass the `{ _tag, ...detail }` a tool failed with, get the tag followed by any remaining detail as JSON. |
| `ToolFail` | Type | The typed failure constructor a handler receives: `fail({ _tag })` with `E` fixed to the declared tags, so the literal is checked against them where it is written. |
| `ToolFailure` | Interface | A settled tool failure as the conversation keeps it: the `{ _tag, …payload }` the tool failed with, spread beside the `reason` string the model reads. |
| `ToolFailureOf` | Type | The error outcome a router over `T` produces: `{ kind: "error", _tag, …payload, reason }`, discriminable on `_tag` over ToolError. |
| `ToolHandler` | Type | A tool's handler: the parsed `args`, the ctx slice `requires` named, and the typed `{ ok, fail }`, to a result over the declared channels — `Ok` is what the `ok` schema parses, `E` the declared `_tag` union. |
| `ToolInput` | Type | The input a tool Cmd carries: the model's `callId` (the fan-out identity the settle folds back on) and the `args` already parsed against the tool's `input` schema — the boundary parses, the handler trusts. |
| `ToolMsg` | Type | The settled Msg union a router's handlers return — folded by `toMachine`. |
| `ToolOk` | Type | The typed success constructor a handler receives: `ok(value)` with `Ok` fixed to what the `ok` schema parses, so a value of the wrong shape is refused where it is written. |
| `ToolOutcome` | Type | One settled tool outcome the consumer routes back into the loop. |
| `ToolRecord` | Interface | A folded tool record kept on the conversation once a tool settles — the call + its outcome, in settle order. |
| `ToolRejectedCmd` | Type | The Cmd `tool_rejected` builds — the router-owned variant of `ToolCmd`. |
| `ToolRejection` | Type | A call the router could not hand to a tool: the model named a tool nobody declared, or its `args` failed the tool's `input` schema. |
| `ToolResilience` | Interface | The per-tool resilience knob — a timeout, a retry ladder, or both, declared on the `tool()` spec and executed by the agent's reducer through `../internal/resilience/resilient-call`. |
| `ToolResilienceError` | Type | The two failures the resilience ladder itself authors — `timeout` and `retry_exhausted`. |
| `ToolResult` | Type | The union of every tool's `ok` value — `R` for `createAgent`. |
| `ToolRetryExhausted` | Interface | A call that spent its retry budget — ToolResilience.retry. |
| `toolRouter` | Function | Fold a set of `tool()`s into one router — pass it the tools, get back the lookup `createAgent` needs, the handlers `toMachine` merges, and a reader that turns a settled message back into a plain outcome. |
| `ToolRouter` | Interface | What `toolRouter()` returns: the derived `toolOf` for `createAgent`'s config, the interpret table `toMachine({ tools })` merges, the defs it puts on `Machine.cmds`, and the one reader that turns a settled Msg back into the conversation's `ToolOutcome`. |
| `ToolSettlement` | Type | One settled tool, read back off a `ToolMsg` by `outcomeOf`. |
| `ToolThrown` | Type | The router-minted failure beside a tool's declared tags: the handler threw (or rejected) with something that is not a declared `{ _tag }`. |
| `ToolTimedOut` | Interface | A call that spent its `timeoutMs` budget — ToolResilience.timeoutMs. |
| `transcript` | Function | Open a transcript collector over an agent run's event stream. |
| `Transcript` | Interface | A live transcript: the listener you wire, and the read you take off it. |
| `TranscriptOutcome` | Type | Whether the run has finished, and its terminal turn once it has. |
| `TranscriptSeed` | Interface | The Model a resumed collector starts from — structural on purpose, so any agent state (`DefinedAgentState<T>`, `AgentState<…>`) satisfies it without this module importing the lid, and a bare `{ conversation }` object works in a test. |
| `TranscriptSnapshot` | Interface | What a collector holds right now — a plain, immutable read. |
| `TranscriptToolResult` | Interface | One tool call the run settled OK, as the transcript keeps it — the `callId` and the result, which is exactly what the `ToolSettled` event carries. |
| `TurnChunk` | Interface | One partial piece of a turn the model is still producing — a token delta, as the provider emitted it. |
| `WiredToolCmd` | Type | `ToolCmd<T>` as `toMachine` reads it: `never` for `T = never` — the "no router" reading it defaults to — so the router-owned `tool_rejected` arm does not leak into a machine that wired no router. |
| `WiredToolMsg` | Type | `ToolMsg<T>` as `toMachine` / `agentEvents` read it — see `WiredToolCmd`. |
