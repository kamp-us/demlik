/**
 * @packageDocumentation
 * @demlik/tea/agent — THE headline Level-3 machine: a durable, crash-recoverable
 * AI agent that runs an ordered stage pipeline, and inside the agentic stage
 * drives the classic loop `llm → tools → fold → llm` until the model stops
 * asking for tools.
 *
 * This generalizes a production audit agent: the domain specifics are stripped,
 * and what remains — the loop, the durability, the boot-reconcile crash
 * recovery, the serial-vs-fanned tool dispatch — is yours. The consumer
 * supplies the only things that are genuinely domain: the tools, the prompts
 * (via the llm-call message loader), the schemas, and the model. `createAgent(config)` returns the uniform handle contract every
 * composition exposes (`init` / verbs returning `readonly [State, Cmd[]]` /
 * `subs`) AND a ready-to-`run` `defineMachine` (`toMachine`) — THE one wired
 * path. (`unsafeDetachedHandlers` is the hand-wiring escape hatch; its name
 * advertises that it does not drive the retry loop.)
 *
 * ## The composition (three siblings wired into ONE machine)
 *
 *   - `../monitored-run` — the OUTER pipeline + lifecycle + safety watchdog.
 *     The agent's stages (`plan → act → report`, say) are its stages; the
 *     position survives eviction, the no-progress deadline auto-fails a wedged
 *     run, and `boot` resumes mid-pipeline. The agent slice OWNS this slice and
 *     delegates `start` / `advance` / `progress` / `onDeadline` / `boot` to it.
 *   - `../llm-call` — every brain call. One
 *     `LlmCall` per turn, structured-output parsed, retry composed in. The agent
 *     delegates the resilient slice + verbs and reuses the detached handler.
 *   - `../fan-out` — the tool calls a turn produced. Tools dispatch SERIALLY by
 *     default (concurrency 1); fan-out generalizes that to bounded concurrency
 *     `config.toolConcurrency`. Each
 *     tool is an `of(call)` Cmd the consumer's own interpret performs; results
 *     route back through `toolOk` / `toolErr`. When the batch drains, the agent
 *     folds the gathered results back into the conversation and fires the next
 *     brain call (`fold → llm`).
 *
 * ## The flow loop, as TEA
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
 * ## Boot reconcile (crash recovery)
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
 *     // The brain: a plain `async (messages) => turn` (the common path), or the
 *     // `(id) => Llm` factory when the model binds the schema itself.
 *     model: async (messages) => client.chat(messages),
 *     schemas: { plan: planSchema, act: turnSchema, report: reportSchema },
 *     turnOf: (stage) => stageToPurpose[stage],   // which brain call a stage runs
 *     toolOf: (call): RunTool => ({ type: "run_tool", ...call }),
 *     toolConcurrency: 1,                          // serial (default)
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

import {
  type Cmd,
  defineMachine,
  type Interpret,
  type Machine,
  type Reducer,
} from "../index";
import { createFanOut, initFanOut } from "../internal/flow/fan-out";
import {
  createMonitoredRun,
  type DeadlineSub,
  type MonitoredRunCmd,
} from "../internal/flow/monitored-run";
import {
  createLlmCall,
  deadlineSub,
  type LlmCall,
  type LlmFailMsg,
  type LlmOk,
  type LlmRunCmd,
  type LlmSucceedMsg,
  type ResilientState,
  subscribeDeadline,
} from "../internal/llm-call";
import { createResilientCall } from "../internal/resilience/resilient-call";
import { MsgType } from "../protocol";
import {
  type AgentCompactErrMsg,
  type AgentCompactOkMsg,
  type AgentCompactRunCmd,
  COMPACTION_PURPOSE,
  type CompactInterpret,
  type CompactionOutputs,
  type CompactionPolicy,
  type CompactionPurpose,
} from "./compaction";
import {
  currentStage,
  dedupeByCallId,
  foldSummary,
  freshConversation,
  isSettled,
  requireAwaiting,
  toCompactRunCmd,
} from "./internal";
import {
  type AgentCmd,
  type AgentDetachedHandlers,
  type AgentKnob,
  type AgentLlmErrMsg,
  type AgentLlmOkMsg,
  type AgentLlmRunCmd,
  type AgentMachineMsg,
  type AgentPorts,
  type AgentTimerMsg,
  mergeInterpret,
  type SnapshotInterpret,
} from "./machine";
import type {
  AnyToolDef,
  ToolRouter,
  WiredToolCmd,
  WiredToolMsg,
} from "./tool";
import {
  createToolLadder,
  isToolTimerId,
  type ToolResilienceState,
} from "./tool-resilience";
import type {
  AgentConfig,
  AgentConfigCore,
  AgentFailure,
  AgentState,
  AgentTurn,
  Conversation,
  ToolCall,
  ToolFailure,
  ToolOutcome,
} from "./types";

// Re-export the concern modules so the public `@demlik/tea/agent` barrel is
// unchanged after the split into `./types` (domain + conversation + config +
// state/status), `./compaction` (the #85 seam), and `./machine` (the Cmd/Msg
// vocabulary + wiring helpers). The reducer core — `createAgent` — stays here.
export * from "./compaction";
export * from "./define-agent";
export * from "./machine";
export * from "./tool";
export * from "./types";

// ===========================================================================
// The knob factory.
// ===========================================================================

/**
 * Assemble an agent from `config` — the model, the stages it walks, and how a
 * tool call is turned into a command — and get back its `init`, verbs and `subs`
 * plus a `toMachine()` that wires all of it into one machine you hand to `run`,
 * which is the layer to reach for only once `defineAgent` cannot express the run
 * you want — a newcomer starts there, not here.
 *
 * Pass `snapshotEvery` to have the run persist itself every N steps, and
 * `compaction` to have long conversations summarized as they grow; each one you
 * pass obliges you to supply the matching handler at `toMachine`, and each one
 * you omit forbids it. `rng` is the determinism seam for the retry backoff —
 * pass a fixed `() => 0` to pin it in tests; omit for `Math.random`.
 * `unsafeDetachedHandlers` is the hand-wiring escape hatch.
 *
 * The four overloads exist because the two obligations are derived
 * from the `config` VALUE, never inferred. `{ snapshotEvery: number }` REQUIRES
 * the `snapshot_write` cell, `{ snapshotEvery?: never }` FORBIDS it; `{ compaction:
 * policy }` REQUIRES the `compact_run` cell, `{ compaction?: never }` FORBIDS it.
 * They enumerate the snapshot × compaction grid: overload resolution
 * reads the two fields off `config`, so the right `Snap`/`Compact` pair is fixed
 * even when the call site passes explicit type arguments (TS does not infer
 * trailing type params — a `Cfg`-inference scheme would silently fall back to OFF
 * at every explicit-type-arg call site). The overloads fix both concretely.
 */
