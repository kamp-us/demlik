/**
 * When tea closes a run because of a failure, `done()` answers with that failure
 * (#697). A host waiting on many jobs hears the one that died, and the others go
 * on. Every case here runs on both engines, through one small adapter, so the
 * two cannot drift. `./sub-failure.test.ts` and
 * `../promise/sub-failure.test.ts` hold the deeper Sub failure cases.
 */

import { Cause, Data, Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  defineMachine,
  NoCellError,
  type RuntimeErrorContext,
  type Sub,
  SubFailedError,
  type Transitions,
  type UnfencedStore,
} from "../index";
import { memoryStore } from "../mem";
import { run as runOnPromise } from "../promise";
import { run as runOnEffect, SubFailed } from "./index";

// === The machine ===

type Watch = Sub<"watch", { readonly on: true }>;
type Msg =
  | { readonly type: "work" }
  | { readonly type: "finish" }
  | { readonly type: "arm" }
  | { readonly type: "explode" };
type Model = {
  readonly worked: number;
  readonly armed: boolean;
  readonly finished: boolean;
};

const boom = new Error("reducer boom");

const job = defineMachine({
  types: { model: {} as Model, msg: {} as Msg, sub: {} as Watch },
  init: () => [{ worked: 0, armed: false, finished: false }, []],
  update: {
    work: (m) => [{ ...m, worked: m.worked + 1 }, []],
    finish: (m) => [{ ...m, finished: true }, []],
    arm: (m) => [{ ...m, armed: true }, []],
    explode: () => {
      throw boom;
    },
  },
  subs: [
    {
      type: "watch",
      deps: (m) => (m.armed ? { on: true as const } : null),
    },
  ],
});

const terminal = (m: Model): boolean => m.finished;

// === One adapter over both engines ===

class Closed extends Data.TaggedError("Closed")<{ readonly code: number }> {}

/** How one `done()` ended, in a shape both engines can be compared on. */
type Answer =
  | { readonly kind: "state"; readonly state: Model }
  | { readonly kind: "sub-failed"; readonly cause: unknown }
  | { readonly kind: "failed"; readonly error: unknown };

type Options = {
  readonly supervision?: "stop" | "escalate";
  /** What the armed Sub does. `failing` by default. */
  readonly sub?:
    | { readonly kind: "failing"; readonly error: unknown }
    | { readonly kind: "mapped"; readonly to: Msg }
    | { readonly kind: "live"; readonly closed: () => void };
  readonly store?: UnfencedStore<Model>;
};

type Harness = {
  readonly reports: { error: unknown; phase: string }[];
  dispatch(msg: Msg): Promise<unknown>;
  done(): Promise<Answer>;
  result(): Model | undefined;
  getState(): Model;
  stop(): Promise<void>;
};

function sink() {
  const reports: { error: unknown; phase: string }[] = [];
  const onError = (error: unknown, context: RuntimeErrorContext) => {
    reports.push({ error, phase: context.phase });
  };
  return { reports, onError };
}

const settled = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => "resolved",
    (error: unknown) => error,
  );

async function onPromise(options: Options): Promise<Harness> {
  const { reports, onError } = sink();
  const sub = options.sub ?? {
    kind: "failing",
    error: new Closed({ code: 1 }),
  };
  const rt = await runOnPromise(job, {
    onError,
    terminal,
    ...(options.supervision ? { supervision: options.supervision } : {}),
    ...(options.store ? { store: options.store } : {}),
    subscribe: {
      watch: (_sub, _ctx, dispatch) => {
        if (sub.kind === "failing") throw sub.error;
        if (sub.kind === "live") return sub.closed;
        dispatch(sub.to);
        return () => {};
      },
    },
  }).ready;
  return {
    reports,
    dispatch: (msg) => settled(rt.dispatch(msg)),
    done: () =>
      rt.done().then(
        (state): Answer => ({ kind: "state", state }),
        (error: unknown): Answer =>
          error instanceof SubFailedError
            ? { kind: "sub-failed", cause: error.cause }
            : { kind: "failed", error },
      ),
    result: () => rt.result(),
    getState: () => rt.getState(),
    stop: () => rt.stop(),
  };
}

