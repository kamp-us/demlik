/**
 * @demlik/tea/with-deadline — auto-fail a wrapped machine at T+N, re-arm on
 * progress. A **pure function over machine data**: `withDeadline(base, config)`
 * takes any `Machine<S, M, C, U, Ctx>` and returns a NEW `Machine` over the
 * composed Model `{ base, $deadline }`. You `run()` / `replay()` the result
 * exactly like any other machine — there is no new runtime, no privileged
 * interception path.
 *
 * ## What it does
 *
 * The wrapper watches the base Msg stream. While the deadline is `armed`, a
 * RELATIVE timeout Sub counts down `config.ms`. Every base Msg the
 * `config.progress` predicate accepts (default: every base Msg) is treated as
 * activity: the wrapper bumps a numeric `seq`, which CHANGES the timer Sub's id,
 * so the substrate's reconcile pass retires the old countdown and starts a fresh
 * one — "re-arm on progress". If `config.ms` elapses with NO accepted progress,
 * the timeout Sub dispatches `$deadline:exceeded`; the merged `update` folds it
 * by flipping `phase` to `exceeded`, and from then on `subscriptions` returns no
 * timer (the machine has auto-failed). The expiry is a slice transition visible
 * in the Msg log — the auto-fail is never an off-ledger side effect.
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
 *   4. **Subs merge by id.** `subscriptions = [...base, ...deadlineSubs]`; the
 *      timeout id is `$deadline:timeout:{seq}`, so a progress bump (seq+1)
 *      yields a NEW id — the substrate retires the old timer and arms a fresh
 *      one. When `exceeded`, no deadline sub is returned.
 *   5. **Clock out of update.** The countdown is a relative-timeout Sub; the
 *      clock is read at subscribe time inside the Sub (`setTimeout`), NEVER in a
 *      verb. The slice carries `seq`, not a deadline timestamp.
 *
 * ## Typical wiring
 *
 *   const guarded = withDeadline(baseMachine, {
 *     ms: 900_000, // auto-fail after 15 minutes of inactivity
 *     progress: (msg) => msg.type !== "heartbeat", // heartbeats don't re-arm
 *   });
 *   const runtime = run(guarded, { ctx: baseCtx });
 */

import {
  type Cmd,
  formOf,
  type Interpret,
  type Machine,
  type Reducer,
  type Sub,
  type Subscribe,
  subId,
  type UpdateForm,
} from "../index";
import { fromTimeout } from "../subs/from-timeout";

// ===========================================================================
// The slice + the Sub + the Msg + the Cmds — the deadline vocabulary.
// ===========================================================================

/**
 * The wrapper's Model slice. `phase` is the lifecycle (`armed` while the
 * countdown runs, `exceeded` once the deadline fired); `seq` is the monotonic
 * re-arm counter that keys the timer Sub's id so each accepted progress Msg
 * retires the old timer and starts a fresh one.
 *
 * PURE and SERIALIZABLE: there is deliberately NO absolute timestamp here. A
 * deadline timestamp would force the merged `update` to read the wall clock to
 * compute it, which the conformance gate (property 2 — two replays under
 * distinct ambient clocks) is built to catch. Instead, the timer arms a fresh
 * full `ms` countdown per generation; no remaining-delay computation and no
 * clock read occur in the slice or `update` — the only clock is `setTimeout`
 * inside the Sub.
 */
export interface DeadlineSlice {
  /** `armed` while the countdown is live; `exceeded` once the deadline fired. */
  readonly phase: "armed" | "exceeded";
  /**
   * Monotonic re-arm counter. Starts at 0; each accepted progress Msg (while
   * armed) bumps it by one. Folds into the timer Sub's id, so a bump = a new id
   * = the substrate retires the old timer and arms a fresh `ms` countdown.
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
 * The relative-timeout Sub the wrapper arms while `phase === "armed"`. `delayMs`
 * is the window `config.ms`; the id is `$deadline:timeout:{seq}`, so each
 * progress bump produces a distinct id and the reconcile pass churns the timer.
 * Same `delayMs`-on-the-Sub shape `fromTimeout` consumes.
 */
export type DeadlineTimeoutSub = Sub<"$deadline:timeout"> & {
  readonly delayMs: number;
};

/**
 * The Msg the timeout Sub dispatches when `config.ms` elapses with no accepted
 * progress. `seq` echoes the re-arm generation the timer was armed against, so a
 * stale timer's Msg (one whose id was already retired) is identifiable; the
 * merged `update` only honors it when it matches the current slice `seq`.
 */
export interface DeadlineExceededMsg {
  readonly type: "$deadline:exceeded";
  /** The re-arm generation this timer was armed against. */
  readonly seq: number;
}

/**
 * Construct the deadline-exceeded Msg. Exported so the subscribe cell and tests
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
export type DeadlineDecisionCmd = Cmd<"$deadline:decision"> & {
  readonly decision: "rearm" | "expire" | "idle";
  /** The slice `seq` AFTER this transition (the re-arm generation now armed). */
  readonly seq: number;
};

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
// update-form dispatch — run the base reducer regardless of its shape.
// ===========================================================================

