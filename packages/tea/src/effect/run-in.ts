/**
 * `runIn`: the Effect engine's `run`, as a host adapter takes it (#852).
 *
 * `useMachine` takes a `run` that hands back its handle at once. The Effect
 * engine's `run` is an `Effect` that needs a `Scope` and the services its
 * handlers read, so it does not fit. `runIn(runtime)` closes the gap and nothing
 * more: the services are the caller's `ManagedRuntime`, used as it is (ADR 0020),
 * and each call opens a `Scope` of its own to run in, which `stop()` closes (ADR
 * 0030). The lifecycle (one run per mount under Strict Mode, Subs paused on an
 * `<Activity>` hide, the run stopped on a real unmount) stays `MountedRun`'s.
 *
 * A `ManagedRuntime` builds its Layer on first use, and an async Layer is not
 * built when `run` is called. So the handle is the run's whole surface from the
 * first instant: a Msg sent before the Layer is built waits and folds in order
 * once it is, and a Layer that fails to build ends the run before it began,
 * reaching `onError` once.
 */

import { Cause, Effect, Exit, type ManagedRuntime, Scope } from "effect";
import {
  type InstalledStateRead,
  installedState,
  readInstalledState,
} from "../internal/engine/installed-state";
import {
  defaultOnError,
  type Postable,
  post,
  sinkOrDefault,
  type TellAnswer,
} from "../internal/engine/loop";
import type { Cmd, Machine, Sub } from "../pure/core";
import {
  type BootedRunHandle,
  DispatchDiscardedError,
  type HandlerFamily,
  type OnError,
  type RunHandle,
  type RunOptions,
} from "../runtime-types";
import type { EffectBootingRun, EffectRun } from "./handle";
import {
  type EffectInterpret,
  type EffectSubscribe,
  type InterpretOption,
  run,
  type SubscribeOption,
} from "./run";

/**
 * The Effect engine's handler tables for a runtime that provides `R`: `interpret`
 * cells that return an `Effect` and `subscribe` runners that return a `Stream`,
 * each reading no service outside `R` but the run's own `Scope.Scope`.
 * Requiredness is the engine's own: a machine with a Cmd needs `interpret`, one
 * with a Sub beyond `timer` needs `subscribe`.
 */
export interface EffectHandlers<R> extends HandlerFamily {
  readonly handlers: EffectHandlerTables<
    this["M"],
    this["C"],
    this["U"],
    R | Scope.Scope
  >;
}

/** The `interpret` and `subscribe` options of `run`, for a runtime providing `R`. */
export type EffectHandlerTables<
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  R,
> = InterpretOption<C, EffectInterpret<M, C, R>> &
  SubscribeOption<U, EffectSubscribe<M, U, R>>;

/**
 * The `run` that {@link runIn} gives `useMachine`: any machine in, a handle out
 * at once, with the handlers typed by {@link EffectHandlers}. A cell that reads a
 * service the runtime does not provide does not compile.
 */
export type BridgedRun<R> = (<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: RunOptions<S, M, C, U, Ctx, never, EffectHandlers<R>>,
) => RunHandle<S, M>) & {
  readonly "~demlik/tea/handlers"?: EffectHandlers<R>;
};

const bridges = new WeakMap<object, BridgedRun<never>>();

/**
 * Turn the caller's `ManagedRuntime` into the `run` that `useMachine` takes:
 * `useMachine(machine, { run: runIn(appRuntime), ctx, interpret })`.
 *
 * Every Cmd handler and Sub runner reads its services from `runtime`, which
 * `runIn` never builds on its own, caches or disposes: the caller owns it, and it
 * is still usable after the component is gone.
 *
 * The same function comes back for the same runtime every time, because
 * `useMachine` keys its run on it. Calling `runIn` in a render is safe.
 *
 * A run stops by closing the `Scope` it ran in: handler fibers are interrupted,
 * their finalizers run, and what a handler or runner acquired from `Scope.Scope`
 * is released. A Layer that fails to build, or a runtime already disposed,
 * reaches `onError` once under `phase: "boot"`.
 */
