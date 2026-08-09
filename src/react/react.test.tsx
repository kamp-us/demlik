// @vitest-environment happy-dom
import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineMachine,
  type Interpret,
  type Reducer,
  RuntimeDiscardedError,
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

// ───────────────────────────────────────────────────────────────────────────
// Issue #365 — a ctx re-derived mid-flight rebuilds the runtime, and the
// in-flight Cmd's response arrives for a runtime nobody renders. The UI
// silently rewinds. The substrate now reports that teardown
// (`RuntimeDiscardedError`, `phase: "discard"`); with no `onError` configured
// — which is every `useMachine` caller, since the hook takes no sink — the
// default sink warns. This is the reproduction, driven through a real React
// commit rather than a direct `stop()` call.
// ───────────────────────────────────────────────────────────────────────────
describe("useMachine — loud on discard", () => {
  type WizardCtx = { readonly userId: string };
  type WizardState = { readonly step: number };
  type WizardMsg = { readonly type: "next" };
  type SaveCmd = { readonly type: "save" };

  // The parked Cmd returns NO follow-up: re-dispatching into a stopped runtime
  // is a separate (pre-existing) `phase: "follow-up"` rejection, and the
  // default sink rethrows that one — noise this test must not conflate with
  // the discard warning it asserts.
  function wizardMachine(park: Promise<void>) {
    const update: Reducer<WizardState, WizardMsg, SaveCmd> = {
      next: (s) => [{ step: s.step + 1 }, [{ type: "save" }]],
    };
    const interpret: Interpret<WizardMsg, SaveCmd, WizardCtx> = {
      save: async () => {
        await park;
      },
    };
    return defineMachine<WizardState, WizardMsg, SaveCmd, never, WizardCtx>({
      init: () => [{ step: 0 }, []],
      update,
      interpret,
    });
  }

  function mountWizard(machine: ReturnType<typeof wizardMachine>) {
    let dispatch: ((msg: WizardMsg) => Promise<void>) | null = null;
    function Wizard({ userId }: { userId: string }) {
      // The defect's exact shape: the ctx is DERIVED from a value the flow
      // itself moves, memoized correctly on that value — so it is stable
      // across renders and mints exactly one fresh identity when `userId`
      // changes, which is the moment the runtime is replaced.
      const ctx = useMemo<WizardCtx>(() => ({ userId }), [userId]);
      const [state, d] = useMachine(machine, { ctx });
      dispatch = d;
      return <span>{state.step}</span>;
    }
    return {
      Wizard,
      dispatch: (msg: WizardMsg) => dispatch?.(msg),
    };
  }

  it("warns when a ctx identity change replaces a runtime with a Cmd in flight", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let release = (): void => {};
    const park = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });
    const { Wizard, dispatch } = mountWizard(wizardMachine(park));

    await act(async () => {
      root.render(<Wizard userId="u1" />);
    });
    // Fire and forget — the Cmd parks, so this never settles before the
    // re-render below.
    await act(async () => {
      void dispatch({ type: "next" });
    });
    expect(warn).not.toHaveBeenCalled();

    // The mid-flight ctx churn: a new `userId` re-derives the ctx object, the
    // memo rebuilds, and the old runtime is dropped with `save` still awaiting.
    await act(async () => {
      root.render(<Wizard userId="u2" />);
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBeInstanceOf(RuntimeDiscardedError);
    expect((warn.mock.calls[0]?.[0] as RuntimeDiscardedError).pendingCmds).toBe(
      1,
    );

    release();
    await act(async () => {
      await Promise.resolve();
    });
    warn.mockRestore();
  });

  it("stays silent when the replaced runtime had nothing in flight", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Already-resolved park: every dispatched Cmd settles within its
    // transition, so the replacement below is a clean handover.
    const { Wizard, dispatch } = mountWizard(wizardMachine(Promise.resolve()));

    await act(async () => {
      root.render(<Wizard userId="u1" />);
    });
    await act(async () => {
      await dispatch({ type: "next" });
    });
    await act(async () => {
      root.render(<Wizard userId="u2" />);
    });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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
