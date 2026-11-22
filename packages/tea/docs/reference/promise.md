# @demlik/tea/promise

> the Promise engine: `run` boots a machine and drives its serial dispatch loop on Promises, `driveToDone` runs one to its terminal state, and `tell` puts a Msg on a run's line without waiting for it.

Tier: `stable`

```ts
import { … } from "@demlik/tea/promise";
```

## Exports (8)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`BootingRun`](#BootingRun) | Interface | stable | The handle `run` returns: a BootingRuntime whose `ready` resolves to a Run. |
| [`driveToDone`](#driveToDone) | Function | stable | Drive a machine from `start` to its terminal State in one call, then tear the runtime down. |
| [`DriveToDoneOptions`](#DriveToDoneOptions) | Type | stable | Options for `driveToDone`. |
| [`PromiseRunOptions`](#PromiseRunOptions) | Type | stable | The options of the Promise engine's `run`. |
| [`run`](#run) | Function | stable | Start a machine on the Promise engine and return its runtime. |
| [`Run`](#Run) | Interface | stable | What a BootingRun's `ready` resolves to: a booted Runtime that also carries the run's line, which is what `tell` asks for. |
| [`tell`](#tell) | Function | stable | Put `msg` on a run's line and return at once. |
| [`TellAnswer`](#TellAnswer) | Type | stable | What `tell` answers, at once, about the Msg it was handed. |

## Declarations

<a id="BootingRun"></a>

### `BootingRun`

```ts
interface BootingRun<S, M extends { _tag: string }, E extends { _tag: string } = never> extends BootingRuntime<S, M, E> {
  /**
   * Resolves to the booted `Runtime<S, M>` after boot completes (or rejects with
   * the boot error). This is the ONLY way to obtain a `Runtime` — and a
   * `Runtime` is the only handle whose `getState()` is total. Awaiting `ready` is
   * the single gate between "boot in flight" and "State exists":
   *
   * ```ts
   * const runtime = await run(machine, opts).ready;
   * runtime.getState(); // total — never throws-before-boot
   * ```
   *
   * Idempotent — the same settled promise, resolving to the same `Runtime`, comes
   * back on every read. Expresses canon §2.3 (boot is a named, awaitable moment).
   */
  ready: Promise<Run<S, M, E>>;
}
```

<a id="driveToDone"></a>

### `driveToDone`

```ts
function driveToDone<
  S,
  M extends { _tag: string },
  E extends { _tag: string } = never,
>(
  handle: BootingRuntime<S, M, E>,
  start: M | ((booted: S) => M),
  isTerminal: (state: S) => boolean,
  opts?: DriveToDoneOptions<S, M>,
): Promise<S>
```

<a id="DriveToDoneOptions"></a>

### `DriveToDoneOptions`

```ts
type DriveToDoneOptions<S, M extends { _tag: string } = never> = DriveCancellation<S, M> & {
  /**
   * Marks a terminal State as a FAILURE. A State this holds for ends the drive
   * like any terminal one — the runtime is stopped — but the drive REJECTS with
   * `DriveFailedError` carrying it instead of resolving. A failed State is
   * terminal by definition; it need not also satisfy `isTerminal`. Omit → the
   * drive never rejects on State, only on a runtime error. A Cmd handler that
   * throws is one: the drive rejects with that error itself, whichever hop it
   * threw on.
   */
  readonly failed?: (state: S) => boolean;
}
```

<a id="PromiseRunOptions"></a>

### `PromiseRunOptions`

```ts
type PromiseRunOptions<
  S,
  M extends { _tag: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  E extends { _tag: string },
> = CtxArg<Ctx> & NoInfer<RunHandlers<M, C, U, Ctx>> & StoreAndOnError<S> & {
  /**
   * How the run starts. Omit it and nothing changes: `init` folds the loaded
   * State, the engine saves what `init` returned, runs `init`'s Cmds, and
   * `stop()` saves the last State once more (ADR 0028).
   *
   * `"restored"` is for a host that already knows this start is a wake, not
   * a new process: a Durable Object woken by its next Msg, a request handler.
   * With a loaded State, `init` still folds it, but its Cmds are not run and
   * nothing is written at boot while `init` returns the loaded State itself.
   * A transition still saves before its Cmds run. `stop()` skips its save
   * only while the State is the one the store is known to hold (the loaded
   * State or the last one a save accepted), and a refused save clears that,
   * because the store may have written before it failed. So a start that
   * changed nothing writes nothing and, on a fenced store, takes no turn at
   * the fence. With nothing saved, `init(null)` runs, its Cmds run and its
   * State is saved. A store with a durable log, or no store, is not changed
   * by it (ADR 0039).
   */
  boot?: "restored";
  /**
   * Stop the run from outside, for a host that holds the runtime itself. Once
   * `signal` aborts the runtime queues `cancel`'s Msg, starts no further Cmd and
   * stops waiting on the handler in flight, which a promise cannot recall; what
   * that handler returns later reaches no one. A signal that is already aborted,
   * or aborts while the store is loading, settles the cancel before `ready`
   * resolves, so a host reading `ready` sees a run that ended and resumes
   * nothing. `cancel` is chosen off the State, and PURE; it must land a State
   * the run does not resume from. A `cancel` that throws is reported to
   * `onError`. A pair, so a signal with no `cancel` cannot be written. Not
   * available with a store that keeps a log: `run` throws.
   *
   * `driveToDone` takes the same pair to stop a run it drives.
   */
  cancellation?: {
    readonly cancel: (state: S) => M;
    readonly signal: AbortSignal;
  };
  /**
   * The clock that stamps `at` on a `Cmd.define`d effect's settled Msg at
   * the interpret edge, and on each `telemetry` event. Defaults to
   * `Date.now`. Inject a fixed one for a deterministic run; a `replay` log
   * carries its own `at`s and never reads this.
   */
  clock?: () => number;
  /**
   * How long `stop()` waits for work it cannot interrupt before giving up
   * on it. Defaults to 5_000ms. It bounds two waits, one after the other:
   * the queue, where a Cmd handler may still be running, and then the
   * teardown work that returned a Promise (an async `release` in
   * `defineManagedResource`, an async Sub cleanup).
   *
   * `stop()` awaits those disposals so a host doing
   * `await runtime.stop(); env.evict()` cannot drop the isolate mid-release —
   * the leak the managed-resource battery exists to prevent, relocated to
   * shutdown. The bound is what keeps a handler that never returns, or a
   * release that never settles, from hanging the host: on expiry `stop()`
   * reports a `DrainTimeoutNotice` or a `DisposeTimeoutNotice` (warn-only,
   * like every `RuntimeDiscardNotice`) and resolves anyway, because `stop()`
   * resolving is a contract (ADR 0025). The Subs are still stopped and the
   * final save still runs, except that a run started with `boot: "restored"`
   * skips it while the State is the one the store is known to hold. A
   * handler `stop()` gave up on keeps running; what it returns later is
   * dropped.
   *
   * tea starts no store call after `stop()` has returned. A store call
   * already under way when `stop()` gave up is not cancelled and can
   * finish after `stop()` has returned. A fenced store refuses that late
   * save with `StoreConflictError`, and so does `doEventSourcedStore` once
   * a newer run has loaded its log. A custom plain store that waits before
   * it writes takes it over what a newer run saved, unless it checks at
   * its own write point. So a host that starts a new run on the same store
   * after a `stop()` that gave up needs one of the first two. A run
   * stopped while its `store.load()` was pending saves nothing when the
   * load returns: `ready` resolves with the loaded State, unsaved.
   */
  disposeTimeoutMs?: number;
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
   * A sink handed `{ seq, msgType, at }` for every applied transition —
   * the observe-only telemetry `withTelemetry` used to add by wrapping the
   * machine (#268). Fire-and-forget; see TelemetrySink.
   */
  telemetry?: TelemetrySink;
  /**
   * The run-terminality predicate — makes the run's outcome first-class. Fed to
   * `Runtime.result()` and `Runtime.done()`. PURE. Omit → never terminal.
   *
   * `done()` resolves with a saved terminal State. When a failure closes the
   * run short of one, it rejects with that failure, for waiting and later
   * callers: the save's own error, a `SubFailedError`, or what a reducer threw
   * under the `stop` strategy. A `stop()` with no failure leaves it pending.
   */
  terminal?: (state: S) => boolean;
}
```

<a id="run"></a>

### `run`

```ts
function run<
  S,
  M extends { _tag: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  E extends { _tag: string } = never,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: PromiseRunOptions<S, M, C, U, Ctx, E>,
): BootingRun<S, M, E>
```

<a id="Run"></a>

### `Run`

```ts
interface Run<S, M extends { _tag: string }, E extends { _tag: string } = never> extends Runtime<S, M, E>, Postable<S, M> {
  /** Resolves to this same `Runtime` once boot completes. Idempotent. */
  ready: Promise<Run<S, M, E>>;
}
```

<a id="tell"></a>

### `tell`

```ts
function tell<
  S,
  M extends { _tag: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  E extends { _tag: string } = never,
>(
  machine: Machine<S, M, C, U, Ctx>,
  runtime: Run<S, M, E>,
  msg: NoInfer<M>,
): TellAnswer
```

<a id="TellAnswer"></a>

### `TellAnswer`

```ts
type TellAnswer = "no_cell" | "queued" | "stopped"
```
