import { describe, expect, it } from "vitest";
import {
  defineMachine,
  type NoCtx,
  type Reducer,
  run,
  type Sub,
  subId,
} from "../index";
import { fromEventTarget } from "./from-event-target";
import type { MinimalEvent, MinimalEventTarget } from "./platform";

// Lifecycle contract under a real runtime (issue #286): the listener attaches
// when the Sub enters `subscriptions(state)`, delivered events fold into
// State (with `msgFn → null` dropped), and reconciling the Sub out removes
// the exact listener instance from the target.

class FakeTarget implements MinimalEventTarget {
  private readonly listeners = new Map<
    string,
    Set<(e: MinimalEvent) => void>
  >();

  addEventListener(type: string, listener: (e: MinimalEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (e: MinimalEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  fire(event: MinimalEvent): void {
    for (const l of this.listeners.get(event.type) ?? []) l(event);
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

type PingSub = Sub<"ping">;
type State = { readonly armed: boolean; readonly pings: number };
type Msg = { readonly type: "ping" } | { readonly type: "disarm" };

const update: Reducer<State, Msg, never> = {
  ping: (s) => [{ ...s, pings: s.pings + 1 }, []],
  disarm: (s) => [{ ...s, armed: false }, []],
};

function pingMachine(target: FakeTarget) {
  return defineMachine<State, Msg, never, PingSub, NoCtx>({
    init: () => [{ armed: true, pings: 0 }, []],
    update,
    subscriptions: (s) =>
      s.armed ? [{ id: subId("ping"), type: "ping" }] : [],
    subscribe: {
      ping: fromEventTarget<PingSub, Msg>(
        () => target,
        "ping",
        (event) => ("skip" in event ? null : { type: "ping" }),
      ),
    },
  });
}

describe("fromEventTarget — subscribe → deliver → cleanup against a real runtime", () => {
  it("attaches the listener at boot and delivers fired events as Msgs", async () => {
    const target = new FakeTarget();
    expect(target.count("ping")).toBe(0);

    const rt = await run(pingMachine(target), {}).ready;
    expect(target.count("ping")).toBe(1); // boot reconcile attached it

    target.fire({ type: "ping" });
    target.fire({ type: "ping" });
    await rt.idle();
    expect(rt.getState().pings).toBe(2);

    await rt.stop();
  });

  it("msgFn → null drops the emission but keeps the listener armed", async () => {
    const target = new FakeTarget();
    const rt = await run(pingMachine(target), {}).ready;

    const skipped: MinimalEvent & { skip: true } = { type: "ping", skip: true };
    target.fire(skipped);
    await rt.idle();
    expect(rt.getState().pings).toBe(0); // dropped, no dispatch

    target.fire({ type: "ping" });
    await rt.idle();
    expect(rt.getState().pings).toBe(1); // still armed for the next event

    await rt.stop();
  });

  it("reconciling the Sub out removes the listener — later events deliver nothing", async () => {
    const target = new FakeTarget();
    const rt = await run(pingMachine(target), {}).ready;

    await rt.dispatch({ type: "disarm" });
    expect(target.count("ping")).toBe(0); // removeEventListener ran

    target.fire({ type: "ping" });
    await rt.idle();
    expect(rt.getState().pings).toBe(0);

    await rt.stop();
  });
});
