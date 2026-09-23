/**
 * internal/resilience/with-deadline — auto-fail a wrapped machine at T+N, re-arm on
 * progress. A **pure function over machine data**: `withDeadline(base, config)`
 * takes any `Machine<S, M, C, U, Ctx>` beside its handlers (a `Wired`) and
 * returns a NEW `Wired` over the composed Model `{ base, $deadline }`. You
 * `run()` / `replay()` the result exactly like any other machine — there is no
 * new runtime, no privileged interception path.
 *
 * ## What it does
 *
 * The wrapper watches the base Msg stream. While the deadline is `armed`, the
 * engine's built-in `timer` Sub counts down `config.ms`. Every base Msg the
 * `config.progress` predicate accepts (default: every base Msg) is treated as
 * activity: the wrapper bumps a numeric `seq`, which the timer's `deps` carry,
 * so the engine stops the old countdown and starts a fresh one — "re-arm on
 * progress". If `config.ms` elapses with NO accepted progress, the timer
 * dispatches `$deadline:exceeded`; the merged `update` folds it by flipping
 * `phase` to `exceeded`, and from then on the timer is off (the machine has
 * auto-failed). The expiry is a slice transition visible in the Msg log — the
 * auto-fail is never an off-ledger side effect.
 *
 * This is an OBSERVE-ONLY wrapper in the same sense as `withTelemetry`: it never
 * intercepts a base Cmd and never gates a base Msg. `state.base` after wrapping
 * is BYTE-IDENTICAL to running the base alone, so the shared
 * `assertWrapperFaithful` gate passes with the deadline bolted on.
 *
 * ## The 5 rules it satisfies (from the wrapper-tier contract)
 *
 *   1. **Named, serializable slice.** Wrapper state lives at `model.$deadline`,
 *      a plain `{ phase, seq }` — JSON-serializable, never a closure. There is
 *      NO absolute timestamp in the slice: the clock is never read in `update`.
 *   2. **Retag-and-re-emit, never swallow.** The merged `update` runs the base
 *      reducer, passes its Cmds through UNCHANGED, and APPENDS its own
 *      `$deadline:rearm` / `$deadline:expire` decision Cmd. No base Cmd ever
 *      vanishes; nothing is gated.
 *   3. **Every decision is a Msg/Cmd.** Re-arm is a `$deadline:rearm` Cmd; the
 *      auto-fail expiry is the `$deadline:exceeded` Msg the Sub delivers, folded
 *      into the slice and echoed as a `$deadline:expire` Cmd. "Why did this
 *      fire" is answerable from reducer + log alone.
 *   4. **Subs merge.** `subs` is the base's entries, lifted onto `base`, plus
 *      a built-in `timer` whose `deps` carry `$deadline:exceeded` with the
 *      current `seq`, so a progress bump (seq+1) is new deps — the engine
 *      stops the old timer and starts a fresh one. When `exceeded`, the timer
 *      is off.
 *   5. **Clock out of update.** The countdown is the built-in `timer`; the
 *      clock is read by its runner (`setTimeout`), NEVER in a verb. The slice
 *      carries `seq`, not a deadline timestamp.
 *
 * ## Typical wiring
 *
 *   const guarded = withDeadline({ machine: baseMachine, interpret }, {
 *     ms: 900_000, // auto-fail after 15 minutes of inactivity
 *     progress: (msg) => msg.type !== "heartbeat", // heartbeats don't re-arm
 *   });
 *   const runtime = run(guarded.machine, { ...guarded, ctx: baseCtx });
 *
 * The wrapper adds no Sub type of its own, so it needs no runner: a base's
 * `subscribe` passes through, and a `subscribe.timer` there (a test clock)
 * drives the deadline too.
 */

import {
  applyCell,
  Cmd,
  type CmdOf,
  type DepKeyedSub,
  type Interpret,
  type Machine,
  msgKeysOf,
  type Reducer,
  type Sub,
  type TimerSub,
  type Wired,
} from "../../../index";
import { subEntriesOf } from "../../../pure/core";
import { unchecked, undefinedOnly } from "../../schema";

// ===========================================================================
// The slice + the Msg + the Cmds — the deadline vocabulary.
// ===========================================================================

/**
 * The wrapper's Model slice. `phase` is the lifecycle (`armed` while the
 * countdown runs, `exceeded` once the deadline fired); `seq` is the monotonic
 * re-arm counter the timer's `deps` carry, so each accepted progress Msg
 * restarts the timer.
 *
 * PURE and SERIALIZABLE: there is deliberately NO absolute timestamp here. A
 * deadline timestamp would force the merged `update` to read the wall clock to
 * compute it, which the conformance gate (property 2 — two replays under
 * distinct ambient clocks) is built to catch. Instead, the timer arms a fresh
 * full `ms` countdown per generation; no remaining-delay computation and no
 * clock read occur in the slice or `update` — the only clock is `setTimeout`
 * inside the timer runner.
 */
