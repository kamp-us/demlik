/**
 * @demlik/tea/agent — the domain data model: the tool + turn shapes the consumer
 * supplies, the agentic-stage conversation, the `createAgent` config knob, and
 * the durable agent slice + its lifecycle status.
 *
 * Everything here is plain data (durable + replayable): the composed bricks'
 * slices, the conversation, and the config are all JSON-serializable. The
 * compaction (#85) vocabulary lives in `./compaction`; this module imports its
 * types where the slice / config reference them. The reducer core (the verbs +
 * the wired `toMachine`) lives in `./index`.
 */

import type { FanOutState } from "../fan-out";
import type { Cmd } from "../index";
import type {
  LlmCall,
  LlmOk,
  MessageLoader,
  ModelFactory,
  ResilientState,
  Schema,
} from "../llm-call";
import type { MonitoredRunState, RunFailure } from "../monitored-run";
import type { RetryPolicy } from "../retry-backoff";
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
 * One tool the model asked to call this turn — the seed's `ToolCall`, stripped
 * of the audit-specific args typing. Plain data so it round-trips through the
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
 * One model turn — the seed's `AiTurn`, generalized: the narration `content`
 * the model produced and the `toolCalls` it asked us to run. An empty
 * `toolCalls` means the model is done with this stage (advance the pipeline).
 * This is the parsed output of a brain call; the consumer's schema produces it.
 */
export interface AgentTurn {
  /** Free-text narration the model produced this turn (folded into the conversation). */
  readonly content: string;
  /** The tools the model asked us to run; empty = stage done. */
  readonly toolCalls: readonly ToolCall[];
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
 * real parse of the boundary, not a shallow `Array.isArray`). PURE — allocates
 * no Error.
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
 * One settled tool outcome the consumer routes back into the loop — the seed's
 * `ToolOutcome`. `ok` carries the result the consumer's interpret produced;
 * `error` carries a reason the model sees (so it recovers rather than stalls —
 * "errors are data").
 */
export type ToolOutcome<R> =
  | { readonly kind: "ok"; readonly result: R }
  | { readonly kind: "error"; readonly reason: string };

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
// Conversation — the agentic-stage loop state (the seed's `Conversation`).
// ===========================================================================

/**
 * Whether the agentic stage is waiting on the model (`llm`), on tools
 * (`tools`), or on a compaction round-trip (`compacting`, #85). The in-flight
 * fan-out batch exists ONLY in the `tools` variant — "awaiting llm with tools
 * pending" is structurally impossible (the seed's canon §2.6 / Rule 1
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
// Config — the knob. The domain seams (tools / schemas / model / stages) are
// required; everything cross-cutting (retry / deadline / concurrency / loader /
// maxTurns) is optional, per the resilient-call "omit a brick → omit its gate".
// ===========================================================================

/**
 * The snapshotting discriminant (#55). Checkpointing is either OFF — in which
 * case `snapshotEvery` is structurally absent and the monitored-run slice never
 * emits a `snapshot_write` Cmd — or ON, in which case `snapshotEvery` is a
 * `number`. A `{ snapshotEvery?: never }` member (rather than a bare optional)
 * makes the OFF case load-bearing: it forbids passing `snapshotEvery` at all, so
 * `toMachine` can config-derive whether the `snapshot_write` interpret cell is
 * REQUIRED (ON) or FORBIDDEN (OFF) instead of defaulting it to a silent no-op.
 *
 * This is what kills the type lie: with checkpointing off, `snapshot_write` is
 * absent from the consumer's interpret contract entirely — never a
 * `snapshot_write: async () => undefined` ceremony that masks a real wiring bug.
 */
export type AgentSnapshotConfig =
  | { readonly snapshotEvery?: never }
  | { readonly snapshotEvery: number };

/**
 * The core (non-snapshot, non-compaction) agent knob. The full `AgentConfig`
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
 *                 key — the brain cell maps to `resilient_run`, the tool cell to
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
  /** DI port — the model factory `(modelId) => Llm`. */
  readonly model: ModelFactory<Msg>;
  /** One structured-output schema per purpose; the parse target per brain call. */
  readonly schemas: { readonly [K in P]: Schema<O[K]> };
  /** Backoff policy for brain calls, composed into `../llm-call`. Omit → no backoff. */
  readonly retry?: RetryPolicy;
  /** DI port — the SDK / message loader. Omit → brain calls invoke with `[]`. */
  readonly loadMessages?: MessageLoader<P, Msg>;

  // ---- fan-out seam (the tools) -------------------------------------------
  /** Map one tool call to the effect Cmd the consumer's interpret performs. */
  readonly toolOf: (call: ToolCall) => TC;
  /** Max tools in flight at once. Omit / `1` → serial dispatch (the seed's behavior). */
  readonly toolConcurrency?: number;

  // ---- the loop wiring -----------------------------------------------------
  /**
   * Which brain-call purpose a given stage runs. The agent fires
   * `call_llm{ turnOf(stage) }` to drive the agentic stage's loop. The purpose's
   * schema output is an `AgentTurn` — enforced by the `O extends Record<P,
   * AgentTurn>` bound, not left to a doc-comment.
   */
  readonly turnOf: (stage: Stage | undefined) => P;
  /** Build the per-purpose brain-call payload from the conversation. Omit → `null`. */
  readonly payloadOf?: (
    stage: Stage | undefined,
    conversation: Conversation<R>,
  ) => unknown;
  /** The model id every brain call invokes. Omit → `null` (the host's default). */
  readonly modelId?: string | null;
  /**
   * Livelock guard: bound on model round-trips within one run. On
   * `turnCount >= maxTurns` the run fails `{ reason: "turn_limit" }`. Omit → no
   * turn guard (only the deadline watchdog bounds the loop).
   */
  readonly maxTurns?: number;

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
 * The agent knob — the core seams intersected with the snapshotting discriminant
 * (`AgentSnapshotConfig`). Type parameters are documented on `AgentConfigCore`;
 * the only addition here is that `snapshotEvery` is the discriminant that drives
 * whether `toMachine` requires (or forbids) the `snapshot_write` interpret cell.
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
// Slice — the Model field this knob owns. Three composed slices + the loop's
// conversation. Plain data end to end → durable + replayable.
// ===========================================================================

