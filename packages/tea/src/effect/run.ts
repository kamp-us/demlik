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
 *   - stopping interrupts every handler fiber still in flight;
 *   - the handle's verbs are Effects with a typed error channel
 *     (`./handle`, `./failures`).
 */

import { Cause, Effect, Exit, Fiber, Result, Scope, Stream } from "effect";
import { builtinExtensions } from "../internal/engine/builtins";
import {
  defaultOnError,
  type LiveWorkProbe,
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
  CtxArg,
  OnError,
  Runtime,
  Store,
  Supervision,
  TelemetrySink,
} from "../runtime-types";
import { CellFailure, saveFailures, unwrapped } from "./failures";
import { type EffectBootingRuntime, effectHandle } from "./handle";

// === The handler and runner shapes ===

/**
 * One Effect `interpret` cell. For a `Cmd.define`d Cmd it succeeds with the
 * Cmd's `Ok` and fails with one of its declared tags, and the engine mints
 * `<name>_ok` / `<name>_err` from that (ADR 0021). For a hand-written Cmd it
 * succeeds with a follow-up Msg, a list of them (dispatched in order), or
 * nothing, and its failure fails the dispatch with that error, typed on the
 * handle (see {@link CellErrors}). `R` is whatever services it reads.
 */
export type EffectInterpretCell<
  M extends { type: string },
  C extends Cmd,
  R = unknown,
> =
  unknown extends ErrorsOf<C>
    ? // biome-ignore lint/suspicious/noConfusingVoidType: a hand-written Cmd's handler may settle with nothing
      (cmd: C) => Effect.Effect<M | readonly M[] | void, unknown, R>
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
 * it on its own fiber and interrupts that fiber when the Sub stops.
 *
 * A Sub maps the errors it expects into Msgs itself, the way an Elm `Sub msg`
 * carries no error type: `Stream.catchTag("Closed", () => Stream.make({ type:
 * "disconnected" }))`. A stream that still fails reaches the error sink under
 * `"sub"` and stops the run: the run's Scope closes with that failure (#309).
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

/**
 * The failures a dispatch on the handle can end with from an `interpret` map:
 * the error type of every hand-written Cmd's cell. A `Cmd.define`d Cmd's
 * declared failure settles its `_err` Msg instead, so it adds nothing here.
 */
export type CellErrors<C extends Cmd, I> = {
  [K in keyof I & C["type"]]: unknown extends ErrorsOf<Extract<C, { type: K }>>
    ? ErrorOfCell<I[K]>
    : never;
}[keyof I & C["type"]];

type ErrorOfCell<F> = F extends (
  cmd: never,
) => Effect.Effect<unknown, infer Err, unknown>
  ? Err
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

