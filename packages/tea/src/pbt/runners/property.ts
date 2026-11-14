// ---------------------------------------------------------------------------
// Property runners — three thin wrappers over `fc.check(fc.property(...))`
// that fold a generated Msg sequence through the machine via `foldEvents`
// and pipe the result into a TEA-shaped predicate.
//
//   - `propertyTerminates` — every sequence ends in a terminal state.
//   - `propertyInvariant`  — predicate holds on every (prev, msg, next, cmds) step.
//   - `propertyTrace`      — predicate holds on the full (trace, final) shape.
//
// Each law is a plain function in `../laws.ts` (`lawTerminates`, `lawInvariant`,
// `lawTrace`) that answers what broke, and the runner throws that with its own
// name in front. The laws import no fast-check, so Effect's checker runs them too.
//
// Each runner takes the Msg-sequence arbitrary, an optional `loaded` saved
// state (a value, or an arbitrary that draws one per run), and fast-check's
// settings. A passing run returns a `PropertyRun`; a failing run throws a
// `PropertyFailure` carrying that same `PropertyRun` under fast-check's own
// report, plus a check's reason when fast-check filed that reason in `cause`.
// `failOnNeverActed` throws one too, naming the Msg types a clean run never acted on.
//
// Before any check runs, every Cmd `init` and the steps sent is held to two rules:
// a value with no string `type` always fails, and with `failOnUndeclaredCmd` on, so
// does a `type` outside `machine.cmds`. Each check also gets `init`'s Cmds as its
// last argument, since no `Step` holds them.
//
// Default shrinker is fast-check's built-in (open question 4): drop-msg /
// prefix shrinkers can be layered later but are opt-in, not default. The
// built-in shrinker handles array-shape shrinking + per-element variant
// shrinking automatically.
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { type Cmd, type Machine, msgKeysOf, type Sub } from "../../index";
import { assertDistinctCmdNames } from "../../pure/core";
import { type LawBreak, lawInvariant, lawTerminates, lawTrace } from "../laws";
import { type MsgCount, MsgTally } from "./msg-tally";
import { type Fold, foldEvents, type Step } from "./replay-fold";

/**
 * What every property runner takes: the saved state to start from, the two checks
 * below, and fast-check's `Parameters` (`numRuns` defaults to 200 here). Five of
 * those settings are left out, each because it would break what a runner promises:
 *
 *   - `reporter` and `asyncReporter` stop a failing run from throwing. One set
 *     through `fc.configureGlobal` still applies, as it does for `fc.assert`.
 *   - `examples` has the shape of the drawn tuple, which an arbitrary `loaded`
 *     changes.
 *   - `timeout` applies only to async properties, and these runners are sync.
 *     `interruptAfterTimeLimit` with `markInterruptAsFailure` is the limit that
 *     works here.
 *   - `plugins` is left out on every fast-check. Only the newest 4s have it, so a
 *     call using it would compile and run on some of the versions tea promises and
 *     not on others. `fc.timeout`, which it can carry, has the same limit as
 *     `timeout`. fast-check 4.10.2 marks `interruptAfterTimeLimit`,
 *     `markInterruptAsFailure`, `skipEqualValues`, `ignoreEqualValues` and `unbiased`
 *     as deprecated in favor of plugins, and they still work on every version tea
 *     promises, so they stay.
 */