export interface DeadlineSlice {
  /** `armed` while the countdown is live; `exceeded` once the deadline fired. */
  readonly phase: "armed" | "exceeded";
  /**
   * Monotonic re-arm counter. Starts at 0; each accepted progress Msg (while
   * armed) bumps it by one. It rides in the timer's `deps`, so a bump restarts
   * the timer with a fresh `ms` countdown.
   */
  readonly seq: number;
}

/**
 * The composed Model. The base machine's state is nested under `base`; the
 * wrapper's state lives in the NAMED `$deadline` slice — never hidden in a
 * closure. Both fields are plain data, so the whole composed Model round-trips
 * through `JSON.parse(JSON.stringify(...))` iff the base state does.
 */
export interface DeadlineModel<S> {
  readonly base: S;
  readonly $deadline: DeadlineSlice;
}

/**
 * The Msg the timer dispatches when `config.ms` elapses with no accepted
 * progress. `seq` echoes the re-arm generation the timer was armed against, so a
 * stale timer's Msg (one already restarted away) is identifiable; the merged
 * `update` only honors it when it matches the current slice `seq`.
 */
export interface DeadlineExceededMsg {
  readonly type: "$deadline:exceeded";
  /** The re-arm generation this timer was armed against. */
  readonly seq: number;
}

/**
 * Construct the deadline-exceeded Msg. Exported so the timer's `deps` and tests
 * share one constructor rather than two literals that can drift.
 */
export function deadlineExceededMsg(seq: number): DeadlineExceededMsg {
  return { type: "$deadline:exceeded", seq };
}

/**
 * The fire-and-forget decision Cmd the merged `update` appends on every
 * transition, so the wrapper's choice is visible in the replayed Cmd log
 * (rule 3) — `rearm` when an accepted progress Msg bumped `seq`, `expire` when
 * the deadline-exceeded Msg flipped the phase, `idle` otherwise (a non-progress
 * Msg, or a Msg after the machine already auto-failed). Plain data; its
 * interpret handler is a no-op (the decision is the Cmd's presence in the log,
 * not a side effect).
 */
export const deadlineDecision = Cmd.define("$deadline:decision", {
  input: unchecked<{
    readonly decision: "rearm" | "expire" | "idle";
    /** The slice `seq` AFTER this transition (the re-arm generation now armed). */
    readonly seq: number;
  }>(),
  ok: undefinedOnly,
  err: [],
});
export type DeadlineDecisionCmd = CmdOf<typeof deadlineDecision>;

/**
 * A predicate over a Msg that decides whether it re-arms the deadline.
 *
 * The argument is `Readonly<M>` and the result is `boolean`: this is the
 * STRONGEST purity TS can express here. `Readonly<M>` removes the most common
 * impurity at compile time — the predicate cannot reassign the Msg's own
 * fields — and `boolean` pins the return so a side-effecting `(msg) => { … }`
 * with an implicit `undefined`/`void` return is rejected.
 *
 * What the type system CANNOT encode (TS has no effect tracking): observational
 * purity. A body that reads `Date.now()`, calls `Math.random()`, performs IO,
 * or closes over and mutates external state still type-checks. Those remain a
 * CONVENTION enforced by review, not the compiler — the predicate runs inside
 * the pure merged `update` (invariant 2), so it must be a pure function of the
 * Msg alone: no clock, no RNG, no IO, no captured mutable state.
 */
export type ProgressPredicate<M extends { type: string }> = (
  msg: Readonly<M>,
) => boolean;

/**
 * The deadline knob. `ms` is the inactivity window; `progress` is an OPTIONAL
 * predicate picking which base Msgs count as activity (default: EVERY base Msg
 * re-arms). The predicate runs INSIDE the pure merged `update`, so it must be a
 * pure function of the Msg — see {@link ProgressPredicate} for what the type
 * enforces vs. what stays a convention.
 */
export interface DeadlineConfig<M extends { type: string }> {
  /** The inactivity window in milliseconds. Auto-fail after `ms` with no progress. */
  readonly ms: number;
  /**
   * Predicate picking which base Msgs re-arm the timer. Default: every base Msg
   * counts as progress. Pure — a function of the Msg alone (see
   * {@link ProgressPredicate}).
   */
  readonly progress?: ProgressPredicate<M>;
}

// ===========================================================================
// withDeadline — the wrapper.
// ===========================================================================

