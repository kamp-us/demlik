# @demlik/tea/promise

> the Promise engine: `run` boots a machine and drives its serial dispatch loop on Promises, and `driveToDone` runs one to its terminal state.

Tier: `stable`

```ts
import { … } from "@demlik/tea/promise";
```

## Exports (3)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`driveToDone`](#driveToDone) | Function | stable | Drive a machine from `start` to its terminal State in one call, then tear the runtime down. |
| [`DriveToDoneOptions`](#DriveToDoneOptions) | Type | stable | Options for `driveToDone`. |
| [`run`](#run) | Function | stable | Start a machine on the Promise engine and return its runtime. |

## Declarations

<a id="driveToDone"></a>

### `driveToDone`

```ts
function driveToDone<
  S,
  M extends { type: string },
  E extends { type: string } = never,
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
type DriveToDoneOptions<S, M extends { type: string } = never> = DriveCancellation<S, M> & {
  /**
   * Marks a terminal State as a FAILURE. A State this holds for ends the drive
   * like any terminal one — the runtime is stopped — but the drive REJECTS with
   * `DriveFailedError` carrying it instead of resolving. A failed State is
   * terminal by definition; it need not also satisfy `isTerminal`. Omit → the
   * drive never rejects on State, only on a runtime error.
   */
  readonly failed?: (state: S) => boolean;
}
```

<a id="run"></a>

### `run`

```ts
function run<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  E extends { type: string } = never,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: CtxArg<Ctx> & NoInfer<RunHandlers<M, C, U, Ctx>> & {
    /**
     * The clock that stamps `at` on a `Cmd.define`d effect's settled Msg at
     * the interpret edge, and on each `telemetry` event. Defaults to
     * `Date.now`. Inject a fixed one for a deterministic run; a `replay` log
     * carries its own `at`s and never reads this.
     */
    clock?: () => number;
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
     * The SEMANTIC event projector. Maps one APPLIED transition `(msg, state)`
     * to zero-or-more public events of `E`; `[]` skips the transition. Maps the
     * machine's PRIVATE Msg vocabulary to NAMED events — the private names never
     * reach `on`'s `E` surface. Omit → `E = never` and `on` is uncallable. PURE.
     */
    events?: (msg: M, state: S) => readonly E[];
    onError?: OnError;
    store?: Store<S>;
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
     */
    terminal?: (state: S) => boolean;
  },
): BootingRuntime<S, M, E>
```