// The base `update` is either a Reducer (flat record keyed by Msg.type) or a
// Transitions table (keyed by state.type then Msg.type). The merged machine is
// always a Reducer over the NON-discriminated `DeadlineModel<S>`, so the merged
// reducer must invoke the base's update through whichever shape it has. Mirrors
// `withTelemetry`'s inline form-branching (kept standalone, not pre-abstracted).
type BaseCellFn<S, M, C extends Cmd> = (
  state: S,
  msg: M,
) => readonly [S, readonly C[]];

/**
 * Invoke the base machine's `update` for `msg` against base `state`, returning
 * the base's `[nextBase, baseCmds]` UNCHANGED. Pure — it only routes to the
 * base cell; it never reads the clock, allocates an Error, or mutates state.
 */
function runBaseUpdate<S, M extends { type: string }, C extends Cmd>(
  // Typed `object` (not `Machine[...]["update"]`) because the field is inspected
  // structurally and re-cast; the precise union (Reducer | Transitions)
  // collapses under the substrate's conditional `update` type.
  update: object,
  // The base's update form, read once via `formOf(base)` — no local heuristic.
  form: UpdateForm,
  state: S,
  msg: M,
): readonly [S, readonly C[]] {
  if (form === "reducer") {
    // Reducer form: `update[msg.type](state, msg)`.
    const record = update as unknown as Record<string, BaseCellFn<S, M, C>>;
    // biome-ignore lint/style/noNonNullAssertion: the base machine's Reducer guarantees a cell for every dispatched Msg.type; `!` required under noUncheckedIndexedAccess and cannot miss for a Msg the base accepts
    return record[msg.type]!(state, msg);
  }
  // Transitions form: `update[state.type][msg.type](state, msg)`.
  const table = update as unknown as Record<
    string,
    Record<string, BaseCellFn<S, M, C>>
  >;
  const stateKey = (state as unknown as { type: string }).type;
  // biome-ignore lint/style/noNonNullAssertion: the base machine's Transitions table guarantees every (state.type × msg.type) cell exists; `!` required under noUncheckedIndexedAccess and cannot miss at runtime
  return table[stateKey]![msg.type]!(state, msg);
}

// Recover the base Msg.type set from either update form. A Reducer's own keys
// ARE the Msg.type set. A Transitions table's keys are state.type; its INNER
// keys are the Msg.type set (uniform across phases), so we read the first
// phase's inner keys. An empty update (`M` is `never`) yields `[]`.
function deadlineMsgKeys(update: object, form: UpdateForm): readonly string[] {
  const keys = Object.keys(update);
  const firstKey = keys[0];
  if (firstKey === undefined) return [];
  if (form === "reducer") return keys;
  const firstValue = (update as Record<string, unknown>)[firstKey];
  return Object.keys(firstValue as object);
}

// ===========================================================================
// withDeadline — the wrapper.
// ===========================================================================

/**
 * Wrap `base` with an inactivity deadline. Returns a NEW `Machine` over the
 * composed Model `{ base, $deadline }`, with the base's Msgs/Cmds/Subs extended
 * by the wrapper's own (`$deadline:exceeded` Msg, `$deadline:decision` Cmd,
 * `$deadline:timeout` Sub).
 *
 * The composed machine:
 *   - `init` rehydrates the base (honoring the `[loaded, []]` contract) and
 *     seeds `$deadline: { phase: "armed", seq: 0 }`. Base init Cmds pass
 *     through unchanged.
 *   - `update` (Reducer form) runs the base reducer for base Msgs — base Cmds
 *     pass through UNCHANGED — and on an accepted progress Msg bumps `seq`
 *     (re-arm). The `$deadline:exceeded` Msg cell flips `phase` to `exceeded`.
 *     Every transition appends a `$deadline:decision` marker Cmd.
 *   - `subscriptions` is the base's, plus a `$deadline:timeout` Sub keyed on
 *     `seq` while `phase === "armed"`.
 *   - `subscribe` is the base's, plus the `$deadline:timeout` cell.
 *   - `interpret` is the base's, plus a no-op `$deadline:decision` handler.
 *
 * @param base   any `Machine<S, M, C, U, Ctx>`.
 * @param config the deadline knob (`ms` window + optional `progress` predicate).
 */