export interface PropertyOpts<S>
  extends Omit<
    fc.Parameters,
    "reporter" | "asyncReporter" | "examples" | "timeout" | "plugins"
  > {
  /**
   * Saved state passed to `machine.init(loaded, ctx)`. Default `null`. An
   * arbitrary draws one per run, and a failure's counterexample shows the drawn
   * state beside the shrunk list. It can draw `null` as well, the nothing storage
   * hands back on a fresh start, which boots the machine fresh.
   */
  readonly loaded?: S | null | fc.Arbitrary<S | null>;
  /**
   * Fail a run whose laws all held when a Msg type never acted, naming each such
   * type, so a cut path can't stay green. Default `false`.
   *
   * A deep path needs a `maxLength` well past its depth as well as `size: "max"`
   * on `arbMsgSequence`. Lists too short to reach a healthy machine's deep state
   * name that healthy path as never acted, in the same report a cut path gives. At
   * the default `maxLength` of 30, a state 20 steps deep on 6 Msg types drawn evenly
   * fails this way, since only one draw in 6 climbs. Allow about the depth times the
   * number of Msg types, here `maxLength: 120`.
   *
   * This stays out of any run with a non-empty `path`, so drop `path` to have it
   * check again. A path with a colon, such as `"0:0"`, replays one shrunk failure. A
   * path with no colon, such as `"3"`, is what a failure with no shrinks reports, and
   * it is no replay once that failure is gone: fast-check draws a full `numRuns` of
   * lists starting from that one, and a cut path reads green. `path: ""` is no path
   * to fast-check, so this applies there.
   *
   * A value `structuralHash` refuses (a `Date`, a `Map`, a class instance) leaves
   * "acted" unreadable when a step's comparison reaches it, so this fails the run
   * saying so. The comparison stops at the first difference and doesn't look inside
   * an object `prev` and `next` share, so a refused value stays unread, and fails
   * nothing, when it sits in a shared object or past a difference. The answer is
   * right either way: a shared object didn't change, and a difference means the
   * step acted. Fields are compared in the order the state's keys were set.
   */
  readonly failOnNeverActed?: boolean;
  /**
   * Fail a run when `init` or a step sends a Cmd whose `type` isn't in
   * `machine.cmds`, naming that Cmd. Default `false`, because tea lets a machine
   * keep a hand-written Cmd beside its defined ones. A machine with no `cmds` field
   * has no list to check against, so this adds nothing there. `cmds: []` is a list
   * with nothing on it, so every Cmd fails.
   *
   * A value with no string `type` is never a Cmd, so it fails with this off too, on
   * every machine.
   */
  readonly failOnUndeclaredCmd?: boolean;
}

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
   * marked as a failure, when too many `fc.pre` skips fail the run, or when
   * `failOnNeverActed` fails it.
   */
  readonly path: string | null;
  /**
   * What the run's lists did, per Msg type: every type the machine has a cell for,
   * then any other that was drawn. A type never drawn reads zero. On a failure this
   * stops at the failing list, so shrinking adds nothing, and a list skipped with
   * `fc.pre` adds nothing either. A list whose reducer threw adds nothing as well,
   * though `numRuns` includes it: its fold hands back no steps to count.
   *
   * A step counts as acted when its comparison reaches a value `structuralHash`
   * refuses (a `Date`, a `Map`, a class instance). One in an object `prev` and `next`
   * share, or past a difference, is never reached, so it changes no count.
   */
  readonly msgCounts: ReadonlyMap<string, MsgCount>;
}

/**
 * Raised when a property fails. The message is fast-check's report, and
 * {@link PropertyFailure.run} holds the same {@link PropertyRun} a pass returns.
 * What the check threw sits where `fc.assert` puts it on the installed fast-check:
 * on 4, in `cause` by default and in the message with `includeErrorInReport`; on 3,
 * in the message by default and in `cause` with `errorWithCause`, on the 3s that have
 * that setting. A reason the check returned is always in the message: when it went to
 * `cause`, the message is the report plus a `reason:` line. A run that `failOnNeverActed` fails broke no list,
 * so fast-check has no report: the message names the Msg types instead.
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
 * A check's failure that says why. The reason is text fast-check would otherwise
 * bury where it files what a check threw, so {@link settle} reads it back here
 * rather than out of that text.
 *
 * Every fast-check prints the stack, which opens with the message. The oldest 3s also
 * print `String(error)` ahead of it, so that leaves the reason out to say it once.
 */
class BrokenLaw extends Error {
  constructor(
    private readonly report: string,
    readonly reason: string,
  ) {
    super(`${report}\nreason: ${reason}`);
    this.name = "Error";
  }

