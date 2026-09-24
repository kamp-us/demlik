// ---------------------------------------------------------------------------
// `drive(machine, initial, msg, interpret, opts)` for the Effect engine: the
// Promise `drive`'s rounds, trace and bound, over the Effect engine's handlers
// and Subs (#321).
//
// There is no second loop. Each Effect cell is adapted into the shared loop's
// cell with the settle rule the engine itself uses (`settleCellExit` in
// `src/effect/run.ts`), run with the services the caller provided, so a cell
// settles here exactly as it does under `run`. The Subs the machine wants are
// started and stopped after every fold, as the engine reconciles them, and
// their Msgs are folded once the Cmds in flight have settled.
// ---------------------------------------------------------------------------

import { Cause, Effect, Exit, Fiber, Stream } from "effect";
import { CellFailure } from "../../effect/failures";
import {
  builtinRunners,
  type CellErrors,
  cellResult,
  type EffectInterpret,
  type EffectSubscribe,
  type InterpretServices,
  type SubscribeOption,
  type SubscribeServices,
  settleCellExit,
} from "../../effect/run";
import type { Cmd, Machine, Sub } from "../../pure/core";
import {
  annotateTrace,
  DEFAULT_MAX_ROUNDS,
  type DriveCell,
  DriveNoHandlerError,
  type DriveOptions,
  type DriveResult,
  DriveRoundsExceededError,
  type DriveSubs,
  desiredSubs,
  driveContractOf,
  driveLoop,
  driveTraceOf,
} from "../drive-loop";

/**
 * The Effect `drive`'s options: the Promise `drive`'s, plus `subscribe` — the
 * runners the engine's `run` takes, required exactly when `run` requires them.
 */
export type EffectDriveOptions<U extends Sub, Ctx, B> = DriveOptions<Ctx> &
  SubscribeOption<U, B>;

/** The failures a drive ends with: the loop's own, and a hand-written cell's. */
export type EffectDriveError<M, C extends Cmd, I> =
  | DriveRoundsExceededError<M, C>
  | DriveNoHandlerError<M, C>
  | CellErrors<C, I>;

/** The drive was interrupted; nothing is left to run. */
class DriveInterrupted {}

type AnyCell = (cmd: unknown) => Effect.Effect<unknown, unknown>;
type AnyRunner = (sub: Sub) => Stream.Stream<unknown, unknown>;
type RunEffect = (
  effect: Effect.Effect<unknown, unknown>,
  options: { readonly signal: AbortSignal },
) => Promise<Exit.Exit<unknown, unknown>>;
type ForkEffect = (
  effect: Effect.Effect<unknown, unknown>,
) => Fiber.Fiber<unknown, unknown>;

/**
 * Drive `machine` from `initial` through `msg` against the REAL Effect
 * `interpret` map — the one a host hands the Effect engine's `run` — and the
 * Subs the machine wants, feeding every Msg back until the machine goes quiet.
 * Yields the settled state together with the whole history, `{ state, trace }`.
 *
 * The rounds, the trace, `maxRounds` and `clock` are the Promise `drive`'s
 * (`@demlik/tea/testing/promise`). What is the Effect engine's:
 *
 *   - a cell returns an Effect. A `Cmd.define`d Cmd's success mints `_ok` and
 *     its declared failure `_err`; a hand-written Cmd's success is its
 *     follow-up — a Msg, a list of them folded in order, or nothing (#324) —
 *     and its failure fails the drive, typed. A defect dies. A cell takes no
 *     `dispatch`, so a defined Cmd's handler cannot send its own `_ok` /
 *     `_err`: the engine's rule holds by construction;
 *   - the services the cells and runners read are this Effect's requirements,
 *     so a test provides them the way a host does: `Effect.provide(layer)`;
 *   - the Subs the machine wants run, through `opts.subscribe` or the engine's
 *     built-in runner, started and stopped after every fold. Their Msgs are
 *     folded once no Cmd's follow-up is pending. The drive settles once no Msg
 *     is pending and no Sub is still running, so hand it a runner whose Stream
 *     ends — a Sub that never ends keeps it waiting. A Stream that fails with
 *     an error it did not map to a Msg dies, as it stops the engine's run.
 *
 * Interrupting the drive interrupts every cell and Sub still running.
 *
 * ```ts
 * const { state, trace } = await Effect.runPromise(
 *   drive(machine, initial, { type: "go" }, {
 *     fetch: (cmd) =>
 *       Effect.gen(function* () {
 *         const api = yield* Api;
 *         return yield* api.get(cmd.id);
 *       }),
 *   }).pipe(Effect.provide(ApiTest)),
 * );
 * ```
 *
 * Fails with {@link DriveRoundsExceededError} when the machine is still
 * emitting work after `opts.maxRounds` rounds, {@link DriveNoHandlerError}
 * for a Cmd no cell answers, or a hand-written cell's own failure — each with
 * the partial trace, readable via `driveTraceOf`.
 */
export function drive<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  // The defaults read no services, so an omitted map adds none to `R`.
  I extends EffectInterpret<M, C> = EffectInterpret<M, C, never>,
  B extends EffectSubscribe<M, U> = EffectSubscribe<M, U, never>,
>(
  machine: Machine<S, M, C, U, Ctx>,
  initial: S,
  msg: M,
  interpret: I,
  ...[opts]: Record<never, never> extends EffectDriveOptions<U, Ctx, B>
    ? [opts?: EffectDriveOptions<U, Ctx, B>]
    : [opts: EffectDriveOptions<U, Ctx, B>]
): Effect.Effect<
  DriveResult<S, M, C>,
  EffectDriveError<M, C, I>,
  InterpretServices<I> | SubscribeServices<B>
