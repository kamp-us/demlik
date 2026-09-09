/**
 * @demlik/tea/agent — `defineAgent`, the convenience layer over `createAgent`.
 *
 * `defineAgent({ model, tools, instructions })` is the three-line door: it
 * defaults the single-stage wiring (`stages`, `turnOf`, `schemas`), derives the
 * tool handlers from `toolRouter`, renders the prompt off the Model, and absorbs
 * the drive loop through `driveToDone`. It hides wiring, never state (ADR
 * 0015): the Model it runs is the same `AgentState` a hand-wired `createAgent`
 * produces, under the same keys, and `machine(input)` is the door down to the
 * raw kernel `run`. Each hidden thing is a named helper below.
 */

import { defineMachine, driveToDone, type Machine, run } from "../index";
import type { DeadlineSub, EndedRun } from "../internal/flow/monitored-run";
import type { LlmCall, MessageLoader, PlainModel } from "../internal/llm-call";
import { MsgType } from "../protocol";
import type { Interpret, RequiredCtx } from "../pure/core";
import type { RetryPolicy } from "../retry-backoff";
import type { BootingRuntime, CtxArg, Store } from "../runtime-types";
import {
  type AgentCompactOkMsg,
  type AgentCompactRunCmd,
  COMPACTION_PURPOSE,
  type CompactionPolicy,
} from "./compaction";
import { createAgent } from "./index";
import {
  type AgentCmd,
  type AgentEvent,
  type AgentMachineMsg,
  agentBootMsg,
  agentCancelMsg,
  agentEvents,
} from "./machine";
import {
  type AnyToolDef,
  type ToolCmd,
  type ToolFailureOf,
  type ToolResult,
  type ToolRouter,
  toolRouter,
  type WiredToolMsg,
} from "./tool";
import {
  type AgentConfigCore,
  type AgentState,
  type AgentTurn,
  agentTurnSchema,
  type Conversation,
  isStreamingModel,
  type ModelStream,
  type StreamingModel,
  status,
  type ToolCall,
  type ToolOutcome,
  type TurnChunk,
} from "./types";

// ===========================================================================
// The convenience layer's vocabulary: the messages a plain model reads, the
// prompt they are rendered from, and the one-purpose agent it fixes.
// ===========================================================================

/**
 * One message a `defineAgent` `model` receives. Plain data the adapter renders into
 * its provider's shape: the head is the `instructions` (when set) and the
 * run's `input`; then, per model turn, the `assistant` turn followed by the
 * `tool` outcomes that turn asked for. A tool outcome rides as data — the
 * adapter decides how a failure reads to its model. An `assistant` message
 * carries the turn's opaque `provider` slot exactly as the adapter returned it
 * (see `AgentTurn`), present only when the stored turn has one.
 */
export type AgentMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls: readonly ToolCall[];
      readonly provider?: unknown;
    }
  | {
      readonly role: "tool";
      readonly callId: string;
      readonly name: string;
      readonly outcome: ToolOutcome<unknown>;
    };

/**
 * The brain-call payload `defineAgent` builds from the durable state — everything
 * `messagesOf` renders, so the prompt is a pure function of the Model and the
 * resilient slice carries exactly what was sent.
 */
export interface AgentPrompt<R> {
  readonly instructions: string | null;
  readonly input: string | null;
  readonly conversation: Conversation<R>;
}

/** The one purpose a `defineAgent` agent runs. */
export type LidPurpose = "act";
type LidOutputs = { readonly [K in LidPurpose]: AgentTurn };

/** The Model a defined agent runs — a hand-wired `createAgent`'s, key for key. */
export type DefinedAgentState<T extends AnyToolDef> = AgentState<
  string,
  LidPurpose,
  LidOutputs,
  ToolResult<T>
>;

/**
 * The Model `run` RESOLVES with — {@link DefinedAgentState} whose `run` slice is
 * narrowed to the ended phases ({@link EndedRun}).
 *
 * `run`'s terminal predicate is `done || cancelled` and its `failed` one rejects,
 * so the never-started `idle` arm is unreachable on the resolved value. Typing
 * the promise as the whole Model published that unreachable arm anyway, and
 * `idle` carries no `runId` — so `(await agent.run(input)).run.runId`, a field
 * every resolved run has, did not typecheck (#155). The narrow is on what `run`
 * can RESOLVE; the `idle` arm is untouched and still carries no `runId`.
 *
 * `DefinedAgentState` itself stays wide, because it is the DURABLE Model: an
 * `init` slice is `idle`, and a `Store<DefinedAgentState<T>>` has to hold one.
 */
export type DefinedAgentResolvedState<T extends AnyToolDef> = Omit<
  DefinedAgentState<T>,
  "run"
> & { readonly run: EndedRun<string> };

/** The ctx the tools' `needs` demand, intersected — what `run` asks for. */
export type DefinedAgentCtx<T extends AnyToolDef> = RequiredCtx<ToolCmd<T>>;

/** The Msg union a defined agent's machine folds. */
export type DefinedAgentMsg<T extends AnyToolDef> =
  | AgentMachineMsg<LidPurpose, LidOutputs, ToolResult<T>>
  | WiredToolMsg<T>;

/**
 * The Cmd union a defined agent's machine emits — one interpret cell per member.
 *
 * Snapshotting is fixed OFF (the lid checkpoints through the run's `store`, not
 * the monitored-run cadence), so `snapshot_write` is out of the union.
 * Compaction is fixed ON, which is the SUPERSET of the two machines
 * `defineAgent` builds: with the knob set the `compact_run` cell is the one the
 * lid wires, and without it the reducer provably emits no such Cmd, so the
 * machine carries no cell for it and the union simply has a member nothing
 * reaches. Naming the superset is what lets one type describe both arms — and
 * it is why `with` may wrap `compact_run` on a compacting agent and gets
 * `overlaid`'s "this machine has none of that cell" throw on one without.
 */
