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
  defineMachine,
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
      const slot: { dispatch?: (msg: Inc) => Promise<void> } = {};
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
        for (let i = 0; i < msgs; i++) await slot.dispatch?.({ type: "inc" });
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
    function Child({ inc }: { readonly inc: (msg: Inc) => Promise<void> }) {
      useEffect(() => {
        void inc({ type: "inc" });
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
      const store = makeStore();
      const machine = counter();
      const probe = subProbe();
      const { counts, counted } = countedRun();
      const slot: { dispatch?: (msg: Inc) => Promise<void> } = {};
      function Part() {
        const [state, dispatch] = useMachine(machine, {
          run: counted,
          ctx: undefined,
          store,
          subscribe: probe.subscribe,
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
      return { store, probe, counts, slot, shown };
    }

    it("keeps counting up through three hides and shows, with Msgs between", async () => {
      const { probe, slot, shown } = harness();
      await settle(shown(true));

      let expected = 0;
      for (let cycle = 0; cycle < 3; cycle++) {
        await act(async () => {
          await slot.dispatch?.({ type: "inc" });
          await slot.dispatch?.({ type: "inc" });
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
        await kept?.({ type: "inc" });
      });

      await settle(shown(false));
      await settle(shown(true));

      expect(slot.dispatch).toBe(kept);
      await act(async () => {
        await kept?.({ type: "inc" });
      });
      expect(container.textContent).toBe("2");
    });

    it("holds a Msg dispatched while hidden and folds it on show", async () => {
      const { slot, shown } = harness();
      await settle(shown(true));
      await settle(shown(false));

      let settled = false;
      const held = slot.dispatch?.({ type: "inc" }).then(() => {
        settled = true;
      });
      await act(beat);
      expect(settled).toBe(false);

      await settle(shown(true));
      await held;
      expect(settled).toBe(true);
      expect(container.textContent).toBe("1");
    });

    it("leaves no run behind after a real unmount, and the final save happened", async () => {
      const { store, probe, counts, slot, shown } = harness();
      await settle(shown(true));
      await act(async () => {
        await slot.dispatch?.({ type: "inc" });
      });
      await settle(shown(false));
      await settle(shown(true));
      await act(async () => {
        await slot.dispatch?.({ type: "inc" });
      });

      await settle(wrap(<div />));

      expect(counts).toEqual({ started: 2, stopped: 2 });
      expect(probe.live).toBe(0);
      expect(probe.cleanups).toBe(probe.starts);
      if (store !== undefined) {
        await expect(store.load()).resolves.toEqual({ n: 2 });
      }
      await expect(slot.dispatch?.({ type: "inc" })).rejects.toThrow(
        "@demlik/tea: runtime stopped",
      );
    });

    it("refuses a held Msg when the hidden component really unmounts", async () => {
      const { counts, slot, shown } = harness();
      await settle(shown(true));
      await settle(shown(false));

      const held = slot.dispatch?.({ type: "inc" });
      const refused = expect(held).rejects.toThrow(
        "@demlik/tea: runtime stopped",
      );
      await settle(wrap(<div />));

      await refused;
      expect(counts).toEqual({ started: 1, stopped: 1 });
    });
  });
});

describe("useMachine across a hide and show: the value and `init`", () => {
  it("keeps the value on a machine whose `init` ignores what it is given", async () => {
    const machine = defineMachine({
      types: { model: {} as Count, msg: {} as Inc, ctx: undefined },
      init: () => [{ n: 0 }, []],
      update: { inc: (s) => [{ n: s.n + 1 }, []] },
    });
    let dispatch: ((msg: Inc) => Promise<void>) | undefined;
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
      await dispatch?.({ type: "inc" });
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

  it("carries a Msg folded by a stop that was still running when the show came", async () => {
    let release = (): void => {};
    const park = new Promise<void>((resolve) => {
      release = resolve;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    let dispatch:
      | ((msg: Inc | { readonly type: "park" }) => Promise<void>)
      | undefined;
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
      void dispatch?.({ type: "park" });
      void dispatch?.({ type: "inc" });
    });
    // The hide's stop is parked on the handler, with `inc` queued behind it.
    await render(shown(false));
    await render(shown(true));
    const late = dispatch?.({ type: "inc" });
    expect(container.textContent).toBe("0");

    release();
    await act(async () => {
      await late;
    });
    expect(container.textContent).toBe("2");
    warn.mockRestore();
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
    let dispatch: ((msg: Inc) => Promise<void>) | undefined;
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
      void dispatch?.({ type: "inc" });
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
