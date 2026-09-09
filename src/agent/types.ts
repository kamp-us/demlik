/**
 * @demlik/tea/agent — the domain data model: the tool + turn shapes the consumer
 * supplies, the agentic-stage conversation, the `createAgent` config object, and
 * the durable agent slice + its lifecycle status.
 *
 * Everything here is plain data (durable + replayable): the composed wrappers'
 * slices, the conversation, and the config are all JSON-serializable. The
 * compaction vocabulary lives in `./compaction`; this module imports its
 * types where the slice / config reference them. The reducer core (the verbs +
 * the wired `toMachine`) lives in `./index`.
 */

import { absurd, type Cmd, type Tagged } from "../index";
import type { FanOutState } from "../internal/flow/fan-out";
import type {
  MonitoredRunState,
  RunFailure,
} from "../internal/flow/monitored-run";
import type {
  LlmCall,
  LlmOk,
  MessageLoader,
  ModelPort,
  ResilientState,
  Schema,
} from "../internal/llm-call";
import type { AnyRetryPolicy, RetryPolicy } from "../retry-backoff";
import type {
  AgentCompactionConfig,
  CompactionOutputs,
  CompactionPurpose,
} from "./compaction";
import { schemaFromGuard } from "./schema";

// ===========================================================================
// Domain seams the consumer supplies — the tool + turn shapes.
// ===========================================================================

/**
 * One tool the model asked to call this turn. Plain data so it round-trips through the
 * durable fan-out ledger: a stable `callId` (the fan-out identity), the tool
 * `name`, and the opaque `args` the consumer's own interpret reads.
 */
