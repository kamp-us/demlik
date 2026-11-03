// @vitest-environment happy-dom
import {
  Activity,
  act,
  type ReactNode,
  StrictMode,
  useEffect,
  useMemo,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DispatchDiscardedError,
  defineMachine,
  type OnError,
  RuntimeDiscardedError,
  type Store,
  type Sub,
  type Subscribe,
} from "../index";
import { memoryStore } from "../mem";
import { run } from "../promise";
import { useMachine } from "./index";

// ───────────────────────────────────────────────────────────────────────────
// #764 — an effect's cleanup does not mean the component went away. Strict Mode
// runs it on mount and `<Activity>` runs it on hide, so `useMachine` has to
// survive both. Real react-dom root, real engine: the only stand-ins are the
// counters around `run` and the Sub runner.
// ───────────────────────────────────────────────────────────────────────────

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Count = { readonly n: number };
type Inc = { readonly type: "inc" };
type Probe = Sub<"probe", { readonly name: string }>;

/** A counter with one always-on Sub. Its `init` reads what a store loaded. */
function counter(name = "p") {
  return defineMachine({
    types: {
      model: {} as Count,
      msg: {} as Inc,
      sub: {} as Probe,
      ctx: undefined,
    },
    init: (loaded) => [loaded ?? { n: 0 }, []],
    update: { inc: (s) => [{ n: s.n + 1 }, []] },
    subs: [{ type: "probe", deps: () => ({ name }) }],
  });
}

/** Counts the Subs live right now and the starts and cleanups so far. */
function subProbe() {
  const probe = {
    live: 0,
    starts: 0,
    cleanups: 0,
    subscribe: {
      probe: () => {
        probe.live += 1;
        probe.starts += 1;
        return () => {
          probe.live -= 1;
          probe.cleanups += 1;
        };
      },
    } satisfies Subscribe<Inc, Probe, undefined>,
  };
  return probe;
}

/** The engine's `run`, counting the runs started and the runs stopped. */
function countedRun() {
  const counts = { started: 0, stopped: 0 };
  const counted = ((...args: Parameters<typeof run>) => {
    counts.started += 1;
    const handle = run(...args);
    const stop = handle.stop;
    handle.stop = () => {
      counts.stopped += 1;
      return stop();
    };
    return handle;
  }) as typeof run;
  return { counts, counted };
}

function parseCount(raw: unknown): Count | null {
  if (typeof raw !== "object" || raw === null) return null;
  const n = (raw as Record<string, unknown>).n;
  return typeof n === "number" ? { n } : null;
}

const beat = () => new Promise((resolve) => setTimeout(resolve, 5));

let container: HTMLDivElement;
let root: Root;

const render = (node: ReactNode) =>
  act(async () => {
    root.render(node);
  });

