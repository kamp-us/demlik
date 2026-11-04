// @vitest-environment happy-dom
import { Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { Activity, act, type ReactNode, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { defineMachine, type Sub } from "../index";
import { useMachine } from "../react/index";
import { runIn } from "./index";

// The job (#852): an Effect-engine window of three tiles, each on `useMachine`
// and `runIn`, sharing one ManagedRuntime. Real react-dom root, real engine: the
// stand-ins are the counters around `run`, the Stream, and the Cmd's gate.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class Greeter extends Context.Service<
  Greeter,
  { readonly greet: (name: string) => string }
>()("test/Greeter") {}

type Tile = { readonly n: number; readonly greeting: string };
type Msg =
  | { readonly type: "inc" }
  | { readonly type: "greet" }
  | { readonly type: "greeted"; readonly text: string };
type Say = { readonly type: "say"; readonly name: string };
type Ticker = Sub<"ticker", { readonly name: string }>;

const names = ["a", "b", "c"] as const;
type Name = (typeof names)[number];

function tileMachine(name: Name) {
  return defineMachine({
    types: {
      model: {} as Tile,
      msg: {} as Msg,
      cmd: {} as Say,
      sub: {} as Ticker,
      ctx: undefined,
    },
    init: () => [{ n: 0, greeting: "" }, []],
    update: {
      inc: (s) => [{ ...s, n: s.n + 1 }, []],
      greet: (s) => [s, [{ type: "say", name }]],
      greeted: (s, msg) => [{ ...s, greeting: msg.text }, []],
    },
    subs: [{ type: "ticker", deps: () => ({ name }) }],
  });
}

const runtime = ManagedRuntime.make(
  Layer.succeed(Greeter, { greet: (name) => `hello ${name}` }),
);
const run = runIn(runtime);

/** What one tile counts, and the gate its Cmd waits at. */
function bookkeeping(name: Name) {
  let release = (): void => {};
  const answer = new Promise<void>((resolve) => {
    release = resolve;
  });
  const counts = { started: 0, stopped: 0 };
  const stream = { live: 0, starts: 0, cleanups: 0 };
  const counted = ((...args: Parameters<typeof run>) => {
    counts.started += 1;
    const handle = run(...args);
    const stop = handle.stop;
    handle.stop = () => {
      counts.stopped += 1;
      return stop.call(handle);
    };
    return handle;
  }) as typeof run;
  return {
    machine: tileMachine(name),
    counts,
    stream,
    counted,
    answer,
    release,
    send: undefined as ((msg: Msg) => void) | undefined,
  };
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

const settle = async (node: ReactNode) => {
  await act(async () => root.render(node));
  await act(beat);
};

it("three tiles on one runtime: one run each, Streams paused by a hide, a Cmd landing across it", async () => {
  const tiles = Object.fromEntries(
    names.map((name) => [name, bookkeeping(name)]),
  ) as Record<Name, ReturnType<typeof bookkeeping>>;

  function Part({ name }: { readonly name: Name }) {
    const t = tiles[name];
    const [state, send] = useMachine(t.machine, {
      run: t.counted,
      ctx: undefined,
      interpret: {
        say: (cmd) =>
          Effect.gen(function* () {
            const greeter = yield* Greeter;
            yield* Effect.promise(() => t.answer);
            return { type: "greeted", text: greeter.greet(cmd.name) } as const;
          }),
      },
      subscribe: {
        ticker: () =>
          Stream.never.pipe(
            Stream.onStart(
              Effect.sync(() => {
                t.stream.live += 1;
                t.stream.starts += 1;
              }),
            ),
            Stream.ensuring(
              Effect.sync(() => {
                t.stream.live -= 1;
                t.stream.cleanups += 1;
              }),
            ),
          ),
      },
    });
    t.send = send;
    return (
      <button
        type="button"
        data-tile={name}
        onClick={() => send({ type: "inc" })}
      >
        {name}:{state.n}:{state.greeting}
      </button>
    );
  }

  const window = (bHidden: boolean) => (
    <StrictMode>
      {names.map((name) => (
        <Activity
          key={name}
          mode={name === "b" && bHidden ? "hidden" : "visible"}
        >
          <Part name={name} />
        </Activity>
      ))}
    </StrictMode>
  );
  const text = (name: Name) =>
    container.querySelector(`[data-tile="${name}"]`)?.textContent;
  const click = (name: Name) =>
    act(async () => {
      (container.querySelector(`[data-tile="${name}"]`) as HTMLElement).click();
    });

  try {
    await settle(window(false));
    for (const name of names) {
      expect(tiles[name].counts).toEqual({ started: 1, stopped: 0 });
      expect(tiles[name].stream).toEqual({ live: 1, starts: 1, cleanups: 0 });
    }

    // Tile b's Cmd is in flight across the first hide and lands during it.
    await act(async () => {
      tiles.b.send?.({ type: "greet" });
    });
    for (let cycle = 1; cycle <= 3; cycle++) {
      await settle(window(true));
      expect(tiles.b.stream).toEqual({
        live: 0,
        starts: cycle,
        cleanups: cycle,
      });
      for (const other of ["a", "c"] as const) {
        expect(tiles[other].stream).toEqual({
          live: 1,
          starts: 1,
          cleanups: 0,
        });
      }
      if (cycle === 1) {
        tiles.b.release();
        await act(beat);
      }

      await settle(window(false));
      expect(tiles.b.stream).toEqual({
        live: 1,
        starts: cycle + 1,
        cleanups: cycle,
      });
      expect(text("b")).toBe("b:0:hello b");
      expect(tiles.b.counts).toEqual({ started: 1, stopped: 0 });
    }

    for (const name of names) await click(name);
    for (const name of names) await click(name);
    expect(text("a")).toBe("a:2:");
    expect(text("b")).toBe("b:2:hello b");
    expect(text("c")).toBe("c:2:");

    await settle(null);
    for (const name of names) {
      expect(tiles[name].counts).toEqual({ started: 1, stopped: 1 });
      expect(tiles[name].stream.live).toBe(0);
      expect(tiles[name].stream.cleanups).toBe(tiles[name].stream.starts);
    }

    // The caller's runtime is the caller's: still usable after the window.
    await expect(
      runtime.runPromise(
        Effect.gen(function* () {
          const greeter = yield* Greeter;
          return greeter.greet("after");
        }),
      ),
    ).resolves.toBe("hello after");
  } finally {
    await runtime.dispose();
  }
});
