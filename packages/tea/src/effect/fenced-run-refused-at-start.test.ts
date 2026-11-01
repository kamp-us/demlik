/**
 * A run on a store fenced at runtime, with no `onError`, is refused at start on
 * both engines, whatever the store's declared type (ADR 0031, amended by #810).
 * Every other pairing starts as before.
 */

import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { defineMachine, type OnError, type Store } from "../index";
import { memoryStore } from "../mem";
import { run as runPromise } from "../promise";
import { run as runEffect } from "./index";

type State = { readonly count: number };
type Msg = { readonly type: "bump" };

const machine = defineMachine({
  types: { model: {} as State, msg: {} as Msg, ctx: undefined },
  init: (loaded) => [loaded ?? { count: 0 }, []],
  update: { bump: (state) => [{ count: state.count + 1 }, []] },
});

/** A fenced memory store that counts every store call, typed plain `Store`. */
function countedFenced(): { readonly store: Store<State>; calls: number } {
  const inner = memoryStore<State>(null, undefined, { fenced: true });
  const counted = { store: inner as Store<State>, calls: 0 };
  const tally =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      counted.calls += 1;
      return fn(...args);
    };
  counted.store = {
    ...inner,
    load: tally(inner.load.bind(inner)),
    save: tally(inner.save.bind(inner)),
    loadFenced: tally(inner.loadFenced.bind(inner)),
    saveFenced: tally(inner.saveFenced.bind(inner)),
  } as Store<State>;
  return counted;
}

const sink: OnError = () => {};

type Options = { readonly store?: Store<State>; readonly onError?: OnError };

/** Start a run and bump it once; answers the end State, or what refused it. */
const engines = {
  promise: async (opts: Options) => {
    try {
      const rt = await runPromise(machine, { ctx: undefined, ...opts }).ready;
      await rt.dispatch({ type: "bump" });
      const state = rt.getState();
      await rt.stop();
      return { state };
    } catch (error) {
      return { refused: (error as Error).message };
    }
  },
  effect: async (opts: Options) => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const booting = yield* runEffect(machine, {
            ctx: undefined,
            ...opts,
          });
          const rt = yield* booting.ready;
          yield* rt.dispatch({ type: "bump" });
          return rt.getState();
        }),
      ),
    );
    if (Exit.isSuccess(exit)) return { state: exit.value };
    // A refusal is a defect, not a declared failure.
    expect(Cause.hasDies(exit.cause)).toBe(true);
    return { refused: (Cause.squash(exit.cause) as Error).message };
  },
} as const;

describe.each(["promise", "effect"] as const)("on the %s engine", (name) => {
  const start = engines[name];

  it("a fenced store typed plain `Store`, with no `onError`, is refused before any store call", async () => {
    const counted = countedFenced();
    const outcome = await start({ store: counted.store });
    expect(outcome.refused).toContain("fenced store needs an `onError`");
    expect(counted.calls).toBe(0);
  });

  it("an `onError` passed as `undefined` is no sink either", async () => {
    const counted = countedFenced();
    const outcome = await start({ store: counted.store, onError: undefined });
    expect(outcome.refused).toContain("`onError`");
    expect(counted.calls).toBe(0);
  });

  it("a fenced store with an `onError` starts as before", async () => {
    const counted = countedFenced();
    const outcome = await start({ store: counted.store, onError: sink });
    expect(outcome).toEqual({ state: { count: 1 } });
    expect(counted.calls).toBeGreaterThan(0);
  });

  it("an unfenced store with no `onError` starts as before", async () => {
    const outcome = await start({ store: memoryStore<State>() });
    expect(outcome).toEqual({ state: { count: 1 } });
  });

  it("no store at all starts as before", async () => {
    expect(await start({})).toEqual({ state: { count: 1 } });
  });
});

it("the Promise engine's refusal is a throw from `run` itself, before it returns a handle", () => {
  expect(() =>
    runPromise(machine, { ctx: undefined, store: countedFenced().store }),
  ).toThrow("`onError`");
});
