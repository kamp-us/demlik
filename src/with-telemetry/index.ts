/**
 * @demlik/tea/with-telemetry — the pattern-setting wrapper of the wrapper tier.
 *
 * `withTelemetry(base, config)` is a **pure function over machine data**: it
 * takes any `Machine<S, M, C, U, Ctx>` and returns a NEW `Machine` over the
 * composed Model `{ base, $telemetry }`. You `run()` / `replay()` the result
 * exactly like any other machine — there is no new runtime, no privileged
 * interception path.
 *
 * This is the SAFEST wrapper and the one every future wrapper (`withDeadline`,
 * `withResilience`) copies: it is **OBSERVE-ONLY**. It observes every base Msg
 * + transition, increments a monotonic counter, and emits a fire-and-forget
 * telemetry Cmd whose interpret handler hands the event to a sink Port. It must
 * NOT transform base Cmds or gate base Msgs — base behavior is byte-identical
 * with or without it. The moment a telemetry wrapper alters the Msg/Cmd stream
 * instead of observing it, it has become saga middleware (the betrayal the
 * research warned of).
 *
 * ## The 5 rules it satisfies (from the wrapper-tier contract)
 *
 *   1. **Named, serializable slice.** Wrapper state lives at `model.$telemetry`,
 *      a plain `{ seq: number }` — JSON-serializable, never a closure.
 *   2. **Retag-and-re-emit, never swallow.** The merged `update` runs the base
 *      reducer, passes its Cmds through UNCHANGED, and APPENDS its own
 *      `$telemetry:emit` Cmd. No base Cmd ever vanishes; nothing is gated.
 *   3. **Every decision is a Msg/Cmd.** Each telemetry emission is a
 *      `$telemetry:emit` Cmd through the merged `update`, so "why did this fire"
 *      is answerable from reducer + log alone, and `runtime.observe` sees it.
 *   4. **Subs merge by id.** Telemetry has no timers — merged subs/subscribe are
 *      the base's, verbatim.
 *   5. **Clock out of update.** The default event carries no wall-clock read.
 *      The optional `at` is stamped at the interpret boundary (the `clock`
 *      port), never inside the merged `update`.
 *
 * ## Where the clock lives
 *
 * Inside the merged `update`: nowhere. The reducer is pure — it reads `seq` from
 * the slice and projects the event from `(msg, prev, next)`. The ONLY clock read
 * is at the interpret boundary: the `$telemetry:emit` handler stamps `event.at`
 * from the injected `clock` port (if supplied and the projector left `at`
 * unset), exactly as `resilient-call` reads `Date.now()` only inside `handlers`.
 *
 * ## Typical wiring
 *
 *   const observed = withTelemetry(baseMachine, {
 *     event: (msg, _prev, next) => ({ seq: next.$telemetry.seq, msgType: msg.type }),
 *   });
 *   const runtime = run(observed, {
 *     ctx: { ...baseCtx, telemetrySink: (e) => posthog.capture(e), clock: Date.now },
 *   });
 */

import type { Cmd, Interpret, Machine, Reducer, Sub } from "../index";

// ===========================================================================
// The event + the slice + the ports — the telemetry vocabulary.
// ===========================================================================

/**
 * The datum handed to the sink. The default projector emits `{ seq, msgType }`;
 * a custom `event` projector may return any extra fields. `at` is OPTIONAL and
 * plain data — it is stamped at the interpret boundary by the `clock` port, not
 * inside the (pure, clock-free) merged `update`. Every field is JSON-round-trip
 * serializable so a recorded telemetry stream stays durable.
 */
export interface TelemetryEvent {
  /** Monotonic event counter — equals `$telemetry.seq` after the transition. */
  readonly seq: number;
  /** The `Msg.type` discriminant that drove this transition. */
  readonly msgType: string;
  /**
   * Wall-clock instant the event was emitted, ms since epoch. Absent until the
   * interpret boundary stamps it (the `clock` port). Optional because the
   * merged `update` is clock-free — a verb must never read `Date.now()`.
   */
  readonly at?: number;
}