export type DefinedAgentCmd<T extends AnyToolDef> = AgentCmd<
  LidPurpose,
  ToolCmd<T>,
  false,
  true
>;

/**
 * The interpret table of the machine `defineAgent` wired: one cell per
 * {@link DefinedAgentCmd}, keyed by its `type` — a tool's own Cmd type, the
 * router's `tool_rejected`, and the agent-owned brain call.
 */
export type DefinedAgentInterpret<T extends AnyToolDef> = Interpret<
  DefinedAgentMsg<T>,
  DefinedAgentCmd<T>,
  DefinedAgentCtx<T>
>;

/** The wired machine `defineAgent` builds per `input` — feed it to the raw `run`. */
export type DefinedAgentMachine<T extends AnyToolDef> = Machine<
  DefinedAgentState<T>,
  DefinedAgentMsg<T>,
  DefinedAgentCmd<T>,
  DeadlineSub,
  DefinedAgentCtx<T>
>;

/**
 * The brain a defined agent runs, in either of its two shapes:
 *
 *   - `async (messages) => turn` — the plain port, and the common path.
 *   - `async (messages, { onChunk }) => turn` — the same call, plus a side
 *     channel it may write token deltas to while the turn is in flight.
 *
 * `defineAgent` takes one field for both and tells them apart by arity
 * (`isStreamingModel`), so there is no config flag saying which you passed and
 * no way for that flag to disagree with the function. Whichever shape you
 * write, the run's Model is the same: the turn it RESOLVES is what the reducer
 * folds, and the deltas end at the `onChunk` run option (see
 * {@link DefinedAgentRunOptions}).
 *
 * Both members are unions of one signature so a model written inline still gets
 * its `messages` parameter typed from the config field.
 */
export type DefinedAgentModel =
  | PlainModel<AgentMessage, AgentTurn>
  | StreamingModel<AgentMessage, AgentTurn>;

/**
 * What `defineAgent` takes: the model, the tools and the instructions, plus the
 * four optional guards that stop a run — `maxTurns`, `deadlineMs`,
 * `maxElapsedMs` and `stopWhen` — and the one that keeps a run going, `retry`,
 * the brain call's backoff ladder. Omit every guard and the run is unbounded:
 * it ends only when the model stops asking for tools.
 *
 * Two more knobs bound what a run COSTS rather than whether it ends:
 * `compaction`, which stops the transcript growing, and `toolConcurrency`,
 * which says how many of a turn's tool calls go out at once.
 */
export interface DefineAgentConfig<T extends AnyToolDef> {
  /** The brain — either {@link DefinedAgentModel} shape. */
  readonly model: DefinedAgentModel;
  /** The `tool()`s the model may call. */
  readonly tools: readonly T[];
  /**
   * The system prompt — stored on the Model at `init` (ADR 0004) and never
   * re-read, so a resumed run keeps the prompt it started with even across a
   * redeploy that changed this string; to replace a bad prompt already in
   * flight, end that run and start a new one rather than resuming it.
   */
  readonly instructions: string;
  /**
   * Stops a run that keeps going: the maximum number of model round-trips it
   * may take. Once the completed-turn count reaches it the run fails rather
   * than calling the model again. Omit → no limit on turns.
   */
  readonly maxTurns?: number;
  /**
   * Stops a run that stops progressing: milliseconds the run may sit without
   * advancing before it fails. The budget is a no-progress watchdog, not a
   * total wall-clock cap — it restarts each time the run moves. Omit → no
   * watchdog.
   */
  readonly deadlineMs?: number;
  /**
   * Stops a run that keeps going, by the clock: total milliseconds from the
   * run's start it may take before it fails. This is the total wall-clock cap
   * `deadlineMs` is not — the budget never restarts, so a run that keeps
   * progressing is bounded by it where `deadlineMs` would let it run forever,
   * and it counts elapsed time where `maxTurns` counts round-trips. It is read
   * at the turn boundary, so like both of those it stops the run rather than
   * cancelling the work already in flight. Omit → no wall-clock cap.
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
   * Stops a run on a condition only you can see: a predicate consulted at the
   * turn boundary, after the other three guards have passed, over the run's
   * durable Model. Answer `true` and the run ends there — settled `cancelled`,
   * the same terminal an aborted `signal` reaches, with the transcript intact
   * and no further model call made. Where `maxTurns` and `maxElapsedMs` bound
   * a quantity the agent counts for you and `deadlineMs` watches for a stall,
   * this bounds whatever you name — a token ledger you keep, an external flag,
   * a condition on the turns so far. Omit → no predicate.
   *
   * It must be PURE: the reducer calls it, so a replay hands it the same state
   * and must get the same answer. And it is config rather than Model — a
   * resumed run consults the predicate the config passed to THIS boot, exactly
   * as it uses the `maxTurns` passed to this boot.
   */
  readonly stopWhen?: (state: DefinedAgentState<T>) => boolean;
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
  readonly onToolError?: (
    outcome: ToolFailureOf<T>,
    ctx: ToolErrorContext,
  ) => void | Promise<void>;
  /**
   * Bounds a run that keeps going without ever failing: the transcript budget,
   * past which the OLDEST turns are folded into one model-written summary
   * before the next brain call, so a long run's prompt stops growing instead of
   * climbing until the provider rejects it.
   *
   * The knob is a THRESHOLD, not a policy function — see
   * {@link DefineAgentCompaction}. `compaction` is what a run tolerates, and the
   * summarize round-trip that enforces it is wiring, so the lid takes the
   * former and supplies the latter from the `model` it already has.
   *
   * Omit → NO compaction, exactly as before: the transcript grows for as long
   * as the model keeps asking for tools. Nothing is defaulted on your behalf —
   * a silent budget would change the prompt every existing caller sends.
   */
  readonly compaction?: DefineAgentCompaction;
  /**
   * How many of ONE turn's tool calls a transition launches at once. At the
   * default `1` a turn's calls go out one at a time, each waiting for the last
   * to settle; raise it and up to that many are launched together, so they are
   * all in flight in the fan-out ledger rather than queued behind each other.
   * A turn asking for more calls than this runs them in waves.
   *
   * It is a DISPATCH knob and not a wall-clock one: the kernel interprets a
   * transition's Cmds one after another (`runInterpret` awaits each handler)
   * and never interleaves them, so two launched calls still run back to back
   * and the turn costs their sum either way. Raising it makes the ledger — and
   * a `store`'s record of it — say what was launched; it does not make two slow
   * tools finish in the time of one. ADR 0018 rules that the serial fold stays
   * and names where real overlap is to live instead.
   *
   * Omit (or `1`) → serial dispatch, exactly as before.
   */
  readonly toolConcurrency?: number;
}