function effectSub(
  sub: NonNullable<Options["sub"]>,
): Stream.Stream<Msg, unknown> {
  switch (sub.kind) {
    case "failing":
      return Stream.fail(sub.error);
    case "mapped":
      return Stream.make(sub.to).pipe(Stream.concat(Stream.never));
    case "live":
      return Stream.never.pipe(Stream.ensuring(Effect.sync(sub.closed)));
  }
}

async function onEffect(options: Options): Promise<Harness> {
  const { reports, onError } = sink();
  const sub = options.sub ?? {
    kind: "failing",
    error: new Closed({ code: 1 }),
  };
  const scope = await Effect.runPromise(Scope.make());
  const booting = await Effect.runPromise(
    Scope.provide(scope)(
      runOnEffect(job, {
        onError,
        terminal,
        ...(options.supervision ? { supervision: options.supervision } : {}),
        ...(options.store ? { store: options.store } : {}),
        subscribe: {
          watch: () => effectSub(sub),
        },
      }),
    ),
  );
  const rt = await Effect.runPromise(booting.ready);
  return {
    reports,
    dispatch: (msg) =>
      Effect.runPromiseExit(rt.dispatch(msg)).then((exit) =>
        Exit.isSuccess(exit) ? "resolved" : Cause.squash(exit.cause),
      ),
    done: () =>
      Effect.runPromiseExit(rt.done()).then((exit): Answer => {
        if (Exit.isSuccess(exit)) return { kind: "state", state: exit.value };
        const error = Cause.squash(exit.cause);
        return error instanceof SubFailed
          ? { kind: "sub-failed", cause: error.cause }
          : { kind: "failed", error };
      }),
    result: () => rt.result(),
    getState: () => rt.getState(),
    stop: () => Effect.runPromise(rt.stop()),
  };
}

const engines = [
  ["Promise", (options: Options = {}) => onPromise(options)],
  ["Effect", (options: Options = {}) => onEffect(options)],
] as const;

const LIMIT_MS = 2_000;
const STILL_WAITING_MS = 50;

/** `done()`'s answer, or a failed test past the limit: the bug here is a hang. */
function within(answer: Promise<Answer>): Promise<Answer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`done() had not settled after ${LIMIT_MS}ms`)),
      LIMIT_MS,
    );
  });
  return Promise.race([answer, limit]).finally(() => clearTimeout(timer));
}

/** True when `answer` has not settled once the run has had time to settle it. */
async function stillWaiting(answer: Promise<Answer>): Promise<boolean> {
  const waiting = Symbol("waiting");
  const seen = await Promise.race([
    answer,
    new Promise<symbol>((resolve) => {
      setTimeout(() => resolve(waiting), STILL_WAITING_MS);
    }),
  ]);
  return seen === waiting;
}

// === The job the host hired tea for ===

describe.each(engines)("%s engine: a host waiting on many jobs", (_, start) => {
  it("hears the one job that died, and the others fold on to their own terminal States", async () => {
    const closed = new Closed({ code: 7 });
    const [first, dying, last] = await Promise.all([
      start(),
      start({ sub: { kind: "failing", error: closed } }),
      start(),
    ]);
    const [firstDone, dyingDone, lastDone] = [
      first.done(),
      dying.done(),
      last.done(),
    ];

    await Promise.all([
      first.dispatch({ type: "work" }),
      last.dispatch({ type: "work" }),
    ]);
    await dying.dispatch({ type: "arm" });

    expect(await within(dyingDone)).toEqual({
      kind: "sub-failed",
      cause: closed,
    });
    expect(dying.reports).toContainEqual({ error: closed, phase: "sub" });
    expect(dying.result()).toBeUndefined();

    // The others heard nothing of it, and neither has answered yet.
    expect(first.reports).toEqual([]);
    expect(last.reports).toEqual([]);
    expect(await stillWaiting(firstDone)).toBe(true);
    expect(await stillWaiting(lastDone)).toBe(true);

    for (const survivor of [first, last]) {
      for (let i = 0; i < 25; i++) await survivor.dispatch({ type: "work" });
      await survivor.dispatch({ type: "finish" });
    }

    const expected: Answer = {
      kind: "state",
      state: { worked: 26, armed: false, finished: true },
    };
    expect(await within(firstDone)).toEqual(expected);
    expect(await within(lastDone)).toEqual(expected);
    await Promise.all([first.stop(), dying.stop(), last.stop()]);
  });

  it("gives the same answers on every pass through a process", async () => {
    const closed = new Closed({ code: 8 });
    const answers: Answer[] = [];
    for (let pass = 0; pass < 5; pass++) {
      const dying = await start({ sub: { kind: "failing", error: closed } });
      const waiting = dying.done();
      await dying.dispatch({ type: "arm" });
      answers.push(await within(waiting));
      await dying.stop();
    }
    expect(answers).toEqual(
      Array.from({ length: 5 }, () => ({
        kind: "sub-failed",
        cause: closed,
      })),
    );
  });
});

