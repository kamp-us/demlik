/**
 * @demlik/tea/agent — the wired-machine surface.
 *
 * The Cmd / Msg vocabulary the knob speaks, the knob interface `createAgent`
 * returns (`AgentKnob` / `AgentToMachine`), the do↔agent boot port, the
 * semantic lifecycle event stream + its projector (`agentEvents`), and the two
 * pure wiring helpers `mergeInterpret` / `liftAgent`. The reducer core (the
 * `createAgent` factory that implements this surface) lives in `./index`.
 */

import type { Cmd, Interpret, Machine } from "../index";
import type {
  LlmCall,
  LlmCallPorts,
  LlmFailMsg,
  LlmRunCmd,
  LlmSucceedMsg,
  LlmTimerMsg,
} from "../llm-call";
import type { DeadlineSub, MonitoredRunCmd } from "../monitored-run";
import { MsgType } from "../protocol";
import type {
  AgentCompactErrMsg,
  AgentCompactOkMsg,
  AgentCompactRunCmd,
  CompactInterpret,
} from "./compaction";
import type { AgentState, AgentTurn } from "./types";

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
 *                              slice emits, present in the union ONLY when
 *                              checkpointing is on (`Snap = true`). With
 *                              checkpointing off the monitored-run slice never
 *                              emits a `snapshot_write` Cmd, so it is config-derived
 *                              OUT of the emitted set — the consumer is never asked
 *                              to interpret a Cmd that can never fire (#55).
 *   - `TC`                    — the consumer's per-tool effect, mapped to the
 *                              consumer's own tool interpret cell.
 *
 * `Snap` defaults to `true` so the verb-internal usage (which forwards whatever
 * monitored-run emits) and the published type stay a safe superset; the wired
 * machine `toMachine` returns is parametrized on the overload-fixed `Snap` so its
 * Cmd set is exact (`MonitoredRunCmd` present only when checkpointing is on).
 */
export type AgentCmd<
  P extends string,
  TC extends Cmd = Cmd,
  Snap extends boolean = true,
  Compact extends boolean = true,
> =
  | AgentLlmRunCmd<P>
  | (Snap extends true ? MonitoredRunCmd<unknown> : never)
  | (Compact extends true ? AgentCompactRunCmd : never)
  | TC;

/**
 * The CONFIG-DERIVED snapshot obligation on `toMachine`'s `toolInterpret` (#55).
 * Resolves on the `Snap` discriminant the snapshotting overload of `createAgent`
 * fixes (`true` checkpointing-on / `false` off):
 *
 *   - checkpointing ON  → a REQUIRED `snapshot_write` cell
 *     (`Interpret<M, MonitoredRunCmd<unknown>, Ctx>`). A real checkpoint write
 *     MUST be wired — the agent never defaults it to a no-op.
 *   - checkpointing OFF → `{ snapshot_write?: never }`. The cell is FORBIDDEN:
 *     the Cmd is config-derived out of the emitted set, so wiring it would be
 *     dead code. The consumer cannot even mention `snapshot_write`.
 *
 * This is the type that kills the `snapshot_write: async () => undefined`
 * ceremony: the obligation is present in the contract EXACTLY when the Cmd can
 * fire, never as a silent gap the agent backfills.
 */
export type SnapshotInterpret<
  M extends { type: string },
  Snap extends boolean,
  Ctx,
> = Snap extends true
  ? Interpret<M, MonitoredRunCmd<unknown>, Ctx>
  : { readonly snapshot_write?: never };

/**
 * The `toMachine` signature, parametrized on the `Snap` + `Compact` discriminants
 * so the snapshotting / compaction overloads of `createAgent` hand back the right
 * obligations. The `toolInterpret` requires (ON) or forbids (OFF) the
 * `snapshot_write` cell via {@link SnapshotInterpret} and the `compact_run` cell
 * via {@link CompactInterpret}, and the machine's Cmd type is the config-derived
 * `AgentCmd<P, TC, Snap, Compact>`.
 */
export type AgentToMachine<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd,
  Snap extends boolean,
  Compact extends boolean,
> = <Ctx = object>(opts?: {
  readonly toolInterpret?: Interpret<AgentMachineMsg<P, O, R>, TC, Ctx> &
    SnapshotInterpret<AgentMachineMsg<P, O, R>, Snap, Ctx> &
    CompactInterpret<AgentMachineMsg<P, O, R>, Compact, Ctx>;
}) => Machine<
  AgentState<Stage, P, O, R>,
  AgentMachineMsg<P, O, R>,
  AgentCmd<P, TC, Snap, Compact>,
  DeadlineSub,
  Ctx
>;

/**
 * The agent knob `createAgent` returns — the uniform verb contract every tea
 * composition exposes, plus the wired `toMachine` and the `unsafeDetachedHandlers`
 * escape hatch. `Snap` flows ONLY into `toMachine`'s `toolInterpret` obligation
 * (the snapshot derivation, #55); every verb is snapshot-agnostic. The model
 * message shape `Msg` does not appear on the knob surface (it is internal to the
 * brain call's loader), so it is not a type parameter here — only `createAgent`
 * carries it, to thread the config's `loadMessages` / `model` ports.
 */
export interface AgentKnob<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd,
  Snap extends boolean,
  Compact extends boolean,
> {
  readonly init: () => AgentState<Stage, P, O, R>;
  readonly start: AgentVerb1<Stage, P, O, R, TC, [runId: string, at: number]>;
  readonly turn: AgentVerb1<
    Stage,
    P,
    O,
    R,
    TC,
    [result: AgentTurn, at: number]
  >;
  readonly toolOk: AgentVerb1<
    Stage,
    P,
    O,
    R,
    TC,
    [callId: string, result: R, at: number]
  >;
  readonly toolErr: AgentVerb1<
    Stage,
    P,
    O,
    R,
    TC,
    [callId: string, reason: string, at: number]
  >;
  readonly succeed: AgentVerb1<
    Stage,
    P,
    O,
    R,
    TC,
    [key: string, msg: AgentLlmOkMsg<P, O>, at: number]
  >;
  readonly fail: AgentVerb1<
    Stage,
    P,
    O,
    R,
    TC,
    [key: string, msg: AgentLlmErrMsg<P>, at: number]
  >;
  readonly compactOk: AgentVerb1<
    Stage,
    P,
    O,
    R,
    TC,
    [key: string, msg: AgentCompactOkMsg, at: number]
  >;
  readonly compactErr: AgentVerb1<
    Stage,
    P,
    O,
    R,
    TC,
    [key: string, msg: AgentCompactErrMsg, at: number]
  >;
  readonly onTimer: AgentVerb1<Stage, P, O, R, TC, [msg: AgentTimerMsg]>;
  readonly boot: AgentVerb1<Stage, P, O, R, TC, [at: number]>;
  readonly isSettled: (s: AgentState<Stage, P, O, R>) => boolean;
  readonly currentStage: (s: AgentState<Stage, P, O, R>) => Stage | undefined;
  readonly brainCall: (s: AgentState<Stage, P, O, R>) => LlmCall<P>;
  readonly subs: (s: AgentState<Stage, P, O, R>) => readonly DeadlineSub[];
  readonly toMachine: AgentToMachine<Stage, P, O, R, TC, Snap, Compact>;
  readonly unsafeDetachedHandlers: <M>(
    ports: AgentPorts<P, O, M>,
  ) => AgentDetachedHandlers<P, M>;
}

/** A verb taking the state + `Args`, returning the knob's `[State, Cmd[]]` tuple. */
type AgentVerb1<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  TC extends Cmd,
  Args extends readonly unknown[],
> = (
  s: AgentState<Stage, P, O, R>,
  ...args: Args
) => readonly [AgentState<Stage, P, O, R>, readonly AgentCmd<P, TC>[]];

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
 * `as unknown as Interpret<...>`) keeps `agent.unsafeDetachedHandlers(ports)` honest: the
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
// AgentBootPort — the typed do↔agent boot seam (issue #60).
// ===========================================================================
//
// A run that rehydrated mid-loop must re-fire its one outstanding effect on
// activation. `do/host`'s `autoBoot` is the firing side; this agent reducer's
// `boot` verb is the receiving side. The coupling used to be a RAW string:
// host built `{ type: "agent_boot", at }` by hand and the agent string-matched
// it — a literal duplicated across the seam with nothing tying the two ends.
//
// `AgentBootPort` promotes that coupling to a typed contract OWNED by the agent
// (which owns the boot Msg shape): the `AgentBootMsg` type and the
// `agentBootMsg` constructor. `do/host` imports the constructor instead of
// hand-writing the literal. Adding a field to boot (or renaming it) is now a
// one-file change here with the constructor's signature flagging every caller,
// not a silent cross-module string drift.

