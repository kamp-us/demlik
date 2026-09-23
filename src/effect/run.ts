/**
 * The Effect engine's `run` (#283): the same machine the Promise engine runs,
 * with Effect handlers, Effect sub runners, the caller's Layers and
 * interruption on stop.
 *
 * It runs the one core loop both engines share (`src/internal/engine/loop.ts`)
 * with the same built-ins in the same order, so a machine folds the same way on
 * either engine. What this file adds is the Effect edge:
 *
 *   - an `interpret` cell returns `Effect<Ok, E, R>`, read with
 *     `Effect.result`: a success settles `_ok`, a declared failure settles
 *     `_err`, a defect goes to the error sink;
 *   - a `subscribe` runner returns a `Stream<Msg>`, drained on its own fiber;
 *   - every handler and runner fiber runs with the services the caller
 *     provided, so `R` reaches them from the caller's Layers;
 *   - stopping interrupts every handler fiber still in flight.
 */

import { Cause, Effect, Exit, Fiber, Result, type Scope, Stream } from "effect";
import { builtinExtensions } from "../internal/engine/builtins";
import {
  type ExtensionFactory,
  type LoopHandler,
  type LoopRunner,
  startLoop,
} from "../internal/engine/loop";
import type {
  BuiltinSub,
  BuiltinSubType,
  Cmd,
  DeclaredErrorsOf,
  ErrorsOf,
  Machine,
  OkOfCmd,
  Sub,
  TimerSub,
} from "../pure/core";
import { applyCell, Outcome, subEntriesOf } from "../pure/core";
import type {
  BootingRuntime,
  CtxArg,
  OnError,
  RuntimeErrorPhase,
  Store,
  Supervision,
  TelemetrySink,
} from "../runtime-types";

// === The handler and runner shapes ===

/**
 * One Effect `interpret` cell. For a `Cmd.define`d Cmd it succeeds with the
 * Cmd's `Ok` and fails with one of its declared tags, and the engine mints
 * `<name>_ok` / `<name>_err` from that (ADR 0021). For a hand-written Cmd it
 * succeeds with a follow-up Msg or nothing, and a failure rejects the dispatch,
 * as a throw does on the Promise engine. `R` is whatever services it reads.
 */
export type EffectInterpretCell<
  M extends { type: string },
  C extends Cmd,
  R = unknown,
> =
  unknown extends ErrorsOf<C>
    ? // biome-ignore lint/suspicious/noConfusingVoidType: a hand-written Cmd's handler may settle with nothing
      (cmd: C) => Effect.Effect<M | void, unknown, R>
    : (cmd: C) => Effect.Effect<OkOfCmd<C>, DeclaredErrorsOf<C>, R>;

/**
 * The Effect engine's `interpret` map: one cell per Cmd variant, each reading
 * services within `R`.
 */
export type EffectInterpret<
  M extends { type: string },
  C extends Cmd,
  R = unknown,
> = {
  readonly [K in C["type"]]: EffectInterpretCell<M, Extract<C, { type: K }>, R>;
};

/**
 * One Effect sub runner: the Sub in, a `Stream` of Msgs out. The engine drains
 * it on its own fiber and interrupts that fiber when the Sub stops. A stream
 * that fails reaches the error sink under `"follow-up"`.
 */
export type EffectRunner<
  M extends { type: string },
  U extends Sub,
  R = unknown,
> = (sub: U) => Stream.Stream<M, unknown, R>;

/**
 * The Effect engine's `subscribe` map: a runner for every Sub type the machine
 * declares beyond the built-ins, and optionally one for a built-in, which
 * replaces the engine's own (#270 R2.1).
 */
export type EffectSubscribe<
  M extends { type: string },
  U extends Sub,
  R = unknown,
> = {
  readonly [K in Exclude<U["type"], BuiltinSubType>]: EffectRunner<
    M,
    Extract<U, { type: K }>,
    R
  >;
} & {
  readonly [K in BuiltinSubType]?: EffectRunner<
    M,
    Extract<BuiltinSub<M>, { type: K }>,
    R
  >;
};

/** The services every cell of an `interpret` map reads. */
export type InterpretServices<I> = {
  [K in keyof I]: ServicesOfCell<I[K]>;
}[keyof I];

type ServicesOfCell<F> = F extends (
  cmd: never,
) => Effect.Effect<unknown, unknown, infer R>
  ? R
  : never;

/** The services every runner of a `subscribe` map reads. */
export type SubscribeServices<B> = {
  [K in keyof B]-?: ServicesOfRunner<NonNullable<B[K]>>;
}[keyof B];

