// ---------------------------------------------------------------------------
// Property runners — three thin wrappers over `fc.check(fc.property(...))`
// that fold a generated Msg sequence through the machine via `foldEvents`
// and pipe the result into a TEA-shaped predicate.
//
//   - `propertyTerminates` — every sequence ends in a terminal state.
//   - `propertyInvariant`  — predicate holds on every (prev, msg, next, cmds) step.
//   - `propertyTrace`      — predicate holds on the full (trace, final) shape.
//
// Each runner takes the Msg-sequence arbitrary, an optional `loaded` saved
// state (a value, or an arbitrary that draws one per run), and fast-check's
// settings. A passing run returns a `PropertyRun`; a failing run throws a
// `PropertyFailure` carrying that same `PropertyRun` under fast-check's own
// report.
//
// Default shrinker is fast-check's built-in (open question 4): drop-msg /
// prefix shrinkers can be layered later but are opt-in, not default. The
// built-in shrinker handles array-shape shrinking + per-element variant
// shrinking automatically.
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import type { Cmd, Machine, Sub } from "../../index";
import { foldEvents, type Step } from "./replay-fold";

/**
 * fast-check's settings a runner forwards. Four are left out, each because it
 * would break what a runner promises:
 *
 *   - `reporter` and `asyncReporter` stop a failing run from throwing.
 *   - `examples` has the shape of the drawn tuple, which an arbitrary `loaded`
 *     changes.
 *   - `timeout` applies only to async properties, and these runners are sync.
 *     `interruptAfterTimeLimit` with `markInterruptAsFailure` is the limit that
 *     works here.
 */
type ForwardedSettings = Omit<
  fc.Parameters,
  "reporter" | "asyncReporter" | "examples" | "timeout"
>;

/**
 * Common options shared by every property runner: fast-check's settings
 * (`numRuns` defaults to 200 here) plus the saved state to start from.
 */
interface PropertyOpts<S> extends ForwardedSettings {
  /**
   * Saved state passed to `machine.init(loaded, ctx)`. Default `null`. An
   * arbitrary draws one per run, and a failure's counterexample shows the drawn
   * state beside the shrunk list. It can draw `null` as well, the nothing storage
   * hands back on a fresh start, which boots the machine fresh.
   */
  readonly loaded?: S | null | fc.Arbitrary<S | null>;
}

/** The `foldEvents` result a runner's `check` inspects. */
type FoldResult<S, M, C> = {
  readonly states: readonly S[];
  readonly steps: readonly Step<S, M, C>[];
  readonly finalState: S;
};

/**
 * What a property run did. A passing runner returns it, and a failing one throws
 * it on {@link PropertyFailure.run}, so a caller reads one shape on both arms and
 * never parses error text.
 */
export interface PropertyRun {
  /** Lists tried. On a failure, this counts up to and including the failing one. */
  readonly numRuns: number;
  /** Shrink steps a failure took. `0` on a pass. */
  readonly numShrinks: number;
  /** The seed this run drew from. Pass it back as `seed` to draw the same lists. */
  readonly seed: number;
  /**
   * Where the shrunk failure sits. Pass it back as `path`, with `seed`, to replay
   * that one failure. `null` when no list failed: on a pass, on an interrupt
   * marked as a failure, or when too many `fc.pre` skips fail the run.
   */
  readonly path: string | null;
}

/**
 * Raised when a property fails. The message is fast-check's report, and
 * {@link PropertyFailure.run} holds the same {@link PropertyRun} a pass returns.
 * What the check threw sits where `fc.assert` puts it on the installed fast-check:
 * on 4, in `cause` by default and in the message with `includeErrorInReport`; on 3,
 * in the message by default and in `cause` with `errorWithCause`.
 *
 * @example
 * ```ts
 * import type { Machine } from "@demlik/tea";
 * import { PropertyFailure, propertyInvariant } from "@demlik/tea/pbt";
 * import type * as fc from "fast-check";
 *
 * type State = { type: "idle" } | { type: "done" };
 * type Msg = { type: "finish" };
 * declare const machine: Machine<State, Msg, never, never, object>;
 * declare const seqArb: fc.Arbitrary<readonly Msg[]>;
 *
 * try {
 *   propertyInvariant(machine, {}, seqArb, ({ next }) => next.type === "idle");
 * } catch (error) {
 *   if (error instanceof PropertyFailure) {
 *     // Replay this one failure with `{ seed, path }`.
 *     const { numShrinks, seed, path } = error.run;
 *     console.log(numShrinks, seed, path);
 *   }
 * }
 * ```
 */
export class PropertyFailure extends Error {
  override readonly name = "PropertyFailure";
  readonly _tag = "PropertyFailure" as const;
  constructor(
    report: string,
    /** The run that failed. */
    public readonly run: PropertyRun,
    options?: ErrorOptions,
  ) {
    super(report, options);
  }
}

/**
 * Tell a drawn `loaded` from a fixed one. A saved state is plain data that can
 * come back through JSON, so it never holds these functions, and testing for them
 * keeps working where `instanceof` breaks: two copies of fast-check installed.
 */