// === A done() that comes after the close ===

describe.each(engines)("%s engine: a later done()", (_, start) => {
  it("fails with the Sub's error once the run has closed", async () => {
    const closed = new Closed({ code: 2 });
    const dying = await start({ sub: { kind: "failing", error: closed } });

    await dying.dispatch({ type: "arm" });
    await within(dying.done());

    expect(await within(dying.done())).toEqual({
      kind: "sub-failed",
      cause: closed,
    });
    await dying.stop();
  });

  it("fails with the reducer's error once the run has closed", async () => {
    const rt = await start();

    await rt.dispatch({ type: "explode" });
    await within(rt.done());

    expect(await within(rt.done())).toEqual({ kind: "failed", error: boom });
    await rt.stop();
  });
});

// === A reducer throw ===

describe.each(engines)("%s engine: a reducer throw", (_, start) => {
  it("under the default strategy fails a done() already waiting, with that error", async () => {
    const rt = await start();
    const waiting = rt.done();

    const dispatched = await rt.dispatch({ type: "explode" });

    expect(dispatched).toBe(boom);
    expect(await within(waiting)).toEqual({ kind: "failed", error: boom });
    expect(rt.reports).toEqual([{ error: boom, phase: "reduce" }]);
    expect(rt.result()).toBeUndefined();
    await rt.stop();
  });

  it('under an explicit "stop" fails done() the same way', async () => {
    const rt = await start({ supervision: "stop" });
    const waiting = rt.done();

    await rt.dispatch({ type: "explode" });

    expect(await within(waiting)).toEqual({ kind: "failed", error: boom });
    await rt.stop();
  });

  it("under escalate leaves the run live and done() waiting", async () => {
    const rt = await start({ supervision: "escalate" });
    const waiting = rt.done();

    expect(await rt.dispatch({ type: "explode" })).toBe(boom);

    expect(await stillWaiting(waiting)).toBe(true);
    expect(await rt.dispatch({ type: "work" })).toBe("resolved");
    expect(rt.getState().worked).toBe(1);

    await rt.dispatch({ type: "finish" });
    expect(await within(waiting)).toEqual({
      kind: "state",
      state: { worked: 1, armed: false, finished: true },
    });
    await rt.stop();
  });

  it("a Msg already in line that reaches a terminal State makes that State the one answer", async () => {
    const rt = await start();
    const waiting = rt.done();

    const dispatches = [
      rt.dispatch({ type: "explode" }),
      rt.dispatch({ type: "finish" }),
    ];
    await Promise.all(dispatches);

    const answer: Answer = {
      kind: "state",
      state: { worked: 0, armed: false, finished: true },
    };
    expect(await within(waiting)).toEqual(answer);
    expect(await within(rt.done())).toEqual(answer);
    expect(rt.result()).toEqual(answer.state);
    await rt.stop();
  });

  it("a Msg already in line that reaches no terminal State folds before done() fails", async () => {
    const rt = await start();
    const waiting = rt.done();

    await Promise.all([
      rt.dispatch({ type: "explode" }),
      rt.dispatch({ type: "work" }),
    ]);

    expect(await within(waiting)).toEqual({ kind: "failed", error: boom });
    expect(rt.getState().worked).toBe(1);
    await rt.stop();
  });

  it("after a Sub failure already closed the run keeps the Sub's answer", async () => {
    const closed = new Closed({ code: 3 });
    const rt = await start({ sub: { kind: "failing", error: closed } });
    const waiting = rt.done();

    await Promise.all([
      rt.dispatch({ type: "arm" }),
      rt.dispatch({ type: "explode" }),
    ]);

    expect(await within(waiting)).toEqual({
      kind: "sub-failed",
      cause: closed,
    });
    await rt.stop();
  });
});