/**
 * The wrapper's Model slice. A monotonic event counter — minimal but real, so
 * the named-slice mechanism is exercised for the richer-slice wrappers that
 * follow. `seq` equals the number of base Msgs folded so far: after replaying
 * `N` msgs, `$telemetry.seq === N`. Plain data → serializes into a `Store<S>`.
 */
export interface TelemetrySlice {
  readonly seq: number;
}

/**
 * The composed Model. The base machine's state is nested under `base`; the
 * wrapper's state lives in the NAMED `$telemetry` slice — never hidden in a
 * closure. Both fields are plain data, so the whole composed Model round-trips
 * through `JSON.parse(JSON.stringify(...))` iff the base state does.
 */
export interface TelemetryModel<S> {
  readonly base: S;
  readonly $telemetry: TelemetrySlice;
}

/**
 * The fire-and-forget Cmd the merged `update` appends after every base
 * transition. It carries the projected `event` as plain data (invariant 3 —
 * no closure). The interpret handler hands `event` to the sink and dispatches
 * NOTHING back, so there is no feedback loop.
 */
export type TelemetryEmitCmd = Cmd<"$telemetry:emit"> & {
  readonly event: TelemetryEvent;
};

/**
 * The side-effecting ports the wrapper adds to `Ctx`. The sink (PostHog / Sentry
 * bridge) lives at the interpret boundary, never in a verb. `clock` is the
 * optional wall-clock source used to stamp `event.at` at that same boundary —
 * pass `Date.now` in production, a fixed `() => 1000` in tests; omit it to leave
 * `at` unset.
 */
export interface TelemetryPorts {
  /** The side-effecting sink. Fire-and-forget — its result is never awaited into a Msg. */
  readonly telemetrySink: (event: TelemetryEvent) => void | Promise<void>;
  /** Optional clock for stamping `event.at` at the interpret boundary. */
  readonly clock?: () => number;
}

/**
 * The telemetry knob. `event` is an OPTIONAL projector mapping
 * `(msg, prev, next)` to a `TelemetryEvent`; omit it and the default emits
 * `{ seq, msgType }` where `seq` is the post-transition counter. The projector
 * runs INSIDE the pure merged `update`, so it must not read the clock — stamp
 * `at` at the sink boundary via the `clock` port instead.
 */
export interface TelemetryConfig<S, M extends { type: string }> {
  readonly event?: (
    msg: M,
    prev: TelemetryModel<S>,
    next: TelemetryModel<S>,
  ) => TelemetryEvent;
}

// ===========================================================================
// update-form dispatch — run the base reducer regardless of its shape.
// ===========================================================================