type ServicesOfRunner<F> = F extends (
  sub: never,
) => Stream.Stream<unknown, unknown, infer R>
  ? R
  : never;

// `interpret` is optional for a machine that emits no Cmd, and `subscribe` for
// one that declares only built-in Subs — the same requiredness the Promise
// engine's `RunHandlers` carries.
type InterpretOption<C extends Cmd, I> = [C] extends [Cmd<never>]
  ? { readonly interpret?: I }
  : { readonly interpret: I };

type SubscribeOption<U extends Sub, B> = [
  Exclude<U["type"], BuiltinSubType>,
] extends [never]
  ? { readonly subscribe?: B }
  : { readonly subscribe: B };

/**
 * The options of the Effect engine's `run`. Beside `interpret` and
 * `subscribe`, they are the Promise engine's, with the same meaning; see `run`
 * in `@demlik/tea/promise` for each one's contract.
 */
export type EffectRunOptions<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  E extends { type: string },
  I,
  B,
> = CtxArg<Ctx> &
  InterpretOption<C, I> &
  SubscribeOption<U, B> & {
    readonly store?: Store<S>;
    readonly onError?: OnError;
    /** Stamps `at` on minted Msgs and telemetry. Defaults to `Date.now`. */
    readonly clock?: () => number;
    /** Projects each applied transition to the public events `on` serves. */
    readonly events?: (msg: M, state: S) => readonly E[];
    /** The policy for a reducer throw. Defaults to `"stop"`. */
    readonly supervision?: Supervision<S, M>;
    /** The terminal predicate `result()` and `done()` read. */
    readonly terminal?: (state: S) => boolean;
    /** A fire-and-forget sink for every applied transition. */
    readonly telemetry?: TelemetrySink;
    /** How long `stop()` waits for async teardown. Defaults to 5_000ms. */
    readonly disposeTimeoutMs?: number;
  };

// === Built-in runners ===

/** `timer`: emit `deps.msg` once, `deps.ms` after the Sub starts. */
function timer<M>(sub: TimerSub<M>): Stream.Stream<M> {
  return Stream.fromEffect(Effect.as(Effect.sleep(sub.deps.ms), sub.deps.msg));
}

/** The Effect engine's built-in runners, keyed by the Sub type each runs. */
const builtinRunners = { timer } as const satisfies Record<
  BuiltinSubType,
  unknown
>;

// === run ===

/**
 * Run `machine` on the Effect engine. The returned Effect needs a `Scope` and
 * the services its handlers and runners read, and yields the run handle —
 * the same handle the Promise engine returns, so a host adapter typed against
 * `RunHandle` takes either.
 *
 * Closing the scope stops the run: every handler still in flight is
 * interrupted (its finalizers run), its Msg is never dispatched, and no Msg is
 * dispatched after stop. Calling `stop()` on the handle does the same.
 *
 * A fenced store is fenced here exactly as on the Promise engine: the check is
 * one of the built-ins both engines run.
 *
 * ```ts
 * const program = Effect.gen(function* () {
 *   const rt = yield* run(machine, {
 *     interpret: {
 *       fetch: (cmd) =>
 *         Effect.gen(function* () {
 *           const api = yield* Api;
 *           return yield* api.get(cmd.id);
 *         }),
 *     },
 *   });
 *   yield* Effect.promise(() => rt.dispatch({ type: "go", id: "7" }));
 * });
 * Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(ApiLive)));
 * ```
 */
export function run<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  // The defaults read no services, so an omitted map adds none to `R`.
  I extends EffectInterpret<M, C> = EffectInterpret<M, C, never>,
  B extends EffectSubscribe<M, U> = EffectSubscribe<M, U, never>,
  E extends { type: string } = never,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: EffectRunOptions<S, M, C, U, Ctx, E, I, B>,
): Effect.Effect<
  BootingRuntime<S, M, E>,
  never,
  Scope.Scope | InterpretServices<I> | SubscribeServices<B>
> {
  return Effect.gen(function* () {
    const services = yield* Effect.context<
      InterpretServices<I> | SubscribeServices<B>
    >();
    return yield* Effect.acquireRelease(
      Effect.sync(() =>
        start<S, M, C, U, Ctx, E>(
          machine,
          opts as EffectRunOptions<S, M, C, U, Ctx, E, unknown, unknown>,
          Effect.runPromiseExitWith(services) as RunEffect,
          Effect.runForkWith(services) as ForkEffect,
        ),
      ),
      (runtime) => Effect.promise(() => runtime.stop()),
    );
  });
}