/** Commit `node`, then let a stop that commit began finish. */
const settle = async (node: ReactNode) => {
  await render(node);
  await act(beat);
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("useMachine under Strict Mode", () => {
  it("three components each fold every Msg and hold exactly one live Sub", async () => {
    const parts = ["a", "b", "c"].map((name) => {
      const machine = counter(name);
      const probe = subProbe();
      const { counts, counted } = countedRun();
      const slot: { dispatch?: (msg: Inc) => void } = {};
      function Part() {
        const [state, dispatch] = useMachine(machine, {
          run: counted,
          ctx: undefined,
          subscribe: probe.subscribe,
        });
        slot.dispatch = dispatch;
        return <span data-part={name}>{state.n}</span>;
      }
      return { name, probe, counts, slot, Part };
    });

    await render(
      <StrictMode>
        {parts.map(({ name, Part }) => (
          <Part key={name} />
        ))}
      </StrictMode>,
    );

    for (const [index, { name, probe, counts, slot }] of parts.entries()) {
      const msgs = index + 2;
      await act(async () => {
        for (let i = 0; i < msgs; i++)
          expect(slot.dispatch?.({ type: "inc" })).toBeUndefined();
      });
      expect(
        container.querySelector(`[data-part="${name}"]`)?.textContent,
      ).toBe(String(msgs));
      expect(probe.live).toBe(1);
      expect(probe.starts).toBe(1);
      expect(counts).toEqual({ started: 1, stopped: 0 });
    }
  });

  it("runs an `init` Cmd once and loses no in-flight result to the extra effect run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = vi.fn(async () => ({ type: "loaded" }) as const);
    const machine = defineMachine({
      types: {
        model: {} as { readonly phase: string },
        msg: {} as { readonly type: "loaded" },
        cmd: {} as { readonly type: "load" },
        ctx: undefined,
      },
      init: (_loaded) => [{ phase: "loading" }, [{ type: "load" }]],
      update: { loaded: () => [{ phase: "loaded" }, []] },
    });
    function Host() {
      const [state] = useMachine(machine, {
        run,
        ctx: undefined,
        interpret: { load: handler },
      });
      return <span>{state.phase}</span>;
    }

    await settle(
      <StrictMode>
        <Host />
      </StrictMode>,
    );

    expect(container.textContent).toBe("loaded");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps a Msg a child dispatches from its own mount effect", async () => {
    const machine = counter();
    const probe = subProbe();
    function Child({ inc }: { readonly inc: (msg: Inc) => void }) {
      useEffect(() => {
        inc({ type: "inc" });
      }, [inc]);
      return null;
    }
    function Parent() {
      const [state, dispatch] = useMachine(machine, {
        run,
        ctx: undefined,
        subscribe: probe.subscribe,
      });
      return (
        <>
          <span>{state.n}</span>
          <Child inc={dispatch} />
        </>
      );
    }

    // No Strict Mode: a child's effect runs before its parent's, so before the
    // run has started.
    await settle(<Parent />);
    expect(container.textContent).toBe("1");
  });
});

