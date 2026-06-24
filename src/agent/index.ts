/**
 * @demlik/tea/agent — THE headline Level-3 machine: a durable, crash-recoverable
 * AI agent that runs an ordered stage pipeline, and inside the agentic stage
 * drives the classic loop `llm → tools → fold → llm` until the model stops
 * asking for tools.
 *
 * This is the `seed/audit-agent-machine` reducer generalized: the seed's audit /
 * glyph / violation domain specifics are stripped, and what remains — the loop,
 * the durability, the boot-reconcile crash recovery, the serial-vs-fanned tool
 * dispatch — is yours. The consumer supplies the only things that are genuinely
 * domain: the tools, the prompts (via the llm-call message loader), the schemas,
 * and the model. `createAgent(config)` returns the uniform knob contract every
 * composition exposes (`init` / verbs returning `readonly [State, Cmd[]]` /
 * `subs` / `handlers`) AND a ready-to-`run` `defineMachine` (`toMachine`).
 *
 * ## The composition (three siblings wired into ONE machine)
 *
 *   - `../monitored-run` — the OUTER pipeline + lifecycle + safety watchdog.
 *     The agent's stages (`plan → act → report`, say) are its stages; the
 *     position survives eviction, the no-progress deadline auto-fails a wedged
 *     run, and `boot` resumes mid-pipeline. The agent slice OWNS this slice and
 *     delegates `start` / `advance` / `progress` / `onDeadline` / `boot` to it.
 *   - `../llm-call` — every brain call (the seed's `call_llm{purpose}`). One
 *     `LlmCall` per turn, structured-output parsed, retry composed in. The agent
 *     delegates the resilient slice + verbs and reuses the detached handler.
 *   - `../fan-out` — the tool calls a turn produced. The seed dispatched tools
 *     SERIALLY (concurrency 1); fan-out generalizes that to bounded concurrency
 *     `config.toolConcurrency` (default 1 = the seed's serial behavior). Each
 *     tool is an `of(call)` Cmd the consumer's own interpret performs; results
 *     route back through `toolOk` / `toolErr`. When the batch drains, the agent
 *     folds the gathered results back into the conversation and fires the next
 *     brain call (`fold → llm`).
 *
 * ## The flow loop, as TEA (generalized from the seed's `applyAiTurn`)
 *
 *   1. `start` enters the pipeline; the consumer wires the per-stage outstanding
 *      effect (often a `call_llm` for the agentic stage) off the current stage.
 *   2. `turn(msg)` folds one model turn:
 *        - no tool calls → the loop is done for this stage → `advance` the
 *          pipeline (next stage, or finish to `done`).
 *        - tool calls → `scatter` them across fan-out (≤ concurrency in flight),
 *          emitting the per-tool effect Cmds. The conversation records the model
 *          turn; `awaiting` flips to `tools`.
 *   3. `toolOk` / `toolErr` fold each settled tool back, launching the next
 *      queued tool. When the batch drains, fold the gathered outcomes into the
 *      conversation, bump the turn count (livelock guard), and fire the next
 *      brain call — `awaiting` flips back to `llm`.
 *   4. The watchdog + turn-limit guard bound the loop; the deadline fires
 *      `failed`, the turn limit fires `failed { turn_limit }`.
 *
 * ## Boot reconcile (crash recovery — the seed's `outstandingEffect`)
 *
 * Cold wake re-derives the ONE outstanding effect from `phase × awaiting`: a
 * brain call in flight re-fires `call_llm`; tools in flight re-fire the in-flight
 * tool Cmds. Re-fire is Model-idempotent — had the prior effect's result been
 * processed, the durable Model would already have advanced and boot re-emits the
 * NEXT effect. `boot` re-seeds the watchdog clock to NOW (a cold wake is not a
 * no-progress wedge) via the inherited monitored-run `boot`.
 *
 * ## The two non-negotiables (canon, inherited)
 *
 *   - **Durable** — the whole slice is plain data: the monitored-run slice, the
 *     resilient (retry) slice, the fan-out ledger, and the conversation are all
 *     JSON-serializable. It survives DO eviction / reload.
 *   - **Replayable** — every transition is a pure verb returning new state +
 *     Cmds; nothing here reads the clock or RNG. Time arrives as an `at`
 *     parameter, jitter RNG is injected once at `createAgent`, and the only clock
 *     reads live inside the spliced handlers (the effect boundary).
 *
 * ## Typical wiring
 *
 *   // Type params: <Stage, Purpose, Outputs, Result, ToolCmd, Msg>. `ToolCmd`
 *   // is the discriminated Cmd `toolOf` returns — keep it precise (not the open
 *   // `Cmd`) so the wired machine's interpret merge type-checks per key.
 *   type RunTool = { readonly type: "run_tool" } & ToolCall;
 *   const agent = createAgent<Stage, Purpose, Outputs, Result, RunTool, Msg>({
 *     stages: ["plan", "act", "report"],
 *     model: (id) => createChatModel(env, id),
 *     schemas: { plan: planSchema, act: turnSchema, report: reportSchema },
 *     turnOf: (stage) => stageToPurpose[stage],   // which brain call a stage runs
 *     toolOf: (call): RunTool => ({ type: "run_tool", ...call }),
 *     toolConcurrency: 1,                          // serial like the seed (default)
 *     deadlineMs: 10 * 60_000,
 *     maxTurns: 60,
 *     retry: defaultRetryPolicy,
 *     loadMessages,
 *   });
 *   // The consumer supplies the per-tool (+ snapshot) interpret; the agent owns
 *   // the brain interpret and merges them in `toMachine`.
 *   const machine = agent.toMachine({ toolInterpret });
 *   const runtime = run(machine, { ctx, store });
 */