/**
 * Why a run terminated as `failed`, beyond monitored-run's own reasons. The
 * `turn_limit` reason is the agent's livelock guard; deadline / stage failures
 * surface through the monitored-run slice's own `failure`.
 */
export type AgentFailure =
  | { readonly reason: "turn_limit"; readonly at: number }
  | { readonly reason: "llm"; readonly error: unknown; readonly at: number };

/**
 * The agent slice — every composed brick's slice plus the loop's conversation
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
   * a flat plain-data record — durable + replayable like every composed brick.
   */
  readonly compaction: ResilientState<
    LlmCall<CompactionPurpose>,
    LlmOk<CompactionPurpose, CompactionOutputs>
  >;
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
   * turn — the `O extends Record<P, AgentTurn>` knob bound pins every purpose's
   * output to an `AgentTurn`, and the terminating turn is the one with no tool
   * calls. The wider `Record<P, unknown>` bound on `AgentState` itself does not
   * constrain `O[P]`, so naming the concrete `AgentTurn` keeps this field's type
   * total without a purpose-indexing narrow.
   */
  readonly output: AgentTurn | null;
}

// ===========================================================================
// Lifecycle status — the ONE typed channel callers read instead of re-deriving
// the private slice shape (issue #49).
// ===========================================================================

/**
 * The unified terminal failure (issue #49). The agent terminates `failed`
 * through TWO independent slice channels:
 *
 *   - `state.failure` (`AgentFailure`) — the AGENT'S OWN annotation
 *     (`turn_limit` livelock guard / `llm` exhausted-retry). Set WITHOUT moving
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
 * doing?" (issue #49). A discriminated union on `kind` so any change to the
 * private slice shape (`Awaiting`, the failure channels, `run.phase`) forces a
 * compile error at the call sites that switch on it, instead of silently
 * breaking a hand-rolled re-derivation. Make-invalid-states-unrepresentable:
 *
 *   - `running`   — live, NOT awaiting tools (a brain call is in flight, or the
 *                   run is between stages). Not resumable on cold wake by
 *                   itself — the in-flight brain call re-fires from `boot`.
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
 */
export type AgentStatus<Stage> =
  | { readonly kind: "running" }
  | { readonly kind: "suspended"; readonly pending: readonly ToolCall[] }
  | { readonly kind: "done"; readonly output: AgentTurn | null }
  | { readonly kind: "failed"; readonly failure: AgentTerminalFailure<Stage> };

/**
 * Derive the agent's lifecycle `status` from its durable slice — the pure
 * status function that REPLACES every caller's hand re-derivation of the private
 * shape (issue #49). PURE — reads no clock / RNG, allocates one small record.
 *
 * Ordering is terminal-first so a settled run never reports `running`:
 *
 *   1. `state.failure` (the agent's own annotation, set WITHOUT moving
 *      `run.phase`) → `failed`. Checked first because `turn_limit` / `llm`
 *      leave `run.phase === "running"`; reading `run.phase` first would
 *      misreport such a run as `running`. This is the canonical failure source
 *      when present.
 *   2. `run.phase === "failed"` → `failed`, carrying `run.failure` (deadline /
 *      stage). The fallback channel.
 *   3. `run.phase === "done"` → `done` with `state.output` (#46).
 *   4. running + conversation + `awaiting.kind === "tools"` → `suspended` with
 *      the outstanding tool calls (`tools.running`). THE resumability condition.
 *   5. otherwise → `running`.
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
  // 2) The monitored-run terminal failure (deadline / stage). `run.failure` is
  //    non-null exactly when `phase === "failed"` (the run-state invariant), so
  //    the `!== null` guard narrows it with no assertion and no fabricated
  //    fallback — the unreachable phase-failed-yet-failure-null state falls
  //    through rather than inventing a failure to report.
  if (s.run.phase === "failed" && s.run.failure !== null) {
    return { kind: "failed", failure: s.run.failure };
  }
  // 3) The pipeline finished — the terminal output landed on `state.output`.
  if (s.run.phase === "done") {
    return { kind: "done", output: s.output };
  }
  // 4) Running + a live conversation awaiting tools → suspended (resumable).
  //    The outstanding calls are the in-flight fan-out batch (`tools.running`).
  if (s.conversation !== null && s.conversation.awaiting.kind === "tools") {
    return { kind: "suspended", pending: s.tools.running };
  }
  // 5) Otherwise the run is live and not awaiting tools.
  return { kind: "running" };
}
