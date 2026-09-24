/**
 * @demlik/tea runtime — `run`: boot a machine and drive its serial dispatch loop
 * on Promises; `driveToDone`: run one to its terminal State.
 *
 * `run` is assembly. The loop itself is `src/internal/engine/loop.ts` — a small
 * core with no special case for any built-in, shared with the Effect engine —
 * and every built-in is an extension of it (`src/internal/engine/builtins.ts`),
 * built from `run`'s options in the order both engines share.
 */

import { builtinExtensions } from "../internal/engine/builtins";
import {
  type LiveWorkProbe,
  type LoopHandler,
  type LoopRunner,
  liveWork,
  startLoop,
} from "../internal/engine/loop";
import type { Interpret, Machine, RunHandlers, Sub } from "../pure/core";
import { applyCell, type Cmd, subEntriesOf } from "../pure/core";
import type {
  BootingRuntime,
  CtxArg,
  OnError,
  Store,
  Supervision,
  TelemetrySink,
} from "../runtime-types";
import { DriveFailedError, DriveStalledError } from "../runtime-types";
import { builtinRunners } from "./builtin-runners";

// === run ===
//
// Returns a `BootingRuntime<S, M>` synchronously; boot runs as the FIRST entry
// on the serial dispatch tail, awaited implicitly by every public method.
//
// Save-then-effects ordering is structural: every transition mutates state,
// awaits `store.save(newState)`, then reconciles subscriptions, then runs
// `interpret` for emitted cmds, then fires external listeners. The listeners
// fire even when a Cmd handler throws: the dispatch rejects with the handler's
// error, and every listener, observer, `on` handler and `done()` waiter still
// hears the State that was installed and saved (#311). A throw in any effect
// phase leaves the persisted state ahead of the host's belief about what
// executed — the Railway discipline (`tryInterpret` in handlers) makes that
// safe in practice.
export function run<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  E extends { type: string } = never,
>(
  machine: Machine<S, M, C, U, Ctx>,
  // `ctx` is a plain object (ADR 0020): tea does no dependency injection, so
  // a handler's services are whatever the host put on it. The Cmd handlers
  // arrive here, beside the machine and never on it (#251 R1.1). `NoInfer`
  // keeps them a check against the machine's `M` / `C` rather than a second
  // inference site that could widen either.
  opts: CtxArg<Ctx> &
    NoInfer<RunHandlers<M, C, U, Ctx>> & {
      store?: Store<S>;
      onError?: OnError;
      /**
       * The clock that stamps `at` on a `Cmd.define`d effect's settled Msg at
       * the interpret edge, and on each `telemetry` event. Defaults to
       * `Date.now`. Inject a fixed one for a deterministic run; a `replay` log
       * carries its own `at`s and never reads this.
       */
      clock?: () => number;
      /**
       * The SEMANTIC event projector. Maps one APPLIED transition `(msg, state)`
       * to zero-or-more public events of `E`; `[]` skips the transition. Maps the
       * machine's PRIVATE Msg vocabulary to NAMED events — the private names never
       * reach `on`'s `E` surface. Omit → `E = never` and `on` is uncallable. PURE.
       */
      events?: (msg: M, state: S) => readonly E[];
      /**
       * Declared policy for a reducer (`update`) throw. Always surfaced via
       * `onError` (`phase: "reduce"`); the strategy decides what the runtime does
       * next. Defaults to `"stop"`. See `Supervision`.
       */
      supervision?: Supervision<S, M>;
      /**
       * The run-terminality predicate — makes the run's outcome first-class. Fed to
       * `Runtime.result()` and `Runtime.done()`. PURE. Omit → never terminal.
       */
      terminal?: (state: S) => boolean;
      /**
       * A sink handed `{ seq, msgType, at }` for every applied transition —
       * the observe-only telemetry `withTelemetry` used to add by wrapping the
       * machine (#268). Fire-and-forget; see {@link TelemetrySink}.
       */
      telemetry?: TelemetrySink;
      /**
       * How long `stop()` waits for teardown work that returned a Promise (an
       * async `release` in `defineManagedResource`, an async Sub cleanup) before
       * giving up on it. Defaults to 5_000ms.
       *
       * `stop()` awaits those disposals so a host doing
       * `await runtime.stop(); env.evict()` cannot drop the isolate mid-release —
       * the leak the managed-resource battery exists to prevent, relocated to
       * shutdown. The bound is what keeps a release that never settles from
       * hanging the host: on expiry `stop()` reports a `DisposeTimeoutNotice`
       * (warn-only, like every `RuntimeDiscardNotice`) and resolves anyway,
       * because `stop()` resolving is a contract.
       */
      disposeTimeoutMs?: number;
      /**
       * Iteration cap for `idle()`'s quiescence wait. Defaults to 100_000. Test
       * seam only. Production code must not set it.
       *
       * @internal test-only
       */
      __idleCap?: number;
    },
): BootingRuntime<S, M, E> {
  // `interpret` is optional when `C extends Cmd<never>`; default a missing map
  // to `{}` — a Cmd with no handler is skipped, invariant 6's forward progress
  // for a miswired consumer.
  const interpretMap = ((opts as { interpret?: Interpret<M, C, Ctx> })
    .interpret ?? {}) as Readonly<Record<string, LoopHandler<M> | undefined>>;

  // The runner for a Sub type: the one handed to `run` in `subscribe`, else
  // the engine's built-in of that name (#270 — a user entry overrides a
  // built-in). Looked up per start rather than merged once, so a handler table
  // that resolves its cells lazily (`/react` reads the latest render's) is
  // honoured.
  const subscribeTable = (opts as { subscribe?: unknown }).subscribe as
    | Readonly<Record<string, LoopRunner<Ctx, M> | undefined>>
    | undefined;
  const builtins = builtinRunners as Readonly<
    Record<string, LoopRunner<Ctx, M> | undefined>
  >;

  const handle = startLoop<S, M, C, Ctx>({
    init: machine.init,
    reduce: (state, msg) => applyCell<S, M, C>(machine, state, msg),
    subs: subEntriesOf<S>(machine),
    runnerFor: (type) => subscribeTable?.[type] ?? builtins[type],
    handlerFor: (type) => interpretMap[type],
    store: opts.store,
    // `ctx` is conditionally optional (see `CtxArg`); default the nullish case
    // to `{}` so the handler ctx and `init(loaded, ctx)` get a value.
    ctx: (opts.ctx ?? {}) as Ctx,
    onError: opts.onError,
    disposeTimeoutMs: opts.disposeTimeoutMs ?? 5_000,
    idleCap: opts.__idleCap ?? 100_000,
    extensions: builtinExtensions<S, M, C, E>(machine, opts),
  });
  return handle as unknown as BootingRuntime<S, M, E> & LiveWorkProbe;
}

