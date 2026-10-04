# @demlik/tea/agent

> THE headline Level-3 machine: a durable, crash-recoverable AI agent that runs an ordered stage pipeline, and inside the agentic stage drives the classic loop `llm → tools → fold → llm` until the model stops asking for tools.

Tier: `experimental`

```ts
import { … } from "@demlik/tea/agent";
```

## Start here

The exports below are alphabetical, which says nothing about where to begin.
These are the ones to read first:

| Symbol | Reach for it when |
| --- | --- |
| [`defineAgent`](#defineAgent) | You want an agent: a model, the tools it may call, instructions. This is the entry point — `run(input)` drives it to its finished state. |
| [`tool`](#tool) | Declare one thing the model may call — its input/result schemas, the failures it may name, and the handler. |
| [`ToolOutcome`](#ToolOutcome) | Read what a settled call hands back, whether it succeeded or failed. |
| [`DefinedAgentState`](#DefinedAgentState) | Type the Model a defined agent persists — what a `Store` reads and writes. |
| [`createAgent`](#createAgent) | Drop below the lid, once you need to walk a stage pipeline `defineAgent` does not express. |

## Exports (155)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`AGENT_EVENT_TYPES`](#AGENT_EVENT_TYPES) | Variable | experimental | Every AgentEvent `type`. |
| [`agentBootMsg`](#agentBootMsg) | Function | experimental | The do↔agent boot port: construct the `agent_boot` Msg `autoBoot` dispatches on a resumable rehydrate. |
| [`AgentBootMsg`](#AgentBootMsg) | Type | experimental | The Msg `do/host`'s `autoBoot` fires to re-enter the agent's `boot` verb on rehydrate. |
| [`agentCancelMsg`](#agentCancelMsg) | Function | experimental | Construct the `agent_cancel` Msg an abort dispatches. |
| [`AgentCancelMsg`](#AgentCancelMsg) | Type | experimental | The Msg an aborted `AbortSignal` fires to settle the run `cancelled`. |
| [`AgentCmd`](#AgentCmd) | Type | experimental | The Cmd union the agent emits, as a CLOSED discriminated union (precise `TC`, not the open `Cmd`) so `Interpret<M, AgentCmd<P, TC>, Ctx>` maps each key precisely and `toMachine` merges the interpret halves with no laundering cast: - `AgentLlmRunCmd<P>` — the brain-call run Cmd (`resilient_run`), folded by the wired `brainHandlers` handler. |
| [`AgentCompactErrMsg`](#AgentCompactErrMsg) | Type | experimental | The compaction round-trip failure settle Msg — carries the typed LlmErr. |
| [`AgentCompactionConfig`](#AgentCompactionConfig) | Type | experimental | The compaction discriminant, shaped exactly like AgentSnapshotConfig. |
| [`AgentCompactOkMsg`](#AgentCompactOkMsg) | Type | experimental | The compaction round-trip success settle Msg — carries the parsed CompactionSummary. |
| [`AgentCompactRunCmd`](#AgentCompactRunCmd) | Type | experimental | The "summarize the oldest N turns" effect Cmd — the compaction round-trip's carrier. |
| [`AgentConfig`](#AgentConfig) | Type | experimental | The agent configuration — the core seams intersected with the snapshotting discriminant (`AgentSnapshotConfig`). |
| [`AgentConfigCore`](#AgentConfigCore) | Interface | experimental | The core (non-snapshot, non-compaction) agent configuration. |
| [`AgentEndedStatus`](#AgentEndedStatus) | Type | experimental | The three AgentStatus arms a run can end on — what `RunDone` carries. |
| [`AgentEvent`](#AgentEvent) | Type | experimental | The agent's PUBLIC lifecycle events — the semantic stream a consumer subscribes to via `runtime.on(type, …)`. |
| [`AgentEventHead`](#AgentEventHead) | Interface | experimental | The two fields every AgentEvent carries. |
| [`agentEvents`](#agentEvents) | Function | experimental | Project one APPLIED agent transition `(msg, state)` to its semantic AgentEvents — the `events` projector a consumer passes to `run(machine, { events: agentEvents() })` to light up `runtime.on(...)`. |
| [`AgentFailure`](#AgentFailure) | Type | experimental | Why a run terminated as `failed`, beyond monitored-run's own reasons. |
| [`AgentKnob`](#AgentKnob) | Interface | experimental | The agent handle `createAgent` returns — the uniform verb contract every tea composition exposes, plus the wired `toMachine` and `brainInterpret`, the brain call's handler for a consumer wiring the verbs by hand. |
| [`AgentLifecycleNote`](#AgentLifecycleNote) | Type | experimental | One fact a transition recorded on AgentState.lifecycle — the input the `agentEvents` projector turns into `BrainStarted`, `ToolStarted`, `ToolFailed` and `RunDone`. |
| [`AgentLlmErrMsg`](#AgentLlmErrMsg) | Type | experimental | The brain-call FAILURE settle Msg, inherited from `../llm-call` — the engine mints it from the brain handler's outcome and it drives the agent's `fail` verb, which backs off via the retry ladder rather than ending the run. |
| [`AgentLlmOkMsg`](#AgentLlmOkMsg) | Type | experimental | The brain-call SUCCESS settle Msg, inherited from `../llm-call`. |
| [`AgentLlmRunCmd`](#AgentLlmRunCmd) | Type | experimental | The brain-call effect Cmd, inherited from `../llm-call`. |
| [`AgentMachineMsg`](#AgentMachineMsg) | Type | experimental | The agent machine's Msg union — one variant per reducer entry point. |
| [`AgentMessage`](#AgentMessage) | Type | experimental | One message a `defineAgent` `model` receives. |
| [`AgentPrompt`](#AgentPrompt) | Interface | experimental | The brain-call payload `defineAgent` builds from the durable state — everything `messagesOf` renders, so the prompt is a pure function of the Model and the resilient slice carries exactly what was sent. |
| [`AgentSnapshotConfig`](#AgentSnapshotConfig) | Type | experimental | The snapshotting discriminant. |
| [`AgentState`](#AgentState) | Interface | experimental | The agent slice — every composed wrapper's slice plus the loop's conversation and the agent-specific failure annotation. |
| [`AgentStatus`](#AgentStatus) | Type | experimental | The agent's lifecycle status — THE single typed channel for "what is this run doing?". |
| [`AgentTerminalFailure`](#AgentTerminalFailure) | Type | experimental | The unified terminal failure the agent settles on. |
| [`AgentTimerMsg`](#AgentTimerMsg) | Type | experimental | The timer Msg (retry + safety deadline) — `DeadlineExceeded`, the shared shape of both composed wrappers' timer Msgs (`LlmTimerMsg` and `MonitoredRunTimerMsg` are both `DeadlineExceeded`). |
| [`AgentToMachine`](#AgentToMachine) | Type | experimental | The `toMachine` signature. |
| [`agentTool`](#agentTool) | Function | experimental | Wrap a child `defineAgent` as a tool a parent `defineAgent` calls and awaits — pass it the child, how to phrase its input and how to read its answer, and get back a tool definition the parent's `tools` accepts like any `tool()`. |
| [`AgentToolError`](#AgentToolError) | Type | experimental | The failures an agent tool settles with beside `thrown`. |
| [`AgentToolSpec`](#AgentToolSpec) | Type | experimental | What `agentTool` takes. |
| [`AgentTurn`](#AgentTurn) | Interface | experimental | One model turn: the narration `content` the model produced and the `toolCalls` it asked us to run. |
| [`agentTurnSchema`](#agentTurnSchema) | Variable | experimental | The `Schema<AgentTurn>` for tea's own turn type — the parse target a brain call binds when the agentic purpose's output is a bare `AgentTurn` (the common case). |
| [`AnyToolDef`](#AnyToolDef) | Type | experimental | The declaration-erased view the router reads. |
| [`Awaiting`](#Awaiting) | Type | experimental | Whether the agentic stage is waiting on the model (`llm`), on tools (`tools`), or on a compaction round-trip (`compacting`). |
| [`ChildFailureReason`](#ChildFailureReason) | Type | experimental | Why a child run ended `failed` — the reason `status()` reports for it. |
| [`CompactInterpret`](#CompactInterpret) | Type | experimental | The CONFIG-DERIVED compaction obligation on `toMachine`'s `toolInterpret` — the exact twin of SnapshotInterpret. |
| [`COMPACTION_PURPOSE`](#COMPACTION_PURPOSE) | Variable | experimental | The reserved compaction purpose's value — the single in-flight summarize call's key. |
| [`CompactionOutputs`](#CompactionOutputs) | Interface | experimental | The purpose→output map for the compaction LLM call — the single reserved `$compact` purpose mapping to a CompactionSummary. |
| [`CompactionPolicy`](#CompactionPolicy) | Interface | experimental | The consumer's compaction policy. |
| [`CompactionPurpose`](#CompactionPurpose) | Type | experimental | The reserved purpose the compaction round-trip runs under. |
| [`CompactionSummary`](#CompactionSummary) | Interface | experimental | The result a compaction round-trip produces — the model's summary of the folded-away turns. |
| [`compactionSummarySchema`](#compactionSummarySchema) | Variable | experimental | The `Schema<CompactionSummary>` the compaction call binds — tea's own parse target for the summarize round-trip (it OWNS the `$compact` purpose's output). |
| [`ContentPart`](#ContentPart) | Type | experimental | One part of a multimodal message. |
| [`contentParts`](#contentParts) | Function | experimental | A message's content as parts — a string reads as one text part, so an adapter maps one shape whichever it was handed. |
| [`Conversation`](#Conversation) | Interface | experimental | The agentic-stage conversation — durable inside the agent slice so an eviction mid-loop resumes the exact turn. |
| [`createAgent`](#createAgent) | Function | experimental | Assemble an agent from `config` — the model, the stages it walks, and how a tool call is turned into a command — and get back its `init`, verbs and `subs` plus a `toMachine()` that wires all of it into one machine you hand to `run`, which is the layer to reach for only once `defineAgent` cannot express the run you want — a newcomer starts there, not here. |
| [`deadlinesSub`](#deadlinesSub) | Function | experimental | The `subs` entry that arms whatever deadlines `select` lists at a state: subs: [deadlinesSub((s: State) => rc.subs(s.resilience))], // run(machine, { subscribe: { deadline: subscribeDeadline } }) |
| [`DeadlinesSub`](#DeadlinesSub) | Type | experimental | The running `"deadline"` Sub: its `deps` is the non-empty list of deadlines to arm. |
| [`deadlineSub`](#deadlineSub) | Function | experimental | Build a deadline literal. |
| [`DeadlineSub`](#DeadlineSub) | Type | experimental | One deadline, as a battery lists it. |
| [`defineAgent`](#defineAgent) | Function | experimental | Define an agent from a model, the tools it may call and its instructions, and get back `run(input)` — a promise of the finished state — plus `machine(input)` for driving the same run yourself, which is the entry point a newcomer picks, `createAgent` being the layer underneath that you drop to only to walk a stage pipeline of your own. |
| [`DefineAgentCompaction`](#DefineAgentCompaction) | Type | experimental | The lid's compaction budget: when a transcript is too long, and how much of it survives the fold. |
| [`DefineAgentConfig`](#DefineAgentConfig) | Interface | experimental | What `defineAgent` takes: the model, the tools and the instructions, plus the four optional guards that stop a run — `maxTurns`, `deadlineMs`, `maxElapsedMs` and `stopWhen` — and the one that keeps a run going, `retry`, the brain call's backoff ladder. |
| [`DefinedAgent`](#DefinedAgent) | Interface | experimental | What `defineAgent` returns. |
| [`DefinedAgentCmd`](#DefinedAgentCmd) | Type | experimental | The Cmd union a defined agent's machine emits — one interpret cell per member. |
| [`DefinedAgentCtx`](#DefinedAgentCtx) | Type | experimental | The ctx the tools' handlers read, intersected — what `run` asks for. |
| [`DefinedAgentEvent`](#DefinedAgentEvent) | Type | experimental | One lifecycle event a defined agent's run emits — AgentEvent with the tool results typed against this agent's own tool set. |
| [`DefinedAgentInterpret`](#DefinedAgentInterpret) | Type | experimental | The interpret table of the machine `defineAgent` wired: one cell per DefinedAgentCmd, keyed by its `type` — a tool's own Cmd type, the router's `tool_rejected`, and the agent-owned brain call. |
| [`DefinedAgentMachine`](#DefinedAgentMachine) | Type | experimental | The wired machine `defineAgent` builds per `input`. |
| [`DefinedAgentModel`](#DefinedAgentModel) | Type | experimental | The brain a defined agent runs, in either of its two shapes: - `async (messages) => turn` — the plain port, and the common path. |
| [`DefinedAgentMsg`](#DefinedAgentMsg) | Type | experimental | The Msg union a defined agent's machine folds. |
| [`DefinedAgentOverlay`](#DefinedAgentOverlay) | Interface | experimental | What `defineAgent(cfg).with(...)` takes — the one documented wrap point over the machine the lid built. |
| [`DefinedAgentResolvedState`](#DefinedAgentResolvedState) | Type | experimental | The Model `run` RESOLVES with — DefinedAgentState whose `run` slice is narrowed to the ended phases (EndedRun). |
| [`DefinedAgentRunOptions`](#DefinedAgentRunOptions) | Type | experimental | Host wiring for one `run`: the store, the ctx the tools need, a runId, a clock. |
| [`DefinedAgentState`](#DefinedAgentState) | Type | experimental | The Model a defined agent runs — a hand-wired `createAgent`'s, key for key. |
| [`DefinedAgentWired`](#DefinedAgentWired) | Type | experimental | The machine `defineAgent` builds per `input` beside the handlers it runs under — the interpret table and the `deadline` runner (a machine carries none — #278, #279). |
| [`EndedRun`](#EndedRun) | Type | experimental | The ENDED phases — a run that finished (`done`) or was stopped from outside (`cancelled`). |
| [`fanOutInterpret`](#fanOutInterpret) | Function | experimental | Give a router's interpret cells real wall-clock overlap without touching the kernel — pass the table `toolRouter` built, get back one whose cells launch their tool and RETURN, so `runInterpret` reaches the next Cmd of the turn while the first tool is still running. |
| [`FILE_OMITTED`](#FILE_OMITTED) | Variable | experimental | The text an omitted file stands in as. |
| [`FilePart`](#FilePart) | Interface | experimental | A document the model reads; `mediaType` is its IANA type, such as `application/pdf`. |
| [`IMAGE_OMITTED`](#IMAGE_OMITTED) | Variable | experimental | The text an omitted image stands in as. |
| [`ImagePart`](#ImagePart) | Interface | experimental | An image the model looks at; `mediaType` is its IANA type, such as `image/jpeg`. |
| [`InterpretOverlay`](#InterpretOverlay) | Type | experimental | One decorator per interpret cell you name: it receives the cell the agent wired (`next`) and returns the cell that runs in its place. |
| [`isAgentTurn`](#isAgentTurn) | Function | experimental | Narrow an unknown to an `AgentTurn` — the runtime witness for tea's own structured-output type. |
| [`isCompactionSummary`](#isCompactionSummary) | Function | experimental | Narrow an unknown to a CompactionSummary — the runtime witness for the compaction call's structured output. |
| [`isReservedToolName`](#isReservedToolName) | Function | experimental | Whether `name` is one a tool door refuses — the set `ReservedToolName` types. |
| [`isStreamingModel`](#isStreamingModel) | Function | experimental | Whether a model port wants the ModelStream — read off its declared arity, which is the mark JavaScript already carries. |
| [`isTurnUsage`](#isTurnUsage) | Function | experimental | Narrow an unknown to a TurnUsage — the two required counts present, and each optional one either absent or a count too. |
| [`LidPurpose`](#LidPurpose) | Type | experimental | The one purpose a `defineAgent` agent runs. |
| [`liftAgent`](#liftAgent) | Function | experimental | Lift an agent result `[slice, cmds]` into a host `[State, cmds]` where the slice lives at `state.agent`. |
| [`Llm`](#Llm) | Interface | experimental | The minimal chat-model contract every model the handler talks to must satisfy — the seed's `InjectableChatModel`, trimmed to the one operation the brain call drives for brain-only stages: `withStructuredOutput(schema)` → a runnable whose `invoke(messages)` resolves to a typed object matching `schema`. |
| [`LlmCall`](#LlmCall) | Interface | experimental | One LLM call request — the resilient-call `input` for this module, carried on the `resilient_run` Cmd as plain data — no closures, so it survives persistence and replay. |
| [`LlmErr`](#LlmErr) | Interface | experimental | The typed failure variant — every failure path surfaces this, tagged by purpose. |
| [`LlmFailMsg`](#LlmFailMsg) | Type | experimental | The failure Msg the engine mints — resilient-call's. |
| [`LlmOk`](#LlmOk) | Interface | experimental | The parsed, typed success carried on `resilient_run_ok`, tagged with its purpose. |
| [`LlmRunCmd`](#LlmRunCmd) | Type | experimental | The effect Cmd this module emits: run the LLM call for `key` with `input`. |
| [`LlmSucceedMsg`](#LlmSucceedMsg) | Type | experimental | The success Msg the engine mints — resilient-call's, with the parsed `LlmOk`. |
| [`MediaSource`](#MediaSource) | Type | experimental | Where an image's or a file's bytes are. |
| [`mergeInterpret`](#mergeInterpret) | Function | experimental | Join two `Interpret` dictionaries over DISJOINT Cmd subsets `A` and `B` (over the same Msg union `M` and Ctx) into the full `Interpret<M, A \| B, Ctx>`. |
| [`MessageContent`](#MessageContent) | Type | experimental | A message's content: a plain string, or a list of parts. |
| [`MessageLoader`](#MessageLoader) | Type | experimental | Build the `Msg[]` the handler hands to the bound model for a given call. |
| [`ModelFactory`](#ModelFactory) | Type | experimental | The model factory — the first DI port. |
| [`ModelPort`](#ModelPort) | Type | experimental | Either model port. |
| [`ModelStream`](#ModelStream) | Interface | experimental | The side channel a StreamingModel writes its deltas to — the second argument of the streaming port. |
| [`MonitoredRunCmd`](#MonitoredRunCmd) | Type | experimental | The checkpoint-write Cmd, generic over the consumer's checkpoint value `V`. |
| [`omitMedia`](#omitMedia) | Function | experimental | The parts with every image and file replaced by a text placeholder — what a summarizer is handed, since the summary is text and cannot carry the pixels forward. |
| [`PLAIN_MODEL_MISROUTE_REASON`](#PLAIN_MODEL_MISROUTE_REASON) | Variable | experimental | The reason an `LlmErr` carries when a sync promise-returning function was passed as `model` bare — the one runtime shape neither port can own. |
| [`plainModel`](#plainModel) | Function | experimental | Lift a plain-function model into the `ModelFactory` port. |
| [`PlainModel`](#PlainModel) | Type | experimental | The plain-function model port — the common path. |
| [`renderPrompt`](#renderPrompt) | Function | experimental | The prompt as messages: the head, then each turn with its tool outcomes. |
| [`ReservedToolName`](#ReservedToolName) | Type | experimental | A tool name `tool()` and `agentTool()` refuse. |
| [`RunFailure`](#RunFailure) | Type | experimental | Why a run terminated as `failed`. |
| [`Schema`](#Schema) | Interface | experimental | The minimal structured-output schema contract: `parse(unknown) => T`, the zod-style call `decode` uses to validate the model's output before it settles `resilient_run_ok`. |
| [`SnapshotInterpret`](#SnapshotInterpret) | Type | experimental | The CONFIG-DERIVED snapshot obligation on `toMachine`'s `toolInterpret`. |
| [`status`](#status) | Function | experimental | Ask where an agent run stands: pass its state, get back one of `idle`, `running`, `suspended` (with the tool calls it is waiting on), `done` (with the output) or `failed` (with the failure). |
| [`StreamingModel`](#StreamingModel) | Type | experimental | The streaming model port — `(messages, { onChunk }) => Promise<AgentTurn>`. |
| [`subscribeDeadline`](#subscribeDeadline) | Variable | experimental | The `deadline` runner for the DEFAULT `setTimeout` backing. |
| [`TaggedFailure`](#TaggedFailure) | Type | experimental | The failure arm typed against a KNOWN tag union — `{ kind, reason }` beside each arm of `E`, distributed, so a `switch` on `_tag` narrows the payload and an unhandled tag is a compile error. |
| [`TextPart`](#TextPart) | Interface | experimental | A run of text. |
| [`tool`](#tool) | Function | experimental | Declare one tool the model may call — its name, the schemas for its arguments and result, the failures it may return and the handler that runs it — and get back a `Cmd<T, Ok, E>` definition, whose `Ok` is what `ok` parses and whose `E` is the `err` tag union, that you pass to `toolRouter` or `defineAgent`. |
| [`TOOL_RETRY_EXHAUSTED_TAG`](#TOOL_RETRY_EXHAUSTED_TAG) | Variable | experimental | The reason-tag a tool call that spent its retry budget settles under. |
| [`TOOL_TIMEOUT_TAG`](#TOOL_TIMEOUT_TAG) | Variable | experimental | The reason-tag a timed-out tool call settles under. |
| [`ToolCall`](#ToolCall) | Interface | experimental | One tool the model asked to call this turn. |
| [`ToolCmd`](#ToolCmd) | Type | experimental | The Cmd union a router's `toolOf` produces — `TC` for `createAgent`. |
| [`ToolConstructors`](#ToolConstructors) | Type | experimental | The two constructors a handler is handed, one per channel — `ok` for the value the `ok` schema parses, `fail` for a declared `{ _tag }`. |
| [`ToolDef`](#ToolDef) | Type | experimental | What `tool()` returns: the `Cmd.define`d constructor (so `Settled<typeof t>` / `CmdOf<typeof t>` read it like any def) plus the colocated `interpret` handler, the bare `args` schema the router parses a call against, and the `description` a provider adapter declares to the model beside that schema. |
| [`ToolError`](#ToolError) | Type | experimental | Every failure a router over `T` can settle with — the union `outcomeOf`'s error arm is typed from. |
| [`ToolErrorContext`](#ToolErrorContext) | Interface | experimental | Which call an `onToolError` failure belongs to: the model's `callId` — the fan-out identity the outcome folds back on — and the tool `name` the model asked for, which for an `unknown_tool` is the name it invented rather than any declared tool. |
| [`toolErrorReason`](#toolErrorReason) | Function | experimental | Turn a tool failure into the human-readable reason string the conversation carries — pass the `{ _tag, ...detail }` a tool failed with, get the tag followed by any remaining detail as JSON. |
| [`ToolFail`](#ToolFail) | Type | experimental | The typed failure constructor a handler receives: `fail({ _tag })` with `E` fixed to the declared tags, so the literal is checked against them where it is written. |
| [`ToolFailure`](#ToolFailure) | Interface | experimental | A settled tool failure as the conversation keeps it: the `{ _tag, …payload }` the tool failed with, spread beside the `reason` string the model reads. |
| [`ToolFailureOf`](#ToolFailureOf) | Type | experimental | The error outcome a router over `T` produces: `{ kind: "error", _tag, …payload, reason }`, discriminable on `_tag` over ToolError. |
| [`ToolHandler`](#ToolHandler) | Type | experimental | A tool's handler: the parsed `args`, the plain `ctx` the host handed `run`, and the typed `{ ok, fail }`, to an outcome over the declared channels — `Ok` is what the `ok` schema parses, `E` the declared `_tag` union. |
| [`ToolInput`](#ToolInput) | Type | experimental | The input a tool Cmd carries: the model's `callId` (the fan-out identity the settle folds back on) and the `args` already parsed against the tool's `input` schema — the boundary parses, the handler trusts. |
| [`ToolMsg`](#ToolMsg) | Type | experimental | The settled Msg union a router's handlers return — folded by `toMachine`. |
| [`ToolOk`](#ToolOk) | Type | experimental | The typed success constructor a handler receives: `ok(value)` with `Ok` fixed to what the `ok` schema parses, so a value of the wrong shape is refused where it is written. |
| [`ToolOutcome`](#ToolOutcome) | Type | experimental | One settled tool outcome the consumer routes back into the loop. |
| [`ToolPartsOf`](#ToolPartsOf) | Type | experimental | How `renderPrompt` reads the parts a settled call shows the model — a `ToolRouter`'s `partsOf`. |
| [`ToolRecord`](#ToolRecord) | Interface | experimental | A folded tool record kept on the conversation once a tool settles — the call + its outcome, in settle order. |
| [`ToolRejectedCmd`](#ToolRejectedCmd) | Type | experimental | The Cmd `tool_rejected` builds — the router-owned variant of `ToolCmd`. |
| [`ToolRejection`](#ToolRejection) | Type | experimental | A call the router could not hand to a tool: the model named a tool nobody declared, or its `args` failed the tool's `input` schema. |
| [`ToolResilience`](#ToolResilience) | Interface | experimental | The per-tool resilience knob — a timeout, a retry ladder, or both, declared on the `tool()` spec and executed by the agent's reducer through `../internal/resilience/resilient-call`. |
| [`ToolResilienceError`](#ToolResilienceError) | Type | experimental | The two failures the resilience ladder itself authors — `timeout` and `retry_exhausted`. |
| [`ToolResult`](#ToolResult) | Type | experimental | The union of every tool's `ok` value — `R` for `createAgent`. |
| [`ToolRetryExhausted`](#ToolRetryExhausted) | Interface | experimental | A call that spent its retry budget — ToolResilience.retry. |
| [`toolRouter`](#toolRouter) | Function | experimental | Fold a set of `tool()`s into one router — pass it the tools, get back the lookup `createAgent` needs, the handlers `toMachine` merges, and a reader that turns a settled message back into a plain outcome. |
| [`ToolRouter`](#ToolRouter) | Interface | experimental | What `toolRouter()` returns: the derived `toolOf` for `createAgent`'s config, the interpret table `toMachine({ tools })` merges, the defs it puts on `Machine.cmds`, and the one reader that turns a settled Msg back into the conversation's `ToolOutcome`. |
| [`ToolsCtx`](#ToolsCtx) | Type | experimental | The ctx a tool set's handlers read, intersected — what `run` asks the host for once the tools are wired into a machine. |
| [`ToolSettlement`](#ToolSettlement) | Type | experimental | One settled tool, read back off a `ToolMsg` by `outcomeOf`. |
| [`ToolThrown`](#ToolThrown) | Type | experimental | The router-minted failure beside a tool's declared tags: the handler threw (or rejected) with something that is not a declared `{ _tag }`. |
| [`ToolTimedOut`](#ToolTimedOut) | Interface | experimental | A call that spent its `timeoutMs` budget — ToolResilience.timeoutMs. |
| [`transcript`](#transcript) | Function | experimental | Open a transcript collector over an agent run's event stream. |
| [`Transcript`](#Transcript) | Interface | experimental | A live transcript: the listener you wire, and the read you take off it. |
| [`TranscriptOutcome`](#TranscriptOutcome) | Type | experimental | Whether the run has ended, and how: `running` until `RunDone`, then the ending it carried — `done` with the terminal turn, `failed` with the failure, or `cancelled`. |
| [`TranscriptSeed`](#TranscriptSeed) | Interface | experimental | The Model a resumed collector starts from — structural on purpose, so any agent state (`DefinedAgentState<T>`, `AgentState<…>`) satisfies it without this module importing the lid, and a bare `{ conversation }` object works in a test. |
| [`TranscriptSnapshot`](#TranscriptSnapshot) | Interface | experimental | What a collector holds right now — a plain, immutable read. |
| [`TranscriptToolResult`](#TranscriptToolResult) | Interface | experimental | One tool call the run settled OK, as the transcript keeps it — the `callId` and the result, which is exactly what the `ToolSettled` event carries. |
| [`TurnChunk`](#TurnChunk) | Interface | experimental | One partial piece of a turn the model is still producing — a token delta, as the provider emitted it. |
| [`TurnUsage`](#TurnUsage) | Interface | experimental | The token usage a provider reported for one model call, in the provider's own counts. |
| [`WiredToolCmd`](#WiredToolCmd) | Type | experimental | `ToolCmd<T>` as `toMachine` reads it: `never` for `T = never` — the "no router" reading it defaults to — so the router-owned `tool_rejected` arm does not leak into a machine that wired no router. |
| [`WiredToolMsg`](#WiredToolMsg) | Type | experimental | `ToolMsg<T>` as `toMachine` / `agentEvents` read it — see `WiredToolCmd`. |

## Declarations

<a id="AGENT_EVENT_TYPES"></a>

### `AGENT_EVENT_TYPES`

```ts
const AGENT_EVENT_TYPES: readonly ["BrainStarted", "TurnSettled", "ToolStarted", "ToolSettled", "ToolFailed", "RunDone"]
```

<a id="agentBootMsg"></a>

### `agentBootMsg`

```ts
function agentBootMsg(at: number): AgentBootMsg
```

<a id="AgentBootMsg"></a>

### `AgentBootMsg`

```ts
type AgentBootMsg = {
  readonly at: number;
  readonly type: typeof MsgType.AgentBoot;
}
```

<a id="agentCancelMsg"></a>

### `agentCancelMsg`

```ts
function agentCancelMsg(at: number): AgentCancelMsg
```

<a id="AgentCancelMsg"></a>

### `AgentCancelMsg`

```ts
type AgentCancelMsg = {
  readonly at: number;
  readonly type: typeof MsgType.AgentCancel;
}
```

<a id="AgentCmd"></a>

### `AgentCmd`

```ts
type AgentCmd<
  P extends string,
  TC extends Cmd = Cmd,
  Snap extends boolean = true,
  Compact extends boolean = true,
> =
  | AgentLlmRunCmd<P>
  | (Snap extends true ? MonitoredRunCmd<unknown> : never)
  | (Compact extends true ? AgentCompactRunCmd : never)
  | TC
```

<a id="AgentCompactErrMsg"></a>

### `AgentCompactErrMsg`

```ts
type AgentCompactErrMsg = {
  readonly at: number;
  readonly error: LlmErr<CompactionPurpose>;
  readonly key: CompactionPurpose;
  readonly type: typeof MsgType.CompactErr;
}
```

<a id="AgentCompactionConfig"></a>

### `AgentCompactionConfig`

```ts
type AgentCompactionConfig<R, Msg> =
  | { readonly compaction?: never }
  | {
    readonly compaction: CompactionPolicy<R, Msg>;
  }
```

<a id="AgentCompactOkMsg"></a>

### `AgentCompactOkMsg`

```ts
type AgentCompactOkMsg = {
  readonly at: number;
  readonly key: CompactionPurpose;
  readonly result: LlmOk<CompactionPurpose, CompactionOutputs>;
  readonly type: typeof MsgType.CompactOk;
}
```

<a id="AgentCompactRunCmd"></a>

### `AgentCompactRunCmd`

```ts
type AgentCompactRunCmd = Cmd<typeof MsgType.CompactRun> & {
  readonly input: LlmCall<CompactionPurpose>;
  readonly key: CompactionPurpose;
}
```

<a id="AgentConfig"></a>

### `AgentConfig`

```ts
type AgentConfig<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd = Cmd,
  Msg = unknown,
> = AgentConfigCore<Stage, P, O, R, TC, Msg> & AgentSnapshotConfig & AgentCompactionConfig<R, Msg>
```

<a id="AgentConfigCore"></a>

### `AgentConfigCore`

```ts
interface AgentConfigCore<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd = Cmd,
  Msg = unknown,
> {
  readonly deadlineMs?: number;
  readonly instructions?: string;
  readonly loadMessages?: MessageLoader<P, Msg>;
  readonly maxElapsedMs?: number;
  readonly maxTurns?: number;
  readonly model: ModelPort<Msg, O[P]>;
  readonly modelId?: string | null;
  readonly payloadOf?: (
    stage: Stage | undefined,
    conversation: Conversation<R>,
    instructions: string | null,
  ) => unknown;
  readonly retry?: RetryPolicy;
  readonly rng?: () => number;
  readonly schemas: { readonly [K in string]: Schema<O[K]> };
  readonly stages?: readonly Stage[];
  readonly stopWhen?: (state: AgentState<Stage, P, O, R>) => boolean;
  readonly toolConcurrency?: number;
  readonly toolOf: (call: ToolCall) => TC;
  readonly toolResilienceOf?: (call: ToolCall) => ToolResilience | null;
  readonly turnOf: (stage: Stage | undefined) => P;
}
```

<a id="AgentEndedStatus"></a>

### `AgentEndedStatus`

```ts
type AgentEndedStatus<Stage = unknown> = Extract<AgentStatus<Stage>, {
  readonly kind: "done" | "failed" | "cancelled";
}>
```

<a id="AgentEvent"></a>

### `AgentEvent`

```ts
type AgentEvent<R> =
  | AgentEventHead & {
    readonly model: string | null;
    readonly payload: unknown;
    readonly purpose: string;
    readonly turn: number;
    readonly type: "BrainStarted";
  }
  | AgentEventHead & {
    readonly turn: AgentTurn;
    readonly type: "TurnSettled";
    readonly usage?: TurnUsage;
  }
  | AgentEventHead & {
    readonly args: Readonly<Record<string, unknown>>;
    readonly callId: string;
    readonly name: string;
    readonly type: "ToolStarted";
  }
  | AgentEventHead & {
    readonly callId: string;
    readonly result: R;
    readonly type: "ToolSettled";
  }
  | AgentEventHead & {
    readonly callId: string;
    readonly failure: ToolFailure;
    readonly name: string;
    readonly type: "ToolFailed";
  }
  | AgentEventHead & {
    readonly status: AgentEndedStatus;
    readonly type: "RunDone";
  }
```

<a id="AgentEventHead"></a>

### `AgentEventHead`

```ts
interface AgentEventHead {
  readonly at: number;
  readonly runId: string;
}
```

<a id="agentEvents"></a>

### `agentEvents`

```ts
function agentEvents<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  T extends AnyToolDef = never,
>(
  opts?: { readonly tools?: ToolRouter<T> },
): (
  msg: AgentMachineMsg<P, O, R> | WiredToolMsg<T>,
  state: AgentState<Stage, P, O, R>,
) => readonly AgentEvent<R>[]
```

<a id="AgentFailure"></a>

### `AgentFailure`

```ts
type AgentFailure =
  | {
    readonly at: number;
    readonly reason: "turn_limit";
  }
  | {
    readonly at: number;
    readonly reason: "elapsed_limit";
  }
  | {
    readonly at: number;
    readonly error: unknown;
    readonly reason: "llm";
  }
```

<a id="AgentKnob"></a>

### `AgentKnob`

```ts
interface AgentKnob<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd,
  Snap extends boolean,
  Compact extends boolean,
> {
  readonly boot: AgentVerb1<Stage, P, O, R, TC, [at: number]>;
  readonly brain: CmdDef<"resilient_run", {
    readonly input: LlmCall;
    readonly key: string;
  }>;
  readonly brainCall: (s: AgentState<Stage, P, O, R>) => LlmCall<P>;
  readonly brainInterpret: () => Interpret<AgentLlmOkMsg<P, O> | AgentLlmErrMsg<P>, AgentLlmRunCmd<P>, unknown>;
  readonly compactErr: AgentVerb1<Stage, P, O, R, TC, [key: string, msg: AgentCompactErrMsg, at: number]>;
  readonly compactOk: AgentVerb1<Stage, P, O, R, TC, [key: string, msg: AgentCompactOkMsg, at: number]>;
  readonly currentStage: (s: AgentState<Stage, P, O, R>) => Stage | undefined;
  readonly fail: AgentVerb1<Stage, P, O, R, TC, [msg: AgentLlmErrMsg<P>, at: number]>;
  readonly init: () => AgentState<Stage, P, O, R>;
  readonly isSettled: (s: AgentState<Stage, P, O, R>) => boolean;
  readonly onTimer: AgentVerb1<Stage, P, O, R, TC, [msg: LlmTimerMsg]>;
  readonly start: AgentVerb1<Stage, P, O, R, TC, [runId: string, at: number]>;
  readonly subs: (s: AgentState<Stage, P, O, R>) => readonly DeadlineSub[];
  readonly succeed: AgentVerb1<Stage, P, O, R, TC, [msg: AgentLlmOkMsg<P, O>, at: number]>;
  readonly toMachine: AgentToMachine<Stage, P, O, R, TC, Snap, Compact>;
  readonly toolErr: AgentVerb1<Stage, P, O, R, TC, [callId: string, failure: string | ToolFailure, at: number]>;
  readonly toolOk: AgentVerb1<Stage, P, O, R, TC, [callId: string, result: R, at: number]>;
  readonly turn: AgentVerb1<Stage, P, O, R, TC, [result: AgentTurn, at: number]>;
}
```

<a id="AgentLifecycleNote"></a>

### `AgentLifecycleNote`

```ts
type AgentLifecycleNote =
  | {
    readonly at: number;
    readonly kind: "brain_started";
    readonly model: string | null;
    readonly purpose: string;
    readonly turn: number;
  }
  | {
    readonly at: number;
    readonly call: ToolCall;
    readonly kind: "tool_started";
  }
  | {
    readonly at: number;
    readonly call: ToolCall;
    readonly failure: ToolFailure;
    readonly kind: "tool_failed";
  }
  | {
    readonly at: number;
    readonly kind: "run_ended";
  }
```

<a id="AgentLlmErrMsg"></a>

### `AgentLlmErrMsg`

```ts
type AgentLlmErrMsg<P extends string> = LlmFailMsg<P>
```

<a id="AgentLlmOkMsg"></a>

### `AgentLlmOkMsg`

```ts
type AgentLlmOkMsg<P extends string, O extends Record<P, unknown>> = LlmSucceedMsg<P, O>
```

<a id="AgentLlmRunCmd"></a>

### `AgentLlmRunCmd`

```ts
type AgentLlmRunCmd<P extends string> = LlmRunCmd<P>
```

<a id="AgentMachineMsg"></a>

### `AgentMachineMsg`

```ts
type AgentMachineMsg<P extends string, O extends Record<P, unknown>, R> =
  | {
    readonly at: number;
    readonly runId: string;
    readonly type: typeof MsgType.AgentStart;
  }
  | {
    readonly at: number;
    readonly callId: string;
    readonly result: R;
    readonly type: typeof MsgType.AgentToolOk;
  }
  | {
    readonly at: number;
    readonly callId: string;
    readonly reason: string;
    readonly type: typeof MsgType.AgentToolErr;
  }
  | AgentLlmOkMsg<P, O>
  | AgentLlmErrMsg<P>
  | AgentCompactOkMsg
  | AgentCompactErrMsg
  | AgentTimerMsg
  | AgentBootMsg
  | AgentCancelMsg
```

<a id="AgentMessage"></a>

### `AgentMessage`

```ts
type AgentMessage =
  | {
    readonly content: string;
    readonly role: "system";
  }
  | {
    readonly content: MessageContent;
    readonly role: "user";
  }
  | {
    readonly content: string;
    readonly provider?: unknown;
    readonly role: "assistant";
    readonly toolCalls: readonly ToolCall[];
  }
  | {
    readonly callId: string;
    readonly name: string;
    readonly outcome: ToolOutcome<unknown>;
    readonly parts?: readonly ContentPart[];
    readonly role: "tool";
  }
```

<a id="AgentPrompt"></a>

### `AgentPrompt`

```ts
interface AgentPrompt<R> {
  readonly conversation: Conversation<R>;
  readonly input: string | null;
  readonly instructions: string | null;
}
```

<a id="AgentSnapshotConfig"></a>

### `AgentSnapshotConfig`

```ts
type AgentSnapshotConfig = { readonly snapshotEvery?: never } | { readonly snapshotEvery: number }
```

<a id="AgentState"></a>

### `AgentState`

```ts
interface AgentState<Stage, P extends string, O extends Record<P, unknown>, R> {
  readonly compaction: ResilientState<LlmCall<"$compact">, LlmOk<"$compact", CompactionOutputs>>;
  readonly conversation: Conversation<R> | null;
  readonly failure: AgentFailure | null;
  readonly instructions: string | null;
  readonly lifecycle: readonly AgentLifecycleNote[];
  readonly output: AgentTurn | null;
  readonly refusedCalls: readonly string[];
  readonly resilience: ResilientState<LlmCall<P>, LlmOk<P, O>>;
  readonly run: MonitoredRunState<Stage>;
  readonly toolResilience: Readonly<Record<string, ResilientState<ToolCall, null>>>;
  readonly tools: FanOutState<ToolCall, ToolOutcome<R>>;
  readonly usage: TurnUsage;
}
```

<a id="AgentStatus"></a>

### `AgentStatus`

```ts
type AgentStatus<Stage> =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | {
    readonly kind: "suspended";
    readonly pending: readonly ToolCall[];
  }
  | {
    readonly kind: "done";
    readonly output: AgentTurn | null;
    readonly usage: TurnUsage;
  }
  | {
    readonly failure: AgentTerminalFailure<Stage>;
    readonly kind: "failed";
  }
  | {
    readonly at: number;
    readonly kind: "cancelled";
  }
```

<a id="AgentTerminalFailure"></a>

### `AgentTerminalFailure`

```ts
type AgentTerminalFailure<Stage> = AgentFailure | RunFailure<Stage>
```

<a id="AgentTimerMsg"></a>

### `AgentTimerMsg`

```ts
type AgentTimerMsg = LlmTimerMsg
```

<a id="AgentToMachine"></a>

### `AgentToMachine`

```ts
type AgentToMachine<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd,
  Snap extends boolean,
  Compact extends boolean,
> = <Ctx = object, T extends AnyToolDef = never>(
  opts?: {
    readonly toolInterpret?: Interpret<AgentMachineMsg<P, O, R> | WiredToolMsg<T>, Exclude<TC, WiredToolCmd<T>>, Ctx> & SnapshotInterpret<AgentMachineMsg<P, O, R> | WiredToolMsg<T>, Snap, Ctx> & CompactInterpret<AgentMachineMsg<P, O, R> | WiredToolMsg<T>, Compact, Ctx>;
    readonly tools?: ToolRouter<T>;
  },
) => {
  readonly interpret: Interpret<AgentMachineMsg<P, O, R> | WiredToolMsg<T>, AgentCmd<P, TC, Snap, Compact>, Ctx & ToolsCtx<T>>;
  readonly machine: Machine<AgentState<Stage, P, O, R>, AgentMachineMsg<P, O, R> | WiredToolMsg<T>, AgentCmd<P, TC, Snap, Compact>, DeadlinesSub, Ctx & ToolsCtx<T>>;
  readonly subscribe: Subscribe<AgentMachineMsg<P, O, R> | WiredToolMsg<T>, DeadlinesSub, Ctx & ToolsCtx<T>>;
}
```

<a id="agentTool"></a>

### `agentTool`

```ts
function agentTool<
  const Name extends string,
  Args,
  Ok,
  CT extends AnyToolDef,
  Ctx = unknown,
>(
  name: Name & NotReserved<Name>,
  spec: AgentToolSpec<Args, Ok, CT, Ctx>,
): ToolDef<Name, Args, Ok, ToolThrown | AgentToolError, Ctx>
```

<a id="AgentToolError"></a>

### `AgentToolError`

```ts
type AgentToolError =
  | {
    readonly _tag: "child_failed";
    readonly childRunId: string;
    readonly failure: ChildFailureReason;
  }
  | {
    readonly _tag: "child_cancelled";
    readonly childRunId: string;
  }
```

<a id="AgentToolSpec"></a>

### `AgentToolSpec`

```ts
type AgentToolSpec<Args, Ok, CT extends AnyToolDef, Ctx> = {
  readonly agent: DefinedAgent<CT>;
  readonly description: string;
  readonly input: StandardSchemaV1<unknown, Args>;
  readonly namespace: (ctx: HandlerCtx<Ctx>) => string;
  readonly ok: StandardSchemaV1<unknown, Ok>;
  readonly prompt: (args: Args) => string;
  readonly result: (output: AgentTurn) => Ok;
  readonly store: (key: string, ctx: HandlerCtx<Ctx>) => Store<DefinedAgentState<CT>>;
} & ChildCtxOption<CT, Ctx>
```

<a id="AgentTurn"></a>

### `AgentTurn`

```ts
interface AgentTurn {
  readonly content: string;
  readonly provider?: unknown;
  readonly toolCalls: readonly ToolCall[];
  readonly usage?: TurnUsage;
}
```

<a id="agentTurnSchema"></a>

### `agentTurnSchema`

```ts
const agentTurnSchema: Schema<AgentTurn>
```

<a id="AnyToolDef"></a>

### `AnyToolDef`

```ts
type AnyToolDef = AnyCmdDef & {
  readonly args: StandardSchemaV1;
  readonly content: ((result: never) => readonly ContentPart[]) | null;
  readonly description: string;
  readonly interpret: (cmd: never, ctx: never) => Promise<unknown>;
  readonly resilience: ToolResilience | null;
}
```

<a id="Awaiting"></a>

### `Awaiting`

```ts
type Awaiting =
  | { readonly kind: "llm" }
  | {
    readonly batchTurn: number;
    readonly kind: "tools";
  }
  | {
    readonly folding: number;
    readonly kind: "compacting";
  }
```

<a id="ChildFailureReason"></a>

### `ChildFailureReason`

```ts
type ChildFailureReason = AgentTerminalFailure<string>["reason"]
```

<a id="CompactInterpret"></a>

### `CompactInterpret`

```ts
type CompactInterpret<M extends { type: string }, Compact extends boolean, Ctx> = Compact extends true ? Interpret<M, AgentCompactRunCmd, Ctx> : { readonly compact_run?: never }
```

<a id="COMPACTION_PURPOSE"></a>

### `COMPACTION_PURPOSE`

```ts
const COMPACTION_PURPOSE: CompactionPurpose
```

<a id="CompactionOutputs"></a>

### `CompactionOutputs`

```ts
interface CompactionOutputs extends Record<CompactionPurpose, unknown> {
  readonly $compact: CompactionSummary;
}
```

<a id="CompactionPolicy"></a>

### `CompactionPolicy`

```ts
interface CompactionPolicy<R, Msg = unknown> {
  readonly loadMessages?: MessageLoader<"$compact", Msg>;
  readonly payloadOf?: (conversation: Conversation<R>, folding: number) => unknown;
  readonly planCompaction: (conversation: Conversation<R>) => number;
}
```

<a id="CompactionPurpose"></a>

### `CompactionPurpose`

```ts
type CompactionPurpose = "$compact"
```

<a id="CompactionSummary"></a>

### `CompactionSummary`

```ts
interface CompactionSummary {
  readonly summary: string;
}
```

<a id="compactionSummarySchema"></a>

### `compactionSummarySchema`

```ts
const compactionSummarySchema: Schema<CompactionSummary>
```

<a id="ContentPart"></a>

### `ContentPart`

```ts
type ContentPart = TextPart | ImagePart | FilePart
```

<a id="contentParts"></a>

### `contentParts`

```ts
function contentParts(content: MessageContent): readonly ContentPart[]
```

<a id="Conversation"></a>

### `Conversation`

```ts
interface Conversation<R> {
  readonly awaiting: Awaiting;
  readonly contextTokens: number | null;
  readonly toolRecords: readonly ToolRecord<R>[];
  readonly turnCount: number;
  readonly turns: readonly AgentTurn[];
}
```

<a id="createAgent"></a>

### `createAgent`

```ts
function createAgent<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd = Cmd,
  Msg = unknown,
>(
  config: AgentConfigCore<Stage, P, O, R, TC, Msg> & {
    readonly compaction: CompactionPolicy<R, Msg>;
    readonly snapshotEvery: number;
  },
): AgentKnob<Stage, P, O, R, TC, true, true>
function createAgent<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd = Cmd,
  Msg = unknown,
>(
  config: AgentConfigCore<Stage, P, O, R, TC, Msg> & {
    readonly compaction?: undefined;
    readonly snapshotEvery: number;
  },
): AgentKnob<Stage, P, O, R, TC, true, false>
function createAgent<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd = Cmd,
  Msg = unknown,
>(
  config: AgentConfigCore<Stage, P, O, R, TC, Msg> & {
    readonly compaction: CompactionPolicy<R, Msg>;
    readonly snapshotEvery?: undefined;
  },
): AgentKnob<Stage, P, O, R, TC, false, true>
function createAgent<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd = Cmd,
  Msg = unknown,
>(
  config: AgentConfigCore<Stage, P, O, R, TC, Msg> & {
    readonly compaction?: undefined;
    readonly snapshotEvery?: undefined;
  },
): AgentKnob<Stage, P, O, R, TC, false, false>
```

<a id="deadlinesSub"></a>

### `deadlinesSub`

```ts
function deadlinesSub<S, N extends string | undefined = undefined>(
  select: (state: S) => readonly DeadlineSub<N>[],
): {
  readonly deps: (state: S) => readonly DeadlineSub<N>[] | null | undefined;
  readonly type: "deadline";
}
```

<a id="DeadlinesSub"></a>

### `DeadlinesSub`

```ts
type DeadlinesSub<N extends string | undefined = undefined> = Sub<"deadline", readonly DeadlineSub<N>[]>
```

<a id="deadlineSub"></a>

### `deadlineSub`

```ts
function deadlineSub<N extends string | undefined = undefined>(
  id: string,
  atMs: number,
  opts?: DeadlineOpts<N>,
): DeadlineSub<N>
```

<a id="DeadlineSub"></a>

### `DeadlineSub`

```ts
type DeadlineSub<N extends string | undefined = undefined> = {
  readonly atMs: number;
  readonly id: SubId;
  readonly type: "deadline";
} & DeadlineOpts<N>
```

<a id="defineAgent"></a>

### `defineAgent`

```ts
function defineAgent<T extends AnyToolDef>(
  config: DefineAgentConfig<T>,
): DefinedAgent<T>
```

<a id="DefineAgentCompaction"></a>

### `DefineAgentCompaction`

```ts
type DefineAgentCompaction =
  | CompactionTriggers & {
    readonly afterContextTokens?: number;
    readonly afterTurns: number;
  }
  | CompactionTriggers & {
    readonly afterContextTokens: number;
    readonly afterTurns?: number;
  }
```

<a id="DefineAgentConfig"></a>

### `DefineAgentConfig`

```ts
interface DefineAgentConfig<T extends AnyToolDef> {
  readonly compaction?: DefineAgentCompaction;
  readonly deadlineMs?: number;
  readonly instructions: string;
  readonly maxElapsedMs?: number;
  readonly maxTurns?: number;
  readonly model: DefinedAgentModel;
  readonly onToolError?: (outcome: ToolFailureOf<T>, ctx: ToolErrorContext) => void | Promise<void>;
  readonly retry?: RetryPolicy;
  readonly stopWhen?: (state: DefinedAgentState<T>) => boolean;
  readonly toolConcurrency?: number;
  readonly tools: readonly T[];
}
```

<a id="DefinedAgent"></a>

### `DefinedAgent`

```ts
interface DefinedAgent<T extends AnyToolDef> {
  readonly machine: (input: string) => DefinedAgentWired<T>;
  readonly run: (
    input: string,
    ...opts: [Record<never, never>] extends [UnionToIntersection<KnownToolCtx<ToolCtxBoxed<T>>>] ? [opts?: DefinedAgentRunOptions<T>] : [opts: DefinedAgentRunOptions<T>],
  ) => Promise<DefinedAgentResolvedState<T>>;
  readonly with: (overlay: DefinedAgentOverlay<T>) => DefinedAgent<T>;
}
```

<a id="DefinedAgentCmd"></a>

### `DefinedAgentCmd`

```ts
type DefinedAgentCmd<T extends AnyToolDef> = AgentCmd<LidPurpose, ToolCmd<T>, false, true>
```

<a id="DefinedAgentCtx"></a>

### `DefinedAgentCtx`

```ts
type DefinedAgentCtx<T extends AnyToolDef> = ToolsCtx<T>
```

<a id="DefinedAgentEvent"></a>

### `DefinedAgentEvent`

```ts
type DefinedAgentEvent<T extends AnyToolDef> = AgentEvent<ToolResult<T>>
```

<a id="DefinedAgentInterpret"></a>

### `DefinedAgentInterpret`

```ts
type DefinedAgentInterpret<T extends AnyToolDef> = Interpret<DefinedAgentMsg<T>, DefinedAgentCmd<T>, DefinedAgentCtx<T>>
```

<a id="DefinedAgentMachine"></a>

### `DefinedAgentMachine`

```ts
type DefinedAgentMachine<T extends AnyToolDef> = Machine<DefinedAgentState<T>, DefinedAgentMsg<T>, DefinedAgentCmd<T>, DeadlinesSub, DefinedAgentCtx<T>>
```

<a id="DefinedAgentModel"></a>

### `DefinedAgentModel`

```ts
type DefinedAgentModel = PlainModel<AgentMessage, AgentTurn> | StreamingModel<AgentMessage, AgentTurn>
```

<a id="DefinedAgentMsg"></a>

### `DefinedAgentMsg`

```ts
type DefinedAgentMsg<T extends AnyToolDef> = AgentMachineMsg<LidPurpose, LidOutputs, ToolResult<T>> | WiredToolMsg<T>
```

<a id="DefinedAgentOverlay"></a>

### `DefinedAgentOverlay`

```ts
interface DefinedAgentOverlay<T extends AnyToolDef> {
  readonly interpret: InterpretOverlay<T>;
}
```

<a id="DefinedAgentResolvedState"></a>

### `DefinedAgentResolvedState`

```ts
type DefinedAgentResolvedState<T extends AnyToolDef> = Omit<DefinedAgentState<T>, "run"> & { readonly run: EndedRun<string> }
```

<a id="DefinedAgentRunOptions"></a>

### `DefinedAgentRunOptions`

```ts
type DefinedAgentRunOptions<T extends AnyToolDef> = CtxArg<DefinedAgentCtx<T>> & {
  readonly clock?: () => number;
  readonly onChunk?: (chunk: TurnChunk) => void;
  readonly onEvent?: (event: DefinedAgentEvent<T>) => void;
  readonly runId?: string;
  readonly signal?: AbortSignal;
  readonly store?: Store<DefinedAgentState<T>>;
}
```

<a id="DefinedAgentState"></a>

### `DefinedAgentState`

```ts
type DefinedAgentState<T extends AnyToolDef> = AgentState<string, LidPurpose, LidOutputs, ToolResult<T>>
```

<a id="DefinedAgentWired"></a>

### `DefinedAgentWired`

```ts
type DefinedAgentWired<T extends AnyToolDef> = {
  readonly interpret: DefinedAgentInterpret<T>;
  readonly machine: DefinedAgentMachine<T>;
  readonly subscribe: Subscribe<DefinedAgentMsg<T>, DeadlinesSub, DefinedAgentCtx<T>>;
}
```

<a id="EndedRun"></a>

### `EndedRun`

```ts
type EndedRun<Stage> = Extract<MonitoredRunState<Stage>, { readonly phase: "done" | "cancelled" }>
```

<a id="fanOutInterpret"></a>

### `fanOutInterpret`

```ts
function fanOutInterpret<T extends AnyToolDef>(
  interpret: Interpret<ToolMsg<T>, ToolCmd<T>, ToolsCtx<T>>,
): Interpret<ToolMsg<T>, ToolCmd<T>, ToolsCtx<T>>
```

<a id="FILE_OMITTED"></a>

### `FILE_OMITTED`

```ts
const FILE_OMITTED: "[file omitted]"
```

<a id="FilePart"></a>

### `FilePart`

```ts
interface FilePart {
  readonly mediaType: string;
  readonly source: MediaSource;
  readonly type: "file";
}
```

<a id="IMAGE_OMITTED"></a>

### `IMAGE_OMITTED`

```ts
const IMAGE_OMITTED: "[image omitted]"
```

<a id="ImagePart"></a>

### `ImagePart`

```ts
interface ImagePart {
  readonly mediaType: string;
  readonly source: MediaSource;
  readonly type: "image";
}
```

<a id="InterpretOverlay"></a>

### `InterpretOverlay`

```ts
type InterpretOverlay<T extends AnyToolDef> = CellWrappers<DefinedAgentInterpret<T>>
```

<a id="isAgentTurn"></a>

### `isAgentTurn`

```ts
function isAgentTurn(value: unknown): value is AgentTurn
```

<a id="isCompactionSummary"></a>

### `isCompactionSummary`

```ts
function isCompactionSummary(value: unknown): value is CompactionSummary
```

<a id="isReservedToolName"></a>

### `isReservedToolName`

```ts
function isReservedToolName(name: string): name is ReservedToolName
```

<a id="isStreamingModel"></a>

### `isStreamingModel`

```ts
function isStreamingModel(model: (...args: never[]) => unknown): boolean
```

<a id="isTurnUsage"></a>

### `isTurnUsage`

```ts
function isTurnUsage(value: unknown): value is TurnUsage
```

<a id="LidPurpose"></a>

### `LidPurpose`

```ts
type LidPurpose = "act"
```

<a id="liftAgent"></a>

### `liftAgent`

```ts
function liftAgent<
  S extends { agent: AgentState<Stage, P, O, R> },
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
  C extends Cmd,
>(
  state: S,
  __namedParameters: readonly [AgentState<Stage, P, O, R>, readonly C[]],
): readonly [S, readonly C[]]
```

<a id="Llm"></a>

### `Llm`

```ts
interface Llm<Msg> {
  withStructuredOutput<T>(schema: Schema<T>): { invoke(messages: readonly Msg[]): Promise<T> };
}
```

<a id="LlmCall"></a>

### `LlmCall`

```ts
interface LlmCall<P extends string> {
  readonly model: string | null;
  readonly payload: unknown;
  readonly purpose: P;
}
```

<a id="LlmErr"></a>

### `LlmErr`

```ts
interface LlmErr<P extends string> {
  readonly error: unknown;
  readonly key: string;
  readonly purpose: P;
  readonly reason: string;
}
```

<a id="LlmFailMsg"></a>

### `LlmFailMsg`

```ts
type LlmFailMsg<P extends string> = FailMsg<"resilient", LlmCall<P>>
```

<a id="LlmOk"></a>

### `LlmOk`

```ts
interface LlmOk<P extends string, O extends Record<P, unknown>> {
  readonly key: string;
  readonly output: O[P];
  readonly purpose: P;
}
```

<a id="LlmRunCmd"></a>

### `LlmRunCmd`

```ts
type LlmRunCmd<P extends string> = RunCmd<LlmCall<P>>
```

<a id="LlmSucceedMsg"></a>

### `LlmSucceedMsg`

```ts
type LlmSucceedMsg<P extends string, O extends Record<P, unknown>> = SucceedMsg<LlmOk<P, O>, "resilient", LlmCall<P>>
```

<a id="MediaSource"></a>

### `MediaSource`

```ts
type MediaSource =
  | {
    readonly data: string;
    readonly type: "base64";
  }
  | {
    readonly data: Uint8Array;
    readonly type: "bytes";
  }
  | { readonly type: "url"; readonly url: string }
```

<a id="mergeInterpret"></a>

### `mergeInterpret`

```ts
function mergeInterpret<
  M extends { type: string },
  A extends Cmd,
  B extends Cmd,
  Ctx,
>(
  a: Interpret<M, A, Ctx> | undefined,
  b: Interpret<M, B, Ctx>,
): Interpret<M, A | B, Ctx>
```

<a id="MessageContent"></a>

### `MessageContent`

```ts
type MessageContent = string | readonly ContentPart[]
```

<a id="MessageLoader"></a>

### `MessageLoader`

```ts
type MessageLoader<P extends string, Msg> = (call: LlmCall<P>) => Promise<readonly Msg[]>
```

<a id="ModelFactory"></a>

### `ModelFactory`

```ts
type ModelFactory<Msg> = (modelId: string | null) => Llm<Msg>
```

<a id="ModelPort"></a>

### `ModelPort`

```ts
type ModelPort<Msg, T = unknown> = ModelFactory<Msg> | PlainModel<Msg, T>
```

<a id="ModelStream"></a>

### `ModelStream`

```ts
interface ModelStream {
  readonly onChunk: (chunk: TurnChunk) => void;
}
```

<a id="MonitoredRunCmd"></a>

### `MonitoredRunCmd`

```ts
type MonitoredRunCmd<V> = SnapshotWriteCmd<V>
```

<a id="omitMedia"></a>

### `omitMedia`

```ts
function omitMedia(parts: readonly ContentPart[]): readonly ContentPart[]
```

<a id="PLAIN_MODEL_MISROUTE_REASON"></a>

### `PLAIN_MODEL_MISROUTE_REASON`

```ts
const PLAIN_MODEL_MISROUTE_REASON: string
```

<a id="plainModel"></a>

### `plainModel`

```ts
function plainModel<Msg, T>(fn: PlainModel<Msg, T>): ModelFactory<Msg>
```

<a id="PlainModel"></a>

### `PlainModel`

```ts
type PlainModel<Msg, T = unknown> = (messages: readonly Msg[]) => Promise<T>
```

<a id="renderPrompt"></a>

### `renderPrompt`

```ts
function renderPrompt(
  prompt: AgentPrompt<unknown>,
  partsOf?: ToolPartsOf,
): AgentMessage[]
```

<a id="ReservedToolName"></a>

### `ReservedToolName`

```ts
type ReservedToolName =
  | MsgTypeValue
  | SettlePrefixOf<MsgTypeValue>
  | typeof REJECTED_TYPE
  | typeof SNAPSHOT_WRITE_TYPE
```

<a id="RunFailure"></a>

### `RunFailure`

```ts
type RunFailure<Stage> =
  | {
    readonly at: number;
    readonly reason: "deadline";
  }
  | {
    readonly error: unknown;
    readonly reason: "stage";
    readonly stage: Stage | undefined;
  }
```

<a id="Schema"></a>

### `Schema`

```ts
interface Schema<T> {
  parse(value: unknown): T;
}
```

<a id="SnapshotInterpret"></a>

### `SnapshotInterpret`

```ts
type SnapshotInterpret<M extends { type: string }, Snap extends boolean, Ctx> = Snap extends true ? Interpret<M, MonitoredRunCmd<unknown>, Ctx> : { readonly snapshot_write?: never }
```

<a id="status"></a>

### `status`

```ts
function status<Stage, P extends string, O extends Record<P, unknown>, R>(
  s: AgentState<Stage, P, O, R>,
): AgentStatus<Stage>
```

<a id="StreamingModel"></a>

### `StreamingModel`

```ts
type StreamingModel<Msg, T = unknown> = (messages: readonly Msg[], stream: ModelStream) => Promise<T>
```

<a id="subscribeDeadline"></a>

### `subscribeDeadline`

```ts
const subscribeDeadline: <N extends string | undefined = undefined>(
  sub: DeadlinesSub<N>,
  ctx: unknown,
  dispatch: (msg: DeadlineExceeded<N>) => void,
) => Dispose
```

<a id="TaggedFailure"></a>

### `TaggedFailure`

```ts
type TaggedFailure<E extends Tagged> = E extends unknown ? {
  readonly kind: "error";
  readonly reason: string;
} & E : never
```

<a id="TextPart"></a>

### `TextPart`

```ts
interface TextPart {
  readonly text: string;
  readonly type: "text";
}
```

<a id="tool"></a>

### `tool`

```ts
function tool<
  const Name extends string,
  Args,
  Ok,
  const Tags extends readonly string[],
  Ctx = unknown,
>(
  name: Name & NotReserved<Name>,
  spec: {
    readonly content?: (result: Ok) => readonly ContentPart[];
    readonly description: string;
    readonly err: Tags;
    readonly input: StandardSchemaV1<unknown, Args>;
    readonly ok: StandardSchemaV1<unknown, Ok>;
    readonly retry?: AnyRetryPolicy;
    readonly timeoutMs?: number;
  },
  handler: ToolHandler<Args, Ok, TaggedError<Tags[number]>, Ctx>,
): ToolDef<Name, Args, Ok, TaggedError<"thrown" | Tags[number]>, Ctx>
```

<a id="TOOL_RETRY_EXHAUSTED_TAG"></a>

### `TOOL_RETRY_EXHAUSTED_TAG`

```ts
const TOOL_RETRY_EXHAUSTED_TAG: "retry_exhausted"
```

<a id="TOOL_TIMEOUT_TAG"></a>

### `TOOL_TIMEOUT_TAG`

```ts
const TOOL_TIMEOUT_TAG: "timeout"
```

<a id="ToolCall"></a>

### `ToolCall`

```ts
interface ToolCall {
  readonly args: Readonly<Record<string, unknown>>;
  readonly callId: string;
  readonly name: string;
}
```

<a id="ToolCmd"></a>

### `ToolCmd`

```ts
type ToolCmd<T extends AnyToolDef> = CmdOf<T> | ToolRejectedCmd
```

<a id="ToolConstructors"></a>

### `ToolConstructors`

```ts
type ToolConstructors<Ok, E extends Tagged> = {
  readonly fail: ToolFail<Ok, E>;
  readonly ok: ToolOk<Ok, E>;
}
```

<a id="ToolDef"></a>

### `ToolDef`

```ts
type ToolDef<Name extends string, Args, Ok, E extends Tagged, Ctx> = CmdDef<Name, ToolInput<Args>, Ok, E> & {
  readonly __ctx?: Ctx;
  readonly args: StandardSchemaV1<unknown, Args>;
  readonly content: ((result: Ok) => readonly ContentPart[]) | null;
  readonly description: string;
  readonly interpret: (
    cmd: CmdValue<Name, ToolInput<Args>, Ok, E>,
    ctx: HandlerCtx<Ctx>,
  ) => Promise<Outcome<Ok, E>>;
  readonly resilience: ToolResilience | null;
}
```

<a id="ToolError"></a>

### `ToolError`

```ts
type ToolError<T extends AnyToolDef> = ErrOf<T> | MalformedResult | ToolRejection | ToolResilienceError
```

<a id="ToolErrorContext"></a>

### `ToolErrorContext`

```ts
interface ToolErrorContext {
  readonly callId: string;
  readonly name: string;
}
```

<a id="toolErrorReason"></a>

### `toolErrorReason`

```ts
function toolErrorReason(error: Tagged): string
```

<a id="ToolFail"></a>

### `ToolFail`

```ts
type ToolFail<Ok, E extends Tagged> = (error: E) => Outcome<Ok, E>
```

<a id="ToolFailure"></a>

### `ToolFailure`

```ts
interface ToolFailure {
  readonly _tag?: string;
  readonly kind: "error";
  readonly reason: string;
}
```

<a id="ToolFailureOf"></a>

### `ToolFailureOf`

```ts
type ToolFailureOf<T extends AnyToolDef> = TaggedFailure<ToolError<T>>
```

<a id="ToolHandler"></a>

### `ToolHandler`

```ts
type ToolHandler<Args, Ok, E extends Tagged, Ctx> = (
  args: Args,
  ctx: HandlerCtx<Ctx>,
  settle: ToolConstructors<Ok, E>,
) => Promise<Outcome<Ok, E>>
```

<a id="ToolInput"></a>

### `ToolInput`

```ts
type ToolInput<Args> = {
  readonly args: Args;
  readonly callId: string;
}
```

<a id="ToolMsg"></a>

### `ToolMsg`

```ts
type ToolMsg<T extends AnyToolDef> = Settled<T> | Settled<typeof rejected>
```

<a id="ToolOk"></a>

### `ToolOk`

```ts
type ToolOk<Ok, E extends Tagged> = (value: Ok) => Outcome<Ok, E>
```

<a id="ToolOutcome"></a>

### `ToolOutcome`

```ts
type ToolOutcome<R> = { readonly kind: "ok"; readonly result: R } | ToolFailure
```

<a id="ToolPartsOf"></a>

### `ToolPartsOf`

```ts
type ToolPartsOf = (call: ToolCall, outcome: ToolOutcome<unknown>) => readonly ContentPart[] | null
```

<a id="ToolRecord"></a>

### `ToolRecord`

```ts
interface ToolRecord<R> {
  readonly call: ToolCall;
  readonly outcome: ToolOutcome<R>;
  readonly turn: number;
}
```

<a id="ToolRejectedCmd"></a>

### `ToolRejectedCmd`

```ts
type ToolRejectedCmd = CmdOf<typeof rejected>
```

<a id="ToolRejection"></a>

### `ToolRejection`

```ts
type ToolRejection =
  | {
    readonly _tag: "unknown_tool";
    readonly name: string;
  }
  | {
    readonly _tag: "malformed_args";
    readonly issues: ReadonlyArray<{
      readonly message: string;
      readonly path: string;
    }>;
    readonly name: string;
  }
```

<a id="ToolResilience"></a>

### `ToolResilience`

```ts
interface ToolResilience {
  readonly retry?: AnyRetryPolicy;
  readonly timeoutMs?: number;
}
```

<a id="ToolResilienceError"></a>

### `ToolResilienceError`

```ts
type ToolResilienceError = ToolTimedOut | ToolRetryExhausted
```

<a id="ToolResult"></a>

### `ToolResult`

```ts
type ToolResult<T extends AnyToolDef> = OkOf<T>
```

<a id="ToolRetryExhausted"></a>

### `ToolRetryExhausted`

```ts
interface ToolRetryExhausted {
  readonly _tag: "retry_exhausted";
  readonly attempts: number;
  readonly last: string;
}
```

<a id="toolRouter"></a>

### `toolRouter`

```ts
function toolRouter<T extends AnyToolDef>(tools: readonly T[]): ToolRouter<T>
```

<a id="ToolRouter"></a>

### `ToolRouter`

```ts
interface ToolRouter<T extends AnyToolDef> {
  readonly defs: readonly AnyCmdDef[];
  readonly interpret: Interpret<ToolMsg<T>, ToolCmd<T>, ToolsCtx<T>>;
  readonly outcomeOf: (msg: { readonly type: string }) => ToolSettlement<OkOf<T>, ToolError<T>> | null;
  readonly partsOf: (call: ToolCall, outcome: ToolOutcome<unknown>) => readonly ContentPart[] | null;
  readonly resilienceOf: (call: ToolCall) => ToolResilience | null;
  readonly toolOf: (call: ToolCall) => ToolCmd<T>;
}
```

<a id="ToolsCtx"></a>

### `ToolsCtx`

```ts
type ToolsCtx<T extends AnyToolDef> = UnionToIntersection<KnownToolCtx<ToolCtxBoxed<T>>>
```

<a id="ToolSettlement"></a>

### `ToolSettlement`

```ts
type ToolSettlement<R, E extends Tagged = Tagged> = {
  readonly callId: string;
  readonly outcome: { readonly kind: "ok"; readonly result: R } | TaggedFailure<E>;
}
```

<a id="ToolThrown"></a>

### `ToolThrown`

```ts
type ToolThrown = {
  readonly _tag: "thrown";
  readonly message: string;
}
```

<a id="ToolTimedOut"></a>

### `ToolTimedOut`

```ts
interface ToolTimedOut {
  readonly _tag: "timeout";
}
```

<a id="transcript"></a>

### `transcript`

```ts
function transcript<R>(seed?: TranscriptSeed<R>): Transcript<R>
```

<a id="Transcript"></a>

### `Transcript`

```ts
interface Transcript<R> {
  readonly onEvent: (event: AgentEvent<R>) => void;
  readonly read: () => TranscriptSnapshot<R>;
}
```

<a id="TranscriptOutcome"></a>

### `TranscriptOutcome`

```ts
type TranscriptOutcome = { readonly kind: "running" } | AgentEndedStatus
```

<a id="TranscriptSeed"></a>

### `TranscriptSeed`

```ts
interface TranscriptSeed<R> {
  readonly conversation: Conversation<R> | null;
}
```

<a id="TranscriptSnapshot"></a>

### `TranscriptSnapshot`

```ts
interface TranscriptSnapshot<R> {
  readonly outcome: TranscriptOutcome;
  readonly tools: readonly TranscriptToolResult<R>[];
  readonly turns: readonly AgentTurn[];
}
```

<a id="TranscriptToolResult"></a>

### `TranscriptToolResult`

```ts
interface TranscriptToolResult<R> {
  readonly callId: string;
  readonly result: R;
}
```

<a id="TurnChunk"></a>

### `TurnChunk`

```ts
interface TurnChunk {
  readonly text: string;
}
```

<a id="TurnUsage"></a>

### `TurnUsage`

```ts
interface TurnUsage {
  readonly cachedInputTokens?: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
}
```

<a id="WiredToolCmd"></a>

### `WiredToolCmd`

```ts
type WiredToolCmd<T extends AnyToolDef> = [T] extends [never] ? never : ToolCmd<T>
```

<a id="WiredToolMsg"></a>

### `WiredToolMsg`

```ts
type WiredToolMsg<T extends AnyToolDef> = [T] extends [never] ? never : ToolMsg<T>
```