export function runIn<R, ER>(
  runtime: ManagedRuntime.ManagedRuntime<R, ER>,
): BridgedRun<R> {
  const known = bridges.get(runtime);
  if (known !== undefined) return known as BridgedRun<R>;
  const bridged: BridgedRun<R> = (machine, opts) =>
    host(
      runtime as ManagedRuntime.ManagedRuntime<never, unknown>,
      machine,
      opts,
    );
  bridges.set(runtime, bridged as BridgedRun<never>);
  return bridged;
}

/**
 * One run in `runtime`. The Effect engine's `run` is called without the types its
 * services ride on, because `runtime` supplies them.
 */
function host<
  R,
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  runtime: ManagedRuntime.ManagedRuntime<never, unknown>,
  machine: Machine<S, M, C, U, Ctx>,
  opts: RunOptions<S, M, C, U, Ctx, never, EffectHandlers<R>>,
): RunHandle<S, M> {
  const sink = opts.onError ?? defaultOnError;
  const hosted = new HostedRun<S, M>((error, context) =>
    sinkOrDefault(sink, error, context),
  );
  const start = (run as StartRun)(machine, opts) as Effect.Effect<
    EffectBootingRun<S, M>,
    never,
    Scope.Scope
  >;
  hosted.begin(runtime, start);
  return hosted;
}

type StartRun = (
  machine: unknown,
  opts: unknown,
) => Effect.Effect<unknown, never, Scope.Scope>;

/** The run `run` builds: the Effect handle, which also carries the line and the installed State. */
type Target<S, M extends { type: string }> = EffectRun<S, M> &
  InstalledStateRead<S>;

/**
 * Where the run is. `building` is a run whose Layer is not built yet: nothing
 * runs, and what a caller does is held. `closed` is a run that will never start,
 * because its Layer failed or it was stopped first.
 */
type Phase<S, M extends { type: string }> =
  | { readonly type: "building" }
  | { readonly type: "live"; readonly target: Target<S, M> }
  | { readonly type: "closed" };

const everyState = (): boolean => true;

/**
 * The handle `runIn`'s `run` returns. It answers for the run at once and hands
 * each call to the real run when there is one: a registration or a Msg that
 * comes before is held and made, in order, when the run exists.
 */