/**
 * The lid's compaction budget: the two numbers that say when a transcript is
 * too long and how much of it survives the fold. Both are plain counts, so the
 * trigger they build is PURE — a replay re-decides identically, and no clock or
 * token estimate enters the Model (ADR 0004).
 *
 * This is deliberately a threshold rather than the core's `planCompaction`
 * function: a policy function is a second place a lid agent would have to learn
 * the conversation shape, and the lid hides wiring, never state (ADR 0015). A
 * run that needs its own heuristic descends to `createAgent`, whose
 * `CompactionPolicy` this is built from.
 */
export interface DefineAgentCompaction {
  /**
   * Fold once the conversation holds at least this many turns, counted BEFORE
   * the brain call about to fire. Must be at least `1`.
   */
  readonly afterTurns: number;
  /**
   * How many of the NEWEST turns survive the fold intact, beside the summary.
   * Everything older becomes the summary's one synthetic head turn. Omit → `0`:
   * the whole transcript folds into the summary.
   *
   * A fold worth fewer than two turns is skipped by the agent itself — one turn
   * replaced by one summary shrinks nothing — so `keepTurns` within one of
   * `afterTurns` is a policy that never fires.
   */
  readonly keepTurns?: number;
}

/**
 * Which call an `onToolError` failure belongs to: the model's `callId` — the
 * fan-out identity the outcome folds back on — and the tool `name` the model
 * asked for, which for an `unknown_tool` is the name it invented rather than
 * any declared tool.
 */
export interface ToolErrorContext {
  readonly callId: string;
  readonly name: string;
}

/**
 * One lifecycle event a defined agent's run emits — {@link AgentEvent} with the
 * tool results typed against this agent's own tool set.
 */
export type DefinedAgentEvent<T extends AnyToolDef> = AgentEvent<ToolResult<T>>;

/** Host wiring for one `run`: the store, the ctx the tools need, a runId, a clock. */
export type DefinedAgentRunOptions<T extends AnyToolDef> = CtxArg<
  DefinedAgentCtx<T>