function isArbitrary<S>(
  loaded: S | null | fc.Arbitrary<S | null> | undefined,
): loaded is fc.Arbitrary<S | null> {
  if (typeof loaded !== "object" || loaded === null) return false;
  const { generate, shrink, canShrinkWithoutContext } = loaded as Partial<
    fc.Arbitrary<S | null>
  >;
  return (
    typeof generate === "function" &&
    typeof shrink === "function" &&
    typeof canShrinkWithoutContext === "function"
  );
}

/**
 * The settings that decide whether `fc.assert` puts a `cause` on its error. tea
 * promises two majors of fast-check, and each knows only one of these: 3 reads
 * `errorWithCause` (off by default) and 4 reads `includeErrorInReport` (a `cause`
 * unless it is on).
 */
interface CauseSettings {
  readonly errorWithCause?: boolean;
  readonly includeErrorInReport?: boolean;
}

/**
 * The `cause` `fc.assert` would attach to this failure. `runConfiguration` holds
 * `errorWithCause` only on 3, so its absence is what says the rule is 4's.
 */
function causeOf<Ts>(details: fc.RunDetails<Ts>): ErrorOptions | undefined {
  const { errorWithCause, includeErrorInReport }: CauseSettings =
    details.runConfiguration;
  return (errorWithCause ?? !includeErrorInReport)
    ? { cause: details.errorInstance }
    : undefined;
}

/**
 * Turn fast-check's details into what the caller sees: the {@link PropertyRun}
 * on a pass, a thrown {@link PropertyFailure} on a failure. `fc.check` never
 * throws by itself, and this keeps the report and the `cause` `fc.assert` gives
 * on either major. fast-check's report is `undefined` exactly when nothing failed.
 */
function settle<Ts>(details: fc.RunDetails<Ts>): PropertyRun {
  const run: PropertyRun = {
    numRuns: details.numRuns,
    numShrinks: details.numShrinks,
    seed: details.seed,
    path: details.counterexamplePath,
  };
  const report = fc.defaultReportMessage(details);
  if (report === undefined) return run;
  throw new PropertyFailure(report, run, causeOf(details));
}

/**
 * The fold+check core every runner shares: run `check` over each generated Msg
 * sequence, folded once through the machine via `foldEvents`. `check` throws on
 * failure so the error message carries the offending shape into fast-check's
 * shrunk counter-example.
 *
 * A fixed `loaded` keeps a one-argument property, so a seed draws what it always
 * drew. An arbitrary `loaded` draws as a second argument.
 */
function runProperty<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: Ctx,
  seqArb: fc.Arbitrary<readonly M[]>,
  opts: PropertyOpts<S> | undefined,
  check: (result: FoldResult<S, M, C>) => void,
): PropertyRun {
  const { loaded, ...settings } = opts ?? {};
  const params = { ...settings, numRuns: settings.numRuns ?? 200 };
  return isArbitrary(loaded)
    ? settle(
        fc.check(
          fc.property(seqArb, loaded, (msgs, drawn) => {
            check(foldEvents(machine, ctx, drawn, msgs));
          }),
          params,
        ),
      )
    : settle(
        fc.check(
          fc.property(seqArb, (msgs) => {
            check(foldEvents(machine, ctx, loaded ?? null, msgs));
          }),
          params,
        ),
      );
}

/**
 * Assert every generated Msg sequence ends in a terminal state. `terminal`
 * is the predicate that names the acceptable final states (often
 * `(s) => s.type === "done" || s.type === "idle"`).
 *
 * The "every sequence" property catches stuck states (machine gets to a
 * non-terminal state and no further msg can escape) AND silent loops
 * (every msg variant is a noop from a given state).
 *
 * @example
 * ```ts
 * import type { Machine } from "@demlik/tea";
 * import {
 *   arbMsgSequence,
 *   propertyTerminates,
 *   stubCtxThrowingProxy,
 * } from "@demlik/tea/pbt";
 * import type * as fc from "fast-check";
 *
 * type State = { type: "idle" } | { type: "auditing" } | { type: "done" };
 * type Msg = { type: "start_audit" } | { type: "ws:audit:done" };
 * interface BackgroundCtx { readonly tabId: number }
 * declare const auditBackgroundMachine: Machine<State, Msg, never, never, BackgroundCtx>;
 * declare const msgArb: fc.Arbitrary<Msg>;
 * const auditingState: State = { type: "auditing" };
 *
 * propertyTerminates(
 *   auditBackgroundMachine,
 *   stubCtxThrowingProxy<BackgroundCtx>(),
 *   arbMsgSequence(msgArb, { minLength: 1, maxLength: 30 }),
 *   (s) => s.type === "done" || s.type === "idle",
 *   { loaded: auditingState, numRuns: 500 },
 * );
 * ```
 */