describe.each([
  ["no Strict Mode", (node: ReactNode): ReactNode => node],
  [
    "Strict Mode",
    (node: ReactNode): ReactNode => <StrictMode>{node}</StrictMode>,
  ],
] as const)("useMachine under <Activity>, %s", (_label, wrap) => {
  describe.each([
    ["storeless", (): Store<Count> | undefined => undefined],
    [
      "with a store",
      (): Store<Count> | undefined => memoryStore<Count>(undefined, parseCount),
    ],
  ] as const)("%s", (_kind, makeStore) => {
    function harness() {
      const onError = vi.fn<OnError>();
      const store = makeStore();
      const machine = counter();
      const probe = subProbe();
      const { counts, counted } = countedRun();
      const slot: { dispatch?: (msg: Inc) => void } = {};
      function Part() {
        const [state, dispatch] = useMachine(machine, {
          run: counted,
          ctx: undefined,
          store,
          subscribe: probe.subscribe,
          onError,
        });
        slot.dispatch = dispatch;
        return <span>{state.n}</span>;
      }
      const shown = (visible: boolean) =>
        wrap(
          <Activity mode={visible ? "visible" : "hidden"}>
            <Part />
          </Activity>,
        );
      return { store, probe, counts, slot, shown, onError };
    }

    it("keeps counting up through three hides and shows, with Msgs between", async () => {
      const { probe, slot, shown } = harness();
      await settle(shown(true));

      let expected = 0;
      for (let cycle = 0; cycle < 3; cycle++) {
        await act(async () => {
          expect(slot.dispatch?.({ type: "inc" })).toBeUndefined();
          expect(slot.dispatch?.({ type: "inc" })).toBeUndefined();
        });
        expected += 2;
        expect(container.textContent).toBe(String(expected));

        await settle(shown(false));
        expect(probe.live).toBe(0);

        await settle(shown(true));
        expect(container.textContent).toBe(String(expected));
        expect(probe.live).toBe(1);
      }
    });

    it("stops the Subs while hidden and starts them again on show", async () => {
      const { probe, shown } = harness();
      await settle(shown(true));
      expect(probe).toMatchObject({ live: 1, starts: 1, cleanups: 0 });

      await settle(shown(false));
      expect(probe).toMatchObject({ live: 0, starts: 1, cleanups: 1 });

      await settle(shown(true));
      expect(probe).toMatchObject({ live: 1, starts: 2, cleanups: 1 });
    });

    it("hands `dispatch` across a hide and show: same function, no error", async () => {
      const { slot, shown } = harness();
      await settle(shown(true));
      const kept = slot.dispatch;
      await act(async () => {
        expect(kept?.({ type: "inc" })).toBeUndefined();
      });

      await settle(shown(false));
      await settle(shown(true));

      expect(slot.dispatch).toBe(kept);
      await act(async () => {
        expect(kept?.({ type: "inc" })).toBeUndefined();
      });
      expect(container.textContent).toBe("2");
    });

    it("folds a Msg dispatched while hidden, and the show renders it", async () => {
      const { probe, slot, shown } = harness();
      await settle(shown(true));
      await settle(shown(false));

      await act(async () => {
        expect(slot.dispatch?.({ type: "inc" })).toBeUndefined();
      });
      expect(probe.live).toBe(0);

      await settle(shown(true));
      expect(container.textContent).toBe("1");
    });

    it("keeps one run across hides and shows", async () => {
      const { counts, shown } = harness();
      await settle(shown(true));
      for (let cycle = 0; cycle < 3; cycle++) {
        await settle(shown(false));
        await settle(shown(true));
      }
      expect(counts).toEqual({ started: 1, stopped: 0 });
    });

    it("leaves no run behind after a real unmount, and the final save happened", async () => {
      const { store, probe, counts, slot, shown, onError } = harness();
      await settle(shown(true));
      await act(async () => {
        expect(slot.dispatch?.({ type: "inc" })).toBeUndefined();
      });
      await settle(shown(false));
      await settle(shown(true));
      await act(async () => {
        expect(slot.dispatch?.({ type: "inc" })).toBeUndefined();
      });

      await settle(wrap(<div />));

      expect(counts).toEqual({ started: 1, stopped: 1 });
      expect(probe.live).toBe(0);
      expect(probe.cleanups).toBe(probe.starts);
      if (store !== undefined) {
        await expect(store.load()).resolves.toEqual({ n: 2 });
      }
      expect(slot.dispatch?.({ type: "inc" })).toBeUndefined();
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.any(DispatchDiscardedError),
        { phase: "discard" },
      );
    });

    it("stops the run when the hidden component really unmounts", async () => {
      const { store, probe, counts, slot, shown, onError } = harness();
      await settle(shown(true));
      await act(async () => {
        expect(slot.dispatch?.({ type: "inc" })).toBeUndefined();
      });
      await settle(shown(false));

      await settle(wrap(<div />));

      expect(counts).toEqual({ started: 1, stopped: 1 });
      expect(probe.cleanups).toBe(probe.starts);
      if (store !== undefined) {
        await expect(store.load()).resolves.toEqual({ n: 1 });
      }
      expect(slot.dispatch?.({ type: "inc" })).toBeUndefined();
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.any(DispatchDiscardedError),
        { phase: "discard" },
      );
    });

    it("on a first mount hidden, starts no run and holds a Msg for the first show", async () => {
      const { probe, counts, slot, shown, onError } = harness();
      await settle(shown(false));
      expect(counts).toEqual({ started: 0, stopped: 0 });

      expect(slot.dispatch?.({ type: "inc" })).toBeUndefined();
      await act(beat);
      expect(counts).toEqual({ started: 0, stopped: 0 });
      expect(onError).not.toHaveBeenCalled();

      await settle(shown(true));
      expect(container.textContent).toBe("1");
      expect(probe.live).toBe(1);
      expect(onError).not.toHaveBeenCalled();
    });

    it("refuses a held Msg when a first mount hidden really unmounts", async () => {
      const { counts, slot, shown, onError } = harness();
      await settle(shown(false));

      expect(slot.dispatch?.({ type: "inc" })).toBeUndefined();
      expect(onError).not.toHaveBeenCalled();
      await settle(wrap(<div />));

      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.any(DispatchDiscardedError),
        { phase: "discard" },
      );
      expect(counts).toEqual({ started: 0, stopped: 0 });
    });
  });
});