/**
 * Is the runtime provably out of ways to transition on its own? True only when
 * the handle carries the `liveWork` read and it counts zero live Subs and zero
 * in-flight Cmds. A handle without the read (a wrapper that rebuilt the object
 * without spreading it) cannot be proven stalled, so the drive keeps waiting —
 * the pre-#68 contract, never a false stall.
 */
function isStalled(runtime: object): boolean {
  const probe = (runtime as Partial<LiveWorkProbe>)[liveWork];
  if (probe === undefined) return false;
  const live = probe();
  return live.subs === 0 && live.cmds === 0;
}

/**
 * The outside-in stop, as a PAIR. A signal is only cancellation if something can
 * turn "aborted" into a transition this machine understands, and the kernel has
 * no built-in cancel Msg any more than it has a built-in terminal set — so the
 * `signal` and the `cancel` that reads it are one option, present together or
 * absent together. A discriminated union rather than two optional fields, on the
 * same reasoning as `AgentCompactionConfig`: a signal with no `cancel` is a stop
 * button wired to nothing, and that is a state worth making unrepresentable
 * rather than checking for.
 */
type DriveCancellation<S, M> =
  | {
      readonly signal?: undefined;
      readonly cancel?: undefined;
    }
  | {
      /**
       * Abort the run through this signal. On abort the drive dispatches
       * `cancel`'s Msg and resolves on the State that lands — it does NOT reject,
       * and a cancellation is never a `DriveFailedError`. Already aborted when
       * the drive is called → the cancel Msg goes in place of `start`, so the
       * run ends without the start's effects ever firing.
       */
      readonly signal: AbortSignal;
      /**
       * The Msg that settles this machine as cancelled, chosen off the current
       * State exactly as `start` is. PURE. It must land a State `isTerminal`
       * holds for — the drive resolves on the terminal predicate, not on the
       * abort — and that State should be DURABLE, or a reload resumes the run
       * its caller stopped.
       */
      readonly cancel: (state: S) => M;
    };

/** Options for `driveToDone`. */
export type DriveToDoneOptions<
  S,
  M extends { type: string } = never,
