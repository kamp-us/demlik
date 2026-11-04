// @vitest-environment happy-dom
import { Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DispatchDiscardedError,
  defineMachine,
  type Reducer,
  type Store,
  type Sub,
} from "../index";
import { memoryStore } from "../mem";
import { useMachine } from "../react/index";
import { runIn } from "./index";

// The edges of `useMachine` on `runIn` (#852): an async Layer, a restored State
// shown while its Cmd runs (#695), the identity of `runIn`, and Stop.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class Greeter extends Context.Service<
  Greeter,
  { readonly greet: (name: string) => string }
>()("test/Greeter") {}

type State = { readonly trail: string; readonly greeting: string };
type Msg =
  | { readonly type: "mark"; readonly ch: string }
  | { readonly type: "greet" }
  | { readonly type: "greeted"; readonly text: string };
type Say = { readonly type: "say" };
type Ticker = Sub<"ticker", { readonly id: string }>;

const greeter = defineMachine({
  types: {
    model: {} as State,
    msg: {} as Msg,
    cmd: {} as Say,
    sub: {} as Ticker,
    ctx: undefined,
  },
  init: () => [{ trail: "", greeting: "" }, []],
  update: {
    mark: (s, msg) => [{ ...s, trail: s.trail + msg.ch }, []],
    greet: (s) => [s, [{ type: "say" }]],
    greeted: (s, msg) => [{ ...s, greeting: msg.text }, []],
  },
  subs: [{ type: "ticker", deps: () => ({ id: "t" }) }],
});

/** The Layer builds when `open` is called. */
function gatedLayer() {
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const layer = Layer.effect(
    Greeter,
    Effect.promise(() => gate).pipe(
      Effect.as({ greet: (name: string) => `hello ${name}` }),
    ),
  );
  return { layer, open };
}

/** What the handlers of `greeter` do, counted. */
function probe() {
  const seen = {
    said: 0,
    interrupted: 0,
    acquired: 0,
    released: 0,
    live: 0,
    starts: 0,
    cleanups: 0,
  };
  const interpret = {
    say: () =>
      Effect.gen(function* () {
        const service = yield* Greeter;
        seen.said += 1;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            seen.acquired += 1;
          }),
          () =>
            Effect.sync(() => {
              seen.released += 1;
            }),
        );
        return { type: "greeted", text: service.greet("x") } as const;
      }),
  };
  const subscribe = {
    ticker: () =>
      Stream.never.pipe(
        Stream.onStart(
          Effect.sync(() => {
            seen.live += 1;
            seen.starts += 1;
          }),
        ),
        Stream.ensuring(
          Effect.sync(() => {
            seen.live -= 1;
            seen.cleanups += 1;
          }),
        ),
      ),
  };
  return { seen, interpret, subscribe };
}

const beat = () => new Promise((resolve) => setTimeout(resolve, 5));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const text = () => container.textContent;

/** A page on `greeter` that hands its `send` out. */
function pageOn(
  runtime: ManagedRuntime.ManagedRuntime<Greeter, unknown>,
  handlers: ReturnType<typeof probe>,
  onError: () => void = () => {},
) {
  const slot: { send?: (msg: Msg) => void } = {};
  function Page() {
    const [state, send] = useMachine(greeter, {
      run: runIn(runtime),
      ctx: undefined,
      onError,
      interpret: handlers.interpret,
      subscribe: handlers.subscribe,
    });
    slot.send = send;
    return (
      <p>
        {state.trail}|{state.greeting}
      </p>
    );
  }
  return { Page, slot };
}

