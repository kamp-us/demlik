import { describe, expect, it, vi } from "vitest";
import {
  defineMachine,
  type NoCtx,
  type Reducer,
  run,
  type Sub,
  subId,
} from "../index";
import { defineListener } from "./define-listener";

// The two silent leaks `defineListener` makes unrepresentable (see the module
// header): (1) a no-op disposer that leaves the listener armed, and (2) a
// `remove` handed a DIFFERENT function than `add` saw. Both are checked here
// against a fake target that records the exact references it was given.

type TickSub = Sub<"tick"> & { readonly channel: string };
type State = { readonly armed: boolean; readonly seen: readonly number[] };
type Msg =
  | { readonly type: "tick"; readonly value: number }
  | { readonly type: "disarm" };

const update: Reducer<State, Msg, never> = {
  tick: (s, m) => [{ ...s, seen: [...s.seen, m.value] }, []],
  disarm: (s) => [{ ...s, armed: false }, []],
};

/** A platform-shaped listener registry: add/remove match by reference. */
function fakeTarget() {
  const listeners = new Set<(value: number) => void>();
  const added: ((value: number) => void)[] = [];
  const removed: ((value: number) => void)[] = [];
  return {
    added,
    removed,
    get armedCount() {
      return listeners.size;
    },
    emit(value: number) {
      for (const l of [...listeners]) l(value);
    },
    add(l: (value: number) => void) {
      added.push(l);
      listeners.add(l);
    },
    remove(l: (value: number) => void) {
      removed.push(l);
      listeners.delete(l);
    },
  };
}

function machineFor(
  target: ReturnType<typeof fakeTarget>,
  seenSubs: TickSub[] = [],
) {
  const fromFake = defineListener<[number], TickSub, NoCtx>({
    add: (listener, sub) => {
      seenSubs.push(sub);
      target.add(listener);
    },
    remove: (listener) => {
      target.remove(listener);
    },
  });

  return defineMachine<State, Msg, never, TickSub, NoCtx>({
    init: () => [{ armed: true, seen: [] }, []],
    update,
    subscriptions: (s) =>
      s.armed
        ? [{ id: subId("tick:main"), type: "tick", channel: "main" }]
        : [],
    subscribe: {
      // Drop-on-null: negatives are filtered, the listener stays armed.
      tick: fromFake<Msg>((_sub, value) =>
        value < 0 ? null : { type: "tick", value },
      ),
    },
  });
}

describe("defineListener — derived, reference-identical cleanup", () => {
  it("adds on subscribe and folds emitted values into State", async () => {
    const target = fakeTarget();
    const rt = await run(machineFor(target), {}).ready;

    expect(target.armedCount).toBe(1);
    target.emit(7);
    target.emit(42);
    await rt.idle();
    expect(rt.getState().seen).toEqual([7, 42]);

    await rt.stop();
  });

  it("removes the IDENTICAL reference it added — no phantom remove, no leak", async () => {
    const target = fakeTarget();
    const rt = await run(machineFor(target), {}).ready;

    await rt.dispatch({ type: "disarm" });

    expect(target.added).toHaveLength(1);
    expect(target.removed).toHaveLength(1);
    // Reference identity is the whole point: a wrapper anywhere in the path
    // would make these two distinct and the registry would keep the original.
    expect(target.removed[0]).toBe(target.added[0]);
    // ...and the registry actually dropped it, so the listener is not armed.
    expect(target.armedCount).toBe(0);

    await rt.stop();
  });

  it("cleanup is not a no-op — post-teardown emissions never reach the machine", async () => {
    const target = fakeTarget();
    const rt = await run(machineFor(target), {}).ready;

    target.emit(1);
    await rt.idle();
    expect(rt.getState().seen).toEqual([1]);

    await rt.dispatch({ type: "disarm" });
    target.emit(99);
    await rt.idle();
    expect(rt.getState().seen).toEqual([1]);

    await rt.stop();
  });

  it("msgFn → null drops the dispatch but leaves the listener armed", async () => {
    const target = fakeTarget();
    const rt = await run(machineFor(target), {}).ready;

    target.emit(-5);
    await rt.idle();
    expect(rt.getState().seen).toEqual([]);
    expect(target.armedCount).toBe(1);

    target.emit(3);
    await rt.idle();
    expect(rt.getState().seen).toEqual([3]);

    await rt.stop();
  });

  it("passes the concrete Sub to add/remove so the target can be keyed on it", async () => {
    const target = fakeTarget();
    const seenSubs: TickSub[] = [];
    const rt = await run(machineFor(target, seenSubs), {}).ready;

    expect(seenSubs).toHaveLength(1);
    // No cast at the substrate edge — `channel` is readable because `S` is
    // pinned when the target is defined.
    expect(seenSubs[0]?.channel).toBe("main");

    await rt.stop();
  });

  it("stop() tears the listener down too", async () => {
    const target = fakeTarget();
    const rt = await run(machineFor(target), {}).ready;
    expect(target.armedCount).toBe(1);

    await rt.stop();
    expect(target.armedCount).toBe(0);
  });

  it("dispatches nothing when the projection returns null for every event", async () => {
    const target = fakeTarget();
    const rt = await run(machineFor(target), {}).ready;
    const observed = vi.fn();
    rt.observe(observed);

    target.emit(-1);
    target.emit(-2);
    await rt.idle();
    expect(observed).not.toHaveBeenCalled();

    await rt.stop();
  });
});