/**
 * Wrap `base` with an inactivity deadline. Takes the base machine together with
 * the handlers it runs under (a machine carries none — #278) and returns a NEW
 * `Wired` over the composed Model `{ base, $deadline }`, with the base's
 * Msgs/Cmds extended by the wrapper's own (`$deadline:exceeded` Msg,
 * `$deadline:decision` Cmd) and a built-in `timer` beside the base's Subs. Run
 * it as `run(wrapped.machine, { ...wrapped, ctx })`.
 *
 * The composed machine:
 *   - `init` rehydrates the base (honoring the `[loaded, []]` contract) and
 *     seeds `$deadline: { phase: "armed", seq: 0 }`. Base init Cmds pass
 *     through unchanged.
 *   - `update` (Reducer form) runs the base reducer for base Msgs — base Cmds
 *     pass through UNCHANGED — and on an accepted progress Msg bumps `seq`
 *     (re-arm). The `$deadline:exceeded` Msg cell flips `phase` to `exceeded`.
 *     Every transition appends a `$deadline:decision` marker Cmd.
 *   - `subs` is the base's entries, read off `state.base`, plus a `timer` that
 *     dispatches `$deadline:exceeded` for the current `seq` while
 *     `phase === "armed"`.
 *   - `subscribe` is the base's, unchanged — the timer is built in.
 *   - `interpret` is the base's, plus a no-op `$deadline:decision` handler.
 *
 * @param wired  any `Machine<S, M, C, U, Ctx>` as `machine`, beside its
 *               `interpret` and `subscribe` handlers.
 * @param config the deadline knob (`ms` window + optional `progress` predicate).
 */
export function withDeadline<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  wired: Wired<S, M, C, U, Ctx>,
  config: DeadlineConfig<M>,
): Wired<
  DeadlineModel<S>,
  M | DeadlineExceededMsg,
  C | DeadlineDecisionCmd,
  U,
  Ctx