  override toString(): string {
    return `${this.name}: ${this.report}`;
  }
}

/**
 * Read what a check answered: `true` and `null` hold, `false` and any string fail.
 * An empty string fails with nothing to say, so it reads as `false`. `report` is
 * what the runner prints today, built only when there is a failure to print.
 */
function assertHolds(
  answer: boolean | string | null,
  report: () => string,
): void {
  if (answer === true || answer === null) return;
  if (answer === false || answer === "") throw new Error(report());
  throw new BrokenLaw(report(), answer);
}

/**
 * Throw what a law said broke, its report led by the runner's name, the way
 * {@link assertHolds} throws a check's answer. A held law throws nothing.
 */
function assertLaw(runner: string, broken: LawBreak | null): void {
  if (broken === null) return;
  const report = `${runner}: ${broken.report}`;
  throw broken.reason === null
    ? new Error(report)
    : new BrokenLaw(report, broken.reason);
}

/**
 * What is wrong with a sent Cmd, naming it, or `null` when nothing is. `declared`
 * is the list to hold it to, or `null` when there is none to read. Types can't
 * rule these out: a reducer's `as` or a mutated line reaches here at run time.
 */
function cmdFault(
  cmd: unknown,
  declared: ReadonlySet<string> | null,
): string | null {
  const { type } = Object(cmd) as { readonly type?: unknown };
  if (typeof cmd !== "object" || typeof type !== "string") {
    return `${fc.stringify(cmd)} isn't a Cmd: it has no string \`type\``;
  }
  if (declared === null || declared.has(type)) return null;
  return `${fc.stringify(cmd)} isn't in machine.cmds: [${[...declared].join(", ")}]`;
}