export function createAgent<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd = Cmd,
  Msg = unknown,
>(
  config: AgentConfigCore<Stage, P, O, R, TC, Msg> & {
    readonly snapshotEvery: number;
    readonly compaction: CompactionPolicy<R, Msg>;
  },
): AgentKnob<Stage, P, O, R, TC, true, true>;
export function createAgent<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd = Cmd,
  Msg = unknown,
>(
  config: AgentConfigCore<Stage, P, O, R, TC, Msg> & {
    readonly snapshotEvery: number;
    readonly compaction?: never;
  },
): AgentKnob<Stage, P, O, R, TC, true, false>;
export function createAgent<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd = Cmd,
  Msg = unknown,
>(
  config: AgentConfigCore<Stage, P, O, R, TC, Msg> & {
    readonly snapshotEvery?: never;
    readonly compaction: CompactionPolicy<R, Msg>;
  },
): AgentKnob<Stage, P, O, R, TC, false, true>;
export function createAgent<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd = Cmd,
  Msg = unknown,
>(
  config: AgentConfigCore<Stage, P, O, R, TC, Msg> & {
    readonly snapshotEvery?: never;
    readonly compaction?: never;
  },
): AgentKnob<Stage, P, O, R, TC, false, false>;
export function createAgent<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd = Cmd,
  Msg = unknown,