/** The Msg `do/host`'s `autoBoot` fires to re-enter the agent's `boot` verb on rehydrate. */
export type AgentBootMsg = {
  readonly type: typeof MsgType.AgentBoot;
  readonly at: number;
};

/**
 * The do↔agent boot port: construct the `agent_boot` Msg `autoBoot` dispatches
 * on a resumable rehydrate. The agent owns this constructor so the boot Msg
 * shape lives in ONE place — the host fires it through here, never as a raw
 * `{ type: "agent_boot" }` literal.
 */
export function agentBootMsg(at: number): AgentBootMsg {
  return { type: MsgType.AgentBoot, at };
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
 * There is deliberately NO `agent_turn` variant here. The wired loop folds a
 * model turn INSIDE `succeed` from the re-entered `resilient_ok` — a single
 * settle Msg advances both the retry slice and the conversation (the L3 fix).
 * Exposing `agent_turn` as a dispatchable Msg re-opened the stuck-`running` bug:
 * a hand-fed turn folds the conversation without ever re-entering `resilient_ok`,
 * so `succeed` never runs and the resilient slice stays `running` (#54). The
 * `turn` verb remains on the knob for the consumer that wires the verbs by hand
 * (manual wiring), but it is not part of the one wired machine's Msg surface.
 */
export type AgentMachineMsg<P extends string, O extends Record<P, unknown>, R> =
  | {
      readonly type: typeof MsgType.AgentStart;
      readonly runId: string;
      readonly at: number;
    }
  | {
      readonly type: typeof MsgType.AgentToolOk;
      readonly callId: string;
      readonly result: R;
      readonly at: number;
    }
  | {
      readonly type: typeof MsgType.AgentToolErr;
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
  // The compaction settle Msgs RE-ENTER from the compaction interpret cell
  // (#85) — `compact_ok` folds the summary back (drops the oldest N turns +
  // their tool records, then fires the next brain call), `compact_err` backs off
  // via the compaction slice's retry or — on exhaustion — proceeds without
  // compacting (errors are data). Dedicated discriminants, re-keyed off the
  // composed resilient settle at the cell boundary.
  | AgentCompactOkMsg
  | AgentCompactErrMsg
  // The timer Msg is `DeadlineExceeded` itself (not wrapped) so the
  // `subscribeDeadline` cell dispatches it straight into `update`, exactly as
  // the resilient-call / llm-call / monitored-run gold standards wire it.
  | AgentTimerMsg
  | AgentBootMsg;

// ===========================================================================
// AgentEvent — the SEMANTIC lifecycle event stream (issue #47).
// ===========================================================================

/**
 * The agent's PUBLIC lifecycle events — the semantic stream a consumer
 * subscribes to via `runtime.on(type, …)` (#47). This is the seam that
 * DECOUPLES observability/SSE code from the agent's PRIVATE retry/loop Msg
 * vocabulary: where the old code switched on `resilient_ok` / `agent_tool_ok`
 * (the inherited resilient-call / tool-fan-out plumbing) off the raw `observe`
 * firehose, a consumer now folds these named events. The private Msg names live
 * ONLY inside `agentEvents` (the projector) — they appear nowhere in this union
 * or any exported type, so a UI built on `TurnSettled` does not break the day
 * the retry plumbing is renamed.
 *
 *   - `TurnSettled` — a brain turn settled (the model produced an `AgentTurn`).
 *     Projected off the private `resilient_ok` settle Msg; carries the parsed
 *     `turn` (the narration + tool calls the model asked for).
 *   - `ToolSettled` — a tool call settled OK. Projected off the private
 *     `agent_tool_ok` Msg; carries the `callId` and the tool `result`.
 *   - `RunDone` — the run finished. Projected off the post-transition State
 *     reaching `run.phase === "done"`; carries the run's `output` (the terminal
 *     model turn, or `null`) — the same first-class result `Runtime.result()`
 *     reads (#46), surfaced as an event for the streaming consumer.
 */
export type AgentEvent<R> =
  | { readonly type: "TurnSettled"; readonly turn: AgentTurn }
  | {
      readonly type: "ToolSettled";
      readonly callId: string;
      readonly result: R;
    }
  | { readonly type: "RunDone"; readonly output: AgentTurn | null };

/**
 * Project one APPLIED agent transition `(msg, state)` to its semantic
 * {@link AgentEvent}s (#47) — the `events` projector a consumer passes to
 * `run(machine, { events: agentEvents() })` to light up `runtime.on(...)`.
 *
 * This is the ONE place the agent's PRIVATE Msg names are read: it maps
 * `resilient_ok` → `TurnSettled` and `agent_tool_ok` → `ToolSettled`, and reads
 * the post-transition `run.phase` for `RunDone`. The mapping is total over the
 * Msg union (a `default`-free switch on the discriminant) and returns `[]` for
 * the transitions that carry no public event (start / boot / timer / the error
 * arms), so a private name never escapes into `AgentEvent`.
 *
 * A single transition may emit more than one event: the brain turn that retires
 * the final stage settles a turn (`TurnSettled`) AND finishes the run
 * (`RunDone`) — both are projected from that one `resilient_ok` transition.
 * `RunDone` is gated on `run.phase === "done"`, which the wired loop reaches
 * exactly once (the agent is terminal there and dispatches no further
 * transition), so the event fires once per run.
 *
 * PURE — reads only the passed `(msg, state)`; no clock, no RNG, no throw.
 *
 * @typeParam P     Brain-call purposes.
 * @typeParam O     Per-purpose outputs (bound to `AgentTurn`, the agentic shape).
 * @typeParam R     Tool result type.
 * @typeParam Stage Pipeline stage type.
 */
export function agentEvents<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
>(): (
  msg: AgentMachineMsg<P, O, R>,
  state: AgentState<Stage, P, O, R>,
) => readonly AgentEvent<R>[] {
  return (msg, state) => {
    const events: AgentEvent<R>[] = [];
    switch (msg.type) {
      case MsgType.ResilientOk:
        // The PRIVATE brain-call settle Msg → the public TurnSettled. Its
        // `result.output` is the parsed `AgentTurn` (the `O extends Record<P,
        // AgentTurn>` bound pins every purpose's output to an `AgentTurn`, the
        // same reasoning `state.output` relies on, #46/#48).
        events.push({ type: "TurnSettled", turn: msg.result.output });
        break;
      case MsgType.AgentToolOk:
        // The PRIVATE tool-fan-out settle Msg → the public ToolSettled.
        events.push({
          type: "ToolSettled",
          callId: msg.callId,
          result: msg.result,
        });
        break;
      // start / boot / timer / the *_err arms / the compaction settles carry no
      // public event — return []. (No `default`: the switch is exhaustive over
      // the Msg discriminant, so a new Msg variant forces a decision here at
      // compile time.) Compaction is an internal optimization, not a semantic
      // lifecycle moment a UI folds — its settles are deliberately silent here.
      case MsgType.AgentStart:
      case MsgType.AgentToolErr:
      case MsgType.ResilientErr:
      case MsgType.CompactOk:
      case MsgType.CompactErr:
      case "deadline_exceeded":
      case MsgType.AgentBoot:
        break;
    }
    // RunDone is a STATE-shaped event (the run's terminal output, #46), not a
    // Msg-shaped one: the transition that lands `done` is the final brain turn
    // (which also emits TurnSettled above). Gate on the post-transition phase so
    // the same projector reports both.
    if (state.run.phase === "done") {
      events.push({ type: "RunDone", output: state.output });
    }
    return events;
  };
}

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