> {
  const options = (opts ?? {}) as {
    ctx?: Ctx;
    maxRounds?: number;
    clock?: () => number;
    subscribe?: Readonly<Record<string, AnyRunner | undefined>>;
  };
  return Effect.gen(function* () {
    const services = yield* Effect.context<
      InterpretServices<I> | SubscribeServices<B>
    >();
    const runEffect = Effect.runPromiseExitWith(services) as RunEffect;
    const fork = Effect.runForkWith(services) as ForkEffect;

    return yield* Effect.callback<
      DriveResult<S, M, C>,
      EffectDriveError<M, C, I>
    >((resume, signal) => {
      const cells = interpret as unknown as Readonly<
        Record<string, AnyCell | undefined>
      >;
      const defined = new Set((machine.cmds ?? []).map((def) => def.cmdType));
      const cellFor = (type: string): DriveCell<M, C> | undefined => {
        const cell = cells[type];
        if (cell === undefined) return undefined;
        return async (cmd) => {
          const exit = await runEffect(cellResult(cell(cmd)), { signal });
          if (signal.aborted) throw new DriveInterrupted();
          return settleCellExit(exit, defined.has(type));
        };
      };

      driveLoop(
        machine,
        initial,
        msg,
        options.ctx as Ctx,
        options.maxRounds ?? DEFAULT_MAX_ROUNDS,
        {
          contract: driveContractOf(machine, options.clock ?? Date.now),
          cellFor,
          subs: effectSubs<S, M>(
            machine,
            options.subscribe ?? {},
            fork,
            signal,
          ),
        },
      ).then(
        (result) => resume(Effect.succeed(result)),
        (error: unknown) => resume(failureOf<M, C, I>(error)),
      );
    });
  });
}

/**
 * Sort what left the loop: its own failures and a hand-written cell's failure
 * are typed, everything else — a defect, a contract breach, a failed Sub — dies.
 */
function failureOf<M, C extends Cmd, I>(
  error: unknown,
): Effect.Effect<never, EffectDriveError<M, C, I>> {
  if (
    error instanceof DriveRoundsExceededError ||
    error instanceof DriveNoHandlerError
  ) {
    return Effect.fail(error as EffectDriveError<M, C, I>);
  }
  if (error instanceof CellFailure) {
    annotateTrace(error.failure, driveTraceOf(error) ?? []);
    return Effect.fail(error.failure as EffectDriveError<M, C, I>);
  }
  if (error instanceof DriveInterrupted) return Effect.interrupt;
  return Effect.die(error);
}

/**
 * One started Sub. It stays registered while the machine wants it, even after
 * its Stream ends, so a Sub that finished is not started again — the engine
 * keeps it the same way. `stopped` drops any Msg that arrives after a fold
 * turned it off; `ended` says its Stream no longer runs.
 */
interface StartedSub {
  stopped: boolean;
  ended: boolean;
  fiber?: Fiber.Fiber<unknown, unknown>;
}

/**
 * The Effect engine's Subs as the shared loop runs them: each wanted Sub's
 * Stream is drained on its own fiber into a buffer the loop reads between
 * rounds.
 */
function effectSubs<S, M>(
  machine: { readonly subs?: ReadonlyArray<unknown> },
  subscribe: Readonly<Record<string, AnyRunner | undefined>>,
  fork: ForkEffect,
  signal: AbortSignal,
): DriveSubs<S, M> {
  const builtins = builtinRunners as unknown as Readonly<
    Record<string, AnyRunner | undefined>
  >;
  const started = new Map<string, StartedSub>();
  let buffered: M[] = [];
  let failed: Cause.Cause<unknown> | undefined;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    const woken = wake;
    wake = undefined;
    woken?.();
  };
  signal.addEventListener("abort", notify, { once: true });

  const stop = (sub: StartedSub): Promise<void> => {
    sub.stopped = true;
    return sub.ended || sub.fiber === undefined
      ? Promise.resolve()
      : Effect.runPromise(Fiber.interrupt(sub.fiber));
  };
  const anyRunning = (): boolean =>
    [...started.values()].some((sub) => !sub.ended);

  return {
    reconcile(state) {
      const desired = desiredSubs(machine, state);
      for (const [id, sub] of started) {
        if (desired.has(id)) continue;
        started.delete(id);
        void stop(sub);
      }
      for (const [id, sub] of desired) {
        if (started.has(id)) continue;
        const make = subscribe[sub.type] ?? builtins[sub.type];
        if (make === undefined) {
          throw new Error(
            `@demlik/tea: no subscribe runner for Sub type "${sub.type}". ` +
              "Pass one to drive in `subscribe`.",
          );
        }
        const entry: StartedSub = { stopped: false, ended: false };
        started.set(id, entry);
        entry.fiber = fork(
          Stream.runForEach(make(sub), (next) =>
            Effect.sync(() => {
              if (entry.stopped) return;
              buffered.push(next as M);
              notify();
            }),
          ).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                entry.ended = true;
                if (
                  !entry.stopped &&
                  Exit.isFailure(exit) &&
                  !Cause.hasInterruptsOnly(exit.cause)
                ) {
                  failed ??= exit.cause;
                }
                notify();
              }),
            ),
          ),
        );
      }
    },
    async next() {
      for (;;) {
        if (signal.aborted) throw new DriveInterrupted();
        if (buffered.length > 0) {
          const out = buffered;
          buffered = [];
          return out;
        }
        if (failed !== undefined) throw Cause.squash(failed);
        if (!anyRunning()) return undefined;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    async close() {
      signal.removeEventListener("abort", notify);
      const stopping = [...started.values()].map(stop);
      started.clear();
      await Promise.all(stopping);
    },
  };
}