> & {
  readonly store?: Store<DefinedAgentState<T>>;
  /** The run's identity. Omit → a fresh UUID. */
  readonly runId?: string;
  /** The clock that stamps `at`. Omit → `Date.now`. */
  readonly clock?: () => number;
  /**
   * Observe the run's turn-level lifecycle events — `TurnSettled`,
   * `ToolSettled`, `RunDone` — in the order the kernel settles them. This is
   * the progress seam: without it the only way to see anything mid-run is
   * `machine(input)` plus the raw kernel loop.
   *
   * It forwards the runtime's existing semantic stream (`agentEvents()` /
   * `runtime.on`); it mints no vocabulary of its own, so a consumer folds the
   * same {@link AgentEvent}s a hand-wired `run` would.
   *
   * The listener is CONTAINED: a throw is caught and warned, never allowed to
   * take the run down, and never observable in `run`'s resolution. Only
   * transitions applied by THIS process project events, so a store-backed
   * resume replays nothing that settled before the boot.
   *
   * Omit → no projector is wired and the run behaves exactly as before.
   */
  readonly onEvent?: (event: DefinedAgentEvent<T>) => void;
  /**
   * Observe the token deltas of the turn being produced right now — the
   * granularity below `onEvent`'s. Wired only when the configured `model` is
   * the streaming shape (`async (messages, { onChunk }) => turn`); a plain
   * model has no deltas to give, so passing this beside one is silent.
   *
   * Chunks ride a SIDE CHANNEL, never state. They are not projected off
   * transitions like an {@link AgentEvent} is, because nothing about a chunk is
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
};

/**
 * One decorator per interpret cell you name: it receives the cell the agent
 * wired (`next`) and returns the cell that runs in its place. Every key is
 * optional and a cell nobody names is passed through by REFERENCE, so an
 * overlay that wraps one tool leaves the others the exact functions
 * `defineAgent` built.
 *
 * The wrapper's signature is the cell's, so calling `next(cmd, ctx, dispatch)`
 * is how the wrapped work happens — that is the typed Cmd→Msg edge
 * (`Cmd.define`'s `_ok` / `_err` Msgs), and returning its Msg is what keeps the
 * fold, and therefore a replay, identical to the unwrapped run's.
 */
export type InterpretOverlay<T extends AnyToolDef> = CellWrappers<
  DefinedAgentInterpret<T>
>;

/**
 * The decorator table over an interpret table `I`. Written over a bare type
 * parameter because `I[K]` is only indexable when `I` is one: applying the
 * mapped type to `DefinedAgentInterpret<T>` inline leaves TypeScript indexing
 * an unreduced generic mapped type, which it refuses.
 */
type CellWrappers<I> = {
  readonly [K in keyof I]?: (next: I[K]) => I[K];
};

/**
 * What `defineAgent(cfg).with(...)` takes — the one documented wrap point over
 * the machine the lid built.
 */
export interface DefinedAgentOverlay<T extends AnyToolDef> {
  readonly interpret: InterpretOverlay<T>;
}

/** What `defineAgent` returns. */
export interface DefinedAgent<T extends AnyToolDef> {
  /**
   * Run `input` to its terminal Model. Resolves on `run.phase: "done"`; a
   * failed run rejects with `DriveFailedError` carrying the failed Model.
   *
   * With a `store`, the same call is also the resume: a Model the Store hands
   * back mid-run is booted (`agent_boot`) at its one outstanding effect —
   * same `runId`, no tool re-run — and one already `done` resolves as it is.
   * A fresh start needs an empty Store.
   *
   * It resolves with {@link DefinedAgentResolvedState} — the Model whose `run`
   * slice is narrowed to the ENDED phases, so `(await agent.run(i)).run.runId`
   * reads without a guard against an `idle` arm this promise cannot produce.
   */
  readonly run: (
    input: string,
    ...opts: [Record<never, never>] extends [DefinedAgentCtx<T>]
      ? [opts?: DefinedAgentRunOptions<T>]
      : [opts: DefinedAgentRunOptions<T>]
  ) => Promise<DefinedAgentResolvedState<T>>;
  /** The machine `run` drives for `input` — the door down to the raw kernel. */
  readonly machine: (input: string) => DefinedAgentMachine<T>;
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

// ===========================================================================
// The defined agent.
// ===========================================================================

/**
 * Define an agent from a model, the tools it may call and its instructions, and
 * get back `run(input)` — a promise of the finished state — plus `machine(input)`
 * for driving the same run yourself, which is the entry point a newcomer picks,
 * `createAgent` being the layer underneath that you drop to only to walk a stage
 * pipeline of your own.
 *
 * Add `maxTurns`, `deadlineMs`, `maxElapsedMs` or `stopWhen` to bound the run;
 * all four are described on `DefineAgentConfig`. The run's `input` is its single stage, so it is durable
 * beside `instructions`, and the prompt is rendered from those two and the
 * conversation on every model call.
 *
 * One unusual requirement does not cost you the lid: `.with({ interpret })`
 * wraps one interpret cell of the machine this built and hands back another
 * defined agent, so `createAgent` is for a rebuild rather than for a detour.
 */
export function defineAgent<T extends AnyToolDef>(
  config: DefineAgentConfig<T>,
): DefinedAgent<T> {
  const router = toolRouter(config.tools);
  const { onToolError } = config;
  // No hook → the router is the plain one, so an omitted `onToolError` leaves
  // the interpret table the router always built.
  const tools =
    onToolError === undefined ? router : withToolErrorHook(router, onToolError);
  return definedAgent(config, { router, tools }, []);
}

/** The wiring every agent in one `defineAgent`'s lineage shares. */
interface LidWiring<T extends AnyToolDef> {
  readonly router: ToolRouter<T>;
  readonly tools: ToolRouter<T>;
}

/**
 * The defined agent for one config's wiring and the overlays stacked on it so
 * far. `defineAgent` is this with none; `with` is this with one more, which is
 * why a wrapped agent is a whole agent (`run`, `machine`, `with` again) rather
 * than a second kind of thing, and why the agent it was called on never
 * changes.
 *
 * The wiring is passed IN rather than rebuilt, so a `with` derives an agent that
 * shares the router — and therefore the very interpret cells the overlay does
 * not name.
 */
function definedAgent<T extends AnyToolDef>(
  config: DefineAgentConfig<T>,
  wiring: LidWiring<T>,
  overlays: readonly InterpretOverlay<T>[],
): DefinedAgent<T> {
  const { router, tools } = wiring;
  const { onToolError } = config;
  const machineWith = (
    input: string,
    onChunk: ((chunk: TurnChunk) => void) | undefined,
  ): DefinedAgentMachine<T> => {
    const brain = brainOf(config.model, onChunk);
    // The half of the core config that does not depend on whether compaction is
    // configured. Spread into BOTH arms below rather than mutated into one, so
    // the two `createAgent` calls are provably the same agent apart from the
    // compaction discriminant.
    const core: LidCoreConfig<T> = {
      stages: [input],
      turnOf: () => "act" as const,
      schemas: { act: agentTurnSchema },
      model: brain,
      instructions: config.instructions,
      payloadOf: promptOf,
      loadMessages: messagesOf,
      toolOf: tools.toolOf,
      // The per-tool timeout / retry knob (#117). The lid grows no option for
      // it: the policy is declared on the `tool()` that needs it, and the
      // router is what carries it down to the reducer that runs it.
      toolResilienceOf: tools.resilienceOf,
      // The BRAIN-call ladder (#146), which does grow one, because a bare
      // `model` function has nowhere else to declare it. Forwarded only when
      // set, so an omitted lid option leaves `AgentConfigCore.retry` unset
      // and the brain call unbackedoff, byte for byte as before.
      ...(config.retry !== undefined ? { retry: config.retry } : {}),
      // Forwarded only when set, for the same reason: an omitted knob leaves
      // `AgentConfigCore.toolConcurrency` unset and the fan-out at its serial
      // default.
      ...(config.toolConcurrency !== undefined
        ? { toolConcurrency: config.toolConcurrency }
        : {}),
      maxTurns: config.maxTurns,
      deadlineMs: config.deadlineMs,
      maxElapsedMs: config.maxElapsedMs,
      stopWhen: config.stopWhen,
    };
    // `AgentCompactionConfig` is a DISCRIMINATED union — compaction is either
    // structurally absent or a whole policy — and the `compact_run` interpret
    // obligation is derived from which member was passed. So the two arms are
    // written out rather than folded into one spread: a conditional spread would
    // widen the config to a bare optional, which is the very type lie the
    // discriminant exists to refuse.
    const compaction = config.compaction;
    const agent: DefinedAgentMachine<T> =
      compaction === undefined
        ? // The one assertion in the pair, and it widens the Cmd union rather
          // than the interpret obligation: this machine's `AgentCmd` fixes
          // compaction OFF, `DefinedAgentMachine` names the ON superset, and the
          // gap is the `compact_run` Cmd a policy-less reducer provably never
          // emits. Widening a union nothing can produce is sound; the reverse —
          // claiming a cell that is not wired — is what the discriminant refuses.
          (createAgent<
            string,
            LidPurpose,
            LidOutputs,
            ToolResult<T>,
            ToolCmd<T>,
            AgentMessage
          >(core).toMachine<DefinedAgentCtx<T>, T>({
            tools,
          }) as DefinedAgentMachine<T>)
        : compactingMachine(core, compaction, brain, tools);
    return overlaid(agent, overlays);
  };
  // The public door down carries no chunk sink: `machine(input)` is handed to
  // the raw kernel by a caller who has no run options to read one from.
  const machine = (input: string): DefinedAgentMachine<T> =>
    machineWith(input, undefined);
  const drive: DefinedAgent<T>["run"] = (input, ...[opts = noHost<T>()]) => {
    const { onEvent, onChunk } = opts;
    // No listener → no projector, so an omitted `onEvent` leaves the run the
    // kernel wiring it always had.
    const handle = run(machineWith(input, onChunk), {
      ...opts,
      terminal: isEnded,
      events:
        onEvent === undefined
          ? undefined
          : agentEvents<string, LidPurpose, LidOutputs, ToolResult<T>, T>({
              tools,
            }),
    });
    if (onEvent !== undefined) forwardEvents(handle, onEvent);
    if (onToolError !== undefined) {
      forwardLadderErrors(handle, router, onToolError);
    }
    const clock = opts.clock ?? Date.now;
    const begin = (booted: DefinedAgentState<T>) => {
      const at = clock();
      return isMidRun(booted)
        ? agentBootMsg(at)
        : startMsg(opts.runId ?? crypto.randomUUID(), at);
    };
    // Written as two calls rather than one with a conditional spread, for the
    // reason `AgentCompactionConfig`'s two arms are: the cancellation option is a
    // PAIR, and a conditional spread widens it back to two independent optionals
    // — the signal-with-no-cancel the union exists to refuse.
    const signal = opts.signal;
    if (signal === undefined) {
      return ended(driveToDone(handle, begin, isEnded, { failed: isFailed }));
    }
    return ended(
      driveToDone(handle, begin, isEnded, {
        failed: isFailed,
        signal,
        cancel: () => agentCancelMsg(clock()),
      }),
    );
  };
  return {
    machine,
    run: drive,
    with: (overlay) =>
      definedAgent(config, wiring, [...overlays, overlay.interpret]),
  };
}

/**
 * The machine with each overlay's named cells wrapped, in the order they were
 * stacked — so the LAST `with` is the outermost wrapper and the innermost
 * `next` is always the cell the lid itself wired.
 *
 * A cell nobody names is carried over by REFERENCE, which is what "unnamed
 * cells untouched" means literally: the wrapped table holds the same functions
 * for every other key. The machine is rebuilt as a new object rather than
 * mutated, because the same `defineAgent` config builds a fresh machine per
 * `input` and per overlay stack, and it goes back through `defineMachine` so
 * the `__form` tag a spread drops is stamped again.
 *
 * An unknown key throws HERE rather than at `with`: the table to check a name
 * against is the machine's, and the machine exists only per `input`.
 */
function overlaid<T extends AnyToolDef>(
  machine: DefinedAgentMachine<T>,
  overlays: readonly InterpretOverlay<T>[],
): DefinedAgentMachine<T> {
  if (overlays.length === 0) return machine;
  type Cell = (...args: never[]) => Promise<unknown>;
  const cells = { ...(machine.interpret as Record<string, Cell>) };
  for (const overlay of overlays) {
    const wrappers = overlay as unknown as Record<string, (next: Cell) => Cell>;
    for (const [type, wrap] of Object.entries(wrappers)) {
      const cell = cells[type];
      if (cell === undefined) {
        throw new Error(
          `@demlik/tea: defineAgent(...).with named the interpret cell ` +
            `"${type}", which this agent's machine has none of. Its cells are: ` +
            `${Object.keys(cells).sort().join(", ")}.`,
        );
      }
      cells[type] = wrap(cell);
    }
  }
  return defineMachine({
    ...machine,
    interpret: cells as DefinedAgentInterpret<T>,
  } as DefinedAgentMachine<T>);
}

// ===========================================================================
// The named parts `defineAgent` composes.
// ===========================================================================

/**
 * The `ModelPort` `createAgent` is configured with, for either model shape.
 *
 * A plain model is passed through UNTOUCHED — same reference, same one-argument
 * call, so the arity that `isPlainModel` reads (and the misroute error a
 * non-`async` model earns) is exactly what it was before streaming existed. A
 * streaming model is wrapped in an `async` one-argument function that binds this
 * run's sink, which is what makes the sink per-run while `model` stays per-agent.
 *
 * The wrapper resolves whatever the streaming model resolves and adds nothing:
 * the turn still meets `agentTurnSchema` at the same seam, so the settled turn
 * — and therefore the Model — cannot depend on whether anyone watched.
 */
function brainOf(
  model: DefinedAgentModel,
  onChunk: ((chunk: TurnChunk) => void) | undefined,
): PlainModel<AgentMessage, AgentTurn> {
  if (!isStreamingModel(model)) {
    return model as PlainModel<AgentMessage, AgentTurn>;
  }
  const streaming = model as StreamingModel<AgentMessage, AgentTurn>;
  const stream: ModelStream = {
    onChunk: onChunk === undefined ? dropChunk : contained("onChunk", onChunk),
  };
  return async (messages) => streaming(messages, stream);
}

/** The sink a streaming model gets when nobody is watching. PURE. */
function dropChunk(): void {}

/**
 * A caller's listener, wrapped so its defects stay its own: a throw is warned
 * about and swallowed rather than propagated into the run that fired it.
 *
 * The run's contract must not depend on the listener's. For `onEvent` the
 * runtime's own fanout is throw-isolated but routes to `OnError`, whose default
 * re-throws on a fresh macrotask; for `onChunk` there is no fanout at all — the
 * sink is called straight from the adapter, so an escaping throw would reject
 * the model call and settle a `resilient_err` for a defect in a progress bar.
 */
function contained<E>(what: string, listener: (event: E) => void) {
  return (event: E): void => {
    try {
      listener(event);
    } catch (err) {
      console.warn(`@demlik/tea: a run's ${what} listener threw`, err);
    }
  };
}

/**
 * The `createAgent` config both of `defineAgent`'s arms share — everything but
 * the compaction discriminant, named so the two arms can be handed one value
 * and provably differ in that field alone.
 */
type LidCoreConfig<T extends AnyToolDef> = AgentConfigCore<
  string,
  LidPurpose,
  LidOutputs,
  ToolResult<T>,
  ToolCmd<T>,
  AgentMessage
>;

/**
 * The compacting arm's machine: the same core config plus the policy, wired to
 * the `compact_run` cell the ON discriminant requires.
 *
 * The one assertion lives here, and it is a GENERICS artifact rather than a
 * claim about the wiring. `toMachine`'s obligation subtracts the router's own
 * Cmds through `Exclude<TC, WiredToolCmd<T>>`, and `WiredToolCmd` is a
 * conditional on `T` — unresolvable while `T` is still a type parameter, so TS
 * cannot see that the router's cells already discharge everything but
 * `compact_run`. At a concrete `T` it reduces and the obligation is exactly the
 * cell supplied. `toMachine` spreads the router's table under this one either
 * way, so nothing here overrides a tool cell.
 */
function compactingMachine<T extends AnyToolDef>(
  core: LidCoreConfig<T>,
  knob: DefineAgentCompaction,
  brain: PlainModel<AgentMessage, AgentTurn>,
  tools: ToolRouter<T>,
): DefinedAgentMachine<T> {
  const agent = createAgent<
    string,
    LidPurpose,
    LidOutputs,
    ToolResult<T>,
    ToolCmd<T>,
    AgentMessage
  >({ ...core, compaction: compactionPolicyOf<ToolResult<T>>(knob) });
  const wiring = {
    tools,
    toolInterpret: { compact_run: summarizeWith(brain) },
  } as Parameters<typeof agent.toMachine<DefinedAgentCtx<T>, T>>[0];
  return agent.toMachine<DefinedAgentCtx<T>, T>(wiring);
}

/**
 * The system prompt the summarize round-trip runs under. It is the lid's, not
 * the agent's: the agent's own `instructions` tell the model how to do the job,
 * and re-sending them here would ask a summarizer to keep working the task.
 */
const SUMMARIZE_INSTRUCTION =
  "Summarize the conversation so far. Preserve the facts, decisions and tool " +
  "results a continuation would need, and drop everything else. Reply with the " +
  "summary as your message content and request no tools.";

/**
 * The core `CompactionPolicy` the lid's threshold knob builds — the whole of the
 * translation from "how long a transcript I tolerate" to "how many of the oldest
 * turns to fold now".
 *
 * `planCompaction` is PURE and reads only turn counts, so a replay re-decides
 * identically (design D). Below the threshold it returns `0` and the agent fires
 * the brain call it was going to fire, which is what makes an unconfigured — and
 * an under-budget — run byte for byte the run it was before.
 *
 * `payloadOf` renders the FOLDING turns and no others: the summarize call is
 * given exactly the transcript that is about to be dropped, so the summary it
 * writes is a replacement for that text rather than a restatement of the whole
 * conversation.
 */
function compactionPolicyOf<R>(
  knob: DefineAgentCompaction,
): CompactionPolicy<R, AgentMessage> {
  const keep = knob.keepTurns ?? 0;
  return {
    planCompaction: (conversation) =>
      conversation.turns.length >= knob.afterTurns
        ? Math.max(0, conversation.turns.length - keep)
        : 0,
    payloadOf: (conversation, folding): AgentPrompt<R> => ({
      instructions: SUMMARIZE_INSTRUCTION,
      input: null,
      conversation: {
        ...conversation,
        turns: conversation.turns.slice(0, folding),
        toolRecords: conversation.toolRecords.filter((r) => r.turn < folding),
      },
    }),
  };
}

/**
 * The `compact_run` interpret cell the lid wires: the summarize I/O, run through
 * the SAME `model` the brain calls, because a lid agent has exactly one model
 * and a second one would be a knob this issue did not add.
 *
 * The summary is the returned turn's `content`. A turn is what a
 * `defineAgent` model resolves, so nothing here asks the adapter for a second
 * output shape — the tool calls such a turn may carry are ignored, since the
 * summarizer is not in the loop that could run them.
 *
 * A throw propagates: the agent's dedicated compaction resilient slice owns the
 * retry / backoff and folds a failure as `compact_err`, which proceeds without
 * compacting rather than failing the run.
 */
function summarizeWith(
  model: PlainModel<AgentMessage, AgentTurn>,
): (cmd: AgentCompactRunCmd) => Promise<AgentCompactOkMsg> {
  return async (cmd) => {
    const payload = cmd.input.payload as AgentPrompt<unknown>;
    const turn = await model(renderPrompt(payload));
    // `Date.now()` at the settle, exactly as the composed llm-call handler
    // stamps the brain call's own settle Msg.
    return {
      type: MsgType.CompactOk,
      key: COMPACTION_PURPOSE,
      result: {
        key: COMPACTION_PURPOSE,
        purpose: COMPACTION_PURPOSE,
        output: { summary: turn.content },
      },
      at: Date.now(),
    };
  };
}

/** `payloadOf`: the prompt is the durable state, nothing else. PURE. */
function promptOf<R>(
  stage: string | undefined,
  conversation: Conversation<R>,
  instructions: string | null,
): AgentPrompt<R> {
  return { instructions, input: stage ?? null, conversation };
}

/**
 * `loadMessages`: render the call's prompt to the messages the model reads.
 * The payload is what `promptOf` built for this same agent, so the narrowing is
 * an identity — the one place the `unknown` payload is read back typed.
 */
const messagesOf: MessageLoader<LidPurpose, AgentMessage> = async (
  call: LlmCall<LidPurpose>,
) => renderPrompt(call.payload as AgentPrompt<unknown>);

/** The prompt as messages: the head, then each turn with its tool outcomes. PURE. */
export function renderPrompt(prompt: AgentPrompt<unknown>): AgentMessage[] {
  const head: AgentMessage[] = [];
  if (prompt.instructions !== null) {
    head.push({ role: "system", content: prompt.instructions });
  }
  if (prompt.input !== null) {
    head.push({ role: "user", content: prompt.input });
  }
  const { turns, toolRecords } = prompt.conversation;
  const transcript = turns.flatMap<AgentMessage>((turn, i) => [
    assistantOf(turn),
    ...toolRecords
      .filter((r) => r.turn === i)
      .map<AgentMessage>((r) => ({
        role: "tool",
        callId: r.call.callId,
        name: r.call.name,
        outcome: r.outcome,
      })),
  ]);
  return [...head, ...transcript];
}

/**
 * The stored turn as the `assistant` message the model reads back. `provider`
 * rides only when the turn carries one, so a turn persisted before the slot
 * existed renders exactly as it did then. PURE.
 */
function assistantOf(turn: AgentTurn): AgentMessage {
  const { content, toolCalls } = turn;
  return "provider" in turn
    ? { role: "assistant", content, toolCalls, provider: turn.provider }
    : { role: "assistant", content, toolCalls };
}

/**
 * The options a `run` with no host wiring gets. `opts` may be omitted only when
 * no tool demands ctx — the `run` signature requires it otherwise — so the
 * empty record is a complete options value there, which is what this asserts.
 */
function noHost<T extends AnyToolDef>(): DefinedAgentRunOptions<T> {
  return {} as DefinedAgentRunOptions<T>;
}

/**
 * Every `AgentEvent` discriminant, so one `on(...)` subscription per type
 * covers the whole union. Subscribing before the drive dispatches is what makes
 * the delivery total: an event of a type nobody is listening for is dropped by
 * the runtime's fanout, not queued.
 */
const AGENT_EVENT_TYPES = ["TurnSettled", "ToolSettled", "RunDone"] as const;

/**
 * Forward the runtime's semantic events to the caller's `onEvent`, CONTAINED.
 *
 * `defineAgent` owns the containment (see {@link contained}): a throwing
 * listener is warned about and the run goes on to its terminal Model, so
 * `run`'s contract does not depend on the listener's.
 *
 * Ordering is the kernel's: one handler per type, all attached before the
 * drive's first dispatch, so events arrive in the order the projector emits
 * them.
 */
function forwardEvents<T extends AnyToolDef>(
  handle: BootingRuntime<
    DefinedAgentState<T>,
    AgentMachineMsg<LidPurpose, LidOutputs, ToolResult<T>> | WiredToolMsg<T>,
    DefinedAgentEvent<T>
  >,
  onEvent: (event: DefinedAgentEvent<T>) => void,
): void {
  const deliver = contained("onEvent", onEvent);
  for (const type of AGENT_EVENT_TYPES) {
    handle.on(type, deliver);
  }
}

/**
 * Deliver a LADDERED call's one failure to `onToolError` (#117 meeting #115).
 *
 * `withToolErrorHook` below wraps interpret, and that is the right seam for a
 * call nothing else owns — but a tool declaring `timeoutMs` or `retry` settles
 * once per ATTEMPT there, and the attempts a ladder absorbs are not failures the
 * run produced: the model is shown none of them, and neither is the host. The
 * call's real ending is minted by the reducer (a timeout has no handler settle
 * at all — the call is over while its attempt is still running), so it is
 * readable only off the fold.
 *
 * So the two seams SPLIT on one question, `resilienceOf(call) !== null`, and
 * every call is announced by exactly one of them. That is what makes
 * once-per-call structural rather than a filter the caller writes: a laddered
 * call is silent at interpret and announced here, a bare call the other way
 * round, and neither can announce the other's.
 *
 * The cost is that a laddered call's failure is read AFTER its fold rather than
 * before it — there is nothing earlier to read. The two other clauses hold
 * unchanged: once per settled call (`fired`), and never re-announced on resume,
 * because the boot/start transition seeds `fired` with every record the `Store`
 * handed back and folds none of its own.
 */
function forwardLadderErrors<T extends AnyToolDef>(
  handle: BootingRuntime<
    DefinedAgentState<T>,
    AgentMachineMsg<LidPurpose, LidOutputs, ToolResult<T>> | WiredToolMsg<T>,
    DefinedAgentEvent<T>
  >,
  router: ToolRouter<T>,
  onToolError: NonNullable<DefineAgentConfig<T>["onToolError"]>,
): void {
  const fired = new Set<string>();
  handle.observe((msg, state) => {
    // `agent_start` and `agent_boot` are the run's first transition and fold no
    // tool record of their own, so every record visible under one is history a
    // `Store` handed back. Reading the Msg rather than "is this the first call"
    // is what makes that a stated invariant instead of an assumed one.
    const seeding =
      msg.type === MsgType.AgentStart || msg.type === MsgType.AgentBoot;
    for (const record of state.conversation?.toolRecords ?? []) {
      const { outcome, call } = record;
      if (outcome.kind !== "error") continue;
      if (fired.has(call.callId)) continue;
      fired.add(call.callId);
      if (seeding) continue;
      // A call no ladder owns was announced at the interpret boundary already.
      if (router.resilienceOf(call) === null) continue;
      void Promise.resolve(
        onToolError(outcome as ToolFailureOf<T>, {
          callId: call.callId,
          name: call.name,
        }),
      ).catch((err: unknown) => {
        console.warn("@demlik/tea: a run's onToolError hook threw", err);
      });
    }
  });
}

/**
 * The router with the consumer's `onToolError` spliced into every interpret
 * handler — the same router, one seam wider.
 *
 * The interpret boundary is where the hook belongs, and the two timing clauses
 * on `onToolError` are properties of that seam rather than bookkeeping this
 * function does: a handler's settled Msg is read back through the router's own
 * `outcomeOf` (so the hook and the conversation see ONE rendering of the
 * failure) and the Msg is returned only after the hook resolves, which is
 * "before the fold"; and interpret runs only for the effects THIS process
 * launches, which is "not again on resume". Nothing is folded, counted or
 * remembered here.
 *
 * `tool_rejected` is wrapped like any other handler, so `unknown_tool` and
 * `malformed_args` reach the hook exactly as a tool's own failure does.
 *
 * A LADDERED call is the one thing this seam stays silent about, because here it
 * is one settle per ATTEMPT and the absorbed ones are not failures the run
 * produced. `forwardLadderErrors` above announces those calls off the fold
 * instead; the two seams split on `resilienceOf` and every call belongs to
 * exactly one.
 */
function withToolErrorHook<T extends AnyToolDef>(
  router: ToolRouter<T>,
  onToolError: NonNullable<DefineAgentConfig<T>["onToolError"]>,
): ToolRouter<T> {
  type Handler = (
    cmd: { readonly type: string },
    ctx: unknown,
  ) => Promise<{ readonly type: string } | void>;
  const handlers = router.interpret as unknown as Record<string, Handler>;
  const wrapped: Record<string, Handler> = {};
  for (const [type, handler] of Object.entries(handlers)) {
    wrapped[type] = async (cmd, ctx) => {
      const msg = await handler(cmd, ctx);
      if (msg === undefined) return msg;
      const settled = router.outcomeOf(msg);
      if (settled === null || settled.outcome.kind === "ok") return msg;
      // A laddered call is announced off its fold, once, by
      // `forwardLadderErrors` — never per attempt from here.
      if (ownedByLadder(router, cmd, settled.callId)) return msg;
      try {
        await onToolError(settled.outcome as ToolFailureOf<T>, {
          callId: settled.callId,
          name: calledName(cmd),
        });
      } catch (err) {
        console.warn("@demlik/tea: a run's onToolError hook threw", err);
      }
      return msg;
    };
  }
  return {
    ...router,
    interpret: wrapped as unknown as ToolRouter<T>["interpret"],
  };
}

/**
 * Whether a ladder owns the call this Cmd is an attempt of — the one question
 * the two `onToolError` seams split on. Read off the same `resilienceOf` the
 * reducer runs the ladder from, so the two can never disagree about who
 * announces a call. A `tool_rejected` names no declared tool, so it is never
 * laddered and always announced at the interpret boundary. PURE.
 */
function ownedByLadder<T extends AnyToolDef>(
  router: ToolRouter<T>,
  cmd: { readonly type: string },
  callId: string,
): boolean {
  return router.resilienceOf({ name: cmd.type, callId, args: {} }) !== null;
}

/**
 * The tool name a Cmd was built for: its own `type`, except for the router's
 * `tool_rejected`, whose type is the router's and whose rejection carries the
 * name the MODEL asked for — the name a consumer needs to see for an
 * `unknown_tool`. PURE.
 */
function calledName(cmd: { readonly type: string }): string {
  const rejection = (cmd as { readonly error?: { readonly name?: unknown } })
    .error;
  return typeof rejection?.name === "string" ? rejection.name : cmd.type;
}

/** The Msg that sets a run in motion. */
function startMsg(runId: string, at: number) {
  return { type: MsgType.AgentStart, runId, at } as const;
}

/**
 * Whether the boot State is a run the Store handed back mid-flight — live, or
 * suspended on tools — which `agent_boot` resumes at its one outstanding
 * effect. A `start` here would mint a new `runId` and a fresh conversation
 * over the work already done; that is a restart, and the durable half of
 * `defineAgent` is exactly that it never does one. PURE.
 */
function isMidRun(s: AgentState<string, LidPurpose, LidOutputs, unknown>) {
  const { kind } = status(s);
  return kind === "running" || kind === "suspended";
}

/**
 * The drive's terminal predicate — the run ENDED, by finishing or by being
 * cancelled. Both are outcomes the drive resolves on and the Store persists, so
 * both have to read terminal here or an aborted run would wait for a `done` that
 * is never coming. PURE.
 */
function isEnded(s: AgentState<string, LidPurpose, LidOutputs, unknown>) {
  return s.run.phase === "done" || s.run.phase === "cancelled";
}

/**
 * The drive's resolved State at the type the drive's own predicates already
 * guarantee. `driveToDone` is typed `Promise<S>` over the machine's whole Model
 * because its terminal test is an opaque `(s) => boolean` it cannot read as a
 * type guard — so the narrowing `isEnded` performs is invisible at the seam and
 * is re-stated here: the promise resolves only where `isEnded` holds (`done` /
 * `cancelled`), and everything `isFailed` marks rejects. This is the ONE place
 * the two are joined, so `run`'s public type carries no `idle` arm and no caller
 * asserts (#155).
 */
function ended<T extends AnyToolDef>(
  drive: Promise<DefinedAgentState<T>>,
): Promise<DefinedAgentResolvedState<T>> {
  return drive as Promise<DefinedAgentResolvedState<T>>;
}

/** The drive's failure predicate — either failure channel, via `status`. PURE. */
function isFailed(s: AgentState<string, LidPurpose, LidOutputs, unknown>) {
  return status(s).kind === "failed";
}