describe("useMachine: a real unmount", () => {
  it("still takes a last Msg from a child's effect cleanup, and saves it", async () => {
    const machine = counter();
    const store = memoryStore<Count>(undefined, parseCount);
    const probe = subProbe();
    function Child({ inc }: { readonly inc: (msg: Inc) => void }) {
      useEffect(
        () => () => {
          inc({ type: "inc" });
        },
        [inc],
      );
      return null;
    }
    function Parent() {
      const [state, dispatch] = useMachine(machine, {
        run,
        ctx: undefined,
        store,
        subscribe: probe.subscribe,
      });
      return (
        <>
          <span>{state.n}</span>
          <Child inc={dispatch} />
        </>
      );
    }

    await settle(<Parent />);
    await settle(<div />);

    await expect(store.load()).resolves.toEqual({ n: 1 });
    expect(probe.live).toBe(0);
  });
});

describe.each([
  ["no Strict Mode", (node: ReactNode): ReactNode => node],
  [
    "Strict Mode",
    (node: ReactNode): ReactNode => <StrictMode>{node}</StrictMode>,
  ],
] as const)("useMachine: a Cmd in flight at a hide, %s", (_label, wrap) => {
  type Load = { readonly phase: "idle" | "loading" | "loaded" };
  type LoadMsg = { readonly type: "start" } | { readonly type: "answered" };
  const types = {
    model: {} as Load,
    msg: {} as LoadMsg,
    cmd: {} as { readonly type: "fetch" },
    ctx: undefined,
  };
  const update = {
    start: (): [Load, { readonly type: "fetch" }[]] => [
      { phase: "loading" },
      [{ type: "fetch" }],
    ],
    answered: (): [Load, never[]] => [{ phase: "loaded" }, []],
  };
  const parseLoad = (raw: unknown): Load | null =>
    raw === null || raw === undefined ? null : (raw as Load);

  // `init` shows "loading" and starts the Cmd, or `update` does on `start`.
  const machines = {
    init: defineMachine({
      types,
      init: (loaded) =>
        loaded?.phase === "loaded"
          ? [loaded, []]
          : [{ phase: "loading" }, [{ type: "fetch" }]],
      update,
    }),
    update: defineMachine({
      types,
      init: (loaded) => [loaded ?? { phase: "idle" }, []],
      update,
    }),
  };

  describe.each([
    ["storeless", (): Store<Load> | undefined => undefined],
    [
      "with a store",
      (): Store<Load> | undefined => memoryStore<Load>(undefined, parseLoad),
    ],
  ] as const)("%s", (_kind, makeStore) => {
    describe.each([
      "init",
      "update",
    ] as const)("started by `%s`", (startedBy) => {
      it.each([
        "during the hide",
        "after the show",
      ] as const)("reaches the answer when it lands %s, and calls the handler once", async (landing) => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        let release = (): void => {};
        const answer = new Promise<void>((resolve) => {
          release = resolve;
        });
        const handler = vi.fn(async () => {
          await answer;
          return { type: "answered" } as const;
        });
        const store = makeStore();
        const { counts, counted } = countedRun();
        let dispatch: ((msg: LoadMsg) => void) | undefined;
        function Part() {
          const [state, d] = useMachine(machines[startedBy], {
            run: counted,
            ctx: undefined,
            store,
            interpret: { fetch: handler },
          });
          dispatch = d;
          return <span>{state.phase}</span>;
        }
        const shown = (visible: boolean) =>
          wrap(
            <Activity mode={visible ? "visible" : "hidden"}>
              <Part />
            </Activity>,
          );

        await settle(shown(true));
        if (startedBy === "update") {
          await act(async () => {
            expect(dispatch?.({ type: "start" })).toBeUndefined();
          });
        }
        // The engine tells listeners before a State's Cmds start (#695), so both
        // starts read as "loading" while the handler is held.
        expect(container.textContent).toBe("loading");
        expect(handler).toHaveBeenCalledTimes(1);

        await settle(shown(false));
        if (landing === "during the hide") {
          release();
          await act(beat);
          await settle(shown(true));
        } else {
          await settle(shown(true));
          expect(container.textContent).toBe("loading");
          release();
          await act(beat);
        }

        expect(container.textContent).toBe("loaded");
        expect(handler).toHaveBeenCalledTimes(1);
        expect(counts).toEqual({ started: 1, stopped: 0 });
        expect(warn).not.toHaveBeenCalled();
        if (store !== undefined) {
          await expect(store.load()).resolves.toEqual({ phase: "loaded" });
        }
        warn.mockRestore();
      });
    });
  });

  it("does not make a machine that resumes in `init` (ADR 0028) start the work twice", async () => {
    const machine = defineMachine({
      types,
      init: (loaded) =>
        loaded?.phase === "loaded"
          ? [loaded, []]
          : [{ phase: "loading" }, [{ type: "fetch" }]],
      update,
    });
    const store = memoryStore<Load>(undefined, parseLoad);
    await store.save({ phase: "loading" });
    let release = (): void => {};
    const answer = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async () => {
      await answer;
      return { type: "answered" } as const;
    });
    function Part() {
      const [state] = useMachine(machine, {
        run,
        ctx: undefined,
        store,
        interpret: { fetch: handler },
      });
      return <span>{state.phase}</span>;
    }
    const shown = (visible: boolean) =>
      wrap(
        <Activity mode={visible ? "visible" : "hidden"}>
          <Part />
        </Activity>,
      );

    await settle(shown(true));
    await settle(shown(false));
    await settle(shown(true));
    release();
    await act(beat);

    expect(container.textContent).toBe("loaded");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("stops the Subs while the Cmd is still running", async () => {
    const machine = defineMachine({
      types: {
        model: {} as Load,
        msg: {} as LoadMsg,
        cmd: {} as { readonly type: "fetch" },
        sub: {} as Probe,
        ctx: undefined,
      },
      init: (_loaded) => [{ phase: "loading" }, [{ type: "fetch" }]],
      update,
      subs: [{ type: "probe", deps: () => ({ name: "p" }) }],
    });
    let release = (): void => {};
    const answer = new Promise<void>((resolve) => {
      release = resolve;
    });
    const live = { subs: 0 };
    function Part() {
      const [state] = useMachine(machine, {
        run,
        ctx: undefined,
        interpret: {
          fetch: async () => {
            await answer;
            return { type: "answered" } as const;
          },
        },
        subscribe: {
          probe: () => {
            live.subs += 1;
            return () => {
              live.subs -= 1;
            };
          },
        },
      });
      return <span>{state.phase}</span>;
    }
    const shown = (visible: boolean) =>
      wrap(
        <Activity mode={visible ? "visible" : "hidden"}>
          <Part />
        </Activity>,
      );

    await settle(shown(true));
    expect(live.subs).toBe(1);
    await settle(shown(false));
    expect(live.subs).toBe(0);
    await settle(shown(true));
    expect(live.subs).toBe(1);
    release();
    await act(beat);
    expect(container.textContent).toBe("loaded");
  });

  it("still reports the loss on a real unmount with the Cmd in flight", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let release = (): void => {};
    const answer = new Promise<void>((resolve) => {
      release = resolve;
    });
    function Part() {
      const [state] = useMachine(machines.init, {
        run,
        ctx: undefined,
        interpret: {
          fetch: async () => {
            await answer;
            return { type: "answered" } as const;
          },
        },
      });
      return <span>{state.phase}</span>;
    }

    await settle(
      wrap(
        <Activity mode="visible">
          <Part />
        </Activity>,
      ),
    );
    await settle(wrap(<div />));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBeInstanceOf(RuntimeDiscardedError);
    release();
    await act(beat);
    warn.mockRestore();
  });
});