class HostedRun<S, M extends { type: string }>
  implements BootedRunHandle<S, M>, Postable<S, M>, InstalledStateRead<S>
{
  private phase: Phase<S, M> = { type: "building" };
  private held: M[] = [];
  private waiting: ((target: Target<S, M>) => void)[] = [];
  // The Scope this run runs in. Whoever opened a Scope closes it (ADR 0030).
  private readonly scope = Scope.makeUnsafe();
  private stopping: Promise<void> | undefined;
  private readonly attached: Promise<Target<S, M>>;
  private resolveAttached!: (target: Target<S, M>) => void;
  private rejectAttached!: (error: unknown) => void;
  readonly ready: Promise<BootedRunHandle<S, M>>;

  /** @param report where a failure with no caller goes: the run's own `onError`. */
  constructor(private readonly report: OnError) {
    this.attached = new Promise((resolve, reject) => {
      this.resolveAttached = resolve;
      this.rejectAttached = reject;
    });
    this.ready = this.attached
      .then((target) => Effect.runPromise(target.ready))
      .then(() => this);
    // A failure to build is reported to `report` where it happens; these are
    // for whoever asks.
    this.attached.catch(() => {});
    this.ready.catch(() => {});
  }

  /** Start the run in `runtime`, as soon as its Layer is built. */
  begin(
    runtime: ManagedRuntime.ManagedRuntime<never, unknown>,
    start: Effect.Effect<EffectBootingRun<S, M>, never, Scope.Scope>,
  ): void {
    const program = Effect.suspend(() =>
      this.phase.type !== "building"
        ? Effect.void
        : start.pipe(
            Scope.provide(this.scope),
            Effect.map((booted) =>
              this.attach(booted as unknown as Target<S, M>),
            ),
          ),
    );
    runtime.runCallback(program, { onExit: (exit) => this.exited(exit) });
  }

  private attach(target: Target<S, M>): void {
    this.phase = { type: "live", target };
    const waiting = this.waiting;
    const held = this.held;
    this.waiting = [];
    this.held = [];
    for (const register of waiting) register(target);
    for (const msg of held) target[post](msg, everyState);
    this.resolveAttached(target);
  }

  private exited(exit: Exit.Exit<unknown, unknown>): void {
    if (Exit.isFailure(exit) && this.phase.type === "building") {
      const error = Cause.squash(exit.cause);
      const held = this.close(error);
      this.report(error, { phase: "boot" });
      this.discard(held);
    }
  }

  /** The run will never start. Returns what was held for it, for {@link discard}. */
  private close(reason: unknown): M[] {
    this.phase = { type: "closed" };
    this.waiting = [];
    const held = this.held;
    this.held = [];
    this.rejectAttached(reason);
    return held;
  }

  private discard(held: readonly M[]): void {
    for (const msg of held)
      this.report(new DispatchDiscardedError(msg.type), { phase: "discard" });
  }

  /**
   * Make `register` on the run as soon as there is one. Returns the undo, which
   * works wherever the registration stands.
   */
  private onTarget(register: (target: Target<S, M>) => () => void): () => void {
    let undo: (() => void) | undefined;
    let undone = false;
    const make = (target: Target<S, M>): void => {
      if (!undone) undo = register(target);
    };
    if (this.phase.type === "live") make(this.phase.target);
    else if (this.phase.type === "building") this.waiting.push(make);
    return () => {
      undone = true;
      undo?.();
    };
  }

  /**
   * Held until the run exists when its Layer is not built, so the answer is
   * `"queued"` for a Msg the run will take or refuse later; once the run is
   * closed it is `"stopped"`. A Msg held here folds under any State, as the
   * hook's `send` posts it.
   */
  readonly [post] = (msg: M, takes: (state: S) => boolean): TellAnswer => {
    switch (this.phase.type) {
      case "live":
        return this.phase.target[post](msg, takes);
      case "closed":
        return "stopped";
      case "building":
        this.held.push(msg);
        return "queued";
    }
  };

  readonly [installedState] = (): S | undefined =>
    this.phase.type === "live"
      ? readInstalledState<S>(this.phase.target)
      : undefined;

  getState(): S {
    return (
      this.phase.type === "live" ? this.phase.target.getState() : undefined
    ) as S;
  }

  dispatch(msg: M): Promise<void> {
    return this.attached.then((target) =>
      Effect.runPromise(target.dispatch(msg)),
    );
  }

  subscribe(listener: () => void): () => void {
    return this.onTarget((target) => target.subscribe(listener));
  }

  observe(observer: (msg: M, state: S) => void): () => void {
    return this.onTarget((target) => target.observe(observer));
  }

  onBoot(handler: (state: S) => void): () => void {
    return this.onTarget((target) => target.onBoot(handler));
  }

  on(type: string, handler: (event: never) => void): () => void {
    return this.onTarget((target) =>
      target.on(type as never, handler as never),
    );
  }

  /**
   * Close the Scope the run runs in, once: the run stops, its handler fibers are
   * interrupted and their finalizers run. A run whose Layer is not built yet never
   * starts.
   */
  stop(): Promise<void> {
    this.stopping ??= this.stopOnce();
    return this.stopping;
  }

  private stopOnce(): Promise<void> {
    if (this.phase.type === "building")
      this.discard(
        this.close(
          new Error(
            "@demlik/tea: the run was stopped before its Layer was built",
          ),
        ),
      );
    return Effect.runPromise(Scope.close(this.scope, Exit.void));
  }
}
