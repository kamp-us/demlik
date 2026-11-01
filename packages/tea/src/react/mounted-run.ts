/**
 * The run behind one `useMachine` mount, as React's effects see it.
 *
 * A passive effect's cleanup does not mean the component went away: Strict Mode
 * runs it and the effect again on mount, and `<Activity>` runs it on hide and
 * the effect again on show. So:
 *
 *   - The first effect starts the one run. Render starts nothing, so a render
 *     may build this object and throw it away.
 *   - A cleanup and an effect in one synchronous pass (Strict Mode) are no event
 *     at all: what the cleanup does is put off to a microtask, and the effect
 *     cancels it.
 *   - A cleanup with nothing after it (a hide) closes the {@link SubGate}, and
 *     that is all. The run stays live, so a Cmd in flight lands, its answer
 *     folds, and `init` never runs twice. An effect after it (a show) opens the
 *     gate again.
 *   - The insertion effect's cleanup, which neither of those cases runs, is the
 *     one that means the component is gone. It stops the run.
 */

import type { BootedRunHandle, RunHandle } from "../index";
import { SubGate } from "./sub-gate";

/** A Msg dispatched before the run has started, and the promise its caller holds. */
interface HeldMsg<M> {
  readonly msg: M;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/** A run and the listener this object holds on it. */
interface Started<S, M extends { type: string }> {
  readonly handle: RunHandle<S, M>;
  readonly unlisten: () => void;
}

/**
 * Where the run is. `leaving` is a run whose component is gone but whose passive
 * cleanups have not run yet: a child's cleanup may still send it a last Msg.
 */
type Phase<S, M extends { type: string }> =
  | { readonly type: "not-started" }
  | ({ readonly type: "live" | "leaving" } & Started<S, M>)
  | { readonly type: "stopped" };

const stoppedError = () => new Error("@demlik/tea: runtime stopped");

export class MountedRun<S, M extends { type: string }> {
  private snapshot: S;
  private phase: Phase<S, M> = { type: "not-started" };
  // The run's booted handle: the only thing with a `getState`. `null` until its
  // `ready` resolves, and for good if its boot fails.
  private booted: BootedRunHandle<S, M> | null = null;
  // An effect is standing, so the component is on screen.
  private connected = false;
  private held: HeldMsg<M>[] = [];
  private readonly subs = new SubGate();
  private readonly listeners = new Set<() => void>();

  /**
   * @param startRun boots the run, its Sub runners going through `subs`.
   * @param initial  the value React reads until the run has booted.
   */
  constructor(
    private readonly startRun: (subs: SubGate) => RunHandle<S, M>,
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
   * Stable for the life of this object. A hide changes nothing about it: the run
   * is still there. A Msg dispatched before the first effect (a child's effects
   * run before its parent's, and a tree first mounted hidden runs none) waits
   * for the run, in order.
   */
  readonly dispatch = (msg: M): Promise<void> => {
    switch (this.phase.type) {
      case "live":
      case "leaving":
        return this.phase.handle.dispatch(msg);
      case "stopped":
        return Promise.reject(stoppedError());
      case "not-started":
        return new Promise((resolve, reject) => {
          this.held.push({ msg, resolve, reject });
        });
    }
  };

  /** The effect ran: the component is on screen. */
  connect(): void {
    this.connected = true;
    this.subs.open();
    switch (this.phase.type) {
      case "live":
        return;
      case "leaving":
        // Only if React ever calls an insertion cleanup on a hide. The show that
        // follows must not find a dead run, so it takes the run back.
        this.phase = { ...this.phase, type: "live" };
        return;
      case "not-started":
      case "stopped":
        this.start();
    }
  }

  /** The effect's cleanup ran. Act on it unless the effect runs again first. */
  disconnect(): void {
    this.connected = false;
    queueMicrotask(() => {
      if (this.connected) return;
      if (this.phase.type === "leaving") this.stop();
      else this.subs.close();
    });
  }

  /**
   * The component is gone for good: this runs from `useInsertionEffect`'s
   * cleanup, which neither Strict Mode's double run nor `<Activity>` calls.
   */
  retire(): void {
    switch (this.phase.type) {
      case "not-started": {
        this.phase = { type: "stopped" };
        const held = this.held;
        this.held = [];
        for (const { reject } of held) reject(stoppedError());
        return;
      }
      case "live":
        // A standing effect's cleanup comes later and stops the run then, so a
        // child's cleanup can still reach it. A hidden one has no cleanup coming.
        if (this.connected) this.phase = { ...this.phase, type: "leaving" };
        else this.stop();
        return;
      default:
        return;
    }
  }

  private start(): void {
    const handle = this.startRun(this.subs);
    this.booted = null;
    // A transition before `ready` needs no read: `ready`'s own read sees it.
    const unlisten = handle.subscribe(() => {
      if (this.booted !== null) this.publish(this.booted.getState());
    });
    this.phase = { type: "live", handle, unlisten };
    // A failed boot is not swallowed: it rejects every dispatch into this run.
    handle.ready.then(
      (booted) => {
        // A run stopped mid-boot still boots, and nobody is reading it.
        if (!("handle" in this.phase) || this.phase.handle !== handle) return;
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

  private stop(): void {
    if (!("handle" in this.phase)) return;
    const { handle, unlisten } = this.phase;
    this.phase = { type: "stopped" };
    unlisten();
    void handle.stop();
  }

  private publish(state: S): void {
    this.snapshot = state;
    for (const listener of this.listeners) listener();
  }
}