> = DriveCancellation<S, M> & {
  /**
   * Marks a terminal State as a FAILURE. A State this holds for ends the drive
   * like any terminal one — the runtime is stopped — but the drive REJECTS with
   * `DriveFailedError` carrying it instead of resolving. A failed State is
   * terminal by definition; it need not also satisfy `isTerminal`. Omit → the
   * drive never rejects on State, only on a runtime error.
   */
  readonly failed?: (state: S) => boolean;
};

/**
 * Drive a machine from `start` to its terminal State in one call, then tear the
 * runtime down. The one-shot shape every "run this machine to done" test and
 * caller boundary otherwise hand-wires as six steps — `await ready`, `observe`,
 * park a promise, `dispatch(start)`, `getState()`, `stop()` — with the observer
 * leak and the forgotten `stop` those six steps invite.
 *
 * Takes the handle `run()` returns (a `Runtime` extends it, so a booted one is
 * accepted too), awaits `ready`, dispatches `start`, and resolves with the first
 * State for which `isTerminal` holds. A machine that boots already terminal (a
 * rehydrated finished run) resolves on its boot State and `start` is never
 * dispatched — a finished run has nothing to set in motion. `start` may be a
 * function of the boot State instead of a Msg: a machine rehydrated MID-run
 * needs its resume Msg, not its start Msg, and only the boot State says which
 * (the agent's `agent_boot` vs `agent_start` is the case in point). The
 * observer is detached and `stop()` awaited on EVERY exit: resolve, `failed`,
 * a stall, a boot or dispatch throw, the quiescence cap.
 *
 * Rejections are typed, never silent:
 *   - `DriveFailedError<S>` when `opts.failed` marks the final State — the State
 *     rides on `error.state`.
 *   - `DriveStalledError<S>` when `start`'s follow-up chain quiesces on a State
 *     that is neither terminal nor `failed` and the runtime has no live Sub and
 *     no Cmd in flight — nothing inside it can deliver another transition, so
 *     waiting would be a hang with the runtime leaked. The stalled State rides
 *     on `error.state`. A machine that CAN still move is not stalled: a live Sub
 *     that delivers the terminal Msg after the dispatch
 *     quiesces keeps the drive waiting, and it resolves on that State. What the
 *     runtime cannot see — a dispatch from outside it after quiescence — does
 *     not count as live; a machine that depends on one declares it as a Sub.
 *   - `QuiescenceTimeoutError` when `start`'s follow-up chain never settles —
 *     the SAME cap `dispatch` and `idle()` already reject on (invariant 6), not a
 *     second clock. A livelocking machine surfaces as its own failure class.
 *   - the boot error, or whatever `dispatch(start)` rejects with, otherwise.
 *
 * `isTerminal` is caller-supplied, exactly as `run()`'s `terminal` option is —
 * the kernel has no built-in terminal-set concept and this does not add one.
 *
 * Cancellation is the same story: `{ signal, cancel }` stops the drive from
 * outside, and it settles the run rather than escaping it. On abort the drive
 * dispatches `cancel`'s Msg and RESOLVES on the terminal State that transition
 * lands — no rejection, no `DriveFailedError`, no `AbortError`. That is the whole
 * point of routing a stop through the Model: the outcome is durable, so a killed
 * process resumes reading a run that ended instead of restarting one someone
 * stopped. A cancel that THROWS is the one abort that rejects: it lands
 * no State, so its error is what the drive has to report — and that holds
 * whether the `cancel` function throws synchronously or the fold it produced
 * throws later, since both leave the run with no State to settle on. A State the
 * caller's `failed` predicate marks rejects on an abort exit exactly as it does
 * anywhere else. In-flight effects are not recalled — a promise cannot be cancelled —
 * so they settle to their own end and `stop()` drains them as it always did;
 * keeping their results off the public channels is the machine's own business.
 * Omit the pair and every path here behaves exactly as it did before.
 *
 * @param handle     the handle `run(machine, opts)` returned.
 * @param start      the Msg that sets the run in motion, or a function choosing
 *                   it off the boot State. PURE.
 * @param isTerminal the terminal predicate over the machine's State. PURE.
 * @param opts       an optional `failed` predicate and an optional
 *                   `{ signal, cancel }` pair (see {@link DriveToDoneOptions}).
 */
export async function driveToDone<
  S,
  M extends { type: string },
  E extends { type: string } = never,