describe("an async Layer", () => {
  it("holds a Msg sent before the Layer is built and folds it, in order, in one run", async () => {
    const { layer, open } = gatedLayer();
    const runtime = ManagedRuntime.make(layer);
    const handlers = probe();
    const onError = vi.fn();
    const { Page, slot } = pageOn(runtime, handlers, onError);
    try {
      await act(async () =>
        root.render(
          <StrictMode>
            <Page />
          </StrictMode>,
        ),
      );
      await act(beat);
      expect(text()).toBe("|");
      expect(handlers.seen.starts).toBe(0);

      await act(async () => {
        slot.send?.({ type: "mark", ch: "a" });
        slot.send?.({ type: "mark", ch: "b" });
        slot.send?.({ type: "greet" });
        slot.send?.({ type: "mark", ch: "c" });
      });
      expect(text()).toBe("|");
      expect(handlers.seen.said).toBe(0);

      open();
      await act(beat);
      expect(text()).toBe("abc|hello x");
      expect(handlers.seen).toMatchObject({
        said: 1,
        starts: 1,
        live: 1,
        cleanups: 0,
      });
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it("reaches onError once under boot when the Layer fails, and refuses what was sent to the run", async () => {
    const runtime = ManagedRuntime.make(
      Layer.effect(Greeter, Effect.fail(new Error("no greeter"))),
    );
    const handlers = probe();
    const onError = vi.fn();
    const { Page, slot } = pageOn(runtime, handlers, onError);
    try {
      await act(async () =>
        root.render(
          <StrictMode>
            <Page />
          </StrictMode>,
        ),
      );
      await act(async () => {
        slot.send?.({ type: "mark", ch: "a" });
      });
      await act(beat);
      await act(async () => {
        slot.send?.({ type: "mark", ch: "b" });
      });

      expect(onError.mock.calls).toEqual([
        [expect.objectContaining({ message: "no greeter" }), { phase: "boot" }],
        [expect.any(DispatchDiscardedError), { phase: "discard" }],
        [expect.any(DispatchDiscardedError), { phase: "discard" }],
      ]);
      expect(text()).toBe("|");
      expect(handlers.seen.starts).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("never starts the run when the component is gone before the Layer is built", async () => {
    const { layer, open } = gatedLayer();
    const runtime = ManagedRuntime.make(layer);
    const handlers = probe();
    const onError = vi.fn();
    const { Page, slot } = pageOn(runtime, handlers, onError);
    try {
      await act(async () => root.render(<Page />));
      await act(async () => {
        slot.send?.({ type: "greet" });
      });
      await act(async () => root.render(null));
      open();
      await act(beat);

      expect(handlers.seen).toMatchObject({ said: 0, starts: 0, cleanups: 0 });
      expect(onError.mock.calls).toEqual([
        [expect.any(DispatchDiscardedError), { phase: "discard" }],
      ]);
    } finally {
      await runtime.dispose();
    }
  });
});

describe("a State restored by a reload, shown while its Cmd runs (#695)", () => {
  type Phase = "idle" | "reading" | "thinking" | "writing" | "done";
  type Phased = { readonly phase: Phase };
  type Step =
    | { readonly type: "read" }
    | { readonly type: "think" }
    | { readonly type: "write" };
  type Move =
    | { readonly type: "read" }
    | { readonly type: "thought" }
    | { readonly type: "wrote" };

  const update: Reducer<Phased, Move, Step> = {
    read: () => [{ phase: "thinking" }, [{ type: "think" }]],
    thought: () => [{ phase: "writing" }, [{ type: "write" }]],
    wrote: () => [{ phase: "done" }, []],
  };

  const resumed = defineMachine({
    types: {
      model: {} as Phased,
      msg: {} as Move,
      cmd: {} as Step,
      ctx: undefined,
    },
    init: (loaded) =>
      loaded?.phase === "reading"
        ? [loaded, [{ type: "read" as const }]]
        : [loaded ?? { phase: "idle" as const }, []],
    update,
  });

  const runtime = ManagedRuntime.make(Layer.empty);

  /** A handler that waits for the test to release it. */
  function held() {
    const releases = new Map<Step["type"], () => void>();
    const hold = (cmd: Step["type"], then: Move) => () =>
      Effect.promise(
        () =>
          new Promise<Move>((resolve) => {
            releases.set(cmd, () => resolve(then));
          }),
      );
    return {
      interpret: {
        read: hold("read", { type: "read" }),
        think: hold("think", { type: "thought" }),
        write: hold("write", { type: "wrote" }),
      },
      release: (cmd: Step["type"]) => releases.get(cmd)?.(),
    };
  }

  function Page(props: {
    readonly store: Store<Phased>;
    readonly handlers: ReturnType<typeof held>;
  }) {
    const [state] = useMachine(resumed, {
      run: runIn(runtime),
      ctx: undefined,
      store: props.store,
      interpret: props.handlers.interpret,
    });
    return <p>{state.phase}</p>;
  }

  it("shows the restored State while `init`'s Cmd is held, then each phase after it", async () => {
    const handlers = held();
    await act(async () =>
      root.render(
        <Page
          store={memoryStore<Phased>({ phase: "reading" })}
          handlers={handlers}
        />,
      ),
    );
    await act(beat);
    expect(text()).toBe("reading");

    for (const [cmd, shown] of [
      ["read", "thinking"],
      ["think", "writing"],
      ["write", "done"],
    ] as const) {
      handlers.release(cmd);
      await act(beat);
      expect(text()).toBe(shown);
    }
  });

  it("shows no State when nothing was saved", async () => {
    const handlers = held();
    await act(async () =>
      root.render(<Page store={memoryStore<Phased>()} handlers={handlers} />),
    );
    await act(beat);
    expect(text()).toBe("idle");
  });
});

describe("the identity of runIn", () => {
  it("is one function for a runtime, and another for another runtime", async () => {
    const a = ManagedRuntime.make(Layer.empty);
    const b = ManagedRuntime.make(Layer.empty);
    try {
      expect(runIn(a)).toBe(runIn(a));
      expect(runIn(a)).not.toBe(runIn(b));
    } finally {
      await Promise.all([a.dispose(), b.dispose()]);
    }
  });
});

describe("Stop", () => {
  const stuck = Effect.promise(() => new Promise<never>(() => {}));

  function stuckProbe() {
    const handlers = probe();
    const seen = handlers.seen;
    return {
      ...handlers,
      interpret: {
        say: () =>
          Effect.gen(function* () {
            yield* handlers.interpret.say();
            return yield* stuck;
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                seen.interrupted += 1;
              }),
            ),
          ),
      },
    };
  }

  const settled = {
    said: 1,
    interrupted: 1,
    acquired: 1,
    released: 1,
    live: 0,
    starts: 1,
    cleanups: 1,
  };

  it("closes the run's Scope once on unmount: the Stream ends, the Cmd in flight is interrupted, what it acquired is released", async () => {
    const runtime = ManagedRuntime.make(
      Layer.succeed(Greeter, { greet: String }),
    );
    const handlers = stuckProbe();
    const { Page, slot } = pageOn(runtime, handlers);
    try {
      await act(async () =>
        root.render(
          <StrictMode>
            <Page />
          </StrictMode>,
        ),
      );
      await act(async () => {
        slot.send?.({ type: "greet" });
      });
      await act(beat);
      expect(handlers.seen).toMatchObject({
        said: 1,
        interrupted: 0,
        acquired: 1,
        released: 0,
        live: 1,
      });

      await act(async () => root.render(null));
      await act(beat);
      expect(handlers.seen).toEqual(settled);
    } finally {
      await runtime.dispose();
    }
  });

  it("closes it once however many times stop is asked", async () => {
    const runtime = ManagedRuntime.make(
      Layer.succeed(Greeter, { greet: String }),
    );
    const handlers = stuckProbe();
    try {
      const handle = runIn(runtime)(greeter, {
        ctx: undefined,
        interpret: handlers.interpret,
        subscribe: handlers.subscribe,
      });
      await handle.ready;
      handle.dispatch({ type: "greet" }).catch(() => {});
      await beat();

      const first = handle.stop();
      expect(handle.stop()).toBe(first);
      await Promise.all([first, handle.stop()]);
      await beat();
      expect(handlers.seen).toEqual(settled);
    } finally {
      await runtime.dispose();
    }
  });
});