// The base `update` is either a Reducer (flat record keyed by Msg.type) or a
// Transitions table (keyed by state.type then Msg.type). The merged machine is
// always a Reducer over the NON-discriminated `TelemetryModel<S>`, so the merged
// reducer must invoke the base's update through whichever shape it has. This
// mirrors the form-branching `run` and `replay` do internally; we keep it inline
// (not factored into a shared helper) so the wrapper stays standalone.
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
  // structurally and re-cast below; the precise union (Reducer | Transitions)
  // collapses under the substrate's conditional `update` type, so the wrapper
  // accepts the erased shape and dispatches on the runtime form.
  update: object,
  state: S,
  msg: M,
): readonly [S, readonly C[]] {
  const firstKey = Object.keys(update)[0];
  const firstValue =
    firstKey === undefined
      ? undefined
      : (update as Record<string, unknown>)[firstKey];
  if (firstKey === undefined || typeof firstValue === "function") {
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

// ===========================================================================
// withTelemetry — the wrapper.
// ===========================================================================

/**
 * Wrap `base` with observe-only telemetry. Returns a NEW `Machine` over the
 * composed Model `{ base, $telemetry }`, with the base's Msgs/Cmds/Subs/Ctx
 * extended by the wrapper's own.
 *
 * The composed machine:
 *   - `init` rehydrates the base (honoring the `[loaded, []]` contract) and
 *     seeds `$telemetry: { seq: 0 }`. Base init Cmds pass through unchanged.
 *   - `update` (Reducer form, keyed by every base `Msg.type`) runs the base
 *     reducer, increments `seq`, and appends a `$telemetry:emit` Cmd carrying
 *     the projected event. Base Cmds pass through UNCHANGED — the observe-only
 *     property.
 *   - `subscriptions` / `subscribe` are the base's, verbatim (no timers).
 *   - `interpret` is `{ ...base.interpret, "$telemetry:emit": sink-handler }`.
 *
 * @param base   any `Machine<S, M, C, U, Ctx>`.
 * @param config the telemetry knob (optional `event` projector).
 */
export function withTelemetry<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  base: Machine<S, M, C, U, Ctx>,
  config: TelemetryConfig<S, M> = {},
): Machine<
  TelemetryModel<S>,
  M,
  C | TelemetryEmitCmd,
  U,
  Ctx & TelemetryPorts
> {
  const project = config.event;

  // The merged update is a flat Reducer over the composed Model. The composed
  // Model is NOT discriminated on `.type`, so the Transitions form is never an
  // option here — every base Msg variant gets exactly one cell. We build the
  // record by enumerating the base update's Msg keys: a Reducer's keys ARE the
  // Msg.type set; a Transitions table's inner keys are too (uniform across
  // phases), so we read the first phase's keys to recover them.
  const msgKeys = telemetryMsgKeys(base.update);

  const update = {} as Record<
    string,
    (
      state: TelemetryModel<S>,
      msg: M,
    ) => readonly [TelemetryModel<S>, readonly (C | TelemetryEmitCmd)[]]
  >;
  for (const key of msgKeys) {
    update[key] = (state, msg) => {
      // 1) Run the base reducer — its result passes through UNCHANGED.
      const [nextBase, baseCmds] = runBaseUpdate<S, M, C>(
        base.update,
        state.base,
        msg,
      );
      // 2) Advance the wrapper slice (monotonic counter). New object — no mutation.
      const $telemetry: TelemetrySlice = { seq: state.$telemetry.seq + 1 };
      const next: TelemetryModel<S> = { base: nextBase, $telemetry };
      // 3) Project the event (pure — no clock). Default: { seq, msgType }.
      const event: TelemetryEvent = project
        ? project(msg, state, next)
        : { seq: $telemetry.seq, msgType: msg.type };
      // 4) Append the fire-and-forget emit Cmd. Base Cmds come FIRST, unchanged.
      const emit: TelemetryEmitCmd = { type: "$telemetry:emit", event };
      return [next, [...baseCmds, emit]];
    };
  }

  // The base's interpret, extended with the one telemetry handler. The sink is
  // the ONLY side effect, and it lives here at the interpret boundary — never in
  // a verb. `clock` (if provided) stamps `event.at` here too, the one permitted
  // clock read. The handler returns void synchronously — it dispatches NOTHING
  // back (no feedback loop) AND it does NOT await the sink (no backpressure /
  // crash from a slow or failing sink). See the fire-and-forget note below.
  const baseInterpret =
    (base as { interpret?: Interpret<M, C, Ctx> }).interpret ??
    ({} as Interpret<M, C, Ctx>);
  // Namespace guard (mirrors the substrate's SubId / definePort collision
  // asserts). The spread below merges `$telemetry:emit` into the base's
  // interpret map; if the base already declares that key, the spread would
  // SILENTLY clobber the base handler. The `$telemetry:` Cmd namespace is the
  // wrapper's — refuse to wrap a base that squats on it instead of stealing it.
  if (Object.hasOwn(baseInterpret as object, "$telemetry:emit")) {
    throw new Error(
      'withTelemetry: the base machine declares a reserved "$telemetry:emit" ' +
        'interpret handler — the wrapper owns the "$telemetry:" Cmd namespace. ' +
        "Rename the base handler.",
    );
  }
  const interpret = {
    ...(baseInterpret as Record<string, unknown>),
    // OBSERVE-ONLY at the boundary: the sink is fire-and-forget. The runtime
    // `await`s every interpret handler in its dispatch loop, so awaiting the
    // sink here would let a SLOW sink backpressure the wrapped machine (its
    // next dispatch waits) and a FAILING sink crash dispatch (the throw would
    // propagate out of the transition). Both violate the contract: telemetry
    // must never affect base behavior OR latency. So we DO NOT await — we hand
    // the event to the sink, normalize its result to a Promise, swallow any
    // rejection/throw, and return immediately. The handler resolves in the same
    // microtask the dispatch loop reaches it; the machine never waits on the
    // sink, and a rejected sink can never become an unhandled rejection.
    "$telemetry:emit": (
      cmd: TelemetryEmitCmd,
      ctx: Ctx & TelemetryPorts,
    ): void => {
      const event =
        cmd.event.at === undefined && ctx.clock !== undefined
          ? { ...cmd.event, at: ctx.clock() }
          : cmd.event;
      // `Promise.resolve(fn())` covers BOTH failure shapes: a sync `throw` is
      // caught by `Promise.resolve` (the call is the argument, so a throw here
      // would escape — guard it), and an async rejection is caught by `.catch`.
      try {
        Promise.resolve(ctx.telemetrySink(event)).catch(() => {});
      } catch {
        // A sink that throws SYNCHRONOUSLY (before returning a Promise) is
        // swallowed here. Either way the slow/failing sink never reaches the
        // dispatch loop's `await`.
      }
    },
  } as Interpret<M, C | TelemetryEmitCmd, Ctx & TelemetryPorts>;

  // Capture once so the narrowing survives into the spread (no non-null assert).
  const baseSubscriptions = base.subscriptions;
  const baseSubscribe = (base as { subscribe?: unknown }).subscribe;

  return {
    init: (loaded, ctx) => {
      // Rehydrate path: `loaded !== null` MUST return `[loaded, []]` (no Cmds) —
      // the substrate's replay enforces this. We split the composed loaded Model
      // into its base slice and feed the base its own loaded snapshot, so the
      // base's rehydrate contract is honored transitively.
      if (loaded !== null) {
        return [loaded, []];
      }
      const [base0, cmds] = base.init(null, ctx);
      const model: TelemetryModel<S> = { base: base0, $telemetry: { seq: 0 } };
      // Base init Cmds pass through unchanged; no telemetry Cmd on boot (boot is
      // not a base Msg transition, so it does not advance `seq`).
      return [model, cmds];
    },
    update: update as unknown as Reducer<
      TelemetryModel<S>,
      M,
      C | TelemetryEmitCmd
    >,
    // Subs merge to the base's, verbatim — telemetry owns no timers. The base
    // subscribes against its own nested slice.
    ...(baseSubscriptions
      ? {
          subscriptions: (state: TelemetryModel<S>) =>
            baseSubscriptions(state.base),
        }
      : {}),
    ...(baseSubscribe ? { subscribe: baseSubscribe } : {}),
    interpret,
  } as Machine<
    TelemetryModel<S>,
    M,
    C | TelemetryEmitCmd,
    U,
    Ctx & TelemetryPorts
  >;
}

// Recover the base Msg.type set from either update form. A Reducer's own keys
// ARE the Msg.type set. A Transitions table's keys are state.type; its INNER
// keys are the Msg.type set (uniform across phases by the mapped-type
// contract), so we read the first phase's inner keys. An empty update (`M` is
// `never`) yields `[]` — the merged reducer then has no cells, which is correct
// because no Msg can ever be dispatched.
function telemetryMsgKeys(update: object): readonly string[] {
  const keys = Object.keys(update);
  const firstKey = keys[0];
  if (firstKey === undefined) return [];
  const firstValue = (update as Record<string, unknown>)[firstKey];
  if (typeof firstValue === "function") {
    // Reducer form — keys are Msg.type.
    return keys;
  }
  // Transitions form — keys are state.type; inner keys are Msg.type.
  return Object.keys(firstValue as object);
}
