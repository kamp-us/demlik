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
 *   - The insertion effect's cleanup, which neither of those cases runs, means
 *     the component is gone. It stops the run.
 *
 * That last signal is only good from React 19.2. Before it, React skips the
 * insertion cleanup when it deletes a tree a Suspense fallback is hiding, so
 * nothing would stop the run. Those Reacts have no stable `<Activity>` either, so
 * a cleanup with nothing after it can only be an unmount, and it stops the run
 * itself. `peer-range.test.tsx` runs all of this on each React in the peer range.
 */

import type { BootedRunHandle, RunHandle } from "../index";
import { readInstalledState } from "../internal/engine/installed-state";
import { DispatchDiscardedError, type OnError } from "../runtime-types";
import { senderOf } from "./send";
import { SubGate } from "./sub-gate";

/** A run, the listener this object holds on it, and the `send` built on it. */
interface Started<S, M extends { type: string }> {
  readonly handle: RunHandle<S, M>;
  readonly unlisten: () => void;
  readonly send: (msg: M) => void;
}

/**
 * Where the run is. `leaving` is a run whose component is gone but whose passive
 * cleanups have not run yet: a child's cleanup may still send it a last Msg.
 */
type Phase<S, M extends { type: string }> =
  | { readonly type: "not-started" }
  | ({ readonly type: "live" | "leaving" } & Started<S, M>)
  | { readonly type: "stopped" };

export class MountedRun<S, M extends { type: string }> {
  private snapshot: S;
  private phase: Phase<S, M> = { type: "not-started" };
  // The run's booted handle: the only thing with a `getState`. `null` until its
  // `ready` resolves, and for good if its boot fails.
  private booted: BootedRunHandle<S, M> | null = null;
  // An effect is standing, so the component is on screen.
  private connected = false;
  private held: M[] = [];
  private readonly subs = new SubGate();
  private readonly listeners = new Set<() => void>();

  /**
   * @param startRun boots the run, its Sub runners going through `subs`.
   * @param initial  the value React reads until the run has told it a State.
   * @param cleanupMayBeAHide whether this React can run a passive cleanup on a
   *   hide, and so runs the insertion cleanup on every delete.
   * @param report where a Msg that never reached the run is reported.
   */
  constructor(
    private readonly startRun: (subs: SubGate) => RunHandle<S, M>,
    initial: S,
    private readonly cleanupMayBeAHide: boolean,
    private readonly report: OnError,
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
   * is still there. A Msg sent before the first effect (a child's effects
   * run before its parent's, and a tree first mounted hidden runs none) waits
   * for the run, in order. Returns `undefined` immediately. A Msg still held at
   * unmount, or sent after stop, is reported as `DispatchDiscardedError` under
   * `phase: "discard"`; the run reports its own step failures.
   */
  readonly send = (msg: M): void => {
    switch (this.phase.type) {
      case "live":
      case "leaving":
        this.phase.send(msg);
        return;
      case "stopped":
        this.discard(msg);
        return;
      case "not-started":
        this.held.push(msg);
        return;
    }
  };

  private discard(msg: M): void {
    this.report(new DispatchDiscardedError(msg.type), { phase: "discard" });
  }

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
      if (this.phase.type === "leaving" || !this.cleanupMayBeAHide) this.stop();
      else this.subs.close();
    });
  }

  /**
   * The component is gone for good: this runs from `useInsertionEffect`'s
   * cleanup, which neither Strict Mode's double run nor `<Activity>` calls. Before
   * React 19.2 a deleted hidden tree never gets here, and `disconnect` stops it.
   */
  retire(): void {
    switch (this.phase.type) {
      case "not-started": {
        this.phase = { type: "stopped" };
        const held = this.held;
        this.held = [];
        for (const msg of held) this.discard(msg);
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
    // `ready` waits for boot's Cmds, so before it the State comes off the read
    // the listener was told about: a page reloaded mid-work shows it while
    // `init`'s Cmds run (#695). A handle with no such read waits for `ready`.
    const unlisten = handle.subscribe(() => {
      if (this.booted !== null) {
        this.publish(this.booted.getState());
        return;
      }
      const installed = readInstalledState<S>(handle);
      if (installed !== undefined) this.publish(installed);
    });
    const send = senderOf(handle, this.report);
    this.phase = { type: "live", handle, unlisten, send };
    // The run reports boot failures through its own sink.
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
    for (const msg of held) send(msg);
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