// === What a host must still do after a reducer throw ===

/** A store that counts its saves, and the Sub's closing counted beside it. */
function watched() {
  const memory = memoryStore<Model>();
  const seen = { saves: 0, closes: 0 };
  const store: UnfencedStore<Model> = {
    ...memory,
    save: async (state) => {
      seen.saves++;
      await memory.save(state);
    },
  };
  const closed = () => {
    seen.closes++;
  };
  return { seen, store, sub: { kind: "live", closed } as const };
}

describe.each(
  engines,
)("%s engine: after a reducer throw fails done()", (_, start) => {
  it("the Sub and the final save wait for the host's stop()", async () => {
    const { seen, store, sub } = watched();
    const rt = await start({ sub, store });
    const waiting = rt.done();

    await rt.dispatch({ type: "arm" });
    await rt.dispatch({ type: "explode" });
    expect(await within(waiting)).toEqual({ kind: "failed", error: boom });

    const savesBeforeStop = seen.saves;
    expect(seen.closes).toBe(0);

    await rt.stop();

    expect(seen.closes).toBe(1);
    expect(seen.saves).toBe(savesBeforeStop + 1);
  });
});

describe("Effect engine: after a reducer throw fails done()", () => {
  it("closing the Scope does what stop() does", async () => {
    const { seen, store, sub } = watched();
    const { onError } = sink();
    const scope = await Effect.runPromise(Scope.make());
    const booting = await Effect.runPromise(
      Scope.provide(scope)(
        runOnEffect(job, {
          onError,
          terminal,
          store,
          subscribe: { watch: () => effectSub(sub) },
        }),
      ),
    );
    const rt = await Effect.runPromise(booting.ready);
    const waiting = Effect.runPromiseExit(rt.done());

    await Effect.runPromiseExit(rt.dispatch({ type: "arm" }));
    await Effect.runPromiseExit(rt.dispatch({ type: "explode" }));
    expect(Exit.isFailure(await waiting)).toBe(true);

    const savesBeforeClose = seen.saves;
    expect(seen.closes).toBe(0);

    await Effect.runPromise(Scope.close(scope, Exit.void));

    expect(seen.closes).toBe(1);
    expect(seen.saves).toBe(savesBeforeClose + 1);
  });
});

// === A State that was already final ===

describe.each(engines)("%s engine: a saved terminal State", (_, start) => {
  it("still answers from done() and result() after a Sub fails", async () => {
    const closed = new Closed({ code: 4 });
    const rt = await start({
      sub: { kind: "failing", error: closed },
      store: memoryStore<Model>(),
    });
    const state: Model = { worked: 0, armed: true, finished: true };

    await rt.dispatch({ type: "finish" });
    await rt.dispatch({ type: "arm" });

    expect(rt.reports).toContainEqual({ error: closed, phase: "sub" });
    expect(await within(rt.done())).toEqual({ kind: "state", state });
    expect(rt.result()).toEqual(state);
    await rt.stop();
  });

  it("still answers from done() and result() after a reducer throw", async () => {
    const rt = await start({ store: memoryStore<Model>() });
    const state: Model = { worked: 0, armed: false, finished: true };

    await rt.dispatch({ type: "finish" });
    expect(await rt.dispatch({ type: "explode" })).toBe(boom);

    expect(await within(rt.done())).toEqual({ kind: "state", state });
    expect(rt.result()).toEqual(state);
    await rt.stop();
  });
});

// === What stays as it was ===

