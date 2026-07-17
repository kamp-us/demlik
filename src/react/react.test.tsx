// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defineMachine,
  type Reducer,
  run,
  type Store,
  type Sub,
  type Subscribe,
} from "../index";
import { memoryStore } from "../mem";
import { useMachine, useRuntime } from "./index";

// ───────────────────────────────────────────────────────────────────────────
// @demlik/tea/react — useMachine / useRuntime. Rendered with a real
// react-dom/client root under happy-dom (no renderer mocks): the runtime is
// the source of truth and React subscribes via useSyncExternalStore, so the
// tests must drive actual commits. The boot-race block pins the ref-capture
// design: a store-backed mount serves `init(null, ctx)` as the preliminary
// snapshot until `ready` resolves, then swaps to the booted runtime's state.
// ───────────────────────────────────────────────────────────────────────────

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type CounterState = { readonly n: number };
type CounterMsg = { readonly type: "inc" };

function parseCounter(raw: unknown): CounterState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const n = (raw as Record<string, unknown>).n;
  return typeof n === "number" ? { n } : null;
}

function counterMachine() {
  const update: Reducer<CounterState, CounterMsg, never> = {
    inc: (s) => [{ n: s.n + 1 }, []],
  };
  return defineMachine<CounterState, CounterMsg, never, never, undefined>({
    init: (loaded) => [loaded ?? { n: 0 }, []],
    update,
  });
}

let container: HTMLDivElement;
let root: Root;

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

describe("useMachine", () => {
  it("renders the machine's state and re-renders on dispatch", async () => {
    let dispatch: ((msg: CounterMsg) => Promise<void>) | null = null;
    const machine = counterMachine();

    function Counter() {
      const [state, d] = useMachine(machine, { ctx: undefined });
      dispatch = d;
      return <span data-testid="n">{state.n}</span>;
    }

    await act(async () => {
      root.render(<Counter />);
    });
    expect(container.textContent).toBe("0");

    await act(async () => {
      await dispatch?.({ type: "inc" });
    });
    expect(container.textContent).toBe("1");
  });

  it("boot race: serves init(null, ctx) preliminary state, then swaps to the store-loaded state once ready resolves (the ref capture)", async () => {
    // A store whose load we resolve by hand — the runtime stays mid-boot
    // (BootingRuntime, no total getState) for as long as we want.
    let resolveLoad: (raw: unknown) => void = () => {};
    const gate = new Promise<unknown>((r) => {
      resolveLoad = r;
    });
    const store: Store<CounterState> = {
      load: () => gate,
      save: async () => {},
      migrate: parseCounter,
    };
    const machine = counterMachine();

    function Counter() {
      const [state] = useMachine(machine, { ctx: undefined, store });
      return <span>{state.n}</span>;
    }

    await act(async () => {
      root.render(<Counter />);
    });
    // Mid-boot: React committed the PRELIMINARY snapshot — init(null, ctx)[0]
    // is { n: 0 }, not the persisted state and not a crash on getState().
    expect(container.textContent).toBe("0");

    // Boot completes: ready resolves, the effect captures the booted runtime
    // in the ref and forces the swap render (the boot fanout alone fires too
    // early — see the boot-race note in ./index.ts). Preliminary swaps to the
    // round-tripped store state with no dispatch.
    await act(async () => {
      resolveLoad({ n: 42 });
    });
    expect(container.textContent).toBe("42");
  });

  it("unmount stops the runtime: active sub cleanups run", async () => {
    type Phase = { readonly phase: "armed" };
    type M = { readonly type: "noop" };
    type ProbeSub = { id: string; type: "probe" } & Sub;
    const log: string[] = [];
    const subscribe: Subscribe<M, ProbeSub, undefined> = {
      probe: () => {
        log.push("install");
        return () => {
          log.push("cleanup");
        };
      },
    };
    const machine = defineMachine<Phase, M, never, ProbeSub, undefined>({
      init: () => [{ phase: "armed" }, []],
      update: { noop: (s) => [s, []] },
      subscriptions: () => [{ id: "p1", type: "probe" }],
      subscribe,
    });

    function Host() {
      useMachine(machine, { ctx: undefined });
      return null;
    }

    await act(async () => {
      root.render(<Host />);
    });
    expect(log).toEqual(["install"]);

    await act(async () => {
      root.render(<div />); // unmount Host → effect cleanup → runtime.stop()
    });
    // stop() is fire-and-forget from the cleanup; give its queue a beat.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(log).toEqual(["install", "cleanup"]);
  });

  it("persists through the store across mount lives — the round-trip tracer", async () => {
    const store = memoryStore<CounterState>(undefined, parseCounter);
    const machine = counterMachine();
    let dispatch: ((msg: CounterMsg) => Promise<void>) | null = null;

    function Counter() {
      const [state, d] = useMachine(machine, { ctx: undefined, store });
      dispatch = d;
      return <span>{state.n}</span>;
    }

    await act(async () => {
      root.render(<Counter />);
    });
    await act(async () => {
      await dispatch?.({ type: "inc" });
      await dispatch?.({ type: "inc" });
    });
    expect(container.textContent).toBe("2");

    // Unmount (stops + flushes the runtime), then remount over the SAME
    // store: the second mount rehydrates the round-tripped state.
    await act(async () => {
      root.render(<div />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    await expect(store.load()).resolves.toEqual({ n: 2 });

    await act(async () => {
      root.render(<Counter />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(container.textContent).toBe("2");
  });
});

describe("useRuntime", () => {
  it("consumes an externally-owned runtime and does NOT stop it on unmount", async () => {
    const external = await run(counterMachine(), { ctx: undefined }).ready;

    function Viewer() {
      const [state] = useRuntime(external);
      return <span>{state.n}</span>;
    }

    await act(async () => {
      root.render(<Viewer />);
    });
    expect(container.textContent).toBe("0");

    await act(async () => {
      await external.dispatch({ type: "inc" });
    });
    expect(container.textContent).toBe("1");

    // Unmount — the caller owns the lifecycle, so the runtime stays live.
    await act(async () => {
      root.render(<div />);
    });
    await external.dispatch({ type: "inc" });
    expect(external.getState()).toEqual({ n: 2 });
    await external.stop();
  });
});