export function withDeadline<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  base: Machine<S, M, C, U, Ctx>,
  config: DeadlineConfig<M>,
): Machine<
  DeadlineModel<S>,
  M | DeadlineExceededMsg,
  C | DeadlineDecisionCmd,
  U | DeadlineTimeoutSub,
  Ctx
> {
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

  // Namespace guard for the Msg/update surface (mirrors the interpret +
  // subscribe guards below). The `$deadline:exceeded` cell is assigned into
  // `update` after this loop; if a base Msg.type already lives in the
  // `$deadline:` namespace, that assignment — or this loop — would SILENTLY
  // clobber / be clobbered by a base cell. The `$deadline:` Msg namespace is
  // the wrapper's: refuse to wrap a base that squats on it.
  // The base's update form, read ONCE from the `__form` tag (see `formOf`) and
  // threaded into the per-form helpers — no structural re-derivation here.
  const baseForm = formOf(base);
  const baseMsgKeys = deadlineMsgKeys(base.update, baseForm);
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
      const [nextBase, baseCmds] = runBaseUpdate<S, M, C>(
        base.update,
        baseForm,
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
      const decision: DeadlineDecisionCmd = {
        type: "$deadline:decision",
        decision: counts ? "rearm" : "idle",
        seq: $deadline.seq,
      };
      return [next, [...baseCmds, decision]];
    };
  }

  // The wrapper's own Msg cell. The timeout Sub delivers `$deadline:exceeded`
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
    const decision: DeadlineDecisionCmd = {
      type: "$deadline:decision",
      decision: fires ? "expire" : "idle",
      seq: $deadline.seq,
    };
    return [next, [decision]];
  };

  // The base's interpret, extended with the one no-op decision handler. The
  // `$deadline:decision` Cmd has no I/O — its purpose is log visibility (rule 3),
  // so the handler returns void and dispatches nothing. Namespace guard mirrors
  // withTelemetry: refuse to wrap a base that squats on the reserved Cmd key.
  const baseInterpret =
    (base as { interpret?: Interpret<M, C, Ctx> }).interpret ??
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

  // Subs merge by id: the base's, plus the deadline countdown while armed. The
  // timeout id folds in `seq`, so each progress bump yields a NEW id and the
  // reconcile pass retires the old timer + arms a fresh `ms` countdown. When
  // exceeded, no deadline sub is returned (the machine has auto-failed).
  const baseSubscriptions = base.subscriptions;
  const subscriptions = (
    state: DeadlineModel<S>,
  ): readonly (U | DeadlineTimeoutSub)[] => {
    const baseSubs = baseSubscriptions ? baseSubscriptions(state.base) : [];
    if (state.$deadline.phase !== "armed") return baseSubs;
    const timeout: DeadlineTimeoutSub = {
      id: subId(`$deadline:timeout:${state.$deadline.seq}`),
      type: "$deadline:timeout",
      delayMs: windowMs,
    };
    return [...baseSubs, timeout];
  };

  // The base's subscribe cells, plus the timeout cell. The clock is read here —
  // at subscribe time, inside the Sub's `setTimeout` — NEVER in a verb. The
  // dispatched Msg carries the `seq` the timer was armed against so the merged
  // update can reject a stale generation.
  const baseSubscribe =
    (base as { subscribe?: Subscribe<M, U, Ctx> }).subscribe ??
    ({} as Subscribe<M, U, Ctx>);
  if (Object.hasOwn(baseSubscribe as object, "$deadline:timeout")) {
    throw new Error(
      'withDeadline: the base machine declares a reserved "$deadline:timeout" ' +
        'subscribe handler — the wrapper owns the "$deadline:" Sub namespace. ' +
        "Rename the base handler.",
    );
  }
  const timeoutCell = fromTimeout<DeadlineTimeoutSub, DeadlineExceededMsg>(
    (sub) => {
      // The sub id is `$deadline:timeout:{seq}`; recover the generation it was
      // armed against so a stale timer's Msg is identifiable in the reducer.
      const seq = Number(sub.id.slice(sub.id.lastIndexOf(":") + 1));
      return deadlineExceededMsg(seq);
    },
  );
  const subscribe = {
    ...(baseSubscribe as Record<string, unknown>),
    "$deadline:timeout": timeoutCell,
  } as Subscribe<M | DeadlineExceededMsg, U | DeadlineTimeoutSub, Ctx>;

  return {
    init: (loaded, ctx) => {
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
    subscriptions,
    subscribe,
    interpret,
  } as Machine<
    DeadlineModel<S>,
    M | DeadlineExceededMsg,
    C | DeadlineDecisionCmd,
    U | DeadlineTimeoutSub,
    Ctx
  >;
}