> {
  const base = wired.machine;
  const windowMs = config.ms;
  const isProgress = config.progress;

  // The merged update is a flat Reducer over the composed Model. The composed
  // Model is NOT discriminated on `.type`, so every (base Msg variant + the
  // wrapper's own `$deadline:exceeded`) gets exactly one cell.
  type Next = readonly [DeadlineModel<S>, readonly (C | DeadlineDecisionCmd)[]];
  const update = {} as Record<
    string,
    (state: DeadlineModel<S>, msg: M | DeadlineExceededMsg) => Next
  >;

  // Namespace guard for the Msg/update surface (mirrors the interpret guard
  // below). The `$deadline:exceeded` cell is assigned into
  // `update` after this loop; if a base Msg.type already lives in the
  // `$deadline:` namespace, that assignment — or this loop — would SILENTLY
  // clobber / be clobbered by a base cell. The `$deadline:` Msg namespace is
  // the wrapper's: refuse to wrap a base that squats on it.
  // Base Msg keys enumerated via `msgKeysOf(base)` — keyed on the
  // authoritative `__form` tag, no structural re-derivation here (#275).
  const baseMsgKeys = msgKeysOf(base);
  for (const key of baseMsgKeys) {
    if (key.startsWith("$deadline:")) {
      throw new Error(
        `withDeadline: the base machine declares a reserved "${key}" update ` +
          'cell — the wrapper owns the "$deadline:" Msg namespace. ' +
          "Rename the base Msg.",
      );
    }
  }

  for (const key of baseMsgKeys) {
    update[key] = (state, msg) => {
      // 1) Run the base reducer — its result passes through UNCHANGED.
      const [nextBase, baseCmds] = applyCell<S, M, C>(
        base,
        state.base,
        msg as M,
      );
      // 2) Re-arm decision: a progress Msg WHILE armed bumps `seq` (new timer
      //    id → fresh countdown). After auto-fail, or for a non-progress Msg,
      //    the slice is unchanged and the decision is `idle`.
      const armed = state.$deadline.phase === "armed";
      const counts =
        armed && (isProgress === undefined || isProgress(msg as M));
      const $deadline: DeadlineSlice = counts
        ? { phase: "armed", seq: state.$deadline.seq + 1 }
        : state.$deadline;
      const next: DeadlineModel<S> = { base: nextBase, $deadline };
      // 3) Append the visible decision marker. Base Cmds come FIRST, unchanged.
      const decision = deadlineDecision({
        decision: counts ? "rearm" : "idle",
        seq: $deadline.seq,
      });
      return [next, [...baseCmds, decision]];
    };
  }

  // The wrapper's own Msg cell. The timer delivers `$deadline:exceeded`
  // carrying the `seq` it was armed against. Honor it ONLY while armed and ONLY
  // when the `seq` matches the current generation — a stale timer's Msg (from a
  // generation already retired by a re-arm, or arriving after auto-fail) is a
  // no-op that still records a visible `idle` decision. The expiry flips `phase`
  // to `exceeded`; the slice transition IS the auto-fail, visible in the log.
  update["$deadline:exceeded"] = (state, msg) => {
    const m = msg as DeadlineExceededMsg;
    const fires =
      state.$deadline.phase === "armed" && m.seq === state.$deadline.seq;
    const $deadline: DeadlineSlice = fires
      ? { phase: "exceeded", seq: state.$deadline.seq }
      : state.$deadline;
    const next: DeadlineModel<S> = { base: state.base, $deadline };
    const decision = deadlineDecision({
      decision: fires ? "expire" : "idle",
      seq: $deadline.seq,
    });
    return [next, [decision]];
  };

  // The base's interpret, extended with the one no-op decision handler. The
  // `$deadline:decision` Cmd has no I/O — its purpose is log visibility (rule 3),
  // so the handler returns void and dispatches nothing. Namespace guard mirrors
  // withTelemetry: refuse to wrap a base that squats on the reserved Cmd key.
  const baseInterpret =
    (wired as { interpret?: Interpret<M, C, Ctx> }).interpret ??
    ({} as Interpret<M, C, Ctx>);
  if (Object.hasOwn(baseInterpret as object, "$deadline:decision")) {
    throw new Error(
      'withDeadline: the base machine declares a reserved "$deadline:decision" ' +
        'interpret handler — the wrapper owns the "$deadline:" Cmd namespace. ' +
        "Rename the base handler.",
    );
  }
  const interpret = {
    ...(baseInterpret as Record<string, unknown>),
    "$deadline:decision": async (): Promise<void> => {},
  } as Interpret<M | DeadlineExceededMsg, C | DeadlineDecisionCmd, Ctx>;

  // Subs: the base's entries, each reading its slice off `state.base`, plus the
  // countdown while armed. The timer's `deps` carry the Msg for the current
  // `seq`, so each progress bump is new deps and the engine restarts the timer
  // with a fresh `ms` countdown; the dispatched Msg names the generation it was
  // armed against so the merged update can reject a stale one. When exceeded,
  // the timer is off (the machine has auto-failed).
  const baseSubs = subEntriesOf<S>(base).map((entry) => ({
    type: entry.type,
    deps: (state: DeadlineModel<S>) => entry.deps(state.base),
  }));
  const timeout: DepKeyedSub<
    DeadlineModel<S>,
    TimerSub<M | DeadlineExceededMsg>
  > = {
    type: "timer",
    deps: (state) =>
      state.$deadline.phase === "armed"
        ? { ms: windowMs, msg: deadlineExceededMsg(state.$deadline.seq) }
        : null,
  };
  const subs = [...baseSubs, timeout];

  const machine = {
    init: (loaded: DeadlineModel<S> | null, ctx: Ctx) => {
      // Rehydrate path: `loaded !== null` MUST return `[loaded, []]` (no Cmds) —
      // the substrate's replay enforces this. We split the composed loaded Model
      // into its base slice and feed the base its own loaded snapshot.
      if (loaded !== null) {
        return [loaded, []];
      }
      const [base0, cmds] = base.init(null, ctx);
      const model: DeadlineModel<S> = {
        base: base0,
        $deadline: { phase: "armed", seq: 0 },
      };
      // Base init Cmds pass through unchanged; no deadline Cmd on boot (boot is
      // not a base Msg transition, so it does not re-arm).
      return [model, cmds];
    },
    update: update as unknown as Reducer<
      DeadlineModel<S>,
      M | DeadlineExceededMsg,
      C | DeadlineDecisionCmd
    >,
    subs,
    // The base's `Cmd.define` list rides through so `run`'s interpret edge
    // still parses / stamps the base's settled Msgs behind the wrap (#66).
    ...(base.cmds ? { cmds: base.cmds } : {}),
  } as Machine<
    DeadlineModel<S>,
    M | DeadlineExceededMsg,
    C | DeadlineDecisionCmd,
    U,
    Ctx
  >;
  // The base's runners pass through: the wrapper's only Sub is the built-in
  // `timer`, so it brings no runner of its own. The cast re-reads the base's
  // `SubscribeArg` (conditional on `U`, unchanged) under the widened Msg.
  return { ...wired, machine, interpret } as unknown as Wired<
    DeadlineModel<S>,
    M | DeadlineExceededMsg,
    C | DeadlineDecisionCmd,
    U,
    Ctx
  >;
}