>(
  handle: BootingRuntime<S, M, E>,
  start: M | ((booted: S) => M),
  isTerminal: (state: S) => boolean,
  opts: DriveToDoneOptions<S, M> = {},
): Promise<S> {
  const failed = opts.failed ?? (() => false);
  const settles = (state: S): boolean => isTerminal(state) || failed(state);
  let detach: (() => void) | undefined;
  let unlisten: (() => void) | undefined;
  try {
    const runtime = await handle.ready;
    // A run that rehydrated already terminal has nothing to start: resolve on
    // the boot State without dispatching, so `start`'s Cmds are never left in
    // flight for `stop()` to discard. Read BEFORE the signal so a run that
    // already ended keeps the outcome it ended on — an abort arriving after the
    // fact does not restate a finished run as cancelled.
    const booted = runtime.getState();
    // The one exit check every branch below shares: a State the caller's
    // `failed` predicate marks rejects, wherever the drive reached it.
    const outcome = (state: S): S => {
      if (failed(state)) throw new DriveFailedError(state);
      return state;
    };
    if (settles(booted)) return outcome(booted);
    // Attach BEFORE dispatching so a terminal transition landing inside the
    // start dispatch is caught.
    const terminal = new Promise<S>((resolve) => {
      detach = runtime.observe((_msg, state) => {
        if (settles(state)) resolve(state);
      });
    });
    // An abort mid-run enqueues the cancel Msg on the SAME serial tail every
    // other dispatch uses, so it lands between transitions rather than inside
    // one. Work already enqueued when the abort arrives still folds; work the
    // machine would have enqueued after it does not, because the cancelled State
    // is terminal and its verbs stop emitting. `dispatchOnce` (not `dispatch`)
    // because the cancel has no follow-up chain to drain. Its rejection is NOT
    // swallowed: only the cancel fold can land the terminal State on an abort,
    // so a cancel that throws leaves `terminal` with nothing to resolve it and
    // the drive would park forever (#170). `cancelFailed` carries that rejection
    // into whichever race the branch below awaits.
    let cancelFailed: Promise<never> | undefined;
    if (opts.signal !== undefined) {
      const { signal, cancel } = opts;
      let onCancelError!: (error: unknown) => void;
      cancelFailed = new Promise<never>((_resolve, reject) => {
        onCancelError = reject;
      });
      // The try covers the SYNCHRONOUS call site too, not just the dispatch it
      // returns: a caller-supplied `cancel` that throws before it ever produces
      // a Msg would otherwise escape this listener, and a listener's throw goes
      // nowhere — no caller frame to catch it, `terminal` still unresolved, the
      // drive parked exactly as #170 described (#174). Both throws are the same
      // fact — the cancel fold could not land a State — so both take the one
      // route out through `onCancelError`.
      const onAbort = () => {
        try {
          runtime.dispatchOnce(cancel(runtime.getState())).catch(onCancelError);
        } catch (error) {
          onCancelError(error);
        }
      };
      // Already aborted → cancel INSTEAD of starting, so `start`'s effects (a
      // model call, for the agent) never fire at all.
      if (signal.aborted) {
        onAbort();
        return outcome(await Promise.race([terminal, cancelFailed]));
      }
      signal.addEventListener("abort", onAbort, { once: true });
      unlisten = () => signal.removeEventListener("abort", onAbort);
    }
    // The race lets a dispatch rejection (reducer / interpret throw, the
    // quiescence cap) surface here instead of floating as an unhandled rejection
    // while the terminal await parks forever.
    const msg = typeof start === "function" ? start(booted) : start;
    const started = runtime.dispatch(msg).then(() => {
      // Quiesced. A settling State already went through the observer, so
      // `terminal` is resolved; otherwise the wait is legitimate only while the
      // runtime itself can still transition. With no live Sub and no Cmd in
      // flight nothing is coming, and the wait becomes the hang #68 names.
      const parked = runtime.getState();
      if (!settles(parked) && isStalled(runtime)) {
        throw new DriveStalledError(parked);
      }
      return terminal;
    });
    // `cancelFailed` rides the race for the mid-run abort: `started` cannot
    // carry the cancel's rejection, having usually resolved long before the
    // abort arrives.
    const racers: Promise<S>[] = [terminal, started];
    if (cancelFailed !== undefined) racers.push(cancelFailed);
    return outcome(await Promise.race(racers));
  } finally {
    detach?.();
    // The abort listener outlives this call unless it is removed: a signal a
    // caller reuses across runs would otherwise accumulate one dispatch per run
    // it has already finished.
    unlisten?.();
    // `stop()` resolves by contract, so awaiting it here cannot mask the error
    // a rejecting branch above is carrying.
    await handle.stop();
  }
}
