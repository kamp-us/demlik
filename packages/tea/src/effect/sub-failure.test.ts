/**
 * A Sub that fails with an error it did not handle stops the run (#309, ruling
 * R3.1 of #325) — the Effect engine's half; `src/promise/sub-failure.test.ts`
 * is the Promise engine's. The Elm way: a Sub maps the errors it expects into
 * Msgs itself, so any failure that reaches the engine is unhandled. It never
 * stays "logged, id still live": the run's Scope closes with the failure.
 */

import {
  Cause,
  Data,
  Effect,
  Exit,
  type Scope,
  Scope as ScopeModule,
  Stream,
} from "effect";
import { describe, expect, it, vi } from "vitest";
import { defineMachine, type RuntimeErrorContext, type Sub } from "../index";
import { type LiveWorkProbe, liveWork } from "../internal/engine/loop";
import * as EffectEngine from "./index";

class Closed extends Data.TaggedError("Closed")<{ readonly code: number }> {}

type Feed = Sub<"feed", { readonly on: true }>;
type Other = Sub<"other", { readonly on: true }>;
type Msg =
  | { readonly type: "tick" }
  | { readonly type: "failed"; readonly code: number }
  | { readonly type: "poke" };
type Model = {
  readonly ticks: number;
  readonly failed: number | null;
  readonly pokes: number;
};

const machine = defineMachine({
  types: {
    model: {} as Model,
    msg: {} as Msg,
    sub: {} as Feed | Other,
  },
  init: () => [{ ticks: 0, failed: null, pokes: 0 }, []],
  update: {
    tick: (m) => [{ ...m, ticks: m.ticks + 1 }, []],
    failed: (m, msg) => [{ ...m, failed: msg.code }, []],
    poke: (m) => [{ ...m, pokes: m.pokes + 1 }, []],
  },
  subs: [
    { type: "feed", deps: () => ({ on: true as const }) },
    { type: "other", deps: () => ({ on: true as const }) },
  ],
});

function sink() {
  const reports: { error: unknown; phase: string }[] = [];
  const onError = (error: unknown, context: RuntimeErrorContext) => {
    reports.push({ error, phase: context.phase });
  };
  return { reports, onError };
}

const liveSubs = (rt: object): number => (rt as LiveWorkProbe)[liveWork]().subs;

/** Open a scope by hand and record the Exit it closes with. */
async function openScope<A>(
  effect: Effect.Effect<A, never, Scope.Scope>,
): Promise<{ value: A; exits: Exit.Exit<unknown, unknown>[] }> {
  const scope = await Effect.runPromise(ScopeModule.make());
  const exits: Exit.Exit<unknown, unknown>[] = [];
  await Effect.runPromise(
    ScopeModule.addFinalizerExit(scope, (exit) =>
      Effect.sync(() => {
        exits.push(exit);
      }),
    ),
  );
  const value = await Effect.runPromise(
    ScopeModule.provide(scope)(effect) as Effect.Effect<A>,
  );
  return { value, exits };
}

/** A Stream that never ends and records when it is torn down. */
function forever(onRelease: () => void): Stream.Stream<Msg> {
  return Stream.never.pipe(Stream.ensuring(Effect.sync(onRelease)));
}

describe("Effect engine: an unhandled Sub failure", () => {
  it("stops the run and closes its Scope with that failure; the Sub is not left running", async () => {
    const closed = new Closed({ code: 1006 });
    let otherReleased = false;
    const { reports, onError } = sink();
    const { value: booting, exits } = await openScope(
      EffectEngine.run(machine, {
        onError,
        subscribe: {
          feed: () =>
            Stream.make({ type: "tick" } as Msg).pipe(
              Stream.concat(Stream.fail(closed)),
            ),
          other: () =>
            forever(() => {
              otherReleased = true;
            }),
        },
      }),
    );
    const rt = await Effect.runPromise(booting.ready);

    await vi.waitFor(() => expect(exits).toHaveLength(1));
    const exit = exits[0] as Exit.Exit<unknown, unknown>;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(closed);

    expect(reports).toEqual([{ error: closed, phase: "sub" }]);
    // Closing the Scope stopped the run: every Sub is torn down, none is
    // counted as live, and the run takes no more Msgs.
    await vi.waitFor(() => expect(otherReleased).toBe(true));
    expect(liveSubs(rt)).toBe(0);
    const refused = await Effect.runPromise(
      Effect.flip(rt.dispatch({ type: "poke" })),
    );
    expect(refused).toBeInstanceOf(EffectEngine.Stopped);
  });

  it("a defect in the Stream closes the Scope with that defect", async () => {
    const boom = new Error("boom");
    const { reports, onError } = sink();
    const { value: booting, exits } = await openScope(
      EffectEngine.run(machine, {
        onError,
        subscribe: {
          feed: () => Stream.die(boom),
          other: () => forever(() => {}),
        },
      }),
    );
    await Effect.runPromise(booting.ready);

    await vi.waitFor(() => expect(exits).toHaveLength(1));
    const exit = exits[0] as Exit.Exit<unknown, unknown>;
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    expect(reports).toEqual([{ error: boom, phase: "sub" }]);
  });

  it("a runner that throws while starting stops the run the same way", async () => {
    const boom = new Error("no socket");
    const { reports, onError } = sink();
    const { value: booting, exits } = await openScope(
      EffectEngine.run(machine, {
        onError,
        subscribe: {
          feed: (): Stream.Stream<Msg> => {
            throw boom;
          },
          other: () => forever(() => {}),
        },
      }),
    );
    // A throw is a defect: `ready` dies with it.
    const booted = await Effect.runPromiseExit(booting.ready);
    expect(Exit.isFailure(booted) && Cause.squash(booted.cause)).toBe(boom);

    await vi.waitFor(() => expect(exits).toHaveLength(1));
    const exit = exits[0] as Exit.Exit<unknown, unknown>;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(boom);
    expect(reports).toEqual([{ error: boom, phase: "sub" }]);
  });
});

describe("Effect engine: a Sub that maps its own errors to Msgs", () => {
  it("keeps the run going, with the failure delivered as a Msg", async () => {
    const { reports, onError } = sink();
    const { value: booting, exits } = await openScope(
      EffectEngine.run(machine, {
        onError,
        subscribe: {
          feed: () =>
            Stream.make({ type: "tick" } as Msg).pipe(
              Stream.concat(Stream.fail(new Closed({ code: 1006 }))),
              Stream.catchTag("Closed", (e) =>
                Stream.make({ type: "failed", code: e.code } as Msg),
              ),
            ),
          other: () => forever(() => {}),
        },
      }),
    );
    const rt = await Effect.runPromise(booting.ready);

    await vi.waitFor(() =>
      expect(rt.getState()).toEqual({ ticks: 1, failed: 1006, pokes: 0 }),
    );
    await Effect.runPromise(rt.dispatch({ type: "poke" }));
    expect(rt.getState().pokes).toBe(1);
    expect(exits).toEqual([]);
    expect(reports).toEqual([]);
  });
});