import { createFanOut, type FanOutState, initFanOut } from "../fan-out";
import {
  type Cmd,
  defineMachine,
  type Interpret,
  type Machine,
  type Reducer,
} from "../index";
import {
  createLlmCall,
  deadlineSub,
  type LlmCall,
  type LlmCallPorts,
  type LlmErr,
  type LlmFailMsg,
  type LlmOk,
  type LlmRunCmd,
  type LlmSucceedMsg,
  type LlmTimerMsg,
  type MessageLoader,
  type ModelFactory,
  type ResilientState,
  type Schema,
  subscribeDeadline,
} from "../llm-call";
import {
  createMonitoredRun,
  type DeadlineSub,
  type MonitoredRunCmd,
  type MonitoredRunState,
} from "../monitored-run";
import type { RetryPolicy } from "../retry-backoff";

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
 * Narrow an unknown to an `AgentTurn` — the runtime witness for tea's own
 * structured-output type. A consumer's brain schema parses the model's output
 * into an `AgentTurn` (the agentic purpose's output); rather than every consumer
 * hand-rolling this guard + a `Schema<AgentTurn>` for a type the agent OWNS, the
 * agent exports both. Checks the two load-bearing fields: `content` is a string,
 * `toolCalls` is an array. PURE — allocates no Error.
 */
export function isAgentTurn(value: unknown): value is AgentTurn {
  if (value === null || typeof value !== "object") return false;
  const t = value as { content?: unknown; toolCalls?: unknown };
  return typeof t.content === "string" && Array.isArray(t.toolCalls);
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
export const agentTurnSchema: Schema<AgentTurn> = {
  parse: (value: unknown): AgentTurn => {
    if (!isAgentTurn(value)) {
      throw new Error("structured-output parse failed: not an AgentTurn");
    }
    return value;
  },
};

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
 */
export interface ToolRecord<R> {
  readonly call: ToolCall;
  readonly outcome: ToolOutcome<R>;
}

// ===========================================================================
// Conversation — the agentic-stage loop state (the seed's `Conversation`).
// ===========================================================================

/**
 * Whether the agentic stage is waiting on the model (`llm`) or on tools
 * (`tools`). The in-flight fan-out batch exists ONLY in the `tools` variant —
 * "awaiting llm with tools pending" is structurally impossible (the seed's
 * canon §2.6 / Rule 1 impossible-states pin). Discriminated on `kind`.
 */
export type Awaiting =
  | { readonly kind: "llm" }
  | { readonly kind: "tools"; readonly batchTurn: number };

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
 * The agent knob. Type parameters:
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
export interface AgentConfig<
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
  /** Periodic durable checkpoint cadence. Omit → no checkpointing. */
  readonly snapshotEvery?: number;

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
  readonly failure: AgentFailure | null;
}

// ===========================================================================
// Cmds + Msgs the knob speaks. Generic over the composed bricks' shapes.
// ===========================================================================

/** The brain-call effect Cmd, inherited from `../llm-call`. */
export type AgentLlmRunCmd<P extends string> = LlmRunCmd<P>;

/**
 * The Cmd union the agent emits, as a CLOSED discriminated union (precise `TC`,
 * not the open `Cmd`) so `Interpret<M, AgentCmd<P, TC>, Ctx>` maps each key
 * precisely and `toMachine` merges the interpret halves with no laundering cast:
 *
 *   - `AgentLlmRunCmd<P>`     — the brain-call run Cmd (`resilient_run`), folded
 *                              by the wired `brainHandlers` cell.
 *   - `MonitoredRunCmd<unknown>` — the durable checkpoint write the monitored-run
 *                              slice emits when `snapshotEvery` is set (forwarded
 *                              out of `advance`). The consumer owns its interpret
 *                              (the agent never persists; it only forwards).
 *   - `TC`                    — the consumer's per-tool effect, mapped to the
 *                              consumer's own tool interpret cell.
 */
export type AgentCmd<P extends string, TC extends Cmd = Cmd> =
  | AgentLlmRunCmd<P>
  | MonitoredRunCmd<unknown>
  | TC;

/** The brain-call success / failure settle Msgs, inherited from `../llm-call`. */
export type AgentLlmOkMsg<
  P extends string,
  O extends Record<P, unknown>,
> = LlmSucceedMsg<P, O>;
export type AgentLlmErrMsg<P extends string> = LlmFailMsg<P>;

/**
 * The timer Msg (retry + safety deadline) — `DeadlineExceeded`, the shared
 * shape of both bricks' timer Msgs (`LlmTimerMsg` and `MonitoredRunTimerMsg`
 * are both `DeadlineExceeded`). One Msg variant covers both timers; `onTimer`
 * disambiguates by Sub id. This is also the machine Msg the `subscribeDeadline`
 * cell dispatches directly (no wrapping), matching the sibling gold standard.
 */
export type AgentTimerMsg = LlmTimerMsg;

/** Ports the consumer supplies to the llm-call handler — re-exported shape. */
export type AgentPorts<
  P extends string,
  O extends Record<P, unknown>,
  M,
> = LlmCallPorts<P, O, M>;

/**
 * The LEGACY detached brain-call handler dictionary `handlers(ports)` returns —
 * the inherited `../llm-call` detached form's exact shape, NOT an `Interpret`.
 * The `resilient_run` cell runs the invoke inside `ctx.waitUntil` and dispatches
 * the consumer's `onOk` / `onErr` Msg directly (returning `void`), so it is a
 * fire-and-forget handler with a structural `{ waitUntil, dispatch }` ctx — it
 * does not re-enter the resilient settle Msg and so does not drive the retry
 * loop. Naming the type precisely (rather than laundering it through
 * `as unknown as Interpret<...>`) keeps `agent.handlers(ports)` honest: the
 * consumer that wires the verbs by hand gets the real detached shape, and its
 * `resilient_run` is callable with a plain Cmd + a `{ waitUntil, dispatch }` ctx
 * with no `as never` at the call site.
 */
export type AgentDetachedHandlers<P extends string, M> = {
  readonly resilient_run: (
    cmd: AgentLlmRunCmd<P>,
    ctx: {
      waitUntil(p: Promise<unknown>): void;
      dispatch(msg: M): unknown;
    },
  ) => void;
};

// ===========================================================================
// Sub-id helpers — the agent owns no NEW sub ids; it merges the two bricks'.
// ===========================================================================

// ===========================================================================
// The knob factory.
// ===========================================================================

/**
 * Build an agent knob from `config`. The determinism seam — `config.rng`,
 * injected for the inherited brain-call retry jitter — lives as a named field
 * on the config (pass a fixed `() => 0` to pin backoff in tests; omit → defaults
 * to `Math.random`, read only at the resilient-call verb boundary).
 *
 * Returns the uniform knob contract (`init` / verbs / `subs` / `handlers`) plus
 * `toMachine()` — a `defineMachine` wiring all of it into one runnable machine.
 */
export function createAgent<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd = Cmd,
  Msg = unknown,
>(config: AgentConfig<Stage, P, O, R, TC, Msg>) {
  const rng = config.rng ?? Math.random;
  // ---- The three composed sub-knobs --------------------------------------

  const run = createMonitoredRun<Stage, unknown>({
    ...(config.stages !== undefined ? { stages: config.stages } : {}),
    ...(config.deadlineMs !== undefined
      ? { deadlineMs: config.deadlineMs }
      : {}),
    ...(config.snapshotEvery !== undefined
      ? { snapshotEvery: config.snapshotEvery }
      : {}),
  });

  const llm = createLlmCall<P, O, Msg>(
    {
      model: config.model,
      schemas: config.schemas,
      ...(config.retry !== undefined ? { retry: config.retry } : {}),
      ...(config.loadMessages !== undefined
        ? { loadMessages: config.loadMessages }
        : {}),
    },
    rng,
  );

  // Tools fan out at `toolConcurrency` (default 1 = the seed's serial dispatch).
  // The fan-out item is the `ToolCall`; its identity is `callId`; each launch is
  // the consumer's `toolOf(call)` effect. No `join` — the agent reads completion
  // off `isComplete` at the settle boundary (it must fold + fire the next brain
  // call, not emit a single completion Cmd).
  // `TC` is the fan-out's launch-Cmd type and `never` its join-Cmd type (the
  // agent fires no `join` — it reads completion off `isComplete`), so `scatter`
  // / `itemOk` / `itemErr` return `readonly TC[]` (not the widened `Cmd[]`). The
  // agent's verb tuples stay precisely `AgentCmd<P, TC>` with no widening cast
  // on the launch cmds.
  const fan = createFanOut<ToolCall, ToolOutcome<R>, TC, never>({
    concurrency: config.toolConcurrency ?? 1,
    idOf: (call) => call.callId,
    of: (call) => config.toolOf(call),
  });

  type State = AgentState<Stage, P, O, R>;

  /** The starting slice — every brick's `init`, no conversation yet. */
  function init(): State {
    return {
      run: run.init(),
      resilience: llm.init(),
      tools: initFanOut<ToolCall, ToolOutcome<R>>(),
      conversation: null,
      failure: null,
    };
  }

  /** A fresh conversation entering the agentic loop — awaiting the first brain call. */
  function freshConversation(): Conversation<R> {
    return {
      turns: [],
      toolRecords: [],
      turnCount: 0,
      awaiting: { kind: "llm" },
    };
  }

  /**
   * Collapse a turn's tool calls to one per `callId` (first occurrence wins).
   * `callId` is the fan-out identity (`idOf`); duplicates in one batch are a
   * model defect that, un-deduped, would double-execute the tool and wedge the
   * batch (one settle Msg cannot close two same-id `running` entries). PURE —
   * preserves order, allocates no Error.
   */
  function dedupeByCallId(calls: readonly ToolCall[]): readonly ToolCall[] {
    const seen = new Set<string>();
    const out: ToolCall[] = [];
    for (const call of calls) {
      if (seen.has(call.callId)) continue;
      seen.add(call.callId);
      out.push(call);
    }
    return out;
  }

  /** The current pipeline stage value (`undefined` for a single-shot run). */
  function currentStage(s: State): Stage | undefined {
    return s.run.stepStates.find((i) => i.status === "running")?.input;
  }

  /** Build the brain-call request for the current stage + conversation. PURE. */
  function brainCall(s: State): LlmCall<P> {
    const stage = currentStage(s);
    const conversation = s.conversation ?? freshConversation();
    return {
      purpose: config.turnOf(stage),
      model: config.modelId ?? null,
      payload: config.payloadOf ? config.payloadOf(stage, conversation) : null,
    };
  }

  // === Verb: start =========================================================

  /**
   * Start (or restart) the run for `runId` at `at`, entering the agentic loop:
   * seed the pipeline (via monitored-run), seed a fresh conversation, and fire
   * the first brain call. PURE — `at` is the only clock.
   */
  function start(
    s: State,
    runId: string,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    const [runSlice] = run.start(s.run, runId, at);
    const conversation = freshConversation();
    const withRun: State = {
      ...s,
      run: runSlice,
      conversation,
      failure: null,
      tools: initFanOut<ToolCall, ToolOutcome<R>>(),
    };
    const call = brainCall(withRun);
    const [resilience, cmds] = llm.attempt(withRun.resilience, call, at);
    return [{ ...withRun, resilience }, cmds];
  }

  // === Verb: turn ==========================================================

  /**
   * Fold ONE model turn (the brain call resolved with an `AgentTurn`). The core
   * of the loop — the seed's `applyAiTurn`, generalized:
   *
   *   - empty `toolCalls` → the loop is done for this stage → `advance` the
   *     pipeline (next stage seeds a fresh conversation + brain call, or finish
   *     to `done`).
   *   - non-empty `toolCalls` → `scatter` them across fan-out (≤ concurrency in
   *     flight), recording the turn and flipping `awaiting` to `tools`. The
   *     returned Cmds are the launched per-tool effects.
   *
   * A no-op when the run is settled or the slice is not awaiting a brain call
   * (stale settle after boot / advance). PURE — `at` is the only clock.
   */
  function turn(
    s: State,
    result: AgentTurn,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    if (isSettled(s)) return [s, []];
    const conv = s.conversation;
    if (conv === null || conv.awaiting.kind !== "llm") return [s, []];

    const withTurn: Conversation<R> = {
      ...conv,
      turns: [...conv.turns, result],
    };

    // ── No tool calls → the stage's loop is done → advance the pipeline. ──
    if (result.toolCalls.length === 0) {
      return advanceStage({ ...s, conversation: withTurn }, at);
    }

    // ── Tool calls → scatter across fan-out (serial by default). ──
    // The fan-out item identity IS `callId` (`idOf`). A model that emits the
    // SAME `callId` twice in one turn is a defect: scattering both would launch
    // the consumer's `toolOf(call)` effect twice for one identity (the dup runs
    // TWICE) while a single settle Msg can only close ONE of the two `running`
    // entries — the other stays in flight forever and the batch never drains.
    // Collapse duplicates by `callId` (keep first occurrence) so every distinct
    // tool launches exactly once and each `callId` settles exactly once.
    const batch = dedupeByCallId(result.toolCalls);
    const [tools, launchCmds] = fan.scatter(
      initFanOut<ToolCall, ToolOutcome<R>>(),
      batch,
    );
    const nextConv: Conversation<R> = {
      ...withTurn,
      awaiting: { kind: "tools", batchTurn: withTurn.turnCount },
    };
    // An advance of the loop is progress — bump the monitored-run watchdog.
    const [runSlice] = run.progress(s.run, undefined, at);
    return [{ ...s, run: runSlice, tools, conversation: nextConv }, launchCmds];
  }

  /**
   * Advance the outer pipeline on a finished stage loop. Retire the current
   * stage (monitored-run `advance`); if the pipeline finished → `done`, else
   * seed a fresh conversation for the next stage and fire its first brain call.
   * Shared by `turn` (empty tool calls) so the loop-end → next-stage move lives
   * in one place. PURE.
   */
  function advanceStage(
    s: State,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    const [runSlice, runCmds] = run.advance(
      s.run,
      undefined,
      { kind: "ok" },
      at,
    );
    // Pipeline finished (or single-shot done) → no further brain call.
    if (runSlice.phase === "done") {
      return [{ ...s, run: runSlice, conversation: null }, runCmds];
    }
    // Next stage → fresh conversation + its first brain call.
    const conversation = freshConversation();
    const moved: State = {
      ...s,
      run: runSlice,
      conversation,
      tools: initFanOut<ToolCall, ToolOutcome<R>>(),
    };
    const call = brainCall(moved);
    const [resilience, llmCmds] = llm.attempt(moved.resilience, call, at);
    return [{ ...moved, resilience }, [...runCmds, ...llmCmds]];
  }

  // === Verb: toolOk / toolErr ==============================================

  /**
   * Record a tool's success for `callId` and launch the next queued tool to
   * backfill the freed slot (the seed's queue-drain → next-tool). When the batch
   * drains, fold every gathered outcome into the conversation, bump the turn
   * count (livelock guard), and fire the next brain call — `awaiting` flips back
   * to `llm` ("fold → llm"). PURE.
   */
  function toolOk(
    s: State,
    callId: string,
    result: R,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    return settleTool(s, callId, { kind: "ok", result }, at);
  }

  /**
   * Record a tool's failure for `callId` — symmetric to `toolOk`. A failed tool
   * still counts toward batch completion (the model sees the error reason and
   * recovers — "errors are data"); same fold → llm tail when the batch drains.
   * PURE.
   */
  function toolErr(
    s: State,
    callId: string,
    reason: string,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    return settleTool(s, callId, { kind: "error", reason }, at);
  }

  /**
   * Shared tool-settle body: route the outcome into fan-out, fold the matching
   * call+outcome onto the conversation, and — if the batch is now complete —
   * fold the turn and fire the next brain call. PURE.
   */
  function settleTool(
    s: State,
    callId: string,
    outcome: ToolOutcome<R>,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    if (isSettled(s)) return [s, []];
    const conv = s.conversation;
    if (conv === null || conv.awaiting.kind !== "tools") return [s, []];

    // Find the original call (by id) so the folded record carries it. A settle
    // for an unknown / already-settled id is a no-op (fan-out also no-ops it).
    const call = s.tools.running.find((c) => c.callId === callId);
    if (call === undefined) return [s, []];

    const [tools, launchCmds] =
      outcome.kind === "ok"
        ? fan.itemOk(s.tools, callId, outcome)
        : fan.itemErr(s.tools, callId, outcome);

    const foldedConv: Conversation<R> = {
      ...conv,
      toolRecords: [...conv.toolRecords, { call, outcome }],
    };

    // Batch still draining → record + keep launching the next queued tool.
    if (!fan.isComplete(tools)) {
      const [runSlice] = run.progress(s.run, undefined, at);
      return [
        { ...s, run: runSlice, tools, conversation: foldedConv },
        launchCmds,
      ];
    }

    // ── Batch drained → fold the turn → fire the next brain call. ──
    const turnedConv: Conversation<R> = {
      ...foldedConv,
      turnCount: foldedConv.turnCount + 1,
      awaiting: { kind: "llm" },
    };

    // Livelock guard: the bumped turn count crossing maxTurns → terminal fail.
    if (
      config.maxTurns !== undefined &&
      turnedConv.turnCount >= config.maxTurns
    ) {
      return failTurnLimit({ ...s, tools, conversation: turnedConv }, at);
    }

    // An advance of the loop is progress — bump the watchdog, then fire.
    const [runSlice] = run.progress(s.run, undefined, at);
    const fired: State = {
      ...s,
      run: runSlice,
      tools: initFanOut<ToolCall, ToolOutcome<R>>(),
      conversation: turnedConv,
    };
    const nextCall = brainCall(fired);
    const [resilience, llmCmds] = llm.attempt(fired.resilience, nextCall, at);
    return [{ ...fired, resilience }, [...launchCmds, ...llmCmds]];
  }

  /** Terminal: the livelock guard tripped. Settle the run failed. PURE. */
  function failTurnLimit(
    s: State,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    return [{ ...s, failure: { reason: "turn_limit", at } }, []];
  }

  // === Verb: succeed / fail (brain-call resilient settles) =================

  /**
   * Fold a brain-call SUCCESS — the FIXED single entry the re-entered
   * `resilient_ok` settle Msg drives. Two halves, in order:
   *
   *   1. The RETRY layer: `llm.succeed` closes the breaker and DROPS this key's
   *      retry counter. This is the half the old detached wiring skipped — the
   *      detached handler dispatched the parsed turn directly and never
   *      re-entered `resilient_ok`, so `succeed` never ran, the resilient slice
   *      stayed stuck `running`, the breaker never closed, and the retry counter
   *      ACCUMULATED across the run (a later transient failure would trip
   *      `maxAttempts` prematurely). Running it here resets the retry slice every
   *      turn — a clean retry slice across the whole run.
   *   2. The LOOP: fold the parsed `AgentTurn` (`msg.result.output`) through
   *      `turn`, which scatters this turn's tools (or advances the pipeline on an
   *      empty turn). One re-entered settle Msg now advances BOTH the resilient
   *      slice AND the conversation, so the loop actually progresses to a
   *      terminal `done`.
   *
   * PURE — `at` is the only clock.
   */
  function succeed(
    s: State,
    key: string,
    msg: AgentLlmOkMsg<P, O>,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    // 1) Advance the retry layer — resets retry[key], closes the breaker.
    const [resilience, retryCmds] = llm.succeed(s.resilience, key, msg);
    const settled: State = { ...s, resilience };
    // 2) Fold the parsed turn into the loop (scatter tools / advance the stage).
    //    `msg.result.output` is `O[P]`, and the `O extends Record<P, AgentTurn>`
    //    bound pins every purpose's output to an `AgentTurn` — so it feeds `turn`
    //    with NO cast. The rule lives in the type (invariant 8: no `as` past the
    //    boundary), not in a doc-comment the compiler cannot enforce.
    const [withTurn, turnCmds] = turn(settled, msg.result.output, at);
    return [withTurn, [...retryCmds, ...turnCmds]];
  }

  /**
   * Record a brain-call failure: back off via the inherited retry (re-arming
   * the retry timer), or — when retry is exhausted / absent — the resilient
   * slice settles the call `failed`. The agent also stamps an `llm` failure on
   * its own slice so a consumer can render the terminal cause. PURE.
   */
  function fail(
    s: State,
    key: string,
    msg: AgentLlmErrMsg<P>,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    const [resilience, cmds] = llm.fail(s.resilience, key, msg);
    // If the resilient slice settled this call terminally (no retry pending),
    // surface the agent-level llm failure too. A `waiting_retry` phase means a
    // retry is armed → not terminal → leave `failure` untouched.
    const call = resilience.calls[key];
    const failure: AgentFailure | null =
      call?.phase === "failed"
        ? { reason: "llm", error: msg.error, at }
        : s.failure;
    return [{ ...s, resilience, failure }, cmds];
  }

  // === Verb: onTimer =======================================================

  /**
   * A timer fired — disambiguated by Sub id across the two composed bricks:
   *
   *   - a `resilient:*` id → a brain-call retry timer → re-run the brain call
   *     via the inherited llm-call `onTimer`.
   *   - a `monitored:safety:*` id → the no-progress watchdog → fail the run via
   *     the inherited monitored-run `onDeadline`.
   *
   * The two brick `onTimer` / `onDeadline` verbs each tolerate a stale fire for
   * the other's id (they no-op on a non-matching id), so threading the Msg
   * through both is safe. PURE.
   */
  function onTimer(
    s: State,
    msg: AgentTimerMsg,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    if (msg.id.startsWith("monitored:")) {
      const [runSlice] = run.onDeadline(s.run, msg);
      return [{ ...s, run: runSlice }, []];
    }
    const [resilience, cmds] = llm.onTimer(s.resilience, msg);
    return [{ ...s, resilience }, cmds];
  }

  // === Verb: boot ==========================================================

  /**
   * Resume after a reload (cold wake) — the seed's boot reconcile, generalized.
   * Re-seeds the watchdog clock to `at` (a cold wake is not a no-progress wedge)
   * via monitored-run `boot`, then RE-EMITS the ONE outstanding effect derived
   * from `phase × awaiting`:
   *
   *   - awaiting `llm`   → re-fire the current stage's brain call (idempotent:
   *     had the response been processed, the durable Model would already have
   *     advanced + persisted, so boot re-emits the NEXT effect).
   *   - awaiting `tools` → re-fire every in-flight tool Cmd (idempotent via
   *     `callId` — the consumer's tool runner dedupes a re-issued call).
   *   - no conversation (between stages / settled) → no effect.
   *
   * A no-op on a settled run. PURE.
   */
  function boot(
    s: State,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    const [runSlice] = run.boot(s.run, at);
    const rebooted: State = { ...s, run: runSlice };
    if (isSettled(rebooted)) return [rebooted, []];

    const conv = rebooted.conversation;
    if (conv === null) return [rebooted, []];

    if (conv.awaiting.kind === "llm") {
      // Re-fire the brain call. The resilient slice already tracks it `running`;
      // re-issuing the same key is idempotent at the gate (re-emits the run Cmd).
      const call = brainCall(rebooted);
      const [resilience, cmds] = llm.attempt(rebooted.resilience, call, at);
      return [{ ...rebooted, resilience }, cmds];
    }

    // awaiting tools → re-fire every running tool's effect Cmd.
    const cmds = rebooted.tools.running.map((call) => config.toolOf(call));
    return [rebooted, cmds];
  }

  // === Derived ============================================================

  /** True iff the run is in a terminal state (monitored-run done/failed, or agent failure). */
  function isSettled(s: State): boolean {
    return (
      s.run.phase === "done" || s.run.phase === "failed" || s.failure !== null
    );
  }

  // === Subs ================================================================

  /**
   * The merged subscription set — the brain-call retry timers (`../llm-call`)
   * and the no-progress safety deadline (`../monitored-run`). Both are
   * `DeadlineSub`s reconciled by id, wired with one `subscribe: { deadline:
   * subscribeDeadline }` cell. PURE.
   */
  function subs(s: State): readonly DeadlineSub[] {
    return [...llm.subs(s.resilience), ...run.subs(s.run)];
  }

  // === Handlers ============================================================

  /**
   * The brain-call interpret handler — DETACHED, inherited from `../llm-call`.
   * It assembles messages, binds the purpose schema, invokes (retry composed),
   * parses, and dispatches the consumer's `onOk` / `onErr` Msg (carrying the
   * parsed `AgentTurn` for `onOk`).
   *
   * LEGACY — kept ONLY for the consumer that wires the verbs by hand and wants
   * the fire-and-forget dispatch shape. It does NOT drive the inherited retry
   * loop (it never re-enters the `resilient_ok` settle Msg, so `succeed` /
   * `fail` never run — the breaker never closes, the retry counter never
   * resets). `toMachine` does NOT use this form; it uses the FIXED `brainHandlers`
   * below, which returns the settle Msg for re-entry. See llm-call's `handlers`
   * doc (the same retry-loop gap, fixed the same way).
   *
   * Returns the inherited detached shape verbatim (`AgentDetachedHandlers`) — a
   * fire-and-forget `resilient_run` cell, NOT an `Interpret` (it returns `void`
   * and takes the structural `{ waitUntil, dispatch }` ctx the detached form
   * runs the invoke against). The type is named precisely so no cast launders a
   * `void`-returning cell into the re-entry `Interpret` contract.
   *
   * The per-tool effects are NOT handled here — `config.toolOf` produces a Cmd
   * the consumer's OWN interpret performs (the agent never owns the tool I/O;
   * the seed's `send_tool_call` handler is the consumer's), routing Ok/Err back
   * to `toolOk` / `toolErr`. This matches fan-out's "the consumer owns `of`'s
   * interpret" discipline.
   */
  function handlers<M>(
    ports: AgentPorts<P, O, M>,
  ): AgentDetachedHandlers<P, M> {
    return llm.handlers(ports);
  }

  /**
   * The FIXED brain-call interpret handler — the no-arg `../llm-call` form that
   * RETURNS the enriched resilient settle Msg (`resilient_ok` carrying the
   * parsed `LlmOk`, or `resilient_err` carrying the typed `LlmErr`). The
   * substrate enqueues an interpret handler's returned Msg as a FOLLOW-UP
   * (re-entry) onto the dispatch tail, so the machine's `resilient_ok` /
   * `resilient_err` reducer arms run `succeed` / `fail`, advancing the inherited
   * retry loop (succeed/fail → backoff → onTimer → re-issue) AND folding the
   * parsed turn into the conversation. This is the wiring that lets the loop
   * reach a clean terminal `done` with a reset retry slice — the headline L3 fix.
   */
  function brainHandlers<Ctx>(): Interpret<
    LlmSucceedMsg<P, O> | LlmFailMsg<P>,
    AgentLlmRunCmd<P>,
    Ctx
  > {
    // `llm.handlers()` is `{ resilient_run: (cmd: LlmRunCmd<P>) => Promise<
    // LlmSucceedMsg<P,O> | LlmFailMsg<P>> }`. That is structurally an
    // `Interpret` over the single `resilient_run` Cmd: the cell may ignore the
    // `ctx` param (a handler taking fewer args is assignable), and its returned
    // settle Msg is the exact `M` subset. No cast — the precise type holds.
    return llm.handlers();
  }

  /**
   * Wire the agent into a single runnable `defineMachine`. The host Msg union is
   * the closed set of verb entry points; `update` routes each to the matching
   * verb, `subscriptions` merges the two bricks' subs, `subscribe` wires the one
   * deadline cell, and `interpret` is the FIXED brain-call handler.
   *
   * The brain call uses the FIXED no-arg `../llm-call` handler (`brainHandlers`):
   * its returned `resilient_ok` / `resilient_err` settle Msg RE-ENTERS the
   * reducer, where the `resilient_ok` arm runs `succeed` (reset retry + close
   * breaker + fold the parsed turn) and the `resilient_err` arm runs `fail`
   * (back off via retry, re-arm the timer). This is what drives the loop to a
   * clean terminal `done` with a reset retry slice — fixing the L3 break where
   * the old detached handler dispatched the turn directly, never re-entered the
   * settle Msg, and so `succeed` never ran (stuck `running`, accumulating retry).
   *
   * The consumer supplies only the per-tool interpret (the agent owns the brain
   * interpret now; no `ports` to supply — the parsed turn is folded by `succeed`,
   * not by a consumer-built Msg).
   *
   * `HostMsg` is fixed to the agent's own verb-driven Msg union so the machine
   * is self-contained; a consumer needing extra Msgs wires the verbs by hand
   * instead (the knob contract is the escape hatch).
   */
  function toMachine<Ctx = object>(opts?: {
    /**
     * The consumer's interpret for the non-brain Cmds — the per-tool effect
     * `TC` plus the monitored-run `snapshot_write` checkpoint (when
     * `snapshotEvery` is set). The brain `resilient_run` cell the agent owns is
     * merged in below, so the consumer supplies only the rest of the closed
     * `AgentCmd<P, TC>` union.
     */
    readonly toolInterpret?: Interpret<AgentMachineMsg<P, O, R>, TC, Ctx> &
      // `snapshot_write` is REQUIRED only when `snapshotEvery` is set (a real
      // checkpoint write must be wired). With checkpointing off, no
      // `snapshot_write` Cmd is ever emitted, so the agent defaults the cell to
      // a no-op below — the consumer omits it. `Partial` makes it optional at
      // the type level; the agent fills the gap.
      Partial<
        Interpret<AgentMachineMsg<P, O, R>, MonitoredRunCmd<unknown>, Ctx>
      >;
  }): Machine<
    State,
    AgentMachineMsg<P, O, R>,
    AgentCmd<P, TC>,
    DeadlineSub,
    Ctx
  > {
    type M = AgentMachineMsg<P, O, R>;
    // The FIXED brain handler returns the settle Msg for re-entry; the substrate
    // enqueues it as a follow-up dispatched back into `update` (the `resilient_*`
    // arms below). It is PRECISELY an `Interpret` over the brain Cmd
    // (`AgentLlmRunCmd<P>`); the consumer's `toolInterpret` is PRECISELY an
    // `Interpret` over the rest of the closed union (`MonitoredRunCmd<unknown> |
    // TC`). `mergeInterpret` joins the two disjoint halves into the full
    // `Interpret<M, AgentCmd<P, TC>, Ctx>` — each key maps precisely
    // (`resilient_run` → the brain cell, `TC["type"]` / `snapshot_write` → the
    // consumer's cells), with the one sound mapped-type identity isolated in the
    // helper rather than laundered through `as unknown as` here.
    // Default the `snapshot_write` cell to a no-op when the consumer omits it.
    // With `snapshotEvery` unset the monitored-run slice never emits a
    // `snapshot_write` Cmd, so this cell is never reached — it exists only to
    // satisfy the closed `AgentCmd` union's interpret contract, killing the
    // `snapshot_write: async () => undefined` ceremony every non-checkpointing
    // consumer wrote. A checkpointing consumer (`snapshotEvery` set) supplies a
    // real cell, which overrides this default in the spread.
    const noopSnapshot: Interpret<M, MonitoredRunCmd<unknown>, Ctx> = {
      snapshot_write: async () => undefined,
    };
    const consumerInterpret = {
      ...noopSnapshot,
      ...(opts?.toolInterpret ?? {}),
    } as Interpret<M, MonitoredRunCmd<unknown> | TC, Ctx>;
    const interpret: Interpret<M, AgentCmd<P, TC>, Ctx> = mergeInterpret<
      M,
      MonitoredRunCmd<unknown> | TC,
      AgentLlmRunCmd<P>,
      Ctx
    >(consumerInterpret, brainHandlers<Ctx>());

    // Type the dispatch table explicitly so each cell gets its narrowed Msg
    // and the Reducer-form overload of `defineMachine` matches cleanly (the
    // agent State is not a discriminated union, so the Transitions overload's
    // `update` field collapses to `never` and would otherwise mask inference).
    const update: Reducer<State, M, AgentCmd<P, TC>> = {
      agent_start: (s, m) => start(s, m.runId, m.at),
      agent_turn: (s, m) => turn(s, m.turn, m.at),
      agent_tool_ok: (s, m) => toolOk(s, m.callId, m.result, m.at),
      agent_tool_err: (s, m) => toolErr(s, m.callId, m.reason, m.at),
      // The re-entered brain-call settle Msgs (from `brainHandlers`): success
      // runs `succeed` (reset retry + fold the turn), failure runs `fail`.
      resilient_ok: (s, m) => succeed(s, m.key, m, m.at),
      resilient_err: (s, m) => fail(s, m.key, m, m.at),
      deadline_exceeded: (s, m) => onTimer(s, m),
      agent_boot: (s, m) => boot(s, m.at),
    };

    // Build the machine as a fully-typed `Machine<...>` const, then pass it
    // through `defineMachine`'s identity. Annotating the const resolves the
    // `Machine` type's conditional `interpret` requirement against the concrete
    // type params here; calling `defineMachine` with explicit type args instead
    // would defer that conditional over the generic `TC` and fail the overload.
    const machine: Machine<State, M, AgentCmd<P, TC>, DeadlineSub, Ctx> = {
      init: (loaded) => (loaded !== null ? [loaded, []] : [init(), []]),
      update,
      subscriptions: (s) => subs(s),
      subscribe: { deadline: subscribeDeadline },
      interpret,
    };
    return defineMachine(machine);
  }

  return {
    init,
    start,
    turn,
    toolOk,
    toolErr,
    succeed,
    fail,
    onTimer,
    boot,
    isSettled,
    currentStage,
    brainCall,
    subs,
    handlers,
    toMachine,
  };
}

// ===========================================================================
// The machine Msg union — the closed set of verb entry points `toMachine` wires.
// ===========================================================================

/**
 * The agent machine's Msg union — one variant per reducer entry point. A
 * consumer using `toMachine` dispatches `agent_start` to begin and `agent_tool_ok`
 * / `agent_tool_err` to route settled tools back; the brain-call settle Msgs
 * (`resilient_ok` / `resilient_err`) RE-ENTER from the FIXED `brainHandlers`
 * (the substrate enqueues an interpret handler's returned Msg as a follow-up),
 * driving `succeed` / `fail`. Time enters via `at` on every variant — the
 * reducer never reads the clock.
 *
 * `agent_turn` stays a variant for the consumer / boot path that folds a turn by
 * hand, but the wired loop folds it INSIDE `succeed` from the re-entered
 * `resilient_ok` — so a single settle Msg advances both the retry slice and the
 * conversation (the L3 fix).
 */
export type AgentMachineMsg<P extends string, O extends Record<P, unknown>, R> =
  | {
      readonly type: "agent_start";
      readonly runId: string;
      readonly at: number;
    }
  | {
      readonly type: "agent_turn";
      readonly turn: AgentTurn;
      readonly at: number;
    }
  | {
      readonly type: "agent_tool_ok";
      readonly callId: string;
      readonly result: R;
      readonly at: number;
    }
  | {
      readonly type: "agent_tool_err";
      readonly callId: string;
      readonly reason: string;
      readonly at: number;
    }
  // The brain-call settle Msgs RE-ENTER straight from `brainHandlers` (no
  // wrapping) — `resilient_ok` runs `succeed` (reset retry + fold the turn),
  // `resilient_err` runs `fail` (back off via retry). This is the inherited
  // llm-call settle shape, dispatched verbatim by the substrate's re-entry.
  | AgentLlmOkMsg<P, O>
  | AgentLlmErrMsg<P>
  // The timer Msg is `DeadlineExceeded` itself (not wrapped) so the
  // `subscribeDeadline` cell dispatches it straight into `update`, exactly as
  // the resilient-call / llm-call / monitored-run gold standards wire it.
  | AgentTimerMsg
  | { readonly type: "agent_boot"; readonly at: number };

/**
 * Join two `Interpret` dictionaries over DISJOINT Cmd subsets `A` and `B` (over
 * the same Msg union `M` and Ctx) into the full `Interpret<M, A | B, Ctx>`. The
 * agent uses it to merge the consumer's per-tool / snapshot interpret (`A`) with
 * the agent-owned brain-call handler (`B = AgentLlmRunCmd`) into the wired
 * machine's single interpret table.
 *
 * The runtime result is exactly the spread of the two key-disjoint records. The
 * single `as` is a SOUND mapped-type identity, not a laundering cast: `Interpret`
 * is a homomorphic mapped type keyed by `Cmd["type"]`, so
 * `Interpret<M, A, Ctx> & Interpret<M, B, Ctx>` IS `Interpret<M, A | B, Ctx>`
 * (`(A | B)["type"] = A["type"] | B["type"]`). TypeScript does not reduce that
 * intersection of two GENERIC mapped types on its own, so the equality is
 * asserted ONCE here — preserving `M` and `Ctx` exactly — rather than smuggled
 * through `as unknown as Interpret<...>` at every wiring site. Pure.
 */
export function mergeInterpret<
  M extends { type: string },
  A extends Cmd,
  B extends Cmd,
  Ctx,
>(
  a: Interpret<M, A, Ctx> | undefined,
  b: Interpret<M, B, Ctx>,
): Interpret<M, A | B, Ctx> {
  return { ...(a ?? {}), ...b } as Interpret<M, A | B, Ctx>;
}

/**
 * Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice
 * lives at `state.agent`. Convenience for a host that nests the agent slice
 * under a named field; the single-slice host uses the verbs' tuple directly.
 * PURE — a thin record rebuild, no clock / RNG.
 */
export function liftAgent<
  S extends { agent: AgentState<Stage, P, O, R> },
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
  C extends Cmd,
>(
  state: S,
  [slice, cmds]: readonly [AgentState<Stage, P, O, R>, readonly C[]],
): readonly [S, readonly C[]] {
  return [{ ...state, agent: slice }, cmds];
}

/**
 * Re-export the deadline Sub primitives so consumers (and tests) wire one
 * import: `subscribeDeadline` is the `subscribe` cell, `deadlineSub` builds the
 * Sub literal both composed bricks' `subs` emit.
 */
export { subscribeDeadline, deadlineSub };
export type {
  DeadlineSub,
  LlmCall,
  LlmErr,
  LlmOk,
  LlmRunCmd,
  LlmSucceedMsg,
  LlmFailMsg,
  Schema,
  ModelFactory,
  MessageLoader,
  // The monitored-run checkpoint Cmd is part of the public `AgentCmd` surface —
  // a consumer wiring `toMachine`'s `toolInterpret` for a snapshotting agent
  // needs it to type the `snapshot_write` cell.
  MonitoredRunCmd,
};
