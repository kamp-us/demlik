/**
 * Stops and starts a live run's Subs without the run knowing.
 *
 * A hidden component's Subs must not run, but stopping its run would lose the
 * Cmds in flight. The engine has no way to pause a Sub, and it needs none: the
 * hook hands the engine runners that go through this gate. To the engine each
 * Sub stays started for as long as its State wants it. Underneath, the real
 * runner is cleaned up when the gate closes and started again when it opens.
 *
 * A Sub the State asks for while the gate is closed starts when it opens. A
 * `timer` starts its countdown over, as any restarted Sub does.
 */

import type { Dispose } from "../index";

/** One Sub the engine believes is running. */
class GatedSub {
  private dispose: Dispose | null = null;
  private lastDisposal: ReturnType<Dispose> = undefined;

  constructor(private readonly begin: () => Dispose) {}

  start(): void {
    this.dispose ??= this.begin();
  }

  /** Returns the cleanup still settling, so `stop()` can wait for it. */
  stop(): ReturnType<Dispose> {
    const dispose = this.dispose;
    this.dispose = null;
    if (dispose !== null) this.lastDisposal = dispose();
    return this.lastDisposal;
  }
}

export class SubGate {
  private isOpen = false;
  private readonly subs = new Set<GatedSub>();

  /**
   * The engine started a Sub. `begin` runs now if the gate is open, so a runner
   * that throws here throws to the engine, as it would without the gate.
   */
  admit(begin: () => Dispose): Dispose {
    const sub = new GatedSub(begin);
    if (this.isOpen) sub.start();
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
      return sub.stop();
    };
  }

  open(): void {
    this.isOpen = true;
    this.forEachSub((sub) => sub.start());
  }

  close(): void {
    this.isOpen = false;
    this.forEachSub((sub) => void sub.stop());
  }

  /**
   * One bad Sub never strands the others. The engine is not on the stack here,
   * so its sink cannot hear a throw: the first one is thrown after the pass, to
   * the error boundary from an effect and to the global handler from a microtask.
   */
  private forEachSub(fn: (sub: GatedSub) => void): void {
    const errors: unknown[] = [];
    for (const sub of this.subs) {
      try {
        fn(sub);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw errors[0];
  }
}
