/**
 * The run behind one `useMachine` mount, as React's effects see it.
 *
 * A passive effect's cleanup does not mean the component went away: Strict Mode
 * runs it and the effect again on mount, and `<Activity>` runs it on hide and
 * the effect again on show. So this object outlives any one run. It holds the
 * value React reads and the `dispatch` a child may keep, and it starts and
 * stops runs underneath them:
 *
 *   - A cleanup and an effect in one synchronous pass (Strict Mode) are no event
 *     at all: the stop is put off to a microtask, and the effect cancels it.
 *   - A cleanup with nothing after it (a hide, an unmount) stops the run for
 *     real, because React cannot say which one it was and a hidden component's
 *     Subs must not run. The stop's final State is carried.
 *   - An effect after a real stop (a show) starts a new run at the carried
 *     State.
 *
 * Constructing one starts nothing, so a render may build one and throw it away.
 */

import type { BootedRunHandle, RunHandle } from "../index";

/** A Msg dispatched while no run can take it, and the promise its caller holds. */
interface HeldMsg<M> {
  readonly msg: M;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/** The State a stopped run ended on. A box, because `S` may itself be nullish. */
export interface CarriedState<S> {
  readonly state: S;
}

/** Where the current run is. A `stopping` run refuses new Msgs but still folds. */
type Phase<S, M extends { type: string }> =
  | { readonly type: "no-run" }
  | {
      readonly type: "live" | "stopping";
      readonly handle: RunHandle<S, M>;
      readonly unlisten: () => void;
    };

export class MountedRun<S, M extends { type: string }> {
  private snapshot: S;
  private phase: Phase<S, M> = { type: "no-run" };
  // The current run's booted handle: the only thing with a `getState`. `null`
  // until its `ready` resolves, and for good if its boot fails.
  private booted: BootedRunHandle<S, M> | null = null;
  private carried: CarriedState<S> | null = null;
  // An effect is standing: a run is wanted. Read by the put-off stop.
  private connected = false;
  // The component is gone for good, not hidden.
  private retired = false;
  private held: HeldMsg<M>[] = [];
  private readonly listeners = new Set<() => void>();

  /**
   * @param startRun boots a run, at `carried`'s State when there is one.
   * @param initial  the value React reads until a run has booted.
   */
  constructor(
    private readonly startRun: (
      carried: CarriedState<S> | null,
    ) => RunHandle<S, M>,
    initial: S,
  ) {
    this.snapshot = initial;
  }

  readonly getSnapshot = (): S => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Stable for the life of this object, so a handler kept across a hide never
   * holds a dead run. With no run to take it, the Msg waits for the next one in
   * order, and its promise settles when that run has folded it.
   */
  readonly dispatch = (msg: M): Promise<void> => {
    // Live first: a child's effect cleanup still reaches the run on an unmount.
    if (this.phase.type === "live") return this.phase.handle.dispatch(msg);
    if (this.retired) {
      return Promise.reject(new Error("@demlik/tea: runtime stopped"));
    }
    return new Promise((resolve, reject) => {
      this.held.push({ msg, resolve, reject });
    });
  };

  /** The effect ran. Start a run unless one is live or is still stopping. */
  connect(): void {
    this.connected = true;
    if (this.phase.type === "no-run") this.start();
  }

  /** The effect's cleanup ran. Stop the run unless the effect runs again first. */
  disconnect(): void {
    this.connected = false;
    queueMicrotask(() => {
      if (!this.connected) void this.stop();
    });
  }

  /**
   * The component is gone for good. Only a real unmount or a replacement gets
   * here: this runs from `useInsertionEffect`'s cleanup, which neither Strict
   * Mode's double run nor `<Activity>` calls. A held Msg has no run coming, so
   * it is refused rather than left waiting forever.
   */
  retire(): void {
    this.retired = true;
    const held = this.held;
    this.held = [];
    for (const { reject } of held) {
      reject(new Error("@demlik/tea: runtime stopped"));
    }
  }

  private start(): void {
    const handle = this.startRun(this.carried);
    this.booted = null;
    // A transition before `ready` needs no read: `ready`'s own read sees it.
    const unlisten = handle.subscribe(() => {
      if (this.booted !== null) this.publish(this.booted.getState());
    });
    this.phase = { type: "live", handle, unlisten };
    // A failed boot is not swallowed: it rejects every dispatch into this run.
    handle.ready.then(
      (booted) => {
        // A load `stop()` gave up on can return after the next run has started.
        if (this.phase.type === "no-run" || this.phase.handle !== handle) {
          return;
        }
        this.booted = booted;
        this.publish(booted.getState());
      },
      () => {},
    );
    const held = this.held;
    this.held = [];
    for (const { msg, resolve, reject } of held) {
      handle.dispatch(msg).then(resolve, reject);
    }
  }

  private async stop(): Promise<void> {
    if (this.phase.type !== "live") return;
    const { handle, unlisten } = this.phase;
    this.phase = { type: "stopping", handle, unlisten };
    // `stop()` also folds what was already queued, so the value is read after it.
    await handle.stop().catch(() => {});
    unlisten();
    // A run that never booted has no State of its own to carry, so the previous
    // carried State (if any) stands.
    if (this.booted !== null) {
      const state = this.booted.getState();
      this.carried = { state };
      this.publish(state);
    }
    this.phase = { type: "no-run" };
    if (this.connected) this.start();
  }

  private publish(state: S): void {
    this.snapshot = state;
    for (const listener of this.listeners) listener();
  }
}