/** Run an erased Effect to its Exit, interruptible through `signal`. */
type RunEffect = (
  effect: Effect.Effect<unknown, unknown>,
  options: { readonly signal: AbortSignal },
) => Promise<Exit.Exit<unknown, unknown>>;

/** Fork an erased Effect onto its own fiber. */
type ForkEffect = (
  effect: Effect.Effect<unknown, unknown>,
) => Fiber.Fiber<unknown, unknown>;

type AnyCell = (cmd: unknown) => Effect.Effect<unknown, unknown>;
type AnyRunner = (sub: Sub) => Stream.Stream<unknown, unknown>;

function start<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  E extends { type: string },
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: EffectRunOptions<S, M, C, U, Ctx, E, unknown, unknown>,
  runEffect: RunEffect,
  fork: ForkEffect,
): BootingRuntime<S, M, E> {
  const interpret = ((opts as { interpret?: unknown }).interpret ??
    {}) as Readonly<Record<string, AnyCell | undefined>>;
  const subscribe = ((opts as { subscribe?: unknown }).subscribe ??
    {}) as Readonly<Record<string, AnyRunner | undefined>>;
  const builtins = builtinRunners as unknown as Readonly<
    Record<string, AnyRunner | undefined>
  >;
  const defined = new Set((machine.cmds ?? []).map((def) => def.cmdType));

  // Aborted on stop: every handler fiber runs under this signal, so aborting
  // it interrupts all of them at once.
  const interruption = new AbortController();

  // The loop's error sink, lent to the runners below: a stream that fails
  // after it started has no caller to reject at.
  let report: (error: unknown, phase: RuntimeErrorPhase) => void = () => {};
  const edge: ExtensionFactory<S, M, C> = (loop) => {
    report = loop.report;
    return {};
  };

  // Read the cell's Effect with `Effect.result`, so a declared failure is a
  // value and only a defect or an interruption is left in the Exit's cause.
  async function settle(cell: AnyCell, cmd: unknown): Promise<unknown> {
    const type = (cmd as { type: string }).type;
    const exit = await runEffect(Effect.result(cell(cmd)), {
      signal: interruption.signal,
    });
    if (Exit.isFailure(exit)) {
      // Interrupted by stop: nothing to dispatch.
      if (Cause.hasInterruptsOnly(exit.cause)) return undefined;
      // A defect. For a defined Cmd the `Cmd.define` edge routes this throw to
      // the error sink; for a hand-written one it rejects the dispatch.
      throw Cause.squash(exit.cause);
    }
    const result = exit.value as Result.Result<unknown, unknown>;
    if (defined.has(type)) {
      return Result.isSuccess(result)
        ? Outcome.ok(result.success)
        : Outcome.err(result.failure);
    }
    if (Result.isFailure(result)) throw result.failure;
    return result.success;
  }

  function handlerFor(type: string): LoopHandler<M> | undefined {
    const cell = interpret[type];
    if (cell === undefined) return undefined;
    return (cmd) => settle(cell, cmd);
  }

  // A runner's Msgs reach the loop through its `dispatch`, which queues each
  // one behind the step in progress — never a transition on the stream's own
  // fiber (spike #260).
  function runnerFor(type: string): LoopRunner<Ctx, M> | undefined {
    const make = subscribe[type] ?? builtins[type];
    if (make === undefined) return undefined;
    return (sub, _ctx, dispatch) => {
      const drain = Stream.runForEach(make(sub), (msg) =>
        Effect.sync(() => dispatch(msg as M)),
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.sync(() => report(Cause.squash(cause), "follow-up")),
        ),
      );
      const fiber = fork(drain);
      return () => Effect.runPromise(Fiber.interrupt(fiber));
    };
  }

  const handle = startLoop<S, M, C, Ctx>({
    init: machine.init,
    reduce: (state, msg) => applyCell<S, M, C>(machine, state, msg),
    subs: subEntriesOf<S>(machine),
    runnerFor,
    handlerFor,
    store: opts.store,
    ctx: (opts.ctx ?? {}) as Ctx,
    onError: opts.onError,
    disposeTimeoutMs: opts.disposeTimeoutMs ?? 5_000,
    idleCap: 100_000,
    extensions: [...builtinExtensions<S, M, C, E>(machine, opts), edge],
  });

  // Stop closes the gate first, so nothing an interrupted handler leaves
  // behind is dispatched, then interrupts every handler still in flight so the
  // drain it waits on can finish.
  const stopLoop = handle.stop;
  handle.stop = () => {
    const stopped = stopLoop();
    interruption.abort();
    return stopped;
  };
  return handle as unknown as BootingRuntime<S, M, E>;
}
