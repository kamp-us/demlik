/**
 * A Sub that fails with an error it did not handle stops the run (#309, ruling
 * R3.1 of #325) — the Effect engine's half; `src/promise/sub-failure.test.ts`
 * is the Promise engine's. The Elm way: a Sub maps the errors it expects into
 * Msgs itself, so any failure that reaches the engine is unhandled. It never
 * stays "logged, id still live": the run closes its own child Scope, the
 * caller's stays open, and `done()` fails with what the Sub failed with
 * (ADR 0030, which narrows R3.1).
 */

import {
  Cause,
  Data,
  Deferred,
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
  it("stops the run and leaves the caller's Scope open; done() says why and the Sub is not left running", async () => {
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

    const failed = await Effect.runPromise(Effect.flip(rt.done()));
    expect(failed).toBeInstanceOf(EffectEngine.SubFailed);
    expect((failed as EffectEngine.SubFailed).cause).toBe(closed);
    expect(rt.result()).toBeUndefined();

    expect(reports).toEqual([{ error: closed, phase: "sub" }]);
    // The run's own Scope closing stopped the run: every Sub is torn down, none
    // is counted as live, and the run takes no more Msgs.
    await vi.waitFor(() => expect(otherReleased).toBe(true));
    expect(liveSubs(rt)).toBe(0);
    const refused = await Effect.runPromise(
      Effect.flip(rt.dispatch({ type: "poke" })),
    );
    expect(refused).toBeInstanceOf(EffectEngine.Stopped);
    expect(exits).toEqual([]);
  });

  it("a defect in the Stream reaches done() and leaves the caller's Scope open", async () => {
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
    const rt = await Effect.runPromise(booting.ready);

    const failed = await Effect.runPromise(Effect.flip(rt.done()));
    expect((failed as EffectEngine.SubFailed).cause).toBe(boom);
    expect(reports).toEqual([{ error: boom, phase: "sub" }]);
    expect(exits).toEqual([]);
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

    expect(reports).toEqual([{ error: boom, phase: "sub" }]);
    await vi.waitFor(() => expect(liveSubs(booting)).toBe(0));
    expect(exits).toEqual([]);
  });

  it("fails a done() already waiting, and one that comes later", async () => {
    const closed = new Closed({ code: 1 });
    const go = Effect.runSync(Deferred.make<void>());
    const { onError } = sink();
    const { value: booting } = await openScope(
      EffectEngine.run(machine, {
        onError,
        subscribe: {
          feed: () =>
            Stream.fromEffect(Deferred.await(go)).pipe(
              Stream.flatMap(() => Stream.fail(closed)),
            ),
          other: () => forever(() => {}),
        },
      }),
    );
    const rt = await Effect.runPromise(booting.ready);
    const waiting = Effect.runPromise(Effect.flip(rt.done()));

    Effect.runSync(Deferred.succeed(go, undefined));

    const first = await waiting;
    const later = await Effect.runPromise(Effect.flip(rt.done()));
    expect((first as EffectEngine.SubFailed).cause).toBe(closed);
    expect((later as EffectEngine.SubFailed).cause).toBe(closed);
  });

  it("leaves a terminal State's done() alone", async () => {
    const closed = new Closed({ code: 1 });
    const go = Effect.runSync(Deferred.make<void>());
    const { onError } = sink();
    const { value: booting } = await openScope(
      EffectEngine.run(machine, {
        onError,
        terminal: (s) => s.pokes > 0,
        subscribe: {
          feed: () =>
            Stream.fromEffect(Deferred.await(go)).pipe(
              Stream.flatMap(() => Stream.fail(closed)),
            ),
          other: () => forever(() => {}),
        },
      }),
    );
    const rt = await Effect.runPromise(booting.ready);
    await Effect.runPromise(rt.dispatch({ type: "poke" }));

    Effect.runSync(Deferred.succeed(go, undefined));
    await vi.waitFor(() => expect(liveSubs(rt)).toBe(0));

    const state = await Effect.runPromise(rt.done());
    expect(state.pokes).toBe(1);
    expect(rt.result()?.pokes).toBe(1);
  });
});

describe("Effect engine: what else lives in the caller's Scope", () => {
  it("a sibling run survives another run's Sub failure, and closing the caller's Scope stops it", async () => {
    const closed = new Closed({ code: 1 });
    const { onError } = sink();
    let siblingReleased = false;
    let resourceReleased = false;
    const caller = await Effect.runPromise(ScopeModule.make());
    const start = <A>(effect: Effect.Effect<A, never, Scope.Scope>) =>
      Effect.runPromise(
        ScopeModule.provide(caller)(effect) as Effect.Effect<A>,
      );

    await start(
      Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          resourceReleased = true;
        }),
      ),
    );
    const sibling = await Effect.runPromise(
      (
        await start(
          EffectEngine.run(machine, {
            onError,
            subscribe: {
              feed: () =>
                forever(() => {
                  siblingReleased = true;
                }),
              other: () => forever(() => {}),
            },
          }),
        )
      ).ready,
    );
    const failing = await Effect.runPromise(
      (
        await start(
          EffectEngine.run(machine, {
            onError,
            subscribe: {
              feed: () => Stream.fail(closed),
              other: () => forever(() => {}),
            },
          }),
        )
      ).ready,
    );

    await Effect.runPromise(Effect.flip(failing.done()));
    await vi.waitFor(() => expect(liveSubs(failing)).toBe(0));

    await Effect.runPromise(sibling.dispatch({ type: "poke" }));
    expect(sibling.getState().pokes).toBe(1);
    expect(siblingReleased).toBe(false);
    expect(resourceReleased).toBe(false);

    await Effect.runPromise(ScopeModule.close(caller, Exit.void));

    expect(siblingReleased).toBe(true);
    expect(resourceReleased).toBe(true);
    const refused = await Effect.runPromise(
      Effect.flip(sibling.dispatch({ type: "poke" })),
    );
    expect(refused).toBeInstanceOf(EffectEngine.Stopped);
  });

  it("a spawned worker's Sub failure runs remove and notify, and its sibling worker lives on", async () => {
    const closed = new Closed({ code: 1 });
    const { onError } = sink();
    const log: string[] = [];
    const parent = await Effect.runPromise(ScopeModule.make());
    const worker = (name: string, feed: () => Stream.Stream<Msg, Closed>) =>
      EffectEngine.spawn(parent, {
        start: () =>
          EffectEngine.run(machine, {
            onError,
            subscribe: { feed, other: () => forever(() => {}) },
          }),
        enrol: () => Effect.void,
        remove: Effect.sync(() => {
          log.push(`remove ${name}`);
        }),
        notify: Effect.sync(() => {
          log.push(`notify ${name}`);
        }),
      });

    const staying = await Effect.runPromise(
      (await Effect.runPromise(worker("staying", () => Stream.never))).ready,
    );
    await Effect.runPromise(worker("failing", () => Stream.fail(closed)));

    await vi.waitFor(() => expect(log).toContain("notify failing"));
    expect(log).toContain("remove failing");
    expect(log).not.toContain("remove staying");
    await Effect.runPromise(staying.dispatch({ type: "poke" }));
    expect(staying.getState().pokes).toBe(1);
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