export interface ToolCall {
  /** Stable id the model minted; the fan-out item identity (`idOf`). */
  readonly callId: string;
  /** The tool to invoke. The consumer's `toolOf` maps it to an effect Cmd. */
  readonly name: string;
  /** Args the model emitted, opaque to the agent. */
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * One model turn: the narration `content` the model produced and the
 * `toolCalls` it asked us to run. An empty
 * `toolCalls` means the model is done with this stage (advance the pipeline).
 * This is the parsed output of a brain call; the consumer's schema produces it.
 *
 * `provider` is the opaque passthrough slot (#93): whatever the adapter hands
 * back beside `content` / `toolCalls` that its provider expects echoed
 * verbatim on the next turn — Anthropic's signed `thinking` blocks,
 * `server_tool_use`, OpenAI reasoning items. tea stores it on the turn and
 * returns it unchanged on the `assistant` `AgentMessage` that replays this
 * turn; it never reads, validates or transforms it. The adapter owns its shape,
 * which must be JSON-serializable like the rest of the Model. A compaction fold
 * (ADR 0004) summarises turns into text, so it drops the slot with the turns it
 * summarises. Optional and additive: a persisted turn without it still parses.
 */
export interface AgentTurn {
  /** Free-text narration the model produced this turn (folded into the conversation). */
  readonly content: string;
  /** The tools the model asked us to run; empty = stage done. */
  readonly toolCalls: readonly ToolCall[];
  /** Provider-opaque blocks to echo back verbatim next turn. tea never reads it. */
  readonly provider?: unknown;
}

/**
 * One partial piece of a turn the model is still producing — a token delta, as
 * the provider emitted it.
 *
 * A chunk is NOT state. It never reaches the Model, the journal or the Store:
 * by the time a turn is durable it has settled, and a delta that has not settled
 * is not an outcome ADR 0011 could fold. So `TurnChunk` carries only what a
 * progress surface renders — the text so far — and carries no identity, because
 * an identity would invite someone to store it.
 */
export interface TurnChunk {
  /** The text delta this chunk adds to the turn's `content`. */
  readonly text: string;
}

/**
 * The side channel a {@link StreamingModel} writes its deltas to — the second
 * argument of the streaming port. One sink, called synchronously by the adapter
 * as the provider yields; a throw from it is contained by the caller that
 * supplied it, so a progress surface's defect cannot fail a model call.
 */
export interface ModelStream {
  /** Hand one delta to whoever is watching this run. */
  readonly onChunk: (chunk: TurnChunk) => void;
}

/**
 * The streaming model port — `(messages, { onChunk }) => Promise<AgentTurn>`.
 *
 * The second, OPTIONAL shape of the brain. It differs from
 * `PlainModel<Msg, T>` in one thing: it is handed a {@link ModelStream} it may
 * write deltas to while the turn is in flight. What it RESOLVES is the same
 * settled turn the plain port resolves, and that turn is the only thing the
 * reducer ever sees — the deltas are a side channel that ends at the caller's
 * listener.
 *
 * A `PlainModel` is assignable here (a function may declare fewer parameters
 * than its type), which is what lets one config field accept either shape.
 * `isStreamingModel` tells them apart at runtime so a plain model is still
 * invoked with exactly one argument, as it always was.
 */
export type StreamingModel<Msg, T = unknown> = (
  messages: readonly Msg[],
  stream: ModelStream,
) => Promise<T>;

/**
 * Whether a model port wants the {@link ModelStream} — read off its declared
 * arity, which is the mark JavaScript already carries. No config flag, and no
 * marker property for a consumer to forget: a brain written
 * `async (messages, { onChunk }) => …` streams, and one written
 * `async (messages) => …` does not.
 *
 * The cost of the arity read is the cost of every arity read — a model that
 * declares a parameter it ignores, or takes `...args`, reads as the other shape.
 * Both misreads are benign: a `...args` model is handed no stream and emits no
 * chunks; a model with an unused second parameter is handed a stream it never
 * writes to. Neither can change the settled turn. PURE.
 */
export function isStreamingModel(
  model: (...args: never[]) => unknown,
): boolean {
  return model.length >= 2;
}

/**
 * Narrow an unknown to a `ToolCall` — the per-element witness `isAgentTurn`
 * folds over the `toolCalls` array. Checks the three load-bearing fields:
 * `callId`/`name` are strings, `args` is a non-null object. PURE — allocates no
 * Error. Without this the array-of-`ToolCall` narrow would be validation
 * masquerading as parse: `toolCalls: [1, 2, 3]` would pass, then the downstream
 * `dedupeByCallId` / `fan.scatter` read an `undefined` `callId` and wedge the
 * fan-out batch.
 */
function isToolCall(value: unknown): value is ToolCall {
  if (value === null || typeof value !== "object") return false;
  const t = value as { callId?: unknown; name?: unknown; args?: unknown };
  return (
    typeof t.callId === "string" &&
    typeof t.name === "string" &&
    t.args !== null &&
    typeof t.args === "object"
  );
}

/**
 * Narrow an unknown to an `AgentTurn` — the runtime witness for tea's own
 * structured-output type. A consumer's brain schema parses the model's output
 * into an `AgentTurn` (the agentic purpose's output); rather than every consumer
 * hand-rolling this guard + a `Schema<AgentTurn>` for a type the agent OWNS, the
 * agent exports both. Checks the load-bearing fields: `content` is a string and
 * `toolCalls` is an array of `ToolCall` (each element guarded — the narrow is a
 * real parse of the boundary, not a shallow `Array.isArray`). `provider` is
 * opaque, so its presence or absence is not a fact the guard reads. PURE —
 * allocates no Error.
 */
export function isAgentTurn(value: unknown): value is AgentTurn {
  if (value === null || typeof value !== "object") return false;
  const t = value as { content?: unknown; toolCalls?: unknown };
  return (
    typeof t.content === "string" &&
    Array.isArray(t.toolCalls) &&
    t.toolCalls.every(isToolCall)
  );
}

/**
 * The `Schema<AgentTurn>` for tea's own turn type — the parse target a brain
 * call binds when the agentic purpose's output is a bare `AgentTurn` (the common
 * case). Throws on a non-`AgentTurn` (the zod-style `parse` contract the
 * llm-call handler relies on). Deletes the consumer's hand-rolled
 * `auditSchema` / `isAgentTurn` pair.
 *
 * A consumer whose turn type EXTENDS `AgentTurn` with extra fields still writes
 * its own schema (it must validate the extra fields); this is for the plain case.
 */
export const agentTurnSchema: Schema<AgentTurn> = schemaFromGuard(
  isAgentTurn,
  "an AgentTurn",
);

/**
 * One settled tool outcome the consumer routes back into the loop.
 * `ok` carries the result the consumer's interpret produced;
 * `error` carries the failure as data — see {@link ToolFailure}.
 */
export type ToolOutcome<R> =
  | { readonly kind: "ok"; readonly result: R }
  | ToolFailure;

/**
 * A settled tool failure as the conversation keeps it: the `{ _tag, …payload }`
 * the tool failed with, spread beside the `reason` string the model reads.
 *
 * Both halves are load-bearing and neither replaces the other. `reason` is the
 * model's channel — `toolErrorReason`'s rendering, which is what the next brain
 * call carries; `_tag` and the payload are the program's, so host code can
 * branch on the failure instead of parsing prose out of `reason` (#115). A
 * payload field never shadows `kind` or `reason`: the router writes those last.
 *
 * `_tag` is OPTIONAL here for one reason only — a record persisted by 0.12.x or
 * earlier was written before the tag was kept, so a Store handing one back has
 * a failure with no tag, and a required field would be a lie about durable
 * state. Every failure THIS version mints carries one. For the exhaustive
 * per-tag union, take `onToolError`'s argument, which is typed from the tools
 * themselves ({@link ToolFailureOf}).
 */
export interface ToolFailure {
  readonly kind: "error";
  /** The model-facing rendering — `toolErrorReason(error)`. */
  readonly reason: string;
  /** The failure's tag; absent only on a record persisted before 0.13. */
  readonly _tag?: string;
}

/**
 * The failure arm typed against a KNOWN tag union — `{ kind, reason }` beside
 * each arm of `E`, distributed, so a `switch` on `_tag` narrows the payload and
 * an unhandled tag is a compile error. `ToolFailure` is its erased form.
 */
export type TaggedFailure<E extends Tagged> = E extends unknown
  ? { readonly kind: "error"; readonly reason: string } & E
  : never;

/**
 * The per-tool resilience knob — a timeout, a retry ladder, or both, declared on
 * the `tool()` spec and executed by the agent's reducer through
 * `../internal/resilience/resilient-call`.
 *
 * Both fields are optional and a tool that names neither behaves exactly as it
 * did before this knob existed: no slice entry is minted, no timer is armed, and
 * its settle path is the plain fan-out one. The ladder lives in the Model, so a
 * process killed between two attempts resumes at the attempt it was on rather
 * than restarting the run — the property a `Promise.race` or a `for` loop inside
 * the handler cannot have, because those live inside the effect boundary.
 */
export interface ToolResilience {
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
   * that never resolves at all holds the runtime's shutdown regardless, and
   * wants an `AbortSignal` in the handler rather than a budget out here.
   *
   * Omit → the call has no cap and ends only when its handler settles.
   */
  readonly timeoutMs?: number;
  /**
   * The backoff ladder a FAILED attempt climbs — the same
   * `BackoffCurve & RetryBudget` shape `AgentConfigCore.retry` takes for the
   * brain call. Each failure is recorded in the Model and the next attempt is
   * armed as a timer Sub, so the wait is durable and the attempt count survives
   * a reload. When the budget is spent the call settles as a `ToolOutcome` error
   * carrying `_tag: "retry_exhausted"` beside its `reason`, plus `attempts` and
   * `last` as fields — see {@link ToolRetryExhausted}.
   *
   * Omit → the first failure is the outcome, exactly as before.
   */
  readonly retry?: AnyRetryPolicy;
}

/** The reason-tag a timed-out tool call settles under. */
export const TOOL_TIMEOUT_TAG = "timeout";
/** The reason-tag a tool call that spent its retry budget settles under. */
export const TOOL_RETRY_EXHAUSTED_TAG = "retry_exhausted";

/** A call that spent its `timeoutMs` budget — {@link ToolResilience.timeoutMs}. */
export interface ToolTimedOut {
  readonly _tag: typeof TOOL_TIMEOUT_TAG;
}

/** A call that spent its retry budget — {@link ToolResilience.retry}. */
export interface ToolRetryExhausted {
  readonly _tag: typeof TOOL_RETRY_EXHAUSTED_TAG;
  /** How many attempts the ladder burned, the failed last one included. */
  readonly attempts: number;
  /** The last attempt's own `reason`, so the real failure is not buried. */
  readonly last: string;
}

/**
 * The two failures the resilience ladder itself authors — `timeout` and
 * `retry_exhausted`. They are in every tool's
 * error union rather than only a policied tool's: the policy is a `tool()` spec
 * field a maintainer can add later, and a union that narrowed with it would turn
 * adding a `timeoutMs` into a silent behaviour change at every `onToolError`
 * that had switched exhaustively without them.
 */
export type ToolResilienceError = ToolTimedOut | ToolRetryExhausted;

/**
 * A folded tool record kept on the conversation once a tool settles — the
 * call + its outcome, in settle order. The consumer's message loader reads
 * these (plus `turns`) to assemble the next brain call's prompt.
 *
 * `turn` is the `turnCount` at the time the record was folded — the association
 * compaction needs to drop the RIGHT records (#85 / design A1). When compaction
 * folds `turns[0..N]` into a summary, it must also drop every tool record that
 * belonged to those turns; without a turn stamp on the record there is no honest
 * way to know which. It is the round-trip index, not a wall clock — small and
 * JSON-stable, preserving the durability invariant.
 */
export interface ToolRecord<R> {
  readonly call: ToolCall;
  readonly outcome: ToolOutcome<R>;
  /** The `turnCount` at fold time — which round-trip this record belongs to (#85, A1). */
  readonly turn: number;
}

// ===========================================================================
// Conversation — the agentic-stage loop state.
// ===========================================================================

/**
 * Whether the agentic stage is waiting on the model (`llm`), on tools
 * (`tools`), or on a compaction round-trip (`compacting`). The in-flight
 * fan-out batch exists ONLY in the `tools` variant — "awaiting llm with tools
 * pending" is structurally impossible (TEA canon §2.6 / Rule 1
 * impossible-states pin). Discriminated on `kind`.
 *
 * `compacting` is the honest state for the dedicated compaction round-trip
 * (design B1): the transcript grew, the policy asked to fold `folding` of the
 * OLDEST turns, and the summarize call is in flight INSTEAD of the next brain
 * call. `folding` is the count `planCompaction` returned — the fold-back
 * (`compact_ok`) drops exactly that many head turns + their tool records.
 */
export type Awaiting =
  | { readonly kind: "llm" }
  | { readonly kind: "tools"; readonly batchTurn: number }
  | { readonly kind: "compacting"; readonly folding: number };

/**
 * The agentic-stage conversation — durable inside the agent slice so an
 * eviction mid-loop resumes the exact turn. The model turns + folded tool
 * records are the consumer's prompt source (via the llm-call message loader);
 * `turnCount` drives the livelock guard; `awaiting` carries the ONE outstanding
 * effect for the agentic stage.
 *
 * Generic over the consumer's tool-result type `R` (what `toolOk` carries).
 */
export interface Conversation<R> {
  /** Model turns this stage has produced, in order. */
  readonly turns: readonly AgentTurn[];
  /** Settled tool records, in settle order — the model sees these next turn. */
  readonly toolRecords: readonly ToolRecord<R>[];
  /** Monotonic round-trip count; the livelock guard compares it to `maxTurns`. */
  readonly turnCount: number;
  /** What the loop is waiting for next. */
  readonly awaiting: Awaiting;
}

// ===========================================================================
// Config — what the agent is configured with. The domain seams (tools /
// schemas / model / stages) are required; everything cross-cutting (retry /
// deadline / concurrency / loader / maxTurns) is optional, per the
// resilient-call "omit a composed wrapper → omit its gate".
// ===========================================================================

/**
 * The snapshotting discriminant. Checkpointing is either OFF — in which
 * case `snapshotEvery` is structurally absent and the monitored-run slice never
 * emits a `snapshot_write` Cmd — or ON, in which case `snapshotEvery` is a
 * `number`. A `{ snapshotEvery?: never }` member (rather than a bare optional)
 * makes the OFF case load-bearing: it forbids passing `snapshotEvery` at all, so
 * `toMachine` can config-derive whether the `snapshot_write` interpret handler
 * is REQUIRED (ON) or FORBIDDEN (OFF) instead of defaulting it to a silent
 * no-op.
 *
 * This is what kills the type lie: with checkpointing off, `snapshot_write` is
 * absent from the consumer's interpret contract entirely — never a
 * `snapshot_write: async () => undefined` ceremony that masks a real wiring bug.
 */
export type AgentSnapshotConfig =
  | { readonly snapshotEvery?: never }
  | { readonly snapshotEvery: number };

/**
 * The core (non-snapshot, non-compaction) agent configuration. The full `AgentConfig`
 * intersects this with the `AgentSnapshotConfig` + `AgentCompactionConfig`
 * discriminants — see those types for why the cadence / policy are discriminated
 * unions rather than bare optionals.
 *
 * Type parameters:
 *   - `Stage`   — the consumer's pipeline stage id (any JSON value).
 *   - `P`       — the brain-call purpose union (`"plan" | "act" | ...`).
 *   - `O`       — the purpose→output map. Every purpose drives the agentic loop,
 *                 so each output is pinned to `AgentTurn` (or a subtype) by the
 *                 `O extends Record<P, AgentTurn>` bound — that is what the loop
 *                 folds. An `Outputs` whose purpose output is NOT an `AgentTurn`
 *                 fails to compile here; the rule lives in the type, not a cast.
 *   - `R`       — the consumer's tool-result type (what `toolOk` carries).
 *   - `TC`      — the consumer's per-tool effect Cmd, the discriminated variant
 *                 `toolOf` produces. Kept PRECISE (a closed Cmd variant, not the
 *                 open `Cmd`) so `AgentCmd<P, TC>` stays a closed discriminated
 *                 union and the wired machine's interpret merge type-checks per
 *                 key — the brain handler maps to `resilient_run`, the tool one to
 *                 `TC["type"]` — with no laundering cast. Defaults to `Cmd` for
 *                 the consumer that does not care to name its tool Cmd.
 *   - `Msg`     — the model's message shape (threaded through the llm-call loader).
 */
export interface AgentConfigCore<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd = Cmd,
  Msg = unknown,
> {
  // ---- monitored-run seam (the outer pipeline) ----------------------------
  /** The ordered stages. Omit / empty → a single-shot run (one agentic stage). */
  readonly stages?: readonly Stage[];
  /** No-progress watchdog budget, in ms. Omit → no watchdog. */
  readonly deadlineMs?: number;

  // ---- llm-call seam (the brain) ------------------------------------------
  /**
   * DI port — the brain. `async (messages) => turn` is the common path:
   * the returned turn is validated through the purpose's schema
   * (`agentTurnSchema` for the plain case), so a malformed turn is the run's
   * `llm` failure, not a throw. `(modelId) => Llm` is the advanced form for a
   * model that binds the structured-output schema itself.
   */
  readonly model: ModelPort<Msg, O[P]>;
  /**
   * The system prompt, stored ON THE MODEL at `init` (`AgentState.instructions`)
   * rather than closed over — so a replay reproduces the exact prompt that ran,
   * a rehydrated run keeps the prompt it started with, and a compaction fold
   * (which touches only the conversation) can never lose it (ADR 0004). It
   * reaches the brain call through `payloadOf`'s third argument. Omit → `null`.
   */
  readonly instructions?: string;
  /** One structured-output schema per purpose; the parse target per brain call. */
  readonly schemas: { readonly [K in P]: Schema<O[K]> };
  /** Backoff policy for brain calls, composed into `../llm-call`. Omit → no backoff. */
  readonly retry?: RetryPolicy;
  /** DI port — the SDK / message loader. Omit → brain calls invoke with `[]`. */
  readonly loadMessages?: MessageLoader<P, Msg>;

  // ---- fan-out seam (the tools) -------------------------------------------
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
   * How many of ONE turn's tool calls a transition LAUNCHES at once — a
   * dispatch knob, not a wall-clock one. At the default `1` a turn's calls go
   * out one at a time; raise it and up to that many move from `pending` to
   * `running` in the fan-out ledger in a single transition, so the durable
   * Model (and a `store`'s record of it) says what was launched.
   *
   * It does NOT make two slow tools finish in the time of one. `runInterpret`
   * interprets a transition's Cmds one after another and never interleaves
   * them, so two launched calls still run back to back and the turn costs their
   * sum either way. That ordering is a guarantee, not an accident — settle Msgs
   * fold in Cmd-emission order so a replayed log reproduces the same fold — and
   * ADR 0018 records why it is not traded for overlap, and where real
   * wall-clock overlap is to live instead.
   *
   * Omit (or `1`) → serial dispatch, exactly as before.
   */
  readonly toolConcurrency?: number;

  // ---- the loop wiring -----------------------------------------------------
  /**
   * Which brain-call purpose a given stage runs. The agent fires
   * `call_llm{ turnOf(stage) }` to drive the agentic stage's loop. The purpose's
   * schema output is an `AgentTurn` — enforced by the `O extends Record<P,
   * AgentTurn>` bound, not left to a doc-comment.
   */
  readonly turnOf: (stage: Stage | undefined) => P;
  /**
   * Build the per-purpose brain-call payload from the durable state: the
   * stage, the conversation, and the Model's `instructions` slot. Omit → `null`.
   */
  readonly payloadOf?: (
    stage: Stage | undefined,
    conversation: Conversation<R>,
    instructions: string | null,
  ) => unknown;
  /** The model id every brain call invokes. Omit → `null` (the host's default). */
  readonly modelId?: string | null;
  /**
   * Livelock guard: bound on model round-trips within one run. On
   * `turnCount >= maxTurns` the run fails `{ reason: "turn_limit" }`. Omit → no
   * turn guard (the other stop conditions still bound the loop).
   */
  readonly maxTurns?: number;
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
   * The consumer's own stop condition, consulted at the turn boundary once the
   * turn-count and wall-clock guards have passed. `true` settles the run
   * `cancelled` at `at` — the same terminal an aborted `signal` reaches, so the
   * transcript stands and no further model call goes out. Omit → no predicate.
   *
   * Where `maxTurns` and `maxElapsedMs` bound a quantity this agent counts,
   * this bounds one only the caller can see (a token ledger, an external flag,
   * a condition on the turns so far). It must be PURE and total over the state
   * it is handed — the reducer calls it, so a replay of the same Msg log calls
   * it with the same state and must get the same answer. It is config, not
   * Model: a resumed run consults the predicate the config passed to THIS boot.
   */
  readonly stopWhen?: (state: AgentState<Stage, P, O, R>) => boolean;

  // ---- determinism seam ----------------------------------------------------
  /**
   * The impurity-injection seam for the inherited brain-call retry jitter — the
   * ONE place this otherwise-pure machine reads randomness. Pass a fixed
   * `() => 0` to pin backoff (tests, replay, durability proofs). Omit →
   * `Math.random`, read only at the resilient-call verb boundary.
   */
  readonly rng?: () => number;
}

/**
 * The agent configuration — the core seams intersected with the snapshotting discriminant
 * (`AgentSnapshotConfig`). Type parameters are documented on `AgentConfigCore`;
 * the only addition here is that `snapshotEvery` is the discriminant that drives
 * whether `toMachine` requires (or forbids) the `snapshot_write` interpret
 * handler.
 */
export type AgentConfig<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd = Cmd,
  Msg = unknown,
> = AgentConfigCore<Stage, P, O, R, TC, Msg> &
  AgentSnapshotConfig &
  AgentCompactionConfig<R, Msg>;

// ===========================================================================
// Slice — the Model field this configuration owns. Three composed slices + the loop's
// conversation. Plain data end to end → durable + replayable.
// ===========================================================================

/**
 * Why a run terminated as `failed`, beyond monitored-run's own reasons. The
 * `turn_limit` reason is the agent's livelock guard and `elapsed_limit` its
 * wall-clock one; deadline / stage failures surface through the monitored-run
 * slice's own `failure`.
 */
export type AgentFailure =
  | { readonly reason: "turn_limit"; readonly at: number }
  | { readonly reason: "elapsed_limit"; readonly at: number }
  | { readonly reason: "llm"; readonly error: unknown; readonly at: number };

/**
 * The agent slice — every composed wrapper's slice plus the loop's conversation
 * and the agent-specific failure annotation.
 *
 *   - `run`          — the `../monitored-run` slice (pipeline position +
 *                      lifecycle + watchdog). The OUTER lifecycle truth.
 *   - `resilience`   — the `../llm-call` (= resilient-call) slice (brain-call
 *                      retry / backoff). Per-purpose retry lives here.
 *   - `tools`        — the `../fan-out` ledger for the current turn's tools.
 *   - `conversation` — the agentic-stage loop state. `null` until the loop is
 *                      entered (the consumer seeds it at the agentic stage).
 *   - `failure`      — the agent-specific terminal annotation (turn-limit /
 *                      llm), null otherwise. Distinct from `run.failure`.
 *   - `instructions` — the system prompt this run was configured with, set at
 *                      `init` and never touched by a fold (ADR 0004).
 */
export interface AgentState<
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
> {
  readonly run: MonitoredRunState<Stage>;
  readonly resilience: ResilientState<LlmCall<P>, LlmOk<P, O>>;
  readonly tools: FanOutState<ToolCall, ToolOutcome<R>>;
  readonly conversation: Conversation<R> | null;
  /**
   * The compaction round-trip's resilient slice (#85, design B1) — a DEDICATED
   * resilient-call slice for the reserved `$compact` purpose, separate from the
   * brain `resilience` slice so a compaction retry/backoff never disturbs the
   * brain call's breaker or retry counter. Always present (empty `calls` when no
   * compaction is in flight, or when no policy is configured) so the slice stays
   * a flat plain-data record — durable + replayable like every composed wrapper.
   */
  readonly compaction: ResilientState<
    LlmCall<CompactionPurpose>,
    LlmOk<CompactionPurpose, CompactionOutputs>
  >;
  /**
   * The per-tool timeout / retry ladders (#117) — one dedicated resilient-call
   * slice PER TOOL NAME, because the policy is declared per tool and one slice
   * carries one config. Keyed by tool name; each slice's own keys are
   * {@link toolCallKey}s, so two concurrent calls to the same tool climb
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
  readonly toolResilience: Readonly<
    Record<string, ResilientState<ToolCall, null>>
  >;
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
  readonly failure: AgentFailure | null;
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
   * The system prompt, durable beside the transcript it governs. `null` when
   * the config named none. Read by `brainCall` on every model call — a
   * rehydrated or replayed run prompts with what the Model says, never with
   * what a closure happens to hold now.
   */
  readonly instructions: string | null;
}

// ===========================================================================
// Lifecycle status — the ONE typed channel callers read instead of re-deriving
// the private slice shape.
// ===========================================================================

/**
 * The unified terminal failure the agent settles on. The agent terminates `failed`
 * through TWO independent slice channels:
 *
 *   - `state.failure` (`AgentFailure`) — the AGENT'S OWN annotation
 *     (`turn_limit` livelock guard / `elapsed_limit` wall-clock guard / `llm`
 *     exhausted-retry). Set WITHOUT moving
 *     `run.phase` (it stays `running`); `isSettled` treats a non-null `failure`
 *     as terminal regardless of `run.phase`.
 *   - `state.run.failure` (`RunFailure`) — the monitored-run channel
 *     (`deadline` watchdog / `stage` failure), present iff `run.phase` is
 *     `"failed"`.
 *
 * Callers used to union these by hand at every status question. `status`
 * collapses them into ONE `failure`, so a consumer reads `status(s).failure`
 * without knowing which channel produced it.
 */
export type AgentTerminalFailure<Stage> = AgentFailure | RunFailure<Stage>;

/**
 * The agent's lifecycle status — THE single typed channel for "what is this run
 * doing?". A discriminated union on `kind` so any change to the
 * private slice shape (`Awaiting`, the failure channels, `run.phase`) forces a
 * compile error at the call sites that switch on it, instead of silently
 * breaking a hand-rolled re-derivation. Make-invalid-states-unrepresentable:
 *
 *   - `idle`      — never started: `run.phase === "idle"`, the slice straight
 *                   out of `init` before any `agent_start`. Distinct from
 *                   `running` so a "start or resume?" decision never boots a
 *                   run that has not begun (#92); the next move is `agent_start`.
 *   - `running`   — live, NOT awaiting tools (a brain call is in flight, or the
 *                   run is between stages). Not resumable on cold wake by
 *                   itself — the in-flight brain call re-fires from `boot`.
 *                   A `stale` run reads here too: monitored-run documents it
 *                   as a soft, still-resumable live mark that the next
 *                   `progress` flips back to `running`.
 *   - `suspended` — the RESUMABLE case: running + a live conversation +
 *                   `awaiting.kind === "tools"`. `pending` is the outstanding
 *                   tool calls (`conversation.awaiting` … the in-flight batch),
 *                   read off `tools.running`. This is exactly the shape
 *                   `agentIsResumable` re-derived by hand.
 *   - `done`      — the pipeline finished; `output` is the terminal model turn
 *                   stamped on `state.output` (issue #46), `null` if the run
 *                   produced no turn.
 *   - `failed`    — terminal failure; `failure` is the UNIFIED channel
 *                   (`AgentTerminalFailure`), absorbing the `state.failure` vs
 *                   `state.run.failure` dual channel so callers stop unioning.
 *   - `cancelled` — stopped because the caller asked — an aborted `AbortSignal`,
 *                   or their own `stopWhen` answering `true` at a turn boundary;
 *                   `at` is when the stop landed. Terminal and distinct from
 *                   `failed`: nothing went wrong, the caller asked, so a consumer
 *                   branching on failure does not have to except one reason. There is no
 *                   `output` — a cancelled run produced no terminal turn, and a
 *                   `null` one here would be indistinguishable from a `done` run
 *                   that produced none.
 */
export type AgentStatus<Stage> =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "suspended"; readonly pending: readonly ToolCall[] }
  | { readonly kind: "done"; readonly output: AgentTurn | null }
  | { readonly kind: "failed"; readonly failure: AgentTerminalFailure<Stage> }
  | { readonly kind: "cancelled"; readonly at: number };

/**
 * Ask where an agent run stands: pass its state, get back one of `idle`,
 * `running`, `suspended` (with the tool calls it is waiting on), `done` (with
 * the output) or `failed` (with the failure).
 *
 * Read this instead of picking at the state's own fields. PURE — reads no
 * clock or randomness, allocates one small record.
 *
 * Ordering is terminal-first so a settled run never reports `running`, and a
 * never-started one never reports live:
 *
 *   1. `state.failure` (the agent's own annotation, set WITHOUT moving
 *      `run.phase`) → `failed`. Checked first because `turn_limit` / `llm`
 *      leave `run.phase === "running"`; reading `run.phase` first would
 *      misreport such a run as `running`. This is the canonical failure source
 *      when present.
 *   2. `run.phase === "idle"` → `idle`. Never started (#92); after the failure
 *      check so the annotation stays canonical, before every live reading so
 *      an `init` slice is never mistaken for a run in flight.
 *   3. `run.phase === "failed"` → `failed`, carrying `run.failure` (deadline /
 *      stage). The fallback channel.
 *   4. `run.phase === "done"` → `done` with `state.output` (#46).
 *   5. `run.phase === "cancelled"` → `cancelled`, carrying when the stop landed.
 *   6. `running` / `stale` + conversation + `awaiting.kind === "tools"` →
 *      `suspended` with the outstanding tool calls (`tools.running`). THE
 *      resumability condition; otherwise the run reads `running`.
 *
 * Steps 2–6 are ONE exhaustive `switch` over `run.phase` closed by `absurd`, not
 * an `if` chain with a trailing `return { kind: "running" }`. Under the chain a
 * phase added to the slice and forgotten here reported as `running` — a terminal
 * run described as live, which is the worst answer this function can give and one
 * nothing would have caught. The switch turns that omission into a type error.
 */
export function status<
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
>(s: AgentState<Stage, P, O, R>): AgentStatus<Stage> {
  // 1) The agent's own failure annotation is canonical — it is set without
  //    moving `run.phase` (turn_limit / llm leave the run `running`), so it
  //    MUST be read before `run.phase` or such a failure reports as `running`.
  if (s.failure !== null) {
    return { kind: "failed", failure: s.failure };
  }
  // Bound to a local so the switch narrows ONE reference: `absurd(run)` below is
  // only reachable — and only type-checks — while every phase above returns.
  const run = s.run;
  switch (run.phase) {
    // 2) Never started — monitored-run's `idle` phase is exactly the "has this
    //    actually started?" guard, and the status channel keeps that distinction.
    case "idle":
      return { kind: "idle" };
    // 3) The monitored-run terminal failure (deadline / stage). `run.failure`
    //    rides ONLY the `failed` arm of the discriminated union, so narrowing on
    //    `phase === "failed"` surfaces it with no nullable side field and no
    //    fabricated fallback — the old "failed-yet-failure-null" state is
    //    unrepresentable.
    case "failed":
      return { kind: "failed", failure: run.failure };
    // 4) The pipeline finished — the terminal output landed on `state.output`.
    case "done":
      return { kind: "done", output: s.output };
    // 5) Stopped from outside. Terminal, and deliberately NOT folded into
    //    `failed`: the unified failure channel answers "what went wrong", and
    //    nothing did.
    case "cancelled":
      return { kind: "cancelled", at: run.at };
    // 6) Live. Awaiting tools is the resumable shape — the outstanding calls are
    //    the in-flight fan-out batch (`tools.running`); anything else is plain
    //    `running`, which is also where `stale` reads (a soft mark the next
    //    progress clears, not an outcome).
    case "running":
    case "stale":
      return s.conversation !== null && s.conversation.awaiting.kind === "tools"
        ? { kind: "suspended", pending: s.tools.running }
        : { kind: "running" };
  }
  // No `default` arm: an unhandled phase reaches here still typed, and `absurd`
  // takes only `never` — so adding a phase to the slice breaks the build at
  // exactly the reader that would otherwise mis-describe it.
  return absurd(run);
}