describe.each(engines)("%s engine: what does not change", (_, start) => {
  it("a Sub that maps its failure to a Msg keeps the run going and done() waiting", async () => {
    const rt = await start({
      sub: { kind: "mapped", to: { type: "work" } },
    });
    const waiting = rt.done();

    await rt.dispatch({ type: "arm" });

    expect(await stillWaiting(waiting)).toBe(true);
    expect(rt.getState().worked).toBe(1);
    expect(rt.reports).toEqual([]);

    await rt.dispatch({ type: "finish" });
    expect(await within(waiting)).toEqual({
      kind: "state",
      state: { worked: 1, armed: true, finished: true },
    });
    await rt.stop();
  });

  it("a plain stop() with no failure leaves a waiting done() and a later one pending", async () => {
    const rt = await start();
    const waiting = rt.done();

    await rt.stop();

    expect(await stillWaiting(waiting)).toBe(true);
    expect(await stillWaiting(rt.done())).toBe(true);
  });
});

describe("a failed terminal save still fails done() as it did", () => {
  const refused = new Error("save refused");
  const refusing = () => {
    const store = memoryStore<Model>();
    return {
      ...store,
      save: async (state: Model) => {
        if (state.finished) throw refused;
        await store.save(state);
      },
    };
  };

  it("Promise engine: rejects with the store's own throw", async () => {
    const { onError } = sink();
    const rt = await runOnPromise(job, {
      onError,
      terminal,
      store: refusing(),
      subscribe: { watch: () => () => {} },
    }).ready;
    const waiting = rt.done().catch((error: unknown) => error);

    await settled(rt.dispatch({ type: "finish" }));

    expect(await waiting).toBe(refused);
    expect(await rt.done().catch((error: unknown) => error)).toBe(refused);
    await rt.stop();
  });

  it("Effect engine: fails with StoreFailed", async () => {
    const { onError } = sink();
    const scope = await Effect.runPromise(Scope.make());
    const booting = await Effect.runPromise(
      Scope.provide(scope)(
        runOnEffect(job, {
          onError,
          terminal,
          store: refusing(),
          subscribe: { watch: () => Stream.never },
        }),
      ),
    );
    const rt = await Effect.runPromise(booting.ready);
    const waiting = Effect.runPromise(Effect.flip(rt.done()));

    await Effect.runPromiseExit(rt.dispatch({ type: "finish" }));

    const failure = await waiting;
    expect(failure._tag).toBe("StoreFailed");
    expect((failure as { cause: unknown }).cause).toBe(refused);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});

describe("a reducer throw reaches done() as it was thrown", () => {
  const throwing = defineMachine({
    types: { model: {} as { readonly on: true }, msg: {} as Msg },
    init: (loaded) => [loaded ?? { on: true }, []],
    update: {
      work: (m) => [m, []],
      finish: (m) => [m, []],
      arm: (m) => [m, []],
      explode: () => {
        throw undefined;
      },
    },
  });

  it("Promise engine: even `undefined`", async () => {
    const { onError } = sink();
    const rt = await runOnPromise(throwing, { onError }).ready;
    const waiting = rt.done().then(
      () => "resolved",
      (error: unknown) => ({ rejectedWith: error }),
    );

    await settled(rt.dispatch({ type: "explode" }));

    expect(await waiting).toEqual({ rejectedWith: undefined });
    await rt.stop();
  });

  it("Effect engine: even `undefined`, as a defect", async () => {
    const { onError } = sink();
    const scope = await Effect.runPromise(Scope.make());
    const booting = await Effect.runPromise(
      Scope.provide(scope)(runOnEffect(throwing, { onError })),
    );
    const rt = await Effect.runPromise(booting.ready);
    const waiting = Effect.runPromiseExit(rt.done());

    await Effect.runPromiseExit(rt.dispatch({ type: "explode" }));

    const exit = await waiting;
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});

describe("a Msg with no cell is a refusal, not a failure", () => {
  type Latch = { readonly type: "closed" } | { readonly type: "open" };
  type LatchMsg = { readonly type: "open" } | { readonly type: "close" };
  const latchUpdate: Transitions<Latch, LatchMsg, never> = {
    closed: { open: () => [{ type: "open" }, []] },
    open: { close: () => [{ type: "closed" }, []] },
  };
  const latch = defineMachine({
    types: { model: {} as Latch, msg: {} as LatchMsg },
    init: (loaded) => [loaded ?? { type: "closed" }, []],
    update: latchUpdate,
  });
  const isOpen = (state: Latch): boolean => state.type === "open";

  it("Promise engine: done() keeps waiting and the run goes on", async () => {
    const { onError } = sink();
    const rt = await runOnPromise(latch, {
      onError,
      terminal: isOpen,
    }).ready;
    const waiting = rt.done();

    await expect(rt.dispatch({ type: "close" })).rejects.toBeInstanceOf(
      NoCellError,
    );

    await rt.dispatch({ type: "open" });
    expect(await waiting).toEqual({ type: "open" });
    await rt.stop();
  });

  it("Effect engine: done() keeps waiting and the run goes on", async () => {
    const { onError } = sink();
    const scope = await Effect.runPromise(Scope.make());
    const booting = await Effect.runPromise(
      Scope.provide(scope)(runOnEffect(latch, { onError, terminal: isOpen })),
    );
    const rt = await Effect.runPromise(booting.ready);
    const waiting = Effect.runPromise(rt.done());

    await Effect.runPromiseExit(rt.dispatch({ type: "close" }));

    await Effect.runPromise(rt.dispatch({ type: "open" }));
    expect(await waiting).toEqual({ type: "open" });
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});

describe("a handler that never returns, in line behind a reducer throw", () => {
  type Hang = { readonly type: "hang" };
  type Stuck = { readonly hung: boolean };
  const stuck = defineMachine({
    types: {
      model: {} as Stuck,
      msg: {} as { readonly type: "explode" } | { readonly type: "wait" },
      cmd: {} as Hang,
    },
    init: (loaded) => [loaded ?? { hung: false }, []],
    update: {
      explode: () => {
        throw boom;
      },
      wait: (m) => [{ ...m, hung: true }, [{ type: "hang" }]],
    },
  });

  it("Promise engine: done() answers once stop() gives up on it", async () => {
    const { onError } = sink();
    const rt = await runOnPromise(stuck, {
      onError,
      disposeTimeoutMs: 10,
      interpret: { hang: () => new Promise<void>(() => {}) },
    }).ready;
    const waiting = rt.done().catch((error: unknown) => error);

    void settled(rt.dispatch({ type: "explode" }));
    void settled(rt.dispatch({ type: "wait" }));
    await rt.stop();

    expect(await waiting).toBe(boom);
  });
});

describe.each(
  engines,
)("%s engine: a throw from a Msg with no caller", (_, start) => {
  it("reaches done() when a Sub's Msg is the one that throws", async () => {
    const rt = await start({
      sub: { kind: "mapped", to: { type: "explode" } },
    });
    const waiting = rt.done();

    await rt.dispatch({ type: "arm" });

    expect(await within(waiting)).toEqual({ kind: "failed", error: boom });
    expect(rt.reports).toContainEqual({ error: boom, phase: "reduce" });
    await rt.stop();
  });

  it("leaves the other runs in the process folding", async () => {
    const [dying, other] = await Promise.all([start(), start()]);
    const [dyingDone, otherDone] = [dying.done(), other.done()];

    await dying.dispatch({ type: "explode" });
    expect(await within(dyingDone)).toEqual({ kind: "failed", error: boom });

    await other.dispatch({ type: "work" });
    await other.dispatch({ type: "finish" });
    expect(await within(otherDone)).toEqual({
      kind: "state",
      state: { worked: 1, armed: false, finished: true },
    });
    await Promise.all([dying.stop(), other.stop()]);
  });
});

describe("Effect engine: how a reducer throw reaches done()", () => {
  it("is a defect: the typed channel stays StoreFailed | SubFailed", async () => {
    const { onError } = sink();
    const scope = await Effect.runPromise(Scope.make());
    const booting = await Effect.runPromise(
      Scope.provide(scope)(
        runOnEffect(job, {
          onError,
          terminal,
          subscribe: { watch: () => Stream.never },
        }),
      ),
    );
    const rt = await Effect.runPromise(booting.ready);

    await Effect.runPromiseExit(rt.dispatch({ type: "explode" }));
    const exit = await Effect.runPromiseExit(rt.done());

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(boom);
    }
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
