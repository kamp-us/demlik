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
  /** No-progress watchdog budget, in ms. Omit → no watchdog. */
  readonly deadlineMs?: number;
  /**
   * The system prompt, stored ON THE MODEL at `init` (`AgentState.instructions`)
   * rather than closed over — so a replay reproduces the exact prompt that ran,
   * a rehydrated run keeps the prompt it started with, and a compaction fold
   * (which touches only the conversation) can never lose it (ADR 0004). It
   * reaches the brain call through `payloadOf`'s third argument. Omit → `null`.
   */
  readonly instructions?: string;
  /** DI port — the SDK / message loader. Omit → brain calls invoke with `[]`. */
  readonly loadMessages?: MessageLoader<P, Msg>;
  /**
   * Wall-clock guard: total milliseconds from `run.startedAt` the run may take.
   * At the turn boundary, `at - run.startedAt >= maxElapsedMs` fails the run
   * `{ reason: "elapsed_limit" }`. Unlike `deadlineMs` — a no-progress watchdog
   * that RESTARTS on every advance — this budget never restarts, so a run that
   * keeps progressing is bounded by it. Omit → no wall-clock cap.
   *
   * `startedAt` is durable, so a resumed run continues the ORIGINAL budget
   * rather than starting a fresh one; the elapsed span a killed run spent dead
   * counts against it.
   */
  readonly maxElapsedMs?: number;
  /**
   * Livelock guard: bound on model round-trips within one run. On
   * `turnCount >= maxTurns` the run fails `{ reason: "turn_limit" }`. Omit → no
   * turn guard (the other stop conditions still bound the loop).
   */
  readonly maxTurns?: number;
  /**
   * DI port — the brain. `async (messages) => turn` is the common path:
   * the returned turn is validated through the purpose's schema
   * (`agentTurnSchema` for the plain case), so a malformed turn is the run's
   * `llm` failure, not a throw. `(modelId) => Llm` is the advanced form for a
   * model that binds the structured-output schema itself.
   */
  readonly model: ModelPort<Msg, O[P]>;
  /** The model id every brain call invokes. Omit → `null` (the host's default). */
  readonly modelId?: string | null;
  /**
   * Build the per-purpose brain-call payload from the durable state: the
   * stage, the conversation, and the Model's `instructions` slot. Omit → `null`.
   */
  readonly payloadOf?: (
    stage: Stage | undefined,
    conversation: Conversation<R>,
    instructions: string | null,
  ) => unknown;
  /** Backoff policy for brain calls, composed into `../llm-call`. Omit → no backoff. */
  readonly retry?: RetryPolicy;
  /**
   * The impurity-injection seam for the inherited brain-call retry jitter — the
   * ONE place this otherwise-pure machine reads randomness. Pass a fixed
   * `() => 0` to pin backoff (tests, replay, durability proofs). Omit →
   * `Math.random`, read only at the resilient-call verb boundary.
   */
  readonly rng?: () => number;
  /** One structured-output schema per purpose; the parse target per brain call. */
  readonly schemas: { readonly [K in string]: Schema<O[K]> };
  /** The ordered stages. Omit / empty → a single-shot run (one agentic stage). */
  readonly stages?: readonly Stage[];
  /**
   * The consumer's own stop condition, consulted at the turn boundary once the
   * turn-count and wall-clock guards have passed. `true` settles the run
   * `cancelled` at `at` — the same terminal an aborted `signal` reaches, so the
   * transcript stands and no further model call goes out. Omit → no predicate.
   *
   * Where `maxTurns` and `maxElapsedMs` bound a quantity this agent counts,
   * this bounds one only the caller can see (an external flag, a condition on
   * the turns so far) — or a token budget: `state.usage` is the run's running
   * total of provider-reported usage, so a budget stop is a predicate over it
   * and needs no knob of its own (#332). It must be PURE and total over the state
   * it is handed — the reducer calls it, so a replay of the same Msg log calls
   * it with the same state and must get the same answer. It is config, not
   * Model: a resumed run consults the predicate the config passed to THIS boot.
   */
  readonly stopWhen?: (state: AgentState<Stage, P, O, R>) => boolean;
  /**
   * How many of ONE turn's tool calls a transition LAUNCHES at once. At the
   * default `1` a turn's calls go out one at a time; raise it and up to that
   * many move from `pending` to `running` in the fan-out ledger in a single
   * transition, so the durable Model (and a `store`'s record of it) says what
   * was launched.
   *
   * Above `1` those calls also OVERLAP on the clock, so a turn of two slow
   * tools costs the slower rather than the sum — but only for the tool cells a
   * `toolRouter` owns (the `toMachine({ tools })` path, which `defineAgent`
   * takes). The overlap lives inside those cells, never in the kernel:
   * `runInterpret` still interprets a transition's Cmds one after another and
   * never interleaves two handlers (ADR 0018). A hand-wired `toolInterpret`
   * cell is yours, so it overlaps only if you write it to.
   *
   * Overlapping does NOT reorder the fold. Settle Msgs are dispatched in
   * Cmd-EMISSION order whichever call finishes first, so a replayed log
   * reproduces the same Model — invariant 2's serializability, which the knob
   * was never allowed to spend.
   *
   * Omit (or `1`) → serial dispatch, exactly as before.
   */
  readonly toolConcurrency?: number;
  /** Map one tool call to the effect Cmd the consumer's interpret performs. */
  readonly toolOf: (call: ToolCall) => TC;
  /**
   * The per-tool timeout / retry knob for a call, read once per launch. `null`
   * (or an omitted seam) → the tool runs bare and its settle path is the plain
   * fan-out one, byte for byte what it was before the knob existed.
   *
   * This is the seam a `toolRouter` fills from the `tool()` specs
   * (`router.resilienceOf`), which is how `defineAgent` grows the knob without
   * growing a lid option: the policy is declared where the tool is. A hand-wired
   * `createAgent` supplies it directly. It must be PURE and config-derived — the
   * reducer calls it on the launch path.
   */
  readonly toolResilienceOf?: (call: ToolCall) => ToolResilience | null;
  /**
   * Which brain-call purpose a given stage runs. The agent fires
   * `call_llm{ turnOf(stage) }` to drive the agentic stage's loop. The purpose's
   * schema output is an `AgentTurn` — enforced by the `O extends Record<P,
   * AgentTurn>` bound, not left to a doc-comment.
   */
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
    /** The usage the provider reported for this turn. Absent → none reported. */
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
  /** When the transition that produced it happened. */
  readonly at: number;
  /** The run this event belongs to — stable across a kill and resume. */
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
  /** The brain call's `Cmd.define`d run Cmd def — list it in `cmds` when you hand-wire. */
  readonly brain: CmdDef<"resilient_run", {
    readonly input: LlmCall;
    readonly key: string;
  }>;
  readonly brainCall: (s: AgentState<Stage, P, O, R>) => LlmCall<P>;
  /**
   * The brain call's `resilient_run` handler — the one `toMachine` wires. Its
   * Cmd is `Cmd.define`d, so it returns an outcome and the engine mints the
   * `resilient_run_ok` / `resilient_run_err` Msg that `succeed` / `fail` fold
   * (ADR 0021). List `AgentKnob`'s brain Cmd def in `cmds` when you hand-wire.
   */
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
  /**
   * A bare `reason` string still works and settles an untagged failure — the
   * hand-wired shape this verb has always had. Hand it a whole `ToolFailure`
   * instead to keep the `{ _tag, …payload }` beside that reason, which is what
   * `onToolError` and any host code discriminating on `_tag` then read (#115).
   */
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
  /**
   * The compaction round-trip's resilient slice (#85, design B1) — a DEDICATED
   * resilient-call slice for the reserved `$compact` purpose, separate from the
   * brain `resilience` slice so a compaction retry/backoff never disturbs the
   * brain call's breaker or retry counter. Always present (empty `calls` when no
   * compaction is in flight, or when no policy is configured) so the slice stays
   * a flat plain-data record — durable + replayable like every composed wrapper.
   */
  readonly compaction: ResilientState<LlmCall<"$compact">, LlmOk<"$compact", CompactionOutputs>>;
  readonly conversation: Conversation<R> | null;
  readonly failure: AgentFailure | null;
  /**
   * The system prompt, durable beside the transcript it governs. `null` when
   * the config named none. Read by `brainCall` on every model call — a
   * rehydrated or replayed run prompts with what the Model says, never with
   * what a closure happens to hold now.
   */
  readonly instructions: string | null;
  /**
   * What THIS transition started, failed or ended (#331) — the outbox the
   * event projector reads. Cleared on entry to every verb, so it only ever
   * holds the one transition's facts.
   *
   * The projector sees `(msg, post-state)` and nothing else, and none of these
   * facts can be read back off that pair: a brain call issued after a batch
   * drains, a queued tool backfilling a slot, a timeout the ladder settled and
   * the transition that ended the run all leave a state that looks like the
   * one before. The reducer knows at the moment it does them, so it writes
   * them down here, the same way `refusedCalls` carries the one fact the
   * projector could not derive.
   *
   * Absent on a Model persisted before 0.18; every reader treats that as empty.
   */
  readonly lifecycle: readonly AgentLifecycleNote[];
  /**
   * The run's terminal output — the FIRST-CLASS result (issue #46). `null`
   * until the pipeline finishes; set to the last model turn (the empty-tool
   * turn that retired the final stage) the instant `run.phase` becomes `"done"`.
   *
   * This survives the `conversation` clear on stage retire: clearing the
   * conversation is correct durability hygiene (a finished stage's transcript
   * is not live state), but the run's PRODUCT is, so it lives here on the
   * durable slice rather than being scraped off the `observe` firehose by
   * matching the private `resilient_ok` Msg and racing the clear (the old
   * `captureLastTurn` dance this field deletes). A consumer reads
   * `runtime.result()?.output` / `(await runtime.done()).output`.
   *
   * Typed `AgentTurn | null` (not `O[P]`): the run's output is always a model
   * turn — the `O extends Record<P, AgentTurn>` type bound pins every purpose's
   * output to an `AgentTurn`, and the terminating turn is the one with no tool
   * calls. The wider `Record<P, unknown>` bound on `AgentState` itself does not
   * constrain `O[P]`, so naming the concrete `AgentTurn` keeps this field's type
   * total without a purpose-indexing narrow.
   */
  readonly output: AgentTurn | null;
  /**
   * The `callId`s whose PUBLIC outcome is already a failure (#145) — a tool the
   * ladder settled on its deadline or on a spent retry budget, or one whose own
   * error was folded. A promise cannot be cancelled, so the abandoned attempt
   * may still resolve; when it does, its late `_ok` names a `callId` listed
   * here and every public channel stays silent about it.
   *
   * The fan-out already drops the late value (its entry is gone, so the fold is
   * a no-op), but "folds nothing" and "emits nothing" are two different facts:
   * the event projector is Msg-shaped and would otherwise push a `ToolSettled`
   * for a `callId` `onToolError` already reported as `{ _tag: "timeout" }`. The
   * projector reads the post-transition state, by which point the ladder has
   * forgotten the key, so the discriminator is carried HERE rather than derived
   * from a presence check that erases both readings.
   *
   * Plain data, one string per failed call, cleared by `start` with the rest of
   * the prior run's bookkeeping. It survives the batch drain and the stage
   * retire on purpose — that is exactly when a late settle arrives.
   */
  readonly refusedCalls: readonly string[];
  readonly resilience: ResilientState<LlmCall<P>, LlmOk<P, O>>;
  readonly run: MonitoredRunState<Stage>;
  /**
   * The per-tool timeout / retry ladders (#117) — one dedicated resilient-call
   * slice PER TOOL NAME, because the policy is declared per tool and one slice
   * carries one config. Keyed by tool name; each slice's own keys are
   * toolCallKeys, so two concurrent calls to the same tool climb
   * independent ladders while sharing the tool's declared policy.
   *
   * A tool declaring neither `timeoutMs` nor `retry` mints no entry, so this is
   * `{}` for every agent that uses no per-tool knob — the addition costs an
   * empty record on the durable Model and nothing else.
   *
   * The result arm is `null`: a tool's VALUE settles through the fan-out ledger
   * and the conversation, exactly as before. This slice tracks only the ladder —
   * which attempt is out, when the next one is due, and when the budget is spent
   * — which is what has to survive a reload.
   */
  readonly toolResilience: Readonly<Record<string, ResilientState<ToolCall, null>>>;
  readonly tools: FanOutState<ToolCall, ToolOutcome<R>>;
  /**
   * The run's running usage total (#332, #354): every brain turn of this RUN
   * that reported usage, summed field by field. It is what the run cost, so it
   * belongs to the run and not to any one conversation: a compaction fold keeps
   * it, a stage advance keeps it, and the retire to `done` keeps it after the
   * conversation is cleared — `status(state)`'s `done` arm hands it on. Only
   * `agent_start` resets it to zero. Read it from `stopWhen` for a token budget.
   *
   * The one place the total lives. A Model persisted before this field held its
   * total on `conversation.usage`, and one persisted by 0.17.x held none; the
   * first transition either takes over lifts the old total here (or starts from
   * zero) and drops the conversation's copy.
   */
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
  /**
   * The child. Its bounds (`maxTurns`, `maxElapsedMs`, `stopWhen`), its tools
   * and its instructions are all its own definition's; the helper adds none.
   */
  readonly agent: DefinedAgent<CT>;
  /** The model-facing sentence — the same field `tool()` declares. */
  readonly description: string;
  /** Parses the parent model's `args`. */
  readonly input: StandardSchemaV1<unknown, Args>;
  /**
   * The namespace the child run's key sits under, read off the parent's ctx —
   * the parent run's id, a tenant, whatever keeps two parents' calls apart.
   * The key is `<namespace>/<callId>`.
   */
  readonly namespace: (ctx: HandlerCtx<Ctx>) => string;
  /** Parses what `result` returns, at the edge, like any tool's `ok`. */
  readonly ok: StandardSchemaV1<unknown, Ok>;
  /**
   * The child's whole input, derived from the call's args. It is the only thing
   * the child is told: the parent's conversation never reaches it.
   */
  readonly prompt: (args: Args) => string;
  /** The value the parent call settles with, read off the child's final turn. */
  readonly result: (output: AgentTurn) => Ok;
  /**
   * The child run's Store at `key`. The same key must reach the same durable
   * cell on every call, in every process — that is what makes a re-fired call
   * resume the child instead of restarting it.
   */
  readonly store: (key: string, ctx: HandlerCtx<Ctx>) => Store<DefinedAgentState<CT>>;
} & ChildCtxOption<CT, Ctx>
```

<a id="AgentTurn"></a>

### `AgentTurn`

```ts
interface AgentTurn {
  /** Free-text narration the model produced this turn (folded into the conversation). */
  readonly content: string;
  /** Provider-opaque blocks to echo back verbatim next turn. tea never reads it. */
  readonly provider?: unknown;
  /** The tools the model asked us to run; empty = stage done. */
  readonly toolCalls: readonly ToolCall[];
  /** The token usage the provider reported for this call. Omit → none reported. */
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
  /** DI port — the SDK / message loader for the summarize call. Omit → invoke with `[]`. */
  readonly loadMessages?: MessageLoader<"$compact", Msg>;
  /** Build the summarize call's prompt payload from the turns being folded. Omit → `null`. */
  readonly payloadOf?: (conversation: Conversation<R>, folding: number) => unknown;
  /** PURE trigger: how many OLDEST turns to fold (`0` = skip). No clock/RNG. */
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
  /** The model's summary of the folded-away (oldest) turns + their tool records. */
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
  /** What the loop is waiting for next. */
  readonly awaiting: Awaiting;
  /**
   * The latest context size: `inputTokens + outputTokens` of the most recent
   * brain turn — how much of the context window the transcript now fills.
   * `null` when that turn reported no usage, when a compaction fold has run
   * since (the pre-fold size describes a transcript that no longer exists), and
   * at the start of each stage. `compaction.afterContextTokens` reads it.
   */
  readonly contextTokens: number | null;
  /** Settled tool records, in settle order — the model sees these next turn. */
  readonly toolRecords: readonly ToolRecord<R>[];
  /** Monotonic round-trip count; the livelock guard compares it to `maxTurns`. */
  readonly turnCount: number;
  /** Model turns this stage has produced, in order. */
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
  /**
   * The slice of state this Sub depends on. `null` or `undefined` ⇒ off in
   * this state (see `depsInactive`), so `(s) => s.optionalRunId` gates
   * correctly. Pure (invariant 2). Plain JSON-compatible data only
   * (invariant 1): the structural hash THROWS on a `Date`, `Map`, `Set`,
   * `Error` or class instance rather than collapsing them onto one id.
   */
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
  /**
   * Bounds a run that keeps going without ever failing: the transcript budget,
   * past which the OLDEST turns are folded into one model-written summary
   * before the next brain call, so a long run's prompt stops growing instead of
   * climbing until the provider rejects it.
   *
   * The knob is a THRESHOLD, not a policy function — see
   * DefineAgentCompaction. `compaction` is what a run tolerates, and the
   * summarize round-trip that enforces it is wiring, so the lid takes the
   * former and supplies the latter from the `model` it already has.
   *
   * `afterTurns: 20` folds once the conversation holds twenty turns.
   * `afterContextTokens: 8_000` folds once the last brain turn's reported
   * `inputTokens + outputTokens` reaches eight thousand; the number is yours,
   * because tea knows no model's window size. Set both and the first one
   * reached folds. `keepTurns` is how many of the newest turns survive the
   * fold intact. It is not a guard: nothing fails, and the run goes on.
   *
   * Omit → NO compaction, exactly as before: the transcript grows for as long
   * as the model keeps asking for tools. Nothing is defaulted on your behalf —
   * a silent budget would change the prompt every existing caller sends.
   */
  readonly compaction?: DefineAgentCompaction;
  /**
   * Stops a run that stops progressing: milliseconds the run may sit without
   * advancing before it fails. The budget is a no-progress watchdog, not a
   * total wall-clock cap — it restarts each time the run moves. Omit → no
   * watchdog.
   *
   * The failure is `{ reason: "deadline", at }` on the Model's `run.failure`,
   * the monitored-run slice, and not on the agent's own `failure` field where
   * `turn_limit` and `elapsed_limit` land. `at` is when the watchdog fired. A
   * tool or model call already out runs to its own end first, so `run` can
   * settle later than `at`.
   */
  readonly deadlineMs?: number;
  /**
   * The system prompt — stored on the Model at `init` (ADR 0004) and never
   * re-read, so a resumed run keeps the prompt it started with even across a
   * redeploy that changed this string; to replace a bad prompt already in
   * flight, end that run and start a new one rather than resuming it.
   */
  readonly instructions: string;
  /**
   * Stops a run that keeps going, by the clock: total milliseconds from the
   * run's start it may take before it fails. This is the total wall-clock cap
   * `deadlineMs` is not — the budget never restarts, so a run that keeps
   * progressing is bounded by it where `deadlineMs` would let it run forever,
   * and it counts elapsed time where `maxTurns` counts round-trips. It is read
   * at the turn boundary, so like both of those it stops the run rather than
   * cancelling the work already in flight. Omit → no wall-clock cap.
   *
   * Read at the turn boundary means the run ends at the first boundary past
   * the budget, not at the millisecond it comes due: a run 10ms into a 400ms
   * tool call under a 150ms budget fails when that tool settles. The failure
   * is `{ reason: "elapsed_limit", at }` on the Model's own `failure` field,
   * beside `turn_limit`.
   *
   * The run's start time is on the durable Model, so a run killed and resumed
   * continues the ORIGINAL budget — the time it spent dead counts against it.
   *
   * The same name on a `DurationRetryPolicy` (`retry`, and a tool's own) is the
   * same idea one altitude down: that one bounds how long ONE call's retry
   * ladder may keep climbing, this one how long the whole run may take.
   */
  readonly maxElapsedMs?: number;
  /**
   * Stops a run that keeps going: the maximum number of model round-trips it
   * may take. Once the completed-turn count reaches it the run fails rather
   * than calling the model again. Omit → no limit on turns.
   *
   * The count is COMPLETED model round-trips. A compaction pass is not one, and
   * tool calls are not counted at all: a turn that asks for six tools is one
   * turn.
   *
   * The failure is `{ reason: "turn_limit", at }` on the Model's own `failure`
   * field. `run` rejects with a `DriveFailedError` whose `.state` is that final
   * Model.
   */
  readonly maxTurns?: number;
  /** The brain — either DefinedAgentModel shape. */
  readonly model: DefinedAgentModel;
  /**
   * Observe a tool call that failed, typed against THIS agent's tools: the
   * outcome is `{ kind: "error", _tag, …payload, reason }` over
   * `ToolError`'s union — declared tags, `thrown`, `malformed_result`,
   * `unknown_tool`, `malformed_args` — so a `switch` on `_tag` is exhaustive and an
   * unhandled failure mode is a compile error rather than a silent turn (#115).
   * The model still reads `reason` next turn either way — this is the host's
   * channel beside it, never instead of it.
   *
   * Called ONCE per failed call, at the interpret boundary: after the handler
   * settled, before the failure is folded into the conversation. It is awaited,
   * so an async hook holds the settle until it resolves — keep it short, and put
   * anything slow on your own queue.
   *
   * A resume calls it for the calls THIS process runs and no others: an outcome
   * a previous process already folded is in the Model the Store handed back and
   * is never re-interpreted, so a durable run does not re-fire the hook over its
   * history.
   *
   * The hook is CONTAINED, exactly as `onEvent` is: a throw (or a rejected
   * promise) is warned about and the run goes on, so `run`'s contract does not
   * depend on the hook's.
   *
   * Omit → the router is wired unwrapped and nothing observes failures.
   */
  readonly onToolError?: (outcome: ToolFailureOf<T>, ctx: ToolErrorContext) => void | Promise<void>;
  /**
   * The backoff ladder a FAILED BRAIN CALL climbs — the same `RetryPolicy`
   * shape `AgentConfigCore.retry` takes, threaded straight to it, so the ladder
   * runs in the resilient slice that already exists and lives on the Model:
   * each failure is recorded there and the next attempt is armed as a timer
   * Sub, which is what makes the wait durable and the attempt count survive a
   * reload.
   *
   * The per-tool knob grows no lid option because a `tool()` is a spec object
   * that declares its own policy (`ToolResilience.retry`). A
   * `defineAgent` `model` is a bare function with no spec object, so the lid is
   * the only declaration site a brain-call policy has.
   *
   * Omit → NO backoff, exactly as before: one throw from `model` ends the run
   * after a single attempt. Nothing is defaulted on your behalf — a silent
   * default would change the failure timing of every existing caller.
   */
  readonly retry?: RetryPolicy;
  /**
   * Stops a run on a condition only you can see: a predicate consulted at the
   * turn boundary, after the other three guards have passed, over the run's
   * durable Model. Answer `true` and the run ends there — settled `cancelled`,
   * the same terminal an aborted `signal` reaches, with the transcript intact
   * and no further model call made. Where `maxTurns` and `maxElapsedMs` bound
   * a quantity the agent counts for you and `deadlineMs` watches for a stall,
   * this bounds whatever you name — a token budget over `state.usage` (the
   * run's provider-reported total), an external flag, a condition on the turns
   * so far. Omit → no predicate.
   *
   * A stop you asked for is not a failure, so `run` RESOLVES with the final
   * Model where the other three guards make it reject, and `status(state)`
   * answers `{ kind: "cancelled", at }`.
   *
   * It must be PURE: the reducer calls it, so a replay hands it the same state
   * and must get the same answer. And it is config rather than Model — a
   * resumed run consults the predicate the config passed to THIS boot, exactly
   * as it uses the `maxTurns` passed to this boot.
   */
  readonly stopWhen?: (state: DefinedAgentState<T>) => boolean;
  /**
   * How many of ONE turn's tool calls a transition launches at once. At the
   * default `1` a turn's calls go out one at a time, each waiting for the last
   * to settle; raise it and up to that many are launched together, so they are
   * all in flight in the fan-out ledger rather than queued behind each other.
   * A turn asking for more calls than this runs them in waves.
   *
   * Launched together means overlapping on the clock: a turn of two slow tools
   * costs the slower of them, not their sum. The overlap lives inside the tool
   * Cmds' own handlers and NOT in the kernel — `runInterpret` still interprets
   * a transition's Cmds one after another and never interleaves two handlers,
   * which is ADR 0018's ruling and the reason a replay is unaffected. Settle
   * Msgs fold in Cmd-EMISSION order whichever call finishes first, so raising
   * the knob changes the turn's latency and nothing about its Model.
   *
   * Omit (or `1`) → serial dispatch, exactly as before.
   */
  readonly toolConcurrency?: number;
  /** The `tool()`s the model may call. */
  readonly tools: readonly T[];
}
```

<a id="DefinedAgent"></a>

### `DefinedAgent`

```ts
interface DefinedAgent<T extends AnyToolDef> {
  /**
   * The machine `run` drives for `input` and the interpret table it runs under
   * — the door down to the raw kernel.
   */
  readonly machine: (input: string) => DefinedAgentWired<T>;
  /**
   * Run `input` to its terminal Model. Resolves on `run.phase: "done"`; a
   * failed run rejects with `DriveFailedError` carrying the failed Model.
   *
   * With a `store`, the same call is also the resume: a Model the Store hands
   * back mid-run is booted (`agent_boot`) at its one outstanding effect —
   * same `runId`, no tool re-run — and one already `done` resolves as it is.
   * A fresh start needs an empty Store.
   *
   * It resolves with DefinedAgentResolvedState — the Model whose `run`
   * slice is narrowed to the ENDED phases, so `(await agent.run(i)).run.runId`
   * reads without a guard against an `idle` arm this promise cannot produce.
   */
  readonly run: (
    input: string,
    ...opts: [Record<never, never>] extends [UnionToIntersection<KnownToolCtx<ToolCtxBoxed<T>>>] ? [opts?: DefinedAgentRunOptions<T>] : [opts: DefinedAgentRunOptions<T>],
  ) => Promise<DefinedAgentResolvedState<T>>;
  /**
   * The ramp between the lid and `createAgent`: wrap ONE interpret cell of the
   * machine this agent builds and get back a NEW defined agent that runs the
   * wrapped table. The agent it is called on is untouched, and so is every cell
   * the overlay does not name.
   *
   *     const traced = agent.with({
   *       interpret: {
   *         fetch_rate: (next) => async (cmd, ctx, dispatch) => {
   *           console.time(cmd.callId);
   *           try { return await next(cmd, ctx, dispatch); }
   *           finally { console.timeEnd(cmd.callId); }
   *         },
   *       },
   *     });
   *
   * The wrapped cell settles through the SAME typed Cmd→Msg edge as the cell it
   * wraps — it returns whatever `next` returned — so the reducer folds the same
   * Msgs and a replay of a wrapped run is the unwrapped run's replay. That is
   * the whole contract: the door is one over the effect boundary, never over
   * the fold. A cell that must settle DIFFERENTLY is a different machine, and
   * `createAgent` is still where you build one.
   *
   * `with` composes — `agent.with(a).with(b)` puts `b`'s wrapper OUTSIDE `a`'s,
   * so `b` is entered first and `a`'s cell is what its `next` calls. Naming a
   * cell the machine has none of throws at `machine(input)`, where the table it
   * is checked against exists.
   */
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
  /** The clock that stamps `at`. Omit → `Date.now`. */
  readonly clock?: () => number;
  /**
   * Observe the token deltas of the turn being produced right now — the
   * granularity below `onEvent`'s. Wired only when the configured `model` is
   * the streaming shape (`async (messages, { onChunk }) => turn`); a plain
   * model has no deltas to give, so passing this beside one is silent.
   *
   * Chunks ride a SIDE CHANNEL, never state. They are not projected off
   * transitions like an AgentEvent is, because nothing about a chunk is
   * a transition: it is never journaled, never written to the `Store`, and
   * never folded into the Model. That is the whole rule this option obeys — a
   * delta that has not settled is not an outcome, so a run that dies mid-turn
   * loses its chunks and resumes from the last SETTLED turn, and a resumed run
   * re-emits nothing it did not itself re-produce.
   *
   * The listener is CONTAINED exactly as `onEvent`'s is: a throw is caught and
   * warned, never allowed to fail the model call it fired from.
   *
   * Omit → the streaming model is still invoked in its streaming shape, with a
   * sink that drops every chunk.
   */
  readonly onChunk?: (chunk: TurnChunk) => void;
  /**
   * Observe the run's turn-level lifecycle events — `TurnSettled`,
   * `ToolSettled`, `RunDone` — in the order the kernel settles them. This is
   * the progress seam: without it the only way to see anything mid-run is
   * `machine(input)` plus the raw kernel loop.
   *
   * It forwards the runtime's existing semantic stream (`agentEvents()` /
   * `runtime.on`); it mints no vocabulary of its own, so a consumer folds the
   * same AgentEvents a hand-wired `run` would.
   *
   * The listener is CONTAINED: a throw is caught and warned, never allowed to
   * take the run down, and never observable in `run`'s resolution. Only
   * transitions applied by THIS process project events, so a store-backed
   * resume replays nothing that settled before the boot.
   *
   * Omit → no projector is wired and the run behaves exactly as before.
   */
  readonly onEvent?: (event: DefinedAgentEvent<T>) => void;
  /** The run's identity. Omit → a fresh UUID. */
  readonly runId?: string;
  /**
   * Stop the run from outside — the stop button's seam. On abort the run settles
   * on a CANCELLED terminal Model and `run` RESOLVES with it; it does not reject,
   * and no `DriveFailedError` is thrown. Read the outcome with `status(state)`,
   * which answers `{ kind: "cancelled", at }` — distinct from `failed`, because a
   * run someone stopped did not fail.
   *
   * The outcome is durable, so it is also the answer on the next boot: a process
   * killed after an abort resumes reading a run that ENDED, not one to restart.
   * A signal already aborted when `run` is called ends it before the first model
   * call is made.
   *
   * It stops DISPATCH, not the work already in flight — a promise cannot be
   * cancelled, so a tool handler mid-call runs to its own end. Those late results
   * reach no `onEvent`, no `onToolError` and no Model, and they do not hold the
   * runtime's teardown. Propagating the signal INTO handlers is a separate seam
   * this option does not open.
   *
   * Omit → the run has no stop button and every path behaves exactly as before.
   */
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
  /** The model id to invoke; `null` = the host's default model. */
  readonly model: string | null;
  /** The per-purpose prompt payload the message loader consumes. Opaque to the knob. */
  readonly payload: unknown;
  /** The stage / schema selector — drives both `schemas[purpose]` and message assembly. */
  readonly purpose: P;
}
```

<a id="LlmErr"></a>

### `LlmErr`

```ts
interface LlmErr<P extends string> {
  /** The original error, carried untouched for the consumer to inspect. */
  readonly error: unknown;
  readonly key: string;
  readonly purpose: P;
  /** A human-readable cause (model throw, retry-exhaustion, or schema parse). */
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
  /** Hand one delta to whoever is watching this run. */
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
  /** Validate + narrow `value` to `T`, or throw on mismatch (the zod contract). */
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
    /**
     * What the model SEES of an `ok` result, as content parts. A screenshot
     * tool whose result is `{ jpeg }` (base64) declares
     * `content: (r) => [{ type: "image", mediaType: "image/jpeg", source: { type: "base64", data: r.jpeg } }]`.
     * The parts ride on the `tool` message beside the outcome, so an adapter
     * sends them instead of stringifying the result. PURE: it runs on every
     * render, over the result as the `Store` hands it back, and never on a
     * failure. Omit → the model reads the outcome as data, as before.
     */
    readonly content?: (result: Ok) => readonly ContentPart[];
    readonly description: string;
    readonly err: Tags;
    readonly input: StandardSchemaV1<unknown, Args>;
    readonly ok: StandardSchemaV1<unknown, Ok>;
    /**
     * The backoff ladder a failed attempt of this tool climbs — the same
     * `{ baseMs, factor, capMs, jitter, maxAttempts }` shape the brain call's
     * `retry` takes. The ladder is folded into the Model and its wait is a timer
     * Sub, so a process killed between two attempts resumes at the attempt it
     * was on. A spent budget settles as a `ToolOutcome` error carrying
     * `_tag: "retry_exhausted"` beside its `reason`, with the attempt count and
     * the last attempt's reason as the `attempts` / `last` fields.
     * Omit → the first failure is the outcome.
     */
    readonly retry?: AnyRetryPolicy;
    /**
     * The budget one call of this tool gets, in ms — the overall cap, measured
     * from the first attempt and not restarted by a retry. When it elapses the
     * call settles as a `ToolOutcome` error carrying `_tag: "timeout"` beside
     * its `reason`, and the loop moves on; the attempt is NOT cancelled (a promise cannot be), so it runs to its
     * own end and its late settle folds nothing. Omit → no cap.
     */
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
  /** Args the model emitted, opaque to the agent. */
  readonly args: Readonly<Record<string, unknown>>;
  /** Stable id the model minted; the fan-out item identity (`idOf`). */
  readonly callId: string;
  /** The tool to invoke. The consumer's `toolOf` maps it to an effect Cmd. */
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
  /** Phantom — the ctx the handler reads. Never assigned. */
  readonly __ctx?: Ctx;
  readonly args: StandardSchemaV1<unknown, Args>;
  /**
   * The parts the model reads for an `ok` result, or `null` when the tool
   * declared no `content` and the model reads the result as data.
   */
  readonly content: ((result: Ok) => readonly ContentPart[]) | null;
  readonly description: string;
  /**
   * The colocated handler, as an interpret cell: it returns the tool's
   * outcome, and the engine mints `<name>_ok` / `<name>_err` from it.
   */
  readonly interpret: (
    cmd: CmdValue<Name, ToolInput<Args>, Ok, E>,
    ctx: HandlerCtx<Ctx>,
  ) => Promise<Outcome<Ok, E>>;
  /**
   * The timeout / retry knob this tool declared, or `null` when it declared
   * neither. `toolRouter` serves it to the agent as `resilienceOf`.
   */
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
  /** The failure's tag; absent only on a record persisted before 0.13. */
  readonly _tag?: string;
  readonly kind: "error";
  /** The model-facing rendering — `toolErrorReason(error)`. */
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
  /** The `turnCount` at fold time — which round-trip this record belongs to (#85, A1). */
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
  /**
   * The backoff ladder a FAILED attempt climbs — the same
   * `BackoffCurve & RetryBudget` shape `AgentConfigCore.retry` takes for the
   * brain call. Each failure is recorded in the Model and the next attempt is
   * armed as a timer Sub, so the wait is durable and the attempt count survives
   * a reload. When the budget is spent the call settles as a `ToolOutcome` error
   * carrying `_tag: "retry_exhausted"` beside its `reason`, plus `attempts` and
   * `last` as fields — see ToolRetryExhausted.
   *
   * Omit → the first failure is the outcome, exactly as before.
   */
  readonly retry?: AnyRetryPolicy;
  /**
   * The budget one tool CALL gets, in ms, measured from the first attempt and
   * NOT restarted by a retry — the overall cap `resilient-call`'s deadline brick
   * enforces. When it elapses the call settles as a `ToolOutcome` error
   * carrying `_tag: "timeout"` beside its `reason`, and the loop moves on, whatever the
   * in-flight attempt does next — its late settle arrives for a call nothing is
   * waiting on and folds nothing, so a slow tool costs the budget and not the
   * turn.
   *
   * What it does NOT do is cancel the handler: a promise cannot be cancelled in
   * JavaScript, so the attempt runs to its own end, and `run`'s teardown still
   * drains it. A handler that resolves LATE is bounded by this knob; a handler
   * that never resolves at all holds the runtime's shutdown regardless. tea
   * hands a tool handler no `AbortSignal`: if the work has to stop, put a signal
   * of your own on the `ctx` you pass to `agent.run` and read it from the
   * handler's second argument.
   *
   * Omit → the call has no cap and ends only when its handler settles.
   */
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
  /** How many attempts the ladder burned, the failed last one included. */
  readonly attempts: number;
  /** The last attempt's own `reason`, so the real failure is not buried. */
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
  /** Every def the router settles through — hand to `Machine.cmds`. */
  readonly defs: readonly AnyCmdDef[];
  /** One interpret handler per tool plus the `tool_rejected` handler. */
  readonly interpret: Interpret<ToolMsg<T>, ToolCmd<T>, ToolsCtx<T>>;
  /**
   * Read a settled tool off a Msg: `null` when the Msg is not one of this
   * router's `<name>_ok` / `<name>_err`. The one place a `{ _tag }` failure is
   * rendered to the `reason` string the conversation carries — and the tag and
   * its payload ride beside that rendering, never instead of it (#115).
   */
  readonly outcomeOf: (msg: { readonly type: string }) => ToolSettlement<OkOf<T>, ToolError<T>> | null;
  /**
   * The parts the model reads for one settled call: the called tool's
   * `content` over an `ok` result. `null` for a failure, for a tool that
   * declared no `content`, and for a call no tool answers. PURE.
   */
  readonly partsOf: (call: ToolCall, outcome: ToolOutcome<unknown>) => readonly ContentPart[] | null;
  /**
   * The timeout / retry knob the called tool declared — `AgentConfigCore`'s
   * `toolResilienceOf` seam, filled from the `tool()` specs. `null` for a tool
   * that declared neither field and for a call no tool answers (the rejection
   * path settles in the reducer and never runs an effect to time out). PURE.
   */
  readonly resilienceOf: (call: ToolCall) => ToolResilience | null;
  /** The `toolOf` for `createAgent`: total, pure, parses `args` at the edge. */
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
  /** Wire this to `run`'s `onEvent`. */
  readonly onEvent: (event: AgentEvent<R>) => void;
  /** The transcript as of now. Each call returns a fresh immutable snapshot. */
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
  /** Whether `RunDone` has been seen, and how the run ended if so. */
  readonly outcome: TranscriptOutcome;
  /** Every tool call that settled OK, in settle order. */
  readonly tools: readonly TranscriptToolResult<R>[];
  /** Every model turn the transcript holds, in order. */
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
  /** The text delta this chunk adds to the turn's `content`. */
  readonly text: string;
}
```

<a id="TurnUsage"></a>

### `TurnUsage`

```ts
interface TurnUsage {
  /** Of `inputTokens`, those served from the provider's prompt cache — when it says. */
  readonly cachedInputTokens?: number;
  /** Prompt tokens the call read, cached ones included. */
  readonly inputTokens: number;
  /** Tokens the model produced. */
  readonly outputTokens: number;
  /** Of `outputTokens`, those spent on reasoning — when the provider says. */
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