export function propertyTerminates<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  seqArb: fc.Arbitrary<readonly NoInfer<M>[]>,
  terminal: (state: NoInfer<S>) => boolean,
  opts?: NoInfer<PropertyOpts<S>>,
): PropertyRun {
  return runProperty(machine, ctx, seqArb, opts, ({ finalState }) => {
    if (!terminal(finalState)) {
      // Throwing here (vs returning false) lets the error message carry
      // the offending final state — fast-check pretty-prints it inside
      // the shrunk counter-example.
      throw new Error(
        `propertyTerminates: final state did not match terminal predicate. ` +
          `Final: ${JSON.stringify(finalState)}`,
      );
    }
  });
}

/**
 * Assert a predicate holds on EVERY transition step in a generated
 * sequence. The predicate sees `{ prev, msg, next, cmds }` per step;
 * return true to accept, false (or throw) to fail.
 *
 * Use to pin a "when X happens in state Y, cmd Z must be emitted" rule.
 * The shrinker minimizes the offending sequence to the smallest Msg list
 * that still violates the predicate.
 *
 * @example
 * ```ts
 * import type { Machine } from "@demlik/tea";
 * import { arbMsgSequence, propertyInvariant } from "@demlik/tea/pbt";
 * import type * as fc from "fast-check";
 *
 * type State = { type: "idle" } | { type: "auditing" };
 * type Msg = { type: "start_audit" } | { type: "ws:client:hello" };
 * type Cmd = { type: "send_ws"; msg: { type: "client:ready" } };
 * interface BackgroundCtx { readonly tabId: number }
 * declare const auditBackgroundMachine: Machine<State, Msg, Cmd, never, BackgroundCtx>;
 * declare const ctx: BackgroundCtx;
 * declare const msgArb: fc.Arbitrary<Msg>;
 * const auditingState: State = { type: "auditing" };
 *
 * // Pin the resume-handshake fix: `ws:client:hello` in auditing must
 * // emit `send_ws { client:ready }`.
 * propertyInvariant(
 *   auditBackgroundMachine, ctx,
 *   arbMsgSequence(msgArb, { prefix: [{ type: "ws:client:hello" }] }),
 *   ({ prev, msg, cmds }) =>
 *     !(prev.type === "auditing" && msg.type === "ws:client:hello") ||
 *     cmds.some((c) => c.type === "send_ws" && c.msg.type === "client:ready"),
 *   { loaded: auditingState, numRuns: 200 },
 * );
 * ```
 */
export function propertyInvariant<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  seqArb: fc.Arbitrary<readonly NoInfer<M>[]>,
  invariant: (step: Step<NoInfer<S>, NoInfer<M>, NoInfer<C>>) => boolean,
  opts?: NoInfer<PropertyOpts<S>>,
): PropertyRun {
  return runProperty(machine, ctx, seqArb, opts, ({ steps }) => {
    for (const step of steps) {
      if (!invariant(step)) {
        throw new Error(
          `propertyInvariant: failed at step msg=${JSON.stringify(step.msg)} ` +
            `prev=${JSON.stringify(step.prev)} next=${JSON.stringify(step.next)} ` +
            `cmds=${JSON.stringify(step.cmds)}`,
        );
      }
    }
  });
}

/**
 * Assert a predicate over the full trace plus the final state. Use when
 * the property is "some Msg appeared in the trace before reaching the
 * final state" or "no two consecutive steps had the same state.type" —
 * predicates that need the full sequence, not a single step.
 *
 * @example
 * ```ts
 * import type { Machine } from "@demlik/tea";
 * import { propertyTrace } from "@demlik/tea/pbt";
 * import type * as fc from "fast-check";
 *
 * type State = { type: "auditing" } | { type: "done" };
 * type Msg = { type: "ws:audit:progress" } | { type: "ws:audit:done" };
 * interface Ctx { readonly tabId: number }
 * declare const machine: Machine<State, Msg, never, never, Ctx>;
 * declare const ctx: Ctx;
 * declare const seqArb: fc.Arbitrary<readonly Msg[]>;
 * const auditingState: State = { type: "auditing" };
 *
 * propertyTrace(
 *   machine, ctx, seqArb,
 *   (steps, final) =>
 *     final.type !== "done" ||
 *     steps.some((step) => step.msg.type === "ws:audit:done"),
 *   { loaded: auditingState, numRuns: 500 },
 * );
 * ```
 */
export function propertyTrace<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  seqArb: fc.Arbitrary<readonly NoInfer<M>[]>,
  predicate: (
    steps: readonly Step<NoInfer<S>, NoInfer<M>, NoInfer<C>>[],
    finalState: NoInfer<S>,
  ) => boolean,
  opts?: NoInfer<PropertyOpts<S>>,
): PropertyRun {
  return runProperty(machine, ctx, seqArb, opts, ({ steps, finalState }) => {
    if (!predicate(steps, finalState)) {
      throw new Error(
        `propertyTrace: predicate failed on trace length=${steps.length}, ` +
          `final=${JSON.stringify(finalState)}`,
      );
    }
  });
}