export type SubscribeOption<U extends Sub, B> = [
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
export const builtinRunners = { timer } as const satisfies Record<
  BuiltinSubType,
  unknown
>;

// === Settling a cell ===

/**
 * The Effect a cell's Effect is run as: `Effect.result` makes a declared
 * failure a value, so only a defect or an interruption is left in the Exit's
 * cause. Read the Exit back with {@link settleCellExit}.
 */
export function cellResult(
  effect: Effect.Effect<unknown, unknown>,
): Effect.Effect<Result.Result<unknown, unknown>> {
  return Effect.result(effect);
}

/**
 * What one cell's run settles to, the rule the engine and the Effect `drive`
 * share so they cannot drift:
 *
 *   - interrupted — `undefined`, nothing to dispatch;
 *   - a defect — thrown;
 *   - a `Cmd.define`d Cmd (`defined`) — its success as `Outcome.ok`, its
 *     declared failure as `Outcome.err`, for the `Cmd.define` edge to mint;
 *   - a hand-written Cmd — its success (the follow-up Msgs) as is, its failure
 *     thrown as a {@link CellFailure}, so a caller types it.
 */
export function settleCellExit(
  exit: Exit.Exit<unknown, unknown>,
  defined: boolean,
): unknown {
  if (Exit.isFailure(exit)) {
    if (Cause.hasInterruptsOnly(exit.cause)) return undefined;
    throw Cause.squash(exit.cause);
  }
  const result = exit.value as Result.Result<unknown, unknown>;
  if (defined) {
    return Result.isSuccess(result)
      ? Outcome.ok(result.success)
      : Outcome.err(result.failure);
  }
  if (Result.isFailure(result)) throw new CellFailure(result.failure);
  return result.success;
}

// === run ===

/**
 * Run `machine` on the Effect engine. The returned Effect needs a `Scope` and
 * the services its handlers and runners read, and yields the run handle. The
 * handle's members have the Promise engine's names; the ones that return a
 * Promise there return an Effect here, failing with `Stopped`, `StoreFailed`
 * or a hand-written cell's declared failure, so a host sorts them with
 * `Effect.catchTags`.
 *
 * Closing the scope stops the run and its Subs: every handler still in flight
 * is interrupted (its finalizers run), its Msg is never dispatched, and a
 * dispatch after stop fails with `Stopped`. The handle's `stop()` does the
 * same.
 *
 * A Sub whose Stream fails with an error it did not map to a Msg stops the
 * run the other way round: the engine closes that Scope with the failure.
 *
 * A fenced store is fenced here exactly as on the Promise engine: the check is
 * one of the built-ins both engines run.
 *
 * ```ts
 * const program = Effect.gen(function* () {
 *   const handle = yield* run(machine, {
 *     interpret: {
 *       fetch: (cmd) =>
 *         Effect.gen(function* () {
 *           const api = yield* Api;
 *           return yield* api.get(cmd.id);
 *         }),
 *     },
 *   });
 *   const runtime = yield* handle.ready;
 *   yield* runtime.dispatch({ type: "go", id: "7" });
 *   return runtime.getState();
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
  EffectBootingRuntime<S, M, E, CellErrors<C, I>>,
  never,
  Scope.Scope | InterpretServices<I> | SubscribeServices<B>
> {
  return Effect.gen(function* () {
    const services = yield* Effect.context<
      InterpretServices<I> | SubscribeServices<B>
    >();
    const scope = yield* Scope.Scope;
    const fork = Effect.runForkWith(services) as ForkEffect;
    return yield* Effect.acquireRelease(
      Effect.sync(() =>
        effectHandle<S, M, E, CellErrors<C, I>>(
          start<S, M, C, U, Ctx, E>(
            machine,
            opts as EffectRunOptions<S, M, C, U, Ctx, E, unknown, unknown>,
            Effect.runPromiseExitWith(services) as RunEffect,
            fork,
            // Closing the Scope runs the release below, which stops the run.
            // A Scope that closes before that release is added runs it on add.
            (exit) => fork(Scope.close(scope, exit)),
          ),
        ),
      ),
      (runtime) => runtime.stop(),
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
  closeScope: (exit: Exit.Exit<never, unknown>) => void,
): Runtime<S, M, E> & LiveWorkProbe {
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

  // Interrupted by stop, a cell settles to nothing. A defect throws: for a
  // defined Cmd the `Cmd.define` edge routes it to the error sink, for a
  // hand-written one it rejects the dispatch. A hand-written cell's failure is
  // marked, so the handle fails the dispatch with it as a typed error.
  async function settle(cell: AnyCell, cmd: unknown): Promise<unknown> {
    const type = (cmd as { type: string }).type;
    const exit = await runEffect(cellResult(cell(cmd)), {
      signal: interruption.signal,
    });
    return settleCellExit(exit, defined.has(type));
  }

  function handlerFor(type: string): LoopHandler<M> | undefined {
    const cell = interpret[type];
    if (cell === undefined) return undefined;
    return (cmd) => settle(cell, cmd);
  }

  // The Cause the run's Scope closes with when a Sub fails: the Stream's own
  // when a Stream failed, else the runner's throw as a defect.
  let subFailure: Cause.Cause<unknown> | undefined;

  // A runner's Msgs reach the loop through its `dispatch`, which queues each
  // one behind the step in progress — never a transition on the stream's own
  // fiber (spike #260). A Stream that fails with anything but an interrupt
  // failed with an error the Sub did not map to a Msg, and the run stops
  // (#309).
  function runnerFor(type: string): LoopRunner<Ctx, M> | undefined {
    const make = subscribe[type] ?? builtins[type];
    if (make === undefined) return undefined;
    return (sub, _ctx, dispatch, fail) => {
      const drain = Stream.runForEach(make(sub), (msg) =>
        Effect.sync(() => dispatch(msg as M)),
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.sync(() => {
                subFailure ??= cause;
                fail(Cause.squash(cause));
              }),
        ),
      );
      const fiber = fork(drain);
      return () => Effect.runPromise(Fiber.interrupt(fiber));
    };
  }

  // The sink is handed what was thrown, never the edge's marker around it.
  const sink = opts.onError ?? defaultOnError;

  const handle = startLoop<S, M, C, Ctx>({
    init: machine.init,
    reduce: (state, msg) => applyCell<S, M, C>(machine, state, msg),
    subs: subEntriesOf<S>(machine),
    runnerFor,
    handlerFor,
    store: opts.store,
    ctx: (opts.ctx ?? {}) as Ctx,
    onError: (error, context) => sink(unwrapped(error), context),
    disposeTimeoutMs: opts.disposeTimeoutMs ?? 5_000,
    idleCap: 100_000,
    // The save marker wraps outermost, around the fence the built-ins add.
    extensions: [
      saveFailures<S, M, C>(),
      ...builtinExtensions<S, M, C, E>(machine, opts),
    ],
    stopOnSubFailure: (error) =>
      closeScope(Exit.failCause(subFailure ?? Cause.die(error))),
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
  return handle as unknown as Runtime<S, M, E> & LiveWorkProbe;
}