/** Hold every Cmd one fold sent, `init`'s first, to {@link cmdFault}. */
function assertSentCmds<S, M, C>(
  { initCmds, steps }: Fold<S, M, C>,
  declared: ReadonlySet<string> | null,
): void {
  for (const cmd of initCmds) {
    assertHolds(cmdFault(cmd, declared), () => "init sent a bad Cmd");
  }
  for (const { msg, cmds } of steps) {
    for (const cmd of cmds) {
      assertHolds(
        cmdFault(cmd, declared),
        () => `step msg=${fc.stringify(msg)} sent a bad Cmd`,
      );
    }
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
 * Drop the settings set to `undefined`. fast-check lays what it is handed over the
 * settings from `fc.configureGlobal` key by key, so a key holding `undefined` would
 * throw the global one away, and a global `seed` would turn into a random one.
 */
function withoutUndefined<T extends object>(settings: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * The settings that decide whether `fc.assert` puts a `cause` on its error. tea
 * promises two majors of fast-check, and each knows only one of these: 3 reads
 * `errorWithCause` (off by default) and 4 reads `includeErrorInReport` (a `cause`
 * unless it is on). The oldest 3s have neither, and never attach a `cause`.
 */
interface CauseSettings {
  readonly errorWithCause?: boolean;
  readonly includeErrorInReport?: boolean;
}

/**
 * The `cause` `fc.assert` would attach to this failure. The loaded major picks the
 * rule: a missing `errorWithCause` can't, because the oldest 3s lack it as 4 does.
 */
function causeOf<Ts>(details: fc.RunDetails<Ts>): ErrorOptions | undefined {
  const { errorWithCause, includeErrorInReport } =
    details.runConfiguration as CauseSettings;
  const major = Number(fc.__version.split(".")[0]);
  return (major >= 4 ? !includeErrorInReport : errorWithCause)
    ? { cause: details.errorInstance }
    : undefined;
}

/**
 * Turn fast-check's details into what the caller sees: the {@link PropertyRun}
 * on a pass, a thrown {@link PropertyFailure} on a failure. `fc.check` never
 * throws by itself, and this keeps the report and the `cause` `fc.assert` gives
 * on either major. fast-check's report is `undefined` exactly when nothing failed.
 *
 * A report leaves out what the check threw exactly when that went to the `cause`,
 * so a check's reason is added to the report there. The thrown error is the one
 * from the shrunk list, so the reason always describes the list printed beside it.
 *
 * A reporter set through `fc.configureGlobal` takes the details instead, on a pass
 * and on a failure, and nothing throws: what `fc.assert` does. It is read from the
 * global settings, not `details.runConfiguration`, which also holds one passed per
 * call, so a `reporter` that slips past the types still can't hide a failure.
 */
function settle<Ts>(details: fc.RunDetails<Ts>, tally: MsgTally): PropertyRun {
  const run: PropertyRun = {
    numRuns: details.numRuns,
    numShrinks: details.numShrinks,
    seed: details.seed,
    path: details.counterexamplePath,
    msgCounts: tally.counts,
  };
  const { reporter } = fc.readConfigureGlobal();
  if (reporter) {
    // A global reporter takes any property's details, so `Ts` is nothing to it.
    reporter(details as fc.RunDetails<unknown>);
    return run;
  }
  const report = fc.defaultReportMessage(details);
  if (report === undefined) return run;
  const cause = causeOf(details);
  const broken = details.errorInstance;
  throw new PropertyFailure(
    cause && broken instanceof BrokenLaw
      ? `${report}\n\nreason: ${broken.reason}`
      : report,
    run,
    cause,
  );
}

/**
 * Fail a run whose laws all held when a Msg type never acted. No single list broke
 * this, so there is no shrunk list to show: the report names the types, and the
 * seed draws the same lists again.
 */
function assertEveryTypeActed(run: PropertyRun, tally: MsgTally): void {
  const { refusal, neverActed } = tally;
  const ranOver = `after ${run.numRuns} runs, seed ${run.seed}`;
  if (refusal !== null) {
    const why = refusal instanceof Error ? refusal.message : String(refusal);
    throw new PropertyFailure(
      `Property failed ${ranOver}: failOnNeverActed can't tell what acted, because a state isn't plain data.\n\n${why}`,
      run,
    );
  }
  if (neverActed.length === 0) return;
  const named = neverActed.map(
    ([type, { drawn }]) => `  ${type} (drawn ${drawn})`,
  );
  throw new PropertyFailure(
    `Property failed ${ranOver}: ${neverActed.length} Msg type(s) never acted:\n${named.join("\n")}`,
    run,
  );
}

/**
 * The fold+check core every runner shares: run `check` over each generated Msg
 * sequence, folded once through the machine via `foldEvents`. `check` throws on
 * failure so the error message carries the offending shape into fast-check's
 * shrunk counter-example.
 *
 * A fixed `loaded` keeps a one-argument property, so a seed draws what it always
 * drew. An arbitrary `loaded` draws as a second argument.
 *
 * A list counts once its fold has finished. A `fc.pre` skip adds nothing, as it
 * adds nothing to `numRuns`. Any other throw is the run's failure, so nothing after
 * that list is counted. A check's throw still counts its list, but a reducer's adds
 * nothing, though `numRuns` includes that list: `foldEvents` hands back no steps.
 *
 * The sent Cmds are held to their rules ahead of `check`, so a law that reads a junk
 * Cmd can't throw first and hide what is wrong.
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
  check: (result: Fold<S, M, C>) => void,
): PropertyRun {
  assertDistinctCmdNames(machine.cmds ?? []);
  const { loaded, failOnNeverActed, failOnUndeclaredCmd, ...settings } =
    opts ?? {};
  const params = {
    ...withoutUndefined(settings),
    numRuns: settings.numRuns ?? 200,
  };
  const tally = new MsgTally(msgKeysOf(machine));
  const declared =
    failOnUndeclaredCmd && machine.cmds
      ? new Set(machine.cmds.map((def) => def.cmdType))
      : null;
  const runList = (msgs: readonly M[], start: S | null): void => {
    let steps: readonly Step<S, M, C>[] = [];
    try {
      const result = foldEvents(machine, ctx, start, msgs);
      steps = result.steps;
      assertSentCmds(result, declared);
      check(result);
    } catch (error) {
      if (!fc.PreconditionFailure.isFailure(error)) {
        tally.add(steps);
        tally.close();
      }
      throw error;
    }
    tally.add(steps);
  };
  const checkActed = failOnNeverActed && !settings.path;
  const finish = <Ts>(details: fc.RunDetails<Ts>): PropertyRun => {
    const run = settle(details, tally);
    // A failed run gets here only past a global reporter, and its laws didn't hold.
    if (checkActed && !details.failed) assertEveryTypeActed(run, tally);
    return run;
  };
  return isArbitrary(loaded)
    ? finish(
        fc.check(
          fc.property(seqArb, loaded, (msgs, drawn) => {
            runList(msgs, drawn);
          }),
          params,
        ),
      )
    : finish(
        fc.check(
          fc.property(seqArb, (msgs) => {
            runList(msgs, loaded ?? null);
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
 * `terminal` also gets the Cmds `init` sent on that list's start.
 *
 * A `machine.cmds` that names one Cmd twice throws `CmdNameCollisionError`, before
 * any list is folded.
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
  terminal: (state: NoInfer<S>, initCmds: readonly NoInfer<C>[]) => boolean,
  opts?: NoInfer<PropertyOpts<S>>,
): PropertyRun {
  // Throwing (vs returning false) lets the error message carry the offending
  // final state — fast-check pretty-prints it inside the shrunk counter-example.
  return runProperty(machine, ctx, seqArb, opts, (fold) => {
    assertLaw("propertyTerminates", lawTerminates(fold, terminal));
  });
}

/**
 * Assert a predicate holds on EVERY transition step in a generated
 * sequence. The predicate sees `{ prev, msg, next, cmds }` per step. Return
 * `true` or `null` to accept. Return `false`, or a string saying why, to fail: the
 * thrown error's message names that string. An empty string fails too. A throw
 * still fails with its own message.
 *
 * The predicate's second argument is the Cmds `init` sent on that list's start. It
 * runs once per step, so an empty list never shows them to it: use `propertyTrace`
 * for a rule about `init` alone.
 *
 * Use to pin a "when X happens in state Y, cmd Z must be emitted" rule.
 * The shrinker minimizes the offending sequence to the smallest Msg list
 * that still violates the predicate.
 *
 * A `machine.cmds` that names one Cmd twice throws `CmdNameCollisionError`, before
 * any list is folded.
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
  invariant: (
    step: Step<NoInfer<S>, NoInfer<M>, NoInfer<C>>,
    initCmds: readonly NoInfer<C>[],
  ) => boolean | string | null,
  opts?: NoInfer<PropertyOpts<S>>,
): PropertyRun {
  return runProperty(machine, ctx, seqArb, opts, (fold) => {
    assertLaw("propertyInvariant", lawInvariant(fold, invariant));
  });
}

/**
 * Assert a predicate over the full trace plus the final state. Use when
 * the property is "some Msg appeared in the trace before reaching the
 * final state" or "no two consecutive steps had the same state.type" —
 * predicates that need the full sequence, not a single step.
 *
 * Return `true` or `null` to accept. Return `false`, or a string saying why, to
 * fail: the thrown error's message names that string. An empty string fails too.
 * A throw still fails with its own message. The last argument is the Cmds `init`
 * sent on that list's start.
 *
 * A `machine.cmds` that names one Cmd twice throws `CmdNameCollisionError`, before
 * any list is folded.
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
    initCmds: readonly NoInfer<C>[],
  ) => boolean | string | null,
  opts?: NoInfer<PropertyOpts<S>>,
): PropertyRun {
  return runProperty(machine, ctx, seqArb, opts, (fold) => {
    assertLaw("propertyTrace", lawTrace(fold, predicate));
  });
}