>(
  config: AgentConfig<Stage, P, O, R, TC, Msg>,
): AgentKnob<Stage, P, O, R, TC, boolean, boolean> {
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

  // The DEDICATED compaction round-trip's resilient slice (#85, design B1) — a
  // SECOND resilient-call slice keyed on the reserved `$compact` purpose, so the
  // summarize call inherits the SAME retry/backoff machinery as the brain call
  // WITHOUT sharing its slice (a compaction retry never touches the brain breaker
  // / retry counter). The agent owns the retry ORCHESTRATION (trigger → settle →
  // backoff → re-issue); the consumer's `compact_run` interpret cell owns the
  // summarize I/O (the model round-trip + parse), exactly as the consumer owns
  // tool I/O via `toolOf`. The slice's `input` is the plain `LlmCall<$compact>`
  // request, its `result` the parsed `LlmOk` the consumer's cell returns. Always
  // built; never driven when no policy is configured (the trigger never fires).
  const compactRc = createResilientCall<
    LlmCall<CompactionPurpose>,
    LlmOk<CompactionPurpose, CompactionOutputs>
  >({ ...(config.retry !== undefined ? { retry: config.retry } : {}) }, rng);

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

  // The PER-TOOL timeout / retry ladders (#117) — one more `resilient-call`
  // composition, the third. `fan.of` still names the effect, but a tool that
  // declared a policy does not reach it directly: every launch the fan-out
  // authorizes is routed through `ladder.launch`, which arms the tool's timeout
  // and emits the run Cmd, and every settle is offered to the ladder first. A
  // tool that declared nothing is passed straight through, so the whole feature
  // is inert for an agent that uses none of it.
  const ladder = createToolLadder<TC>(
    config.toolResilienceOf ?? (() => null),
    config.toolOf,
    rng,
  );

  type State = AgentState<Stage, P, O, R>;

  /** The starting slice — every brick's `init`, no conversation yet. */
  function init(): State {
    return {
      run: run.init(),
      resilience: llm.init(),
      tools: initFanOut<ToolCall, ToolOutcome<R>>(),
      conversation: null,
      compaction: compactRc.init(),
      toolResilience: ladder.init(),
      refusedCalls: [],
      failure: null,
      output: null,
      instructions: config.instructions ?? null,
    };
  }

  /** Build the brain-call request for the current stage + conversation. PURE. */
  function brainCall(s: State): LlmCall<P> {
    const stage = currentStage(s);
    const conversation = s.conversation ?? freshConversation<R>();
    // `?? null`: a Model persisted before the slot existed rehydrates without it.
    const instructions = s.instructions ?? null;
    return {
      purpose: config.turnOf(stage),
      model: config.modelId ?? null,
      payload: config.payloadOf
        ? config.payloadOf(stage, conversation, instructions)
        : null,
    };
  }

  /**
   * Fire the current stage's brain call: build the request ({@link brainCall}),
   * thread it through the resilient retry layer, and return the resilience-updated
   * state + the llm run Cmds. THE shared epilogue of every verb that (re-)enters
   * the brain path — `start`, `advanceStage`, `settleTool`'s drain, `compactOk`,
   * `compactErr`, `boot` — each concats its OWN leading Cmds onto the returned llm
   * Cmds. PURE — `at` is the only clock.
   */
  function fireBrainCall(
    s: State,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    const call = brainCall(s);
    const [resilience, cmds] = llm.attempt(s.resilience, call, at);
    return [{ ...s, resilience }, cmds];
  }

  /**
   * Build the compaction summarize request for a conversation + fold count — the
   * `$compact` sibling of {@link brainCall}, so the summarize-request shape lives
   * in ONE spot and both the trigger (`maybeCompact`) and the boot re-fire emit a
   * byte-identical `LlmCall<$compact>`. PURE.
   */
  function compactionCall(
    conv: Conversation<R>,
    folding: number,
  ): LlmCall<CompactionPurpose> {
    const payloadOf = config.compaction?.payloadOf;
    return {
      purpose: COMPACTION_PURPOSE,
      model: config.modelId ?? null,
      payload: payloadOf ? payloadOf(conv, folding) : null,
    };
  }

  /** The dedicated compaction round-trip's resilient slice type (#85, design B1). */
  type CompactionSlice = ResilientState<
    LlmCall<CompactionPurpose>,
    LlmOk<CompactionPurpose, CompactionOutputs>
  >;

  /**
   * Re-key a compaction verb's `[slice, resilient_run Cmds]` result so the emitted
   * Cmds carry the dedicated `compact_run` discriminant. The one place the
   * `with-resilience` boundary re-key ({@link toCompactRunCmd}) lives.
   */
  function reKeyCompactCmds(
    result: readonly [CompactionSlice, readonly LlmRunCmd<CompactionPurpose>[]],
  ): readonly [CompactionSlice, readonly AgentCompactRunCmd[]] {
    const [slice, cmds] = result;
    return [slice, cmds.map(toCompactRunCmd)];
  }

  /**
   * The compaction slice's four cmd-emitting verbs, wrapped so each returns its
   * `resilient_run` Cmds ALREADY re-keyed to the dedicated `compact_run`
   * discriminant. The re-key is an INVARIANT of talking to `compactRc` — its Cmds
   * must route to the compaction interpret cell, never the brain `resilient_run`
   * one — so it lives here ONCE instead of at every call boundary, where a single
   * forgotten `.map` would misroute a compaction run Cmd to the brain cell. PURE —
   * pure delegation + re-key. (`init` / `subs` emit no run Cmds → used on
   * `compactRc` directly.)
   */
  const compact = {
    attempt: (
      slice: CompactionSlice,
      key: CompactionPurpose,
      input: LlmCall<CompactionPurpose>,
      at: number,
    ): readonly [CompactionSlice, readonly AgentCompactRunCmd[]] =>
      reKeyCompactCmds(compactRc.attempt(slice, key, input, at)),
    succeed: (
      slice: CompactionSlice,
      key: string,
      msg: Parameters<typeof compactRc.succeed>[2],
    ): readonly [CompactionSlice, readonly AgentCompactRunCmd[]] =>
      reKeyCompactCmds(compactRc.succeed(slice, key, msg)),
    fail: (
      slice: CompactionSlice,
      key: string,
      msg: Parameters<typeof compactRc.fail>[2],
    ): readonly [CompactionSlice, readonly AgentCompactRunCmd[]] =>
      reKeyCompactCmds(compactRc.fail(slice, key, msg)),
    onTimer: (
      slice: CompactionSlice,
      msg: Parameters<typeof compactRc.onTimer>[1],
    ): readonly [CompactionSlice, readonly AgentCompactRunCmd[]] =>
      reKeyCompactCmds(compactRc.onTimer(slice, msg)),
  };

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
    const conversation = freshConversation<R>();
    const withRun: State = {
      ...s,
      run: runSlice,
      conversation,
      failure: null,
      // A restart clears the prior run's terminal output — `result()` reads
      // `undefined` again until THIS run finishes (#46).
      output: null,
      tools: initFanOut<ToolCall, ToolOutcome<R>>(),
      // A restart also clears any prior compaction slice — a fresh run never
      // inherits the previous run's summarize retry bookkeeping (#85).
      compaction: compactRc.init(),
      // …and the prior run's refusals: those `callId`s belong to a batch this
      // run will never settle, so carrying them would only grow the Model (#145).
      refusedCalls: [],
    };
    return fireBrainCall(withRun, at);
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
    const conv = requireAwaiting(s, "llm");
    if (conv === null) return [s, []];

    const withTurn: Conversation<R> = {
      ...conv,
      turns: [...conv.turns, result],
    };

    // ── No tool calls → the stage's loop is done → advance the pipeline. ──
    // `result` is the terminating turn — threaded into `advanceStage` so it can
    // be stamped as the run's `output` when this retire finishes the pipeline.
    if (result.toolCalls.length === 0) {
      return advanceStage({ ...s, conversation: withTurn }, result, at);
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
    const [tools] = fan.scatter(initFanOut<ToolCall, ToolOutcome<R>>(), batch);
    const nextConv: Conversation<R> = {
      ...withTurn,
      awaiting: { kind: "tools", batchTurn: withTurn.turnCount },
    };
    // An advance of the loop is progress — bump the monitored-run watchdog.
    const [runSlice] = run.progress(s.run, undefined, at);
    const [toolResilience, launchCmds] = armLaunch(s, [], tools.running, at);
    return [
      { ...s, run: runSlice, tools, toolResilience, conversation: nextConv },
      launchCmds,
    ];
  }

  /**
   * Advance the outer pipeline on a finished stage loop. Retire the current
   * stage (monitored-run `advance`); if the pipeline finished → `done`, else
   * seed a fresh conversation for the next stage and fire its first brain call.
   * Shared by `turn` (empty tool calls) so the loop-end → next-stage move lives
   * in one place. PURE.
   *
   * `terminatingTurn` is the empty-tool model turn that ended the current
   * stage's loop. When THIS retire finishes the whole pipeline (`done`), it is
   * the run's terminal output — stamped on `state.output` so it survives the
   * conversation clear and `runtime.result()` can read it (#46).
   */
  function advanceStage(
    s: State,
    terminatingTurn: AgentTurn,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    const [runSlice, runCmds] = run.advance(
      s.run,
      undefined,
      { kind: "ok" },
      at,
    );
    // Pipeline finished (or single-shot done) → no further brain call. The
    // terminating turn is the run's output; record it before clearing the
    // conversation so the result survives the retire (the field the deleted
    // `captureLastTurn` host hook used to reconstruct off the stream).
    if (runSlice.phase === "done") {
      return [
        { ...s, run: runSlice, conversation: null, output: terminatingTurn },
        runCmds,
      ];
    }
    // Next stage → fresh conversation + its first brain call.
    const conversation = freshConversation<R>();
    const moved: State = {
      ...s,
      run: runSlice,
      conversation,
      tools: initFanOut<ToolCall, ToolOutcome<R>>(),
    };
    const [fired, llmCmds] = fireBrainCall(moved, at);
    return [fired, [...runCmds, ...llmCmds]];
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
    const call = inFlight(s, callId);
    // A success ends the ladder for this call: `ladder.ok` drops its entry, and
    // dropping it is what disarms the timeout Sub — so the value settles and no
    // timer survives to fire against a call that is already folded.
    const laddered =
      call === null
        ? s
        : { ...s, toolResilience: ladder.ok(toolSlice(s), call, at) };
    return settleTool(laddered, callId, { kind: "ok", result }, at);
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
    reported: string | ToolFailure,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    // A bare string is the hand-wired caller's shape and carries no tag — the
    // one untagged arm `ToolFailure`'s optional `_tag` exists for, beside a
    // record a pre-0.13 `Store` hands back.
    const failure: ToolFailure =
      typeof reported === "string"
        ? { kind: "error", reason: reported }
        : reported;
    const call = inFlight(s, callId);
    if (call === null) return settleTool(s, callId, failure, at);
    // Offer the failure to the ladder FIRST. A `null` verdict means it armed
    // another attempt: the fan-out entry stays `running`, nothing is folded, and
    // the wait is a timer Sub on the Model rather than an `await` inside a
    // handler — which is what makes the ladder survive a process kill. Anything
    // else is the failure the call ends on, ladder-authored or the tool's own —
    // and either way it is the STRUCTURED failure, so the `_tag` #115 keeps
    // survives the ladder instead of being flattened by passing through it.
    const [toolResilience, settled] = ladder.err(
      toolSlice(s),
      call,
      failure,
      at,
    );
    const next: State = { ...s, toolResilience };
    if (settled === null) return [next, []];
    return settleTool(next, callId, settled, at);
  }

  /** The in-flight `ToolCall` for `callId`, or `null` if none is running. PURE. */
  function inFlight(s: State, callId: string): ToolCall | null {
    return s.tools.running.find((c) => c.callId === callId) ?? null;
  }

  /**
   * The tool-ladder slice, defaulting to empty. The default is the rehydration
   * guard: a Model persisted before this slice existed comes back without the
   * field, and it must read as "no tool has laddered" rather than crash. PURE.
   */
  function toolSlice(s: State): ToolResilienceState {
    return s.toolResilience ?? {};
  }

  /**
   * The refused-`callId` list, defaulting to empty — the same rehydration guard
   * `toolSlice` carries, for the same reason: a Model persisted before the
   * field existed comes back without it, and it must read as "nothing refused
   * yet" rather than crash. PURE.
   */
  function refusedOf(s: State): readonly string[] {
    return s.refusedCalls ?? [];
  }

  /**
   * Arm every launch the fan-out just authorized. The fan-out's own launch Cmds
   * are DISCARDED in favour of these: a policied tool's effect must be emitted
   * by its resilient gate (which is what records the attempt and arms the
   * timeout), and a bare tool's is re-emitted here identically. The two lists
   * are the same calls either way — `after \ before` is exactly what the
   * fan-out moved into `running`. PURE.
   */
  function armLaunch(
    s: State,
    before: readonly ToolCall[],
    after: readonly ToolCall[],
    at: number,
  ): readonly [ToolResilienceState, readonly TC[]] {
    const known = new Set(before.map((c) => c.callId));
    return ladder.launch(
      toolSlice(s),
      after.filter((c) => !known.has(c.callId)),
      at,
    );
  }

  /**
   * Shared tool-settle body: route the outcome into fan-out, fold the matching
   * call+outcome onto the conversation, and — if the batch is now complete —
   * fold the turn and fire the next brain call. PURE.
   */
  function settleTool(
    prev: State,
    callId: string,
    outcome: ToolOutcome<R>,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    const conv = requireAwaiting(prev, "tools");
    if (conv === null) return [prev, []];

    // Find the original call (by id) so the folded record carries it. A settle
    // for an unknown / already-settled id is a no-op (fan-out also no-ops it).
    const call = prev.tools.running.find((c) => c.callId === callId);
    if (call === undefined) return [prev, []];

    const [tools] =
      outcome.kind === "ok"
        ? fan.itemOk(prev.tools, callId, outcome)
        : fan.itemErr(prev.tools, callId, outcome);
    // The freed slot backfills from the queue — those launches are armed exactly
    // like the batch's first ones, so a queued tool gets its timeout too.
    const [toolResilience, launchCmds] = armLaunch(
      prev,
      prev.tools.running,
      tools.running,
      at,
    );
    // A failure IS this call's public outcome: `onToolError` reports it now, so
    // any later success for the same `callId` is a late result of an abandoned
    // attempt and must be silent on every public channel (#145). Recorded here,
    // at the one settle body both the ladder's deadline arm and a tool's own
    // error pass through, so the projector needs no second rule per source.
    const refusedCalls =
      outcome.kind === "ok" ? refusedOf(prev) : [...refusedOf(prev), callId];
    const s: State = { ...prev, toolResilience, refusedCalls };

    const foldedConv: Conversation<R> = {
      ...conv,
      // Stamp the producing-turn index on the record (#85, A1). At settle time
      // `conv.turnCount` equals the index in `turns` of the turn that scattered
      // this batch (each prior drained batch bumped `turnCount` exactly once, and
      // each tool-bearing turn appended exactly one entry to `turns`), so a record
      // carrying `turn: conv.turnCount` is dropped iff its producing turn is folded
      // (`turn < N`) — the association the fold-back relies on.
      toolRecords: [
        ...conv.toolRecords,
        { call, outcome, turn: conv.turnCount },
      ],
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

    // The tool ledger resets for the next turn's batch regardless of which
    // effect (compaction or brain call) fires next.
    const drained: State = {
      ...s,
      tools: initFanOut<ToolCall, ToolOutcome<R>>(),
      conversation: turnedConv,
    };

    // ── Compaction trigger (#85, design B1). BEFORE the next brain call, ask
    // the PURE policy how many oldest turns to fold. N > 0 → fire the dedicated
    // compaction round-trip INSTEAD of the brain call and flip awaiting to
    // `compacting`; the fold-back (`compact_ok`) then fires the brain call. The
    // trigger bumps the watchdog (compaction IS liveness, decision C) but does
    // NOT bump `turnCount` — it already bumped once for this drained batch, and
    // compaction is not model reasoning progress, so it never trips `maxTurns`.
    const compacting = maybeCompact(drained, at);
    if (compacting !== null) return compacting;

    // ── No compaction → fire the next brain call. ──
    // An advance of the loop is progress — bump the watchdog, then fire.
    const [runSlice] = run.progress(drained.run, undefined, at);
    const [fired, llmCmds] = fireBrainCall({ ...drained, run: runSlice }, at);
    return [fired, [...launchCmds, ...llmCmds]];
  }

  /**
   * The compaction trigger (#85, design B1) — PURE. Given the drained-batch
   * state about to fire a brain call, consult `config.compaction.planCompaction`
   * (the consumer's PURE heuristic). Returns:
   *
   *   - `null` — no policy, or the policy returned `0`, or there is nothing to
   *     fold (`< 2` turns: folding 0 or 1 turns into a summary cannot shrink the
   *     transcript, so it is a no-op the trigger skips rather than spend a round
   *     trip). The caller fires the brain call as normal.
   *   - `[state, cmds]` — fire the dedicated compaction round-trip: flip
   *     `awaiting` to `compacting { folding: N }`, bump the watchdog (liveness,
   *     decision C — NOT `turnCount`, so `maxTurns` is untouched), and emit the
   *     re-keyed `compact_run` Cmd. `compact_ok` folds the summary back; the loop
   *     resumes with the next brain call there.
   *
   * `folding` is clamped to `turns.length` so a policy returning a count larger
   * than the transcript folds the WHOLE transcript into one summary (never more).
   * The launched `launchCmds` from the final tool settle are NOT this function's
   * concern — the caller composes them.
   */
  function maybeCompact(
    s: State,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] | null {
    const policy = config.compaction;
    const conv = s.conversation;
    if (policy === undefined || conv === null) return null;
    const requested = policy.planCompaction(conv);
    // Nothing to gain: a fold of 0 or 1 turns cannot shrink the transcript
    // (`turns[0..N]` → one summary turn only shrinks when N >= 2).
    const folding = Math.min(requested, conv.turns.length);
    if (folding < 2) return null;

    const compactConv: Conversation<R> = {
      ...conv,
      awaiting: { kind: "compacting", folding },
    };
    // Compaction is forward progress (liveness) — bump the watchdog, NOT the
    // turn count (decision C: it is not model reasoning, must not trip maxTurns).
    const [runSlice] = run.progress(s.run, undefined, at);
    const input = compactionCall(conv, folding);
    // The `compact` adapter re-keys the composed `resilient_run` Cmd(s) to the
    // dedicated `compact_run` discriminant so they route to the compaction
    // interpret cell, never the brain `resilient_run` one (the `with-resilience`
    // boundary-re-key pattern).
    const [compaction, cmds] = compact.attempt(
      s.compaction,
      COMPACTION_PURPOSE,
      input,
      at,
    );
    return [
      { ...s, run: runSlice, conversation: compactConv, compaction },
      cmds,
    ];
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

  // === Verb: compactOk / compactErr (compaction resilient settles) =========

  /**
   * Fold the compaction SUMMARY back (#85, design A1) — the entry the re-entered
   * `compact_ok` settle Msg drives. Two halves, in order:
   *
   *   1. The RETRY layer: `compactRc.succeed` closes the compaction breaker and
   *      DROPS the `$compact` retry counter (the same reset the brain `succeed`
   *      does, on the dedicated compaction slice).
   *   2. The FOLD-BACK: replace `turns[0..folding]` AND every `toolRecord` whose
   *      `turn < folding` with a SINGLE synthetic summary `AgentTurn` (no tool
   *      calls, carrying the summary text), then RE-INDEX the surviving records'
   *      `turn` so the new head (the summary) is index 0. `turnCount` is
   *      UNCHANGED (compaction is not a model round-trip — decision C), and
   *      `awaiting` flips back to `llm`. The next brain call fires on the shrunk
   *      transcript — the loop the trigger paused resumes here.
   *
   * A no-op if the run is settled or not awaiting compaction (a stale settle).
   * PURE — `at` is the only clock.
   */
  function compactOk(
    s: State,
    key: string,
    msg: AgentCompactOkMsg,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    // 1) Advance the compaction retry layer — resets retry[$compact], closes the
    //    compaction breaker. Reuses llm-call's `succeed` on the dedicated slice;
    //    the enriched `LlmSucceedMsg` is the `compact_ok` payload as-is.
    const [compaction, retryCmds] = compact.succeed(s.compaction, key, {
      type: MsgType.ResilientOk,
      key: msg.key,
      result: msg.result,
      at: msg.at,
    });
    const settledRetry: State = { ...s, compaction };

    // Stale settle (the run is settled, or advanced/rebooted past this
    // compaction). The retry slice still resets above; emit only its cmds
    // (`succeed` never emits a run Cmd, so `retryCmds` is empty here).
    const conv = requireAwaiting(settledRetry, "compacting");
    if (conv === null) return [settledRetry, retryCmds];

    // 2) Fold-back. `folding` is the count the trigger pinned on `awaiting`; the
    //    summary turn replaces those oldest turns + their records.
    const folding = conv.awaiting.folding;
    const summaryTurn: AgentTurn = {
      content: msg.result.output.summary,
      toolCalls: [],
    };
    const foldedConv = foldSummary(conv, folding, summaryTurn);
    // Resume the loop: fire the next brain call on the shrunk transcript.
    const [fired, llmCmds] = fireBrainCall(
      { ...settledRetry, conversation: foldedConv },
      at,
    );
    return [fired, [...retryCmds, ...llmCmds]];
  }

  /**
   * Record a compaction FAILURE (#85). Back off via the compaction slice's
   * inherited retry (re-arming the `$compact` retry timer), or — when retry is
   * exhausted / absent — PROCEED WITHOUT COMPACTING: flip `awaiting` back to
   * `llm` and fire the brain call on the (un-compacted) transcript. Compaction is
   * an OPTIMIZATION, not correctness: a failed summarize must not wedge or fail
   * the whole run (errors are data). This is the chosen option of design B1's
   * `compact_err` fork — it is strictly weaker than failing the run, and the
   * brain call's OWN resilient retry / the deadline watchdog still bound the
   * un-compacted continuation. A consumer that wants compaction failure to be
   * terminal can detect it on the `compaction` slice's `failed` phase. PURE.
   */
  function compactErr(
    s: State,
    key: string,
    msg: AgentCompactErrMsg,
    at: number,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    const [compaction, cmds] = compact.fail(s.compaction, key, {
      type: MsgType.ResilientErr,
      key: msg.key,
      error: msg.error,
      at: msg.at,
    });
    const settledRetry: State = { ...s, compaction };
    const call = compaction.calls[key];

    // A retry is armed (`waiting_retry`) → not terminal → keep awaiting the
    // re-issued compaction call (the re-keyed run Cmd, if any, rides here).
    if (call?.phase === "waiting_retry") {
      return [settledRetry, cmds];
    }

    // Stale settle (run settled, or advanced/rebooted past this compaction).
    // Past the `waiting_retry` guard `fail` emits no run Cmd, so `cmds` is empty.
    const conv = requireAwaiting(settledRetry, "compacting");
    if (conv === null) return [settledRetry, cmds];

    // Exhausted retry (or no retry) → proceed WITHOUT compacting: drop the
    // `compacting` state, fire the next brain call on the un-compacted transcript.
    const resumedConv: Conversation<R> = { ...conv, awaiting: { kind: "llm" } };
    const [fired, llmCmds] = fireBrainCall(
      { ...settledRetry, conversation: resumedConv },
      at,
    );
    return [fired, [...cmds, ...llmCmds]];
  }

  // === Verb: onTimer =======================================================

  /**
   * A timer fired — disambiguated by Sub id across the composed bricks:
   *
   *   - a `monitored:safety:*` id → the no-progress watchdog → fail the run via
   *     the inherited monitored-run `onDeadline`.
   *   - a `resilient:*:$compact` id → a COMPACTION retry/deadline timer →
   *     re-run the compaction call via the compaction slice's `onTimer`, re-keying
   *     its re-issued `resilient_run` to the dedicated `compact_run` (#85).
   *   - any other `resilient:*` id → a brain-call retry timer → re-run the brain
   *     call via the inherited llm-call `onTimer`.
   *
   * Each brick `onTimer` / `onDeadline` verb tolerates a stale fire for another's
   * id (it no-ops on a non-matching id), so the routing is by id prefix/suffix.
   * PURE.
   */
  function onTimer(
    s: State,
    msg: AgentTimerMsg,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    if (msg.id.startsWith("monitored:")) {
      const [runSlice] = run.onDeadline(s.run, msg);
      return [{ ...s, run: runSlice }, []];
    }
    // The compaction slice's timers are keyed on the reserved `$compact` purpose
    // (`resilient:retry:$compact` / `resilient:deadline:$compact`), distinct from
    // every brain purpose, so the suffix routes the fire to the right slice.
    if (msg.id.endsWith(`:${COMPACTION_PURPOSE}`)) {
      const [compaction, cmds] = compact.onTimer(s.compaction, msg);
      return [{ ...s, compaction }, cmds];
    }
    // A `$tool:`-keyed id is one of the per-tool ladders (#117): either a retry
    // timer, whose fire IS the next attempt, or a timeout, whose fire ends the
    // call. Both come back as data the reducer folds — the run cmds to re-issue
    // and, for a timeout, the settle order the fan-out then folds like any
    // other failure, so the model reads `timeout` as an ordinary tool error.
    if (isToolTimerId(msg.id)) return toolTimer(s, msg);
    const [resilience, cmds] = llm.onTimer(s.resilience, msg);
    return [{ ...s, resilience }, cmds];
  }

  /**
   * Fold one tool-ladder timer fire: apply it to the slice, emit whatever next
   * attempt it authorized, and settle every call it gave up on. A timeout's
   * settle runs through `settleTool`, so a timed-out call drains its batch and
   * fires the next brain call exactly as a handler-reported failure would —
   * there is no second completion path to keep in step. PURE.
   */
  function toolTimer(
    s: State,
    msg: AgentTimerMsg,
  ): readonly [State, readonly AgentCmd<P, TC>[]] {
    const [toolResilience, outcome] = ladder.onTimer(toolSlice(s), msg);
    let next: State = { ...s, toolResilience };
    const cmds: AgentCmd<P, TC>[] = [...outcome.cmds];
    for (const order of outcome.settle) {
      const [settled, more] = settleTool(
        next,
        order.callId,
        order.failure,
        msg.atMs,
      );
      next = settled;
      cmds.push(...more);
    }
    return [next, cmds];
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
   *   - awaiting `compacting` → re-fire the in-flight compaction call (#85),
   *     idempotent at the compaction slice's gate exactly like the brain call.
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
      return fireBrainCall(rebooted, at);
    }

    if (conv.awaiting.kind === "compacting") {
      // Re-fire the in-flight compaction round-trip (#85). The compaction slice
      // already tracks `$compact` running; re-issuing the same key is idempotent
      // at the gate, and the re-emitted `resilient_run` is re-keyed to `compact_run`.
      const input = compactionCall(conv, conv.awaiting.folding);
      const [compaction, cmds] = compact.attempt(
        rebooted.compaction,
        COMPACTION_PURPOSE,
        input,
        at,
      );
      return [{ ...rebooted, compaction }, cmds];
    }

    // awaiting tools → re-fire every running tool's effect Cmd, through the
    // ladder. It re-arms each policied call's timeout and — the point of the
    // whole exercise — SKIPS a call the kill caught between two attempts: that
    // one's next attempt is already owed to the retry timer `subs` re-arms off
    // the rehydrated slice, so re-firing here would buy an attempt the budget
    // never granted and reset the count that survived the kill.
    const [toolResilience, cmds] = ladder.boot(
      toolSlice(rebooted),
      rebooted.tools.running,
      at,
    );
    return [{ ...rebooted, toolResilience }, cmds];
  }

  // === Subs ================================================================

  /**
   * The merged subscription set — the brain-call retry timers (`../llm-call`),
   * the COMPACTION retry timers (the dedicated `$compact` slice, #85), the
   * PER-TOOL retry + timeout timers (the `$tool:`-keyed ladders, #117), and the
   * no-progress safety deadline (`../monitored-run`). All are `DeadlineSub`s
   * reconciled by id (the compaction timers are keyed `resilient:*:$compact`,
   * distinct from every brain timer), wired with one `subscribe: { deadline:
   * subscribeDeadline }` cell. PURE.
   */
  function subs(s: State): readonly DeadlineSub[] {
    return [
      ...llm.subs(s.resilience),
      ...compactRc.subs(s.compaction),
      ...ladder.subs(toolSlice(s)),
      ...run.subs(s.run),
    ];
  }

  // === Handlers ============================================================

  /**
   * The brain-call interpret handler — DETACHED, inherited from `../llm-call`.
   * It assembles messages, binds the purpose schema, invokes (retry composed),
   * parses, and dispatches the consumer's `onOk` / `onErr` Msg (carrying the
   * parsed `AgentTurn` for `onOk`).
   *
   * UNSAFE — kept ONLY as a deliberate escape hatch for the consumer that wires
   * the verbs by hand and wants the fire-and-forget dispatch shape. It does NOT
   * drive the inherited retry loop (it never re-enters the `resilient_ok` settle
   * Msg, so `succeed` / `fail` never run — the breaker never closes, the retry
   * counter never resets). The `unsafe` prefix is the warning the name carries:
   * `toMachine` is THE wired path (it uses the FIXED `brainHandlers` below, which
   * returns the settle Msg for re-entry and drives the loop correctly), and this
   * detached form is named `unsafeDetachedHandlers` so the broken-by-design
   * behaviour is visible at the call site, not buried in a doc-comment a consumer
   * meets only after autocomplete already offered it. A consumer reaches for it
   * only when it has accepted owning the retry wiring itself. See llm-call's
   * `handlers` doc (the same retry-loop gap).
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
  function unsafeDetachedHandlers<M>(
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
  function toMachine<Ctx = object, T extends AnyToolDef = never>(opts?: {
    /**
     * A `toolRouter` (#56). Its cells join the interpret table, its defs go on
     * `Machine.cmds` (so `run`'s edge parses each `_ok` and stamps `at`), and
     * one reducer cell per settled Msg folds the tool back through `toolOk` /
     * `toolErr` — the router's `toolOf` is the config's, so the consumer wires
     * nothing per tool.
     */
    readonly tools?: ToolRouter<T>;
    /**
     * The consumer's interpret for the non-brain Cmds — the per-tool effect
     * `TC`, plus (ONLY when checkpointing is configured) the monitored-run
     * `snapshot_write` checkpoint cell. The brain `resilient_run` cell the agent
     * owns is merged in below, so the consumer supplies only the rest of the
     * config-derived `AgentCmd<P, TC, Snap>` union.
     *
     * The snapshot obligation is CONFIG-DERIVED (#55): `SnapshotInterpret`
     * resolves to a REQUIRED `snapshot_write` cell when `config.snapshotEvery`
     * is set (a real checkpoint write MUST be wired — never a silent no-op), and
     * to `{ snapshot_write?: never }` (the cell is FORBIDDEN — it can never fire)
     * when checkpointing is off. There is no default no-op: a non-checkpointing
     * consumer cannot even mention `snapshot_write`, and a checkpointing one must.
     */
    readonly toolInterpret?: Interpret<
      AgentMachineMsg<P, O, R> | WiredToolMsg<T>,
      Exclude<TC, WiredToolCmd<T>>,
      Ctx
    > &
      SnapshotInterpret<
        AgentMachineMsg<P, O, R> | WiredToolMsg<T>,
        boolean,
        Ctx
      > &
      CompactInterpret<
        AgentMachineMsg<P, O, R> | WiredToolMsg<T>,
        boolean,
        Ctx
      >;
  }): Machine<
    State,
    AgentMachineMsg<P, O, R> | WiredToolMsg<T>,
    AgentCmd<P, TC, boolean, boolean>,
    DeadlineSub,
    Ctx
  > {
    type M = AgentMachineMsg<P, O, R> | WiredToolMsg<T>;
    const tools = opts?.tools;
    // The implementation is typed at `Snap = boolean` — the SUPERSET that
    // always includes the monitored-run checkpoint Cmd; the public OVERLOADS
    // narrow it to `true` / `false` and hand the consumer the precise obligation
    // (#55). `NonBrainCmd` is the consumer's per-tool `TC` plus that checkpoint
    // Cmd, and `ACmd` unions it with the brain Cmd — fully concrete (no pending
    // conditional), union-equal to `AgentCmd<P, TC, boolean>`, and built from the
    // SAME pieces `mergeInterpret` joins so the merge result is syntactically
    // `Interpret<M, ACmd, Ctx>` with no `Exclude`/conditional TS refuses to reduce.
    // `NonBrainCmd` is the consumer's half of the merged interpret — the per-tool
    // `TC`, the monitored-run checkpoint Cmd, AND the compaction `compact_run`
    // Cmd (#85). The consumer owns the `compact_run` cell (the summarize I/O,
    // returning `compact_ok` / `compact_err` for re-entry), exactly as it owns the
    // tool cells; the agent owns only the retry ORCHESTRATION (the slice verbs).
    // At `boolean` this is the SUPERSET; the overloads config-derive `compact_run`
    // IN (policy) or OUT (`{ compact_run?: never }`) of the obligation (#55 reuse).
    type NonBrainCmd = TC | MonitoredRunCmd<unknown> | AgentCompactRunCmd;
    type ACmd = AgentLlmRunCmd<P> | NonBrainCmd;
    // The FIXED brain handler returns the settle Msg for re-entry; the substrate
    // enqueues it as a follow-up dispatched back into `update` (the `resilient_*`
    // arms below). It is PRECISELY an `Interpret` over the brain Cmd
    // (`AgentLlmRunCmd<P>`); the consumer's `toolInterpret` is PRECISELY an
    // `Interpret` over the rest of the config-derived union (`TC`, and
    // `snapshot_write` only when snapshotting). `mergeInterpret` joins the two
    // disjoint halves into the full `Interpret<M, ACmd, Ctx>` — each key maps
    // precisely (`resilient_run` → the brain cell, `TC["type"]` / `snapshot_write`
    // → the consumer's cells), with the one sound mapped-type identity isolated in
    // the helper rather than laundered through `as unknown as` here.
    //
    // No no-op `snapshot_write` default: with checkpointing off `SnapCmd` is
    // `never`, so the Cmd is config-derived OUT of `ACmd`, the consumer never
    // wires it, and the monitored-run slice never emits it — the
    // `snapshot_write: async () => undefined` ceremony (and the type lie it
    // masked) is gone (#55).
    //
    // The router's cells (#56) sit under the consumer's: the router owns the
    // tool Cmds' keys (`Exclude<TC, WiredToolCmd<T>>` took them off the consumer's
    // obligation), the consumer owns the rest, so the two never share a key.
    const consumerInterpret = {
      ...tools?.interpret,
      ...opts?.toolInterpret,
    } as Interpret<M, NonBrainCmd, Ctx>;
    const interpret: Interpret<M, ACmd, Ctx> = mergeInterpret<
      M,
      NonBrainCmd,
      AgentLlmRunCmd<P>,
      Ctx
    >(consumerInterpret, brainHandlers<Ctx>());

    // Type the dispatch table explicitly so each cell gets its narrowed Msg
    // and the Reducer-form overload of `defineMachine` matches cleanly (the
    // agent State is not a discriminated union, so the Transitions overload's
    // `update` field collapses to `never` and would otherwise mask inference).
    // The verbs return `AgentCmd<P, TC>` — the `Snap = true` superset, because
    // they FORWARD whatever monitored-run emits and the verbs are not themselves
    // config-typed. The machine declares the config-derived `ACmd`; the one
    // narrowing (`update` below) is SOUND because a non-snapshotting run's
    // monitored-run slice provably never emits a `snapshot_write` Cmd, so the
    // forwarded array never carries the variant `ACmd` excludes.
    //
    // The router's settled Msgs (#56) fold exactly as `agent_tool_ok` /
    // `agent_tool_err` do — one cell per `<name>_ok` / `<name>_err`, read off
    // the router's defs, each routed through `outcomeOf` so the `_ok` value and
    // the `{ _tag }` failure's `reason` are rendered in ONE place. The record is
    // built per def at runtime, which is why the reducer is assembled as a
    // record and typed at the `M` union below.
    type ToolCell = (
      s: State,
      m: WiredToolMsg<T>,
    ) => readonly [State, readonly AgentCmd<P, TC>[]];
    const foldTool: ToolCell = (s, m) => {
      const settled = tools?.outcomeOf(m);
      if (settled === undefined || settled === null) return [s, []];
      // Through `toolOk` / `toolErr` rather than straight to `settleTool`: those
      // two are where the per-tool timeout / retry ladder (#117) sees the
      // settle, and a router tool declaring `retry` must climb it exactly as a
      // bare one does. `toolErr` takes the WHOLE failure the router built, so
      // the `{ _tag, …payload }` beside the reason (#115) rides through the
      // ladder intact — re-deriving it from a string here is exactly the loss.
      return settled.outcome.kind === "ok"
        ? toolOk(s, settled.callId, settled.outcome.result as R, m.at)
        : toolErr(s, settled.callId, settled.outcome, m.at);
    };
    const toolCells: Record<string, ToolCell> = {};
    for (const def of tools?.defs ?? []) {
      toolCells[def.okType] = foldTool;
      toolCells[def.errType] = foldTool;
    }
    const ownUpdate: Reducer<
      State,
      AgentMachineMsg<P, O, R>,
      AgentCmd<P, TC>
    > = {
      [MsgType.AgentStart]: (s, m) => start(s, m.runId, m.at),
      [MsgType.AgentToolOk]: (s, m) => toolOk(s, m.callId, m.result, m.at),
      // `agent_tool_err` is `createAgent`'s own raw settle Msg and its wire
      // shape is a bare `reason` string — a consumer routing their own interpret
      // through it never declared a tag, so the failure it mints carries none.
      [MsgType.AgentToolErr]: (s, m) => toolErr(s, m.callId, m.reason, m.at),
      // The re-entered brain-call settle Msgs (from `brainHandlers`): success
      // runs `succeed` (reset retry + fold the turn), failure runs `fail`.
      [MsgType.ResilientOk]: (s, m) => succeed(s, m.key, m, m.at),
      [MsgType.ResilientErr]: (s, m) => fail(s, m.key, m, m.at),
      // The re-entered compaction settle Msgs (from the consumer's `compact_run`
      // cell, #85): `compact_ok` folds the summary back (drop oldest turns +
      // their records, fire the next brain call), `compact_err` backs off via the
      // compaction retry or proceeds without compacting.
      [MsgType.CompactOk]: (s, m) => compactOk(s, m.key, m, m.at),
      [MsgType.CompactErr]: (s, m) => compactErr(s, m.key, m, m.at),
      deadline_exceeded: (s, m) => onTimer(s, m),
      [MsgType.AgentBoot]: (s, m) => boot(s, m.at),
    };
    // `ownUpdate` carries every `AgentMachineMsg` cell (checked above);
    // `toolCells` carries one per router def. The join is `Reducer` over the
    // union `M` — a mapped type over a generic `T` that TS cannot enumerate,
    // so the identity is asserted once here.
    const update = { ...ownUpdate, ...toolCells } as Reducer<
      State,
      M,
      AgentCmd<P, TC>
    >;

    // Build the machine as a fully-typed `Machine<...>` const, then pass it
    // through `defineMachine`'s identity. Annotating the const resolves the
    // `Machine` type's conditional `interpret` requirement against the concrete
    // type params here; calling `defineMachine` with explicit type args instead
    // would defer that conditional over the generic `TC` and fail the overload.
    //
    // The machine's Cmd type is the config-derived `ACmd`. `update` is the
    // `AgentCmd<P, TC>` superset reducer; narrowing it to `Reducer<State, M,
    // ACmd>` is the SINGLE sound assertion of the snapshot derivation — a
    // non-snapshotting run never emits the `MonitoredRunCmd` variant `ACmd`
    // drops, so the reducer's emitted arrays provably stay within `ACmd[]`. This
    // is the same shape as `mergeInterpret`'s one sound mapped-type identity: the
    // soundness lives in a documented seam, not smuggled at every verb.
    const machine: Machine<State, M, ACmd, DeadlineSub, Ctx> = {
      init: (loaded) => (loaded !== null ? [loaded, []] : [init(), []]),
      update: update as Reducer<State, M, ACmd>,
      subscriptions: (s) => subs(s),
      subscribe: { deadline: subscribeDeadline },
      interpret,
      ...(tools !== undefined ? { cmds: tools.defs } : {}),
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
    compactOk,
    compactErr,
    onTimer,
    boot,
    isSettled,
    currentStage,
    brainCall,
    subs,
    // `toMachine` is THE wired path. `unsafeDetachedHandlers` is the
    // hand-wiring escape hatch — named to advertise the retry-loop gap so it is
    // never mistaken for the loop driver (#54).
    toMachine,
    unsafeDetachedHandlers,
  };
}

/**
 * Re-export the deadline Sub primitives so consumers (and tests) wire one
 * import: `subscribeDeadline` is the `subscribe` handler, `deadlineSub` builds
 * the Sub literal both composed wrappers' `subs` emit.
 */
export { subscribeDeadline, deadlineSub };
export type {
  DeadlineSub,
  MonitoredRunCmd,
  RunFailure,
} from "../internal/flow/monitored-run";
export type {
  LlmCall,
  LlmErr,
  LlmFailMsg,
  LlmOk,
  LlmRunCmd,
  LlmSucceedMsg,
  MessageLoader,
  ModelFactory,
  ModelPort,
  PlainModel,
  Schema,
} from "../internal/llm-call";
export { PLAIN_MODEL_MISROUTE_REASON, plainModel } from "../internal/llm-call";