describe("useMachine under <Activity>: which Subs run", () => {
  type Flag = { readonly n: number; readonly fired: boolean };
  type FlagMsg = Inc | { readonly type: "fired" };

  it("stops the built-in `timer` while hidden, and the show starts its countdown over", async () => {
    const machine = defineMachine({
      types: { model: {} as Flag, msg: {} as FlagMsg, ctx: undefined },
      init: () => [{ n: 0, fired: false }, []],
      update: {
        inc: (s) => [{ ...s, n: s.n + 1 }, []],
        fired: (s) => [{ ...s, fired: true }, []],
      },
      subs: [
        {
          type: "timer",
          deps: (s) =>
            s.fired ? null : { ms: 30, msg: { type: "fired" } as const },
        },
      ],
    });
    function Part() {
      const [state] = useMachine(machine, { run, ctx: undefined });
      return <span>{state.fired ? "fired" : "waiting"}</span>;
    }
    const shown = (visible: boolean) => (
      <Activity mode={visible ? "visible" : "hidden"}>
        <Part />
      </Activity>
    );
    // A fake clock: on a real one, a slow machine lets the countdown run out
    // before the assertion that it has not.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const advance = (ms: number) =>
        act(async () => {
          vi.advanceTimersByTime(ms);
        });

      await render(shown(true));
      await render(shown(false));
      await advance(60);
      await render(shown(true));
      expect(container.textContent).toBe("waiting");

      await advance(29);
      expect(container.textContent).toBe("waiting");
      await advance(1);
      expect(container.textContent).toBe("fired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a `subscribe` entry named `timer` in place of the built-in", async () => {
    const machine = defineMachine({
      types: { model: {} as Flag, msg: {} as FlagMsg, ctx: undefined },
      init: () => [{ n: 0, fired: false }, []],
      update: {
        inc: (s) => [{ ...s, n: s.n + 1 }, []],
        fired: (s) => [{ ...s, fired: true }, []],
      },
      subs: [
        {
          type: "timer",
          deps: () => ({ ms: 60_000, msg: { type: "fired" } as const }),
        },
      ],
    });
    function Part() {
      const [state] = useMachine(machine, {
        run,
        ctx: undefined,
        subscribe: {
          timer: (sub, _ctx, dispatch) => {
            dispatch(sub.deps.msg);
            return () => {};
          },
        },
      });
      return <span>{state.fired ? "fired" : "waiting"}</span>;
    }

    await settle(<Part />);
    expect(container.textContent).toBe("fired");
  });

  it("starts a Sub the State asks for while hidden only on show", async () => {
    const machine = defineMachine({
      types: {
        model: {} as Count,
        msg: {} as Inc,
        sub: {} as Probe,
        ctx: undefined,
      },
      init: () => [{ n: 0 }, []],
      update: { inc: (s) => [{ n: s.n + 1 }, []] },
      subs: [{ type: "probe", deps: (s) => (s.n > 0 ? { name: "p" } : null) }],
    });
    const probe = subProbe();
    let dispatch: ((msg: Inc) => void) | undefined;
    function Part() {
      const [state, d] = useMachine(machine, {
        run,
        ctx: undefined,
        subscribe: probe.subscribe,
      });
      dispatch = d;
      return <span>{state.n}</span>;
    }
    const shown = (visible: boolean) => (
      <Activity mode={visible ? "visible" : "hidden"}>
        <Part />
      </Activity>
    );

    await settle(shown(true));
    await settle(shown(false));
    await act(async () => {
      expect(dispatch?.({ type: "inc" })).toBeUndefined();
    });
    expect(probe).toMatchObject({ live: 0, starts: 0 });

    await settle(shown(true));
    expect(probe).toMatchObject({ live: 1, starts: 1 });
  });

  it("does not bring back on show a Sub the State dropped while hidden", async () => {
    const machine = defineMachine({
      types: {
        model: {} as Count,
        msg: {} as Inc,
        sub: {} as Probe,
        ctx: undefined,
      },
      init: () => [{ n: 0 }, []],
      update: { inc: (s) => [{ n: s.n + 1 }, []] },
      subs: [
        { type: "probe", deps: (s) => (s.n === 0 ? { name: "p" } : null) },
      ],
    });
    const probe = subProbe();
    let dispatch: ((msg: Inc) => void) | undefined;
    function Part() {
      const [state, d] = useMachine(machine, {
        run,
        ctx: undefined,
        subscribe: probe.subscribe,
      });
      dispatch = d;
      return <span>{state.n}</span>;
    }
    const shown = (visible: boolean) => (
      <Activity mode={visible ? "visible" : "hidden"}>
        <Part />
      </Activity>
    );

    await settle(shown(true));
    await settle(shown(false));
    await act(async () => {
      expect(dispatch?.({ type: "inc" })).toBeUndefined();
    });
    await settle(shown(true));

    expect(probe).toMatchObject({ live: 0, starts: 1, cleanups: 1 });
  });

  it("reads the latest render's runner when a Sub starts again on show", async () => {
    const machine = counter();
    const started: string[] = [];
    function Part({ label }: { readonly label: string }) {
      const [state] = useMachine(machine, {
        run,
        ctx: undefined,
        subscribe: {
          probe: () => {
            started.push(label);
            return () => {};
          },
        },
      });
      return <span>{state.n}</span>;
    }
    const shown = (visible: boolean, label: string) => (
      <Activity mode={visible ? "visible" : "hidden"}>
        <Part label={label} />
      </Activity>
    );

    await settle(shown(true, "first"));
    await settle(shown(false, "first"));
    await settle(shown(true, "second"));

    expect(started).toEqual(["first", "second"]);
  });

  it("still reports a Sub type with no runner", async () => {
    const machine = counter();
    const onError = vi.fn<OnError>();
    let dispatch: ((msg: Inc) => void) | undefined;
    function Part() {
      const [state, d] = useMachine(machine, {
        run,
        ctx: undefined,
        subscribe: {} as Subscribe<Inc, Probe, undefined>,
        onError,
      });
      dispatch = d;
      return <span>{state.n}</span>;
    }

    await settle(<Part />);
    await act(async () => {
      expect(dispatch?.({ type: "inc" })).toBeUndefined();
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.stringContaining(
          'no subscribe runner for Sub type "probe"',
        ),
      }),
      { phase: "follow-up" },
    );
  });
});

describe("useMachine across a hide and show: the value and `init`", () => {
  it("keeps the value on a machine whose `init` ignores what it is given", async () => {
    const machine = defineMachine({
      types: { model: {} as Count, msg: {} as Inc, ctx: undefined },
      init: () => [{ n: 0 }, []],
      update: { inc: (s) => [{ n: s.n + 1 }, []] },
    });
    let dispatch: ((msg: Inc) => void) | undefined;
    function Part() {
      const [state, d] = useMachine(machine, { run, ctx: undefined });
      dispatch = d;
      return <span>{state.n}</span>;
    }
    const shown = (visible: boolean) => (
      <Activity mode={visible ? "visible" : "hidden"}>
        <Part />
      </Activity>
    );

    await settle(shown(true));
    await act(async () => {
      expect(dispatch?.({ type: "inc" })).toBeUndefined();
    });
    await settle(shown(false));
    await settle(shown(true));
    expect(container.textContent).toBe("1");
  });

  it("does not run `init`'s Cmds again on show", async () => {
    const handler = vi.fn(async () => {});
    const machine = defineMachine({
      types: {
        model: {} as Count,
        msg: {} as Inc,
        cmd: {} as { readonly type: "hello" },
        ctx: undefined,
      },
      init: (_loaded) => [{ n: 0 }, [{ type: "hello" }]],
      update: { inc: (s) => [{ n: s.n + 1 }, []] },
    });
    function Part() {
      const [state] = useMachine(machine, {
        run,
        ctx: undefined,
        interpret: { hello: handler },
      });
      return <span>{state.n}</span>;
    }
    const shown = (visible: boolean) => (
      <Activity mode={visible ? "visible" : "hidden"}>
        <Part />
      </Activity>
    );

    await settle(shown(true));
    await settle(shown(false));
    await settle(shown(true));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("folds Msgs queued behind a Cmd that spans a hide, in order", async () => {
    let release = (): void => {};
    const park = new Promise<void>((resolve) => {
      release = resolve;
    });
    const machine = defineMachine({
      types: {
        model: {} as Count,
        msg: {} as Inc | { readonly type: "park" },
        cmd: {} as { readonly type: "wait" },
        ctx: undefined,
      },
      init: () => [{ n: 0 }, []],
      update: {
        inc: (s) => [{ n: s.n + 1 }, []],
        park: (s) => [s, [{ type: "wait" }]],
      },
    });
    let dispatch: ((msg: Inc | { readonly type: "park" }) => void) | undefined;
    function Part() {
      const [state, d] = useMachine(machine, {
        run,
        ctx: undefined,
        interpret: {
          wait: async () => {
            await park;
          },
        },
      });
      dispatch = d;
      return <span>{state.n}</span>;
    }
    const shown = (visible: boolean) => (
      <Activity mode={visible ? "visible" : "hidden"}>
        <Part />
      </Activity>
    );

    await settle(shown(true));
    await act(async () => {
      expect(dispatch?.({ type: "park" })).toBeUndefined();
      expect(dispatch?.({ type: "inc" })).toBeUndefined();
    });
    // The run's queue is parked on the handler, with `inc` waiting behind it.
    await settle(shown(false));
    await settle(shown(true));
    expect(dispatch?.({ type: "inc" })).toBeUndefined();
    expect(container.textContent).toBe("0");

    release();
    await act(beat);
    expect(container.textContent).toBe("2");
  });
});

describe("useMachine: replacing the run under Strict Mode", () => {
  it("still replaces the run on a new ctx, with the warning, and leaves no run behind", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let release = (): void => {};
    const park = new Promise<void>((resolve) => {
      release = resolve;
    });
    const machine = defineMachine({
      types: {
        model: {} as Count,
        msg: {} as Inc,
        cmd: {} as { readonly type: "save" },
        ctx: {} as { readonly userId: string },
      },
      init: () => [{ n: 0 }, []],
      update: { inc: (s) => [{ n: s.n + 1 }, [{ type: "save" }]] },
    });
    const { counts, counted } = countedRun();
    let dispatch: ((msg: Inc) => void) | undefined;
    function Part({ userId }: { readonly userId: string }) {
      const ctx = useMemo(() => ({ userId }), [userId]);
      const [state, d] = useMachine(machine, {
        run: counted,
        ctx,
        interpret: {
          save: async () => {
            await park;
          },
        },
      });
      dispatch = d;
      return <span>{state.n}</span>;
    }

    await render(
      <StrictMode>
        <Part userId="u1" />
      </StrictMode>,
    );
    await act(async () => {
      expect(dispatch?.({ type: "inc" })).toBeUndefined();
    });
    expect(warn).not.toHaveBeenCalled();
    expect(counts).toEqual({ started: 1, stopped: 0 });

    await render(
      <StrictMode>
        <Part userId="u2" />
      </StrictMode>,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBeInstanceOf(RuntimeDiscardedError);
    expect(counts).toEqual({ started: 2, stopped: 1 });
    expect(container.textContent).toBe("0");

    release();
    await settle(<div />);
    expect(counts).toEqual({ started: 2, stopped: 2 });
    warn.mockRestore();
  });
});
